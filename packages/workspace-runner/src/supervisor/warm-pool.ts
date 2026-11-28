import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type BootStage } from '@halley/shared';
import { computePreviewBase } from '../astro-manager.js';
import { ignore, ignoreExpected, logger } from '../log.js';
import { writeFileAtomic } from '../fs-util.js';
import {
  WARM_SLOT_MARKER,
  DiskPressureError,
  type StartPhaseTimings,
  type WarmSlot,
  runnerFetch,
} from './shared.js';
import type { SupervisorContext } from './context.js';

/**
 * Warm standby pool: booting, replenishing, health checks and slot disposal. Created by
 * createWorkspaceSupervisor (see SupervisorContext).
 */
export function createWarmPool(ctx: SupervisorContext) {
  const {
    opts,
    clock,
    mirrorDir,
    nmCache,
    activeSessions,
    logsBySession,
    startPhasesBySession,
    assertDiskAdmission,
    reservedWarmSlots,
    internalGitUrl,
    sessionDir,
    emitProgress,
    runGit,
  } = ctx;
  /** Stops a warm/reserved slot's runner and removes its dir + log buffer (best effort, logged). */
  async function discardSlot(id: string, context: string): Promise<void> {
    await ctx.stopSessionProcess(id).catch((e) => ignore(e, 'supervisor: stop slot runner', { id, context }));
    await fs
      .rm(sessionDir(id), { recursive: true, force: true })
      .catch((e) => ignore(e, 'supervisor: remove slot dir', { id, context }));
    logsBySession.delete(id);
    startPhasesBySession.delete(id);
  }

  async function recycleStaleWarmSlots(latestBaseSha: string): Promise<void> {
    if (!ctx.warmPoolRunning || !latestBaseSha) return;
    const stale = ctx.warmPool.filter(
      (s) => s.state === 'ready' && !s.claimedBySessionId && s.baseSha && s.baseSha !== latestBaseSha,
    );
    if (stale.length === 0) return;
    for (const slot of stale) {
      const idx = ctx.warmPool.indexOf(slot);
      if (idx !== -1) ctx.warmPool.splice(idx, 1);
      await discardSlot(slot.id, 'stale base sha');
    }
    replenishWarmPool();
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

    const t0 = Date.now();
    const phasesMs: Record<string, number> = {};
    const phase = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const t = Date.now();
      try {
        return await fn();
      } finally {
        phasesMs[name] = Date.now() - t;
      }
    };
    try {
      // W-disk: never fill the volume with standby clones/installs
      await assertDiskAdmission('warm a standby workspace');
      console.log(`[halley-warm-pool] Warming standby workspace ${slot.id.slice(0, 8)}…`);
      updateSlotProgress('syncing_repo', 'Syncing latest website repository…');
      const headSha = await phase('mirrorFetch', () => ctx.syncLocalMirror(opts.baseBranch));
      slot.baseSha = headSha;

      updateSlotProgress('cloning_repo', 'Cloning website files…');
      await fs.mkdir(stateDir, { recursive: true });
      // W6c: marks this dir as disposable so a supervisor restart can sweep it; removed on claim
      await writeFileAtomic(path.join(baseDir, WARM_SLOT_MARKER), `${new Date().toISOString()}\n`, { durable: true });
      await phase('clone', () =>
        ctx.withMirrorRead(() => runGit(baseDir, ['clone', '--no-checkout', mirrorDir, 'workspace'])),
      );
      await phase('checkout', async () => {
        await runGit(workspaceDir, ['remote', 'set-url', 'origin', internalGitUrl]);
        await runGit(workspaceDir, [
          'checkout',
          '-B',
          `halley/standby-${slot.id.slice(0, 6)}`,
          `origin/${opts.baseBranch}`,
        ]);
        slot.baseSha = await runGit(workspaceDir, ['rev-parse', 'HEAD']);
      });

      await phase('nodeModules', () =>
        nmCache.ensureSessionNodeModules({
          workspaceDir,
          stateDir,
          devLocalRepo: opts.devLocalRepo,
          onInstalling: () => updateSlotProgress('installing_deps', 'Installing project packages…'),
        }),
      );

      updateSlotProgress('starting_preview', 'Starting Astro live preview…');
      const managed = await ctx.spawnRunnerForSession({
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
        phasesMs,
      });

      // Pre-render `/` once so Vite + Tailwind v4 JIT + Astro Content Layer are already hot in RAM!
      const previewBase = computePreviewBase(slot.id, managed.astroBase);
      await phase('prerender', () =>
        runnerFetch(`http://127.0.0.1:${managed.astroPort}${previewBase}/`, {
          signal: clock.timeoutSignal(25_000),
        })
          .then((r) => r.arrayBuffer())
          .catch((e) => ignore(e, 'supervisor: pre-render of warm slot failed (slot still usable)')),
      );
      const timings: StartPhaseTimings = {
        path: 'warm-standby',
        phasesMs,
        totalMs: Date.now() - t0,
        at: new Date().toISOString(),
      };
      startPhasesBySession.set(slot.id, timings);
      logger.info('supervisor: session start phases', { sessionId: slot.id, ...timings });

      slot.runnerPort = managed.runnerPort;
      slot.astroPort = managed.astroPort;
      slot.astroBase = managed.astroBase;
      slot.baseSha = managed.baseSha;
      slot.state = 'ready';
      console.log(
        `[halley-warm-pool] Standby workspace ${slot.id.slice(0, 8)} is pre-rendered & ready (baseSha=${slot.baseSha.slice(0, 7)})`,
      );
    } catch (err) {
      slot.state = 'failed';
      if (err instanceof DiskPressureError) logger.warn('supervisor: warm slot not started (disk pressure)', { id: slot.id });
      else logger.warn('supervisor: failed to warm standby workspace', { id: slot.id, err });
      const idx = ctx.warmPool.indexOf(slot);
      if (idx !== -1) ctx.warmPool.splice(idx, 1);
      await ctx.stopSessionProcess(slot.id).catch((e) => ignore(e, 'supervisor: stop failed warm slot', { id: slot.id }));
      // Only remove baseDir here if not currently claimed by an active `/start` handler
      // (if claimed, `/start` owns cleanup before its cold-boot fallback to avoid racing fs.rm!)
      if (!slot.claimedBySessionId) {
        logsBySession.delete(slot.id);
        await fs
          .rm(baseDir, { recursive: true, force: true })
          .catch((e) => ignore(e, 'supervisor: remove failed warm slot dir', { id: slot.id }));
        if (ctx.warmPoolRunning) {
          clock
            .setTimeout(() => {
              if (ctx.warmPoolRunning) replenishWarmPool();
            }, 30_000)
            .unref?.();
        }
      }
    }
  }

  function replenishWarmPool(): void {
    if (!ctx.warmPoolRunning || opts.warmPoolSize <= 0) return;
    ctx.warmPool = ctx.warmPool.filter((s) => s.state !== 'failed');
    // Respect MAX_ACTIVE_WORKSPACES across active user sessions + standby slots
    const activeNonWarmCount = [...activeSessions.values()].filter((s) => !s.isWarmStandby).length;
    const availableCapacity = Math.max(0, opts.maxActiveWorkspaces - activeNonWarmCount);
    const targetSlots = Math.min(opts.warmPoolSize, availableCapacity);

    while (ctx.warmPool.length < targetSlots) {
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
      ctx.warmPool.push(slot);
    }
  }

  async function checkWarmPoolHealth(): Promise<void> {
    if (!ctx.warmPoolRunning) return;
    const unhealthy: WarmSlot[] = [];
    for (const slot of ctx.warmPool) {
      if (slot.state !== 'ready') continue;
      try {
        const res = await runnerFetch(`http://127.0.0.1:${slot.runnerPort}/health`, {
          signal: clock.timeoutSignal(4_000),
        });
        if (!res.ok) unhealthy.push(slot);
      } catch (err) {
        // unreachable / timed out: recycled below like a non-OK answer
        ignoreExpected(err, 'supervisor: warm slot health probe failed', { slotId: slot.id });
        unhealthy.push(slot);
      }
    }
    for (const slot of unhealthy) {
      const idx = ctx.warmPool.indexOf(slot);
      if (idx !== -1) ctx.warmPool.splice(idx, 1);
      await discardSlot(slot.id, 'unhealthy');
    }
    const now = clock.now();
    for (const [id, slot] of Array.from(reservedWarmSlots.entries())) {
      if (slot.reservedAt && now - slot.reservedAt > 5 * 60_000) {
        reservedWarmSlots.delete(id);
        await discardSlot(slot.id, 'reservation expired');
      }
    }
    replenishWarmPool();
  }

  function startWarmPool(): void {
    if (opts.warmPoolSize <= 0 || ctx.warmPoolRunning) return;
    ctx.warmPoolRunning = true;
    replenishWarmPool();
    ctx.warmHealthTimer = clock.setInterval(() => {
      void checkWarmPoolHealth();
    }, 120_000);
    ctx.warmHealthTimer.unref?.();
  }

  return { discardSlot, recycleStaleWarmSlots, replenishWarmPool, startWarmPool };
}
