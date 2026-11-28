import fs from 'node:fs/promises';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { ignore } from './log.js';
import { createPreviewProxy } from './proxy/preview-proxy.js';
import { type App, type ControlPlaneContext } from './control-plane-context.js';

/** Registers the preview proxy, the cookie-free preview fallback and the built web UI (registered last). */
export function register(app: App, ctx: ControlPlaneContext) {
  const { config, db, auth, driver } = ctx;
  // Preview Proxy (/p/:sessionId/* + Service Worker /__halley_p/:sessionId/* + cookie-free Referer fallback)
  const previewProxy = createPreviewProxy(auth, db, driver, config.publicUrl);
  app.all('/p/:sessionId/*', previewProxy.handleHttp);
  app.all('/p/:sessionId', previewProxy.handleHttp);
  app.all('/__halley_p/:sessionId/*', previewProxy.handleServiceWorkerRewrite);
  app.all('/__halley_p/:sessionId', previewProxy.handleServiceWorkerRewrite);

  app.all('*', async (c, next) => {
    const p = c.req.path;
    if (
      p.startsWith('/api/') ||
      p.startsWith('/p/') ||
      p.startsWith('/__halley_p/') ||
      p.startsWith('/internal/') ||
      p === '/halley-preview-sw.js'
    ) {
      return next();
    }
    const ref = c.req.header('referer') || '';
    const refMatch = ref.match(/\/(?:p|__halley_p)\/([^/?#]+)/);
    const targetSessionId = refMatch?.[1] ? decodeURIComponent(refMatch[1]) : '';
    if (targetSessionId) {
      return previewProxy.handleHttpForSession(c, targetSessionId);
    }
    const isEscapedDevModule =
      p.startsWith('/@vite/') ||
      p.startsWith('/@fs/') ||
      p.startsWith('/@id/') ||
      p.startsWith('/__astro') ||
      p.startsWith('/src/') ||
      p.startsWith('/node_modules/') ||
      p.startsWith('/_astro/');
    if (isEscapedDevModule || p.startsWith('/__editor/')) {
      // Never fall through to SPA index.html (text/html) for Vite/Astro dev module paths
      return c.notFound();
    }
    return next();
  });

  // Serve built React Web UI in production
  const webRoot = config.webDistDir;
  app.use('/*', serveStatic({ root: webRoot }));
  app.get('*', async (c, next) => {
    if (
      c.req.path.startsWith('/api/') ||
      c.req.path.startsWith('/p/') ||
      c.req.path.startsWith('/__halley_p/') ||
      c.req.path.startsWith('/internal/')
    ) {
      return next();
    }
    // Never return index.html with text/html for missing static asset extensions
    if (/\.(?:js|mjs|ts|css|map|wasm|webp|png|jpg|jpeg|svg|ico|woff2?)$/i.test(c.req.path)) {
      return c.notFound();
    }
    try {
      const html = await fs.readFile(path.join(webRoot, 'index.html'), 'utf8');
      return c.html(html);
    } catch (err) {
      ignore(err, 'web UI index.html not found', { webRoot }, 'debug');
      return c.text('Halley Control Plane running. Start @halley/web dev server or build packages/web.', 200);
    }
  });
  return { previewProxy };
}
