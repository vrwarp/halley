import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { ignore, ignoreExpected, logger } from '../log.js';
import { getProcessRunner, killProcessesWithEnv, killProcessGroup, withMaxOldSpace } from '../proc.js';
import { RUNNER_PROTOCOL_HEADER, RUNNER_PROTOCOL_VERSION } from '../runner-protocol.js';
import { sleep } from '../clock.js';
import {
  FatalBootError,
  type ManagedSession,
  type CrashedSessionInfo,
  MAX_CRASH_RECORDS,
  runnerFetch,
} from './shared.js';
import type { SupervisorContext } from './context.js';

/**
 * Runner process management: spawn + boot health polling, stop (grace -> SIGKILL), crash records,
 * LRU admission. Created by createWorkspaceSupervisor (see SupervisorContext).
 */
export function createProcessManager(ctx: SupervisorContext) {
  const {
    opts,
    clock,
    mirrorDir,
    nmCacheDir,
    pkgCacheDir,
    verifySandboxDir,
    buildQueue,
    runnerHeapMb,
    runnerStopGraceMs,
    crashedSessions,
    allocateLeasedPort,
    releaseLeasedPort,
    activeSessions,
    deletedSessionIds,
    logsBySession,
    bootProgressBySession,
    admissionMutex,
    admittedBooting,
    runnerEntry,
    controlPlaneBase,
    sessionDir,
    appendLog,
    emitProgress,
  } = ctx;
  function killRunnerGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
    killProcessGroup(proc, signal);
  }

  async function stopSessionProcess(sessionId: string): Promise<void> {
    bootProgressBySession.delete(sessionId);
    buildQueue.releaseBySession(sessionId);
    const managed = activeSessions.get(sessionId);
    activeSessions.delete(sessionId);
    if (!managed) return;
    managed.stopRequested = true;
    if (managed.proc.exitCode === null && managed.proc.signalCode === null) {
      // SIGTERM lets the runner stop astro dev (its own process group) and the Pi harness itself
      killRunnerGroup(managed.proc, 'SIGTERM');
      await new Promise<void>((resolve) => {
        const t = clock.setTimeout(resolve, runnerStopGraceMs);
        t.unref?.();
        managed.proc.once('exit', () => {
          clock.clearTimeout(t);
          resolve();
        });
      });
      if (managed.proc.exitCode === null && managed.proc.signalCode === null) {
        logger.warn('supervisor: runner did not stop within grace; SIGKILL', {
          sessionId,
          graceMs: runnerStopGraceMs,
        });
        killRunnerGroup(managed.proc, 'SIGKILL');
        // The runner could not clean up: reap its detached astro dev / builds / shells
        const reaped = await killProcessesWithEnv('HALLEY_SESSION_ID', sessionId);
        if (reaped > 0) logger.warn('supervisor: reaped orphaned session processes', { sessionId, reaped });
      }
    }
    releaseLeasedPort(managed.runnerPort);
    releaseLeasedPort(managed.astroPort);
  }

  /** Sessions counted against the cap: running processes + sessions admitted but still booting. */
  function cappedSessionIds(excludeSessionId: string): Set<string> {
    const ids = new Set<string>([...activeSessions.keys(), ...admittedBooting]);
    ids.delete(excludeSessionId);
    return ids;
  }

  /**
   * Asks a runner to stop accepting work if (and only if) it is idle, atomically on the runner side,
   * closing the gap between "health says idle" and SIGTERM. Returns true when it is safe to stop.
   */
  async function drainIfIdle(candidate: ManagedSession): Promise<boolean> {
    try {
      const res = await runnerFetch(`http://127.0.0.1:${candidate.runnerPort}/internal/drain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: clock.timeoutSignal(3_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { drained?: boolean };
        return Boolean(data.drained);
      }
      if (res.status !== 404) return false;
      // Older runner without /internal/drain: fall back to the (racy) health check
      const health = await runnerFetch(`http://127.0.0.1:${candidate.runnerPort}/health`, {
        signal: clock.timeoutSignal(3_000),
      });
      if (!health.ok) return true;
      const data = (await health.json()) as { piBusy?: boolean; busy?: boolean };
      return !(data.piBusy || data.busy);
    } catch (err) {
      // unreachable runner holds no in-flight work we could protect -> safe to evict
      ignoreExpected(err, 'supervisor: drain check of LRU candidate failed; evicting', { sessionId: candidate.id });
      return true;
    }
  }

  async function undrain(candidate: ManagedSession): Promise<void> {
    await runnerFetch(`http://127.0.0.1:${candidate.runnerPort}/internal/drain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cancel: true }),
      signal: clock.timeoutSignal(3_000),
    }).catch((e) => ignore(e, 'supervisor: cancel drain', { sessionId: candidate.id }));
  }

  /**
   * Enforces `maxActiveWorkspaces` across ALL running processes (including warm standby) and
   * sessions admitted but still booting. Must run under `admissionMutex` (see `admitSession`).
   * Reclaims unclaimed warm standby slots first so user sessions are never evicted needlessly,
   * and sorts remaining sessions by real `lastActiveAt` (synced from control-plane).
   */
  async function enforceLruCap(excludeSessionId: string, protectedIds: Set<string>): Promise<void> {
    const cap = opts.maxActiveWorkspaces;
    if (cap <= 0) return;

    let totalRunning = cappedSessionIds(excludeSessionId).size;
    if (totalRunning < cap) return;

    // 1. Reclaim unclaimed warm standby processes first
    for (const slot of [...ctx.warmPool]) {
      if (totalRunning < cap) break;
      if (slot.claimedBySessionId || slot.id === excludeSessionId) continue;
      const idx = ctx.warmPool.indexOf(slot);
      if (idx !== -1) ctx.warmPool.splice(idx, 1);
      await ctx.discardSlot(slot.id, 'lru reclaim');
      totalRunning = cappedSessionIds(excludeSessionId).size;
    }

    if (totalRunning < cap) return;

    const bq = buildQueue.getStatus();
    const buildProtected = new Set<string>(bq.queuedSessionIds);
    if (bq.activeSessionId) buildProtected.add(bq.activeSessionId);

    const nonWarm = [...activeSessions.values()].filter(
      (s) => !s.isWarmStandby && s.id !== excludeSessionId && !admittedBooting.has(s.id),
    );
    nonWarm.sort((a, b) => a.lastActiveAt - b.lastActiveAt);

    for (const candidate of nonWarm) {
      if (totalRunning < cap) break;
      if (protectedIds.has(candidate.id) || buildProtected.has(candidate.id)) continue;
      // Re-checked right before stopping: the runner refuses new work from here on if idle
      if (!(await drainIfIdle(candidate))) continue;
      // State may have moved while we awaited the runner
      const live = activeSessions.get(candidate.id);
      const bqNow = buildQueue.getStatus();
      if (
        live !== candidate ||
        bqNow.activeSessionId === candidate.id ||
        bqNow.queuedSessionIds.includes(candidate.id)
      ) {
        if (live === candidate) await undrain(candidate);
        continue;
      }

      logger.info('supervisor: LRU cap reached; putting idle session to sleep', {
        cap,
        sessionId: candidate.id,
      });
      await stopSessionProcess(candidate.id);
      totalRunning = cappedSessionIds(excludeSessionId).size;
    }
    if (totalRunning >= cap) {
      logger.warn('supervisor: LRU cap exceeded; every running session is busy or protected', {
        cap,
        running: totalRunning + 1,
      });
    }
  }

  /** Admission under the cap, serialized: concurrent starts are counted against each other. */
  function admitSession(sessionId: string, protectedIds: Set<string>): Promise<void> {
    return admissionMutex.run(async () => {
      await enforceLruCap(sessionId, protectedIds);
      admittedBooting.add(sessionId);
    });
  }

  /**
   * W6b: a runner exited without being asked to (crash, OOM kill). Record it (visible in /health),
   * reap its orphaned astro dev / build processes, and tell the control plane (best effort).
   */
  async function recordUnexpectedExit(
    managed: ManagedSession,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    const info: CrashedSessionInfo = {
      id: managed.id,
      code,
      signal,
      at: new Date().toISOString(),
      oom: code === 137 || signal === 'SIGKILL',
      warmStandby: managed.isWarmStandby,
      logTail: (logsBySession.get(managed.id) ?? []).slice(-20),
    };
    const existing = crashedSessions.findIndex((c) => c.id === managed.id);
    if (existing !== -1) crashedSessions.splice(existing, 1);
    crashedSessions.push(info);
    if (crashedSessions.length > MAX_CRASH_RECORDS) crashedSessions.splice(0, crashedSessions.length - MAX_CRASH_RECORDS);
    logger.error('supervisor: runner exited unexpectedly', {
      sessionId: managed.id,
      code,
      signal,
      oom: info.oom,
      warmStandby: info.warmStandby,
    });
    const reaped = await killProcessesWithEnv('HALLEY_SESSION_ID', managed.id).catch((e) => {
      ignore(e, 'supervisor: reap crashed session processes');
      return 0;
    });
    if (reaped > 0) logger.warn('supervisor: reaped orphaned processes of crashed runner', { sessionId: managed.id, reaped });
    if (managed.isWarmStandby) {
      const idx = ctx.warmPool.findIndex((s) => s.id === managed.id);
      if (idx !== -1) {
        const [slot] = ctx.warmPool.splice(idx, 1);
        if (slot) await fs.rm(sessionDir(slot.id), { recursive: true, force: true }).catch((e) => ignore(e, 'supervisor: remove crashed warm slot'));
        ctx.replenishWarmPool();
      }
      return;
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (ctx.activeHostSecret) headers.Authorization = `Bearer ${ctx.activeHostSecret}`;
    try {
      const res = await fetch(`${controlPlaneBase}/internal/workspaces/session-exited`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionId: managed.id, code, signal, oom: info.oom, at: info.at }),
        signal: clock.timeoutSignal(3_000),
      });
      if (!res.ok) {
        logger.warn('supervisor: control plane did not accept session-exited notification', {
          sessionId: managed.id,
          status: res.status,
        });
      }
    } catch (err) {
      ignore(err, 'supervisor: notify control plane of runner exit', { sessionId: managed.id });
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
    /** Filled with runnerSpawn / runnerHttp / astroReady / piReady (ms). */
    phasesMs?: Record<string, number>;
  }): Promise<ManagedSession> {
    const spawnT0 = Date.now();
    let httpUpAt = 0;
    const bindHost = opts.bindHost || '0.0.0.0';
    const runnerPort = await allocateLeasedPort(bindHost);
    let astroPort = 0;
    try {
      astroPort = await allocateLeasedPort(bindHost);
    } catch (err) {
      releaseLeasedPort(runnerPort);
      throw err;
    }

    emitProgress(params.sessionId, 'starting_preview', 'Starting Astro live preview…', {
      warmHit: params.isWarmStandby || undefined,
    });

    const child = getProcessRunner().spawn(process.execPath, [runnerEntry], {
      cwd: params.workspaceDir,
      detached: true,
      env: {
        ...process.env,
        // Merged, not clobbered: keeps inherited flags, replaces any existing heap cap
        NODE_OPTIONS: withMaxOldSpace(process.env.NODE_OPTIONS, runnerHeapMb),
        HALLEY_WORKSPACE_DIR: params.workspaceDir,
        HALLEY_STATE_DIR: params.stateDir,
        HALLEY_SESSION_ID: params.sessionId,
        HALLEY_BASE_BRANCH: params.baseBranch,
        HALLEY_BASE_SHA: params.baseSha,
        HALLEY_MIRROR_PATH: mirrorDir,
        HALLEY_NM_CACHE_DIR: nmCacheDir,
        HALLEY_PKG_CACHE_DIR: pkgCacheDir,
        HALLEY_VERIFY_SANDBOX_DIR: verifySandboxDir,
        RUNNER_PORT: String(runnerPort),
        ASTRO_PORT: String(astroPort),
        CONTROL_PLANE_INTERNAL_URL: controlPlaneBase,
        HALLEY_SUPERVISOR_URL: ctx.supervisorSelfUrl,
        ...(ctx.activeHostSecret ? { WORKSPACE_HOST_SECRET: ctx.activeHostSecret } : {}),
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
      workspaceToken: params.workspaceToken,
      lastActiveAt: clock.now(),
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
      releaseLeasedPort(runnerPort);
      releaseLeasedPort(astroPort);
    });
    child.stdout?.on('data', (d: Buffer) => appendLog(params.sessionId, d, false));
    child.stderr?.on('data', (d: Buffer) => appendLog(params.sessionId, d, true));
    child.on('exit', (code, signal) => {
      if (activeSessions.get(params.sessionId)?.proc === child) {
        activeSessions.delete(params.sessionId);
      }
      buildQueue.releaseBySession(params.sessionId);
      releaseLeasedPort(runnerPort);
      releaseLeasedPort(astroPort);
      if (!managed.stopRequested) {
        void recordUnexpectedExit(managed, code, signal);
      }
    });

    // Poll until astroReady (generous 90s ceiling for cold Ryzen V1500B boots)
    const bootT0 = clock.now();
    const deadline = bootT0 + 90_000;
    let lastAstroState: string | undefined;
    let lastAstroLogs: string[] = [];
    while (clock.now() < deadline) {
      if (deletedSessionIds.has(params.sessionId)) {
        await stopSessionProcess(params.sessionId);
        throw new FatalBootError('Session was deleted while starting');
      }
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
        const res = await runnerFetch(`http://127.0.0.1:${runnerPort}/health`, {
          signal: clock.timeoutSignal(4_000),
        });
        if (res.ok) {
          const health = (await res.json()) as {
            protocolVersion?: number;
            originalBase?: string;
            astroReady?: boolean;
            astroState?: string;
            astroLogs?: string[];
            baseSha?: string;
            bootFailed?: string;
            bootTimings?: Record<string, number>;
          };
          if (!httpUpAt) {
            httpUpAt = Date.now();
            if (params.phasesMs) params.phasesMs.runnerHttp = httpUpAt - spawnT0;
            // W-proto: a runner speaking another protocol (stale dist, partial deploy) is refused
            const headerVersion = res.headers.get(RUNNER_PROTOCOL_HEADER);
            const reported = health.protocolVersion ?? (headerVersion ? Number(headerVersion) : undefined);
            if (reported !== RUNNER_PROTOCOL_VERSION) {
              await stopSessionProcess(params.sessionId);
              throw new FatalBootError(
                `Workspace runner protocol mismatch: supervisor speaks v${RUNNER_PROTOCOL_VERSION}, ` +
                  `runner ${runnerEntry} reports ${reported === undefined ? 'no version (pre-v2 runner)' : `v${reported}`}. ` +
                  'Rebuild/redeploy the workspace image so both come from the same build.',
              );
            }
          }
          if (health.bootFailed) {
            await stopSessionProcess(params.sessionId);
            throw new FatalBootError(`Workspace failed to start: ${health.bootFailed}`);
          }
          managed.astroBase = health.originalBase || '/';
          if (health.baseSha) managed.baseSha = health.baseSha;
          if (health.astroState) lastAstroState = health.astroState;
          if (Array.isArray(health.astroLogs) && health.astroLogs.length > 0) {
            lastAstroLogs = health.astroLogs;
          }
          if (health.astroReady) {
            if (params.phasesMs) {
              params.phasesMs.runnerSpawn = Date.now() - spawnT0;
              for (const [k, v] of Object.entries(health.bootTimings ?? {})) params.phasesMs[`runner.${k}`] = v;
            }
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
            throw new FatalBootError(
              `Workspace preview server crashed during startup.${tail ? `\n${tail}` : ''}`,
            );
          }
        }
      } catch (err) {
        if (err instanceof FatalBootError) throw err;
        // still booting (connection refused until the runner listens)
        ignoreExpected(err, 'supervisor: runner health poll', { sessionId: params.sessionId });
      }
      // Fast polling while the runner is coming up (astro dev is typically ready in ~1s), then back off
      await sleep(clock, clock.now() - bootT0 < 15_000 ? 75 : 350);
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

  return { stopSessionProcess, admitSession, spawnRunnerForSession };
}
