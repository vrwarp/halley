/**
 * Regressions for the review items: durable crash-loop state, pre-PR exclude rollback on resume,
 * workspace-token miss cache, revert-start markers, LLM proxy body forwarding and stream drain,
 * review screenshots served by id, and publish poll loops stopping cleanly on shutdown.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { FetchFn } from '../src/clock.js';
import { loadConfig } from '../src/config.js';
import { ControlPlaneDb } from '../src/db.js';
import { CrashLoopTracker, WorkspaceCrashLoopError, type WorkspaceDriver } from '../src/drivers/workspace-driver.js';
import { GitHubService } from '../src/github/client.js';
import { createControlPlane } from '../src/index.js';
import { createLlmProxyHandler } from '../src/proxy/llm-proxy.js';
import { PublishService } from '../src/routes/publish.js';
import { externalizeDataUrls, ScreenshotStore } from '../src/screenshot-store.js';
import { FakeClock } from './helpers/fake-clock.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()!();
});

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const urlOf = (input: Parameters<FetchFn>[0]) =>
  new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setImmediate(r));
  expect(cond()).toBe(true);
}

function seedSession(db: ControlPlaneDb, id = 'sess-1') {
  const user = db.upsertUser({ email: 'e@x.test', name: 'E', picture: null });
  db.createSession({
    id,
    title: 'T',
    slug: 't',
    ownerUserId: user.id,
    repo: 'o/r',
    baseBranch: 'main',
    workingBranch: `halley/${id}`,
    volumeName: `v-${id}`,
    workspaceTokenHash: `h-${id}`,
  });
  db.updateSession(id, { status: 'running' });
  return user;
}

describe('a. crash-loop breaker state survives a restart', () => {
  it('persists failures and the open breaker in SQLite; reset clears the row', async () => {
    const dir = await tmpDir('halley-crash-');
    const cfg = { ...loadConfig(), dataDir: dir };
    const clock = new FakeClock({ start: 1_000_000 });
    const dbPath = path.join(dir, 'cp.sqlite');
    let db = new ControlPlaneDb(dbPath, cfg, { clock });
    seedSession(db);
    const opts = { threshold: 3, windowMs: 60_000, cooldownsMs: [10_000, 30_000], clock };
    const t1 = new CrashLoopTracker({ ...opts, store: db });
    t1.recordFailure('sess-1', 'exit 137', { oom: true });
    t1.recordFailure('sess-1', 'exit 137', { oom: true });
    expect(t1.recordFailure('sess-1', 'OOMKilled', { oom: true }).crashLoop).toBe(true);
    db.close();

    // "Restart": a new process opens the same database
    db = new ControlPlaneDb(dbPath, cfg, { clock });
    cleanups.push(() => db.close());
    const t2 = new CrashLoopTracker({ ...opts, store: db });
    expect(() => t2.assertCanAttempt('sess-1')).toThrow(WorkspaceCrashLoopError);
    expect(t2.getInfo('sess-1')).toMatchObject({ crashLoop: true, oom: true, failureCount: 3 });

    t2.reset('sess-1');
    expect(db.listCrashLoopRecords()).toEqual([]);
    expect(() => new CrashLoopTracker({ ...opts, store: db }).assertCanAttempt('sess-1')).not.toThrow();
  });

  it('drops stale rows on load', async () => {
    const dir = await tmpDir('halley-crash2-');
    const clock = new FakeClock({ start: 1_000_000 });
    const db = new ControlPlaneDb(path.join(dir, 'cp.sqlite'), { ...loadConfig(), dataDir: dir }, { clock });
    cleanups.push(() => db.close());
    db.saveCrashLoopRecord('old', { failures: [1], openCount: 1, openUntil: 2, lastError: 'x', oom: false });
    new CrashLoopTracker({ clock, store: db });
    expect(db.listCrashLoopRecords()).toEqual([]);
  });
});

describe('c. interrupted pre-PR run restores excluded paths on resume', () => {
  async function setup(clock: FakeClock) {
    const dir = await tmpDir('halley-resume-');
    const cfg = { ...loadConfig(), dataDir: dir };
    const db = new ControlPlaneDb(path.join(dir, 'cp.sqlite'), cfg, { clock });
    cleanups.push(() => db.close());
    const user = seedSession(db);
    let runnerUp = false;
    const restores: unknown[] = [];
    const driver: WorkspaceDriver = {
      ensureRunning: async () => {
        if (!runnerUp) throw new Error('connect ECONNREFUSED');
        return { runnerUrl: 'http://runner.test', astroUrl: '', astroBase: '/', baseSha: 'abc' };
      },
      stop: async () => {},
      destroy: async () => {},
      duplicateWorkspace: async () => {},
      pushSessionBranch: async () => {},
      fetchIntoSession: async () => {},
    };
    const fetchImpl: FetchFn = async (input, init) => {
      if (urlOf(input).pathname === '/internal/git/restore-sha') restores.push(JSON.parse(String(init?.body)));
      return json(200, { ok: true });
    };
    const svc = new PublishService(cfg, db, driver, {} as never, () => {}, undefined, undefined, { clock, fetch: fetchImpl });
    return { db, user, svc, restores, setRunnerUp: (v: boolean) => (runnerUp = v) };
  }

  it('keeps the run while the runner is unreachable and restores on the next reconcile pass', async () => {
    const clock = new FakeClock();
    const t = await setup(clock);
    t.db.upsertPublishRun({ sessionId: 'sess-1', runId: 'run-1', actorUserId: t.user.id, step: 'verifying', preExcludeSha: 'p'.repeat(40) });
    t.db.updateSession('sess-1', { publish_state: 'verifying' });

    t.svc.resumeIncompletePublishes();
    await until(() => !t.svc.isPublishActive('sess-1'));
    expect(t.db.getPublishRun('sess-1')?.run_id).toBe('run-1'); // kept for retry
    expect(t.db.getSession('sess-1')!.publish_state).toBe('verifying');
    expect(t.restores).toEqual([]);

    t.setRunnerUp(true);
    await t.svc.reconcileArmedRuns();
    expect(t.restores).toEqual([{ targetSha: 'p'.repeat(40) }]);
    expect(t.db.getPublishRun('sess-1')).toBeNull();
    expect(t.db.getSession('sess-1')!.publish_state).toBe('idle');
  });

  it('does not roll back once the branch was pushed, and resets plain interrupted runs synchronously', async () => {
    const clock = new FakeClock();
    const t = await setup(clock);
    t.setRunnerUp(true);
    // No exclude commit: reset without touching the runner
    t.db.upsertPublishRun({ sessionId: 'sess-1', runId: 'run-1', actorUserId: t.user.id, step: 'verifying' });
    t.db.updateSession('sess-1', { publish_state: 'verifying' });
    t.svc.resumeIncompletePublishes();
    expect(t.db.getPublishRun('sess-1')).toBeNull();
    expect(t.db.getSession('sess-1')!.publish_state).toBe('idle');
    expect(t.restores).toEqual([]);
  });
});

describe('d. workspace token resolution', () => {
  it('caches misses so a repeated bad token does not rescan every session; any token change clears it', async () => {
    const dir = await tmpDir('halley-token-');
    const clock = new FakeClock();
    const db = new ControlPlaneDb(path.join(dir, 'cp.sqlite'), { ...loadConfig(), dataDir: dir }, { clock });
    cleanups.push(() => db.close());
    seedSession(db);
    const scan = vi.spyOn(db, 'listSessions');
    expect(db.resolveSessionByWorkspaceToken('bad-token')).toBeNull();
    expect(db.resolveSessionByWorkspaceToken('bad-token')).toBeNull();
    expect(scan).toHaveBeenCalledTimes(1);
    db.updateSession('sess-1', { token_epoch: 1 });
    expect(db.resolveSessionByWorkspaceToken('bad-token')).toBeNull();
    expect(scan).toHaveBeenCalledTimes(2);
    await clock.advance(ControlPlaneDb.TOKEN_MISS_TTL_MS);
    expect(db.resolveSessionByWorkspaceToken('bad-token')).toBeNull();
    expect(scan).toHaveBeenCalledTimes(3);
  });
});

describe('e. revert-start failure leaves a durable marker and is retried by the chat bridge', () => {
  it('records a retryable failure, then the next chat connection applies the revert and clears it', async () => {
    const dir = await tmpDir('halley-revert-');
    const cfg = {
      ...loadConfig(),
      dataDir: dir,
      devLoginEnabled: true,
      allowedDomains: ['x.test'],
      publicUrl: '',
      githubToken: '',
      githubAppId: '',
      devLocalRepo: '',
    };
    let workspaceUp = false;
    const driver: WorkspaceDriver = {
      ensureRunning: async () => {
        if (!workspaceUp) throw new Error('Workspace failed to boot');
        return { runnerUrl: 'http://runner.test', astroUrl: '', astroBase: '/', baseSha: 'abc' };
      },
      stop: async () => {},
      destroy: async () => {},
      duplicateWorkspace: async () => {},
      pushSessionBranch: async () => {},
      fetchIntoSession: async () => {},
    };
    const revertCalls: unknown[] = [];
    const fetchImpl: FetchFn = async (input, init) => {
      const p = urlOf(input).pathname;
      if (p === '/internal/git/revert-start') {
        revertCalls.push(JSON.parse(String(init?.body)));
        return json(200, { status: 'clean', revertCheckpointSha: 'r'.repeat(40), changedFilesCount: 2 });
      }
      return json(200, { ok: true });
    };
    const screenshots = { prewarm: () => {}, close: async () => {} } as never;
    const cp = createControlPlane(cfg, driver, screenshots, { fetch: fetchImpl });
    cleanups.push(() => {
      cp.dispose();
      cp.db.close();
    });
    const login = await cp.app.request('/api/auth/dev-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@x.test', name: 'A' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const sha = 'a'.repeat(40);
    const res = await cp.app.request('/api/sessions/revert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ sha, reason: 'broke the homepage' }),
    });
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as { session: { id: string } };
    const row = cp.db.getSession(session.id)!;
    expect(JSON.parse(row.revert_pending_json!)).toMatchObject({ shas: [sha] });
    expect(row.revert_start_error).toMatch(/^retryable:Workspace failed to boot/);
    expect(revertCalls).toEqual([]);

    // The editor opens the Undo draft once the workspace is up
    workspaceUp = true;
    const wss = new WebSocketServer({ noServer: true });
    const server = http.createServer();
    server.on('upgrade', (req, socket, head) => cp.handleWsUpgrade(req, socket, head, wss));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    cleanups.push(async () => {
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    });
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as net.AddressInfo).port}/ws/sessions/${session.id}`, {
      headers: { Cookie: cookie },
    });
    ws.on('error', () => {});
    cleanups.push(() => ws.terminate());
    await until(() => revertCalls.length === 1 && !cp.db.getSession(session.id)!.revert_pending_json);
    expect(revertCalls).toEqual([{ shas: [sha] }]);
    expect(cp.db.getSession(session.id)).toMatchObject({
      revert_pending_json: null,
      revert_start_error: null,
      initial_revert_sha: 'r'.repeat(40),
    });
  });
});

describe('g. LLM proxy', () => {
  async function makeProxy(upstream: FetchFn) {
    const dir = await tmpDir('halley-llm-');
    const cfg = { ...loadConfig(), dataDir: dir, anthropicApiKey: 'k', anthropicBaseUrl: 'https://llm.test' };
    const db = new ControlPlaneDb(path.join(dir, 'cp.sqlite'), cfg);
    cleanups.push(() => db.close());
    seedSession(db);
    db.updateSession('sess-1', { workspace_token_hash: (await import('@halley/shared/auth')).hashWorkspaceToken('tok') });
    const handler = createLlmProxyHandler(cfg, db, undefined, { fetch: upstream });
    const app = new Hono();
    app.all('/internal/llm/anthropic/*', handler);
    const call = (body: string) =>
      app.request('/internal/llm/anthropic/v1/messages', {
        method: 'POST',
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
        body,
      });
    return { db, handler, call };
  }

  it('forwards the original body bytes when the model needs no rewrite, and canonicalizes otherwise', async () => {
    const seen: string[] = [];
    const upstream: FetchFn = async (_input, init) => {
      const b = init?.body;
      seen.push(typeof b === 'string' ? b : new TextDecoder().decode(b as Uint8Array));
      return json(200, { model: 'claude-haiku-5-5', usage: { input_tokens: 1, output_tokens: 1 } });
    };
    const p = await makeProxy(upstream);
    const original = '{ "model": "claude-haiku-5-5",  "max_tokens": 5, "messages": [] }';
    expect((await p.call(original)).status).toBe(200);
    expect(seen[0]).toBe(original); // byte-for-byte, whitespace included

    // Duplicate model keys: upstream must see exactly the model the allowlist checked
    await p.call('{"model":"claude-opus-4-1","max_tokens":5,"model":"claude-haiku-5-5"}');
    expect(JSON.parse(seen[1]!)).toEqual({ model: 'claude-haiku-5-5', max_tokens: 5 });
    expect(seen[1]!.match(/"model"/g)).toHaveLength(1);
    // Missing model: the default is filled in
    await p.call('{"max_tokens":5}');
    expect(JSON.parse(seen[2]!).model).toBe(loadConfig().modelId);
  });

  it('drain() bills in-flight streams before shutdown closes the database', async () => {
    const enc = new TextEncoder();
    const upstream: FetchFn = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              enc.encode(
                `data: ${JSON.stringify({ type: 'message_start', message: { model: 'claude-haiku-5-5', usage: { input_tokens: 1000, output_tokens: 1 } } })}\n`,
              ),
            );
            // ...and never finishes
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    const p = await makeProxy(upstream);
    const res = await p.call('{"model":"claude-haiku-5-5","stream":true}');
    const reader = res.body!.getReader();
    await reader.read(); // first event passed through
    expect(p.handler.inFlightStreams()).toBe(1);
    const before = p.db.getSpendStatus(p.db.getSession('sess-1')!.owner_user_id).spentTodayUsd;
    p.handler.drain();
    expect(p.handler.inFlightStreams()).toBe(0);
    const after = p.db.getSpendStatus(p.db.getSession('sess-1')!.owner_user_id).spentTodayUsd;
    expect(after).toBeGreaterThan(before);
  });
});

describe('g. review screenshots by id', () => {
  it('externalizes base64 data URLs into a bounded store', () => {
    const clock = new FakeClock();
    let n = 0;
    const store = new ScreenshotStore({ clock, randomUUID: () => `id-${++n}`, maxBytes: 6 });
    const png = Buffer.from([1, 2, 3, 4]);
    const page = {
      route: '/',
      draftScreenshotDataUrl: `data:image/webp;base64,${png.toString('base64')}`,
      shots: { mobile: { liveScreenshotDataUrl: `data:image/jpeg;base64,${png.toString('base64')}`, highlights: [] } },
      title: 'data:image/png;base64,AAAA', // not a *DataUrl field: untouched
    };
    externalizeDataUrls(page, store, (id) => `/api/screenshots/${id}`);
    expect(page.draftScreenshotDataUrl).toBe('/api/screenshots/id-1');
    expect(page.shots.mobile.liveScreenshotDataUrl).toBe('/api/screenshots/id-2');
    expect(page.title).toBe('data:image/png;base64,AAAA');
    // 8 bytes > maxBytes 6: the oldest was evicted
    expect(store.get('id-1')).toBeNull();
    expect(store.get('id-2')).toMatchObject({ contentType: 'image/jpeg', bytes: png });
  });

  it('per-route screenshot calls share one cached review-metadata fetch and return image URLs', async () => {
    const dir = await tmpDir('halley-shots-');
    const cfg = { ...loadConfig(), dataDir: dir, devLoginEnabled: true, allowedDomains: ['x.test'] };
    const driver: WorkspaceDriver = {
      ensureRunning: async () => ({ runnerUrl: 'http://runner.test', astroUrl: 'http://astro.test', astroBase: '/', baseSha: 'abc' }),
      stop: async () => {},
      destroy: async () => {},
      duplicateWorkspace: async () => {},
      pushSessionBranch: async () => {},
      fetchIntoSession: async () => {},
    };
    let reviewFetches = 0;
    const fetchImpl: FetchFn = async (input) => {
      if (urlOf(input).pathname === '/internal/review') {
        reviewFetches += 1;
        return json(200, { draftFiles: [], mergedFromLiveFiles: [], astroReady: true, baseSha: 'abc' });
      }
      return json(200, { ok: true });
    };
    const jpg = Buffer.from('fake-jpeg-bytes');
    const screenshots = {
      prewarm: () => {},
      close: async () => {},
      captureRouteReview: async (o: { route: string }) => ({
        route: o.route,
        title: o.route,
        highlights: [],
        liveTimestamp: '',
        draftScreenshotDataUrl: `data:image/jpeg;base64,${jpg.toString('base64')}`,
      }),
    } as never;
    const cp = createControlPlane(cfg, driver, screenshots, { fetch: fetchImpl });
    cleanups.push(() => {
      cp.dispose();
      cp.db.close();
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
    const { session } = (await created.json()) as { session: { id: string } };
    const urls: string[] = [];
    for (const route of ['/', '/about', '/contact']) {
      const r = await cp.app.request(`/api/sessions/${session.id}/review/screenshot?route=${route}`, { headers: { Cookie: cookie } });
      expect(r.status).toBe(200);
      urls.push(((await r.json()) as { page: { draftScreenshotDataUrl: string } }).page.draftScreenshotDataUrl);
    }
    expect(reviewFetches).toBe(1);
    expect(urls.every((u) => u.startsWith('/api/screenshots/'))).toBe(true);
    const img = await cp.app.request(urls[0]!, { headers: { Cookie: cookie } });
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/jpeg');
    expect(img.headers.get('cache-control')).toMatch(/max-age=\d+, immutable/);
    expect(Buffer.from(await img.arrayBuffer())).toEqual(jpg);
    expect((await cp.app.request(urls[0]!)).status).toBe(401);
    // Legacy embedding stays available
    const legacy = await cp.app.request(`/api/sessions/${session.id}/review/screenshot?route=/&screenshotFormat=dataurl`, {
      headers: { Cookie: cookie },
    });
    expect(((await legacy.json()) as { page: { draftScreenshotDataUrl: string } }).page.draftScreenshotDataUrl).toMatch(
      /^data:image\/jpeg;base64,/,
    );
  });
});

describe('g. shutdown stops publish poll loops without touching state', () => {
  it('a CI wait parked on fake time exits on shutdown(); the run stays for resume', async () => {
    const dir = await tmpDir('halley-shutdown-');
    const clock = new FakeClock();
    const cfg = { ...loadConfig(), dataDir: dir, repo: 'o/r', githubApiBaseUrl: 'https://gh.test', githubToken: 't', githubAppId: '' };
    const db = new ControlPlaneDb(path.join(dir, 'cp.sqlite'), cfg, { clock });
    cleanups.push(() => db.close());
    const user = seedSession(db);
    let prChecks = 0;
    const ghFetch: FetchFn = async (input) => {
      const p = urlOf(input).pathname;
      if (/\/pulls\/\d+$/.test(p)) {
        prChecks += 1;
        return json(200, { number: 7, merged: false, state: 'open', head: { sha: 'h'.repeat(40) }, merge_commit_sha: null });
      }
      if (p.endsWith('/check-runs')) return json(200, { total_count: 1, check_runs: [{ name: 'ci', status: 'in_progress', conclusion: null }] });
      if (p.endsWith('/status')) return json(200, { state: 'pending', statuses: [] });
      return json(200, {});
    };
    const github = new GitHubService(cfg, { maxAttempts: 1 }, { clock, fetch: ghFetch });
    const driver = { stop: async () => {} } as unknown as WorkspaceDriver;
    const svc = new PublishService(cfg, db, driver, github, () => {}, undefined, { ciPollIntervalMs: 1000 }, { clock });
    db.upsertPublishRun({
      sessionId: 'sess-1',
      runId: 'run-1',
      actorUserId: user.id,
      step: 'waiting_ci',
      localHeadSha: 'h'.repeat(40),
      prNumber: 7,
      prUrl: 'https://gh.test/o/r/pull/7',
    });
    db.updateSession('sess-1', { publish_state: 'waiting_ci', pr_number: 7, pr_url: 'https://gh.test/o/r/pull/7' });
    svc.resumeIncompletePublishes();
    await until(() => prChecks === 1 && clock.pendingTimers() === 1); // parked in the poll sleep
    svc.shutdown();
    await until(() => !svc.isPublishActive('sess-1'));
    expect(prChecks).toBe(1);
    expect(db.getPublishRun('sess-1')?.step).toBe('waiting_ci');
    expect(db.getSession('sess-1')!.publish_state).toBe('waiting_ci');
  });
});
