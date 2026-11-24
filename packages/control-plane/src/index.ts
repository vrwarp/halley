import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatServerMessage, LiveHistoryEntryDto, PublishProgressPayload, UserDto } from '@halley/shared';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { WebSocket, WebSocketServer } from 'ws';
import { AuthService } from './auth/google.js';
import { loadConfig, type HalleyConfig } from './config.js';
import { ControlPlaneDb } from './db.js';
import { DockerWorkspaceDriver } from './drivers/docker-driver.js';
import { LocalWorkspaceDriver } from './drivers/local-driver.js';
import { WorkspaceCrashLoopError, type WorkspaceDriver } from './drivers/workspace-driver.js';
import { GitHubService } from './github/client.js';
import { createLlmProxyHandler, hashWorkspaceToken } from './proxy/llm-proxy.js';
import { createPreviewProxy } from './proxy/preview-proxy.js';
import { startSessionReaper } from './reaper.js';
import { PublishService } from './routes/publish.js';
import { ScreenshotService, type ScreenshotViewport } from './screenshot-service.js';

type Env = {
  Variables: {
    user: UserDto;
  };
};

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'edit'
  );
}

export function createControlPlane(
  config: HalleyConfig,
  customDriver?: WorkspaceDriver,
  customScreenshotService?: ScreenshotService,
) {
  const db = new ControlPlaneDb(path.join(config.dataDir, 'control-plane.sqlite'), config);
  const auth = new AuthService(config, db);
  const github = new GitHubService(config);

  const driver: WorkspaceDriver =
    customDriver ??
    (config.workspaceDriver === 'local'
      ? new LocalWorkspaceDriver(config, db, github)
      : new DockerWorkspaceDriver(config, db, github));

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
    bootProgress: driver.getBootProgress?.(s.id) ?? null,
  });

  const publishService = new PublishService(
    config,
    db,
    driver,
    github,
    (sessionId, payload: PublishProgressPayload) => {
      broadcastToSession(sessionId, { type: 'publish_state', payload });
    },
  );

  const screenshotService =
    customScreenshotService ??
    new ScreenshotService({
      idleTimeoutMs: config.browserIdleTimeoutMs,
    });

  const app = new Hono<Env>();

  // Health & Doctor preflight diagnostics
  app.get('/api/health', (c) =>
    c.json({ ok: true, repo: config.repo, baseBranch: config.baseBranch }),
  );

  app.get('/api/health/doctor', async (c) => {
    if ('runDoctorChecks' in driver && typeof driver.runDoctorChecks === 'function') {
      const report = await (driver as DockerWorkspaceDriver).runDoctorChecks();
      return c.json(report, report.ok ? 200 : 503);
    }
    return c.json({
      ok: true,
      warnings: [],
      errors: [],
      details: { workspaceDriver: config.workspaceDriver, dataDir: config.dataDir },
    });
  });

  // LLM Proxy (authenticated via WORKSPACE_TOKEN, no user cookie)
  app.all(
    '/internal/llm/anthropic/*',
    createLlmProxyHandler(config, db, (userId, sessionId) => {
      const spend = db.getSpendStatus(userId);
      broadcastToSession(sessionId, { type: 'spend_status', ...spend });
    }),
  );

  // Shared Headless Chromium Screenshot Service (authenticated via WORKSPACE_TOKEN)
  app.post('/internal/screenshot', async (c) => {
    const authHeader = c.req.header('authorization') || '';
    const rawToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!rawToken) {
      return c.json({ error: 'Missing workspace token' }, 401);
    }

    const session = db.getSessionByTokenHash(hashWorkspaceToken(rawToken));
    if (!session) {
      return c.json({ error: 'Invalid workspace token' }, 401);
    }

    db.updateSession(session.id, { last_active_at: new Date().toISOString() });

    let astroUrl = session.astro_url;
    let originalBase = session.astro_base || '/';
    if (!astroUrl) {
      try {
        const ep = await driver.ensureRunning(session);
        astroUrl = ep.astroUrl;
        originalBase = ep.astroBase || '/';
      } catch {
        return c.json({ error: 'Workspace preview server is not running' }, 503);
      }
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      route?: unknown;
      viewport?: unknown;
      fullPage?: unknown;
    };
    const rawRoute = typeof body.route === 'string' ? body.route.trim() : '/';
    const viewport: ScreenshotViewport = body.viewport === 'mobile' ? 'mobile' : 'desktop';
    const fullPage = body.fullPage === true;
    let cleanRoute = rawRoute.startsWith('/') ? rawRoute : `/${rawRoute}`;

    const astroOrigin = new URL(astroUrl);
    const baseSuffix = originalBase === '/' ? '' : originalBase.replace(/\/$/, '');
    if (baseSuffix && (cleanRoute === baseSuffix || cleanRoute.startsWith(`${baseSuffix}/`))) {
      cleanRoute = cleanRoute.slice(baseSuffix.length) || '/';
    }

    const sessionPrefix = `/p/${session.id}`;
    const previewPath = `${sessionPrefix}${baseSuffix}${cleanRoute}`;
    const targetUrl = new URL(previewPath, astroOrigin);
    if (
      targetUrl.origin !== astroOrigin.origin ||
      (targetUrl.pathname !== sessionPrefix && !targetUrl.pathname.startsWith(`${sessionPrefix}/`))
    ) {
      return c.json({ error: 'Invalid route' }, 400);
    }

    try {
      const result = await screenshotService.capture({
        url: targetUrl.toString(),
        viewport,
        fullPage,
      });
      return new Response(new Uint8Array(result.data), {
        status: 200,
        headers: {
          'Content-Type': result.mimeType,
          'X-Screenshot-Width': String(result.width),
          'X-Screenshot-Height': String(result.height),
        },
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Screenshot capture failed' },
        500,
      );
    }
  });

  // Auth routes
  app.get('/api/auth/me', (c) => {
    const user = auth.getUserFromContext(c);
    if (!user) {
      return c.json({
        authenticated: false,
        devLoginEnabled: config.devLoginEnabled,
        googleEnabled: Boolean(config.googleClientId && config.googleClientSecret),
        repo: config.repo,
      });
    }
    return c.json({
      authenticated: true,
      user,
      spend: db.getSpendStatus(user.id),
      repo: config.repo,
      baseBranch: config.baseBranch,
    });
  });

  app.get('/api/auth/google', (c) => {
    if (!config.googleClientId || !config.googleClientSecret) {
      return c.text('Google OAuth is not configured', 500);
    }
    return c.redirect(auth.buildGoogleAuthUrl(c));
  });

  app.get('/api/auth/google/callback', async (c) => {
    const code = c.req.query('code') || '';
    const state = c.req.query('state') || '';
    const err = c.req.query('error');
    if (err || !code || !state) {
      return c.redirect('/?authError=cancelled');
    }
    const result = await auth.handleGoogleCallback(c, code, state);
    if (!result.ok) {
      if (result.reason === 'not_allowed') {
        return c.redirect(`/?authError=not_allowed&email=${encodeURIComponent(result.email || '')}`);
      }
      return c.redirect(`/?authError=${encodeURIComponent(result.reason)}`);
    }
    return c.redirect('/');
  });

  app.post('/api/auth/dev-login', async (c) => {
    if (!config.devLoginEnabled) {
      return c.json({ error: 'Dev login is disabled' }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      email?: string;
      name?: string;
    };
    const email = (body.email || config.adminEmails[0] || 'dev@example.com').toLowerCase();
    if (!db.isEmailAllowed(email)) {
      db.addAllowlist('email', email, 'dev-login');
    }
    const user = db.upsertUser({
      email,
      name: body.name || 'Dev Editor',
      picture: null,
    });
    auth.issueSessionCookie(c, user.id);
    return c.json({ user, spend: db.getSpendStatus(user.id) });
  });

  app.post('/api/auth/logout', (c) => {
    auth.clearSessionCookie(c);
    return c.json({ ok: true });
  });

  app.patch('/api/auth/preferences', auth.requireAuth, async (c) => {
    const user = c.get('user');
    const body = (await c.req.json()) as { persona?: 'non-technical' | 'developer' };
    const persona = body.persona === 'developer' ? 'developer' : 'non-technical';
    db.setUserPersona(user.id, persona);
    // Notify any running sessions owned by this user
    for (const s of db.listSessions()) {
      if (s.owner_user_id === user.id && s.status === 'running' && s.runner_url) {
        void fetch(`${s.runner_url}/internal/persona`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ persona }),
        }).catch(() => {});
      }
    }
    return c.json({ user: db.getUserById(user.id) });
  });

  // Sessions
  app.get('/api/sessions', auth.requireAuth, (c) => {
    const user = c.get('user');
    const sessions = db.listSessions().map((s) => enrichSessionDto(s, user));
    return c.json({ sessions, spend: db.getSpendStatus(user.id) });
  });

  app.post('/api/sessions', auth.requireAuth, async (c) => {
    const user = c.get('user');
    const body = (await c.req.json()) as { title?: string };
    const title = (body.title || 'Website update').trim();
    const warm = driver.reserveWarmWorkspace?.() ?? null;
    const id = warm ? warm.id : crypto.randomUUID();
    const short = id.slice(0, 6);
    const slug = slugify(title);
    const workingBranch = `halley/${slug}-${short}`;
    const rawToken = warm ? warm.rawToken : crypto.randomBytes(24).toString('hex');
    const volumeName = warm ? warm.volumeName : `halley-ws-${id}`;

    const session = db.createSession({
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

    driver.setRawWorkspaceToken?.(id, rawToken);

    // Start booting (or claiming warm standby) workspace asynchronously so the UI opens immediately
    void driver.ensureRunning(session).catch((err) => {
      db.updateSession(id, { status: 'error', publish_error: String(err) });
    });

    return c.json({ session: enrichSessionDto(session, user) }, 201);
  });

  app.get('/api/sessions/:id', auth.requireAuth, (c) => {
    const user = c.get('user');
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    return c.json({ session: enrichSessionDto(s, user), spend: db.getSpendStatus(user.id) });
  });

  app.post('/api/sessions/:id/wake', auth.requireAuth, async (c) => {
    const user = c.get('user');
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);

    if (s.status === 'sleeping' || s.status === 'error') {
      db.updateSession(s.id, { status: 'starting', publish_error: null });
    }
    const updated = db.getSession(s.id)!;
    void driver.ensureRunning(updated).catch((err) => {
      db.updateSession(s.id, { status: 'error', publish_error: String(err) });
    });
    return c.json({ session: enrichSessionDto(updated, user) });
  });

  app.post('/api/sessions/:id/restart', auth.requireAuth, async (c) => {
    const user = c.get('user');
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    if (s.owner_user_id !== user.id && !user.isAdmin) {
      return c.json({ error: 'Only the session owner or an admin can restart this workspace.' }, 403);
    }

    db.updateSession(s.id, { status: 'starting', publish_error: null, runner_url: null, astro_url: null });
    const updated = db.getSession(s.id)!;
    const starter = driver.restart
      ? driver.restart(updated)
      : driver.stop(updated).then(() => driver.ensureRunning(updated));
    void starter.catch((err) => {
      db.updateSession(s.id, { status: 'error', publish_error: String(err) });
    });
    return c.json({ session: enrichSessionDto(updated, user) });
  });

  const buildDeterministicHandoffSummary = (
    src: ReturnType<ControlPlaneDb['getSession']> & object,
    archive: ReturnType<ControlPlaneDb['getSessionArchive']>,
    priorHandoff?: string | null,
  ): string => {
    const lines: string[] = [];
    if (priorHandoff) {
      lines.push(`Earlier lineage summary: ${priorHandoff.slice(0, 600)}`);
    }
    const statusLabel =
      src.status === 'published'
        ? `published${src.pr_number ? ` as PR #${src.pr_number}` : ''}`
        : src.status === 'merged'
          ? `merged${src.pr_number ? ` as PR #${src.pr_number}` : ''}`
          : 'in-progress draft';
    lines.push(
      `This session continues "${src.title}" (${statusLabel}, edited by ${src.owner_name || 'a teammate'}).`,
    );
    if (src.status === 'published' || src.status === 'merged') {
      lines.push('Those published changes are already live on the main branch.');
    }
    if (archive?.diffSummary && archive.diffSummary !== '[]') {
      try {
        const diffs = JSON.parse(archive.diffSummary) as Array<{ path: string; status: string }>;
        if (diffs.length > 0) {
          lines.push(
            `Files touched previously: ${diffs.map((d) => `${d.path} (${d.status})`).slice(0, 12).join(', ')}.`,
          );
        }
      } catch {
        // ignore
      }
    }
    if (archive?.transcriptJson) {
      try {
        const t = JSON.parse(archive.transcriptJson) as {
          entries?: Array<{ role: string; text?: string; attachments?: Array<{ stagedId: string; filename: string }> }>;
        };
        const userPrompts = (t.entries ?? [])
          .filter((e) => e.role === 'user' && e.text)
          .slice(-6)
          .map((e) => e.text!.replace(/\s+/g, ' ').trim().slice(0, 180));
        if (userPrompts.length > 0) {
          lines.push(`Recent requests from the prior thread:\n- ${userPrompts.join('\n- ')}`);
        }
        const uploads = (t.entries ?? [])
          .flatMap((e) => e.attachments ?? [])
          .slice(-10)
          .map((a) => `${a.filename} (stagedId=${a.stagedId})`);
        if (uploads.length > 0 && src.status !== 'published' && src.status !== 'merged') {
          lines.push(`Staged uploads carried over: ${uploads.join(', ')}.`);
        }
      } catch {
        // ignore
      }
    }
    return lines.join('\n');
  };

  app.post('/api/sessions/:id/duplicate', auth.requireAuth, async (c) => {
    const user = c.get('user');
    const src = db.getSession(c.req.param('id')!);
    if (!src) return c.json({ error: 'Not found' }, 404);

    // Ensure source transcript is captured in session_archives for unified Hybrid carry-over (Q18, Q19)
    let srcArchive = db.getSessionArchive(src.id);
    if (!srcArchive && src.runner_url) {
      await publishService
        .archiveSessionDeterministically(
          src.id,
          src.runner_url,
          src.base_branch,
          src.merged_sha,
          src.pr_url,
        )
        .catch(() => {});
      srcArchive = db.getSessionArchive(src.id);
    }

    const parentArchive = src.parent_session_id ? db.getSessionArchive(src.parent_session_id) : null;
    let handoffSummary = srcArchive?.handoffSummary ?? null;
    if (!handoffSummary) {
      handoffSummary = buildDeterministicHandoffSummary(src, srcArchive, parentArchive?.handoffSummary);
      if (srcArchive) {
        db.setArchiveHandoffSummary(src.id, handoffSummary);
      }
    }

    const isFinished = src.status === 'published' || src.status === 'merged';
    const mode = isFinished ? 'fresh-from-main' : 'branch-off';
    const kind = isFinished ? 'continuation' : 'edit';
    const id = crypto.randomUUID();
    const short = id.slice(0, 6);
    const title = isFinished ? `Continued: ${src.title}` : `${src.title} (Copy)`;
    const slug = slugify(title);
    const rawToken = crypto.randomBytes(24).toString('hex');

    const copy = db.createSession({
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

    driver.setRawWorkspaceToken?.(id, rawToken);

    await driver.duplicateWorkspace(src, copy, mode);
    void driver
      .ensureRunning(copy)
      .then(async (ep) => {
        if (handoffSummary) {
          await fetch(`${ep.runnerUrl}/internal/context-note`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note: handoffSummary, persist: true }),
          }).catch(() => {});
        }
      })
      .catch(() => {});

    return c.json({ session: enrichSessionDto(copy, user) }, 201);
  });

  // Journey A: Any editor can undo a Halley publication or non-.github/** main commit (Q1, Q5, Q17)
  app.post('/api/sessions/revert', auth.requireAuth, async (c) => {
    const user = c.get('user');
    const body = (await c.req.json().catch(() => ({}))) as {
      sessionId?: string;
      sha?: string;
      shas?: string[];
      reason?: string;
      title?: string;
    };
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
    // In-flight publish lock only (idle/abandoned revert drafts never block teammates)
    const inFlight = db.hasInFlightRevertForSha(primarySha);
    if (inFlight) {
      return c.json(
        {
          error: `${inFlight.owner_name || 'A teammate'} is already publishing an undo for this change.`,
          inFlightSessionId: inFlight.id,
        },
        409,
      );
    }

    // Block undoing developer commits that touch protected .github/** files
    if (!srcSession) {
      const files = await github.getCommitFiles(primarySha);
      if (files.some((f) => f.startsWith('.github/'))) {
        return c.json(
          { error: 'Developer infrastructure update (.github/**) — revert directly on GitHub.' },
          403,
        );
      }
    }

    const id = crypto.randomUUID();
    const short = id.slice(0, 6);
    const baseTitle = body.title || srcSession?.title || `commit ${primarySha.slice(0, 7)}`;
    const title = `Undo: ${baseTitle}`;
    const slug = slugify(title);
    const rawToken = crypto.randomBytes(24).toString('hex');

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

    let revertResult: Record<string, unknown> | null = null;
    try {
      const ep = await driver.ensureRunning(revertSession);
      const res = await fetch(`${ep.runnerUrl}/internal/git/revert-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shas: targetShas }),
      });
      revertResult = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    } catch {
      // Workspace may still be booting; UI can retry
    }

    return c.json(
      {
        session: db.toSessionDto(db.getSession(revertSession.id)!, user),
        revertResult,
      },
      201,
    );
  });

  // Published History timeline: Halley publications + direct developer commits + PR reconciliation (Q20, P6)
  app.get('/api/history', auth.requireAuth, async (c) => {
    const allSessions = db.listSessions();

    // Best-effort reconciliation of open Halley PRs that were merged/closed manually on GitHub (P6)
    const openPrSessions = allSessions.filter(
      (s) => s.pr_number && s.status !== 'published' && s.status !== 'merged',
    );
    for (const s of openPrSessions.slice(0, 5)) {
      try {
        const prState = await github.getPrState(s.pr_number!);
        if (prState.merged && prState.mergeCommitSha) {
          db.updateSession(s.id, {
            status: 'published',
            publish_state: 'published',
            merged_sha: prState.mergeCommitSha,
            merged_at: s.merged_at ?? new Date().toISOString(),
            archived_at: s.archived_at ?? new Date().toISOString(),
          });
        }
      } catch {
        // GitHub unavailable in dev/offline mode
      }
    }

    const refreshed = db.listSessions();
    const publishedSessions = refreshed.filter(
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

    const ghCommits = await github.listMainCommits(config.baseBranch, 25);
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
    void publishService.retryDeployCheck(s).catch(() => {});
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/takeover', auth.requireAdmin, async (c) => {
    const user = c.get('user');
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    db.updateSession(s.id, { owner_user_id: user.id });
    return c.json({ session: db.toSessionDto(db.getSession(s.id)!, user) });
  });

  app.delete('/api/sessions/:id', auth.requireAuth, async (c) => {
    const user = c.get('user');
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    if (s.owner_user_id !== user.id && !user.isAdmin) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    await driver.destroy(s);
    db.deleteSession(s.id);
    return c.json({ ok: true });
  });

  // Workspace git, undo, verify, uploads, publish
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

  app.get('/api/sessions/:id/routes', auth.requireAuth, async (c) => {
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    const ep = await driver.ensureRunning(s);
    const res = await fetch(`${ep.runnerUrl}/internal/routes`);
    return c.json(await res.json(), res.status as 200);
  });

  app.get('/api/sessions/:id/page-options', auth.requireAuth, async (c) => {
    const user = c.get('user');
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    const spend = db.getSpendStatus(user.id);
    const ep = await driver.ensureRunning(s);
    const res = await fetch(
      `${ep.runnerUrl}/internal/page-options?capped=${spend.capped ? 'true' : 'false'}`,
    );
    return c.json(await res.json(), res.status as 200);
  });

  app.post('/api/sessions/:id/pages', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const spend = db.getSpendStatus(check.user.id);
    const ep = await driver.ensureRunning(check.session);
    const body = (await c.req.json()) as Record<string, unknown>;
    const res = await fetch(`${ep.runnerUrl}/internal/pages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, capped: spend.capped }),
    });
    const data = (await res.json()) as { changedFilesCount?: number };
    if (res.ok && typeof data.changedFilesCount === 'number') {
      db.updateSession(check.session.id, { changed_files_count: data.changedFilesCount });
    }
    return c.json(data, res.status as 200);
  });

  app.post('/api/sessions/:id/pages/:pageRequestId/retry', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const spend = db.getSpendStatus(check.user.id);
    const ep = await driver.ensureRunning(check.session);
    const pageRequestId = c.req.param('pageRequestId')!;
    const reqBody = (await c.req.json().catch(() => ({}))) as { viewport?: string };
    const res = await fetch(
      `${ep.runnerUrl}/internal/pages/${encodeURIComponent(pageRequestId)}/retry`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capped: spend.capped, viewport: reqBody.viewport }),
      },
    );
    return c.json(await res.json(), res.status as 200);
  });

  app.delete('/api/sessions/:id/pages', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const ep = await driver.ensureRunning(check.session);
    const route = c.req.query('route') || '';
    const res = await fetch(
      `${ep.runnerUrl}/internal/pages?route=${encodeURIComponent(route)}`,
      { method: 'DELETE' },
    );
    return c.json(await res.json(), res.status as 200);
  });

  app.post('/api/sessions/:id/pages/visibility', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const spend = db.getSpendStatus(check.user.id);
    const ep = await driver.ensureRunning(check.session);
    const body = (await c.req.json()) as Record<string, unknown>;
    const res = await fetch(`${ep.runnerUrl}/internal/pages/visibility`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, capped: spend.capped }),
    });
    const data = (await res.json()) as { changedFilesCount?: number };
    if (res.ok && typeof data.changedFilesCount === 'number') {
      db.updateSession(check.session.id, { changed_files_count: data.changedFilesCount });
    }
    return c.json(data, res.status as 200);
  });

  app.post('/api/sessions/:id/pages/rename', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const ep = await driver.ensureRunning(check.session);
    const body = await c.req.json();
    const res = await fetch(`${ep.runnerUrl}/internal/pages/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { changedFilesCount?: number };
    if (res.ok && typeof data.changedFilesCount === 'number') {
      db.updateSession(check.session.id, { changed_files_count: data.changedFilesCount });
    }
    return c.json(data, res.status as 200);
  });

  app.get('/api/sessions/:id/changes', auth.requireAuth, async (c) => {
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    const ep = await driver.ensureRunning(s);
    const res = await fetch(
      `${ep.runnerUrl}/internal/git/changes?baseRef=${encodeURIComponent(`origin/${s.base_branch}`)}`,
    );
    const data = (await res.json()) as { changes?: unknown[]; checkpoints?: unknown[] };
    db.updateSession(s.id, { changed_files_count: data.changes?.length ?? 0 });
    return c.json(data);
  });

  app.post('/api/sessions/:id/revert-file', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const ep = await driver.ensureRunning(check.session);
    const body = await c.req.json();
    const res = await fetch(`${ep.runnerUrl}/internal/git/revert-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, baseRef: `origin/${check.session.base_branch}` }),
    });
    return c.json(await res.json(), res.status as 200);
  });

  app.post('/api/sessions/:id/undo', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const ep = await driver.ensureRunning(check.session);
    const body = await c.req.json();
    const res = await fetch(`${ep.runnerUrl}/internal/git/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return c.json(await res.json(), res.status as 200);
  });

  app.post('/api/sessions/:id/verify', auth.requireAuth, async (c) => {
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    const ep = await driver.ensureRunning(s);
    const res = await fetch(`${ep.runnerUrl}/internal/verify`, { method: 'POST' });
    return c.json(await res.json(), res.status as 200);
  });

  app.post('/api/sessions/:id/uploads', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const ep = await driver.ensureRunning(check.session);
    const formData = await c.req.formData();
    const res = await fetch(`${ep.runnerUrl}/internal/uploads`, {
      method: 'POST',
      body: formData,
    });
    return c.json(await res.json(), res.status as 200);
  });

  app.post('/api/sessions/:id/sync', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const body = (await c.req.json().catch(() => ({}))) as {
      kind?: 'sync' | 'publish' | 'revert';
      autoSyncOnly?: boolean;
    };
    const ep = await driver.ensureRunning(check.session);
    const ghToken = await github.getAccessToken().catch(() => '');
    if (ghToken) {
      await driver.fetchIntoSession(check.session, ghToken).catch(() => {});
    }
    const res = await fetch(`${ep.runnerUrl}/internal/sync/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseBranch: check.session.base_branch,
        kind: body.kind ?? 'sync',
        autoSyncOnly: body.autoSyncOnly,
        skipFetch: Boolean(ghToken),
      }),
    });
    const data = (await res.json().catch(() => ({ error: 'Sync failed' }))) as {
      review?: { newBaseSha?: string; prevBaseSha?: string; status?: string };
      error?: string;
    };
    if (data.review?.newBaseSha && data.review.status !== 'needs_choices') {
      db.updateSession(check.session.id, {
        prev_base_sha: data.review.prevBaseSha ?? (check.session.base_sha || null),
        base_sha: data.review.newBaseSha,
        last_active_at: new Date().toISOString(),
      });
    }
    return c.json(data, res.status as 200);
  });

  app.post('/api/sessions/:id/sync/choose', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const body = await c.req.json();
    const ep = await driver.ensureRunning(check.session);
    const res = await fetch(`${ep.runnerUrl}/internal/sync/choose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({ error: 'Choice failed' }))) as {
      review?: { newBaseSha?: string; prevBaseSha?: string; status?: string };
    };
    if (data.review?.newBaseSha && data.review.status === 'ready_for_review') {
      db.updateSession(check.session.id, {
        prev_base_sha: data.review.prevBaseSha ?? (check.session.base_sha || null),
        base_sha: data.review.newBaseSha,
      });
    }
    return c.json(data, res.status as 200);
  });

  app.post('/api/sessions/:id/sync/undo', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const body = await c.req.json().catch(() => ({}));
    const ep = await driver.ensureRunning(check.session);
    const res = await fetch(`${ep.runnerUrl}/internal/sync/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok && check.session.prev_base_sha) {
      db.updateSession(check.session.id, { base_sha: check.session.prev_base_sha });
    }
    return c.json(await res.json().catch(() => ({ ok: res.ok })), res.status as 200);
  });

  app.post('/api/sessions/:id/sync/estimate-escalation', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const body = (await c.req.json().catch(() => ({}))) as {
      recordIds?: string[];
      userNote?: string;
    };
    const spend = db.getSpendStatus(check.user.id);
    const remainingBudgetUsd = Math.max(
      0,
      spend.dailyCapUsd + spend.extraGrantedUsd - spend.spentTodayUsd,
    );
    const ep = await driver.ensureRunning(check.session);
    const res = await fetch(`${ep.runnerUrl}/internal/sync/estimate-escalation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recordIds: body.recordIds,
        userNote: body.userNote,
        remainingBudgetUsd,
        escalationModelId: config.escalationModelId,
        hardCeilingUsd: config.escalationMaxUsd,
      }),
    });
    return c.json(await res.json().catch(() => ({ error: 'Estimate failed' })), res.status as 200);
  });

  app.post('/api/sessions/:id/sync/escalate', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const body = (await c.req.json().catch(() => ({}))) as {
      recordIds?: string[];
      userNote?: string;
      ceilingUsd?: number;
    };
    const ep = await driver.ensureRunning(check.session);
    const res = await fetch(`${ep.runnerUrl}/internal/sync/escalate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recordIds: body.recordIds,
        userNote: body.userNote,
        escalationModelId: config.escalationModelId,
        escalationThinking: config.escalationThinkingLevel,
        ceilingUsd: Math.min(body.ceilingUsd ?? config.escalationMaxUsd, config.escalationMaxUsd),
      }),
    });
    return c.json(await res.json().catch(() => ({ error: 'Escalation failed' })), res.status as 200);
  });

  app.post('/api/sessions/:id/sync/apply-advanced', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const body = await c.req.json();
    const ep = await driver.ensureRunning(check.session);
    const res = await fetch(`${ep.runnerUrl}/internal/sync/apply-advanced`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return c.json(await res.json().catch(() => ({ error: 'Apply failed' })), res.status as 200);
  });

  app.get('/api/sessions/:id/review', auth.requireAuth, async (c) => {
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    const ep = await driver.ensureRunning(s);
    const includeScreenshots = c.req.query('screenshots') === '1';
    const rawViewport = c.req.query('viewport');
    const screenshotViewport: ScreenshotViewport = rawViewport === 'mobile' ? 'mobile' : 'desktop';
    const qs = new URLSearchParams({
      baseRef: `origin/${s.base_branch}`,
    });
    const res = await fetch(`${ep.runnerUrl}/internal/review?${qs.toString()}`);
    const data = (await res
      .json()
      .catch(() => ({ cards: [], pages: [], mergeReview: null }))) as {
      cards: Array<{ route?: string }>;
      pages: unknown[];
      draftFiles?: string[];
      mergedFromLiveFiles?: string[];
      astroReady?: boolean;
      previewBase?: string;
      liveSiteUrl?: string | null;
      mergeReview: unknown;
      baseSha?: string;
      prevBaseSha?: string | null;
    };

    if (includeScreenshots && res.ok && data.astroReady !== false && ep.astroUrl) {
      const baseSuffix = ep.astroBase === '/' ? '' : ep.astroBase.replace(/\/$/, '');
      const previewBase = data.previewBase || `/p/${s.id}${baseSuffix}`;
      const draftBaseUrl = `${ep.astroUrl.replace(/\/$/, '')}${previewBase}`;
      const routes = [
        ...data.cards.map((card) => card.route || '/'),
        ...(data.cards.length === 0 ? ['/'] : []),
      ];
      const envLive = config.liveSiteUrl;
      const liveBaseUrl =
        envLive.toLowerCase() === 'none' || envLive.toLowerCase() === 'off'
          ? null
          : envLive || data.liveSiteUrl || null;
      data.pages = await screenshotService
        .captureLiveVsDraftPages({
          routes,
          draftFiles: data.draftFiles ?? [],
          mergedFromLiveFiles: data.mergedFromLiveFiles ?? [],
          draftBaseUrl,
          liveBaseUrl,
          viewport: screenshotViewport,
          liveTimestamp: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        })
        .catch(() => []);
    }

    return c.json(data, res.ok ? 200 : 502);
  });

  app.get('/api/sessions/:id/upstream-status', auth.requireAuth, async (c) => {
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    const ghCommits = await github.listMainCommits(s.base_branch, 10);
    const latestMainSha = ghCommits[0]?.sha ?? '';
    const behind = Boolean(latestMainSha && s.base_sha && latestMainSha !== s.base_sha);
    const newerCommits = behind
      ? ghCommits.slice(
          0,
          Math.max(
            1,
            ghCommits.findIndex((cm) => cm.sha === s.base_sha) === -1
              ? ghCommits.length
              : ghCommits.findIndex((cm) => cm.sha === s.base_sha),
          ),
        )
      : [];

    // Warn early if teammates have other active drafts with edits
    const coEditors = db
      .listSessions()
      .filter(
        (other) =>
          other.id !== s.id &&
          other.status !== 'published' &&
          other.status !== 'merged' &&
          !other.volume_expired_at &&
          other.changed_files_count > 0,
      )
      .map((other) => ({
        sessionId: other.id,
        title: other.title,
        ownerName: other.owner_name ?? 'A teammate',
        changedFilesCount: other.changed_files_count,
      }));

    return c.json({
      behind,
      latestMainSha,
      newerCommits,
      coEditors,
    });
  });

  app.post('/api/sessions/:id/publish', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const body = (await c.req.json().catch(() => ({}))) as { title?: string; summary?: string };

    // Run publish pipeline in background so UI streams live progress over WS
    void publishService.publish(check.session, check.user, body);
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/prompt', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const body = await c.req.json();
    const ep = await driver.ensureRunning(check.session);
    db.updateSession(check.session.id, { last_active_at: new Date().toISOString() });
    const res = await fetch(`${ep.runnerUrl}/internal/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({ ok: res.ok }));
    return c.json(data, res.ok ? 200 : 400);
  });

  app.get('/api/sessions/:id/transcript', auth.requireAuth, async (c) => {
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    const parentSession = s.parent_session_id ? db.getSession(s.parent_session_id) : null;
    const parentArchive = s.parent_session_id ? db.getSessionArchive(s.parent_session_id) : null;
    const priorThread =
      parentSession && parentArchive
        ? {
            parentSessionId: parentSession.id,
            parentTitle: parentSession.title,
            parentStatus: parentSession.status,
            parentPublishedAt: parentSession.merged_at ?? parentSession.archived_at ?? parentSession.last_active_at,
            entries: (() => {
              try {
                const parsed = JSON.parse(parentArchive.transcriptJson) as { entries?: unknown[] };
                return parsed.entries ?? [];
              } catch {
                return [];
              }
            })(),
          }
        : null;

    // If volume expired (>420d), serve archived transcript from DB without waking a deleted volume
    if (s.volume_expired_at) {
      const ownArchive = db.getSessionArchive(s.id);
      if (ownArchive) {
        try {
          const parsed = JSON.parse(ownArchive.transcriptJson) as Record<string, unknown>;
          return c.json({ ...parsed, volumeExpired: true, priorThread });
        } catch {
          // fall through
        }
      }
      return c.json({
        entries: [],
        live: { busy: false, streamingText: '', activeTools: [], queuedCount: 0 },
        usageUsd: 0,
        volumeExpired: true,
        priorThread,
      });
    }

    if (!s.runner_url || (s.status !== 'running' && s.status !== 'published' && s.status !== 'merged')) {
      const ownArchive = db.getSessionArchive(s.id);
      if (ownArchive) {
        try {
          const parsed = JSON.parse(ownArchive.transcriptJson) as Record<string, unknown>;
          return c.json({ ...parsed, priorThread });
        } catch {
          // fall through
        }
      }
      return c.json(
        {
          error: 'Workspace is not running',
          status: s.status,
          bootProgress: driver.getBootProgress?.(s.id) ?? null,
          priorThread,
        },
        503,
      );
    }

    try {
      const res = await fetch(`${s.runner_url}/internal/transcript`, {
        signal: AbortSignal.timeout(4000),
      });
      const data = (await res
        .json()
        .catch(() => ({ entries: [], live: { busy: false, streamingText: '', activeTools: [], queuedCount: 0 } }))) as Record<
        string,
        unknown
      >;
      return c.json({ ...data, priorThread }, res.ok ? 200 : 502);
    } catch {
      return c.json(
        {
          error: 'Workspace is not reachable',
          status: s.status,
          bootProgress: driver.getBootProgress?.(s.id) ?? null,
          priorThread,
        },
        503,
      );
    }
  });

  app.get('/api/sessions/:id/debug-trace', auth.requireAuth, async (c) => {
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    try {
      const ep = await driver.ensureRunning(s);
      const res = await fetch(`${ep.runnerUrl}/internal/debug/trace`);
      const data = await res.json().catch(() => ({ error: 'Invalid debug trace response' }));
      return c.json(data, res.ok ? 200 : 502);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Workspace is not running' },
        503,
      );
    }
  });

  app.post('/api/sessions/:id/fix-with-pi', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const body = (await c.req.json()) as { errorSummary: string; logs?: string };
    const ep = await driver.ensureRunning(check.session);
    const promptText = [
      `Publishing failed with the following issue:`,
      body.errorSummary,
      body.logs ? `\nLogs:\n\`\`\`\n${body.logs.slice(0, 3500)}\n\`\`\`` : '',
      `\nPlease inspect the issue, fix it in the codebase, run \`run_checks\` to confirm everything passes, and summarize what you fixed.`,
    ].join('\n');

    await fetch(`${ep.runnerUrl}/internal/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'submit_input',
        requestId: `fix-${Date.now()}`,
        text: promptText,
        contextChips: [],
        attachments: [],
      }),
    });
    db.updateSession(check.session.id, { publish_state: 'idle', publish_error: null });
    return c.json({ ok: true });
  });

  // Admin routes
  app.get('/api/admin/overview', auth.requireAdmin, (c) => {
    return c.json({
      allowlist: db.listAllowlist(),
      users: db.listUsers(),
      dailyCapUsd: db.getDailyCapUsd(),
      todaySpend: db.listTodaySpendByUser(),
      spendByPurpose: db.listTodaySpendByPurpose(),
      sessions: db.listSessions().map((s) => db.toSessionDto(s, c.get('user'))),
    });
  });

  app.post('/api/admin/allowlist', auth.requireAdmin, async (c) => {
    const body = (await c.req.json()) as { kind: 'email' | 'domain'; value: string };
    const entry = db.addAllowlist(body.kind, body.value, c.get('user').email);
    return c.json({ entry }, 201);
  });

  app.delete('/api/admin/allowlist/:id', auth.requireAdmin, (c) => {
    db.removeAllowlist(c.req.param('id')!);
    return c.json({ ok: true });
  });

  app.post('/api/admin/cap', auth.requireAdmin, async (c) => {
    const body = (await c.req.json()) as { dailyCapUsd: number };
    db.setDailyCapUsd(Number(body.dailyCapUsd));
    return c.json({ dailyCapUsd: db.getDailyCapUsd() });
  });

  app.post('/api/admin/users/:id/grant-extra', auth.requireAdmin, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { extraUsd?: number };
    db.grantExtraSpend(c.req.param('id')!, Number(body.extraUsd ?? 10));
    return c.json({ ok: true });
  });

  app.post('/api/admin/users/:id/admin', auth.requireAdmin, async (c) => {
    const body = (await c.req.json()) as { isAdmin: boolean };
    db.setUserAdmin(c.req.param('id')!, Boolean(body.isAdmin));
    return c.json({ ok: true });
  });

  app.post('/api/admin/sessions/:id/sleep', auth.requireAdmin, async (c) => {
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    await driver.stop(s);
    return c.json({ ok: true });
  });

  // Preview Proxy (/p/:sessionId/*) + Referer-scoped Vite dev module proxy (/@vite/*, /@fs/*, /src/*, /node_modules/*)
  const previewProxy = createPreviewProxy(auth, db, driver);
  app.all('/p/:sessionId/*', previewProxy.handleHttp);
  app.all('/p/:sessionId', previewProxy.handleHttp);

  app.all('*', async (c, next) => {
    const p = c.req.path;
    if (
      p.startsWith('/@vite/') ||
      p.startsWith('/@fs/') ||
      p.startsWith('/@id/') ||
      p.startsWith('/__astro') ||
      p.startsWith('/src/') ||
      p.startsWith('/node_modules/')
    ) {
      const ref = c.req.header('referer') || '';
      const m = ref.match(/\/p\/([0-9a-f-]{20,})\b/i);
      if (m?.[1]) {
        return previewProxy.handleHttpForSession(c, m[1]);
      }
    }
    return next();
  });

  // Serve built React Web UI in production
  const webRoot = config.webDistDir;
  app.use('/*', serveStatic({ root: webRoot }));
  app.get('*', async (c, next) => {
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/p/') || c.req.path.startsWith('/internal/')) {
      return next();
    }
    // Never return index.html with text/html for missing static asset extensions
    if (/\.(?:js|mjs|ts|css|map|wasm|webp|png|jpg|jpeg|svg|ico|woff2?)$/i.test(c.req.path)) {
      return c.notFound();
    }
    try {
      const html = await fs.readFile(path.join(webRoot, 'index.html'), 'utf8');
      return c.html(html);
    } catch {
      return c.text('Halley Control Plane running. Start @halley/web dev server or build packages/web.', 200);
    }
  });

  const handleWsUpgrade = (
    req: import('node:http').IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
    wss: WebSocketServer,
  ) => {
    const urlPath = (req.url ?? '').split('?')[0] ?? '';
    if (urlPath.startsWith('/p/')) {
      void previewProxy.handleUpgrade(req, socket, head);
      return;
    }

    const chatMatch = urlPath.match(/^\/ws\/sessions\/([^/]+)$/);
    if (!chatMatch?.[1]) {
      socket.destroy();
      return;
    }
    const sessionId = chatMatch[1];
    const session = db.getSession(sessionId);
    if (!session) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, async (browserWs) => {
      let set = browserWsBySession.get(sessionId);
      if (!set) {
        set = new Set();
        browserWsBySession.set(sessionId, set);
      }
      set.add(browserWs);

      // Keep reverse proxies (Synology Nginx, Cloudflare, etc.) from dropping idle WebSockets
      const pingTimer = setInterval(() => {
        if (browserWs.readyState === WebSocket.OPEN) {
          browserWs.ping();
        }
      }, 20_000);

      // Push current spend, publish status, and boot progress immediately (re-read latest DB state)
      const latestSession = db.getSession(sessionId) ?? session;
      const spend = db.getSpendStatus(latestSession.owner_user_id);
      browserWs.send(JSON.stringify({ type: 'spend_status', ...spend }));
      browserWs.send(
        JSON.stringify({
          type: 'publish_state',
          payload: {
            state: latestSession.publish_state,
            prNumber: latestSession.pr_number,
            prUrl: latestSession.pr_url,
            error: latestSession.publish_error,
          },
        }),
      );
      const currentBootProgress = driver.getBootProgress?.(sessionId);
      if (currentBootProgress) {
        browserWs.send(JSON.stringify({ type: 'boot_progress', progress: currentBootProgress }));
      }

      let runnerWs: WebSocket | null = null;
      const pendingMessages: string[] = [];

      browserWs.on('message', (data) => {
        db.updateSession(sessionId, { last_active_at: new Date().toISOString() });
        const str = data.toString();
        if (runnerWs && runnerWs.readyState === WebSocket.OPEN) {
          runnerWs.send(str);
        } else {
          pendingMessages.push(str);
        }
      });

      try {
        const ep = await driver.ensureRunning(latestSession);
        const wsUrl = ep.runnerUrl.replace(/^http/, 'ws') + '/ws';
        runnerWs = new WebSocket(wsUrl);
        runnerWs.on('open', () => {
          while (pendingMessages.length > 0 && runnerWs?.readyState === WebSocket.OPEN) {
            runnerWs.send(pendingMessages.shift()!);
          }
        });
        runnerWs.on('error', (err) => {
          if (browserWs.readyState === WebSocket.OPEN) {
            browserWs.send(
              JSON.stringify({
                type: 'error',
                message: `Workspace connection error: ${err.message}`,
              }),
            );
          }
        });
        runnerWs.on('message', (data) => {
          if (browserWs.readyState === WebSocket.OPEN) {
            browserWs.send(data.toString());
          }
        });
      } catch (err) {
        if (browserWs.readyState === WebSocket.OPEN) {
          if (err instanceof WorkspaceCrashLoopError) {
            const now = new Date().toISOString();
            browserWs.send(
              JSON.stringify({
                type: 'boot_progress',
                progress: {
                  stage: 'error',
                  message: err.oom
                    ? 'Workspace ran out of memory'
                    : 'Workspace paused after repeated crashes',
                  detail: err.message,
                  startedAt: now,
                  updatedAt: now,
                  crashLoop: true,
                  oom: err.oom,
                  retryAfterSec: err.retryAfterSec,
                },
              }),
            );
          }
          browserWs.send(
            JSON.stringify({
              type: 'error',
              message: err instanceof Error ? err.message : 'Workspace failed to connect',
            }),
          );
        }
      }

      browserWs.on('close', () => {
        clearInterval(pingTimer);
        set?.delete(browserWs);
        if (runnerWs && runnerWs.readyState === WebSocket.OPEN) {
          runnerWs.close();
        }
      });
    });
  };

  return { app, db, driver, auth, github, publishService, screenshotService, handleWsUpgrade };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const preExistingEnv = { ...process.env };
  for (const envFile of ['.env.local', '.env', '../../.env.local', '../../.env']) {
    try {
      process.loadEnvFile(envFile);
    } catch {
      // ignore missing env file
    }
  }
  Object.assign(process.env, preExistingEnv);
  const config = loadConfig();
  const cp = createControlPlane(config);
  const stopReaper = startSessionReaper(config, cp.db, cp.driver);

  const server = serve({
    fetch: cp.app.fetch,
    port: config.port,
    hostname: '0.0.0.0',
    createServer,
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    cp.handleWsUpgrade(req, socket, head, wss);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopReaper();
    void Promise.allSettled([
      Promise.resolve(cp.driver.stopWarmPool?.()),
      cp.screenshotService.close(),
    ]).finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`[halley-control-plane] listening on http://0.0.0.0:${config.port} (repo=${config.repo})`);
  if ('runDoctorChecks' in cp.driver && typeof cp.driver.runDoctorChecks === 'function') {
    void (cp.driver as DockerWorkspaceDriver)
      .runDoctorChecks()
      .then((report) => {
        for (const w of report.warnings) console.warn(`[halley-doctor] WARN: ${w}`);
        for (const e of report.errors) console.error(`[halley-doctor] ERROR: ${e}`);
      })
      .catch(() => {});
  }
  cp.driver.startWarmPool?.();
}
