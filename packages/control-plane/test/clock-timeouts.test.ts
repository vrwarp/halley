/**
 * Request deadlines and the chat WebSocket keepalive run on the injected Clock: with a FakeClock
 * they fire exactly when virtual time passes them, with no wall-clock waits.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Browser } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { timeoutSignal, type FetchFn } from '../src/clock.js';
import { loadConfig } from '../src/config.js';
import type { WorkspaceDriver } from '../src/drivers/workspace-driver.js';
import { GitHubService } from '../src/github/client.js';
import { createControlPlane } from '../src/index.js';
import { AnyJsonSchema, createRunnerClient, RunnerError } from '../src/runner-client.js';
import { ScreenshotService } from '../src/screenshot-service.js';
import { FakeClock } from './helpers/fake-clock.js';

/** A transport that never answers, but rejects with the signal's reason once it aborts (like fetch). */
function hangingFetch(calls: string[] = []): FetchFn {
  return (input, init) => {
    calls.push(String(input));
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
}

/** Waits (on real I/O and microtasks, not time) until `cond` holds. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  expect(cond()).toBe(true);
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()!();
});

describe('FakeClock.timeoutSignal', () => {
  it('aborts with a TimeoutError exactly at the deadline and combines with another signal', async () => {
    const clock = new FakeClock();
    const s = clock.timeoutSignal(1000);
    await clock.advance(999);
    expect(s.aborted).toBe(false);
    await clock.advance(1);
    expect(s.aborted).toBe(true);
    expect((s.reason as DOMException).name).toBe('TimeoutError');

    const ac = new AbortController();
    const combined = timeoutSignal(clock, 5000, ac.signal);
    ac.abort(new Error('caller gave up'));
    expect(combined.aborted).toBe(true);
    expect((combined.reason as Error).message).toBe('caller gave up');
  });

  it('a pending deadline never drives auto-advance on its own', async () => {
    const clock = new FakeClock({ autoAdvance: true });
    const s = clock.timeoutSignal(1000);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(s.aborted).toBe(false);
    expect(clock.pendingTimers()).toBe(0);
    expect(clock.pendingTimeoutSignals()).toBe(1);
    // ...but time moving for an ordinary timer past the deadline fires it
    await clock.sleep(1500);
    expect(s.aborted).toBe(true);
  });
});

describe('runner calls on the injected clock', () => {
  it('a runner call that never responds fails with a timeout exactly when fake time passes the deadline', async () => {
    const clock = new FakeClock();
    const runner = createRunnerClient(hangingFetch(), clock);
    const wallStart = performance.now();
    let settled: unknown = 'pending';
    const p = runner
      .callRunner('http://runner.test', '/internal/verify', AnyJsonSchema, { timeoutMs: 600_000 })
      .then(
        () => (settled = 'resolved'),
        (err: unknown) => (settled = err),
      );
    await clock.advance(599_999);
    expect(settled).toBe('pending');
    await clock.advance(1);
    await p;
    expect(settled).toBeInstanceOf(RunnerError);
    expect((settled as RunnerError).kind).toBe('timeout');
    expect((settled as RunnerError).message).toContain('timed out after 600000ms');
    expect(performance.now() - wallStart).toBeLessThan(1000); // a 10-minute deadline, no wall wait
  });
});

describe('GitHub request timeout', () => {
  it('a hung GitHub request times out at 15s of fake time and is retried after the backoff', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // backoff = baseDelay/2, deterministic
    const clock = new FakeClock();
    const calls: number[] = [];
    let n = 0;
    const fetchImpl: FetchFn = (input, init) => {
      calls.push(clock.now());
      n += 1;
      if (n === 1) return hangingFetch()(input, init);
      return Promise.resolve(
        new Response(
          JSON.stringify([{ number: 7, html_url: 'https://github.test/o/r/pull/7', node_id: 'PR_7', head: { sha: 'a'.repeat(40) } }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    };
    const cfg = { ...loadConfig(), repo: 'o/r', githubApiBaseUrl: 'https://api.github.test', githubToken: 't', githubAppId: '' };
    const gh = new GitHubService(cfg, { maxAttempts: 2, baseDelayMs: 400 }, { clock, fetch: fetchImpl });
    const t0 = clock.now();
    const p = gh.findOpenPrForBranch('halley/x');
    await until(() => calls.length === 1);
    await clock.advance(14_999);
    expect(calls).toEqual([t0]);
    await clock.advance(1); // deadline: abort -> network-error retry path, backoff 200ms
    expect(calls).toHaveLength(1);
    await clock.advance(199);
    expect(calls).toHaveLength(1);
    await clock.advance(1);
    const pr = await p;
    expect(calls).toEqual([t0, t0 + 15_200]);
    expect(pr?.number).toBe(7);
  });

  it('with no attempts left the TimeoutError surfaces', async () => {
    const clock = new FakeClock();
    const cfg = { ...loadConfig(), repo: 'o/r', githubApiBaseUrl: 'https://api.github.test', githubToken: 't', githubAppId: '' };
    const gh = new GitHubService(cfg, { maxAttempts: 1 }, { clock, fetch: hangingFetch() });
    const p = gh.findOpenPrForBranch('halley/x').catch((e: unknown) => e);
    await until(() => clock.pendingTimeoutSignals() === 1);
    await clock.advance(14_999);
    expect(clock.pendingTimeoutSignals()).toBe(1);
    await clock.advance(1);
    expect(((await p) as DOMException).name).toBe('TimeoutError');
  });
});

describe('chat WebSocket keepalive on the injected clock', () => {
  async function setup(runnerUrl: string) {
    const clock = new FakeClock({ start: Date.parse('2026-03-01T12:00:00Z') });
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-ws-clock-'));
    const cfg = {
      ...loadConfig(),
      dataDir,
      devLoginEnabled: true,
      allowedDomains: ['example.test'],
      publicUrl: '',
      sessionSecret: 'ws-clock-test-secret-0123456789abcdef',
    };
    const driver: WorkspaceDriver = {
      ensureRunning: async () => ({ runnerUrl, astroUrl: 'http://astro.test', astroBase: '/', baseSha: 'abc1234' }),
      stop: async () => {},
      destroy: async () => {},
      duplicateWorkspace: async () => {},
      pushSessionBranch: async () => {},
      fetchIntoSession: async () => {},
    };
    const screenshots = new ScreenshotService({
      clock,
      launchBrowser: async () =>
        Object.assign(new EventEmitter(), { isConnected: () => true, close: async () => {} }) as unknown as Browser,
    });
    const cp = createControlPlane(cfg, driver, screenshots, { clock, fetch: hangingFetch() });
    const wss = new WebSocketServer({ noServer: true });
    const server = http.createServer((_req, res) => res.end());
    server.on('upgrade', (req, socket, head) => cp.handleWsUpgrade(req, socket, head, wss));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    cleanups.push(async () => {
      cp.dispose();
      await screenshots.close();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      cp.db.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    const login = await cp.app.request('/api/auth/dev-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'editor@example.test', name: 'Editor' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const created = await cp.app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ title: 'WS' }),
    });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as { session: { id: string } };
    cp.db.updateSession(session.id, { status: 'running' });

    const port = (server.address() as net.AddressInfo).port;
    const browser = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${session.id}`, { headers: { Cookie: cookie } });
    const pings: number[] = [];
    browser.on('ping', () => pings.push(clock.now()));
    const closed = new Promise<number>((r) => browser.on('close', (code) => r(code)));
    await new Promise<void>((resolve, reject) => {
      browser.once('open', () => resolve());
      browser.once('error', reject);
    });
    cleanups.push(() => browser.terminate());
    return { clock, browser, pings, closed };
  }

  it('pings the browser every 20s of fake time and drops a runner connection stuck connecting', async () => {
    // Accepts TCP but never answers the WebSocket handshake
    const held = new Set<net.Socket>();
    const stuck = net.createServer((s) => held.add(s));
    await new Promise<void>((r) => stuck.listen(0, '127.0.0.1', () => r()));
    cleanups.push(async () => {
      for (const s of held) s.destroy();
      await new Promise<void>((r) => stuck.close(() => r()));
    });
    const { clock, pings, closed } = await setup(`http://127.0.0.1:${(stuck.address() as net.AddressInfo).port}`);
    await until(() => held.size === 1); // the bridge is dialing the runner
    const t0 = clock.now();

    await clock.advance(19_999);
    expect(pings).toEqual([]);
    await clock.advance(1);
    await until(() => pings.length === 1);
    expect(pings).toEqual([t0 + 20_000]);

    // Still connecting a whole interval later: the runner leg is terminated and the browser told to reconnect
    await clock.advance(20_000);
    expect(await closed).toBe(1012);
    expect(pings).toEqual([t0 + 20_000, t0 + 40_000]);
  });

  it('drops an open runner connection that stops answering pings', async () => {
    const runnerWss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => runnerWss.once('listening', () => r()));
    const received: string[] = [];
    runnerWss.on('connection', (ws) => {
      ws.once('message', (d) => {
        received.push(d.toString());
        // Wedge the runner: it stops reading, so pings go unanswered
        (ws as unknown as { _socket: net.Socket })._socket.pause();
      });
    });
    cleanups.push(async () => {
      for (const c of runnerWss.clients) c.terminate();
      await new Promise<void>((r) => runnerWss.close(() => r()));
    });
    const { clock, browser, pings, closed } = await setup(
      `http://127.0.0.1:${(runnerWss.address() as net.AddressInfo).port}`,
    );
    browser.send(JSON.stringify({ type: 'prompt', text: 'hi' }));
    await until(() => received.length === 1); // runner leg is OPEN

    await clock.advance(20_000); // ping sent to the runner, no pong
    await until(() => pings.length === 1);
    // A browser ping round trip: a close sent at that tick would arrive before this pong
    await new Promise<void>((r) => {
      browser.once('pong', () => r());
      browser.ping();
    });
    expect(browser.readyState).toBe(WebSocket.OPEN);

    await clock.advance(20_000); // still no pong: terminated
    expect(await closed).toBe(1012);
  });
});
