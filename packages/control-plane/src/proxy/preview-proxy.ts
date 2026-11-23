import http from 'node:http';
import type { Duplex } from 'node:stream';
import type { Context } from 'hono';
import type { AuthService } from '../auth/google.js';
import type { ControlPlaneDb } from '../db.js';
import type { WorkspaceDriver } from '../drivers/workspace-driver.js';

const WAKING_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="refresh" content="2" />
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
</body>
</html>`;

export function createPreviewProxy(
  auth: AuthService,
  db: ControlPlaneDb,
  driver: WorkspaceDriver,
) {
  const handleHttp = async (c: Context) => {
    const user = auth.getUserFromContext(c);
    if (!user) return c.text('Unauthorized', 401);

    const sessionId = c.req.param('sessionId') || '';
    const session = db.getSession(sessionId);
    if (!session) return c.text('Session not found', 404);

    // Block inline edit patches if viewer is not owner/admin or session is published
    if (
      c.req.method === 'POST' &&
      c.req.path.endsWith('/__editor/patch') &&
      ((session.owner_user_id !== user.id && !user.isAdmin) || session.status === 'published')
    ) {
      return c.json({ error: 'Read-only preview' }, 403);
    }

    db.updateSession(session.id, { last_active_at: new Date().toISOString() });

    let endpoint;
    try {
      endpoint = await driver.ensureRunning(session);
    } catch {
      return c.html(WAKING_HTML, 503);
    }

    const url = new URL(c.req.url);
    const targetUrl = `${endpoint.astroUrl}${url.pathname}${url.search}`;

    const reqHeaders = new Headers(c.req.raw.headers);
    reqHeaders.delete('host');

    try {
      const upstream = await fetch(targetUrl, {
        method: c.req.method,
        headers: reqHeaders,
        body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
        duplex: 'half',
      } as RequestInit);
      const resHeaders = new Headers(upstream.headers);
      resHeaders.delete('content-encoding');
      return new Response(upstream.body, {
        status: upstream.status,
        headers: resHeaders,
      });
    } catch {
      return c.html(WAKING_HTML, 503);
    }
  };

  const handleUpgrade = async (
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    const match = (req.url ?? '').match(/^\/p\/([^/]+)/);
    if (!match?.[1]) {
      socket.destroy();
      return;
    }
    const session = db.getSession(match[1]);
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
        host: target.host,
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

  return { handleHttp, handleUpgrade };
}
