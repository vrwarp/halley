/**
 * Builds a control plane entirely from injected fakes (tmp db path, fake GitHub via injected fetch,
 * fake clock, fake ids, in-memory workspace driver/runner) and drives a publish through the HTTP API.
 * Same inputs must yield identical run ids and identical database contents across two runs.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '../src/clock.js';
import { loadConfig } from '../src/config.js';
import { ControlPlaneDb } from '../src/db.js';
import type { WorkspaceDriver } from '../src/drivers/workspace-driver.js';
import { GitHubService } from '../src/github/client.js';
import { createControlPlane } from '../src/index.js';
import { ScreenshotService } from '../src/screenshot-service.js';
import { FakeClock } from './helpers/fake-clock.js';

const GITHUB = 'https://api.github.test';
const RUNNER = 'http://runner.test';
const HEAD = 'a'.repeat(40);
const MERGED = 'b'.repeat(40);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function sequentialIds(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  };
}

/** Minimal GitHub REST/GraphQL fake: PR create, CI green, squash merge, deploy run succeeded. */
function fakeGitHubFetch(calls: string[]): FetchFn {
  const prs: Array<{ number: number; merged: boolean }> = [];
  const prJson = (p: { number: number; merged: boolean }) => ({
    number: p.number,
    html_url: `https://github.test/o/r/pull/${p.number}`,
    node_id: `PR_${p.number}`,
    head: { sha: HEAD },
    merged: p.merged,
    merge_commit_sha: p.merged ? MERGED : null,
    state: p.merged ? 'closed' : 'open',
  });
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.pathname}`);
    const p = url.pathname;
    if (p === '/graphql') return json(200, { errors: [{ message: 'Auto-merge is not allowed for this repository' }] });
    if (p.endsWith('/pulls') && method === 'GET') return json(200, prs.filter((x) => !x.merged).map(prJson));
    if (p.endsWith('/pulls') && method === 'POST') {
      const pr = { number: 101 + prs.length, merged: false };
      prs.push(pr);
      return json(201, prJson(pr));
    }
    const merge = p.match(/\/pulls\/(\d+)\/merge$/);
    if (merge && method === 'PUT') {
      const pr = prs.find((x) => x.number === Number(merge[1]))!;
      pr.merged = true;
      return json(200, { sha: MERGED, merged: true });
    }
    const one = p.match(/\/pulls\/(\d+)$/);
    if (one) {
      const pr = prs.find((x) => x.number === Number(one[1]));
      return pr ? json(200, prJson(pr)) : json(404, { message: 'Not Found' });
    }
    if (p.includes('/check-runs')) {
      return json(200, { total_count: 1, check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] });
    }
    if (p.endsWith('/status')) return json(200, { state: 'success', statuses: [] });
    if (p.endsWith('/actions/runs')) {
      return json(200, {
        workflow_runs: [
          {
            id: 1,
            name: 'Deploy',
            path: '.github/workflows/deploy.yml',
            event: 'push',
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://github.test/o/r/actions/runs/1',
          },
        ],
      });
    }
    if (p.endsWith('/actions/workflows')) {
      return json(200, { workflows: [{ name: 'Deploy', path: '.github/workflows/deploy.yml', state: 'active' }] });
    }
    return json(404, { message: `unexpected ${method} ${p}` });
  };
}

/** Workspace runner fake: every pre-publish step succeeds on HEAD. */
function fakeRunnerFetch(calls: string[]): FetchFn {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    switch (url.pathname) {
      case '/internal/git/checkpoint':
        return json(200, { ok: true, checkpoint: null });
      case '/internal/sync/start':
        return json(200, { review: { status: 'clean', newBaseSha: 'c'.repeat(40), prevBaseSha: 'd'.repeat(40) } });
      case '/internal/git/changes':
        return json(200, { changes: [{ path: 'src/pages/index.md' }], checkpoints: [{ sha: HEAD }] });
      case '/internal/verify':
        return json(200, { allPassed: true, results: [], headSha: HEAD });
      case '/internal/git/protected-diff':
        return json(200, { clean: true, protectedFiles: [] });
      case '/internal/transcript':
        return json(200, { entries: [{ role: 'user', text: 'Update the Easter times' }] });
      default:
        return json(200, { ok: true });
    }
  };
}

function dumpDb(db: ControlPlaneDb): Record<string, unknown[]> {
  const tables = db.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  const out: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    out[name] = db.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  }
  return out;
}

async function runScenario(tmpRoot: string) {
  const dataDir = await fs.mkdtemp(path.join(tmpRoot, 'run-'));
  const clock = new FakeClock({ start: Date.parse('2026-03-01T12:00:00Z'), autoAdvance: true });
  const randomUUID = sequentialIds();
  const githubCalls: string[] = [];
  const runnerCalls: string[] = [];
  const pushes: Array<{ sessionId: string; sha?: string }> = [];
  const cfg = {
    ...loadConfig(),
    dataDir,
    repo: 'o/r',
    baseBranch: 'main',
    githubApiBaseUrl: GITHUB,
    githubToken: 'test-token',
    githubAppId: '',
    githubAppPrivateKey: '',
    githubAppInstallationId: '',
    devLocalRepo: '',
    deployWorkflow: 'Deploy',
    devLoginEnabled: true,
    allowedDomains: ['example.test'],
    adminEmails: [],
    sessionSecret: 'deterministic-test-secret-0123456789abcdef',
  };
  const githubFetch = fakeGitHubFetch(githubCalls);
  const runnerFetch = fakeRunnerFetch(runnerCalls);
  // One injected transport for GitHub and the workspace runner; nothing may reach the real network.
  const fakeFetch: FetchFn = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (href.startsWith(RUNNER)) return runnerFetch(input, init);
    if (href.startsWith(GITHUB)) return githubFetch(input, init);
    throw new Error(`unexpected network call: ${href}`);
  };
  // Guard only (calls through): proves no control-plane code path falls back to the global fetch
  const globalFetchSpy = vi.spyOn(globalThis, 'fetch');

  const db = new ControlPlaneDb(path.join(dataDir, 'cp.sqlite'), cfg, { clock, randomUUID });
  // publish_runs rows are deleted once a publish completes: record every run id as it is written
  const runIds: string[] = [];
  const upsertPublishRun = db.upsertPublishRun.bind(db);
  db.upsertPublishRun = (input) => {
    if (!runIds.includes(input.runId)) runIds.push(input.runId);
    return upsertPublishRun(input);
  };
  const github = new GitHubService(cfg, { maxAttempts: 1 }, { clock, fetch: fakeFetch });
  const driver: WorkspaceDriver = {
    ensureRunning: async () => ({ runnerUrl: RUNNER, astroUrl: 'http://astro.test', astroBase: '/', baseSha: 'abc1234' }),
    stop: async () => {},
    destroy: async () => {},
    duplicateWorkspace: async () => {},
    pushSessionBranch: async (s, _token, opts) => {
      pushes.push({ sessionId: s.id, sha: opts?.sha });
    },
    fetchIntoSession: async () => {},
  };
  // Session creation prewarms Chromium: hand it an inert in-memory browser instead of a real one
  const screenshots = new ScreenshotService({
    clock,
    launchBrowser: async () => {
      const emitter = new EventEmitter();
      return Object.assign(emitter, { isConnected: () => true, close: async () => {} }) as unknown as Browser;
    },
  });
  const cp = createControlPlane(cfg, driver, screenshots, {
    clock,
    randomUUID,
    db,
    github,
    fetch: fakeFetch,
  });
  try {
    expect(cp.db).toBe(db);
    expect(cp.github).toBe(github);

    const login = await cp.app.request('/api/auth/dev-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'editor@example.test', name: 'Editor' }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;

    const created = await cp.app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ title: 'Update Easter Times' }),
    });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as { session: { id: string } };
    db.updateSession(session.id, { status: 'running' });

    const pub = await cp.app.request(`/api/sessions/${session.id}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ title: 'Easter times', summary: 'New service times' }),
    });
    expect(pub.status).toBe(200);

    // Everything runs on in-process promises + the auto-advancing fake clock: no wall-clock waits.
    for (let i = 0; i < 10_000 && db.getSession(session.id)!.publish_state !== 'published'; i++) {
      await new Promise((r) => setImmediate(r));
    }
    const final = db.getSession(session.id)!;
    expect(final.publish_state).toBe('published');
    expect(final.merged_sha).toBe(MERGED);
    expect(pushes).toEqual([{ sessionId: session.id, sha: HEAD }]);
    expect(runnerCalls).toContain('POST /internal/verify');
    expect(globalFetchSpy).not.toHaveBeenCalled();

    expect(runIds).toHaveLength(1);
    return { sessionId: session.id, cookie, runnerCalls, githubCalls, runIds, dump: dumpDb(db) };
  } finally {
    cp.dispose();
    await screenshots.close();
    db.close();
    globalFetchSpy.mockRestore();
  }
}

describe('control plane built entirely from injected fakes', () => {
  const tmpRoots: string[] = [];
  afterEach(async () => {
    while (tmpRoots.length) await fs.rm(tmpRoots.pop()!, { recursive: true, force: true });
  });

  it('drives a publish through the HTTP API deterministically: same inputs give identical ids and DB state', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-det-'));
    tmpRoots.push(tmpRoot);

    const a = await runScenario(tmpRoot);
    const b = await runScenario(tmpRoot);

    // Ids come from the injected generator, timestamps from the fake clock
    expect(a.sessionId).toMatch(/^00000000-0000-4000-8000-/);
    expect(b.sessionId).toBe(a.sessionId);
    expect(b.cookie).toBe(a.cookie);
    expect(b.runIds).toEqual(a.runIds);
    expect(b.runnerCalls).toEqual(a.runnerCalls);
    expect(b.githubCalls).toEqual(a.githubCalls);
    expect(a.githubCalls).toContain('PUT /repos/o/r/pulls/101/merge');
    expect(b.dump).toEqual(a.dump);
    expect(a.runIds[0]).toMatch(/^00000000-0000-4000-8000-/);
    expect(a.dump.publish_runs).toEqual([]);
    const sessions = a.dump.editor_sessions as Array<{ id: string; created_at: string; archived_at: string | null }>;
    expect(sessions[0]!.created_at).toBe('2026-03-01T12:00:00.000Z');
    expect(sessions[0]!.archived_at).not.toBeNull();
  });
});
