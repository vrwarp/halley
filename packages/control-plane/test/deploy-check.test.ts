import fs from 'node:fs/promises';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { PublishProgressPayload } from '@halley/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ControlPlaneDb } from '../src/db.js';
import type { WorkspaceDriver } from '../src/drivers/workspace-driver.js';
import { GitHubService, matchesDeployWorkflow } from '../src/github/client.js';
import { PublishService } from '../src/routes/publish.js';

interface MockRouteHandler {
  (req: http.IncomingMessage, res: http.ServerResponse, url: URL): void;
}

async function startMockGitHub(handler: MockRouteHandler): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    handler(req, res, url);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function createStubDriver(onStop?: (sessionId: string) => void): WorkspaceDriver {
  return {
    ensureRunning: async () => ({
      runnerUrl: '',
      astroUrl: '',
      astroBase: '',
      baseSha: 'abc1234',
    }),
    stop: async (s) => {
      onStop?.(s.id);
    },
    destroy: async () => {},
    duplicateWorkspace: async () => {},
    pushSessionBranch: async () => {},
    fetchIntoSession: async () => {},
  };
}

describe('deploy workflow matching & deploy check reliability', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  async function setupSession(
    githubApiBaseUrl: string,
    opts?: { deployWorkflow?: string; poll?: Parameters<typeof PublishService['prototype']['retryDeployCheck']> },
    pollOverrides?: {
      initialDelayMs?: number;
      pollIntervalMs?: number;
      timeoutMs?: number;
      runRegistrationGraceMs?: number;
      maxConsecutiveErrors?: number;
    },
  ) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-deploy-test-'));
    const cfg = {
      ...loadConfig(),
      dataDir: tmp,
      repo: 'vrwarp/thecrossing.website',
      deployWorkflow: opts?.deployWorkflow ?? '',
      githubApiBaseUrl,
      githubToken: 'test-token',
      githubAppId: '',
      githubAppPrivateKey: '',
      githubAppInstallationId: '',
    };
    const db = new ControlPlaneDb(path.join(tmp, 'halley.db'), cfg);
    cleanups.push(async () => {
      db.db.close();
      await fs.rm(tmp, { recursive: true, force: true });
    });

    const user = db.upsertUser({
      email: 'editor@thecrossing.website',
      name: 'Editor',
      picture: null,
    });
    const session = db.createSession({
      id: 'sess-deploy-1',
      title: 'Sunday update',
      slug: 'sunday-update',
      ownerUserId: user.id,
      repo: cfg.repo,
      baseBranch: 'main',
      workingBranch: 'halley/test-1',
      volumeName: 'vol-test-1',
      workspaceTokenHash: 'hash-test-1',
    });
    db.updateSession(session.id, {
      status: 'merged',
      publish_state: 'deploying_pages',
      merged_sha: 'deadbeef1234567890',
      merged_at: new Date().toISOString(),
      pr_number: 42,
      pr_url: 'https://github.com/vrwarp/thecrossing.website/pull/42',
    });

    const stopped: string[] = [];
    const broadcasts: PublishProgressPayload[] = [];
    const github = new GitHubService(cfg);
    const publish = new PublishService(
      cfg,
      db,
      createStubDriver((id) => stopped.push(id)),
      github,
      (_id, payload) => broadcasts.push(payload),
      undefined,
      {
        initialDelayMs: 0,
        pollIntervalMs: 10,
        timeoutMs: 400,
        runRegistrationGraceMs: 120,
        maxConsecutiveErrors: 3,
        ...pollOverrides,
      },
    );

    return { db, github, publish, session: db.getSession(session.id)!, broadcasts, stopped };
  }

  it('matches deploy/pages workflows by default and honors explicit HALLEY_DEPLOY_WORKFLOW overrides', () => {
    expect(matchesDeployWorkflow({ name: 'Deploy to GitHub Pages', path: '.github/workflows/deploy.yml' })).toBe(true);
    expect(matchesDeployWorkflow({ name: 'pages-build-deployment', path: 'dynamic/pages/pages-build-deployment' })).toBe(true);
    expect(matchesDeployWorkflow({ name: 'Deploy Pages' })).toBe(true);
    expect(matchesDeployWorkflow({ name: 'CI', path: '.github/workflows/ci.yml' })).toBe(false);

    expect(
      matchesDeployWorkflow({ name: 'Publish Site', path: '.github/workflows/publish.yml' }, 'publish.yml'),
    ).toBe(true);
    expect(
      matchesDeployWorkflow({ name: 'Deploy to GitHub Pages', path: '.github/workflows/deploy.yml' }, 'publish.yml'),
    ).toBe(false);
    expect(
      matchesDeployWorkflow({ name: 'Publish Site', path: '.github/workflows/publish.yml' }, 'Publish Site'),
    ).toBe(true);
  });

  it('waits through post-merge race condition (empty runs -> CI only -> Pages in_progress -> Pages success)', async () => {
    let runPolls = 0;
    const mock = await startMockGitHub((_req, res, url) => {
      if (url.pathname.endsWith('/actions/workflows')) {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            workflows: [
              { id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
              { id: 2, name: 'Deploy to GitHub Pages', path: '.github/workflows/deploy.yml', state: 'active' },
            ],
          }),
        );
        return;
      }
      if (url.pathname.endsWith('/actions/runs')) {
        runPolls += 1;
        res.writeHead(200);
        if (runPolls === 1) {
          // Immediately after merge: no runs registered yet
          res.end(JSON.stringify({ workflow_runs: [] }));
        } else if (runPolls === 2) {
          // CI registered & succeeded first; deploy workflow still hasn't registered
          res.end(
            JSON.stringify({
              workflow_runs: [
                {
                  id: 100,
                  name: 'CI',
                  path: '.github/workflows/ci.yml',
                  event: 'push',
                  status: 'completed',
                  conclusion: 'success',
                },
              ],
            }),
          );
        } else if (runPolls === 3) {
          // Deploy workflow registered and is in progress
          res.end(
            JSON.stringify({
              workflow_runs: [
                {
                  id: 100,
                  name: 'CI',
                  path: '.github/workflows/ci.yml',
                  event: 'push',
                  status: 'completed',
                  conclusion: 'success',
                },
                {
                  id: 101,
                  name: 'Deploy to GitHub Pages',
                  path: '.github/workflows/deploy.yml',
                  event: 'push',
                  status: 'in_progress',
                  conclusion: null,
                  html_url: 'https://github.com/vrwarp/thecrossing.website/actions/runs/101',
                },
              ],
            }),
          );
        } else {
          // Deploy workflow succeeded
          res.end(
            JSON.stringify({
              workflow_runs: [
                {
                  id: 100,
                  name: 'CI',
                  path: '.github/workflows/ci.yml',
                  event: 'push',
                  status: 'completed',
                  conclusion: 'success',
                },
                {
                  id: 101,
                  name: 'Deploy to GitHub Pages',
                  path: '.github/workflows/deploy.yml',
                  event: 'push',
                  status: 'completed',
                  conclusion: 'success',
                  html_url: 'https://github.com/vrwarp/thecrossing.website/actions/runs/101',
                },
              ],
            }),
          );
        }
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ message: 'Not found' }));
    });
    cleanups.push(() => mock.close());

    const { db, publish, session, broadcasts, stopped } = await setupSession(mock.url);
    await publish.retryDeployCheck(session);

    expect(runPolls).toBe(4);
    const updated = db.getSession(session.id)!;
    expect(updated.status).toBe('published');
    expect(updated.publish_state).toBe('published');
    expect(stopped).toEqual([session.id]);
    expect(broadcasts.at(-1)?.state).toBe('published');
    expect(broadcasts.at(-1)?.deployUrl).toBe('https://github.com/vrwarp/thecrossing.website/actions/runs/101');
  });

  it('fails closed when the deploy workflow is skipped, cancelled, or fails', async () => {
    const mock = await startMockGitHub((_req, res, url) => {
      if (url.pathname.endsWith('/actions/runs')) {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            workflow_runs: [
              {
                id: 200,
                name: 'CI',
                path: '.github/workflows/ci.yml',
                event: 'push',
                status: 'completed',
                conclusion: 'success',
              },
              {
                id: 201,
                name: 'Deploy to GitHub Pages',
                path: '.github/workflows/deploy.yml',
                event: 'push',
                status: 'completed',
                conclusion: 'skipped',
                html_url: 'https://github.com/vrwarp/thecrossing.website/actions/runs/201',
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ message: 'Not found' }));
    });
    cleanups.push(() => mock.close());

    const { db, publish, session, broadcasts, stopped } = await setupSession(mock.url);
    await publish.retryDeployCheck(session);

    const updated = db.getSession(session.id)!;
    expect(updated.status).toBe('merged');
    expect(updated.publish_state).toBe('failed_deploy');
    expect(updated.publish_error).toContain('skipped');
    expect(stopped).toEqual([]);
    expect(broadcasts.at(-1)?.state).toBe('failed_deploy');
    expect(broadcasts.at(-1)?.deployUrl).toBe('https://github.com/vrwarp/thecrossing.website/actions/runs/201');
  });

  it('retries transient 5xx API errors and fails closed if errors persist', async () => {
    let calls = 0;
    const mock = await startMockGitHub((_req, res, url) => {
      if (url.pathname.endsWith('/actions/runs')) {
        calls += 1;
        if (calls <= 2) {
          res.writeHead(502);
          res.end(JSON.stringify({ message: 'Bad Gateway' }));
          return;
        }
        res.writeHead(200);
        res.end(
          JSON.stringify({
            workflow_runs: [
              {
                id: 301,
                name: 'Deploy to GitHub Pages',
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
      res.end(JSON.stringify({ message: 'Not found' }));
    });
    cleanups.push(() => mock.close());

    const { db, publish, session } = await setupSession(mock.url);
    await publish.retryDeployCheck(session);

    expect(calls).toBe(3);
    expect(db.getSession(session.id)?.status).toBe('published');
    expect(db.getSession(session.id)?.publish_state).toBe('published');

    // Now test persistent 503s -> must fail closed (never fail open to published)
    let failCalls = 0;
    const failingMock = await startMockGitHub((_req, res) => {
      failCalls += 1;
      res.writeHead(503);
      res.end(JSON.stringify({ message: 'Service Unavailable' }));
    });
    cleanups.push(() => failingMock.close());

    const second = await setupSession(failingMock.url);
    await second.publish.retryDeployCheck(second.session);

    expect(failCalls).toBe(3);
    expect(second.db.getSession(second.session.id)?.status).toBe('merged');
    expect(second.db.getSession(second.session.id)?.publish_state).toBe('failed_deploy');
    expect(second.db.getSession(second.session.id)?.publish_error).toContain('failed repeatedly');
  });

  it('fails closed immediately on 403 permission error without marking published', async () => {
    let calls = 0;
    const mock = await startMockGitHub((_req, res) => {
      calls += 1;
      res.writeHead(403);
      res.end(JSON.stringify({ message: 'Resource not accessible by integration' }));
    });
    cleanups.push(() => mock.close());

    const { db, publish, session } = await setupSession(mock.url);
    await publish.retryDeployCheck(session);

    expect(calls).toBe(1);
    const updated = db.getSession(session.id)!;
    expect(updated.status).toBe('merged');
    expect(updated.publish_state).toBe('failed_deploy');
    expect(updated.publish_error).toContain('Actions: Read');
  });

  it('marks published when repo has no active deploy workflow, but fails closed when an active deploy workflow never spawns a run', async () => {
    // Case 1: repo has only CI, no deploy workflow
    const noDeployMock = await startMockGitHub((_req, res, url) => {
      if (url.pathname.endsWith('/actions/runs')) {
        res.writeHead(200);
        res.end(JSON.stringify({ workflow_runs: [] }));
        return;
      }
      if (url.pathname.endsWith('/actions/workflows')) {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            workflows: [{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ message: 'Not found' }));
    });
    cleanups.push(() => noDeployMock.close());

    const first = await setupSession(noDeployMock.url);
    await first.publish.retryDeployCheck(first.session);
    expect(first.db.getSession(first.session.id)?.status).toBe('published');
    expect(first.db.getSession(first.session.id)?.publish_state).toBe('published');

    // Case 2: active deploy workflow exists, yet no run ever spawns within grace window
    const stuckMock = await startMockGitHub((_req, res, url) => {
      if (url.pathname.endsWith('/actions/runs')) {
        res.writeHead(200);
        res.end(JSON.stringify({ workflow_runs: [] }));
        return;
      }
      if (url.pathname.endsWith('/actions/workflows')) {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            workflows: [
              { id: 2, name: 'Deploy to GitHub Pages', path: '.github/workflows/deploy.yml', state: 'active' },
            ],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ message: 'Not found' }));
    });
    cleanups.push(() => stuckMock.close());

    const second = await setupSession(stuckMock.url, undefined, {
      runRegistrationGraceMs: 40,
      pollIntervalMs: 10,
      timeoutMs: 300,
    });
    await second.publish.retryDeployCheck(second.session);
    expect(second.db.getSession(second.session.id)?.status).toBe('merged');
    expect(second.db.getSession(second.session.id)?.publish_state).toBe('failed_deploy');
    expect(second.db.getSession(second.session.id)?.publish_error).toContain('no live site deploy workflow run appeared');
  });

  it('syncs main before running /internal/verify once and waits for PR check-runs to register before merging', async () => {
    const runnerCalls: string[] = [];
    const runnerServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      runnerCalls.push(url.pathname);
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/internal/git/checkpoint') {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, checkpoint: null }));
        return;
      }
      if (url.pathname === '/internal/sync/start') {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            review: {
              status: 'applied',
              alreadyUpToDate: false,
              prevBaseSha: 'base000',
              newBaseSha: 'base111',
              touchedUserFiles: [],
            },
          }),
        );
        return;
      }
      if (url.pathname === '/internal/verify') {
        res.writeHead(200);
        res.end(JSON.stringify({ allPassed: true, results: [] }));
        return;
      }
      if (url.pathname === '/internal/git/protected-diff') {
        res.writeHead(200);
        res.end(JSON.stringify({ clean: true, protectedFiles: [] }));
        return;
      }
      if (url.pathname === '/internal/read-only') {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname === '/internal/transcript') {
        res.writeHead(200);
        res.end(JSON.stringify({ entries: [], usageUsd: 0 }));
        return;
      }
      if (url.pathname === '/internal/git/changes') {
        res.writeHead(200);
        res.end(JSON.stringify({ changes: [] }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    });
    await new Promise<void>((resolve) => runnerServer.listen(0, '127.0.0.1', () => resolve()));
    const runnerAddr = runnerServer.address() as net.AddressInfo;
    const runnerUrl = `http://127.0.0.1:${runnerAddr.port}`;
    cleanups.push(() => new Promise((r) => runnerServer.close(() => r())));

    let checkRunPolls = 0;
    let mergeCalls = 0;
    let merged = false;
    const ghMock = await startMockGitHub((req, res, url) => {
      if (req.method === 'POST' && url.pathname === '/graphql') {
        res.writeHead(200);
        res.end(JSON.stringify({ errors: [{ message: 'auto-merge disabled' }] }));
        return;
      }
      if (req.method === 'GET' && url.pathname.endsWith('/pulls')) {
        res.writeHead(200);
        res.end('[]');
        return;
      }
      if (req.method === 'POST' && url.pathname.endsWith('/pulls')) {
        res.writeHead(201);
        res.end(
          JSON.stringify({
            number: 99,
            html_url: 'https://github.com/vrwarp/thecrossing.website/pull/99',
            node_id: 'PR_99',
            head: { sha: 'head999' },
          }),
        );
        return;
      }
      if (req.method === 'GET' && url.pathname.endsWith('/pulls/99')) {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            merged,
            merge_commit_sha: merged ? 'merge999' : null,
            state: merged ? 'closed' : 'open',
            head: { sha: 'head999' },
          }),
        );
        return;
      }
      if (url.pathname.endsWith('/actions/workflows')) {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            workflows: [
              { id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
              { id: 2, name: 'Deploy to GitHub Pages', path: '.github/workflows/deploy.yml', state: 'active' },
            ],
          }),
        );
        return;
      }
      if (url.pathname.endsWith('/check-runs')) {
        checkRunPolls += 1;
        res.writeHead(200);
        if (checkRunPolls === 1) {
          // Race immediately after PR creation: 0 check-runs registered yet
          res.end(JSON.stringify({ total_count: 0, check_runs: [] }));
        } else if (checkRunPolls === 2) {
          res.end(
            JSON.stringify({
              total_count: 1,
              check_runs: [{ id: 1, name: 'verify', status: 'in_progress', conclusion: null }],
            }),
          );
        } else {
          res.end(
            JSON.stringify({
              total_count: 1,
              check_runs: [{ id: 1, name: 'verify', status: 'completed', conclusion: 'success' }],
            }),
          );
        }
        return;
      }
      if (req.method === 'PUT' && url.pathname.endsWith('/pulls/99/merge')) {
        // Must NEVER merge while checkRunPolls < 3
        expect(checkRunPolls).toBeGreaterThanOrEqual(3);
        mergeCalls += 1;
        merged = true;
        res.writeHead(200);
        res.end(JSON.stringify({ sha: 'merge999', merged: true }));
        return;
      }
      if (url.pathname.endsWith('/actions/runs')) {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            workflow_runs: [
              {
                id: 500,
                name: 'Deploy to GitHub Pages',
                path: '.github/workflows/deploy.yml',
                event: 'push',
                status: 'completed',
                conclusion: 'success',
                html_url: 'https://github.com/vrwarp/thecrossing.website/actions/runs/500',
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ message: 'Not found' }));
    });
    cleanups.push(() => ghMock.close());

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-pub-order-'));
    const cfg = {
      ...loadConfig(),
      dataDir: tmp,
      repo: 'vrwarp/thecrossing.website',
      deployWorkflow: '',
      githubApiBaseUrl: ghMock.url,
      githubToken: 'test-token',
      githubAppId: '',
      githubAppPrivateKey: '',
      githubAppInstallationId: '',
    };
    const db = new ControlPlaneDb(path.join(tmp, 'halley.db'), cfg);
    cleanups.push(async () => {
      db.db.close();
      await fs.rm(tmp, { recursive: true, force: true });
    });

    const user = db.upsertUser({
      email: 'editor@thecrossing.website',
      name: 'Editor',
      picture: null,
    });
    const session = db.createSession({
      id: 'sess-order-1',
      title: 'Order test',
      slug: 'order-test',
      ownerUserId: user.id,
      repo: cfg.repo,
      baseBranch: 'main',
      workingBranch: 'halley/order-1',
      volumeName: 'vol-order-1',
      workspaceTokenHash: 'hash-order-1',
    });

    const driver: WorkspaceDriver = {
      ...createStubDriver(),
      ensureRunning: async () => ({
        runnerUrl,
        astroUrl: '',
        astroBase: '',
        baseSha: 'base000',
      }),
    };
    const states: string[] = [];
    const publish = new PublishService(
      cfg,
      db,
      driver,
      new GitHubService(cfg),
      (_id, payload) => states.push(payload.state),
      undefined,
      {
        initialDelayMs: 0,
        pollIntervalMs: 10,
        ciPollIntervalMs: 10,
        ciRegistrationGraceMs: 500,
        runRegistrationGraceMs: 200,
        timeoutMs: 2000,
      },
    );

    await publish.publish(
      session,
      { id: user.id, email: user.email, name: user.name, picture: null, isAdmin: true, persona: 'non-technical' },
      { title: 'Order test', summary: 'Updated 1 file.' },
    );

    // Sync happened before verify, and verify ran ONCE despite alreadyUpToDate: false
    const syncIdx = runnerCalls.indexOf('/internal/sync/start');
    const verifyIndices = runnerCalls
      .map((p, idx) => (p === '/internal/verify' ? idx : -1))
      .filter((i) => i !== -1);
    expect(syncIdx).toBeGreaterThan(-1);
    expect(verifyIndices).toHaveLength(1);
    expect(syncIdx).toBeLessThan(verifyIndices[0]!);
    expect(states.indexOf('rebasing')).toBeLessThan(states.indexOf('verifying'));

    // PR waited through the 0-check-runs race and merged after poll 3
    expect(checkRunPolls).toBe(3);
    expect(mergeCalls).toBe(1);
    expect(db.getSession(session.id)?.publish_state).toBe('published');
  });
});
