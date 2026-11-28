import fs from 'node:fs/promises';
import path from 'node:path';
import type { Hono } from 'hono';
import { fetchBaseBranchLocked, GitRemoteError, pushCommitLocked } from '../checkpoints-and-git.js';
import { ignore, ignoreExpected, logger, readJsonBodyOrEmpty } from '../log.js';
import { sleep } from '../clock.js';
import {
  WARM_SLOT_MARKER,
  DiskPressureError,
  type StartPhaseTimings,
  type ManagedSession,
  runnerFetch,
  fileExists,
} from './shared.js';
import type { SupervisorContext } from './context.js';

/**
 * Session lifecycle API for the control plane: mirror notify, touch, warm reserve/release,
 * start/stop/restart/delete, duplicate, git fetch/push, logs, progress. Registered by
 * createWorkspaceSupervisor (see SupervisorContext).
 */
export function registerSessionRoutes(app: Hono, ctx: SupervisorContext): void {
  const {
    opts,
    clock,
    instanceId,
    mirrorDir,
    nmCache,
    crashedSessions,
    activeSessions,
    bootingSessions,
    deletedSessionIds,
    logsBySession,
    bootProgressBySession,
    startPhasesBySession,
    admittedBooting,
    sessionGitLocks,
    assertDiskAdmission,
    markDeleted,
    reservedWarmSlots,
    internalGitUrl,
    sessionDir,
    emitProgress,
    runGit,
  } = ctx;
  app.post('/api/mirror/notify-updated', async (c) => {
    const body = (await readJsonBodyOrEmpty(c)) as { baseBranch?: string };
    void ctx.syncLocalMirror(body.baseBranch || opts.baseBranch).catch((err) =>
      // A failing mirror sync means every new session boots from a stale live site
      logger.error('supervisor: mirror sync after notify-updated failed', { err }),
    );
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/touch', (c) => {
    const sessionId = c.req.param('id')!;
    const s = activeSessions.get(sessionId);
    if (s) {
      s.lastActiveAt = clock.now();
    }
    return c.json({ ok: true });
  });

  app.post('/api/warm/reserve', (c) => {
    if (opts.warmPoolSize <= 0) return c.json({ reserved: null });
    let idx = ctx.warmPool.findIndex((s) => s.state === 'ready');
    if (idx === -1) idx = ctx.warmPool.findIndex((s) => s.state === 'warming');
    if (idx === -1) return c.json({ reserved: null });

    const [slot] = ctx.warmPool.splice(idx, 1);
    if (!slot) return c.json({ reserved: null });

    slot.claimedBySessionId = slot.id;
    slot.reservedAt = clock.now();
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

    clock
      .setTimeout(() => {
        if (ctx.warmPoolRunning) ctx.replenishWarmPool();
      }, 100)
      .unref?.();

    return c.json({
      reserved: {
        id: slot.id,
        volumeName: `halley-ws-${slot.id}`,
        rawToken: slot.rawToken,
        adoptedWarming,
      },
    });
  });

  app.post('/api/warm/release/:id', async (c) => {
    const id = c.req.param('id')!;
    const slot = reservedWarmSlots.get(id);
    if (slot) {
      reservedWarmSlots.delete(id);
      await ctx.discardSlot(slot.id, 'released');
      ctx.replenishWarmPool();
    }
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/start', async (c) => {
    const sessionId = c.req.param('id')!;
    deletedSessionIds.delete(sessionId);
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
      if (body.workspaceToken && body.workspaceToken !== existing.workspaceToken) {
        try {
          const tokRes = await runnerFetch(`http://127.0.0.1:${existing.runnerPort}/internal/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              workspaceToken: body.workspaceToken,
              hostSecret: ctx.activeHostSecret || undefined,
            }),
            signal: clock.timeoutSignal(5_000),
          });
          if (tokRes.ok) {
            existing.workspaceToken = body.workspaceToken;
          } else {
            await ctx.stopSessionProcess(sessionId);
          }
        } catch (err) {
          // a runner that cannot take the new token is restarted with it
          ignore(err, 'supervisor: rotate runner workspace token; restarting session', { sessionId });
          await ctx.stopSessionProcess(sessionId);
        }
      }
      if (activeSessions.get(sessionId) === existing && existing.proc.exitCode === null) {
        existing.lastActiveAt = clock.now();
        return c.json({
          runnerPort: existing.runnerPort,
          astroPort: existing.astroPort,
          astroBase: existing.astroBase,
          baseSha: existing.baseSha,
          instanceId,
        });
      }
    }

    // Phase timings of this start (one structured log line + /progress `phases`)
    const startT0 = Date.now();
    const phasesMs: Record<string, number> = {};
    let startPath: StartPhaseTimings['path'] = 'cold';
    const phase = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const t = Date.now();
      try {
        return await fn();
      } finally {
        phasesMs[name] = (phasesMs[name] ?? 0) + (Date.now() - t);
        publishPhases(false);
      }
    };
    const publishPhases = (final: boolean) => {
      const timings: StartPhaseTimings = {
        path: startPath,
        phasesMs: { ...phasesMs },
        totalMs: Date.now() - startT0,
        at: new Date().toISOString(),
      };
      startPhasesBySession.set(sessionId, timings);
      if (final) logger.info('supervisor: session start phases', { sessionId, ...timings });
    };

    const bootPromise = (async (): Promise<ManagedSession> => {
      // W-disk: a new runner (clone / install / caches) must not fill the shared volume
      await assertDiskAdmission('start a workspace', { sessionId });
      const reservedSlot = reservedWarmSlots.get(sessionId);
      if (reservedSlot) {
        reservedWarmSlots.delete(sessionId);
        startPath = 'warm-claim';
        try {
          if (reservedSlot.state === 'warming') {
            await phase('warmSlotBoot', () => reservedSlot.bootPromise);
          }
          if (reservedSlot.state === 'ready') {
            const managed = activeSessions.get(sessionId);
            if (managed && managed.proc.exitCode === null) {
              await phase('lruEvict', () => ctx.admitSession(sessionId, protectedSet));
              const latestHead = await phase('mirrorFetch', () =>
                ctx.syncLocalMirror(body.baseBranch).catch((e) => {
                  ignore(e, 'supervisor: mirror sync before warm claim');
                  return '';
                }),
              );
              // Becomes a real session dir from here on: drop the sweepable marker BEFORE claiming,
              // so a crash after the claim can never let the startup sweep delete user work.
              await fs.rm(path.join(sessionDir(sessionId), WARM_SLOT_MARKER), { force: true });
              const needsSync = Boolean(
                latestHead && reservedSlot.baseSha && latestHead !== reservedSlot.baseSha,
              );
              const claimRes = await phase('claim', () =>
                runnerFetch(`http://127.0.0.1:${managed.runnerPort}/internal/claim`, {
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
                    workspaceToken: body.workspaceToken || undefined,
                    hostSecret: ctx.activeHostSecret || undefined,
                  }),
                  signal: clock.timeoutSignal(60_000),
                }),
              );
              if (claimRes.ok) {
                const claimed = (await claimRes.json()) as {
                  baseSha?: string;
                  originalBase?: string;
                };
                managed.isWarmStandby = false;
                managed.lastActiveAt = clock.now();
                if (body.workspaceToken) managed.workspaceToken = body.workspaceToken;
                if (claimed.baseSha) managed.baseSha = claimed.baseSha;
                if (claimed.originalBase) managed.astroBase = claimed.originalBase;
                emitProgress(sessionId, 'ready', 'Workspace ready!', { warmHit: true });
                return managed;
              }
              logger.warn('supervisor: warm claim rejected by runner; cold booting instead', {
                sessionId,
                status: claimRes.status,
              });
            }
          }
        } catch (err) {
          logger.warn('supervisor: warm claim failed; cleaning up before cold boot', { sessionId, err });
        }
        // Cleanly wipe failed/partial warm slot directory so cold boot starts 100% fresh on workingBranch!
        await ctx.stopSessionProcess(sessionId).catch((e) => ignore(e, 'supervisor: stop failed warm claim', { sessionId }));
        await fs
          .rm(sessionDir(sessionId), { recursive: true, force: true })
          .catch((e) => ignore(e, 'supervisor: remove failed warm claim dir', { sessionId }));
        startPath = 'cold';
      }

      if (deletedSessionIds.has(sessionId)) {
        throw new Error('Session was deleted before boot');
      }

      if (!admittedBooting.has(sessionId)) {
        await phase('lruEvict', () => ctx.admitSession(sessionId, protectedSet));
      }

      const baseDir = sessionDir(sessionId);
      const workspaceDir = path.join(baseDir, 'workspace');
      const stateDir = path.join(baseDir, 'state');

      // Supervisor-side git ops on a stopped session (fetch/push) must finish before its runner starts
      return sessionGitLocks.run(sessionId, async () => {
        await fs.mkdir(stateDir, { recursive: true });

        const repoReady = await fileExists(path.join(workspaceDir, '.git'));
        let baseSha = body.baseSha || '';

        if (!repoReady) {
          startPath = 'cold';
          emitProgress(sessionId, 'syncing_repo', 'Syncing latest website repository…');
          await phase('mirrorFetch', () => ctx.syncLocalMirror(body.baseBranch));

          emitProgress(sessionId, 'cloning_repo', 'Cloning website files…');
          await fs.mkdir(baseDir, { recursive: true });
          // --no-checkout + explicit checkout: one working-tree write instead of two (HEAD, then branch)
          await phase('clone', () =>
            ctx.withMirrorRead(() => runGit(baseDir, ['clone', '--no-checkout', mirrorDir, 'workspace'])),
          );
          await phase('checkout', async () => {
            await runGit(workspaceDir, ['remote', 'set-url', 'origin', internalGitUrl]);
            await runGit(workspaceDir, ['checkout', '-B', body.workingBranch, `origin/${body.baseBranch}`]);
            baseSha = await runGit(workspaceDir, ['rev-parse', 'HEAD']);
          });
        } else {
          if (startPath !== 'warm-claim') startPath = 'wake';
          await runGit(workspaceDir, ['remote', 'set-url', 'origin', internalGitUrl]).catch((e) =>
            ignore(e, 'supervisor: reset origin url on wake', { sessionId }),
          );
          if (!baseSha) {
            baseSha = await runGit(workspaceDir, ['rev-parse', 'HEAD']).catch((e) => {
              ignore(e, 'supervisor: resolve HEAD on wake', { sessionId });
              return '';
            });
          }
        }

        const nm = await phase('nodeModules', () =>
          nmCache.ensureSessionNodeModules({
            workspaceDir,
            stateDir,
            devLocalRepo: opts.devLocalRepo,
            onInstalling: () => emitProgress(sessionId, 'installing_deps', 'Installing project packages…'),
          }),
        );
        phasesMs[`nodeModules:${nm.action}`] = phasesMs.nodeModules ?? 0;

        const spawned = await ctx.spawnRunnerForSession({
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
          phasesMs,
        });

        if (deletedSessionIds.has(sessionId)) {
          await ctx.stopSessionProcess(sessionId).catch((e) => ignore(e, 'supervisor: stop session deleted during boot'));
          await fs
            .rm(baseDir, { recursive: true, force: true })
            .catch((e) => ignore(e, 'supervisor: remove session deleted during boot'));
          throw new Error('Session was deleted during boot');
        }

        return spawned;
      });
    })().finally(() => {
      bootingSessions.delete(sessionId);
      admittedBooting.delete(sessionId);
    });

    bootingSessions.set(sessionId, bootPromise);
    try {
      const m = await bootPromise;
      const crashIdx = crashedSessions.findIndex((c) => c.id === sessionId);
      if (crashIdx !== -1) crashedSessions.splice(crashIdx, 1);
      publishPhases(true);
      return c.json({
        runnerPort: m.runnerPort,
        astroPort: m.astroPort,
        astroBase: m.astroBase,
        baseSha: m.baseSha,
        instanceId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      publishPhases(true);
      logger.error('supervisor: session start failed', { sessionId, err });
      emitProgress(sessionId, 'error', 'Workspace failed to start', { detail: msg });
      if (err instanceof DiskPressureError) return c.json({ error: msg, diskPressure: true }, 507);
      return c.json({ error: msg }, 500);
    }
  });

  app.post('/api/sessions/:id/stop', async (c) => {
    const sessionId = c.req.param('id')!;
    await ctx.stopSessionProcess(sessionId);
    // Once a user session goes to sleep, replenish warm standby if capacity opened up
    if (ctx.warmPoolRunning) ctx.replenishWarmPool();
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/restart', async (c) => {
    const sessionId = c.req.param('id')!;
    reservedWarmSlots.delete(sessionId);
    await ctx.stopSessionProcess(sessionId);
    return c.json({ ok: true });
  });

  app.delete('/api/sessions/:id', async (c) => {
    const sessionId = c.req.param('id')!;
    markDeleted(sessionId);
    const reserved = reservedWarmSlots.get(sessionId);
    if (reserved) {
      reservedWarmSlots.delete(sessionId);
    }
    const inflight = bootingSessions.get(sessionId);
    await ctx.stopSessionProcess(sessionId);
    if (inflight) {
      // the boot observes the tombstone and fails; its error was already reported to its caller
      await inflight.catch((e) => ignoreExpected(e, 'supervisor: boot aborted by delete', { sessionId }));
      await ctx.stopSessionProcess(sessionId);
    }
    logsBySession.delete(sessionId);
    startPhasesBySession.delete(sessionId);
    await fs.rm(sessionDir(sessionId), { recursive: true, force: true });
    if (ctx.warmPoolRunning) ctx.replenishWarmPool();
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/prune-node-modules', async (c) => {
    const sessionId = c.req.param('id')!;
    if (activeSessions.has(sessionId) || bootingSessions.has(sessionId)) {
      return c.json({ error: 'Cannot prune node_modules of an active session' }, 409);
    }
    const nmPath = path.join(sessionDir(sessionId), 'workspace', 'node_modules');
    await fs.rm(nmPath, { recursive: true, force: true });
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
    try {
      await assertDiskAdmission('duplicate a session', { sourceId });
    } catch (err) {
      if (err instanceof DiskPressureError) return c.json({ error: err.message, diskPressure: true }, 507);
      throw err;
    }
    await fs.mkdir(path.join(dstBase, 'state'), { recursive: true });

    if (body.mode === 'fresh-from-main') {
      return c.json({ ok: true });
    }

    const srcBase = sessionDir(sourceId);
    const srcWs = path.join(srcBase, 'workspace');
    const dstWs = path.join(dstBase, 'workspace');

    const hasSrcRepo = await fileExists(path.join(srcWs, '.git'));
    if (hasSrcRepo) {
      // Atomic Git clone avoids torn reads of .git/index or refs when duplicating a live session!
      await runGit(dstBase, ['clone', '--no-hardlinks', srcWs, 'workspace']);
      await runGit(dstWs, ['remote', 'set-url', 'origin', internalGitUrl]).catch((e) =>
        ignore(e, 'supervisor: set origin url on duplicated session'),
      );
      await runGit(dstWs, ['checkout', '-B', body.targetWorkingBranch]);
    }

    const srcUploads = path.join(srcBase, 'state', 'uploads');
    if (await fileExists(srcUploads)) {
      await fs.cp(srcUploads, path.join(dstBase, 'state', 'uploads'), { recursive: true });
    }
    const srcPageRequests = path.join(srcBase, 'state', 'page-requests.json');
    if (await fileExists(srcPageRequests)) {
      await fs
        .copyFile(srcPageRequests, path.join(dstBase, 'state', 'page-requests.json'))
        .catch((e) => ignore(e, 'supervisor: copy page requests to duplicated session'));
    }

    return c.json({ ok: true });
  });

  /**
   * Runs a git operation for a session without racing its runner's checkpoints (W-git): when the
   * runner is up it executes there, under the runner's repo lock; otherwise it runs here while
   * holding the session's git lock, which a booting runner waits for before it spawns.
   */
  async function runSessionGitOp<T>(
    sessionId: string,
    viaRunner: (m: ManagedSession) => Promise<T>,
    direct: (workspaceDir: string) => Promise<T>,
  ): Promise<T> {
    const booting = bootingSessions.get(sessionId);
    if (booting) {
      await booting.catch((e) => ignoreExpected(e, 'supervisor: boot failed before git op', { sessionId }));
    }
    const m = activeSessions.get(sessionId);
    if (m && m.proc.exitCode === null && m.proc.signalCode === null) return viaRunner(m);
    return sessionGitLocks.run(sessionId, () => direct(path.join(sessionDir(sessionId), 'workspace')));
  }

  async function postToRunner(
    m: ManagedSession,
    route: string,
    payload: Record<string, unknown>,
    timeoutMs = 150_000,
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    const res = await runnerFetch(`http://127.0.0.1:${m.runnerPort}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: clock.timeoutSignal(timeoutMs),
    });
    const data = (await res.json().catch((e) => {
      ignore(e, 'supervisor: non-JSON runner response', { route, status: res.status });
      return {};
    })) as Record<string, unknown>;
    return { status: res.status, data };
  }

  /**
   * Runs a session git operation, mapping failures to HTTP responses: remote errors (auth, missing
   * branch, rejected push) keep their status and are logged at warn; anything else is a 500 + error log.
   */
  async function withGitErrorResponse(
    c: { json: (b: unknown, s: number) => Response },
    op: string,
    sessionId: string,
    fn: () => Promise<Response>,
  ): Promise<Response> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GitRemoteError) {
        logger.warn('supervisor: session git remote operation rejected', { op, sessionId, status: err.status, err });
        return c.json({ error: err.message }, err.status);
      }
      logger.error('supervisor: session git operation failed', { op, sessionId, err });
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  app.post('/api/sessions/:id/git/fetch', async (c) => {
    const sessionId = c.req.param('id')!;
    const body = (await c.req.json()) as { baseBranch: string };
    return withGitErrorResponse(c, 'fetch', sessionId, () =>
      runSessionGitOp(
        sessionId,
        async (m) => {
          const r = await postToRunner(m, '/internal/git/fetch', {
            baseBranch: body.baseBranch,
            remoteUrl: internalGitUrl,
            authBearer: ctx.activeHostSecret || undefined,
          });
          return c.json(r.status === 200 ? { ok: true } : r.data, r.status as 200);
        },
        async (ws) => {
          await fetchBaseBranchLocked(ws, {
            baseBranch: body.baseBranch,
            remoteUrl: internalGitUrl,
            authBearer: ctx.activeHostSecret || undefined,
          });
          return c.json({ ok: true });
        },
      ),
    );
  });

  /**
   * Pushes the session to `refs/heads/<workingBranch>` (force). With `sha` (the commit the control
   * plane verified) exactly that commit is pushed; without it, HEAD resolved once. Returns `pushedSha`.
   */
  app.post('/api/sessions/:id/git/push', async (c) => {
    const sessionId = c.req.param('id')!;
    const body = (await c.req.json()) as { workingBranch: string; sha?: string };
    const sha = typeof body.sha === 'string' && body.sha.trim() ? body.sha.trim() : undefined;
    return withGitErrorResponse(c, 'push', sessionId, () =>
      runSessionGitOp(
        sessionId,
        async (m) => {
          const r = await postToRunner(m, '/internal/git/push', {
            workingBranch: body.workingBranch,
            sha,
            remoteUrl: internalGitUrl,
            authBearer: ctx.activeHostSecret || undefined,
          });
          if (r.status === 200) return c.json({ ok: true, pushedSha: r.data.pushedSha });
          return c.json(r.data, r.status as 400);
        },
        async (ws) => {
          const { pushedSha } = await pushCommitLocked(ws, {
            branch: body.workingBranch,
            sha,
            remoteUrl: internalGitUrl,
            authBearer: ctx.activeHostSecret || undefined,
          });
          return c.json({ ok: true, pushedSha });
        },
      ),
    );
  });

  app.get('/api/sessions/:id/logs', (c) => {
    const sessionId = c.req.param('id')!;
    return c.json({ lines: logsBySession.get(sessionId) ?? [] });
  });

  app.get('/api/sessions/:id/progress', (c) => {
    const sessionId = c.req.param('id')!;
    return c.json({
      progress: bootProgressBySession.get(sessionId) ?? null,
      // Phase timings of the latest (or in-progress) start: lruEvict, mirrorFetch, clone, checkout,
      // nodeModules, runnerHttp, runnerSpawn, runner.astroReady, runner.piReady, ...
      phases: startPhasesBySession.get(sessionId) ?? null,
    });
  });
}
