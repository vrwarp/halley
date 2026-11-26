import { execFile, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  WORKSPACE_HOST_PROTOCOL_VERSION,
  type BootProgressDto,
  type BootStage,
} from '@halley/shared';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { scanBareGitRepo } from './astro-optimizer.js';
import { BuildQueueTimeoutError, FifoBuildQueue } from './build-queue.js';
import { NodeModulesCacheManager } from './nm-cache.js';

const execFileAsync = promisify(execFile);

const MAX_LOG_LINES_PER_SESSION = 500;

const BOOT_STAGE_MESSAGES: Partial<Record<BootStage, string>> = {
  syncing_repo: 'Syncing latest website repository…',
  cloning_repo: 'Cloning website files…',
  installing_deps: 'Installing project packages…',
  starting_preview: 'Starting Astro live preview…',
  starting_ai: 'Starting AI editing assistant…',
  claiming_warm: 'Connecting to ready workspace…',
  ready: 'Workspace ready!',
};

export interface SupervisorOptions {
  workspacesDir: string;
  controlPlaneInternalUrl: string;
  hostSecret?: string;
  repo: string;
  baseBranch: string;
  modelId: string;
  thinkingLevel: 'off' | 'low' | 'medium' | 'high';
  gitBotName: string;
  gitBotEmail: string;
  warmPoolSize: number;
  maxActiveWorkspaces: number;
  buildQueueTimeoutMs?: number;
  devLocalRepo?: string;
  runnerEntry?: string;
  bindHost?: string;
  port?: number;
}

interface ManagedSession {
  id: string;
  proc: ChildProcess;
  runnerPort: number;
  astroPort: number;
  astroBase: string;
  baseSha: string;
  lastActiveAt: number;
  isWarmStandby: boolean;
}

interface WarmSlot {
  id: string;
  rawToken: string;
  state: 'warming' | 'ready' | 'failed';
  runnerPort: number;
  astroPort: number;
  astroBase: string;
  baseSha: string;
  progress: BootProgressDto;
  bootPromise: Promise<void>;
  claimedBySessionId: string | null;
}

export interface DiskUsageInfo {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

async function getFreePort(host = '0.0.0.0'): Promise<number> {
  return new Promise((resolve, reject) => {
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
}

async function fileExists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

function parseBootStageFromLine(line: string): { stage: BootStage; message: string } | null {
  const m = line.match(/\[halley-boot\]\s+([a-z_]+)/);
  const stage = m?.[1] as BootStage | undefined;
  if (!stage) return null;
  const message = BOOT_STAGE_MESSAGES[stage];
  if (!message) return null;
  return { stage, message };
}

export function createWorkspaceSupervisor(opts: SupervisorOptions) {
  const instanceId = crypto.randomUUID();
  const workspacesDir = path.resolve(opts.workspacesDir);
  const sessionsRoot = path.join(workspacesDir, 'sessions');
  const mirrorDir = path.join(workspacesDir, 'git-mirror', 'repo.git');
  const nmCacheDir = path.join(workspacesDir, 'nm-cache');
  const pkgCacheDir = path.join(workspacesDir, 'pkg-cache');
  const nmCache = new NodeModulesCacheManager(nmCacheDir, pkgCacheDir, 2);
  const buildQueue = new FifoBuildQueue(opts.buildQueueTimeoutMs ?? 10 * 60_000);

  const activeSessions = new Map<string, ManagedSession>();
  const bootingSessions = new Map<string, Promise<ManagedSession>>();
  const logsBySession = new Map<string, string[]>();
  const bootProgressBySession = new Map<string, BootProgressDto>();

  let warmPool: WarmSlot[] = [];
  const reservedWarmSlots = new Map<string, WarmSlot>();
  let warmPoolRunning = false;
  let warmHealthTimer: NodeJS.Timeout | null = null;
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

  async function runGit(cwd: string, args: string[], includeAuthHeader = false): Promise<string> {
    const fullArgs = ['-c', 'safe.directory=*'];
    if (includeAuthHeader && opts.hostSecret) {
      fullArgs.push('-c', `http.extraHeader=Authorization: Bearer ${opts.hostSecret}`);
    }
    fullArgs.push(...args);
    const { stdout } = await execFileAsync('git', fullArgs, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout.trim();
  }

  let mirrorSyncPromise: Promise<string> | null = null;
  async function syncLocalMirror(baseBranch: string): Promise<string> {
    if (mirrorSyncPromise) return mirrorSyncPromise;
    mirrorSyncPromise = (async () => {
      const exists = await fileExists(path.join(mirrorDir, 'HEAD'));
      if (!exists) {
        await fs.mkdir(path.dirname(mirrorDir), { recursive: true });
        await fs.mkdir(mirrorDir, { recursive: true });
        await runGit(mirrorDir, ['init', '--bare'], false);
        await runGit(mirrorDir, ['remote', 'add', 'origin', internalGitUrl], false);
      } else {
        await runGit(mirrorDir, ['remote', 'set-url', 'origin', internalGitUrl], false).catch(() => {});
      }
      await runGit(
        mirrorDir,
        ['fetch', 'origin', `+refs/heads/${baseBranch}:refs/heads/${baseBranch}`],
        true,
      );
      await runGit(mirrorDir, ['symbolic-ref', 'HEAD', `refs/heads/${baseBranch}`]).catch(() => {});
      return runGit(mirrorDir, ['rev-parse', `refs/heads/${baseBranch}`]).catch(() => '');
    })().finally(() => {
      mirrorSyncPromise = null;
    });
    return mirrorSyncPromise;
  }

  async function getDiskUsage(): Promise<DiskUsageInfo | null> {
    try {
      await fs.mkdir(workspacesDir, { recursive: true });
      const st = await fs.statfs(workspacesDir);
      const totalBytes = Number(st.blocks) * Number(st.bsize);
      const freeBytes = Number(st.bavail) * Number(st.bsize);
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      const usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0;
      return { totalBytes, freeBytes, usedBytes, usedPercent };
    } catch {
      return null;
    }
  }

  async function stopSessionProcess(sessionId: string): Promise<void> {
    bootProgressBySession.delete(sessionId);
    buildQueue.releaseBySession(sessionId);
    const managed = activeSessions.get(sessionId);
    activeSessions.delete(sessionId);
    if (!managed) return;
    if (managed.proc.exitCode === null) {
      managed.proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 1500);
        t.unref?.();
        managed.proc.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
      if (managed.proc.exitCode === null) {
        managed.proc.kill('SIGKILL');
      }
    }
  }

  async function enforceLruCap(excludeSessionId: string, protectedIds: Set<string>): Promise<void> {
    const cap = opts.maxActiveWorkspaces;
    if (cap <= 0) return;

    const nonWarm = [...activeSessions.values()].filter(
      (s) => !s.isWarmStandby && s.id !== excludeSessionId,
    );
    if (nonWarm.length < cap) return;

    // Sort oldest lastActiveAt first
    nonWarm.sort((a, b) => a.lastActiveAt - b.lastActiveAt);

    let activeCount = nonWarm.length;
    for (const candidate of nonWarm) {
      if (activeCount < cap) break;
      if (protectedIds.has(candidate.id)) continue;

      // Check if candidate's Pi agent is currently busy
      let piBusy = false;
      try {
        const res = await fetch(`http://127.0.0.1:${candidate.runnerPort}/health`, {
          signal: AbortSignal.timeout(1500),
        });
        if (res.ok) {
          const data = (await res.json()) as { piBusy?: boolean };
          piBusy = Boolean(data.piBusy);
        }
      } catch {
        // unreachable -> safe to evict
      }
      if (piBusy) continue;

      console.log(
        `[halley-supervisor] LRU cap (${cap}) reached — putting idle session ${candidate.id.slice(0, 8)} to sleep`,
      );
      await stopSessionProcess(candidate.id);
      activeCount--;
    }
  }

  async function spawnRunnerForSession(params: {
    sessionId: string;
    workspaceDir: string;
    stateDir: string;
    baseBranch: string;
    baseSha: string;
    workspaceToken: string;
    persona: 'non-technical' | 'developer';
    editorName: string;
    editorEmail: string;
    readOnly: boolean;
    isWarmStandby: boolean;
  }): Promise<ManagedSession> {
    const bindHost = opts.bindHost || '0.0.0.0';
    const runnerPort = await getFreePort(bindHost);
    const astroPort = await getFreePort(bindHost);

    emitProgress(params.sessionId, 'starting_preview', 'Starting Astro live preview…', {
      warmHit: params.isWarmStandby || undefined,
    });

    const child = spawn(process.execPath, [runnerEntry], {
      cwd: params.workspaceDir,
      env: {
        ...process.env,
        HALLEY_WORKSPACE_DIR: params.workspaceDir,
        HALLEY_STATE_DIR: params.stateDir,
        HALLEY_SESSION_ID: params.sessionId,
        HALLEY_BASE_BRANCH: params.baseBranch,
        HALLEY_BASE_SHA: params.baseSha,
        HALLEY_MIRROR_PATH: mirrorDir,
        HALLEY_PKG_CACHE_DIR: pkgCacheDir,
        RUNNER_PORT: String(runnerPort),
        ASTRO_PORT: String(astroPort),
        CONTROL_PLANE_INTERNAL_URL: controlPlaneBase,
        HALLEY_SUPERVISOR_URL: supervisorSelfUrl,
        ...(opts.hostSecret ? { WORKSPACE_HOST_SECRET: opts.hostSecret } : {}),
        WORKSPACE_TOKEN: params.workspaceToken,
        HALLEY_MODEL_ID: opts.modelId,
        HALLEY_THINKING_LEVEL: opts.thinkingLevel,
        HALLEY_PERSONA: params.persona,
        HALLEY_GIT_BOT_NAME: opts.gitBotName,
        HALLEY_GIT_BOT_EMAIL: opts.gitBotEmail,
        HALLEY_EDITOR_NAME: params.editorName,
        HALLEY_EDITOR_EMAIL: params.editorEmail,
        HALLEY_READ_ONLY: params.readOnly ? 'true' : 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const managed: ManagedSession = {
      id: params.sessionId,
      proc: child,
      runnerPort,
      astroPort,
      astroBase: '/',
      baseSha: params.baseSha,
      lastActiveAt: Date.now(),
      isWarmStandby: params.isWarmStandby,
    };
    activeSessions.set(params.sessionId, managed);

    let spawnError: Error | null = null;
    child.on('error', (err) => {
      spawnError = err;
      if (activeSessions.get(params.sessionId)?.proc === child) {
        activeSessions.delete(params.sessionId);
      }
      buildQueue.releaseBySession(params.sessionId);
    });
    child.stdout?.on('data', (d: Buffer) => appendLog(params.sessionId, d, false));
    child.stderr?.on('data', (d: Buffer) => appendLog(params.sessionId, d, true));
    child.on('exit', () => {
      if (activeSessions.get(params.sessionId)?.proc === child) {
        activeSessions.delete(params.sessionId);
      }
      buildQueue.releaseBySession(params.sessionId);
    });

    // Poll until astroReady
    const deadline = Date.now() + 90_000;
    let lastAstroState: string | undefined;
    let lastAstroLogs: string[] = [];
    while (Date.now() < deadline) {
      if (spawnError !== null) {
        throw new Error(`Failed to spawn workspace process: ${(spawnError as Error).message}`);
      }
      if (child.exitCode !== null) {
        const tail = (logsBySession.get(params.sessionId) ?? []).slice(-15).join('\n');
        throw new Error(
          `Workspace process exited unexpectedly (exit=${child.exitCode}). ${tail}`.trim(),
        );
      }
      try {
        const res = await fetch(`http://127.0.0.1:${runnerPort}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          const health = (await res.json()) as {
            originalBase?: string;
            astroReady?: boolean;
            astroState?: string;
            astroLogs?: string[];
            baseSha?: string;
          };
          managed.astroBase = health.originalBase || '/';
          if (health.baseSha) managed.baseSha = health.baseSha;
          if (health.astroState) lastAstroState = health.astroState;
          if (Array.isArray(health.astroLogs) && health.astroLogs.length > 0) {
            lastAstroLogs = health.astroLogs;
          }
          if (health.astroReady) {
            emitProgress(params.sessionId, 'ready', 'Workspace ready!');
            return managed;
          }
          if (health.astroState === 'crashed') {
            const tail = (
              lastAstroLogs.length > 0
                ? lastAstroLogs
                : (logsBySession.get(params.sessionId) ?? [])
            )
              .slice(-10)
              .join('\n');
            await stopSessionProcess(params.sessionId);
            throw new Error(
              `Workspace preview server crashed during startup.${tail ? `\n${tail}` : ''}`,
            );
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Workspace preview server crashed')) {
          throw err;
        }
        // still booting
      }
      await new Promise((r) => setTimeout(r, 350));
    }

    const tail = (
      lastAstroLogs.length > 0 ? lastAstroLogs : (logsBySession.get(params.sessionId) ?? [])
    )
      .slice(-10)
      .join('\n');
    await stopSessionProcess(params.sessionId);
    throw new Error(
      `Timed out waiting for workspace preview server to become ready${lastAstroState ? ` (state=${lastAstroState})` : ''}.${tail ? `\n${tail}` : ''}`,
    );
  }

  async function bootWarmSlot(slot: WarmSlot): Promise<void> {
    const baseDir = sessionDir(slot.id);
    const workspaceDir = path.join(baseDir, 'workspace');
    const stateDir = path.join(baseDir, 'state');

    const updateSlotProgress = (stage: BootStage, message: string) => {
      const now = new Date().toISOString();
      slot.progress = {
        stage,
        message,
        startedAt: slot.progress.startedAt,
        updatedAt: now,
        warmHit: true,
      };
      if (slot.claimedBySessionId) {
        emitProgress(slot.claimedBySessionId, stage, message, {
          startedAt: slot.progress.startedAt,
          warmHit: true,
        });
      }
    };

    try {
      console.log(`[halley-warm-pool] Warming standby workspace ${slot.id.slice(0, 8)}…`);
      updateSlotProgress('syncing_repo', 'Syncing latest website repository…');
      const headSha = await syncLocalMirror(opts.baseBranch);
      slot.baseSha = headSha;

      updateSlotProgress('cloning_repo', 'Cloning website files…');
      await fs.mkdir(stateDir, { recursive: true });
      await runGit(baseDir, ['clone', mirrorDir, 'workspace']);
      await runGit(workspaceDir, ['remote', 'set-url', 'origin', internalGitUrl]);
      await runGit(workspaceDir, [
        'checkout',
        '-B',
        `halley/standby-${slot.id.slice(0, 6)}`,
        `origin/${opts.baseBranch}`,
      ]);
      slot.baseSha = await runGit(workspaceDir, ['rev-parse', 'HEAD']);

      await nmCache.ensureSessionNodeModules({
        workspaceDir,
        stateDir,
        devLocalRepo: opts.devLocalRepo,
        onInstalling: () => updateSlotProgress('installing_deps', 'Installing project packages…'),
      });

      updateSlotProgress('starting_preview', 'Starting Astro live preview…');
      const managed = await spawnRunnerForSession({
        sessionId: slot.id,
        workspaceDir,
        stateDir,
        baseBranch: opts.baseBranch,
        baseSha: slot.baseSha,
        workspaceToken: slot.rawToken,
        persona: 'non-technical',
        editorName: 'Editor',
        editorEmail: 'editor@example.com',
        readOnly: false,
        isWarmStandby: true,
      });

      slot.runnerPort = managed.runnerPort;
      slot.astroPort = managed.astroPort;
      slot.astroBase = managed.astroBase;
      slot.baseSha = managed.baseSha;
      slot.state = 'ready';
      console.log(
        `[halley-warm-pool] Standby workspace ${slot.id.slice(0, 8)} is hot & ready (baseSha=${slot.baseSha.slice(0, 7)})`,
      );
    } catch (err) {
      slot.state = 'failed';
      console.warn(`[halley-warm-pool] Failed to warm standby ${slot.id.slice(0, 8)}:`, err);
      const idx = warmPool.indexOf(slot);
      if (idx !== -1) warmPool.splice(idx, 1);
      await stopSessionProcess(slot.id).catch(() => {});
      await fs.rm(baseDir, { recursive: true, force: true }).catch(() => {});
      if (!slot.claimedBySessionId && warmPoolRunning) {
        setTimeout(() => {
          if (warmPoolRunning) replenishWarmPool();
        }, 30_000).unref?.();
      }
    }
  }

  function replenishWarmPool(): void {
    if (!warmPoolRunning || opts.warmPoolSize <= 0) return;
    warmPool = warmPool.filter((s) => s.state !== 'failed');
    while (warmPool.length < opts.warmPoolSize) {
      const id = crypto.randomUUID();
      const rawToken = crypto.randomBytes(24).toString('hex');
      const now = new Date().toISOString();
      const slot: WarmSlot = {
        id,
        rawToken,
        state: 'warming',
        runnerPort: 0,
        astroPort: 0,
        astroBase: '/',
        baseSha: '',
        progress: {
          stage: 'syncing_repo',
          message: 'Preparing standby workspace…',
          startedAt: now,
          updatedAt: now,
          warmHit: true,
        },
        bootPromise: Promise.resolve(),
        claimedBySessionId: null,
      };
      slot.bootPromise = bootWarmSlot(slot);
      warmPool.push(slot);
    }
  }

  async function checkWarmPoolHealth(): Promise<void> {
    if (!warmPoolRunning) return;
    const unhealthy: WarmSlot[] = [];
    for (const slot of warmPool) {
      if (slot.state !== 'ready') continue;
      try {
        const res = await fetch(`http://127.0.0.1:${slot.runnerPort}/health`, {
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) unhealthy.push(slot);
      } catch {
        unhealthy.push(slot);
      }
    }
    for (const slot of unhealthy) {
      const idx = warmPool.indexOf(slot);
      if (idx !== -1) warmPool.splice(idx, 1);
      await stopSessionProcess(slot.id).catch(() => {});
      await fs.rm(sessionDir(slot.id), { recursive: true, force: true }).catch(() => {});
    }
    replenishWarmPool();
  }

  function startWarmPool(): void {
    if (opts.warmPoolSize <= 0 || warmPoolRunning) return;
    warmPoolRunning = true;
    replenishWarmPool();
    warmHealthTimer = setInterval(() => {
      void checkWarmPoolHealth();
    }, 120_000);
    warmHealthTimer.unref?.();
  }

  async function stopAll(): Promise<void> {
    warmPoolRunning = false;
    if (warmHealthTimer) {
      clearInterval(warmHealthTimer);
      warmHealthTimer = null;
    }
    const ids = [...activeSessions.keys()];
    await Promise.allSettled(ids.map((id) => stopSessionProcess(id)));
    for (const slot of warmPool.splice(0)) {
      await fs.rm(sessionDir(slot.id), { recursive: true, force: true }).catch(() => {});
    }
  }

  function getWarmPoolStatus() {
    return {
      enabled: opts.warmPoolSize > 0,
      target: opts.warmPoolSize,
      ready: warmPool.filter((s) => s.state === 'ready').length,
      warming: warmPool.filter((s) => s.state === 'warming').length,
    };
  }

  const app = new Hono();

  // Optional Bearer auth when WORKSPACE_HOST_SECRET is set
  app.use('*', async (c, next) => {
    if (opts.hostSecret) {
      const auth = c.req.header('authorization') || '';
      if (auth !== `Bearer ${opts.hostSecret}`) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
    }
    return next();
  });

  app.get('/health', async (c) => {
    const diskUsage = await getDiskUsage();
    const activeIds = [...activeSessions.values()]
      .filter((s) => !s.isWarmStandby)
      .map((s) => s.id);
    return c.json({
      ok: true,
      protocolVersion: WORKSPACE_HOST_PROTOCOL_VERSION,
      instanceId,
      activeSessionIds: activeIds,
      activeCount: activeIds.length,
      maxActiveWorkspaces: opts.maxActiveWorkspaces,
      warmPool: getWarmPoolStatus(),
      buildQueue: buildQueue.getStatus(),
      diskUsage,
    });
  });

  app.post('/api/warm/reserve', (c) => {
    if (opts.warmPoolSize <= 0) return c.json({ reserved: null });
    let idx = warmPool.findIndex((s) => s.state === 'ready');
    if (idx === -1) idx = warmPool.findIndex((s) => s.state === 'warming');
    if (idx === -1) return c.json({ reserved: null });

    const [slot] = warmPool.splice(idx, 1);
    if (!slot) return c.json({ reserved: null });

    slot.claimedBySessionId = slot.id;
    reservedWarmSlots.set(slot.id, slot);

    const adoptedWarming = slot.state === 'warming';
    if (adoptedWarming) {
      emitProgress(slot.id, slot.progress.stage, slot.progress.message, {
        startedAt: slot.progress.startedAt,
        warmHit: true,
      });
    } else {
      emitProgress(slot.id, 'claiming_warm', 'Connecting to ready workspace…', {
        warmHit: true,
      });
    }

    setTimeout(() => {
      if (warmPoolRunning) replenishWarmPool();
    }, 100).unref?.();

    return c.json({
      reserved: {
        id: slot.id,
        volumeName: `halley-ws-${slot.id}`,
        rawToken: slot.rawToken,
        adoptedWarming,
      },
    });
  });

  app.post('/api/sessions/:id/start', async (c) => {
    const sessionId = c.req.param('id')!;
    const body = (await c.req.json()) as {
      baseBranch: string;
      workingBranch: string;
      baseSha?: string;
      workspaceToken: string;
      persona?: 'non-technical' | 'developer';
      editorName?: string;
      editorEmail?: string;
      readOnly?: boolean;
      protectedSessionIds?: string[];
    };

    const protectedSet = new Set(body.protectedSessionIds ?? []);

    // Deduplicate concurrent boots for the same session
    const inflight = bootingSessions.get(sessionId);
    if (inflight) {
      const m = await inflight;
      return c.json({
        runnerPort: m.runnerPort,
        astroPort: m.astroPort,
        astroBase: m.astroBase,
        baseSha: m.baseSha,
        instanceId,
      });
    }

    // Fast path: already running & healthy (non-warm)
    const existing = activeSessions.get(sessionId);
    if (existing && !existing.isWarmStandby && existing.proc.exitCode === null) {
      existing.lastActiveAt = Date.now();
      return c.json({
        runnerPort: existing.runnerPort,
        astroPort: existing.astroPort,
        astroBase: existing.astroBase,
        baseSha: existing.baseSha,
        instanceId,
      });
    }

    const bootPromise = (async (): Promise<ManagedSession> => {
      // Check if this session reserved a warm standby slot
      const reservedSlot = reservedWarmSlots.get(sessionId);
      if (reservedSlot) {
        reservedWarmSlots.delete(sessionId);
        try {
          if (reservedSlot.state === 'warming') {
            await reservedSlot.bootPromise;
          }
          if (reservedSlot.state === 'ready') {
            const managed = activeSessions.get(sessionId);
            if (managed && managed.proc.exitCode === null) {
              await enforceLruCap(sessionId, protectedSet);
              const latestHead = await syncLocalMirror(body.baseBranch).catch(() => '');
              const needsSync = Boolean(
                latestHead && reservedSlot.baseSha && latestHead !== reservedSlot.baseSha,
              );
              const claimRes = await fetch(`http://127.0.0.1:${managed.runnerPort}/internal/claim`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  workingBranch: body.workingBranch,
                  baseBranch: body.baseBranch,
                  editorName: body.editorName || 'Editor',
                  editorEmail: body.editorEmail || 'editor@example.com',
                  persona: body.persona || 'non-technical',
                  readOnly: Boolean(body.readOnly),
                  syncFromMirror: needsSync,
                  mirrorPath: mirrorDir,
                }),
              });
              if (claimRes.ok) {
                const claimed = (await claimRes.json()) as {
                  baseSha?: string;
                  originalBase?: string;
                };
                managed.isWarmStandby = false;
                managed.lastActiveAt = Date.now();
                if (claimed.baseSha) managed.baseSha = claimed.baseSha;
                if (claimed.originalBase) managed.astroBase = claimed.originalBase;
                emitProgress(sessionId, 'ready', 'Workspace ready!', { warmHit: true });
                return managed;
              }
            }
          }
        } catch (err) {
          console.warn(
            `[halley-warm-pool] Claim failed for ${sessionId.slice(0, 8)}, falling back to cold boot:`,
            err,
          );
        }
        await stopSessionProcess(sessionId).catch(() => {});
      }

      await enforceLruCap(sessionId, protectedSet);

      const baseDir = sessionDir(sessionId);
      const workspaceDir = path.join(baseDir, 'workspace');
      const stateDir = path.join(baseDir, 'state');
      await fs.mkdir(stateDir, { recursive: true });

      const repoReady = await fileExists(path.join(workspaceDir, '.git'));
      let baseSha = body.baseSha || '';

      if (!repoReady) {
        emitProgress(sessionId, 'syncing_repo', 'Syncing latest website repository…');
        await syncLocalMirror(body.baseBranch);

        emitProgress(sessionId, 'cloning_repo', 'Cloning website files…');
        await fs.mkdir(baseDir, { recursive: true });
        await runGit(baseDir, ['clone', mirrorDir, 'workspace']);
        await runGit(workspaceDir, ['remote', 'set-url', 'origin', internalGitUrl]);
        await runGit(workspaceDir, ['checkout', '-B', body.workingBranch, `origin/${body.baseBranch}`]);
        baseSha = await runGit(workspaceDir, ['rev-parse', 'HEAD']);
      } else {
        // Ensure origin points to the current internal git URL
        await runGit(workspaceDir, ['remote', 'set-url', 'origin', internalGitUrl]).catch(() => {});
        if (!baseSha) {
          baseSha = await runGit(workspaceDir, ['rev-parse', 'HEAD']).catch(() => '');
        }
      }

      await nmCache.ensureSessionNodeModules({
        workspaceDir,
        stateDir,
        devLocalRepo: opts.devLocalRepo,
        onInstalling: () => emitProgress(sessionId, 'installing_deps', 'Installing project packages…'),
      });

      return spawnRunnerForSession({
        sessionId,
        workspaceDir,
        stateDir,
        baseBranch: body.baseBranch,
        baseSha,
        workspaceToken: body.workspaceToken,
        persona: body.persona || 'non-technical',
        editorName: body.editorName || 'Editor',
        editorEmail: body.editorEmail || 'editor@example.com',
        readOnly: Boolean(body.readOnly),
        isWarmStandby: false,
      });
    })().finally(() => {
      bootingSessions.delete(sessionId);
    });

    bootingSessions.set(sessionId, bootPromise);
    try {
      const m = await bootPromise;
      return c.json({
        runnerPort: m.runnerPort,
        astroPort: m.astroPort,
        astroBase: m.astroBase,
        baseSha: m.baseSha,
        instanceId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[halley-supervisor] Session ${sessionId.slice(0, 8)} start failed: ${msg}`);
      emitProgress(sessionId, 'error', 'Workspace failed to start', { detail: msg });
      return c.json({ error: msg }, 500);
    }
  });

  app.post('/api/sessions/:id/stop', async (c) => {
    const sessionId = c.req.param('id')!;
    await stopSessionProcess(sessionId);
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/restart', async (c) => {
    const sessionId = c.req.param('id')!;
    reservedWarmSlots.delete(sessionId);
    await stopSessionProcess(sessionId);
    return c.json({ ok: true });
  });

  app.delete('/api/sessions/:id', async (c) => {
    const sessionId = c.req.param('id')!;
    reservedWarmSlots.delete(sessionId);
    await stopSessionProcess(sessionId);
    logsBySession.delete(sessionId);
    await fs.rm(sessionDir(sessionId), { recursive: true, force: true });
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/prune-node-modules', async (c) => {
    const sessionId = c.req.param('id')!;
    const nmPath = path.join(sessionDir(sessionId), 'workspace', 'node_modules');
    await fs.rm(nmPath, { recursive: true, force: true }).catch(() => {});
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/duplicate', async (c) => {
    const sourceId = c.req.param('id')!;
    const body = (await c.req.json()) as {
      targetSessionId: string;
      targetWorkingBranch: string;
      mode?: 'branch-off' | 'fresh-from-main';
    };

    const dstBase = sessionDir(body.targetSessionId);
    await fs.mkdir(path.join(dstBase, 'state'), { recursive: true });

    if (body.mode === 'fresh-from-main') {
      return c.json({ ok: true });
    }

    const srcBase = sessionDir(sourceId);
    const srcWs = path.join(srcBase, 'workspace');
    const dstWs = path.join(dstBase, 'workspace');

    const hasSrcRepo = await fileExists(path.join(srcWs, '.git'));
    if (hasSrcRepo) {
      await fs.cp(srcWs, dstWs, {
        recursive: true,
        filter: (srcPath) => {
          const base = path.basename(srcPath);
          return base !== 'node_modules' && base !== 'dist' && base !== '.astro';
        },
      });
    }

    const srcUploads = path.join(srcBase, 'state', 'uploads');
    if (await fileExists(srcUploads)) {
      await fs.cp(srcUploads, path.join(dstBase, 'state', 'uploads'), { recursive: true });
    }

    if (hasSrcRepo) {
      await runGit(dstWs, ['remote', 'set-url', 'origin', internalGitUrl]).catch(() => {});
      await runGit(dstWs, ['checkout', '-B', body.targetWorkingBranch]);
    }

    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/git/fetch', async (c) => {
    const sessionId = c.req.param('id')!;
    const body = (await c.req.json()) as { baseBranch: string };
    const ws = path.join(sessionDir(sessionId), 'workspace');
    await runGit(ws, ['remote', 'set-url', 'origin', internalGitUrl]).catch(() => {});
    await runGit(ws, ['fetch', 'origin', body.baseBranch], true);
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/git/push', async (c) => {
    const sessionId = c.req.param('id')!;
    const body = (await c.req.json()) as { workingBranch: string };
    const ws = path.join(sessionDir(sessionId), 'workspace');
    await runGit(ws, ['remote', 'set-url', 'origin', internalGitUrl]).catch(() => {});
    await runGit(
      ws,
      ['push', '--force', 'origin', `HEAD:refs/heads/${body.workingBranch}`],
      true,
    );
    return c.json({ ok: true });
  });

  app.get('/api/sessions/:id/logs', (c) => {
    const sessionId = c.req.param('id')!;
    return c.json({ lines: logsBySession.get(sessionId) ?? [] });
  });

  app.get('/api/sessions/:id/progress', (c) => {
    const sessionId = c.req.param('id')!;
    return c.json({ progress: bootProgressBySession.get(sessionId) ?? null });
  });

  // Track open speculative NDJSON stream closers by leaseId so release/promote closes them cleanly
  const speculativeStreamClosers = new Map<string, () => void>();

  // Container-wide priority FIFO build lock (NDJSON stream)
  app.post('/internal/build-lock/acquire', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      sessionId?: string;
      priority?: 'foreground' | 'speculative';
      timeoutMs?: number;
    };
    const sessionId = body.sessionId || 'unknown';
    const priority = body.priority === 'speculative' ? 'speculative' : 'foreground';
    const encoder = new TextEncoder();
    const ac = new AbortController();

    c.req.raw.signal?.addEventListener('abort', () => ac.abort(), { once: true });

    const stream = new ReadableStream({
      start(controller) {
        let closed = false;
        let acquiredLeaseId: string | null = null;
        const closeStream = () => {
          if (closed) return;
          closed = true;
          if (acquiredLeaseId) {
            speculativeStreamClosers.delete(acquiredLeaseId);
          }
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
        const send = (obj: Record<string, unknown>) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
          } catch {
            // stream closed
          }
        };

        void buildQueue
          .acquire(sessionId, {
            priority,
            timeoutMs: body.timeoutMs,
            signal: ac.signal,
            onQueued: (position) => {
              send({
                event: 'queued',
                position,
                message: `Waiting for another editor's checks to finish (position ${position})…`,
              });
            },
            onPreempted:
              priority === 'speculative'
                ? () => {
                    send({ event: 'preempted', leaseId: acquiredLeaseId });
                    closeStream();
                  }
                : undefined,
          })
          .then((lease) => {
            acquiredLeaseId = lease.leaseId;
            send({ event: 'acquired', leaseId: lease.leaseId });
            if (priority === 'speculative') {
              speculativeStreamClosers.set(lease.leaseId, closeStream);
            } else {
              closeStream();
            }
          })
          .catch((err) => {
            send({
              event: err instanceof BuildQueueTimeoutError ? 'timeout' : 'error',
              message: err instanceof Error ? err.message : String(err),
            });
            closeStream();
          });
      },
      cancel() {
        ac.abort();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
      },
    });
  });

  app.post('/internal/build-lock/promote', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { leaseId?: string };
    const promoted = body.leaseId ? buildQueue.promoteToForeground(body.leaseId) : false;
    if (body.leaseId) {
      speculativeStreamClosers.get(body.leaseId)?.();
    }
    return c.json({ ok: true, promoted });
  });

  app.post('/internal/build-lock/release', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { leaseId?: string };
    const released = body.leaseId ? buildQueue.releaseByLease(body.leaseId) : false;
    if (body.leaseId) {
      speculativeStreamClosers.get(body.leaseId)?.();
    }
    return c.json({ ok: true, released });
  });

  app.post('/api/optimize/scan', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
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
  };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
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

  const supervisor = createWorkspaceSupervisor({
    workspacesDir,
    controlPlaneInternalUrl,
    hostSecret: process.env.WORKSPACE_HOST_SECRET || undefined,
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

  // Wait until control-plane /api/health is reachable before starting the warm standby pool
  void (async () => {
    const cpHealthUrl = `${controlPlaneInternalUrl.replace(/\/+$/, '')}/api/health`;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(cpHealthUrl, { signal: AbortSignal.timeout(2000) });
        if (res.ok) break;
      } catch {
        // control-plane still starting
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    supervisor.startWarmPool();
  })();

  const shutdown = () => {
    void supervisor.stopAll().finally(() => {
      server.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
