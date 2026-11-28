import path from 'node:path';
import type { Hono } from 'hono';
import { ensureGitRerere, runLockedGit } from '../checkpoints-and-git.js';
import { pathExists } from '../fs-util.js';
import { ignore, readJsonBodyOrEmpty } from '../log.js';
import type { RunnerContext } from '../runner-context.js';

/**
 * Session control from the supervisor / control plane: token, astro restart, warm-slot claim,
 * read-only, persona, owner. Registered by createRunner (see RunnerContext).
 */
export function registerSessionRoutes(app: Hono, ctx: RunnerContext): void {
  const {
    config,
    REPO_ROOT,
    STATE_DIR,
    BASE_BRANCH,
    gitIdentity,
    savePersistedSessionMeta,
    saveMetaLogged,
    cancelSpeculativeVerify,
    astroManager,
    runnerNmCache,
  } = ctx;
  app.post('/internal/token', async (c) => {
    const body = (await readJsonBodyOrEmpty(c)) as {
      workspaceToken?: string;
      hostSecret?: string;
    };
    if (body.hostSecret?.trim()) {
      ctx.activeHostSecret = body.hostSecret.trim();
    }
    if (!body.workspaceToken || !body.workspaceToken.trim()) {
      return c.json({ error: 'Missing workspaceToken' }, 400);
    }
    ctx.workspaceToken = body.workspaceToken.trim();
    return c.json({ ok: true });
  });

  app.post('/internal/astro/restart', async (c) => {
    await astroManager.restart();
    const astro = astroManager.getStatus();
    return c.json({
      ok: true,
      astroReady: astro.ready,
      astroState: astro.state,
    });
  });

  /**
   * Binds a pre-warmed standby workspace to a real user session.
   * When `syncFromMirror` is false (normal case since supervisor recycles standby slots when
   * `origin/main` advances), performs a zero-file-churn `git symbolic-ref` branch rename so
   * Chokidar fires zero events and pre-rendered Vite/Tailwind JIT caches stay hot!
   */
  app.post('/internal/claim', async (c) => {
    const body = (await c.req.json()) as {
      workingBranch: string;
      baseBranch?: string;
      editorName?: string;
      editorEmail?: string;
      persona?: 'non-technical' | 'developer';
      readOnly?: boolean;
      syncFromMirror?: boolean;
      mirrorPath?: string;
      workspaceToken?: string;
      hostSecret?: string;
    };

    if (body.workspaceToken?.trim()) {
      ctx.workspaceToken = body.workspaceToken.trim();
    }
    if (body.hostSecret?.trim()) {
      ctx.activeHostSecret = body.hostSecret.trim();
    }

    const targetBaseBranch = body.baseBranch || BASE_BRANCH;
    const mirrorPath = body.mirrorPath || config.mirrorPath;
    let needsAstroRestart = false;

    if (body.syncFromMirror) {
      const hasMirror = await pathExists(path.join(mirrorPath, 'HEAD'), 'runner: probe git mirror');
      if (hasMirror) {
        const oldHead = (await runLockedGit(REPO_ROOT, ['rev-parse', 'HEAD'])).stdout.trim();
        await runLockedGit(
          REPO_ROOT,
          ['fetch', mirrorPath, `+refs/heads/${targetBaseBranch}:refs/remotes/origin/${targetBaseBranch}`],
          undefined,
          30_000,
        );
        const changedFilesOut = await runLockedGit(REPO_ROOT, [
          'diff',
          '--name-only',
          oldHead,
          `origin/${targetBaseBranch}`,
        ]);
        const changedList = changedFilesOut.stdout.split(/\r?\n/).filter(Boolean);

        const changedLocks = changedList.some(
          (f) => f === 'package.json' || f === 'package-lock.json' || f === 'pnpm-lock.yaml',
        );
        if (changedLocks || changedList.some((f) => f.startsWith('astro.config.'))) {
          needsAstroRestart = true;
          await astroManager.pause().catch((e) => ignore(e, 'runner: pause astro dev before dependency change'));
        }

        await runLockedGit(REPO_ROOT, [
          'checkout',
          '-B',
          body.workingBranch,
          `origin/${targetBaseBranch}`,
        ]);

        if (changedLocks) {
          await runnerNmCache.ensureSessionNodeModules({
            workspaceDir: REPO_ROOT,
            stateDir: STATE_DIR,
            devLocalRepo: config.devLocalRepo,
          });
        }
        await ctx.piRuntime?.reloadAgentsMd().catch((e) => ignore(e, 'runner: reload AGENTS.md'));
      } else {
        const curSha = (await runLockedGit(REPO_ROOT, ['rev-parse', 'HEAD'])).stdout.trim();
        await runLockedGit(REPO_ROOT, ['update-ref', `refs/heads/${body.workingBranch}`, curSha]);
        await runLockedGit(REPO_ROOT, ['symbolic-ref', 'HEAD', `refs/heads/${body.workingBranch}`]);
      }
    } else {
      // Zero working-tree churn branch rename
      const curSha = (await runLockedGit(REPO_ROOT, ['rev-parse', 'HEAD'])).stdout.trim();
      await runLockedGit(REPO_ROOT, ['update-ref', `refs/heads/${body.workingBranch}`, curSha]);
      await runLockedGit(REPO_ROOT, ['symbolic-ref', 'HEAD', `refs/heads/${body.workingBranch}`]);
    }

    if (needsAstroRestart) {
      await astroManager.restart().catch((e) => ignore(e, 'runner: restart astro dev after claim'));
    }

    await ensureGitRerere(REPO_ROOT).catch((e) => ignore(e, 'runner: enable git rerere'));
    ctx.baseSha = (await runLockedGit(REPO_ROOT, ['rev-parse', 'HEAD'])).stdout.trim();
    if (body.editorName) gitIdentity.editorName = body.editorName;
    if (body.editorEmail) gitIdentity.editorEmail = body.editorEmail;
    if (body.persona === 'developer' || body.persona === 'non-technical') {
      ctx.persona = body.persona;
    }
    if (typeof body.readOnly === 'boolean') {
      ctx.readOnly = body.readOnly;
    }
    await savePersistedSessionMeta();

    const astroStatus = astroManager.getStatus();
    return c.json({
      ok: true,
      baseSha: ctx.baseSha,
      originalBase: astroStatus.originalBase || ctx.originalBase,
      previewBase: astroStatus.previewBase || ctx.previewBase,
    });
  });

  app.post('/internal/read-only', async (c) => {
    const body = (await c.req.json()) as { readOnly: boolean };
    ctx.readOnly = Boolean(body.readOnly);
    if (ctx.readOnly) cancelSpeculativeVerify();
    await saveMetaLogged('state change');
    return c.json({ ok: true, readOnly: ctx.readOnly });
  });

  app.post('/internal/persona', async (c) => {
    const body = (await c.req.json()) as { persona?: string };
    ctx.persona = body.persona === 'developer' ? 'developer' : 'non-technical';
    await saveMetaLogged('state change');
    return c.json({ ok: true, persona: ctx.persona });
  });

  app.post('/internal/owner', async (c) => {
    const body = (await c.req.json()) as {
      editorName?: string;
      editorEmail?: string;
      persona?: string;
    };
    if (body.editorName?.trim()) gitIdentity.editorName = body.editorName.trim();
    if (body.editorEmail?.trim()) gitIdentity.editorEmail = body.editorEmail.trim();
    if (body.persona === 'developer' || body.persona === 'non-technical') {
      ctx.persona = body.persona;
    }
    await saveMetaLogged('state change');
    return c.json({ ok: true });
  });
}
