import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE_HOST_PROTOCOL_VERSION, type BootProgressDto, type BootStage } from '@halley/shared';
import { extractBearerToken, safeEqualToken } from '@halley/shared/auth';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { scanBareGitRepo } from './astro-optimizer.js';
import { FifoBuildQueue } from './build-queue.js';
import {
  ignore,
  ignoreExpected,
  logger,
  MISSING_PATH_CODES,
  orDefault,
  readJsonBodyOrEmpty,
  requestContextMiddleware,
} from './log.js';
import { AsyncMutex, KeyedMutex } from './mutex.js';
import { NodeModulesCacheManager } from './nm-cache.js';
import { envInt, execFileGroup, setProcessRunner, onParentDeath } from './proc.js';
import { realClock, sleep, type TimerHandle } from './clock.js';
import {
  WARM_SLOT_MARKER,
  MAX_LOG_LINES_PER_SESSION,
  MAX_IDLE_LOG_BUFFERS,
  MAX_DELETED_TOMBSTONES,
  DELETED_TOMBSTONE_TTL_MS,
  STOP_ALL_EXTRA_MS,
  DiskPressureError,
  StartPhaseTimings,
  SupervisorOptions,
  ManagedSession,
  CrashedSessionInfo,
  WarmSlot,
  DiskUsageInfo,
  runnerFetch,
  fileExists,
  parseBootStageFromLine,
} from './supervisor/shared.js';
import { createMirror } from './supervisor/mirror.js';
import { createProcessManager } from './supervisor/process-manager.js';
import { createWarmPool } from './supervisor/warm-pool.js';
import { createMaintenance } from './supervisor/maintenance.js';
import { registerSessionRoutes } from './supervisor/session-routes.js';
import { registerBuildLockRoutes } from './supervisor/build-lock-routes.js';
import type { SupervisorContext } from './supervisor/context.js';
export { WARM_SLOT_MARKER, DiskPressureError } from './supervisor/shared.js';
export type { CrashedSessionInfo, DiskUsageInfo, StartPhaseTimings, SupervisorOptions } from './supervisor/shared.js';

export function createWorkspaceSupervisor(opts: SupervisorOptions) {
  if (opts.processRunner) setProcessRunner(opts.processRunner);
  const clock = opts.clock ?? realClock;
  const instanceId = crypto.randomUUID();
  const workspacesDir = path.resolve(opts.workspacesDir);
  const sessionsRoot = path.join(workspacesDir, 'sessions');
  const mirrorDir = path.join(workspacesDir, 'git-mirror', 'repo.git');
  const nmCacheDir = path.join(workspacesDir, 'nm-cache');
  const pkgCacheDir = path.join(workspacesDir, 'pkg-cache');
  const verifySandboxDir = path.join(workspacesDir, 'verify-sandbox');
  const nmCache = new NodeModulesCacheManager(nmCacheDir, pkgCacheDir, 2);
  const buildQueueTimeoutMs = opts.buildQueueTimeoutMs ?? 10 * 60_000;
  const buildQueue = new FifoBuildQueue(
    buildQueueTimeoutMs,
    envInt('HALLEY_BUILD_MAX_LEASE_MS', 15 * 60_000, 1_000),
    3_500,
    (msg, fields) => logger.warn(msg, fields),
    clock,
  );
  // W6: per-process heap caps so one runaway session cannot OOM the whole shared container
  const runnerHeapMb = envInt('HALLEY_RUNNER_MAX_OLD_SPACE_MB', 1536, 128);
  // W6e: must exceed the runner's own shutdown budget (HALLEY_RUNNER_SHUTDOWN_BUDGET_MS, 4s)
  const runnerStopGraceMs = envInt('HALLEY_RUNNER_STOP_GRACE_MS', 5_000, 100);
  const crashedSessions: CrashedSessionInfo[] = [];

  let activeHostSecret = (opts.hostSecret || '').trim();

  // Port lease registry prevents ephemeral TOCTOU collisions across concurrent boots
  const leasedPorts = new Set<number>();

  async function allocateLeasedPort(host = '0.0.0.0'): Promise<number> {
    for (let attempt = 0; attempt < 24; attempt++) {
      const candidate = await new Promise<number>((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, host, () => {
          const addr = srv.address();
          if (addr && typeof addr === 'object') {
            const port = addr.port;
            srv.close(() => resolve(port));
          } else {
            srv.close(() => reject(new Error('Failed to allocate port')));
          }
        });
        srv.on('error', reject);
      });
      if (!leasedPorts.has(candidate)) {
        leasedPorts.add(candidate);
        return candidate;
      }
    }
    throw new Error('Exhausted port lease allocation attempts');
  }

  function releaseLeasedPort(port: number): void {
    if (port <= 0) return;
    clock
      .setTimeout(() => {
        leasedPorts.delete(port);
      }, 1500)
      .unref?.();
  }

  const activeSessions = new Map<string, ManagedSession>();
  const bootingSessions = new Map<string, Promise<ManagedSession>>();
  /** id -> deletion time; bounded (see pruneTombstones). */
  const deletedSessionIds = new Map<string, number>();
  const logsBySession = new Map<string, string[]>();
  const bootProgressBySession = new Map<string, BootProgressDto>();
  const startPhasesBySession = new Map<string, StartPhaseTimings>();
  /** W-LRU: serializes cap admission so concurrent /start calls cannot both pass the cap. */
  const admissionMutex = new AsyncMutex();
  /** Sessions admitted under the cap whose runner is not in activeSessions (or not ready) yet. */
  const admittedBooting = new Set<string>();
  /** Serializes supervisor-side git ops on a stopped session with that session's runner boot. */
  const sessionGitLocks = new KeyedMutex();

  // Disk admission control (W-disk)
  const minFreeDiskBytes = envInt('HALLEY_MIN_FREE_DISK_MB', 2048, 0) * 1024 * 1024;
  const minFreeDiskPercent = envInt('HALLEY_MIN_FREE_DISK_PERCENT', 5, 0, 100);
  let lastDiskPressureLogAt = 0;

  function diskThresholdBytes(totalBytes: number): number {
    return Math.max(minFreeDiskBytes, Math.floor((totalBytes * minFreeDiskPercent) / 100));
  }

  function isDiskPressure(usage: DiskUsageInfo | null): boolean {
    if (!usage || usage.totalBytes <= 0) return false;
    return usage.freeBytes < diskThresholdBytes(usage.totalBytes);
  }

  /** Throws DiskPressureError (HTTP 507) when free space on the workspaces volume is below threshold. */
  async function assertDiskAdmission(operation: string, fields?: Record<string, unknown>): Promise<void> {
    const usage = await getDiskUsage();
    if (!usage || !isDiskPressure(usage)) return;
    const threshold = diskThresholdBytes(usage.totalBytes);
    const now = clock.now();
    if (now - lastDiskPressureLogAt > 10_000) {
      lastDiskPressureLogAt = now;
      logger.error('supervisor: refusing operation under disk pressure', {
        operation,
        freeBytes: usage.freeBytes,
        thresholdBytes: threshold,
        usedPercent: usage.usedPercent,
        ...fields,
      });
    }
    throw new DiskPressureError(operation, usage.freeBytes, threshold);
  }

  function markDeleted(sessionId: string): void {
    deletedSessionIds.delete(sessionId);
    deletedSessionIds.set(sessionId, clock.now());
    pruneTombstones();
  }

  function pruneTombstones(): void {
    const now = clock.now();
    for (const [id, at] of deletedSessionIds) {
      const overCap = deletedSessionIds.size > MAX_DELETED_TOMBSTONES;
      if (!overCap && now - at < DELETED_TOMBSTONE_TTL_MS) break; // insertion order = oldest first
      if (bootingSessions.has(id)) continue;
      deletedSessionIds.delete(id);
    }
  }

  /** Drops log buffers of sessions that are not running, keeping the most recent MAX_IDLE_LOG_BUFFERS. */
  function pruneLogBuffers(): void {
    const idle = [...logsBySession.keys()].filter(
      (id) => !activeSessions.has(id) && !bootingSessions.has(id) && !reservedWarmSlots.has(id),
    );
    for (const id of idle.slice(0, Math.max(0, idle.length - MAX_IDLE_LOG_BUFFERS))) {
      logsBySession.delete(id);
      startPhasesBySession.delete(id);
    }
  }

  let warmPool: WarmSlot[] = [];
  const reservedWarmSlots = new Map<string, WarmSlot>();
  let warmPoolRunning = false;
  let warmHealthTimer: TimerHandle | null = null;
  let supervisorSelfUrl = `http://127.0.0.1:${opts.port ?? 4000}`;

  const runnerEntry =
    opts.runnerEntry ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'index.js');

  const controlPlaneBase = opts.controlPlaneInternalUrl.replace(/\/+$/, '');
  const internalGitUrl = `${controlPlaneBase}/internal/git/repo.git`;

  function setSupervisorSelfUrl(url: string): void {
    supervisorSelfUrl = url.replace(/\/+$/, '');
  }

  function sessionDir(sessionId: string): string {
    return path.join(sessionsRoot, sessionId);
  }

  function appendLog(sessionId: string, chunk: Buffer | string, isErr: boolean): void {
    const text = chunk.toString();
    const prefix = `[ws:${sessionId.slice(0, 6)}] `;
    const lines = text.split(/\r?\n/);
    let buf = logsBySession.get(sessionId);
    if (!buf) {
      buf = [];
      logsBySession.set(sessionId, buf);
    }
    for (const rawLine of lines) {
      if (!rawLine) continue;
      const out = `${prefix}${rawLine}\n`;
      if (isErr) process.stderr.write(out);
      else process.stdout.write(out);

      buf.push(rawLine);
      if (buf.length > MAX_LOG_LINES_PER_SESSION) {
        buf.splice(0, buf.length - MAX_LOG_LINES_PER_SESSION);
      }

      const parsed = parseBootStageFromLine(rawLine);
      if (parsed) {
        emitProgress(sessionId, parsed.stage, parsed.message);
      }
    }
  }

  function emitProgress(
    sessionId: string,
    stage: BootStage,
    message: string,
    extra?: { detail?: string; warmHit?: boolean; startedAt?: string },
  ): BootProgressDto {
    const prev = bootProgressBySession.get(sessionId);
    const now = new Date().toISOString();
    const progress: BootProgressDto = {
      stage,
      message,
      detail: extra?.detail,
      startedAt: extra?.startedAt ?? prev?.startedAt ?? now,
      updatedAt: now,
      warmHit: extra?.warmHit ?? prev?.warmHit,
    };
    bootProgressBySession.set(sessionId, progress);
    return progress;
  }

  async function runGit(
    cwd: string,
    args: string[],
    includeAuthHeader = false,
    timeoutMs = 30_000,
  ): Promise<string> {
    const fullArgs = ['-c', 'safe.directory=*'];
    if (includeAuthHeader && activeHostSecret) {
      fullArgs.push('-c', `http.extraHeader=Authorization: Bearer ${activeHostSecret}`);
    }
    fullArgs.push(...args);
    // Own process group: a timed-out fetch/clone also kills git-remote-https and friends (W10)
    const { stdout } = await execFileGroup('git', fullArgs, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 32 * 1024 * 1024,
      timeoutMs,
    });
    return stdout.trim();
  }

  // The supervisor's parts (src/supervisor/*) share an explicit, typed view of its state;
  // mutable fields and parts created later are accessors, so reads are always current.
  const ctx: SupervisorContext = {
    opts,
    clock,
    instanceId,
    sessionsRoot,
    mirrorDir,
    nmCacheDir,
    pkgCacheDir,
    verifySandboxDir,
    nmCache,
    buildQueueTimeoutMs,
    buildQueue,
    runnerHeapMb,
    runnerStopGraceMs,
    crashedSessions,
    get activeHostSecret() {
      return activeHostSecret;
    },
    set activeHostSecret(v) {
      activeHostSecret = v;
    },
    allocateLeasedPort,
    releaseLeasedPort,
    activeSessions,
    bootingSessions,
    deletedSessionIds,
    logsBySession,
    bootProgressBySession,
    startPhasesBySession,
    admissionMutex,
    admittedBooting,
    sessionGitLocks,
    assertDiskAdmission,
    markDeleted,
    pruneTombstones,
    pruneLogBuffers,
    get warmPool() {
      return warmPool;
    },
    set warmPool(v) {
      warmPool = v;
    },
    reservedWarmSlots,
    get warmPoolRunning() {
      return warmPoolRunning;
    },
    set warmPoolRunning(v) {
      warmPoolRunning = v;
    },
    get warmHealthTimer() {
      return warmHealthTimer;
    },
    set warmHealthTimer(v) {
      warmHealthTimer = v;
    },
    get supervisorSelfUrl() {
      return supervisorSelfUrl;
    },
    set supervisorSelfUrl(v) {
      supervisorSelfUrl = v;
    },
    runnerEntry,
    controlPlaneBase,
    internalGitUrl,
    sessionDir,
    appendLog,
    emitProgress,
    runGit,
    get withMirrorRead() {
      return withMirrorRead;
    },
    get syncLocalMirror() {
      return syncLocalMirror;
    },
    get runMirrorMaintenance() {
      return runMirrorMaintenance;
    },
    get discardSlot() {
      return discardSlot;
    },
    get recycleStaleWarmSlots() {
      return recycleStaleWarmSlots;
    },
    get stopSessionProcess() {
      return stopSessionProcess;
    },
    get admitSession() {
      return admitSession;
    },
    get spawnRunnerForSession() {
      return spawnRunnerForSession;
    },
    get replenishWarmPool() {
      return replenishWarmPool;
    },
  };
  const { withMirrorRead, syncLocalMirror, runMirrorMaintenance } = createMirror(ctx);
  const { stopSessionProcess, admitSession, spawnRunnerForSession } = createProcessManager(ctx);
  const { discardSlot, recycleStaleWarmSlots, replenishWarmPool, startWarmPool } = createWarmPool(ctx);
  const { runMaintenance, maintenanceTimer } = createMaintenance(ctx);

  async function getDiskUsage(): Promise<DiskUsageInfo | null> {
    try {
      await fs.mkdir(workspacesDir, { recursive: true });
      const st = await fs.statfs(workspacesDir);
      const totalBytes = Number(st.blocks) * Number(st.bsize);
      const freeBytes = Number(st.bavail) * Number(st.bsize);
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      const usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0;
      return { totalBytes, freeBytes, usedBytes, usedPercent };
    } catch (err) {
      ignore(err, 'supervisor: statfs of workspaces volume');
      return null;
    }
  }

  async function stopAll(): Promise<void> {
    warmPoolRunning = false;
    clock.clearTimeout(maintenanceTimer);
    if (warmHealthTimer) {
      clock.clearTimeout(warmHealthTimer);
      warmHealthTimer = null;
    }
    const ids = [...activeSessions.keys()];
    // Each stop is already bounded (grace -> SIGKILL); this caps the whole fan-out (reaping /proc,
    // a wedged exit event) so a supervisor shutdown can never hang on one runner.
    let stopDeadline: TimerHandle | null = null;
    const timedOut = await Promise.race([
      Promise.allSettled(ids.map((id) => stopSessionProcess(id))).then(() => false),
      new Promise<boolean>((resolve) => {
        stopDeadline = clock.setTimeout(() => resolve(true), runnerStopGraceMs + STOP_ALL_EXTRA_MS);
        stopDeadline.unref?.();
      }),
    ]);
    clock.clearTimeout(stopDeadline);
    if (timedOut) logger.warn('supervisor: stopAll deadline exceeded; continuing shutdown', { sessions: ids.length });
    for (const slot of warmPool.splice(0)) {
      await fs
        .rm(sessionDir(slot.id), { recursive: true, force: true })
        .catch((e) => ignore(e, 'supervisor: remove warm slot on stop', { id: slot.id }));
    }
  }

  /**
   * W6c: on startup, remove leftovers of a supervisor that died without graceful shutdown:
   * warm-slot dirs (identified ONLY by the `.warm-slot` marker; real session dirs never carry it),
   * node_modules staging/old dirs inside session workspaces, and partial nm-cache installs.
   */
  async function sweepLeftovers(): Promise<void> {
    // no sessions root yet (first boot) is expected; anything else is logged and the sweep skipped
    const entries = await orDefault(fs.readdir(sessionsRoot, { withFileTypes: true }), [], 'supervisor: list sessions for leftover sweep', {
      expected: MISSING_PATH_CODES,
      fields: { sessionsRoot },
    });
    let removedSlots = 0;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const id = e.name;
      const dir = sessionDir(id);
      const inUse =
        activeSessions.has(id) ||
        bootingSessions.has(id) ||
        reservedWarmSlots.has(id) ||
        warmPool.some((s) => s.id === id);
      if (!inUse && (await fileExists(path.join(dir, WARM_SLOT_MARKER)))) {
        await fs.rm(dir, { recursive: true, force: true }).catch((err) => ignore(err, 'sweep: warm slot', { id }));
        removedSlots++;
        continue;
      }
      if (inUse) continue;
      const ws = path.join(dir, 'workspace');
      const wsEntries = await orDefault(fs.readdir(ws), [] as string[], 'sweep: list session workspace', {
        expected: MISSING_PATH_CODES,
        silentExpected: true,
        fields: { ws },
      });
      for (const name of wsEntries) {
        if (name.startsWith('.node_modules.tmp-') || name.startsWith('.node_modules.old-')) {
          await fs.rm(path.join(ws, name), { recursive: true, force: true }).catch((err) => ignore(err, 'sweep: nm scratch'));
        }
      }
    }
    const cacheEntries = await orDefault(fs.readdir(nmCacheDir), [] as string[], 'sweep: list nm-cache', {
      expected: MISSING_PATH_CODES,
      fields: { nmCacheDir },
    });
    for (const name of cacheEntries) {
      if (name.startsWith('.tmp-')) {
        await fs.rm(path.join(nmCacheDir, name), { recursive: true, force: true }).catch((err) => ignore(err, 'sweep: nm-cache tmp'));
      }
    }
    if (removedSlots > 0) {
      logger.info('supervisor: swept leftover warm-slot dirs from a previous run', { removedSlots });
    }
  }
  const startupSweep = sweepLeftovers().catch((err) => ignore(err, 'supervisor: startup sweep'));

  function getWarmPoolStatus() {
    return {
      enabled: opts.warmPoolSize > 0,
      target: opts.warmPoolSize,
      ready: warmPool.filter((s) => s.state === 'ready').length,
      warming: warmPool.filter((s) => s.state === 'warming').length,
    };
  }

  const app = new Hono();
  // Correlation ids (X-Request-Id / X-Halley-Run-Id) land on every log line of the request
  app.use('*', requestContextMiddleware());

  /**
   * Zero-config HKDF handshake from control-plane: adopts `internalHostToken` on startup
   * when `WORKSPACE_HOST_SECRET` was not set manually, then enforces mandatory Bearer auth!
   */
  app.post('/api/handshake', async (c) => {
    const body = (await readJsonBodyOrEmpty(c)) as { internalHostToken?: string };
    const candidate = (body.internalHostToken || '').trim();
    if (!candidate) {
      return c.json({ error: 'Missing internalHostToken' }, 400);
    }
    if (!activeHostSecret) {
      activeHostSecret = candidate;
      startWarmPool();
    } else if (!safeEqualToken(candidate, activeHostSecret)) {
      return c.json({ error: 'Unauthorized: host secret mismatch' }, 401);
    }
    return c.json({
      ok: true,
      protocolVersion: WORKSPACE_HOST_PROTOCOL_VERSION,
      instanceId,
    });
  });

  app.use('*', async (c, next) => {
    if (c.req.path === '/api/handshake') return next();
    if (activeHostSecret) {
      const bearer = extractBearerToken(c.req.header('authorization'));
      if (!safeEqualToken(bearer, activeHostSecret)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
    }
    return next();
  });

  app.get('/health', async (c) => {
    const diskUsage = await getDiskUsage();
    const activeNonWarm = [...activeSessions.values()].filter((s) => !s.isWarmStandby);
    const astroReadySessionIds: string[] = [];
    await Promise.all(
      activeNonWarm.map(async (s) => {
        try {
          const r = await runnerFetch(`http://127.0.0.1:${s.runnerPort}/health`, {
            signal: clock.timeoutSignal(1500),
          });
          if (r.ok) {
            const d = (await r.json()) as { astroReady?: boolean };
            if (d.astroReady) astroReadySessionIds.push(s.id);
          }
        } catch (err) {
          // not ready / unreachable: simply not listed as astro-ready
          ignoreExpected(err, 'supervisor: runner health for /health aggregation', { sessionId: s.id });
        }
      }),
    );
    const activeIds = activeNonWarm.map((s) => s.id);
    return c.json({
      ok: true,
      protocolVersion: WORKSPACE_HOST_PROTOCOL_VERSION,
      instanceId,
      activeSessionIds: activeIds,
      astroReadySessionIds,
      activeCount: activeIds.length,
      maxActiveWorkspaces: opts.maxActiveWorkspaces,
      warmPool: getWarmPoolStatus(),
      buildQueue: buildQueue.getStatus(),
      diskUsage,
      // W-disk: new starts / clones / installs / verify builds are refused while true
      diskPressure: isDiskPressure(diskUsage),
      diskThresholdBytes: diskUsage ? diskThresholdBytes(diskUsage.totalBytes) : null,
      crashedSessions: crashedSessions.map(({ logTail: _logTail, ...rest }) => rest),
    });
  });

  registerSessionRoutes(app, ctx);

  registerBuildLockRoutes(app, ctx);

  app.post('/api/optimize/scan', async (c) => {
    const body = (await readJsonBodyOrEmpty(c)) as {
      baseBranch?: string;
      repo?: string;
    };
    const branch = body.baseBranch || opts.baseBranch;
    const repoSlug = body.repo || opts.repo;
    try {
      await syncLocalMirror(branch);
      const scanned = await scanBareGitRepo(mirrorDir, {
        repoSlug,
        baseBranch: branch,
      });
      return c.json(scanned);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Repository scan failed' },
        500,
      );
    }
  });

  return {
    app,
    instanceId,
    buildQueue,
    startWarmPool,
    stopAll,
    setSupervisorSelfUrl,
    getWarmPoolStatus,
    startupSweep,
    runMaintenance,
    nmCache,
  };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  // Fail-stop: after an uncaught exception the process state is unknown, so shut down (bounded) and
  // exit non-zero; Docker restarts us and the control plane reconciles sessions from disk.
  let fatalShutdownStarted = false;
  let fatalShutdown: (() => void) | null = null;
  process.on('uncaughtException', (err) => {
    logger.error('supervisor: uncaughtException; shutting down', { err });
    if (fatalShutdownStarted) return;
    fatalShutdownStarted = true;
    const hardExit = setTimeout(() => process.exit(1), 10_000);
    hardExit.unref();
    if (fatalShutdown) fatalShutdown();
    else process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('supervisor: unhandledRejection', { err: reason });
  });
  const port = Number(process.env.SUPERVISOR_PORT || 4000);
  const bindHost = process.env.SUPERVISOR_BIND_HOST || '0.0.0.0';
  const workspacesDir = process.env.WORKSPACES_DIR || '/workspaces';
  const controlPlaneInternalUrl =
    process.env.CONTROL_PLANE_INTERNAL_URL || 'http://control-plane:3000';
  const warmPoolRaw = process.env.HALLEY_WARM_POOL_SIZE;
  const warmPoolSize =
    warmPoolRaw !== undefined && warmPoolRaw !== ''
      ? Math.max(0, Math.min(3, Number(warmPoolRaw) || 0))
      : 1;
  const maxActiveWorkspaces = Math.max(1, Number(process.env.MAX_ACTIVE_WORKSPACES || 5) || 5);
  const initialHostSecret = (process.env.WORKSPACE_HOST_SECRET || '').trim() || undefined;

  const supervisor = createWorkspaceSupervisor({
    workspacesDir,
    controlPlaneInternalUrl,
    hostSecret: initialHostSecret,
    repo: process.env.HALLEY_REPO || 'vrwarp/thecrossing.website',
    baseBranch: process.env.HALLEY_BASE_BRANCH || 'main',
    modelId: process.env.HALLEY_MODEL_ID || 'haiku-latest',
    thinkingLevel: (process.env.HALLEY_THINKING_LEVEL || 'high') as
      | 'off'
      | 'low'
      | 'medium'
      | 'high',
    gitBotName: process.env.HALLEY_GIT_BOT_NAME || 'Halley Bot',
    gitBotEmail: process.env.HALLEY_GIT_BOT_EMAIL || 'halley-bot@users.noreply.github.com',
    warmPoolSize,
    maxActiveWorkspaces,
    devLocalRepo: process.env.HALLEY_DEV_LOCAL_REPO || undefined,
    bindHost,
    port,
  });

  supervisor.setSupervisorSelfUrl(`http://127.0.0.1:${port}`);

  const server = serve({
    fetch: supervisor.app.fetch,
    port,
    hostname: bindHost,
    createServer,
  });

  console.log(
    `[halley-supervisor] listening on http://${bindHost}:${port} (protocol=v${WORKSPACE_HOST_PROTOCOL_VERSION}, dir=${workspacesDir}, maxActive=${maxActiveWorkspaces}, warmPool=${warmPoolSize})`,
  );

  // If WORKSPACE_HOST_SECRET was explicitly provided via env, start warm pool once control-plane is reachable;
  // otherwise `/api/handshake` from control-plane provides the HKDF token and starts the warm pool!
  if (initialHostSecret) {
    void (async () => {
      const cpHealthUrl = `${controlPlaneInternalUrl.replace(/\/+$/, '')}/api/health`;
      const deadline = realClock.now() + 60_000;
      while (realClock.now() < deadline) {
        try {
          const res = await fetch(cpHealthUrl, { signal: realClock.timeoutSignal(2000) });
          if (res.ok) break;
        } catch (err) {
          ignoreExpected(err, 'supervisor: control plane not reachable yet');
        }
        await sleep(realClock, 1000);
      }
      supervisor.startWarmPool();
    })();
  }

  let shuttingDown = false;
  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void supervisor.stopAll().finally(() => {
      server.close();
      process.exit(code);
    });
  };
  fatalShutdown = () => shutdown(1);
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  // Local (non-Docker) mode: the control plane spawns us and sets this; if it dies we must not keep
  // running its sessions unsupervised. In Docker our parent is tini, which never goes away.
  if (process.env.HALLEY_EXIT_WITH_PARENT === '1') {
    onParentDeath(() => {
      logger.warn('supervisor: parent process died; stopping all sessions and exiting');
      shutdown(1);
    });
  }
}
