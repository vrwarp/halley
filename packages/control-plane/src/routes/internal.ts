import { deriveInternalHostToken, extractBearerToken, safeEqualToken } from '@halley/shared/auth';
import { createInternalGitHttpHandler } from '../git-http.js';
import { z } from 'zod';
import { readJsonObject } from '../http-body.js';
import { ignore, logger } from '../log.js';
import { createLlmProxyHandler } from '../proxy/llm-proxy.js';
import { ScreenshotBusyError, type ScreenshotViewport } from '../screenshot-service.js';
import { type App, type ControlPlaneContext } from '../control-plane-context.js';

/** Registers the internal workspace-facing routes (git smart-HTTP, LLM proxy, screenshots, runner hooks). */
export function register(app: App, ctx: ControlPlaneContext) {
  const {
    config,
    deps,
    clock,
    db,
    hostDriver,
    driver,
    broadcastToSession,
    convertAndBroadcastIfRevert,
    screenshotService,
  } = ctx;
  // Internal Git Smart-HTTP mirror (keeps GitHub credentials strictly inside control-plane)
  const internalGitHandler = createInternalGitHttpHandler(
    config,
    db,
    async () => {
      if (hostDriver) {
        await hostDriver.ensureControlPlaneMirror(config.baseBranch, { allowStaleOnError: true });
      }
    },
    clock,
  );
  app.all('/internal/git/repo.git/*', internalGitHandler);
  app.all('/internal/git/repo.git', internalGitHandler);

  // LLM Proxy (authenticated via WORKSPACE_TOKEN, no user cookie)
  const llmProxy = createLlmProxyHandler(
    config,
    db,
    (userId, sessionId) => {
      const spend = db.getSpendStatus(userId);
      broadcastToSession(sessionId, { type: 'spend_status', ...spend });
    },
    { clock, fetch: deps.fetch },
  );
  app.all('/internal/llm/anthropic/*', llmProxy);

  // Shared Headless Chromium Screenshot Service (authenticated via WORKSPACE_TOKEN)
  app.post('/internal/screenshot', async (c) => {
    const authHeader = c.req.header('authorization') || '';
    const rawToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!rawToken) {
      return c.json({ error: 'Missing workspace token' }, 401);
    }

    const session = db.resolveSessionByWorkspaceToken(rawToken);
    if (!session) {
      return c.json({ error: 'Invalid workspace token' }, 401);
    }

    db.touchSessionActivity(session.id);

    let astroUrl: string;
    let originalBase: string;
    try {
      const ep = await driver.ensureRunning(session);
      astroUrl = ep.astroUrl;
      originalBase = ep.astroBase || '/';
    } catch (err) {
      ignore(err, 'screenshot: workspace not running', { sessionId: session.id }, 'debug');
      return c.json({ error: 'Workspace preview server is not running' }, 503);
    }

    const body = (await readJsonObject(c)) as {
      route?: unknown;
      viewport?: unknown;
      fullPage?: unknown;
    };
    const rawRoute = typeof body.route === 'string' ? body.route.trim() : '/';
    const viewport: ScreenshotViewport = body.viewport === 'mobile' ? 'mobile' : 'desktop';
    const fullPage = body.fullPage === true;
    let cleanRoute = rawRoute.startsWith('/') ? rawRoute : `/${rawRoute}`;

    const astroOrigin = new URL(astroUrl);
    const baseSuffix = originalBase === '/' ? '' : originalBase.replace(/\/$/, '');
    if (baseSuffix && (cleanRoute === baseSuffix || cleanRoute.startsWith(`${baseSuffix}/`))) {
      cleanRoute = cleanRoute.slice(baseSuffix.length) || '/';
    }

    const sessionPrefix = `/p/${session.id}`;
    const previewPath = `${sessionPrefix}${baseSuffix}${cleanRoute}`;
    const targetUrl = new URL(previewPath, astroOrigin);
    if (
      targetUrl.origin !== astroOrigin.origin ||
      (targetUrl.pathname !== sessionPrefix && !targetUrl.pathname.startsWith(`${sessionPrefix}/`))
    ) {
      return c.json({ error: 'Invalid route' }, 400);
    }

    try {
      const result = await screenshotService.capture({
        url: targetUrl.toString(),
        viewport,
        fullPage,
      });
      return new Response(new Uint8Array(result.data), {
        status: 200,
        headers: {
          'Content-Type': result.mimeType,
          'X-Screenshot-Width': String(result.width),
          'X-Screenshot-Height': String(result.height),
        },
      });
    } catch (err) {
      if (err instanceof ScreenshotBusyError) {
        return c.json({ error: err.message, retryable: true }, 503, { 'Retry-After': '2' });
      }
      ignore(err, 'screenshot capture failed', { sessionId: session.id });
      return c.json(
        { error: err instanceof Error ? err.message : 'Screenshot capture failed' },
        500,
      );
    }
  });

  // Internal hook called by workspace-runner when an edit checkpoint is created
  // Supervisor -> control plane: a session's runner exited without being asked to (crash / OOM).
  // Reconcile immediately instead of waiting for the next health poll, and tell open editors.
  const SessionExitedSchema = z.object({
    sessionId: z.string().min(1),
    code: z.number().nullable().optional(),
    signal: z.string().nullable().optional(),
    oom: z.boolean().optional(),
  });
  const derivedHostToken = deriveInternalHostToken(config.sessionSecret);
  app.post('/internal/workspaces/session-exited', async (c) => {
    const token = extractBearerToken(c.req.header('authorization'));
    const authorized =
      safeEqualToken(token, derivedHostToken) ||
      (config.workspaceHostSecret ? safeEqualToken(token, config.workspaceHostSecret) : false);
    if (!authorized) return c.json({ error: 'Unauthorized' }, 401);
    const parsed = SessionExitedSchema.safeParse(await readJsonObject(c));
    if (!parsed.success) return c.json({ error: 'Invalid body' }, 400);
    const { sessionId, code, signal, oom } = parsed.data;
    logger.warn('workspace runner exited unexpectedly', { sessionId, code, signal, oom });
    await driver.reconcileSessions?.().catch((err) =>
      ignore(err, 'session-exited: reconcile failed', { sessionId }),
    );
    if (db.getSession(sessionId)) {
      broadcastToSession(sessionId, {
        type: 'error',
        message: oom
          ? 'Your workspace ran out of memory and stopped. It will restart when you continue editing.'
          : 'Your workspace stopped unexpectedly. It will restart when you continue editing.',
      });
      broadcastToSession(sessionId, { type: 'session_meta_updated' });
    }
    return c.json({ ok: true });
  });

  app.post('/internal/session/diverged', async (c) => {
    const authHeader = c.req.header('authorization') || '';
    const rawToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!rawToken) {
      return c.json({ error: 'Missing workspace token' }, 401);
    }
    const session = db.resolveSessionByWorkspaceToken(rawToken);
    if (!session) {
      return c.json({ error: 'Invalid workspace token' }, 401);
    }
    const body = (await readJsonObject(c)) as { changedFilesCount?: unknown };
    if (typeof body.changedFilesCount === 'number' && Number.isFinite(body.changedFilesCount)) {
      db.updateSession(session.id, { changed_files_count: body.changedFilesCount });
    }
    const converted = convertAndBroadcastIfRevert(session.id);
    return c.json({ ok: true, converted: Boolean(converted), kind: converted?.kind ?? session.kind });
  });

  // Internal hook called when the initial Optimization Draft pass settles (clears escalation gate)
  app.post('/internal/session/optimization-settled', (c) => {
    const authHeader = c.req.header('authorization') || '';
    const rawToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!rawToken) {
      return c.json({ error: 'Missing workspace token' }, 401);
    }
    const session = db.resolveSessionByWorkspaceToken(rawToken);
    if (!session) {
      return c.json({ error: 'Invalid workspace token' }, 401);
    }
    db.updateSession(session.id, {
      optimize_escalation_allowed: 0,
      active_model_label: null,
    });
    broadcastToSession(session.id, { type: 'session_meta_updated' });
    return c.json({ ok: true });
  });
  return { llmProxy };
}
