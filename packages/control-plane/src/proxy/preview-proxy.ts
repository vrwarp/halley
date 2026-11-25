import http from 'node:http';
import { Readable, type Duplex } from 'node:stream';
import type { Context } from 'hono';
import type { AuthService } from '../auth/google.js';
import type { ControlPlaneDb } from '../db.js';
import { WorkspaceCrashLoopError, type WorkspaceDriver } from '../drivers/workspace-driver.js';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const WAKING_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Waking up preview…</title>
  <style>
    body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:#FAF9F7; color:#1C1917; display:flex; align-items:center; justify-content:center; height:100vh; }
    .card { text-align:center; padding:32px; max-width:360px; }
    .spinner { width:24px; height:24px; border:2px solid #E7E5E4; border-top-color:#D97706;
      border-radius:50%; margin:0 auto 16px; animation:spin .8s linear infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }
    h1 { font-size:16px; font-weight:600; margin:0 0 6px; }
    p { font-size:13px; color:#78716C; margin:0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h1>Waking up your preview…</h1>
    <p>This usually takes a couple of seconds.</p>
  </div>
  <script>
    (function () {
      var key = 'halley_wake_attempt:' + location.pathname;
      var attempt = Number(sessionStorage.getItem(key) || '0') + 1;
      sessionStorage.setItem(key, String(Math.min(attempt, 6)));
      var delays = [2000, 3000, 5000, 8000, 12000, 15000];
      var delay = delays[Math.min(attempt - 1, delays.length - 1)];
      setTimeout(function () { location.reload(); }, delay);
    })();
  </script>
</body>
</html>`;

const VERIFYING_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Running pre-publish checks…</title>
  <style>
    body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:#FAF9F7; color:#1C1917; display:flex; align-items:center; justify-content:center; height:100vh; }
    .card { text-align:center; padding:36px 32px; max-width:380px; background:#fff; border:1px solid #E7E5E4; border-radius:16px; }
    .ring { width:36px; height:36px; border:2px solid #E7E5E4; border-top-color:#D97706;
      border-radius:50%; margin:0 auto 18px; animation:spin .9s linear infinite; }
    .bar { height:4px; background:#F5F5F4; border-radius:999px; overflow:hidden; margin:18px auto 0; width:200px; }
    .bar > div { height:100%; width:42%; background:#D97706; border-radius:999px; animation:slide 1.5s ease-in-out infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }
    @keyframes slide { 0% { transform:translateX(-110%); } 100% { transform:translateX(260%); } }
    h1 { font-size:16px; font-weight:600; margin:0 0 6px; }
    p { font-size:13px; color:#78716C; margin:0; line-height:1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="ring"></div>
    <h1>Preview paused for publish checks</h1>
    <p>Verifying your build, links, and SEO before publishing. Live preview will return automatically.</p>
    <div class="bar"><div></div></div>
  </div>
  <script>
    setTimeout(function () { location.reload(); }, 4000);
  </script>
</body>
</html>`;

function crashLoopHtml(sessionId: string, err: WorkspaceCrashLoopError): string {
  const title = err.oom
    ? 'Workspace ran out of memory'
    : 'Workspace paused after repeated crashes';
  const detail = escapeHtml(err.lastError || err.message);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:#FAF9F7; color:#1C1917; display:flex; align-items:center; justify-content:center; height:100vh; padding:24px; box-sizing:border-box; }
    .card { text-align:center; padding:32px; max-width:420px; background:#fff; border:1px solid #FECACA; border-radius:16px; }
    h1 { font-size:16px; font-weight:600; margin:0 0 8px; color:#991B1B; }
    p { font-size:13px; color:#57534E; margin:0 0 14px; line-height:1.5; }
    pre { text-align:left; font-size:11px; background:#FEF2F2; color:#991B1B; border:1px solid #FECACA; border-radius:10px; padding:10px; max-height:120px; overflow:auto; white-space:pre-wrap; margin:0 0 16px; }
    button { background:#1C1917; color:#fff; border:0; border-radius:10px; padding:9px 16px; font-size:13px; font-weight:600; cursor:pointer; }
    button:disabled { opacity:0.6; cursor:default; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>Auto-restart is paused to prevent a crash loop. Your saved edits are safe.</p>
    <pre>${detail}</pre>
    <button id="restartBtn" type="button">Restart workspace</button>
  </div>
  <script>
    document.getElementById('restartBtn').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      btn.textContent = 'Restarting…';
      fetch('/api/sessions/${encodeURIComponent(sessionId)}/restart', { method: 'POST' })
        .finally(function () { setTimeout(function () { location.reload(); }, 1500); });
    });
  </script>
</body>
</html>`;
}

export function createPreviewProxy(
  auth: AuthService,
  db: ControlPlaneDb,
  driver: WorkspaceDriver,
) {
  const handleHttpForSession = async (c: Context, sessionId: string) => {
    const user = auth.getUserFromContext(c);
    if (!user) return c.text('Unauthorized', 401);

    const session = db.getSession(sessionId);
    if (!session) return c.text('Session not found', 404);

    // Block inline edit patches if viewer is not owner/admin or session is published/merged
    if (
      c.req.method === 'POST' &&
      c.req.path.endsWith('/__editor/patch') &&
      ((session.owner_user_id !== user.id && !user.isAdmin) ||
        session.status === 'published' ||
        session.status === 'merged')
    ) {
      return c.json({ error: 'Read-only preview' }, 403);
    }

    db.updateSession(session.id, { last_active_at: new Date().toISOString() });

    if (session.publish_state === 'verifying') {
      return c.html(VERIFYING_HTML, 503);
    }

    let endpoint;
    try {
      endpoint = await driver.ensureRunning(session);
    } catch (err) {
      if (err instanceof WorkspaceCrashLoopError) {
        return c.html(crashLoopHtml(session.id, err), 503);
      }
      return c.html(WAKING_HTML, 503);
    }

    const url = new URL(c.req.url);
    const targetBase = new URL(endpoint.astroUrl);
    const targetPort = Number(targetBase.port || 4321);

    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      if (key.toLowerCase() !== 'host') {
        headers[key] = value;
      }
    });
    headers['host'] = `localhost:${targetPort}`;

    const reqBody =
      ['GET', 'HEAD'].includes(c.req.method) ? undefined : Buffer.from(await c.req.arrayBuffer());

    try {
      const upstream = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const proxyReq = http.request(
          {
            hostname: targetBase.hostname,
            port: targetPort,
            path: `${url.pathname}${url.search}`,
            method: c.req.method,
            headers,
          },
          resolve,
        );
        proxyReq.on('error', reject);
        if (reqBody && reqBody.length > 0) {
          proxyReq.write(reqBody);
        }
        proxyReq.end();
      });

      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(upstream.headers)) {
        if (!v || k.toLowerCase() === 'content-encoding') continue;
        if (Array.isArray(v)) {
          for (const item of v) resHeaders.append(k, item);
        } else {
          resHeaders.set(k, v);
        }
      }
      if (c.req.path.startsWith('/p/')) {
        const cookieHeader = c.req.header('cookie') || '';
        const existingCookie = cookieHeader.match(/(?:^|;\s*)halley_preview_session=([^;]+)/)?.[1];
        if (existingCookie !== sessionId) {
          resHeaders.append(
            'set-cookie',
            `halley_preview_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax`,
          );
        }
      }
      return new Response(Readable.toWeb(upstream) as ReadableStream, {
        status: upstream.statusCode ?? 200,
        headers: resHeaders,
      });
    } catch {
      const latest = db.getSession(session.id);
      if (latest?.publish_state === 'verifying') {
        return c.html(VERIFYING_HTML, 503);
      }
      return c.html(WAKING_HTML, 503);
    }
  };

  const handleHttp = async (c: Context) => {
    const sessionId = c.req.param('sessionId') || '';
    return handleHttpForSession(c, sessionId);
  };

  const handleUpgrade = async (
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    let sessionId = '';
    const match = (req.url ?? '').match(/^\/p\/([^/]+)/);
    if (match?.[1]) {
      sessionId = match[1];
    } else {
      const ref = req.headers.referer || '';
      const refMatch = ref.match(/\/p\/([0-9a-f-]{20,})\b/i);
      if (refMatch?.[1]) sessionId = refMatch[1];
    }
    if (!sessionId) {
      socket.destroy();
      return;
    }
    const session = db.getSession(sessionId);
    if (!session || !session.astro_url) {
      socket.destroy();
      return;
    }

    const target = new URL(session.astro_url);
    const proxyReq = http.request({
      hostname: target.hostname,
      port: Number(target.port || 80),
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: `localhost:${target.port || '4321'}`,
      },
    });

    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n` +
          Object.entries(proxyRes.headers)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
            .join('\r\n') +
          '\r\n\r\n',
      );
      if (proxyHead.length) socket.write(proxyHead);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
      proxySocket.on('error', () => socket.destroy());
      socket.on('error', () => proxySocket.destroy());
    });

    proxyReq.on('error', () => socket.destroy());
    if (head.length) proxyReq.write(head);
    proxyReq.end();
  };

  return { handleHttp, handleHttpForSession, handleUpgrade };
}
