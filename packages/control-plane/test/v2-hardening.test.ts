import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  deriveInternalHostToken,
  deriveWorkspaceToken,
} from '@halley/shared/auth';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { WorkspaceDriver } from '../src/drivers/workspace-driver.js';
import { GitHubService } from '../src/github/client.js';
import { createControlPlane } from '../src/index.js';

const execFileAsync = promisify(execFile);

describe('v2 control-plane hardening invariants', () => {
  it('enforces mandatory HKDF Bearer auth on /internal/git/repo.git and deterministic stateless workspace tokens across restart', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-cp-gitauth-'));
    const repoDir = path.join(tmp, 'upstream-repo');
    const dataDir = path.join(tmp, 'data');
    await fs.mkdir(repoDir, { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });

    await fs.writeFile(path.join(repoDir, 'README.md'), '# Crossing Site\n');
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.name', 'Bot'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.email', 'bot@example.org'], { cwd: repoDir });
    await execFileAsync('git', ['add', '-A'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoDir });

    const bareMirror = path.join(dataDir, 'git-mirror', 'repo.git');
    await fs.mkdir(path.dirname(bareMirror), { recursive: true });
    await execFileAsync('git', ['clone', '--bare', repoDir, bareMirror]);

    const sessionSecret = 'test-v2-hkdf-secret-999';
    const driver: WorkspaceDriver = {
      ensureRunning: async () => ({
        runnerUrl: 'http://127.0.0.1:49999',
        astroUrl: 'http://127.0.0.1:49998',
        astroBase: '/',
        baseSha: 'abc1234',
      }),
      stop: async () => {},
      destroy: async () => {},
      duplicateWorkspace: async () => {},
      pushSessionBranch: async () => {},
      fetchIntoSession: async () => {},
    };

    const cfg = {
      ...loadConfig(),
      dataDir,
      sessionSecret,
      devLocalRepo: repoDir,
      allowedDomains: ['thecrossing.website'],
      devLoginEnabled: true,
    };

    let cp = createControlPlane(cfg, driver);
    try {
      // 1. Unauthenticated or wrong-token requests to /internal/git/repo.git MUST return 401
      const unauthRes = await cp.app.request(
        '/internal/git/repo.git/info/refs?service=git-upload-pack',
      );
      expect(unauthRes.status).toBe(401);

      const badRes = await cp.app.request(
        '/internal/git/repo.git/info/refs?service=git-upload-pack',
        { headers: { Authorization: 'Bearer wrong-token' } },
      );
      expect(badRes.status).toBe(401);

      // 2. HKDF internal host token succeeds
      const hostToken = deriveInternalHostToken(sessionSecret);
      const okHostRes = await cp.app.request(
        '/internal/git/repo.git/info/refs?service=git-upload-pack',
        { headers: { Authorization: `Bearer ${hostToken}` } },
      );
      expect(okHostRes.status).toBe(200);

      // 3. Create session, simulate control-plane restart (new ControlPlane instance on same SQLite DB),
      // and verify deterministic HKDF workspace token STILL resolves!
      const login = await cp.app.request('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'editor@thecrossing.website', name: 'Editor' }),
      });
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      const createRes = await cp.app.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ title: 'Stateless Token Check' }),
      });
      const { session } = (await createRes.json()) as { session: { id: string } };
      const wsToken = deriveWorkspaceToken(sessionSecret, session.id, 0);

      cp.db.close();
      cp = createControlPlane(cfg, driver);

      expect(cp.db.resolveSessionByWorkspaceToken(wsToken)?.id).toBe(session.id);

      const okWsGitRes = await cp.app.request(
        '/internal/git/repo.git/info/refs?service=git-upload-pack',
        { headers: { Authorization: `Bearer ${wsToken}` } },
      );
      expect(okWsGitRes.status).toBe(200);
    } finally {
      cp.db.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('enforces SQLite CAS transitionSession epoch/freeze guards, JSON.parse >12KB model pinning, and parallel TOCTOU spend reservations', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-cp-llm-cas-'));
    const upstreamModelsSeen: string[] = [];
    let releaseFirstStream: (() => void) | null = null;

    const fakeAnthropic = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', async () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string };
        upstreamModelsSeen.push(parsed.model);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (upstreamModelsSeen.length === 1) {
          await new Promise<void>((r) => {
            releaseFirstStream = r;
          });
        }
        res.write(
          `event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: {
              model: parsed.model,
              usage: { input_tokens: 100, output_tokens: 1 },
            },
          })}\n\n`,
        );
        res.write(
          `event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            usage: { output_tokens: 20 },
          })}\n\n`,
        );
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      });
    });

    await new Promise<void>((r) => fakeAnthropic.listen(0, '127.0.0.1', () => r()));
    const anthropicPort = (fakeAnthropic.address() as AddressInfo).port;

    const sessionSecret = 'cas-toctou-secret';
    const driver: WorkspaceDriver = {
      ensureRunning: async () => ({
        runnerUrl: 'http://127.0.0.1:49999',
        astroUrl: 'http://127.0.0.1:49998',
        astroBase: '/',
        baseSha: 'abc1234',
      }),
      stop: async () => {},
      destroy: async () => {},
      duplicateWorkspace: async () => {},
      pushSessionBranch: async () => {},
      fetchIntoSession: async () => {},
    };

    const cp = createControlPlane(
      {
        ...loadConfig(),
        dataDir: tmp,
        sessionSecret,
        anthropicApiKey: 'sk-ant-test',
        anthropicBaseUrl: `http://127.0.0.1:${anthropicPort}`,
        dailyCostCapUsd: 0.004, // Tight budget so 2nd concurrent request ($0.00478 reservation) hits 429!
        allowedDomains: ['thecrossing.website'],
        devLoginEnabled: true,
      },
      driver,
    );

    try {
      const login = await cp.app.request('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'pastor@thecrossing.website', name: 'Pastor' }),
      });
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      const createRes = await cp.app.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ title: 'CAS & Spend Test' }),
      });
      const { session } = (await createRes.json()) as { session: { id: string } };
      const wsToken = deriveWorkspaceToken(sessionSecret, session.id, 0);

      // --- SQLite CAS transitionSession tests ---
      const row0 = cp.db.getSession(session.id)!;
      const bumped = cp.db.transitionSession(session.id, {
        expectedEpoch: row0.lease_epoch,
        bumpEpoch: true,
        patch: { status: 'running' },
      });
      expect(bumped?.lease_epoch).toBe((row0.lease_epoch ?? 0) + 1);

      // Stale epoch is rejected atomically
      const staleAttempt = cp.db.transitionSession(session.id, {
        expectedEpoch: row0.lease_epoch,
        patch: { status: 'sleeping' },
      });
      expect(staleAttempt).toBeNull();

      // Merged freeze guard prevents accidental un-freezing back to running/sleeping
      cp.db.transitionSession(session.id, { patch: { status: 'merged' } });
      const illegalUnfreeze = cp.db.transitionSession(session.id, {
        patch: { status: 'sleeping' },
      });
      expect(illegalUnfreeze).toBeNull();
      expect(cp.db.getSession(session.id)?.status).toBe('merged');

      // Restore to running with allowUnfreeze for LLM test
      cp.db.transitionSession(session.id, {
        allowUnfreeze: true,
        patch: { status: 'running' },
      });

      // --- 1. >14 KB JSON body model validation: unauthorized model placed after 14 KB is caught (403)! ---
      const hugeSystem = 'S'.repeat(14_000);
      const unauthorizedRes = await cp.app.request('/internal/llm/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': wsToken,
        },
        body: JSON.stringify({
          system: hugeSystem,
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 4096,
          model: 'claude-opus-99-unauthorized',
        }),
      });
      expect(unauthorizedRes.status).toBe(403);
      expect(upstreamModelsSeen).toHaveLength(0);

      // --- 2. Parallel TOCTOU spend reservation with allowed model ---
      const allowedBodyStr = JSON.stringify({
        system: hugeSystem,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 4096,
        model: 'claude-haiku-4-5-20251001',
      });

      const req1Promise = cp.app
        .request('/internal/llm/anthropic/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': wsToken,
          },
          body: allowedBodyStr,
        })
        .then(async (r) => ({ status: r.status, text: await r.text() }));

      // Wait until req1 reaches upstream and holds an in-flight spend reservation
      while (!releaseFirstStream) {
        await new Promise((r) => setTimeout(r, 15));
      }

      // Concurrent req2 arrives BEFORE req1 finishes streaming -> blocked by TOCTOU spend reservation (429)!
      const req2Res = await cp.app.request('/internal/llm/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': wsToken,
        },
        body: allowedBodyStr,
      });
      expect(req2Res.status).toBe(429);

      releaseFirstStream!();
      const req1Done = await req1Promise;
      expect(req1Done.status).toBe(200);
      expect(upstreamModelsSeen[0]).toBe('claude-haiku-4-5-20251001');
    } finally {
      releaseFirstStream?.();
      cp.db.close();
      await new Promise<void>((r) => fakeAnthropic.close(() => r()));
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('isolates 2 concurrent preview sessions without cookies and routes /__editor/* strictly to single-writer runnerUrl', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-cp-preview-'));
    let astroEditorCalls = 0;
    let runnerEditorCalls = 0;

    const makeUpstreamPair = async (label: string) => {
      const astroSrv = http.createServer((req, res) => {
        if (req.url?.includes('/__editor/')) {
          astroEditorCalls += 1;
          res.writeHead(500);
          res.end('astro should never receive /__editor/*');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body>session=${label};url=${req.url}</body></html>`);
      });
      const runnerSrv = http.createServer((req, res) => {
        if (req.url?.startsWith('/__editor/')) {
          runnerEditorCalls += 1;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, writer: `runner-${label}`, path: req.url }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      await new Promise<void>((r) => astroSrv.listen(0, '127.0.0.1', () => r()));
      await new Promise<void>((r) => runnerSrv.listen(0, '127.0.0.1', () => r()));
      return {
        astroSrv,
        runnerSrv,
        astroUrl: `http://127.0.0.1:${(astroSrv.address() as AddressInfo).port}`,
        runnerUrl: `http://127.0.0.1:${(runnerSrv.address() as AddressInfo).port}`,
      };
    };

    const upA = await makeUpstreamPair('ALPHA');
    const upB = await makeUpstreamPair('BETA');
    const bySession = new Map<string, { astroUrl: string; runnerUrl: string }>();

    const driver: WorkspaceDriver = {
      ensureRunning: async (s) => {
        const pair = bySession.size === 0 || bySession.has(s.id)
          ? bySession.get(s.id) ?? upA
          : upB;
        bySession.set(s.id, pair);
        return {
          runnerUrl: pair.runnerUrl,
          astroUrl: pair.astroUrl,
          astroBase: '/site',
          baseSha: 'abc1234',
        };
      },
      stop: async () => {},
      destroy: async () => {},
      duplicateWorkspace: async () => {},
      pushSessionBranch: async () => {},
      fetchIntoSession: async () => {},
    };

    const cp = createControlPlane(
      {
        ...loadConfig(),
        dataDir: tmp,
        allowedDomains: ['thecrossing.website'],
        devLoginEnabled: true,
      },
      driver,
    );

    try {
      const login = await cp.app.request('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'editor@thecrossing.website', name: 'Editor' }),
      });
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;

      const cA = await cp.app.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ title: 'Session A' }),
      });
      const sA = ((await cA.json()) as { session: { id: string } }).session.id;

      const cB = await cp.app.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ title: 'Session B' }),
      });
      const sB = ((await cB.json()) as { session: { id: string } }).session.id;

      // 1. Service Worker endpoint serves JS with Service-Worker-Allowed: /
      const swRes = await cp.app.request('/halley-preview-sw.js');
      expect(swRes.status).toBe(200);
      expect(swRes.headers.get('service-worker-allowed')).toBe('/');

      // 2. Navigating /p/:sessionId/* sets ZERO halley_preview_session cookies!
      const navA = await cp.app.request(`/p/${sA}/site/`, { headers: { Cookie: cookie } });
      const navB = await cp.app.request(`/p/${sB}/site/`, { headers: { Cookie: cookie } });
      expect(navA.headers.get('set-cookie') ?? '').not.toContain('halley_preview_session');
      expect(navB.headers.get('set-cookie') ?? '').not.toContain('halley_preview_session');
      expect(await navA.text()).toContain('session=ALPHA');
      expect(await navB.text()).toContain('session=BETA');

      // 3. Concurrent Service-Worker `/__halley_p/:id/*` and Referer subresource fetches never bleed across tabs!
      const [subSwA, subSwB, subRefA, subRefB] = await Promise.all([
        cp.app.request(`/__halley_p/${sA}/images/hero.webp`, { headers: { Cookie: cookie } }),
        cp.app.request(`/__halley_p/${sB}/images/hero.webp`, { headers: { Cookie: cookie } }),
        cp.app.request('/site/_astro/app.css', {
          headers: { Cookie: cookie, Referer: `http://localhost:3000/p/${sA}/site/` },
        }),
        cp.app.request('/site/_astro/app.css', {
          headers: { Cookie: cookie, Referer: `http://localhost:3000/p/${sB}/site/` },
        }),
      ]);
      expect(await subSwA.text()).toContain(`session=ALPHA;url=/p/${sA}/site/images/hero.webp`);
      expect(await subSwB.text()).toContain(`session=BETA;url=/p/${sB}/site/images/hero.webp`);
      expect(await subRefA.text()).toContain(`session=ALPHA;url=/p/${sA}/site/_astro/app.css`);
      expect(await subRefB.text()).toContain(`session=BETA;url=/p/${sB}/site/_astro/app.css`);

      // 4. `/__editor/patch` routes strictly to single-writer `runnerUrl`, NEVER `astroUrl`!
      const patchRes = await cp.app.request(`/p/${sA}/site/__editor/patch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ file: 'src/pages/index.astro', loc: '1:1', expectedHash: 'x', html: 'y' }),
      });
      expect(patchRes.status).toBe(200);
      const patchJson = (await patchRes.json()) as { writer: string; path: string };
      expect(patchJson.writer).toBe('runner-ALPHA');
      expect(patchJson.path).toBe('/__editor/patch');
      expect(runnerEditorCalls).toBe(1);
      expect(astroEditorCalls).toBe(0);
    } finally {
      cp.db.close();
      await Promise.all([
        new Promise<void>((r) => upA.astroSrv.close(() => r())),
        new Promise<void>((r) => upA.runnerSrv.close(() => r())),
        new Promise<void>((r) => upB.astroSrv.close(() => r())),
        new Promise<void>((r) => upB.runnerSrv.close(() => r())),
      ]);
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('detects combined pull_request+push deploy workflows in hasActiveCiWorkflow and resumes durable publish_runs after control-plane restart', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-cp-pubresume-'));
    let workflowYaml = `name: Build and Deploy\non:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  build:\n    runs-on: ubuntu-latest\n`;

    const fakeGh = http.createServer((req, res) => {
      const urlPath = (req.url || '').split('?')[0]!;
      res.setHeader('Content-Type', 'application/json');
      if (urlPath.endsWith('/actions/workflows')) {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            workflows: [
              {
                id: 10,
                name: 'Deploy Pages',
                path: '.github/workflows/deploy.yml',
                state: 'active',
              },
            ],
          }),
        );
        return;
      }
      if (urlPath.includes('/contents/.github/workflows/deploy.yml')) {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            encoding: 'base64',
            content: Buffer.from(workflowYaml, 'utf8').toString('base64'),
          }),
        );
        return;
      }
      if (urlPath.endsWith('/actions/runs')) {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            workflow_runs: [
              {
                id: 99,
                name: 'Deploy Pages',
                path: '.github/workflows/deploy.yml',
                event: 'push',
                status: 'completed',
                conclusion: 'success',
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });

    await new Promise<void>((r) => fakeGh.listen(0, '127.0.0.1', () => r()));
    const ghUrl = `http://127.0.0.1:${(fakeGh.address() as AddressInfo).port}`;

    const cfg = {
      ...loadConfig(),
      dataDir: tmp,
      repo: 'org/site',
      baseBranch: 'main',
      deployWorkflow: 'deploy.yml',
      githubToken: 'gh-test-token',
      githubApiBaseUrl: ghUrl,
      allowedDomains: ['thecrossing.website'],
      devLoginEnabled: true,
    };

    const gh = new GitHubService(cfg);
    // 1. Combined deploy.yml WITH `pull_request:` trigger -> hasActiveCiWorkflow() === true!
    expect(await gh.hasActiveCiWorkflow()).toBe(true);

    // 2. Push-only deploy.yml (even with `# pull_request` in a comment!) -> hasActiveCiWorkflow() === false!
    workflowYaml = `name: Deploy Only\n# pull_request is handled elsewhere\non:\n  push:\n    branches: [main]\n`;
    expect(await gh.hasActiveCiWorkflow()).toBe(false);

    // 3. Durable publish_runs resume across control-plane restart:
    // Seed a merged session with an active `deploying_pages` publish_run in SQLite, then start a new
    // control-plane instance and verify `resumeIncompletePublishes()` completes it to `published`!
    const driver: WorkspaceDriver = {
      ensureRunning: async () => ({
        runnerUrl: 'http://127.0.0.1:49999',
        astroUrl: 'http://127.0.0.1:49998',
        astroBase: '/',
        baseSha: 'abc1234',
      }),
      stop: async () => {},
      destroy: async () => {},
      duplicateWorkspace: async () => {},
      pushSessionBranch: async () => {},
      fetchIntoSession: async () => {},
    };

    const cp1 = createControlPlane(cfg, driver);
    try {
      const login = await cp1.app.request('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'editor@thecrossing.website', name: 'Editor' }),
      });
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      const { user } = (await login.json()) as { user: { id: string } };
      const cRes = await cp1.app.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ title: 'Interrupted Deploy Session' }),
      });
      const { session: sess } = (await cRes.json()) as { session: { id: string } };
      cp1.db.updateSession(sess.id, {
        status: 'merged',
        publish_state: 'deploying_pages',
        pr_number: 42,
        pr_url: 'https://github.com/org/site/pull/42',
        merged_sha: 'feedface1234567890abcdef1234567890abcdef',
      });
      cp1.db.upsertPublishRun({
        sessionId: sess.id,
        runId: 'run-resume-1',
        actorUserId: user.id,
        title: 'Interrupted Deploy Session',
        step: 'deploying_pages',
        prNumber: 42,
        prUrl: 'https://github.com/org/site/pull/42',
        mergedSha: 'feedface1234567890abcdef1234567890abcdef',
      });
      cp1.db.close();

      // Boot fresh cp2 ("restart") -> createControlPlane calls publishService.resumeIncompletePublishes()
      const cp2 = createControlPlane(cfg, driver);
      try {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const updated = cp2.db.getSession(sess.id);
          if (updated?.status === 'published' && updated.publish_state === 'published') {
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        const finalSess = cp2.db.getSession(sess.id);
        expect(finalSess?.status).toBe('published');
        expect(finalSess?.publish_state).toBe('published');
        expect(cp2.db.getPublishRun(sess.id)).toBeNull();
      } finally {
        cp2.db.close();
      }
    } finally {
      await new Promise<void>((r) => fakeGh.close(() => r()));
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
