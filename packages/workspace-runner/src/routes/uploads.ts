import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { RunnerContext } from '../runner-context.js';

/** Image upload staging. Registered by createRunner (see RunnerContext). */
export function registerUploadsRoutes(app: Hono, ctx: RunnerContext): void {
  const { config, uploadManager } = ctx;
  const MAX_UPLOAD_BYTES = config.maxUploadBytes;
  // Enforced on the raw stream (Content-Length or chunked) before the multipart body is buffered
  const uploadLimit = bodyLimit({
    maxSize: MAX_UPLOAD_BYTES,
    onError: (c) =>
      c.json({ error: `File is too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB)` }, 413),
  });
  app.post('/internal/uploads', uploadLimit, async (c) => {
    if (ctx.readOnly) return c.json({ error: 'Read-only' }, 403);
    const form = await c.req.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') {
      return c.json({ error: 'Missing file' }, 400);
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const staged = await uploadManager.stageImage(file.name, file.type || 'image/png', buf);
    return c.json({ attachment: staged });
  });
}
