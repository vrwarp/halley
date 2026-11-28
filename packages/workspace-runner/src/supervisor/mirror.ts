import fs from 'node:fs/promises';
import path from 'node:path';
import { ignore, logger } from '../log.js';
import { AsyncMutex } from '../mutex.js';
import { fileExists } from './shared.js';
import type { SupervisorContext } from './context.js';

/**
 * Local bare git mirror: serialized syncs from the control plane, readers, maintenance. Created by
 * createWorkspaceSupervisor (see SupervisorContext).
 */
export function createMirror(ctx: SupervisorContext) {
  const { opts, mirrorDir, internalGitUrl, runGit } = ctx;
  // Mirror: every mutation (fetch per branch, maintenance) is serialized by mirrorMutex. A sync is
  // single-flight PER BRANCH: a request for branch B never returns the result of an in-flight sync
  // of branch A (it queues behind it instead).
  const mirrorMutex = new AsyncMutex();
  const mirrorSyncInflight = new Map<string, Promise<string>>();
  /** Clones (readers of the mirror) in flight; maintenance never starts while > 0. */
  let mirrorReaders = 0;
  let mirrorSyncsSinceMaintenance = 0;

  async function withMirrorRead<T>(fn: () => Promise<T>): Promise<T> {
    mirrorReaders++;
    try {
      return await fn();
    } finally {
      mirrorReaders--;
    }
  }

  function syncLocalMirror(baseBranch: string): Promise<string> {
    const existing = mirrorSyncInflight.get(baseBranch);
    if (existing) return existing;
    const promise = mirrorMutex
      .run(async () => {
        const exists = await fileExists(path.join(mirrorDir, 'HEAD'));
        if (!exists) {
          await fs.mkdir(path.dirname(mirrorDir), { recursive: true });
          await fs.mkdir(mirrorDir, { recursive: true });
          await runGit(mirrorDir, ['init', '--bare'], false);
          await runGit(mirrorDir, ['remote', 'add', 'origin', internalGitUrl], false);
        } else {
          await runGit(mirrorDir, ['remote', 'set-url', 'origin', internalGitUrl], false).catch((e) =>
            ignore(e, 'supervisor: update mirror origin url'),
          );
        }
        await runGit(
          mirrorDir,
          ['fetch', 'origin', `+refs/heads/${baseBranch}:refs/heads/${baseBranch}`],
          true,
        );
        mirrorSyncsSinceMaintenance++;
        // HEAD tracks the default branch only; other base branches are cloned via explicit checkout
        if (baseBranch === opts.baseBranch || !exists) {
          await runGit(mirrorDir, ['symbolic-ref', 'HEAD', `refs/heads/${baseBranch}`]).catch((e) =>
            ignore(e, 'supervisor: point mirror HEAD at base branch', { baseBranch }),
          );
        }
        return runGit(mirrorDir, ['rev-parse', `refs/heads/${baseBranch}`]).catch((e) => {
          ignore(e, 'supervisor: resolve mirror branch head', { baseBranch });
          return '';
        });
      })
      .then((headSha) => {
        // Warm standby slots are always cut from the default base branch
        if (headSha && baseBranch === opts.baseBranch) void ctx.recycleStaleWarmSlots(headSha);
        return headSha;
      })
      .finally(() => {
        if (mirrorSyncInflight.get(baseBranch) === promise) mirrorSyncInflight.delete(baseBranch);
      });
    mirrorSyncInflight.set(baseBranch, promise);
    return promise;
  }

  /**
   * `git maintenance run --auto` (falls back to `git gc --auto`) on the mirror, off the request path:
   * queued on the mirror mutex (never concurrent with a fetch) and skipped while a clone reads it.
   */
  async function runMirrorMaintenance(): Promise<'ran' | 'skipped'> {
    if (!(await fileExists(path.join(mirrorDir, 'HEAD')))) return 'skipped';
    return mirrorMutex.run(async () => {
      if (mirrorReaders > 0) {
        logger.debug('supervisor: mirror maintenance deferred; clone in flight', { mirrorReaders });
        return 'skipped';
      }
      const t0 = Date.now();
      try {
        await runGit(mirrorDir, ['maintenance', 'run', '--auto'], false, 10 * 60_000);
      } catch (err) {
        ignore(err, 'supervisor: git maintenance unavailable; falling back to gc --auto');
        await runGit(mirrorDir, ['gc', '--auto', '--quiet'], false, 10 * 60_000);
      }
      mirrorSyncsSinceMaintenance = 0;
      logger.info('supervisor: mirror maintenance done', { ms: Date.now() - t0 });
      return 'ran';
    });
  }

  return { withMirrorRead, syncLocalMirror, runMirrorMaintenance };
}
