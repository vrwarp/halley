import {
  CreateSessionRequestSchema,
  RevertSessionCreateSchema,
  UpdateSessionRequestSchema,
  type LiveHistoryEntryDto,
  type RevertedCommitSummaryDto,
} from '@halley/shared';
import { deriveWorkspaceToken } from '@halley/shared/auth';
import { runGit } from '../drivers/workspace-driver.js';
import { readJsonObject } from '../http-body.js';
import { ignore, logger, orDefault } from '../log.js';
import { buildContinuationHandoffSummary, buildUndoHandoffSummary } from '../handoff.js';
import { hashWorkspaceToken } from '../proxy/llm-proxy.js';
import { slugify, type App, type ControlPlaneContext, type PendingRevert } from '../control-plane-context.js';

/** Registers the session lifecycle routes (CRUD, wake/restart/duplicate, Undo drafts, history, delete). */
export function register(app: App, ctx: ControlPlaneContext) {
  const {
    config,
    clock,
    randomUUID,
    runnerFetch,
    db,
    auth,
    github,
    driver,
    browserWsBySession,
    broadcastToSession,
    enrichSessionDto,
    publishService,
    screenshotService,
  } = ctx;
  // Sessions
  app.get('/api/sessions', auth.requireAuth, (c) => {
    const user = c.get('user');
    const sessions = db.listSessions().map((s) => enrichSessionDto(s, user));
    return c.json({ sessions, spend: db.getSpendStatus(user.id) });
  });

  app.post('/api/sessions', auth.requireAuth, async (c) => {
    const user = c.get('user');
    const rawBody = await readJsonObject(c);
    const parsed = CreateSessionRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message || 'Invalid session request' }, 400);
    }
    const title = (parsed.data.title || 'Website update').trim();
    const warm = (await driver.reserveWarmWorkspace?.()) ?? null;
    const id = warm ? warm.id : randomUUID();
    const short = id.slice(0, 6);
    const slug = slugify(title);
    const workingBranch = `halley/${slug}-${short}`;
    const rawToken = deriveWorkspaceToken(config.sessionSecret, id, 0);
    const volumeName = warm ? warm.volumeName : `halley-ws-${id}`;

    let session;
    try {
      session = db.createSession({
        id,
        title,
        slug,
        ownerUserId: user.id,
        repo: config.repo,
        baseBranch: config.baseBranch,
        workingBranch,
        volumeName,
        workspaceTokenHash: hashWorkspaceToken(rawToken),
      });
    } catch (err) {
      if (warm) {
        await driver
          .releaseWarmWorkspace?.(warm.id)
          .catch((releaseErr) => ignore(releaseErr, 'releasing warm workspace after failed create failed', { warmId: warm.id }));
      }
      throw err;
    }

    driver.setRawWorkspaceToken?.(id, rawToken);

    // Start booting (or claiming warm standby) workspace asynchronously so the UI opens immediately
    void driver.ensureRunning(session).catch((err) => {
      db.transitionSession(id, {
        expectedEpoch: session.lease_epoch,
        patch: { status: 'error', publish_error: String(err) },
      });
    });
    screenshotService.prewarm();

    return c.json({ session: enrichSessionDto(session, user) }, 201);
  });

  app.patch('/api/sessions/:id', auth.requireAuth, async (c) => {
    const user = c.get('user');
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    if (s.owner_user_id !== user.id && !user.isAdmin) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const rawBody = await readJsonObject(c);
    const parsed = UpdateSessionRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message || 'Invalid title' }, 400);
    }
    db.updateSession(s.id, { title: parsed.data.title });
    broadcastToSession(s.id, { type: 'session_meta_updated' });
    return c.json({ session: enrichSessionDto(db.getSession(s.id)!, user) });
  });

  app.get('/api/sessions/:id', auth.requireAuth, (c) => {
    const user = c.get('user');
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    if (s.status === 'running' || s.status === 'starting') {
      screenshotService.prewarm();
    }
    return c.json({ session: enrichSessionDto(s, user), spend: db.getSpendStatus(user.id) });
  });

  app.post('/api/sessions/:id/wake', auth.requireAuth, async (c) => {
    const user = c.get('user');
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);

    if (s.status === 'sleeping' || s.status === 'error') {
      db.transitionSession(s.id, {
        fromStatuses: ['sleeping', 'error'],
        patch: { status: 'starting', publish_error: null },
      });
    }
    const updated = db.getSession(s.id)!;
    void driver.ensureRunning(updated).catch((err) => {
      db.transitionSession(s.id, {
        expectedEpoch: updated.lease_epoch,
        patch: { status: 'error', publish_error: String(err) },
      });
    });
    screenshotService.prewarm();
    return c.json({ session: enrichSessionDto(updated, user) });
  });

  app.post('/api/sessions/:id/restart', auth.requireAuth, async (c) => {
    const user = c.get('user');
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    if (s.owner_user_id !== user.id && !user.isAdmin) {
      return c.json({ error: 'Only the session owner or an admin can restart this workspace.' }, 403);
    }

    const isFrozen = s.status === 'published' || s.status === 'merged';
    db.transitionSession(s.id, {
      allowUnfreeze: isFrozen,
      patch: {
        status: isFrozen ? s.status : 'starting',
        publish_error: null,
        runner_url: null,
        astro_url: null,
      },
    });
    const updated = db.getSession(s.id)!;
    const starter = driver.restart
      ? driver.restart(updated)
      : driver.stop(updated).then(() => driver.ensureRunning(db.getSession(s.id) ?? updated));
    void starter.catch((err) => {
      logger.warn('workspace restart failed', { sessionId: s.id, err });
      try {
        // setSessionStatus refuses to move a merged/published session to 'error'
        db.setSessionStatus(s.id, 'error', { publish_error: String(err) });
      } catch (dbErr) {
        logger.error('recording workspace restart failure failed', { sessionId: s.id, err: dbErr });
      }
    });
    return c.json({ session: enrichSessionDto(updated, user) });
  });

  app.post('/api/sessions/:id/duplicate', auth.requireAuth, async (c) => {
    const user = c.get('user');
    const src = db.getSession(c.req.param('id')!);
    if (!src) return c.json({ error: 'Not found' }, 404);

    // Ensure source transcript is captured in session_archives for unified Hybrid carry-over (Q18, Q19)
    let srcArchive = db.getSessionArchive(src.id);
    if (!srcArchive && !src.volume_expired_at && (src.runner_url || src.status === 'sleeping')) {
      const srcEp = await orDefault(
        driver.ensureRunning(src),
        null,
        'duplicate: source workspace could not be started; continuing without archiving its transcript',
        { sessionId: src.id },
      );
      if (srcEp?.runnerUrl) {
        await publishService
          .archiveSessionDeterministically(
            src.id,
            srcEp.runnerUrl,
            src.base_branch,
            src.merged_sha,
            src.pr_url,
          )
          .catch((err) => ignore(err, 'duplicate: archiving source session failed', { sessionId: src.id }));
        srcArchive = db.getSessionArchive(src.id);
      }
    }

    const parentArchive = src.parent_session_id ? db.getSessionArchive(src.parent_session_id) : null;
    let handoffSummary = srcArchive?.handoffSummary ?? null;
    if (!handoffSummary) {
      handoffSummary = buildContinuationHandoffSummary(src, srcArchive, parentArchive?.handoffSummary);
      if (srcArchive) {
        db.setArchiveHandoffSummary(src.id, handoffSummary);
      }
    }

    const isFinished = src.status === 'published' || src.status === 'merged';
    const mode = isFinished ? 'fresh-from-main' : 'branch-off';
    const kind = isFinished ? 'continuation' : 'edit';
    const id = randomUUID();
    const short = id.slice(0, 6);
    const title = isFinished ? `Continued: ${src.title}` : `${src.title} (Copy)`;
    const slug = slugify(title);
    const rawToken = deriveWorkspaceToken(config.sessionSecret, id, 0);

    const copy = db.transaction(() => {
      const created = db.createSession({
        id,
        title,
        slug,
        kind,
        parentSessionId: src.id,
        ownerUserId: user.id,
        repo: src.repo,
        baseBranch: src.base_branch,
        workingBranch: `halley/${slug}-${short}`,
        baseSha: mode === 'branch-off' ? src.base_sha : '',
        volumeName: `halley-ws-${id}`,
        workspaceTokenHash: hashWorkspaceToken(rawToken),
      });
      if (mode === 'branch-off' && src.changed_files_count > 0) {
        db.updateSession(created.id, { changed_files_count: src.changed_files_count });
        return db.getSession(created.id) ?? created;
      }
      return created;
    });

    driver.setRawWorkspaceToken?.(id, rawToken);

    await driver.duplicateWorkspace(src, copy, mode);
    void driver
      .ensureRunning(copy)
      .then(async (ep) => {
        if (handoffSummary) {
          await runnerFetch(`${ep.runnerUrl}/internal/context-note`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note: handoffSummary, persist: true }),
            signal: clock.timeoutSignal(15_000),
          }).catch((err) => ignore(err, 'duplicate: sending handoff note failed', { sessionId: copy.id }));
        }
      })
      .catch((err) => {
        logger.warn('duplicate: starting the copied workspace failed', { sessionId: copy.id, err });
        db.transitionSession(copy.id, {
          expectedEpoch: copy.lease_epoch,
          patch: { status: 'error', publish_error: String(err) },
        });
      });

    return c.json({ session: enrichSessionDto(copy, user) }, 201);
  });

  // Journey A: Any editor can undo a Halley publication or non-.github/** main commit (Q1, Q5, Q17)
  const revertStartsInFlight = new Set<string>();
  type RevertStartResult = {
    status?: 'clean' | 'conflict' | 'nothing_to_undo';
    revertCheckpointSha?: string;
    revertedCommits?: RevertedCommitSummaryDto[];
    conflictedFiles?: string[];
    changedFilesCount?: number;
    [key: string]: unknown;
  };

  /**
   * Starts the revert in an Undo draft's workspace and sends the undo context note. On success the
   * session's revert_pending_json marker is cleared; on failure revert_start_error records why, with
   * a `retryable:` prefix when the request never reached the runner (safe to send again).
   */
  const runRevertStart = async (
    revertSession: import('../db.js').SessionRecord,
    pending: PendingRevert,
    ctx?: {
      srcSession: import('../db.js').SessionRecord | null;
      srcArchive: ReturnType<typeof db.getSessionArchive>;
      parentArchive: ReturnType<typeof db.getSessionArchive>;
    },
  ): Promise<RevertStartResult | null> => {
    const srcSession = ctx ? ctx.srcSession : pending.srcSessionId ? db.getSession(pending.srcSessionId) : null;
    const srcArchive = ctx ? ctx.srcArchive : srcSession ? db.getSessionArchive(srcSession.id) : null;
    const parentArchive = ctx
      ? ctx.parentArchive
      : srcSession?.parent_session_id
        ? db.getSessionArchive(srcSession.parent_session_id)
        : null;
    let sent = false;
    revertStartsInFlight.add(revertSession.id);
    try {
      const ep = await driver.ensureRunning(revertSession);
      sent = true;
      let res: Response;
      try {
        res = await runnerFetch(`${ep.runnerUrl}/internal/git/revert-start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shas: pending.shas }),
          signal: clock.timeoutSignal(55_000),
        });
      } catch (err) {
        // Connection refused/reset before any response: the runner did not start the revert
        if (!(err instanceof Error && err.name === 'TimeoutError')) sent = false;
        throw err;
      }
      const revertResult = (await orDefault(res.json(), null, 'revert-start: runner response is not JSON', {
        sessionId: revertSession.id,
        status: res.status,
      })) as RevertStartResult | null;
      if (!res.ok) {
        throw new Error(
          `revert-start failed (${res.status}): ${typeof revertResult?.error === 'string' ? revertResult.error : 'no detail'}`,
        );
      }
      const revUpdates: Partial<import('../db.js').SessionRecord> = { revert_pending_json: null, revert_start_error: null };
      if (revertResult?.revertCheckpointSha) {
        revUpdates.initial_revert_sha = revertResult.revertCheckpointSha;
      }
      if (typeof revertResult?.changedFilesCount === 'number') {
        revUpdates.changed_files_count = revertResult.changedFilesCount;
      }
      db.updateSession(revertSession.id, revUpdates);

      const undoSummary = buildUndoHandoffSummary({
        baseBranch: config.baseBranch,
        targetTitle: pending.targetTitle,
        targetShas: pending.shas,
        revertReason: revertSession.revert_reason ?? '',
        revertStatus: revertResult?.status ?? null,
        revertCheckpointSha: revertResult?.revertCheckpointSha ?? null,
        revertedCommits: Array.isArray(revertResult?.revertedCommits) ? revertResult.revertedCommits : [],
        conflictedFiles: Array.isArray(revertResult?.conflictedFiles) ? revertResult.conflictedFiles : [],
        srcSession,
        srcArchive,
        priorHandoff: parentArchive?.handoffSummary ?? null,
      });

      await runnerFetch(`${ep.runnerUrl}/internal/context-note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: undoSummary, persist: true }),
        signal: clock.timeoutSignal(15_000),
      }).catch((err) => ignore(err, 'revert: sending undo context note failed', { sessionId: revertSession.id }));
      return revertResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Durable marker: the Undo draft may not contain the revert yet. Retried by the chat bridge
      // when it never reached the runner, otherwise surfaced to the editor.
      db.updateSession(revertSession.id, { revert_start_error: `${sent ? '' : 'retryable:'}${msg}`.slice(0, 1000) });
      logger.warn('revert: starting revert in workspace failed', { sessionId: revertSession.id, retryable: !sent, err });
      return null;
    } finally {
      revertStartsInFlight.delete(revertSession.id);
    }
  };

  /**
   * Called once a chat bridge has a running workspace: finishes an Undo draft whose revert-start
   * failed earlier. Returns a message to surface when the revert could not be applied.
   */
  const resumePendingRevert = async (sessionId: string): Promise<string | null> => {
    if (revertStartsInFlight.has(sessionId)) return null;
    const s = db.getSession(sessionId);
    if (!s?.revert_pending_json) return null;
    let pending: PendingRevert;
    try {
      pending = JSON.parse(s.revert_pending_json) as PendingRevert;
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      logger.error('revert: corrupt pending revert marker; dropping it', { sessionId, err });
      db.updateSession(sessionId, { revert_pending_json: null });
      return null;
    }
    // No error yet means the call may still be in flight (or the process died mid-call): only a
    // failure that never reached the runner is safe to send again.
    const lastError = s.revert_start_error;
    if (lastError?.startsWith('retryable:')) {
      const result = await runRevertStart(s, pending);
      if (result) return null;
    }
    const cur = db.getSession(sessionId);
    if (!cur?.revert_pending_json) return null;
    const detail = (cur.revert_start_error ?? 'the workspace did not confirm it').replace(/^retryable:/, '');
    return `Undo could not be applied to this draft automatically (${detail}). Ask the assistant to revert ${pending.shas
      .map((x) => x.slice(0, 7))
      .join(', ')}, or discard this draft and try Undo again.`;
  };

  app.post('/api/sessions/revert', auth.requireAuth, async (c) => {
    const user = c.get('user');
    const rawBody = await readJsonObject(c);
    const parsed = RevertSessionCreateSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message || 'Invalid revert request' }, 400);
    }
    const body = parsed.data;
    const reason = (body.reason || '').trim();
    if (!reason) {
      return c.json({ error: 'Please enter a short reason for undoing this publication.' }, 400);
    }

    const srcSession = body.sessionId ? db.getSession(body.sessionId) : null;
    const targetShas =
      body.shas && body.shas.length > 0
        ? body.shas
        : body.sha
          ? [body.sha]
          : srcSession?.merged_sha
            ? [srcSession.merged_sha]
            : [];

    if (targetShas.length === 0) {
      return c.json({ error: 'No published commit SHA found to undo.' }, 400);
    }

    const primarySha = targetShas[0]!;
    // In-flight publish lock checked across ALL target SHAs
    for (const sha of targetShas) {
      const inFlight = db.hasInFlightRevertForSha(sha);
      if (inFlight) {
        return c.json(
          {
            error: `${inFlight.owner_name || 'A teammate'} is already publishing an undo for this change.`,
            inFlightSessionId: inFlight.id,
          },
          409,
        );
      }
    }

    // Block undoing developer commits that touch protected .github/** files (fail closed when GitHub or devLocalRepo is configured!)
    if (!srcSession && (config.githubToken || config.githubAppId || config.devLocalRepo)) {
      for (const sha of targetShas) {
        let files: string[];
        try {
          if (config.devLocalRepo && !config.githubToken && !config.githubAppId) {
            const out = await runGit(config.devLocalRepo, [
              'diff-tree',
              '--no-commit-id',
              '--name-only',
              '-r',
              '-m',
              sha,
            ]);
            files = out
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean);
          } else {
            files = await github.getCommitFilesOrThrow(sha);
          }
        } catch (err) {
          return c.json(
            {
              error: `Could not verify commit files before undoing (${err instanceof Error ? err.message : 'GitHub unavailable'}). Please try again.`,
            },
            502,
          );
        }
        if (files.some((f) => f === '.github' || f.startsWith('.github/'))) {
          return c.json(
            { error: 'Developer infrastructure update (.github/**) — revert directly on GitHub.' },
            403,
          );
        }
      }
    }

    // Ensure source transcript is captured if undoing a Halley session whose archive wasn't saved yet
    let srcArchive = srcSession ? db.getSessionArchive(srcSession.id) : null;
    if (srcSession && !srcArchive && srcSession.runner_url) {
      const srcEp = await orDefault(
        driver.ensureRunning(srcSession),
        null,
        'revert: source workspace could not be started; continuing without archiving its transcript',
        { sessionId: srcSession.id },
      );
      if (srcEp?.runnerUrl) {
        await publishService
          .archiveSessionDeterministically(
            srcSession.id,
            srcEp.runnerUrl,
            srcSession.base_branch,
            srcSession.merged_sha,
            srcSession.pr_url,
          )
          .catch((err) => ignore(err, 'revert: archiving source session failed', { sessionId: srcSession.id }));
        srcArchive = db.getSessionArchive(srcSession.id);
      }
    }
    const parentArchive = srcSession?.parent_session_id
      ? db.getSessionArchive(srcSession.parent_session_id)
      : null;

    const id = randomUUID();
    const short = id.slice(0, 6);
    const baseTitle = body.title || srcSession?.title || `commit ${primarySha.slice(0, 7)}`;
    const title = `Undo: ${baseTitle}`;
    const slug = slugify(title);
    const rawToken = deriveWorkspaceToken(config.sessionSecret, id, 0);

    const revertSession = db.createSession({
      id,
      title,
      slug,
      kind: 'revert',
      parentSessionId: srcSession?.id ?? null,
      revertsSha: primarySha,
      revertReason: reason,
      ownerUserId: user.id,
      repo: config.repo,
      baseBranch: config.baseBranch,
      workingBranch: `halley/${slug}-${short}`,
      volumeName: `halley-ws-${id}`,
      workspaceTokenHash: hashWorkspaceToken(rawToken),
    });

    driver.setRawWorkspaceToken?.(id, rawToken);

    const pending: PendingRevert = { shas: targetShas, targetTitle: baseTitle, srcSessionId: srcSession?.id ?? null };
    // Durable marker first: if revert-start fails (or we die mid-call) the Undo draft is known to
    // be missing its revert, and the chat bridge retries or surfaces it.
    db.updateSession(revertSession.id, { revert_pending_json: JSON.stringify(pending), revert_start_error: null });
    const revertResult = await runRevertStart(db.getSession(revertSession.id) ?? revertSession, pending, {
      srcSession,
      srcArchive,
      parentArchive,
    });

    return c.json(
      {
        session: enrichSessionDto(db.getSession(revertSession.id)!, user),
        revertResult,
      },
      201,
    );
  });

  // Published History timeline: Halley publications + direct developer commits + PR reconciliation (Q20, P6)
  app.get('/api/history', auth.requireAuth, async (c) => {
    const allSessions = db.listSessions();
    // Start the (30s-cached) commit list now so it overlaps the local work below
    const ghCommitsPromise = github.listMainCommits(config.baseBranch, 25);

    // PRs merged manually on GitHub are reconciled by the maintenance pass (PublishService.reconcileManualMerges)
    const publishedSessions = allSessions.filter(
      (s) => s.status === 'published' || s.status === 'merged',
    );
    const revertedBySha = new Map<
      string,
      { sessionId: string; authorName: string; timestamp: string; reason: string | null }
    >();

    for (const s of publishedSessions) {
      if (s.kind === 'revert' && s.reverts_sha) {
        revertedBySha.set(s.reverts_sha, {
          sessionId: s.id,
          authorName: s.owner_name ?? 'Editor',
          timestamp: s.merged_at ?? s.archived_at ?? s.last_active_at,
          reason: s.revert_reason,
        });
      }
    }

    const entries: LiveHistoryEntryDto[] = [];
    const seenShas = new Set<string>();

    for (const s of publishedSessions) {
      const sha = s.merged_sha || s.id;
      if (s.merged_sha) seenShas.add(s.merged_sha);
      entries.push({
        id: `session-${s.id}`,
        source: 'halley',
        sha,
        shortSha: sha.slice(0, 7),
        title: s.title,
        authorName: s.owner_name ?? 'Editor',
        timestamp: s.merged_at ?? s.archived_at ?? s.last_active_at,
        prNumber: s.pr_number,
        prUrl: s.pr_url,
        sessionId: s.id,
        sessionKind: s.kind,
        parentSessionId: s.parent_session_id,
        revertsSha: s.reverts_sha,
        revertReason: s.revert_reason,
        revertedBy: s.merged_sha ? (revertedBySha.get(s.merged_sha) ?? null) : null,
        canUndo: Boolean(s.merged_sha),
        undoDisabledReason: s.merged_sha ? undefined : 'No merged commit SHA recorded',
        volumeExpired: Boolean(s.volume_expired_at),
      });
    }

    const ghCommits = await ghCommitsPromise;
    for (const cm of ghCommits) {
      if (seenShas.has(cm.sha)) continue;
      const isInfra = /^\s*(?:ci|build|chore|workflow)\b/i.test(cm.subject) && cm.subject.includes('.github');
      entries.push({
        id: `commit-${cm.sha}`,
        source: 'github',
        sha: cm.sha,
        shortSha: cm.shortSha,
        title: cm.subject,
        authorName: cm.author,
        timestamp: cm.date,
        revertedBy: revertedBySha.get(cm.sha) ?? null,
        canUndo: !isInfra,
        undoDisabledReason: isInfra ? 'Developer infrastructure update — revert on GitHub' : undefined,
      });
    }

    entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return c.json({ entries });
  });

  app.get('/api/sessions/:id/archive', auth.requireAuth, (c) => {
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    const archive = db.getSessionArchive(s.id);
    return c.json({ archive });
  });

  app.post('/api/sessions/:id/retry-deploy', auth.requireAuth, async (c) => {
    const user = c.get('user');
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    if (s.owner_user_id !== user.id && !user.isAdmin) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (s.status !== 'merged' || !s.merged_sha) {
      return c.json({ error: 'Session is not awaiting deploy verification' }, 409);
    }
    void publishService
      .retryDeployCheck(s)
      .catch((err) => logger.error('retry deploy check failed', { sessionId: s.id, err }));
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/takeover', auth.requireAdmin, async (c) => {
    const user = c.get('user');
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    db.updateSession(s.id, { owner_user_id: user.id });
    const updated = db.getSession(s.id)!;
    if (updated.runner_url && updated.status === 'running') {
      void runnerFetch(`${updated.runner_url}/internal/owner`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          editorName: user.name,
          editorEmail: user.email,
          persona: user.persona,
        }),
        signal: clock.timeoutSignal(5000),
      }).catch((err) => ignore(err, 'takeover: notifying runner of new owner failed', { sessionId: s.id }));
    }
    broadcastToSession(s.id, { type: 'session_meta_updated' });
    return c.json({ session: enrichSessionDto(updated, user) });
  });

  app.delete('/api/sessions/:id', auth.requireAuth, async (c) => {
    const user = c.get('user');
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    if (s.owner_user_id !== user.id && !user.isAdmin) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    try {
      await driver.destroy(s);
    } catch (err) {
      // Keep the row: deleting it would orphan a workspace volume nobody can find again.
      logger.error('deleting session: workspace destroy failed', { sessionId: s.id, err });
      return c.json(
        {
          error: `Could not delete the workspace: ${err instanceof Error ? err.message : String(err)}. Please try again.`,
        },
        502,
      );
    }
    db.deleteSession(s.id);
    for (const ws of browserWsBySession.get(s.id) ?? []) ws.close(1000, 'Session deleted');
    browserWsBySession.delete(s.id);
    return c.json({ ok: true });
  });
  return { resumePendingRevert };
}
