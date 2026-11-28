/**
 * Regression tests for the reliability review findings (R1–R7 plus follow-ups). Each test started
 * life as a reproduction asserting the defective behaviour; they now assert the fixed behaviour.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, envNumber, loadConfig } from '../src/config.js';
import { ControlPlaneDb, InvalidSessionStateError } from '../src/db.js';
import { WorkspaceHostDriver } from '../src/drivers/workspace-host-driver.js';
import type { WorkspaceDriver } from '../src/drivers/workspace-driver.js';
import { GitHubService } from '../src/github/client.js';
import { runReaperPass } from '../src/reaper.js';
import { PublishService } from '../src/routes/publish.js';
import { FakeClock } from './helpers/fake-clock.js';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, body: string) => void;

async function startServer(handler: Handler) {
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      handler(req, res, new URL(req.url || '/', 'http://127.0.0.1'), body);
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

interface FakeGitHub {
  prs: Array<{ number: number; open: boolean; merged: boolean; autoMergeArmed: boolean; headSha?: string }>;
  calls: string[];
  /** Virtual time of each call (when a FakeClock is supplied). */
  callTimes: number[];
  graphqlAt: number | null;
  /** Create the PR, then answer the POST with 502 (lost response) this many times. */
  failPrPostAfterCreate: number;
  /** Merge the PR, then answer the merge PUT with 502 this many times. */
  failMergePutAfterMerge: number;
  graphqlErrors: string[] | null;
  mergeBodies: Array<Record<string, unknown>>;
  /** GET /pulls answers [] this many times (GitHub's list lagging behind a just-created PR). */
  hideOpenPrsInList: number;
  failNextPrGet: number;
  hangGraphql: boolean;
  graphqlReceived: Promise<void>;
  checkConclusion: 'in_progress' | 'failure';
  disableAutoMergeCalls: number;
}

async function startFakeGitHub(clock?: FakeClock) {
  let resolveGraphql!: () => void;
  const state: FakeGitHub = {
    prs: [],
    calls: [],
    callTimes: [],
    graphqlAt: null,
    failPrPostAfterCreate: 0,
    failMergePutAfterMerge: 0,
    graphqlErrors: null,
    mergeBodies: [],
    hideOpenPrsInList: 0,
    failNextPrGet: 0,
    hangGraphql: false,
    graphqlReceived: new Promise<void>((r) => (resolveGraphql = r)),
    checkConclusion: 'in_progress',
    disableAutoMergeCalls: 0,
  };
  const srv = await startServer((req, res, url, body) => {
    state.calls.push(`${req.method} ${url.pathname}`);
    state.callTimes.push(clock ? clock.now() : Date.now());
    const json = (code: number, v: unknown) => {
      res.statusCode = code;
      res.end(JSON.stringify(v));
    };
    const prJson = (p: FakeGitHub['prs'][number]) => ({
      number: p.number,
      html_url: `https://github.test/pull/${p.number}`,
      node_id: `node-${p.number}`,
      head: { sha: p.headSha ?? 'headsha1' },
      merged: p.merged,
      merge_commit_sha: p.merged ? 'mergedsha1' : null,
      state: p.open ? 'open' : 'closed',
    });
    if (url.pathname === '/graphql' && body.includes('disablePullRequestAutoMerge')) {
      state.disableAutoMergeCalls += 1;
      const pr = state.prs[state.prs.length - 1];
      if (pr) pr.autoMergeArmed = false;
      return json(200, { data: {} });
    }
    if (url.pathname === '/graphql') {
      // GitHub applies the mutation server-side regardless of whether we ever read the response
      const pr = state.prs[state.prs.length - 1];
      if (pr) pr.autoMergeArmed = true;
      state.graphqlAt = clock ? clock.now() : Date.now();
      resolveGraphql();
      if (state.graphqlErrors) return json(200, { errors: state.graphqlErrors.map((message) => ({ message })) });
      if (state.hangGraphql) return; // never respond: models the process dying in this window
      return json(200, { data: {} });
    }
    if (req.method === 'GET' && url.pathname.endsWith('/pulls')) {
      if (state.hideOpenPrsInList > 0) {
        state.hideOpenPrsInList -= 1;
        return json(200, []);
      }
      return json(200, state.prs.filter((p) => p.open).map(prJson));
    }
    if (req.method === 'POST' && url.pathname.endsWith('/pulls')) {
      if (state.prs.some((p) => p.open)) {
        return json(422, { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for o:halley/t.' }] });
      }
      const pr = { number: 101 + state.prs.length, open: true, merged: false, autoMergeArmed: false };
      state.prs.push(pr);
      if (state.failPrPostAfterCreate > 0) {
        state.failPrPostAfterCreate -= 1;
        return json(502, { message: 'Bad Gateway' }); // GitHub created it, but we never learn that
      }
      return json(201, prJson(pr));
    }
    const mergeM = url.pathname.match(/\/pulls\/(\d+)\/merge$/);
    if (req.method === 'PUT' && mergeM) {
      const pr = state.prs.find((p) => p.number === Number(mergeM[1]));
      state.mergeBodies.push(JSON.parse(body || '{}'));
      if (!pr) return json(404, {});
      if (pr.merged) return json(405, { message: 'Pull Request is not mergeable' });
      const wantSha = (JSON.parse(body || '{}') as { sha?: string }).sha;
      if (wantSha && wantSha !== (pr.headSha ?? 'headsha1')) {
        return json(409, { message: 'Head branch was modified. Review and try the merge again.' });
      }
      pr.merged = true;
      pr.open = false;
      if (state.failMergePutAfterMerge > 0) {
        state.failMergePutAfterMerge -= 1;
        return json(502, { message: 'Bad Gateway' });
      }
      return json(200, { sha: 'mergedsha1', merged: true });
    }
    if (req.method === 'PATCH' && /\/pulls\/\d+$/.test(url.pathname)) {
      const pr = state.prs.find((p) => url.pathname.endsWith(`/pulls/${p.number}`));
      return pr ? json(200, prJson(pr)) : json(404, {});
    }
    const m = url.pathname.match(/\/pulls\/(\d+)$/);
    if (m) {
      if (state.failNextPrGet > 0) {
        state.failNextPrGet -= 1;
        return json(502, { message: 'Bad Gateway' });
      }
      const pr = state.prs.find((p) => p.number === Number(m[1]));
      return pr ? json(200, prJson(pr)) : json(404, {});
    }
    if (url.pathname.includes('/check-runs')) {
      const run =
        state.checkConclusion === 'failure'
          ? { status: 'completed', conclusion: 'failure', name: 'ci' }
          : { status: 'in_progress', conclusion: null, name: 'ci' };
      return json(200, { total_count: 1, check_runs: [run] });
    }
    if (url.pathname.includes('/status')) return json(200, { state: 'pending', statuses: [], total_count: 0 });
    return json(200, {});
  });
  return { ...srv, state };
}

async function startFakeRunner(opts: {
  syncStatus: number;
  syncBody: unknown;
  verifyStatus?: number;
  verifyBody?: unknown;
  /** HEAD reported by /internal/git/changes; a function lets a test move it mid-publish. */
  head?: string | (() => string);
  /** Body returned by the post-verify /internal/git/checkpoint (default: nothing to commit). */
  checkpointBody?: () => unknown;
}) {
  const calls: string[] = [];
  const headers: Array<Record<string, string | string[] | undefined>> = [];
  const srv = await startServer((req, res, url) => {
    calls.push(`${req.method} ${url.pathname}`);
    headers.push(req.headers);
    const json = (code: number, v: unknown) => {
      res.statusCode = code;
      res.end(JSON.stringify(v));
    };
    if (url.pathname === '/internal/sync/start') return json(opts.syncStatus, opts.syncBody);
    if (url.pathname === '/internal/verify') {
      return json(opts.verifyStatus ?? 200, opts.verifyBody ?? { allPassed: true, results: [] });
    }
    if (url.pathname === '/internal/git/protected-diff') return json(200, { clean: true, protectedFiles: [] });
    if (url.pathname === '/internal/git/changes') {
      const head = typeof opts.head === 'function' ? opts.head() : (opts.head ?? 'headsha1');
      return json(200, { changes: [{ path: 'a.md' }], checkpoints: [{ sha: head }] });
    }
    if (url.pathname === '/internal/git/checkpoint') return json(200, opts.checkpointBody?.() ?? { ok: true, checkpoint: null });
    return json(200, { ok: true });
  });
  return { ...srv, calls, headers };
}

describe('control-plane reliability regressions', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  async function setup(runnerUrl: string, githubUrl: string, poll?: Record<string, number>, clock?: FakeClock) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-repro-'));
    const cfg = {
      ...loadConfig(),
      dataDir: tmp,
      repo: 'o/r',
      githubApiBaseUrl: githubUrl,
      githubToken: 'test-token',
      githubAppId: '',
      githubAppPrivateKey: '',
      githubAppInstallationId: '',
      devLocalRepo: '',
    };
    const dbPath = path.join(tmp, 'halley.db');
    const db = new ControlPlaneDb(dbPath, cfg);
    cleanups.push(async () => {
      // db is intentionally left open: publishes parked by a test finish in the background after teardown
      await fs.rm(tmp, { recursive: true, force: true });
    });
    const user = db.upsertUser({ email: 'e@x.test', name: 'E', picture: null });
    const created = db.createSession({
      id: 'sess-1',
      title: 'T',
      slug: 't',
      ownerUserId: user.id,
      repo: cfg.repo,
      baseBranch: 'main',
      workingBranch: 'halley/t',
      volumeName: 'v',
      workspaceTokenHash: 'h',
    });
    db.updateSession(created.id, { status: 'running' });
    const pushes: string[] = [];
    const pushedShas: Array<string | undefined> = [];
    const driver: WorkspaceDriver = {
      ensureRunning: async () => ({ runnerUrl, astroUrl: '', astroBase: '', baseSha: 'abc1234' }),
      stop: async () => {},
      destroy: async () => {},
      duplicateWorkspace: async () => {},
      pushSessionBranch: async (s, _token, opts) => {
        pushes.push(s.id);
        pushedShas.push(opts?.sha);
      },
      fetchIntoSession: async () => {},
    };
    const mk = (d: ControlPlaneDb) =>
      new PublishService(
        cfg,
        d,
        driver,
        new GitHubService(cfg, undefined, { clock }),
        () => {},
        undefined,
        {
          ciPollIntervalMs: 20,
          ciRegistrationGraceMs: 0,
          ...poll,
        },
        { clock },
      );
    const actor = { id: user.id, email: user.email, name: 'E', picture: null, isAdmin: false, persona: 'editor' } as never;
    return { cfg, db, dbPath, mk, pushes, pushedShas, actor, session: db.getSession(created.id)! };
  }


  async function waitFor(pred: () => boolean, timeoutMs = 5000, label = 'condition') {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pred()) return;
      await new Promise((r) => setImmediate(r)); // yield to I/O; no fixed wall-clock sleep
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  it('R1: runner sync failure (409 "Pi is busy") fails the publish closed: no verify, no push, no PR', async () => {
    const gh = await startFakeGitHub();
    const runner = await startFakeRunner({
      syncStatus: 409,
      syncBody: { error: 'Pi is currently editing; try again once it finishes.' },
    });
    cleanups.push(gh.close, runner.close);
    const t = await setup(runner.url, gh.url);
    await t.mk(t.db).publish(t.session, t.actor, {});

    expect(runner.calls).toContain('POST /internal/sync/start');
    expect(runner.calls).not.toContain('POST /internal/verify');
    expect(t.pushes).toEqual([]);
    expect(gh.state.prs).toHaveLength(0);
    const after = t.db.getSession('sess-1')!;
    expect(after.publish_state).toBe('failed_checks');
    expect(after.publish_error).toMatch(/Pi is currently editing/);
    expect(t.db.listActivePublishRuns()).toHaveLength(0);
  });

  it('R1b: verify error responses and malformed bodies fail closed (no push), with the runner error message', async () => {
    const gh = await startFakeGitHub();
    const runner502 = await startFakeRunner({
      syncStatus: 200,
      syncBody: { review: { status: 'clean' } },
      verifyStatus: 502,
      verifyBody: { error: 'verify sandbox crashed' },
    });
    const runnerBad = await startFakeRunner({
      syncStatus: 200,
      syncBody: { review: { status: 'clean' } },
      verifyBody: { ok: true }, // 200 but not a verify result
    });
    cleanups.push(gh.close, runner502.close, runnerBad.close);

    const a = await setup(runner502.url, gh.url);
    await a.mk(a.db).publish(a.session, a.actor, {});
    expect(a.pushes).toEqual([]);
    expect(a.db.getSession('sess-1')).toMatchObject({ publish_state: 'failed_checks', publish_error: 'verify sandbox crashed' });

    const b = await setup(runnerBad.url, gh.url);
    await b.mk(b.db).publish(b.session, b.actor, {});
    expect(b.pushes).toEqual([]);
    expect(b.db.getSession('sess-1')!.publish_error).toMatch(/unexpected response for \/internal\/verify/);
    expect(gh.state.prs).toHaveLength(0);
  });

  it('R1c: publish() never rejects, even when the database is closed under it', async () => {
    const gh = await startFakeGitHub();
    const runner = await startFakeRunner({ syncStatus: 409, syncBody: { error: 'busy' } });
    cleanups.push(gh.close, runner.close);
    const t = await setup(runner.url, gh.url);
    const svc = t.mk(t.db);
    t.db.db.close();
    await expect(svc.publish(t.session, t.actor, {})).resolves.toBeUndefined();
  });

  it('R2: pr_number is persisted before auto-merge is armed, and a restart resumes tracking the PR', async () => {
    const gh = await startFakeGitHub();
    gh.state.hangGraphql = true; // process "dies" while awaiting the auto-merge response
    const runner = await startFakeRunner({ syncStatus: 200, syncBody: { review: { status: 'clean' } } });
    cleanups.push(gh.close, runner.close);
    const t = await setup(runner.url, gh.url);
    void t.mk(t.db).publish(t.session, t.actor, {});
    await gh.state.graphqlReceived;

    // What survived to disk at the moment of the crash
    expect(t.db.getSession('sess-1')!.pr_number).toBe(101);
    expect(t.db.listActivePublishRuns()[0]).toMatchObject({ step: 'waiting_ci', pr_number: 101 });

    // "Restart": fresh DB handle + fresh service, as on control-plane boot
    const db2 = new ControlPlaneDb(t.dbPath, t.cfg);
    cleanups.push(async () => db2.db.close());
    t.mk(db2).resumeIncompletePublishes();
    expect(db2.listActivePublishRuns()).toHaveLength(1); // still tracked
    expect(db2.getSession('sess-1')).toMatchObject({ publish_state: 'waiting_ci', pr_number: 101 });

    // GitHub merges on its own: the resumed run reconciles it
    gh.state.prs[0]!.merged = true;
    gh.state.prs[0]!.open = false;
    await waitFor(() => ['merged', 'published'].includes(db2.getSession('sess-1')!.status), 5000, 'merge reconciled');
    expect(db2.getSession('sess-1')!.merged_sha).toBe('mergedsha1');
  });

  it('R2b: a run interrupted at pushing_pr adopts an open PR for its branch instead of resetting to idle', async () => {
    const gh = await startFakeGitHub();
    const runner = await startFakeRunner({ syncStatus: 200, syncBody: { review: { status: 'clean' } } });
    cleanups.push(gh.close, runner.close);
    const t = await setup(runner.url, gh.url);
    t.db.upsertPublishRun({ sessionId: 'sess-1', runId: 'run-x', actorUserId: t.session.owner_user_id, step: 'pushing_pr' });
    t.db.updateSession('sess-1', { publish_state: 'pushing_pr' });
    gh.state.prs.push({ number: 101, open: true, merged: false, autoMergeArmed: true });

    t.mk(t.db).resumeIncompletePublishes();
    await waitFor(() => t.db.getSession('sess-1')!.pr_number === 101, 3000, 'PR adopted');
    expect(t.db.getSession('sess-1')!.publish_state).toBe('waiting_ci');
    expect(t.db.getPublishRun('sess-1')).toMatchObject({ step: 'waiting_ci', pr_number: 101, run_id: 'run-x' });
    gh.state.prs[0]!.open = false; // let the resumed loop end

    // Without an open PR it still resets to idle as before
    const t2 = await setup(runner.url, gh.url);
    t2.db.upsertPublishRun({ sessionId: 'sess-1', runId: 'run-y', actorUserId: t2.session.owner_user_id, step: 'pushing_pr' });
    t2.db.updateSession('sess-1', { publish_state: 'pushing_pr' });
    t2.mk(t2.db).resumeIncompletePublishes();
    await waitFor(() => t2.db.getSession('sess-1')!.publish_state === 'idle', 3000, 'reset to idle');
    expect(t2.db.listActivePublishRuns()).toHaveLength(0);
  });

  it('R3: a transient GitHub 502 while waiting for CI is tolerated and the later merge completes the publish', async () => {
    // Virtual time: GitHub retry backoff and CI polling never sleep on the wall clock
    const clock = new FakeClock({ autoAdvance: true });
    const gh = await startFakeGitHub(clock);
    const runner = await startFakeRunner({ syncStatus: 200, syncBody: { review: { status: 'clean' } } });
    cleanups.push(gh.close, runner.close);
    const t = await setup(runner.url, gh.url, { ciTimeoutMs: 30 * 24 * 3600_000 }, clock);
    gh.state.failNextPrGet = 4; // more than one API call's worth of retries
    const done = t.mk(t.db).publish(t.session, t.actor, {});
    await waitFor(() => gh.state.failNextPrGet === 0, 5000, '502s served');
    await waitFor(() => gh.state.callTimes.length > gh.state.calls.indexOf('POST /graphql') + 12, 5000, 'polling resumed');
    expect(t.db.getSession('sess-1')!.publish_state).toBe('waiting_ci');
    expect(t.db.listActivePublishRuns()).toHaveLength(1);

    gh.state.prs[0]!.merged = true;
    gh.state.prs[0]!.open = false;
    await done;
    expect(t.db.getSession('sess-1')).toMatchObject({ status: 'published', publish_state: 'published' });
  });

  it('R3b: CI failure disarms native auto-merge so the failed PR cannot self-merge', async () => {
    const gh = await startFakeGitHub();
    gh.state.checkConclusion = 'failure';
    const runner = await startFakeRunner({ syncStatus: 200, syncBody: { review: { status: 'clean' } } });
    cleanups.push(gh.close, runner.close);
    const t = await setup(runner.url, gh.url);
    await t.mk(t.db).publish(t.session, t.actor, {});

    const after = t.db.getSession('sess-1')!;
    expect(after.publish_state).toBe('failed_ci');
    expect(after.publish_error).toMatch(/Auto-merge was turned off/);
    expect(after.pr_number).toBe(101);
    expect(gh.state.disableAutoMergeCalls).toBe(1);
    expect(gh.state.prs[0]!.autoMergeArmed).toBe(false);
    expect(t.db.listActivePublishRuns()).toHaveLength(0);
  });

  it('R3c: a CI timeout with auto-merge still armed keeps the run so a restart reconciles a later self-merge', async () => {
    const clock = new FakeClock({ autoAdvance: true });
    const gh = await startFakeGitHub(clock);
    const runner = await startFakeRunner({ syncStatus: 200, syncBody: { review: { status: 'clean' } } });
    cleanups.push(gh.close, runner.close);
    const t = await setup(runner.url, gh.url, { ciTimeoutMs: 300 }, clock);
    await t.mk(t.db).publish(t.session, t.actor, {});

    const after = t.db.getSession('sess-1')!;
    expect(after).toMatchObject({ publish_state: 'failed_ci', pr_number: 101 });
    expect(after.publish_error).toMatch(/Timed out/);
    expect(t.db.listActivePublishRuns()[0]).toMatchObject({ pr_number: 101, native_auto_merge: 1 });
    expect(gh.state.prs[0]).toMatchObject({ open: true, autoMergeArmed: true });

    // GitHub later merges on its own; a restart resumes and reconciles it
    gh.state.prs[0]!.merged = true;
    gh.state.prs[0]!.open = false;
    t.mk(t.db).resumeIncompletePublishes();
    await waitFor(() => t.db.getSession('sess-1')!.status === 'published', 5000, 'published after reconcile');
  });

  it('R3d: without a restart, the periodic reconcile records a later self-merge of a kept PR (and skips open ones)', async () => {
    const clock = new FakeClock({ autoAdvance: true });
    const gh = await startFakeGitHub(clock);
    const runner = await startFakeRunner({ syncStatus: 200, syncBody: { review: { status: 'clean' } } });
    cleanups.push(gh.close, runner.close);
    const t = await setup(runner.url, gh.url, { ciTimeoutMs: 300 }, clock);
    const svc = t.mk(t.db);
    await svc.publish(t.session, t.actor, {});
    expect(t.db.listActivePublishRuns()).toHaveLength(1);

    // Still open: one cheap GET, nothing changes
    const before = gh.state.calls.length;
    await svc.reconcileArmedRuns();
    expect(gh.state.calls.length - before).toBe(1);
    expect(t.db.getSession('sess-1')!.status).toBe('running');

    gh.state.prs[0]!.merged = true;
    gh.state.prs[0]!.open = false;
    await svc.reconcileArmedRuns();
    await waitFor(() => t.db.getSession('sess-1')!.status === 'published', 5000, 'published after periodic reconcile');
  });

  it('R4: CI polling backs off (x1.5 up to a cap) instead of 3 GitHub calls every 1.5s', async () => {
    // Runs the whole 15-minute CI wait in virtual time: no wall-clock sleeps
    const clock = new FakeClock({ autoAdvance: true });
    const gh = await startFakeGitHub(clock);
    const runner = await startFakeRunner({ syncStatus: 200, syncBody: { review: { status: 'clean' } } });
    cleanups.push(gh.close, runner.close);
    const t = await setup(runner.url, gh.url, { ciPollIntervalMs: 1500 }, clock);
    const wallStart = Date.now();
    await t.mk(t.db).publish(t.session, t.actor, {});
    const wallMs = Date.now() - wallStart;

    const t0 = gh.state.graphqlAt!;
    const after = gh.state.callTimes.filter((at) => at > t0);
    const inFirstWindow = after.filter((at) => at <= t0 + 6200).length;
    // ticks at ~0, 1.5, 3.75, 7.1s → at most 3 ticks (3 calls each) in the window; was 5 ticks
    expect(inFirstWindow).toBeLessThanOrEqual(9);
    console.log(
      `[R4] ${inFirstWindow} GitHub calls in the first 6.2s; ${after.length} calls over the whole 15-minute wait (was ~1800); ${wallMs}ms wall clock`,
    );
    expect(after.length).toBeLessThan(250);
    expect(t.db.getSession('sess-1')!.publish_error).toMatch(/Timed out/);
    expect(wallMs).toBeLessThan(5000);
  });

  it('R5: a mistyped numeric env var fails loadConfig with a clear error naming the variable', async () => {
    const prev = process.env.WORKSPACE_IDLE_TIMEOUT_MS;
    process.env.WORKSPACE_IDLE_TIMEOUT_MS = '20m';
    try {
      expect(() => loadConfig()).toThrow(ConfigError);
      expect(() => loadConfig()).toThrow(/WORKSPACE_IDLE_TIMEOUT_MS="20m"/);
    } finally {
      if (prev === undefined) delete process.env.WORKSPACE_IDLE_TIMEOUT_MS;
      else process.env.WORKSPACE_IDLE_TIMEOUT_MS = prev;
    }
    expect(envNumber('X', 7, {}, {})).toBe(7); // unset → default
    expect(envNumber('X', 7, {}, { X: '' })).toBe(7); // empty → default
    expect(envNumber('X', 7, { min: 1 }, { X: ' 42 ' })).toBe(42);
    expect(() => envNumber('X', 7, { min: 1 }, { X: '0' })).toThrow(/X="0".*>= 1/);
    expect(() => envNumber('X', 7, { integer: true }, { X: '1.5' })).toThrow(/integer/);
    expect(loadConfig().workspaceIdleTimeoutMs).toBeGreaterThan(0);
  });

  it('R6: unknown status/publish_state values are rejected and status changes go through allowed transitions', async () => {
    const t = await setup('http://127.0.0.1:1', 'http://127.0.0.1:1');
    expect(() => t.db.updateSession('sess-1', { status: 'banana' as never })).toThrow(InvalidSessionStateError);
    expect(() => t.db.updateSession('sess-1', { publish_state: 'also-not-a-state' as never })).toThrow(
      InvalidSessionStateError,
    );
    expect(t.db.getSession('sess-1')).toMatchObject({ status: 'running', publish_state: 'idle' });

    expect(t.db.setSessionStatus('sess-1', 'published', { publish_state: 'published' })).not.toBeNull();
    // terminal: neither the guarded CAS nor the status helper can leave 'published'
    expect(t.db.transitionSession('sess-1', { fromStatuses: ['running'], patch: { status: 'sleeping' } })).toBeNull();
    expect(t.db.setSessionStatus('sess-1', 'running')).toBeNull();
    expect(t.db.setSessionStatus('sess-1', 'merged')).toBeNull();
    expect(t.db.setSessionStatus('sess-1', 'error')).toBeNull();
    expect(t.db.getSession('sess-1')!.status).toBe('published');

    // db.transaction rolls back every statement on error
    expect(() =>
      t.db.transaction(() => {
        t.db.updateSession('sess-1', { title: 'changed' });
        t.db.deletePublishRun('sess-1');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(t.db.getSession('sess-1')!.title).toBe('T');
  });

  it('R7: proxied preview asset requests run <=3 cached statements and <=1 activity write per 15s', async () => {
    const { createControlPlane } = await import('../src/index.js');
    const astro = await startServer((_req, res) => {
      res.setHeader('Content-Type', 'application/javascript');
      res.end('export default 1;');
    });
    cleanups.push(astro.close);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-repro-proxy-'));
    const cfg = { ...loadConfig(), dataDir: tmp, allowedDomains: ['x.test'], devLoginEnabled: true };
    const driver: WorkspaceDriver = {
      ensureRunning: async () => ({ runnerUrl: astro.url, astroUrl: astro.url, astroBase: '/', baseSha: 'abc1234' }),
      stop: async () => {},
      destroy: async () => {},
      duplicateWorkspace: async () => {},
      pushSessionBranch: async () => {},
      fetchIntoSession: async () => {},
    };
    const cp = createControlPlane(cfg, driver);
    cleanups.push(async () => {
      cp.db.close();
      await fs.rm(tmp, { recursive: true, force: true });
    });
    const login = await cp.app.request('/api/auth/dev-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@x.test', name: 'A' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const created = await cp.app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ title: 'T' }),
    });
    const cj = (await created.json()) as { session?: { id: string }; id?: string };
    const id = cj.session?.id ?? cj.id!;
    const warm = await cp.app.request(`/p/${id}/src/a.js`, { headers: { Cookie: cookie } });
    expect(warm.status).toBe(200);

    const raw = cp.db.db;
    const origPrepare = raw.prepare.bind(raw);
    let freshPrepares = 0;
    raw.prepare = ((q: string) => {
      freshPrepares += 1;
      return origPrepare(q);
    }) as typeof raw.prepare;
    const origPrepared = cp.db.prepared.bind(cp.db);
    const sql: string[] = [];
    cp.db.prepared = ((q: string) => {
      sql.push(q.replace(/\s+/g, ' ').trim().slice(0, 60));
      return origPrepared(q);
    }) as typeof cp.db.prepared;
    const N = 20;
    for (let i = 0; i < N; i++) {
      const r = await cp.app.request(`/p/${id}/src/a${i}.js`, { headers: { Cookie: cookie } });
      expect(r.status).toBe(200);
      await r.arrayBuffer();
    }
    raw.prepare = origPrepare as typeof raw.prepare;
    cp.db.prepared = origPrepared;
    const perReq = sql.length / N;
    const writes = sql.filter((q) => /^(UPDATE|INSERT|DELETE)/i.test(q)).length;
    console.log(`[R7] ${perReq} statements/request, ${writes} writes in ${N} requests, ${freshPrepares} fresh prepares`);
    expect(perReq).toBeLessThanOrEqual(3);
    expect(writes).toBeLessThanOrEqual(1);
    expect(freshPrepares).toBe(0); // statements are prepared once and reused

    // The throttle still records activity once the window has passed
    const t0 = Date.now();
    expect(cp.db.touchSessionActivity(id, t0 + 16_000)).toBe(true);
    expect(cp.db.touchSessionActivity(id, t0 + 17_000)).toBe(false);
    expect(new Date(cp.db.getSession(id)!.last_active_at).getTime()).toBe(t0 + 16_000);
  });

  it('reaper only stamps volume_expired_at when destroy succeeds', async () => {
    const t = await setup('http://127.0.0.1:1', 'http://127.0.0.1:1');
    const old = new Date(Date.now() - 500 * 24 * 3600_000).toISOString();
    t.db.updateSession('sess-1', { status: 'sleeping', last_active_at: old });
    let fail = true;
    const driver = {
      ensureRunning: async () => ({ runnerUrl: '', astroUrl: '', astroBase: '', baseSha: '' }),
      stop: async () => {},
      destroy: async () => {
        if (fail) throw new Error('supervisor unavailable');
      },
      duplicateWorkspace: async () => {},
      pushSessionBranch: async () => {},
      fetchIntoSession: async () => {},
    } as WorkspaceDriver;
    await runReaperPass(t.cfg, t.db, driver);
    expect(t.db.getSession('sess-1')!.volume_expired_at).toBeNull();
    fail = false;
    await runReaperPass(t.cfg, t.db, driver);
    expect(t.db.getSession('sess-1')!.volume_expired_at).toBeTruthy();
  });

  it('supervisor health is single-flight and responses are validated', async () => {
    let healthCalls = 0;
    let healthBody: unknown = {
      ok: true,
      protocolVersion: 2,
      instanceId: 'inst-1',
      activeSessionIds: [],
      activeCount: 0,
      maxActiveWorkspaces: 5,
      warmPool: { enabled: false, target: 0, ready: 0, warming: 0 },
      buildQueue: { activeSessionId: null, queueLength: 0, queuedSessionIds: [] },
      diskUsage: null,
    };
    const sup = await startServer((req, res) => {
      if (req.url === '/health') {
        healthCalls += 1;
        setTimeout(() => res.end(JSON.stringify(healthBody)), 50);
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    cleanups.push(sup.close);
    const t = await setup('http://127.0.0.1:1', 'http://127.0.0.1:1');
    const hostDriver = new WorkspaceHostDriver({ ...t.cfg, workspaceHostUrl: sup.url, workspaceHostSecret: 's' }, t.db, {} as never);
    await Promise.all([1, 2, 3, 4, 5].map(() => hostDriver.reconcileSessions()));
    expect(healthCalls).toBe(1);

    healthBody = { ok: true, protocolVersion: 2 }; // missing instanceId / activeSessionIds
    await expect(hostDriver.reconcileSessions()).rejects.toThrow(/invalid health response/);
  });
  it('R8: a runner crash reported by the supervisor reconciles the session at once and tells open editors', async () => {
    const { createControlPlane } = await import('../src/index.js');
    const { deriveInternalHostToken } = await import('@halley/shared/auth');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-exited-'));
    const cfg = { ...loadConfig(), dataDir: tmp, allowedDomains: ['x.test'], devLoginEnabled: true };
    let reconciles = 0;
    const driver: WorkspaceDriver = {
      ensureRunning: async () => ({ runnerUrl: 'http://127.0.0.1:1', astroUrl: '', astroBase: '/', baseSha: 'abc1234' }),
      stop: async () => {},
      destroy: async () => {},
      duplicateWorkspace: async () => {},
      pushSessionBranch: async () => {},
      fetchIntoSession: async () => {},
      reconcileSessions: async () => {
        reconciles += 1;
      },
    };
    const cp = createControlPlane(cfg, driver);
    cleanups.push(async () => {
      cp.db.close();
      await fs.rm(tmp, { recursive: true, force: true });
    });
    const post = (auth: string | null, body: unknown) =>
      cp.app.request('/internal/workspaces/session-exited', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
        body: JSON.stringify(body),
      });
    expect((await post(null, { sessionId: 's' })).status).toBe(401);
    expect((await post('wrong', { sessionId: 's' })).status).toBe(401);
    const token = deriveInternalHostToken(cfg.sessionSecret);
    expect((await post(token, { nope: 1 })).status).toBe(400);
    const ok = await post(token, { sessionId: 's', code: null, signal: 'SIGKILL', oom: true });
    expect(ok.status).toBe(200);
    expect(reconciles).toBe(1);
  });

  // ---------------------------------------------------------------------------------------------
  // Follow-up reliability work (R9+)

  /** A throwaway local git repo with one commit on main (used as HALLEY_DEV_LOCAL_REPO). */
  async function makeLocalRepo(): Promise<{ dir: string; head: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-src-'));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@x.test', ...args], { cwd: dir }).toString().trim();
    git('init', '-q', '-b', 'main');
    await fs.writeFile(path.join(dir, 'index.md'), '# hi\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    return { dir, head: git('rev-parse', 'HEAD') };
  }

  async function loginCp(cp: { app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> } }) {
    const login = await cp.app.request('/api/auth/dev-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@x.test', name: 'A' }),
    });
    return login.headers.get('set-cookie')!.split(';')[0]!;
  }

  async function makeCp(driver: WorkspaceDriver, overrides: Record<string, unknown> = {}) {
    const { createControlPlane } = await import('../src/index.js');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-cp-'));
    const cfg = { ...loadConfig(), dataDir: tmp, allowedDomains: ['x.test'], devLoginEnabled: true, ...overrides };
    const cp = createControlPlane(cfg, driver);
    cleanups.push(async () => {
      cp.db.close();
      await fs.rm(tmp, { recursive: true, force: true });
    });
    return { cp, cfg, tmp };
  }

  function stubDriver(runnerUrl: string, extra: Partial<WorkspaceDriver> = {}): WorkspaceDriver {
    return {
      ensureRunning: async () => ({ runnerUrl, astroUrl: runnerUrl, astroBase: '/', baseSha: 'abc1234' }),
      stop: async () => {},
      destroy: async () => {},
      duplicateWorkspace: async () => {},
      pushSessionBranch: async () => {},
      fetchIntoSession: async () => {},
      ...extra,
    };
  }

  it('R9: a PR POST answered with 502 after GitHub created the PR is adopted on retry: exactly one PR, publish proceeds', async () => {
    const clock = new FakeClock({ autoAdvance: true });
    const gh = await startFakeGitHub(clock);
    gh.state.failPrPostAfterCreate = 1;
    const runner = await startFakeRunner({ syncStatus: 200, syncBody: { review: { status: 'clean' } } });
    cleanups.push(gh.close, runner.close);
    const t = await setup(runner.url, gh.url, { ciTimeoutMs: 30 * 24 * 3600_000 }, clock);
    const done = t.mk(t.db).publish(t.session, t.actor, {});
    await waitFor(() => t.db.getSession('sess-1')!.pr_number === 101, 5000, 'PR recorded');
    expect(gh.state.prs).toHaveLength(1);
    expect(gh.state.calls.filter((c) => c === 'POST /repos/o/r/pulls')).toHaveLength(1);
    expect(gh.state.calls.filter((c) => c === 'PATCH /repos/o/r/pulls/101')).toHaveLength(1);
    gh.state.prs[0]!.merged = true;
    gh.state.prs[0]!.open = false;
    await done;
    expect(t.db.getSession('sess-1')).toMatchObject({ status: 'published', publish_state: 'published' });

    // 422 "A pull request already exists" (list lagging behind) is treated as a lookup, not a failure
    const gh2 = await startFakeGitHub(clock);
    cleanups.push(gh2.close);
    gh2.state.prs.push({ number: 101, open: true, merged: false, autoMergeArmed: false });
    gh2.state.hideOpenPrsInList = 1;
    const svc = new GitHubService({ ...t.cfg, githubApiBaseUrl: gh2.url }, undefined, { clock });
    const pr = await svc.createOrUpdatePr({ headBranch: 'halley/t', baseBranch: 'main', title: 'x', body: 'y' });
    expect(pr.number).toBe(101);
    expect(gh2.state.prs).toHaveLength(1);
    expect(gh2.state.calls).toEqual(['GET /repos/o/r/pulls', 'POST /repos/o/r/pulls', 'GET /repos/o/r/pulls', 'PATCH /repos/o/r/pulls/101']);
  });

  it('R10: squash merge is pinned to the verified sha and safe to retry (lost response / already merged / head moved)', async () => {
    const clock = new FakeClock({ autoAdvance: true });
    const gh = await startFakeGitHub(clock);
    cleanups.push(gh.close);
    const t = await setup('http://127.0.0.1:1', gh.url, undefined, clock);
    const svc = new GitHubService(t.cfg, undefined, { clock });
    gh.state.prs.push({ number: 101, open: true, merged: false, autoMergeArmed: false });
    gh.state.failMergePutAfterMerge = 1;
    const merge = () => svc.squashMergePr({ prNumber: 101, commitTitle: 't', commitMessage: 'm', headSha: 'headsha1' });
    await expect(merge()).resolves.toBe('mergedsha1'); // 502 after merging → re-read → merged
    expect(gh.state.mergeBodies[0]).toMatchObject({ merge_method: 'squash', sha: 'headsha1' });
    await expect(merge()).resolves.toBe('mergedsha1'); // 405 already merged → merge commit
    gh.state.prs.push({ number: 102, open: true, merged: false, autoMergeArmed: false, headSha: 'movedsha' });
    await expect(
      svc.squashMergePr({ prNumber: 102, commitTitle: 't', commitMessage: 'm', headSha: 'headsha1' }),
    ).rejects.toThrow(/head changed/);
    expect(gh.state.prs[1]!.merged).toBe(false);
  });

  it('R11: auto-merge enable/disable treat "already enabled"/"not enabled" as success', async () => {
    const gh = await startFakeGitHub();
    cleanups.push(gh.close);
    const t = await setup('http://127.0.0.1:1', gh.url);
    const svc = new GitHubService(t.cfg);
    gh.state.graphqlErrors = ['Pull request Auto merge is already enabled'];
    await expect(svc.tryEnableNativeAutoMerge('node-1', 'h')).resolves.toBe(true);
    gh.state.graphqlErrors = ['Pull request is in clean status'];
    await expect(svc.tryEnableNativeAutoMerge('node-1', 'h')).resolves.toBe(false);
    gh.state.graphqlErrors = null;
    await expect(svc.tryEnableNativeAutoMerge('node-1', 'h')).resolves.toBe(true);
  });

  it('R12: the pushed commit is exactly the verified one; edits during checks fail closed', async () => {
    const clock = new FakeClock({ autoAdvance: true });
    // (a) happy path: the driver is asked to push the verified HEAD
    const gh = await startFakeGitHub(clock);
    const runner = await startFakeRunner({ syncStatus: 200, syncBody: { review: { status: 'clean' } } });
    cleanups.push(gh.close, runner.close);
    const a = await setup(runner.url, gh.url, { ciTimeoutMs: 300 }, clock);
    await a.mk(a.db).publish(a.session, a.actor, {});
    expect(a.pushedShas).toEqual(['headsha1']);
    expect(a.db.getSession('sess-1')!.pr_number).toBe(101);

    // (b) HEAD moves while verify runs → no push, no PR
    let changesCalls = 0;
    const moving = await startFakeRunner({
      syncStatus: 200,
      syncBody: { review: { status: 'clean' } },
      head: () => (++changesCalls === 1 ? 'headsha1' : 'headsha2'),
    });
    const gh2 = await startFakeGitHub(clock);
    cleanups.push(moving.close, gh2.close);
    const b = await setup(moving.url, gh2.url, undefined, clock);
    await b.mk(b.db).publish(b.session, b.actor, {});
    expect(b.pushes).toEqual([]);
    expect(gh2.state.prs).toHaveLength(0);
    expect(b.db.getSession('sess-1')).toMatchObject({ publish_state: 'failed_checks' });
    expect(b.db.getSession('sess-1')!.publish_error).toMatch(/changed while publish checks were running/);

    // (c) uncommitted edits during verify (post-verify checkpoint creates a commit) → fail closed
    let ckpts = 0;
    const dirty = await startFakeRunner({
      syncStatus: 200,
      syncBody: { review: { status: 'clean' } },
      checkpointBody: () => (++ckpts === 2 ? { ok: true, checkpoint: { sha: 'newsha' } } : { ok: true, checkpoint: null }),
    });
    cleanups.push(dirty.close);
    const c = await setup(dirty.url, gh2.url, undefined, clock);
    await c.mk(c.db).publish(c.session, c.actor, {});
    expect(c.pushes).toEqual([]);
    expect(c.db.getSession('sess-1')!.publish_error).toMatch(/changed while publish checks/);

    // (d) the PR does not point at the verified commit → fail before arming auto-merge
    const otherHead = await startFakeRunner({ syncStatus: 200, syncBody: { review: { status: 'clean' } }, head: 'abc9999' });
    const gh3 = await startFakeGitHub(clock);
    cleanups.push(otherHead.close, gh3.close);
    const d = await setup(otherHead.url, gh3.url, undefined, clock);
    await d.mk(d.db).publish(d.session, d.actor, {});
    expect(d.pushedShas).toEqual(['abc9999']);
    expect(gh3.state.graphqlAt).toBeNull(); // auto-merge never armed
    expect(d.db.getSession('sess-1')).toMatchObject({ publish_state: 'failed_ci', pr_number: 101 });
    expect(d.db.getSession('sess-1')!.publish_error).toMatch(/not the verified commit/);
    // the publish carried its run id to the runner
    expect(otherHead.headers.some((h) => typeof h['x-halley-run-id'] === 'string')).toBe(true);
  });

  it('R12b: the host driver sends { sha } to the supervisor and refuses to forward a different commit', async () => {
    const src = await makeLocalRepo();
    let pushBody: Record<string, unknown> | null = null;
    let mirrorDir = '';
    let pushAs = src.head;
    const sup = await startServer((req, res, url, body) => {
      if (url.pathname.endsWith('/git/push')) {
        pushBody = JSON.parse(body) as Record<string, unknown>;
        // An old supervisor pushes whatever HEAD is: model it by moving the branch to `pushAs`
        execFileSync('git', ['update-ref', `refs/heads/${pushBody.workingBranch as string}`, pushAs], { cwd: mirrorDir });
      }
      res.end('{"ok":true}');
    });
    cleanups.push(sup.close);
    const t = await setup('http://127.0.0.1:1', 'http://127.0.0.1:1');
    const cfg = { ...t.cfg, devLocalRepo: src.dir, workspaceHostUrl: sup.url, workspaceHostSecret: 's' };
    mirrorDir = path.join(cfg.dataDir, 'git-mirror', 'repo.git');
    const hostDriver = new WorkspaceHostDriver(cfg, t.db, new GitHubService(cfg));
    const session = t.db.getSession('sess-1')!;

    pushAs = src.head;
    await expect(hostDriver.pushSessionBranch(session, '', { sha: 'f'.repeat(40) })).rejects.toThrow(/refusing to publish unverified/);
    expect(pushBody).toMatchObject({ workingBranch: 'halley/t', sha: 'f'.repeat(40) });
    expect(() => execFileSync('git', ['rev-parse', '--verify', 'refs/heads/halley/t'], { cwd: src.dir, stdio: 'pipe' })).toThrow();

    await hostDriver.pushSessionBranch(session, '', { sha: src.head });
    expect(execFileSync('git', ['rev-parse', 'refs/heads/halley/t'], { cwd: src.dir }).toString().trim()).toBe(src.head);
  });

  it('R13: concurrent ensureRunning on a sleeping session is single-flight; restart waits for the in-flight boot', async () => {
    const src = await makeLocalRepo();
    const calls: string[] = [];
    let active: string[] = [];
    const sup = await startServer((req, res, url) => {
      if (url.pathname === '/health') {
        res.end(
          JSON.stringify({ ok: true, protocolVersion: 2, instanceId: 'inst-1', activeSessionIds: active, activeCount: active.length }),
        );
        return;
      }
      calls.push(`${req.method} ${url.pathname}`);
      if (url.pathname.endsWith('/start')) {
        setTimeout(() => {
          active = ['sess-1'];
          calls.push('start-done');
          res.end(JSON.stringify({ runnerPort: 4500, astroPort: 4501, astroBase: '/' }));
        }, 60);
        return;
      }
      if (url.pathname.endsWith('/progress')) return res.end('{"progress":null}');
      res.end('{"ok":true}');
    });
    cleanups.push(sup.close);
    const t = await setup('http://127.0.0.1:1', 'http://127.0.0.1:1');
    t.db.updateSession('sess-1', { status: 'sleeping' });
    const cfg = { ...t.cfg, devLocalRepo: src.dir, workspaceHostUrl: sup.url, workspaceHostSecret: 's' };
    const hostDriver = new WorkspaceHostDriver(cfg, t.db, new GitHubService(cfg));
    const s = t.db.getSession('sess-1')!;
    const eps = await Promise.all([1, 2, 3, 4, 5].map(() => hostDriver.ensureRunning(s)));
    const starts = calls.filter((c) => c.endsWith('/start'));
    console.log(`[R13] 5 concurrent ensureRunning → ${starts.length} supervisor /start`);
    expect(starts).toHaveLength(1);
    expect(new Set(eps.map((e) => e.runnerUrl)).size).toBe(1);
    expect(t.db.getSession('sess-1')!.status).toBe('running');

    // Restart while a boot is in flight: it waits for that boot, and later callers join the restart
    calls.length = 0;
    active = [];
    const boot = hostDriver.ensureRunning(t.db.getSession('sess-1')!);
    await waitFor(() => calls.some((c) => c.endsWith('/start')), 5000, 'boot to reach the supervisor');
    const restart = hostDriver.restart(t.db.getSession('sess-1')!);
    const joiner = hostDriver.ensureRunning(t.db.getSession('sess-1')!);
    expect(joiner).toBe(restart);
    await Promise.all([boot, restart]);
    const relevant = calls.filter((c) => c === 'start-done' || c.endsWith('/restart') || c.endsWith('/start'));
    expect(relevant[0]).toMatch(/\/start$/);
    expect(relevant[1]).toBe('start-done');
    expect(relevant[2]).toMatch(/\/restart$/);
    expect(relevant.filter((c) => c.endsWith('/start'))).toHaveLength(2);
  });

  it('R14: /api/health checks the db; /api/health/ready reports db + supervisor readiness', async () => {
    let supOk = true;
    const { cp } = await makeCp(
      stubDriver('http://127.0.0.1:1', {
        getSupervisorReadiness: async () => (supOk ? { ok: true } : { ok: false, error: 'supervisor down' }),
      }),
    );
    expect((await cp.app.request('/api/health')).status).toBe(200);
    const ready = await cp.app.request('/api/health/ready');
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ok: true, db: 'ok', schemaVersion: expect.any(Number) });
    supOk = false;
    const notReady = await cp.app.request('/api/health/ready');
    expect(notReady.status).toBe(503);
    expect(await notReady.json()).toMatchObject({ ok: false, supervisor: { ok: false, error: 'supervisor down' } });
    cp.db.close();
    expect((await cp.app.request('/api/health')).status).toBe(503);
  });

  it('R14b: supervisor readiness is cached and single-flight', async () => {
    let healthCalls = 0;
    let fail = false;
    const sup = await startServer((_req, res, url) => {
      if (url.pathname === '/health') {
        healthCalls += 1;
        if (fail) {
          res.statusCode = 500;
          return res.end('{}');
        }
        return res.end(JSON.stringify({ ok: true, protocolVersion: 2, instanceId: 'i', activeSessionIds: [] }));
      }
      res.end('{}');
    });
    cleanups.push(sup.close);
    const t = await setup('http://127.0.0.1:1', 'http://127.0.0.1:1');
    const clock = new FakeClock();
    const hostDriver = new WorkspaceHostDriver(
      { ...t.cfg, workspaceHostUrl: sup.url, workspaceHostSecret: 's' },
      t.db,
      {} as never,
      { clock },
    );
    const r = await Promise.all([1, 2, 3, 4].map(() => hostDriver.getSupervisorReadiness()));
    expect(r.every((x) => x.ok)).toBe(true);
    expect(healthCalls).toBe(1);
    await hostDriver.getSupervisorReadiness();
    expect(healthCalls).toBe(1); // cached
    fail = true;
    await clock.advance(6_000);
    expect((await hostDriver.getSupervisorReadiness()).ok).toBe(false);
    expect((await hostDriver.getSupervisorReadiness()).ok).toBe(false);
    expect(healthCalls).toBe(2); // failure cached too: probes do not hammer a down supervisor
  });

  it('R15: request ids are honoured/generated, returned, forwarded to the runner, and stamped on logs', async () => {
    const runner = await startFakeRunner({ syncStatus: 200, syncBody: {} });
    cleanups.push(runner.close);
    const { cp } = await makeCp(stubDriver(runner.url));
    const cookie = await loginCp(cp);
    const created = await cp.app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ title: 'T' }),
    });
    const id = ((await created.json()) as { session: { id: string } }).session.id;
    expect(created.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      lines.push(a.map(String).join(' '));
    };
    let res: Response;
    try {
      res = await cp.app.request(`/api/sessions/${id}/verify`, {
        method: 'POST',
        headers: { Cookie: cookie, 'X-Request-Id': 'req-abc.123' },
      });
    } finally {
      console.log = origLog;
    }
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('req-abc.123');
    expect(runner.headers.at(-1)!['x-request-id']).toBe('req-abc.123');
    const access = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'http request');
    expect(access).toMatchObject({ requestId: 'req-abc.123', method: 'POST', status: 200, path: `/api/sessions/${id}/verify` });
    expect(typeof access!.durationMs).toBe('number');

    // A hostile/oversized incoming id is replaced, not echoed
    const bad = await cp.app.request('/api/health', { headers: { 'X-Request-Id': 'x'.repeat(500) } });
    expect(bad.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('R16: JSON API bodies are capped (413) and uploads get the larger upload cap', async () => {
    const { cp } = await makeCp(stubDriver('http://127.0.0.1:1'), { apiBodyLimitBytes: 64 * 1024, uploadBodyLimitBytes: 256 * 1024 });
    const cookie = await loginCp(cp);
    const big = JSON.stringify({ title: 'x'.repeat(100 * 1024) });
    const res = await cp.app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: big,
    });
    expect(res.status).toBe(413);
    // Chunked (no Content-Length) bodies are counted too
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const chunked = await cp.app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(chunked.status).toBe(413);
    // 100 KB under /uploads is within the upload cap: passes the limiter (404 = no such session)
    const up = await cp.app.request('/api/sessions/nope/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Cookie: cookie },
      body: big,
    });
    expect(up.status).toBe(404);
  });

  it('R17: git smart-HTTP streams pushes and fetches through git-http-backend', async () => {
    const { serve } = await import('@hono/node-server');
    const { deriveInternalHostToken } = await import('@halley/shared/auth');
    const src = await makeLocalRepo();
    const { cp, cfg, tmp } = await makeCp(stubDriver('http://127.0.0.1:1'));
    const mirror = path.join(tmp, 'git-mirror', 'repo.git');
    execFileSync('git', ['clone', '-q', '--bare', src.dir, mirror]);
    const { configureBareMirrorForHttp } = await import('../src/git-http.js');
    await configureBareMirrorForHttp(mirror);
    const server = serve({ fetch: cp.app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((r) => server.once('listening', () => r()));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const port = (server.address() as net.AddressInfo).port;
    const token = deriveInternalHostToken(cfg.sessionSecret);
    const remote = `http://127.0.0.1:${port}/internal/git/repo.git`;
    const work = path.join(tmp, 'work');
    const { promisify } = await import('node:util');
    const { execFile } = await import('node:child_process');
    const execFileAsync = promisify(execFile);
    // Async: the server under test runs in this process, so a sync git call would deadlock it
    const git = async (cwd: string, ...args: string[]) =>
      (
        await execFileAsync(
          'git',
          ['-c', `http.extraHeader=Authorization: Bearer ${token}`, '-c', 'user.name=T', '-c', 'user.email=t@x.test', ...args],
          { cwd },
        )
      ).stdout.trim();
    await git(tmp, 'clone', '-q', remote, work);
    // ~3 MB of incompressible data: exercises chunked request streaming on push
    await fs.writeFile(path.join(work, 'blob.bin'), (await import('node:crypto')).randomBytes(3 * 1024 * 1024));
    await git(work, 'add', '.');
    await git(work, 'commit', '-q', '-m', 'big');
    const started = Date.now();
    await git(work, '-c', 'http.postBuffer=65536', 'push', '-q', 'origin', 'HEAD:refs/heads/halley/big');
    const pushMs = Date.now() - started;
    expect(execFileSync('git', ['rev-parse', 'refs/heads/halley/big'], { cwd: mirror }).toString().trim()).toBe(
      await git(work, 'rev-parse', 'HEAD'),
    );
    await expect(git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main')).rejects.toThrow(); // pre-receive hook
    // And fetch it back (streamed response)
    const work2 = path.join(tmp, 'work2');
    await git(tmp, 'clone', '-q', '-b', 'halley/big', remote, work2);
    expect((await fs.stat(path.join(work2, 'blob.bin'))).size).toBe(3 * 1024 * 1024);
    console.log(`[R17] pushed 3 MB over streamed git smart-HTTP in ${pushMs}ms`);
  });

  it('R18: preview proxy streams request bodies to the upstream', async () => {
    let received = 0;
    const astro = await startServer((req, res, _url, body) => {
      received = Buffer.byteLength(body);
      res.end(JSON.stringify({ received }));
    });
    cleanups.push(astro.close);
    const { cp } = await makeCp(stubDriver(astro.url));
    const cookie = await loginCp(cp);
    const created = await cp.app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ title: 'T' }),
    });
    const id = ((await created.json()) as { session: { id: string } }).session.id;
    await waitFor(() => cp.db.getSession(id)!.status !== 'starting' || true, 100);
    const payload = 'y'.repeat(2 * 1024 * 1024);
    const res = await cp.app.request(`/p/${id}/api/form`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'text/plain' },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(received).toBe(payload.length);
  });

  it('R19: schema_version + ordered idempotent migrations adopt a pre-versioning db; indexes exist', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-mig-'));
    cleanups.push(() => fs.rm(tmp, { recursive: true, force: true }));
    const dbPath = path.join(tmp, 'old.sqlite');
    const { DatabaseSync } = await import('node:sqlite');
    // A database from before versioning: old editor_sessions without the later columns
    const old = new DatabaseSync(dbPath);
    old.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, picture TEXT,
        is_admin INTEGER NOT NULL DEFAULT 0, persona TEXT NOT NULL DEFAULT 'non-technical', created_at TEXT NOT NULL, last_login_at TEXT NOT NULL);
      CREATE TABLE editor_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT NOT NULL, owner_user_id TEXT NOT NULL,
        repo TEXT NOT NULL, base_branch TEXT NOT NULL, working_branch TEXT NOT NULL, base_sha TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'starting', publish_state TEXT NOT NULL DEFAULT 'idle', publish_error TEXT,
        pr_number INTEGER, pr_url TEXT, merged_sha TEXT, merged_at TEXT, volume_name TEXT NOT NULL, container_id TEXT,
        runner_url TEXT, astro_url TEXT, workspace_token_hash TEXT NOT NULL, astro_base TEXT NOT NULL DEFAULT '/',
        changed_files_count INTEGER NOT NULL DEFAULT 0, last_active_at TEXT NOT NULL, archived_at TEXT, created_at TEXT NOT NULL);
      INSERT INTO users VALUES ('u1', 'a@x.test', 'A', NULL, 0, 'non-technical', '2025-01-01', '2025-01-01');
      INSERT INTO editor_sessions (id, title, slug, owner_user_id, repo, base_branch, working_branch, volume_name,
        workspace_token_hash, last_active_at, created_at) VALUES ('s1', 'Old', 'old', 'u1', 'o/r', 'main', 'halley/old', 'v', 'h', '2025-01-01', '2025-01-01');
    `);
    old.close();
    const cfg = loadConfig();
    const { LATEST_SCHEMA_VERSION } = await import('../src/db.js');
    const db = new ControlPlaneDb(dbPath, cfg);
    expect(db.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    expect(db.getSession('s1')).toMatchObject({ kind: 'edit', lease_epoch: 0, title: 'Old' });
    const idx = (db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(['idx_sessions_token_hash', 'idx_spend_events_user_day', 'idx_publish_runs_step', 'idx_sessions_status_active']));
    const plan = db.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM editor_sessions WHERE workspace_token_hash = ?').all('h') as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join(' ')).toMatch(/idx_sessions_token_hash/);
    db.close();
    // Re-opening is a no-op (no migration re-applied)
    const again = new ControlPlaneDb(dbPath, cfg);
    expect((again.db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as { n: number }).n).toBe(LATEST_SCHEMA_VERSION);
    again.close();
  });

  it('R19b: spend_events retention rolls old rows into daily rollups; online backups keep the last N', async () => {
    const t = await setup('http://127.0.0.1:1', 'http://127.0.0.1:1');
    const uid = t.session.owner_user_id;
    const now = Date.parse('2026-06-30T12:00:00Z');
    t.db.recordSpend(uid, 1.5, 100, 10, '2026-01-01', { purpose: 'chat', model: 'm' });
    t.db.recordSpend(uid, 0.5, 50, 5, '2026-01-01', { purpose: 'chat', model: 'm' });
    t.db.recordSpend(uid, 0.25, 10, 1, '2026-01-01', { purpose: 'sync', model: 'm' });
    t.db.recordSpend(uid, 2, 10, 1, '2026-06-29', { purpose: 'chat', model: 'm' });
    expect(t.db.pruneSpendEvents(90, now)).toBe(3);
    expect((t.db.db.prepare('SELECT COUNT(*) AS n FROM spend_events').get() as { n: number }).n).toBe(1);
    const roll = t.db.db.prepare('SELECT purpose, request_count, cost_usd FROM spend_daily_purpose ORDER BY purpose').all();
    expect(roll).toEqual([
      { purpose: 'chat', request_count: 2, cost_usd: 2 },
      { purpose: 'sync', request_count: 1, cost_usd: 0.25 },
    ]);
    expect(t.db.getSpendStatus(uid, '2026-01-01').spentTodayUsd).toBe(2.25); // daily totals untouched
    expect(t.db.pruneSpendEvents(90, now)).toBe(0);

    const { runMaintenancePass, newMaintenanceState } = await import('../src/reaper.js');
    const cfg = { ...t.cfg, dbBackupIntervalMs: 24 * 3600_000, dbBackupKeep: 7 };
    const state = newMaintenanceState();
    const backups = path.join(cfg.dataDir, 'backups');
    for (let day = 0; day < 9; day++) {
      await runMaintenancePass(cfg, t.db, state, now + day * 24 * 3600_000);
    }
    const files = (await fs.readdir(backups)).sort();
    expect(files).toHaveLength(7);
    expect(files.at(-1)).toBe('control-plane-2026-07-08.sqlite');
    // A second pass the same day does not write again
    await runMaintenancePass(cfg, t.db, state, now + 8 * 24 * 3600_000 + 3600_000);
    expect(await fs.readdir(backups)).toHaveLength(7);
    // The backup is a valid, complete database
    const { DatabaseSync } = await import('node:sqlite');
    const copy = new DatabaseSync(path.join(backups, files.at(-1)!), { readOnly: true });
    expect((copy.prepare('SELECT COUNT(*) AS n FROM editor_sessions').get() as { n: number }).n).toBe(1);
    copy.close();
  });

  it('R20: manual merges are reconciled by the maintenance pass (bounded, cached, full finalize); /api/history makes no PR calls', async () => {
    let inflight = 0;
    let maxInflight = 0;
    let commitCalls = 0;
    let prCalls = 0;
    const TOTAL = 6;
    let served = 0;
    // Hold PR responses until every request the concurrency limit allows is in flight (no timers)
    const held: Array<() => void> = [];
    const gh = await startServer((req, res, url) => {
      if (url.pathname.endsWith('/commits')) {
        commitCalls += 1;
        return res.end(JSON.stringify([{ sha: 'c'.repeat(40), commit: { message: 'dev commit', author: { name: 'Dev', date: '2026-01-01T00:00:00Z' } } }]));
      }
      const m = url.pathname.match(/\/pulls\/(\d+)$/);
      if (m) {
        prCalls += 1;
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        const n = Number(m[1]);
        held.push(() => {
          inflight -= 1;
          served += 1;
          res.end(
            JSON.stringify(
              n === 205
                ? { number: n, merged: true, state: 'closed', head: { sha: 'h' }, merge_commit_sha: 'm'.repeat(40) }
                : { number: n, merged: false, state: 'open', head: { sha: 'h' }, merge_commit_sha: null },
            ),
          );
        });
        if (held.length === Math.min(3, TOTAL - served)) for (const release of held.splice(0)) release();
        return;
      }
      res.end('{}');
    });
    const runnerCalls: string[] = [];
    const runner = await startServer((req, res, url) => {
      runnerCalls.push(`${req.method} ${url.pathname}`);
      if (url.pathname === '/internal/transcript') return res.end(JSON.stringify({ entries: [{ role: 'user', text: 'hi' }] }));
      if (url.pathname === '/internal/git/changes') return res.end(JSON.stringify({ changes: [] }));
      res.end('{}');
    });
    cleanups.push(gh.close, runner.close);
    const stopped: string[] = [];
    const { cp } = await makeCp(
      stubDriver('http://127.0.0.1:1', { stop: async (s) => void stopped.push(s.id) }),
      { githubApiBaseUrl: gh.url, githubToken: 't', githubAppId: '' },
    );
    const cookie = await loginCp(cp);
    const ids: string[] = [];
    for (let i = 0; i < TOTAL; i++) {
      const r = await cp.app.request('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ title: `S${i}` }),
      });
      const id = ((await r.json()) as { session: { id: string } }).session.id;
      ids.push(id);
      cp.db.updateSession(id, { pr_number: 200 + i, pr_url: `https://github.test/o/r/pull/${200 + i}`, status: 'running' });
    }
    const mergedId = ids[5]!;
    cp.db.updateSession(mergedId, { runner_url: runner.url });

    const h1 = await cp.app.request('/api/history', { headers: { Cookie: cookie } });
    expect(h1.status).toBe(200);
    expect(((await h1.json()) as { entries: unknown[] }).entries).toHaveLength(1);
    await cp.app.request('/api/history', { headers: { Cookie: cookie } });
    expect(commitCalls).toBe(1); // second load served from the 30s cache
    expect(prCalls).toBe(0); // reconciliation is off the request path

    const pass = await cp.publishService.reconcileManualMerges();
    expect(pass).toEqual({ checked: TOTAL, finalized: 1 });
    expect(prCalls).toBe(TOTAL);
    expect(maxInflight).toBe(3);
    // Same finalize path as a Halley publish: merged sha, read-only, archived, published, stopped
    expect(cp.db.getSession(mergedId)).toMatchObject({ status: 'published', publish_state: 'published', merged_sha: 'm'.repeat(40) });
    expect(cp.db.getSession(mergedId)!.archived_at).not.toBeNull();
    expect(cp.db.getSessionArchive(mergedId)?.mergedSha).toBe('m'.repeat(40));
    expect(runnerCalls).toContain('POST /internal/read-only');
    expect(runnerCalls).toContain('GET /internal/transcript');
    expect(stopped).toContain(mergedId);
    for (const id of ids.slice(0, 5)) expect(cp.db.getSession(id)!.status).toBe('running');

    // Each PR is re-checked at most once per MANUAL_MERGE_RECHECK_MS
    expect(await cp.publishService.reconcileManualMerges()).toEqual({ checked: 0, finalized: 0 });
    expect(prCalls).toBe(TOTAL);
  });
});
