import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ChatServerMessage, type PublishProgressPayload, type UserDto } from '@halley/shared';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { WebSocket, WebSocketServer } from 'ws';
import { AuthService } from './auth/google.js';
import { loadConfig, type HalleyConfig } from './config.js';
import { realClock, type Clock, type ControlPlaneDeps } from './clock.js';
import { ControlPlaneDb } from './db.js';
import { type WorkspaceDriver } from './drivers/workspace-driver.js';
import { WorkspaceHostDriver } from './drivers/workspace-host-driver.js';
import { GitHubService } from './github/client.js';
import { ignore, isLogLevelEnabled, log, logger } from './log.js';
import { REQUEST_ID_HEADER, resolveRequestId, runWithContext } from './request-context.js';
import { createRunnerClient } from './runner-client.js';
import { startSessionReaper } from './reaper.js';
import { OptimizeService } from './routes/optimize.js';
import { PublishService } from './routes/publish.js';
import { ScreenshotBusyError, ScreenshotService } from './screenshot-service.js';
import { register as registerHealth } from './routes/health.js';
import { register as registerInternal } from './routes/internal.js';
import { register as registerAuth } from './routes/auth.js';
import { register as registerSessions } from './routes/sessions.js';
import { register as registerWorkspace } from './routes/workspace.js';
import { register as registerReview } from './routes/review.js';
import { register as registerActions } from './routes/session-actions.js';
import { register as registerAdmin } from './routes/admin.js';
import { register as registerStatic } from './static.js';
import { register as registerWs } from './ws-bridge.js';
import { type ControlPlaneContext, type Env } from './control-plane-context.js';

export function createControlPlane(
  config: HalleyConfig,
  customDriver?: WorkspaceDriver,
  customScreenshotService?: ScreenshotService,
  deps: ControlPlaneDeps = {},
) {
  const clock = deps.clock ?? realClock;
  const randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());
  const nowIso = () => new Date(clock.now()).toISOString();
  // Every workspace-runner call in this module goes through the injected transport
  const { runnerFetch } = createRunnerClient(deps.fetch, clock);
  const db =
    deps.db ??
    new ControlPlaneDb(path.join(config.dataDir, 'control-plane.sqlite'), config, { clock, randomUUID });
  const auth = deps.auth ?? new AuthService(config, db, { clock, fetch: deps.fetch });
  const github = deps.github ?? new GitHubService(config, undefined, { clock, fetch: deps.fetch });

  const hostDriver = customDriver
    ? null
    : new WorkspaceHostDriver(config, db, github, { clock, fetch: deps.fetch });
  const driver: WorkspaceDriver = customDriver ?? hostDriver!;

  const browserWsBySession = new Map<string, Set<WebSocket>>();

  const broadcastToSession = (sessionId: string, msg: ChatServerMessage) => {
    const clients = browserWsBySession.get(sessionId);
    if (!clients) return;
    const json = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
    }
  };

  driver.setBootProgressListener?.((sessionId, progress) => {
    broadcastToSession(sessionId, { type: 'boot_progress', progress });
  });

  const enrichSessionDto = (s: import('./db.js').SessionRecord, user: UserDto) => ({
    ...db.toSessionDto(s, user),
    astroReady: driver.isSessionAstroReady
      ? driver.isSessionAstroReady(s.id)
      : Boolean(s.astro_url && s.status === 'running'),
    bootProgress: driver.getBootProgress?.(s.id) ?? null,
  });

  const convertAndBroadcastIfRevert = (sessionId: string) => {
    const converted = db.convertRevertSession(sessionId);
    if (converted) {
      broadcastToSession(sessionId, { type: 'session_meta_updated' });
    }
    return converted;
  };

  const publishService = new PublishService(
    config,
    db,
    driver,
    github,
    (sessionId, payload: PublishProgressPayload) => {
      broadcastToSession(sessionId, { type: 'publish_state', payload });
    },
    (sessionId) => {
      broadcastToSession(sessionId, { type: 'session_meta_updated' });
    },
    undefined,
    { clock, randomUUID, fetch: deps.fetch },
  );
  publishService.resumeIncompletePublishes();
  // Re-armed only after a pass settles, so a slow GitHub never stacks overlapping passes.
  let reconcileTimer: ReturnType<typeof clock.setTimeout> | null = null;
  let disposed = false;
  const scheduleArmedRunReconcile = () => {
    if (disposed) return;
    reconcileTimer = clock.setTimeout(() => {
      void publishService
        .reconcileArmedRuns()
        .catch((err) => ignore(err, 'publish: armed-run reconcile pass failed'))
        .finally(scheduleArmedRunReconcile);
    }, 5 * 60_000);
  };
  scheduleArmedRunReconcile();

  const optimizeService = new OptimizeService(
    config,
    db,
    driver,
    enrichSessionDto,
    (sessionId) => {
      broadcastToSession(sessionId, { type: 'session_meta_updated' });
    },
    (userId) => {
      // Indexed per-owner lookup, and only sessions with an open browser socket get a frame
      const spend = db.getSpendStatus(userId);
      for (const sessionId of db.listSessionIdsByOwner(userId)) {
        if (browserWsBySession.get(sessionId)?.size) {
          broadcastToSession(sessionId, { type: 'spend_status', ...spend });
        }
      }
    },
    { fetch: deps.fetch, randomUUID, clock },
  );

  const screenshotService =
    customScreenshotService ??
    new ScreenshotService({
      idleTimeoutMs: config.browserIdleTimeoutMs,
      clock,
    });

  const app = new Hono<Env>();

  // Correlation id + access log. The id lives in AsyncLocalStorage, so every log line written while
  // handling the request (and every supervisor/runner call it makes) carries it automatically.
  app.use('*', async (c, next) => {
    const requestId = resolveRequestId(c.req.header('x-request-id'));
    const startedAt = performance.now();
    c.header(REQUEST_ID_HEADER, requestId);
    await runWithContext({ requestId }, () => next());
    if (!c.res.headers.has(REQUEST_ID_HEADER)) {
      try {
        c.res.headers.set(REQUEST_ID_HEADER, requestId);
      } catch (err) {
        // Immutable headers (a Response passed through from fetch): copy instead
        ignore(err, 'access log: response headers immutable; cloning response', {}, 'debug');
        c.res = new Response(c.res.body, c.res);
        c.res.headers.set(REQUEST_ID_HEADER, requestId);
      }
    }
    const p = c.req.path;
    // Preview assets, static files and health probes are high-volume: debug only
    const level =
      (p.startsWith('/api/') && !p.startsWith('/api/health')) || p.startsWith('/internal/') ? 'info' : 'debug';
    if (isLogLevelEnabled(level)) {
      log(level, 'http request', {
        requestId,
        method: c.req.method,
        path: p,
        status: c.res.status,
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      });
    }
  });

  // Request body caps: JSON APIs 1 MB by default; uploads get their own cap (matches the runner).
  const payloadTooLarge = (c: import('hono').Context) => c.json({ error: 'Request body is too large' }, 413);
  const apiBodyLimit = bodyLimit({ maxSize: config.apiBodyLimitBytes, onError: payloadTooLarge });
  const uploadBodyLimit = bodyLimit({ maxSize: config.uploadBodyLimitBytes, onError: payloadTooLarge });
  app.use('/api/*', (c, next) => (c.req.path.endsWith('/uploads') ? uploadBodyLimit(c, next) : apiBodyLimit(c, next)));
  app.use('/internal/session/*', apiBodyLimit);
  app.use('/internal/workspaces/*', apiBodyLimit);
  app.use('/internal/screenshot', apiBodyLimit);

  app.onError((err, c) => {
    logger.error('unhandled error in request handler', { method: c.req.method, path: c.req.path, err });
    if (err instanceof ScreenshotBusyError) {
      return c.json({ error: err.message, retryable: true }, 503);
    }
    return c.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      500,
    );
  });

  const requireSessionEdit = async (c: import('hono').Context<Env>) => {
    const user = c.get('user');
    const s = db.getSession(c.req.param('id')!);
    if (!s) return { error: 'Not found', status: 404 as const };
    if (s.owner_user_id !== user.id && !user.isAdmin) {
      return { error: 'Read-only: only the owner or an admin can edit this session', status: 403 as const };
    }
    if (s.status === 'published' || s.status === 'merged') {
      return { error: 'This edit has already been merged or published', status: 409 as const };
    }
    return { session: s, user };
  };

  const ctx: ControlPlaneContext = {
    config,
    deps,
    clock,
    randomUUID,
    nowIso,
    runnerFetch,
    db,
    auth,
    github,
    hostDriver,
    driver,
    browserWsBySession,
    broadcastToSession,
    enrichSessionDto,
    convertAndBroadcastIfRevert,
    publishService,
    optimizeService,
    screenshotService,
    requireSessionEdit,
  };

  // Route modules, registered in the original order (Hono matches in registration order)
  registerHealth(app, ctx);
  const { llmProxy } = registerInternal(app, ctx);
  registerAuth(app, ctx);
  const { resumePendingRevert } = registerSessions(app, ctx);
  registerWorkspace(app, ctx);
  registerReview(app, ctx);
  registerActions(app, ctx);
  registerAdmin(app, ctx);
  const { previewProxy } = registerStatic(app, ctx);
  const { handleWsUpgrade } = registerWs(app, ctx, { previewProxy, resumePendingRevert });

  /** Stops control-plane-owned background timers (the armed-run reconcile loop). Idempotent. */
  const dispose = () => {
    disposed = true;
    clock.clearTimeout(reconcileTimer);
    reconcileTimer = null;
    // Publish CI/deploy poll loops stop at their next step; their runs resume after restart
    publishService.shutdown();
  };

  /**
   * Last step before the database closes on shutdown: records spend for LLM streams still in
   * flight (and aborts their upstream calls) so no usage is lost to a closed SQLite handle.
   */
  const drainInFlight = () => {
    llmProxy.drain();
  };

  return {
    app,
    db,
    driver,
    auth,
    github,
    publishService,
    screenshotService,
    handleWsUpgrade,
    dispose,
    drainInFlight,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const preExistingEnv = { ...process.env };
  for (const envFile of ['.env.local', '.env', '../../.env.local', '../../.env']) {
    try {
      process.loadEnvFile(envFile);
    } catch (err) {
      // A missing env file is normal; anything else (unreadable, malformed) deserves a warning
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        ignore(err, 'loading env file failed', { envFile });
      }
    }
  }
  Object.assign(process.env, preExistingEnv);

  // Last-resort handlers. A stray rejection is logged and survived; an uncaught exception leaves
  // the process in an unknown state, so log it, close SQLite cleanly and exit(1) so the container
  // restart policy brings up a fresh process.
  let fatalDb: ControlPlaneDb | null = null;
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', { err: reason });
  });
  process.on('uncaughtException', (err, origin) => {
    logger.error('uncaught exception; exiting', { origin, err });
    try {
      fatalDb?.close();
    } catch (closeErr) {
      logger.error('closing database after uncaught exception failed', { err: closeErr });
    }
    process.exit(1);
  });

  const config = loadConfig();
  // The process-level timers below (shutdown grace, startup reconcile retry) share the clock
  // the control plane runs on.
  const clock: Clock = realClock;
  const cp = createControlPlane(config, undefined, undefined, { clock });
  fatalDb = cp.db;
  const stopReaper = startSessionReaper(config, cp.db, cp.driver, {
    clock,
    extraPasses: [{ name: 'manual-merge reconcile', run: () => cp.publishService.reconcileManualMerges() }],
  });
  void fs
    .mkdir(path.join(config.dataDir, 'backups'), { recursive: true })
    .catch((err) => ignore(err, 'creating backups directory failed', { dataDir: config.dataDir }));

  const server = serve({
    fetch: cp.app.fetch,
    port: config.port,
    hostname: '0.0.0.0',
    createServer,
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    cp.handleWsUpgrade(req, socket, head, wss);
  });

  let shuttingDown = false;
  const SHUTDOWN_GRACE_MS = 10_000;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down: draining in-flight requests', { signal, graceMs: SHUTDOWN_GRACE_MS });
    stopReaper();
    cp.dispose();
    // Stop accepting new connections/upgrades; let in-flight HTTP requests finish within the grace.
    for (const client of wss.clients) client.close(1012, 'Server restarting');
    wss.close();
    const drained = new Promise<void>((resolve) => server.close(() => resolve()));
    const httpServer = server as unknown as { closeIdleConnections?: () => void; closeAllConnections?: () => void };
    httpServer.closeIdleConnections?.();
    const grace = new Promise<'timeout'>((resolve) => clock.setTimeout(() => resolve('timeout'), SHUTDOWN_GRACE_MS));
    void Promise.race([drained.then(() => 'drained' as const), grace])
      .then((outcome) => {
        if (outcome === 'timeout') {
          logger.warn('shutdown grace elapsed; closing remaining connections');
          httpServer.closeAllConnections?.();
        }
        cp.drainInFlight();
        return Promise.allSettled([
          Promise.resolve(cp.driver.stopWarmPool?.()),
          Promise.resolve(cp.driver.close?.()),
          cp.screenshotService.close(),
        ]);
      })
      .finally(() => {
        cp.db.close();
        process.exit(0);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Opt-in orphan containment for local / test launches (Docker's tini never goes away): if whatever
  // started us dies, shut down cleanly, which also stops the local supervisor and its sessions.
  if (process.env.HALLEY_EXIT_WITH_PARENT === '1') {
    const originalPpid = process.ppid;
    const checkParent = () => {
      if (process.ppid !== originalPpid) {
        logger.warn('control plane: parent process died; shutting down');
        shutdown('parent-exit');
        return;
      }
      realClock.setTimeout(checkParent, 2_000); // realClock timers are unref'd
    };
    realClock.setTimeout(checkParent, 2_000);
  }

  console.log(`[halley-control-plane] listening on http://0.0.0.0:${config.port} (repo=${config.repo})`);
  if (cp.driver.runDoctorChecks) {
    void (async () => {
      try {
        const report = await cp.driver.runDoctorChecks!();
        for (const w of report.warnings) console.warn(`[halley-doctor] WARN: ${w}`);
        for (const e of report.errors) console.error(`[halley-doctor] ERROR: ${e}`);
        if (!report.ok && cp.driver.reconcileSessions) {
          // Workspaces container may still be finishing entrypoint/startup; retry reconciliation briefly
          for (let attempt = 0; attempt < 15 && !shuttingDown; attempt++) {
            await clock.sleep(2_000);
            try {
              await cp.driver.reconcileSessions();
              break;
            } catch (err) {
              ignore(err, 'startup reconcile: workspaces still starting', { attempt }, 'debug');
            }
          }
        }
      } catch (err) {
        ignore(err, 'startup doctor checks failed');
      }
    })();
  }
  cp.driver.startWarmPool?.();
}
