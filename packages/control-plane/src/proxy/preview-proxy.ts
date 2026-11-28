import http from 'node:http';
import { Readable, type Duplex } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Context } from 'hono';
import type { AuthService } from '../auth/google.js';
import type { ControlPlaneDb } from '../db.js';
import { WorkspaceCrashLoopError, type WorkspaceDriver } from '../drivers/workspace-driver.js';
import { ignore } from '../log.js';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

const STARTING_STATUS_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Preview starting…</title>
  <style>
    body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:#FAF9F7; color:#57534E; display:flex; align-items:center; justify-content:center; height:100vh; font-size:14px; }
  </style>
</head>
<body>Preview server is starting…</body>
</html>`;

const ASTRO_TOOLBAR_STUB_JS = 'export default {};\nexport const loadDevToolbarApps = async () => [];\n';

/**
 * Service Worker script served at `/halley-preview-sw.js` with `Service-Worker-Allowed: /`.
 * Eliminates the global `Path=/` `halley_preview_session` cookie so multiple open session tabs
 * never cross-contaminate escaped root-relative requests (`/@vite/*`, `/src/*`, `/images/*`, CSS `url()`).
 * Each preview iframe browsing context has a unique `clientId` whose URL starts with `/p/<sessionId>/`.
 */
export const HALLEY_PREVIEW_SW_JS = `
const clientSessions = new Map();

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function extractSessionFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const m = u.pathname.match(/^\\/p\\/([^/]+)(?:\\/|$)/);
    return m ? m[1] : null;
  } catch (err) {
    if (!(err instanceof TypeError)) throw err; // only an unparseable URL is expected here
    console.debug('[halley-sw] ignoring unparseable client URL', rawUrl, err);
    return null;
  }
}

function isReservedTopLevelPath(pathname) {
  return (
    pathname === '/halley-preview-sw.js' ||
    pathname.startsWith('/p/') ||
    pathname.startsWith('/__halley_p/') ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/internal/') ||
    pathname.startsWith('/ws/')
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' && req.method !== 'HEAD') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    const navSid = extractSessionFromUrl(req.url);
    if (navSid && event.resultingClientId) {
      clientSessions.set(event.resultingClientId, navSid);
    }
    return;
  }

  if (isReservedTopLevelPath(url.pathname)) return;
  if (!event.clientId) return;

  event.respondWith(
    (async () => {
      let sid = clientSessions.get(event.clientId) || null;
      if (!sid) {
        const client = await self.clients.get(event.clientId);
        if (client && client.url) {
          sid = extractSessionFromUrl(client.url);
          if (sid) clientSessions.set(event.clientId, sid);
        }
      }
      if (!sid) {
        return fetch(req);
      }
      const rewrittenUrl = new URL(
        '/__halley_p/' + encodeURIComponent(sid) + url.pathname + url.search,
        self.location.origin,
      );
      return fetch(rewrittenUrl.toString(), {
        method: req.method,
        headers: req.headers,
        credentials: 'same-origin',
        redirect: req.redirect,
      });
    })(),
  );
});
`.trimStart();

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function isEditorRunnerEndpoint(pathname: string): string | null {
  for (const suffix of [
    '/__editor/health',
    '/__editor/routes',
    '/__editor/inspect',
    '/__editor/patch',
  ]) {
    if (pathname === suffix || pathname.endsWith(suffix)) {
      return suffix;
    }
  }
  return null;
}

export function isAllowedWsOrigin(req: http.IncomingMessage, publicUrl?: string): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // Non-browser WS clients or same-origin without Origin
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const reqHost = (req.headers['x-forwarded-host']?.toString().split(',')[0]?.trim() ||
      req.headers.host ||
      '').toLowerCase();
    if (reqHost && originHost === reqHost) return true;
    if (publicUrl) {
      const pubHost = new URL(publicUrl).host.toLowerCase();
      if (pubHost && originHost === pubHost) return true;
    }
    return false;
  } catch (err) {
    // new URL() throws TypeError for a malformed Origin header (or PUBLIC_URL): reject the upgrade.
    if (!(err instanceof TypeError)) throw err;
    ignore(err, 'preview ws: rejecting upgrade with unparseable origin', { origin }, 'debug');
    return false;
  }
}

export function createPreviewProxy(
  auth: AuthService,
  db: ControlPlaneDb,
  driver: WorkspaceDriver,
  publicUrl?: string,
) {
  const proxyHttpRequest = async (
    c: Context,
    sessionId: string,
    opts?: { escapedRootSubPath?: string },
  ) => {
    const user = auth.getUserFromContext(c);
    if (!user) return c.text('Unauthorized', 401);

    const incomingUrl = new URL(c.req.url);
    const effectivePathname = opts?.escapedRootSubPath ?? incomingUrl.pathname;

    if (
      c.req.method === 'GET' &&
      (effectivePathname.endsWith('/dev-toolbar/entrypoint.js') ||
        effectivePathname.includes('__x00__astro:toolbar:internal'))
    ) {
      return new Response(ASTRO_TOOLBAR_STUB_JS, {
        status: 200,
        headers: {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    }

    const session = db.getSession(sessionId);
    if (!session) return c.text('Session not found', 404);

    const editorAction = isEditorRunnerEndpoint(effectivePathname);

    // Block inline edit patches if viewer is not owner/admin or session is published/merged
    if (
      c.req.method === 'POST' &&
      editorAction === '/__editor/patch' &&
      ((session.owner_user_id !== user.id && !user.isAdmin) ||
        session.status === 'published' ||
        session.status === 'merged')
    ) {
      return c.json({ error: 'Read-only preview' }, 403);
    }

    let endpoint;
    try {
      endpoint = await driver.ensureRunning(session);
    } catch (err) {
      const wantsHtml = (c.req.header('accept') || '').includes('text/html');
      if (err instanceof WorkspaceCrashLoopError && wantsHtml) {
        return c.html(crashLoopHtml(session.id, err), 503);
      }
      if (wantsHtml) {
        return new Response(STARTING_STATUS_HTML, {
          status: 503,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'retry-after': '2',
          },
        });
      }
      return c.json({ error: 'Preview server is starting', retryable: true }, 503);
    }

    // Only stamp activity once the session is confirmed running (throttled: ≤1 write/15s/session)
    db.touchSessionActivity(session.id);
    driver.touchSession?.(session.id);

    // Route `/__editor/*` directly to single-writer `workspace-runner` (never `astro dev`)
    const targetBase = new URL(editorAction ? endpoint.runnerUrl : endpoint.astroUrl);
    const targetPort = Number(targetBase.port || (editorAction ? 4322 : 4321));

    let upstreamPath = effectivePathname;
    if (editorAction) {
      upstreamPath = editorAction;
    } else if (opts?.escapedRootSubPath) {
      const sub = opts.escapedRootSubPath.startsWith('/')
        ? opts.escapedRootSubPath
        : `/${opts.escapedRootSubPath}`;
      const cleanAstroBase =
        !endpoint.astroBase || endpoint.astroBase === '/'
          ? ''
          : `/${endpoint.astroBase.replace(/^\/+|\/+$/g, '')}`;
      if (cleanAstroBase && (sub === cleanAstroBase || sub.startsWith(`${cleanAstroBase}/`))) {
        upstreamPath = `/p/${sessionId}${sub}`;
      } else {
        upstreamPath = `/p/${sessionId}${cleanAstroBase}${sub}`;
      }
    }

    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === 'host' || lower === 'accept-encoding' || HOP_BY_HOP_HEADERS.has(lower)) {
        return;
      }
      headers[key] = value;
    });
    headers['host'] = `localhost:${targetPort}`;
    // Request uncompressed upstream bytes so Node streams match stripped content-encoding
    headers['accept-encoding'] = 'identity';

    // Stream request bodies (inline-edit patches, form posts) instead of buffering them
    const reqBody =
      c.req.method === 'GET' || c.req.method === 'HEAD' || !c.req.raw.body
        ? null
        : Readable.fromWeb(c.req.raw.body as unknown as NodeReadableStream<Uint8Array>);

    try {
      const upstream = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const proxyReq = http.request(
          {
            hostname: targetBase.hostname,
            port: targetPort,
            path: `${upstreamPath}${incomingUrl.search}`,
            method: c.req.method,
            headers,
            timeout: 25_000,
          },
          (res) => {
            c.req.raw.signal?.removeEventListener('abort', onAbort);
            resolve(res);
          },
        );
        const onAbort = () => {
          proxyReq.destroy(new Error('Preview proxy client aborted'));
        };
        c.req.raw.signal?.addEventListener('abort', onAbort, { once: true });
        proxyReq.on('timeout', () => {
          proxyReq.destroy(new Error('Preview proxy upstream timed out'));
        });
        proxyReq.on('error', (err) => {
          c.req.raw.signal?.removeEventListener('abort', onAbort);
          reject(err);
        });
        if (reqBody) {
          reqBody.on('error', (err) => proxyReq.destroy(err));
          reqBody.pipe(proxyReq);
        } else {
          proxyReq.end();
        }
      });

      const resHeaders = new Headers();
      const upstreamOriginPrefix = `http://localhost:${targetPort}`;
      for (const [k, v] of Object.entries(upstream.headers)) {
        const lower = k.toLowerCase();
        if (!v || lower === 'content-encoding' || lower === 'content-length' || HOP_BY_HOP_HEADERS.has(lower)) {
          continue;
        }
        if (lower === 'location' && typeof v === 'string' && v.startsWith(upstreamOriginPrefix)) {
          resHeaders.set(k, v.slice(upstreamOriginPrefix.length) || '/');
          continue;
        }
        if (Array.isArray(v)) {
          for (const item of v) resHeaders.append(k, item);
        } else {
          resHeaders.set(k, v);
        }
      }

      return new Response(Readable.toWeb(upstream) as ReadableStream, {
        status: upstream.statusCode ?? 200,
        headers: resHeaders,
      });
    } catch (err) {
      ignore(err, 'preview proxy: upstream request failed', { sessionId, path: upstreamPath }, 'debug');
      const wantsHtml = (c.req.header('accept') || '').includes('text/html');
      if (wantsHtml) {
        return new Response(STARTING_STATUS_HTML, {
          status: 503,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'retry-after': '2',
          },
        });
      }
      return c.json({ error: 'Preview upstream temporarily unavailable', retryable: true }, 503);
    }
  };

  const handleHttpForSession = async (c: Context, sessionId: string) => {
    const escapedRootSubPath = c.req.path.startsWith('/p/') ? undefined : c.req.path;
    return proxyHttpRequest(c, sessionId, { escapedRootSubPath });
  };

  const handleServiceWorkerRewrite = async (c: Context) => {
    const sessionId = c.req.param('sessionId') || '';
    const prefix = `/__halley_p/${encodeURIComponent(sessionId)}`;
    const rawPath = new URL(c.req.url).pathname;
    const subPath = rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) || '/' : '/';
    return proxyHttpRequest(c, sessionId, { escapedRootSubPath: subPath });
  };

  const handleHttp = async (c: Context) => {
    const sessionId = c.req.param('sessionId') || '';
    return proxyHttpRequest(c, sessionId);
  };

  const handleUpgrade = async (
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    // A client reset (ECONNRESET/EPIPE) on a raw upgrade socket with no 'error' listener is an
    // uncaught exception that kills the whole control-plane: attach one before any await.
    socket.on('error', (err) => {
      ignore(err, 'preview upgrade socket error', { url: req.url }, 'debug');
      socket.destroy();
    });
    if (!isAllowedWsOrigin(req, publicUrl)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const user = auth.getUserFromCookieHeader(req.headers.cookie);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    let sessionId = '';
    const match = (req.url ?? '').match(/^\/p\/([^/?]+)/);
    if (match?.[1]) {
      sessionId = decodeURIComponent(match[1]);
    } else {
      const ref = req.headers.referer || '';
      const refMatch = ref.match(/\/p\/([^/?#]+)/);
      if (refMatch?.[1]) sessionId = decodeURIComponent(refMatch[1]);
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

    let astroUrl = session.astro_url;
    try {
      const ep = await driver.ensureRunning(session);
      astroUrl = ep.astroUrl;
    } catch (err) {
      ignore(err, 'preview upgrade: workspace not running', { sessionId }, 'debug');
      socket.destroy();
      return;
    }
    if (socket.destroyed) return;

    driver.touchSession?.(sessionId);

    const target = new URL(astroUrl);
    const proxyReq = http.request({
      hostname: target.hostname,
      port: Number(target.port || 80),
      path: req.url,
      method: req.method,
      timeout: 15_000,
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
      socket.on('close', () => proxySocket.destroy());
      proxySocket.on('close', () => socket.destroy());
    });

    proxyReq.on('response', (proxyRes) => {
      proxyRes.resume();
      socket.destroy();
    });
    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      socket.destroy();
    });
    proxyReq.on('error', () => socket.destroy());
    if (head.length) proxyReq.write(head);
    proxyReq.end();
  };

  return { handleHttp, handleHttpForSession, handleServiceWorkerRewrite, handleUpgrade };
}
