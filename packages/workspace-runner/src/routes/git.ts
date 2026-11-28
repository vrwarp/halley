import fs from 'node:fs/promises';
import path from 'node:path';
import type { Hono } from 'hono';
import {
  createCheckpoint,
  fetchBaseBranchLocked,
  getGitChanges,
  GitRemoteError,
  hasProtectedPathChanges,
  listCheckpoints,
  pushCommitLocked,
  resetToRef,
  revertSingleFile,
  runLockedGit,
  undoToCheckpoint,
} from '../checkpoints-and-git.js';
import { ignore, readJsonBodyOrEmpty } from '../log.js';
import type { RunnerContext } from '../runner-context.js';

/**
 * Working-tree git endpoints: changes, revert-file, exclude-paths, restore-sha, undo, checkpoint,
 * supervisor fetch/push. Registered by createRunner (see RunnerContext).
 */
export function registerGitRoutes(app: Hono, ctx: RunnerContext): void {
  const {
    REPO_ROOT,
    BASE_BRANCH,
    gitIdentity,
    changesOrEmpty,
    resolveHeadSha,
    syncPageRequestsLogged,
    broadcast,
    notifySessionDiverged,
    cancelSpeculativeVerify,
    scheduleIdleSpeculativeVerify,
    cancelInlineEditTimer,
    scheduleInlineCheckpoint,
  } = ctx;
  app.post('/internal/git/notify-patched', async (c) => {
    const body = (await readJsonBodyOrEmpty(c)) as { file?: string };
    scheduleInlineCheckpoint(`Inline edit in ${body.file || 'page'}`);
    return c.json({ ok: true });
  });

  app.get('/internal/git/changes', async (c) => {
    const baseRef = c.req.query('baseRef') || `origin/${BASE_BRANCH}`;
    const changes = await getGitChanges(REPO_ROOT, baseRef);
    const checkpoints = await listCheckpoints(REPO_ROOT, ctx.baseSha);
    return c.json({ changes, checkpoints, baseSha: ctx.baseSha, headSha: await resolveHeadSha() });
  });

  app.post('/internal/git/revert-file', async (c) => {
    if (ctx.readOnly) return c.json({ error: 'Read-only' }, 403);
    cancelSpeculativeVerify();
    cancelInlineEditTimer();
    const body = (await c.req.json()) as { path: string; baseRef?: string };
    await revertSingleFile(REPO_ROOT, body.path, body.baseRef || `origin/${BASE_BRANCH}`, gitIdentity);
    await syncPageRequestsLogged('after git operation');
    const changes = await changesOrEmpty();
    const checkpoints = await listCheckpoints(REPO_ROOT, ctx.baseSha).catch((e) => {
      ignore(e, 'runner: list checkpoints after revert');
      return [] as Awaited<ReturnType<typeof listCheckpoints>>;
    });
    if (checkpoints[0]) {
      broadcast({
        type: 'checkpoint_created',
        checkpoint: checkpoints[0],
        changedFilesCount: changes.length,
      });
    }
    notifySessionDiverged(changes.length);
    if (changes.length > 0) {
      scheduleIdleSpeculativeVerify();
    }
    return c.json({ ok: true, changedFilesCount: changes.length });
  });

  /**
   * Transactionally excludes unticked Undo paths right before verification, returning
   * `preExcludeSha` so `PublishService` can restore the unticked files if checks fail.
   */
  app.post('/internal/git/exclude-paths', async (c) => {
    if (ctx.readOnly) return c.json({ error: 'Read-only' }, 403);
    cancelSpeculativeVerify();
    cancelInlineEditTimer();
    const body = (await c.req.json()) as { paths?: string[]; baseRef?: string };
    const paths = (body.paths ?? []).filter((p) => p && !p.startsWith('.github'));
    if (paths.length === 0) {
      return c.json({ ok: true, preExcludeSha: null });
    }
    await createCheckpoint(REPO_ROOT, 'Before partial-undo selection', gitIdentity);
    const preExcludeSha = (await runLockedGit(REPO_ROOT, ['rev-parse', 'HEAD'])).stdout.trim();
    const baseRef = body.baseRef || `origin/${BASE_BRANCH}`;
    for (const relPath of paths) {
      const inBase = await runLockedGit(REPO_ROOT, ['cat-file', '-e', `${baseRef}:${relPath}`]);
      if (inBase.code === 0) {
        await runLockedGit(REPO_ROOT, ['checkout', baseRef, '--', relPath]);
      } else {
        await fs.rm(path.join(REPO_ROOT, relPath), { force: true });
        await runLockedGit(REPO_ROOT, ['rm', '-f', '--ignore-unmatch', relPath]);
      }
    }
    await createCheckpoint(
      REPO_ROOT,
      `Exclude ${paths.length} unselected file${paths.length === 1 ? '' : 's'} from Undo`,
      gitIdentity,
    );
    const changes = await changesOrEmpty(baseRef);
    return c.json({ ok: true, preExcludeSha, changedFilesCount: changes.length });
  });

  app.post('/internal/git/restore-sha', async (c) => {
    if (ctx.readOnly) return c.json({ error: 'Read-only' }, 403);
    const body = (await c.req.json()) as { targetSha?: string };
    if (!body.targetSha) return c.json({ error: 'Missing targetSha' }, 400);
    cancelSpeculativeVerify();
    cancelInlineEditTimer(); // its pending edit is auto-saved by resetToRef before the reset
    const ok = await resetToRef(REPO_ROOT, body.targetSha, gitIdentity);
    if (!ok) return c.json({ error: 'Failed to restore SHA' }, 500);
    const changes = await changesOrEmpty();
    return c.json({ ok: true, changedFilesCount: changes.length });
  });

  app.post('/internal/git/undo', async (c) => {
    if (ctx.readOnly) return c.json({ error: 'Read-only' }, 403);
    cancelSpeculativeVerify();
    cancelInlineEditTimer();
    const body = (await c.req.json()) as { targetSha: string };
    const ckpt = await undoToCheckpoint(REPO_ROOT, body.targetSha, gitIdentity);
    await syncPageRequestsLogged('after git operation');
    const changes = await changesOrEmpty();
    if (ckpt) {
      broadcast({ type: 'checkpoint_created', checkpoint: ckpt, changedFilesCount: changes.length });
    }
    notifySessionDiverged(changes.length);
    if (changes.length > 0) {
      scheduleIdleSpeculativeVerify();
    }
    return c.json({ ok: true, checkpoint: ckpt, changedFilesCount: changes.length });
  });

  app.post('/internal/git/checkpoint', async (c) => {
    if (ctx.readOnly) return c.json({ error: 'Read-only' }, 403);
    cancelInlineEditTimer();
    const body = (await readJsonBodyOrEmpty(c)) as { summary?: string };
    const ckpt = await createCheckpoint(REPO_ROOT, body.summary || 'Manual checkpoint', gitIdentity);
    return c.json({ ok: true, checkpoint: ckpt });
  });

  /**
   * Supervisor-initiated fetch/push. They run here, under this process's repo git lock, so they can
   * never interleave with a checkpoint, undo or sync (the supervisor is a different process).
   */
  app.post('/internal/git/fetch', async (c) => {
    const body = (await readJsonBodyOrEmpty(c)) as {
      baseBranch?: string;
      remoteUrl?: string;
      authBearer?: string;
    };
    try {
      await fetchBaseBranchLocked(REPO_ROOT, {
        baseBranch: body.baseBranch || BASE_BRANCH,
        remoteUrl: body.remoteUrl,
        authBearer: body.authBearer || ctx.activeHostSecret || undefined,
      });
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof GitRemoteError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  app.post('/internal/git/push', async (c) => {
    const body = (await readJsonBodyOrEmpty(c)) as {
      workingBranch?: string;
      sha?: string;
      remoteUrl?: string;
      authBearer?: string;
    };
    if (!body.workingBranch) return c.json({ error: 'Missing workingBranch' }, 400);
    // Pushes committed history only (HEAD or the verified `sha`); a pending debounced inline edit is
    // deliberately NOT checkpointed here: it has not been verified.
    try {
      const { pushedSha } = await pushCommitLocked(REPO_ROOT, {
        branch: body.workingBranch,
        sha: body.sha || undefined,
        remoteUrl: body.remoteUrl,
        authBearer: body.authBearer || ctx.activeHostSecret || undefined,
      });
      return c.json({ ok: true, pushedSha });
    } catch (err) {
      if (err instanceof GitRemoteError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  app.get('/internal/git/protected-diff', async (c) => {
    const baseRef = c.req.query('baseRef') || `origin/${BASE_BRANCH}`;
    const protectedFiles = await hasProtectedPathChanges(REPO_ROOT, baseRef);
    return c.json({ clean: protectedFiles.length === 0, protectedFiles });
  });

  // The legacy `/internal/git/rebase` and `/internal/git/sync` endpoints (working-tree conflict
  // markers + waiting for the agent while holding the repo lock) had no callers and were removed;
  // syncing goes through `/internal/sync/*` (virtual merge, never touches the tree on conflict).
}
