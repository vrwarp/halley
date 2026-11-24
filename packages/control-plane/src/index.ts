import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatServerMessage, PublishProgressPayload, UserDto } from '@halley/shared';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { WebSocket, WebSocketServer } from 'ws';
import { AuthService } from './auth/google.js';
import { loadConfig, type HalleyConfig } from './config.js';
import { ControlPlaneDb } from './db.js';
import { DockerWorkspaceDriver } from './drivers/docker-driver.js';
import { LocalWorkspaceDriver } from './drivers/local-driver.js';
import type { WorkspaceDriver } from './drivers/workspace-driver.js';
import { GitHubService } from './github/client.js';
import { createLlmProxyHandler, hashWorkspaceToken } from './proxy/llm-proxy.js';
import { createPreviewProxy } from './proxy/preview-proxy.js';
import { startSessionReaper } from './reaper.js';
import { PublishService } from './routes/publish.js';

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

export function createControlPlane(config: HalleyConfig, customDriver?: WorkspaceDriver) {
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

  const publishService = new PublishService(
    config,
    db,
    driver,
    github,
    (sessionId, payload: PublishProgressPayload) => {
      broadcastToSession(sessionId, { type: 'publish_state', payload });
    },
  );

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
    const sessions = db.listSessions().map((s) => db.toSessionDto(s, user));
    return c.json({ sessions, spend: db.getSpendStatus(user.id) });
  });

  app.post('/api/sessions', auth.requireAuth, async (c) => {
    const user = c.get('user');
    const body = (await c.req.json()) as { title?: string };
    const title = (body.title || 'Website update').trim();
    const id = crypto.randomUUID();
    const short = id.slice(0, 6);
    const slug = slugify(title);
    const workingBranch = `halley/${slug}-${short}`;
    const rawToken = crypto.randomBytes(24).toString('hex');

    const session = db.createSession({
      id,
      title,
      slug,
      ownerUserId: user.id,
      repo: config.repo,
      baseBranch: config.baseBranch,
      workingBranch,
      volumeName: `halley-ws-${id}`,
      workspaceTokenHash: hashWorkspaceToken(rawToken),
    });

    if ('setRawWorkspaceToken' in driver && typeof driver.setRawWorkspaceToken === 'function') {
      (driver as LocalWorkspaceDriver).setRawWorkspaceToken(id, rawToken);
    }

    // Start booting workspace asynchronously so the UI opens immediately
    void driver.ensureRunning(session).catch((err) => {
      db.updateSession(id, { status: 'error', publish_error: String(err) });
    });

    return c.json({ session: db.toSessionDto(session, user) }, 201);
  });

  app.get('/api/sessions/:id', auth.requireAuth, (c) => {
    const user = c.get('user');
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    return c.json({ session: db.toSessionDto(s, user), spend: db.getSpendStatus(user.id) });
  });

  app.post('/api/sessions/:id/wake', auth.requireAuth, async (c) => {
    const user = c.get('user');
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    await driver.ensureRunning(s);
    const updated = db.getSession(s.id)!;
    return c.json({ session: db.toSessionDto(updated, user) });
  });

  app.post('/api/sessions/:id/duplicate', auth.requireAuth, async (c) => {
    const user = c.get('user');
    const src = db.getSession(c.req.param('id')!);
    if (!src) return c.json({ error: 'Not found' }, 404);

    const id = crypto.randomUUID();
    const short = id.slice(0, 6);
    const title = `${src.title} (Copy)`;
    const slug = slugify(title);
    const rawToken = crypto.randomBytes(24).toString('hex');

    const copy = db.createSession({
      id,
      title,
      slug,
      ownerUserId: user.id,
      repo: src.repo,
      baseBranch: src.base_branch,
      workingBranch: `halley/${slug}-${short}`,
      volumeName: `halley-ws-${id}`,
      workspaceTokenHash: hashWorkspaceToken(rawToken),
    });

    if ('setRawWorkspaceToken' in driver && typeof driver.setRawWorkspaceToken === 'function') {
      (driver as LocalWorkspaceDriver).setRawWorkspaceToken(id, rawToken);
    }

    await driver.duplicateWorkspace(src, copy);
    void driver.ensureRunning(copy).catch(() => {});

    return c.json({ session: db.toSessionDto(copy, user) }, 201);
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
    if (s.status === 'published') {
      return { error: 'This edit has already been published', status: 409 as const };
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
    const ep = await driver.ensureRunning(s);
    const res = await fetch(`${ep.runnerUrl}/internal/transcript`);
    const data = await res
      .json()
      .catch(() => ({ entries: [], live: { busy: false, streamingText: '', activeTools: [], queuedCount: 0 } }));
    return c.json(data, res.ok ? 200 : 502);
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

      // Push current spend & publish status immediately
      const spend = db.getSpendStatus(session.owner_user_id);
      browserWs.send(JSON.stringify({ type: 'spend_status', ...spend }));
      browserWs.send(
        JSON.stringify({
          type: 'publish_state',
          payload: {
            state: session.publish_state,
            prNumber: session.pr_number,
            prUrl: session.pr_url,
            error: session.publish_error,
          },
        }),
      );

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
        const ep = await driver.ensureRunning(session);
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

  return { app, db, driver, auth, github, publishService, handleWsUpgrade };
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

  const shutdown = () => {
    stopReaper();
    process.exit(0);
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
}
