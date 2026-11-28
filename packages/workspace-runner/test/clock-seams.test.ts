/**
 * Every behaviour-affecting timer runs on the injected Clock: fetch deadlines (timeoutSignal),
 * git-lock retry backoff + stale-lock age, supervisor stop grace -> SIGKILL. All driven by a
 * ManualClock: no wall-clock sleeps decide any outcome here.
 */
import { execFile, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock, realClock } from '../src/clock.js';
import {
  CheckpointError,
  configureGitClock,
  createCheckpoint,
  GIT_LOCK_RETRY_DELAY_MS,
} from '../src/checkpoints-and-git.js';
import { realProcessRunner, setProcessRunner, type ProcessRunner } from '../src/proc.js';
import { RUNNER_PROTOCOL_VERSION } from '../src/runner-protocol.js';
import { createWorkspaceSupervisor } from '../src/supervisor.js';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout.trim();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
async function tmpDir(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rm(d, { recursive: true, force: true }));
  return d;
}
const tick = () => new Promise<void>((r) => setImmediate(r));
/** Lets pending I/O callbacks run until `cond` holds (event-loop turns, never a timed sleep). */
async function until(cond: () => boolean, maxTurns = 20_000): Promise<void> {
  for (let i = 0; i < maxTurns; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error('condition never became true');
}
function settled<T>(p: Promise<T>): { done: () => boolean } {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  return { done: () => done };
}
/** Drives `p` to completion, advancing the manual clock only to timers due within `maxStepMs`. */
async function drive<T>(p: Promise<T>, clock: ManualClock, maxStepMs: number): Promise<T> {
  const s = settled(p);
  while (!s.done()) {
    const due = clock.nextDueIn();
    if (due !== null && due <= maxStepMs) clock.advance(due);
    await tick();
  }
  return p;
}

describe('ManualClock primitives', () => {
  it('timeoutSignal aborts with TimeoutError exactly at the manual deadline; the real one is native', () => {
    const clock = new ManualClock();
    const sig = clock.timeoutSignal(1_000);
    clock.advance(999);
    expect(sig.aborted).toBe(false);
    clock.advance(1);
    expect(sig.aborted).toBe(true);
    expect((sig.reason as DOMException).name).toBe('TimeoutError');
    const real = realClock.timeoutSignal(60_000);
    expect(real.aborted).toBe(false);
  });

  it('setInterval repeats until cleared', () => {
    const clock = new ManualClock();
    let n = 0;
    const h = clock.setInterval(() => n++, 100);
    clock.advance(350);
    expect(n).toBe(3);
    clock.clearTimeout(h);
    clock.advance(1_000);
    expect(n).toBe(3);
    expect(clock.pendingTimers()).toBe(0);
  });
});

describe('git lock handling on the injected clock', () => {
  async function initRepo(): Promise<string> {
    const dir = await tmpDir('halley-clock-git-');
    await git(dir, 'init', '-q', '-b', 'main');
    await git(dir, 'config', 'user.name', 'T');
    await git(dir, 'config', 'user.email', 't@x.test');
    await fs.mkdir(path.join(dir, 'src/pages'), { recursive: true });
    await fs.writeFile(path.join(dir, 'src/pages/index.astro'), '<p>0</p>\n');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-qm', 'init');
    return dir;
  }
  const identity = { botName: 'B', botEmail: 'b@x.test', editorName: 'E', editorEmail: 'e@x.test' };

  it('a fresh lock is retried on manual time then fails with CheckpointError; one older than the threshold (by the clock) is cleared', async () => {
    const repo = await initRepo();
    const lock = path.join(repo, '.git/index.lock');
    await fs.writeFile(lock, '');
    const mtime = (await fs.stat(lock)).mtimeMs;
    const clock = new ManualClock(Math.floor(mtime)); // the lock is 0ms old on this clock
    cleanups.push(configureGitClock(clock));
    const page = path.join(repo, 'src/pages/index.astro');
    const head0 = await git(repo, 'rev-parse', 'HEAD');

    // fresh: 4 retries x 300ms of MANUAL time, never reaching the 10s threshold
    await fs.writeFile(page, '<p>1</p>\n');
    const t0 = clock.now();
    const err = await drive(
      createCheckpoint(repo, 'edit', identity).catch((e: unknown) => e),
      clock,
      GIT_LOCK_RETRY_DELAY_MS,
    );
    expect(err).toBeInstanceOf(CheckpointError);
    expect(clock.now() - t0).toBe(4 * GIT_LOCK_RETRY_DELAY_MS);
    expect(await fs.stat(lock).then(() => true)).toBe(true);
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(head0);

    // 1ms under the threshold: the first attempt fails, the lock turns stale during the first
    // retry delay (manual time) and is cleared -> the checkpoint lands after exactly one backoff
    clock.set(mtime + 10_000 - 1);
    const t1 = clock.now();
    const ck1 = await drive(createCheckpoint(repo, 'edit', identity), clock, GIT_LOCK_RETRY_DELAY_MS);
    expect(ck1).not.toBeNull();
    expect(clock.now() - t1).toBe(GIT_LOCK_RETRY_DELAY_MS);
    await expect(fs.stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });

    // a lock already older than the threshold on the manual clock is cleared up front: no backoff
    await fs.writeFile(lock, '');
    const mtime2 = (await fs.stat(lock)).mtimeMs;
    clock.set(Math.ceil(mtime2) + 10_000);
    await fs.writeFile(page, '<p>2</p>\n');
    const before = clock.now();
    const ck = await createCheckpoint(repo, 'edit', identity);
    expect(ck).not.toBeNull();
    expect(clock.now()).toBe(before);
    await expect(fs.stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('HALLEY_STALE_GIT_LOCK_MS still sets the threshold', async () => {
    const repo = await initRepo();
    const lock = path.join(repo, '.git/index.lock');
    await fs.writeFile(lock, '');
    const mtime = (await fs.stat(lock)).mtimeMs;
    const clock = new ManualClock(Math.ceil(mtime) + 1_001);
    cleanups.push(configureGitClock(clock));
    process.env.HALLEY_STALE_GIT_LOCK_MS = '1000';
    cleanups.push(() => delete process.env.HALLEY_STALE_GIT_LOCK_MS);
    await fs.writeFile(path.join(repo, 'src/pages/index.astro'), '<p>2</p>\n');
    expect(await createCheckpoint(repo, 'edit', identity)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Supervisor with a fake ProcessRunner: the "runner process" is an in-process fake child + server
// ---------------------------------------------------------------------------------------------

interface FakeChild {
  child: ChildProcess;
  signals: NodeJS.Signals[];
  server: http.Server;
  /** Requests whose path matches are left hanging. */
  hang: Set<string>;
  hungRequests: string[];
}

function fakeRunnerProcessRunner(children: FakeChild[]): ProcessRunner {
  return {
    exec: realProcessRunner.exec,
    spawn: (_cmd, _args, opts) => {
      const ee = new EventEmitter() as unknown as ChildProcess & { exitCode: number | null; signalCode: NodeJS.Signals | null };
      const signals: NodeJS.Signals[] = [];
      Object.assign(ee, {
        pid: undefined,
        exitCode: null,
        signalCode: null,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: (sig: NodeJS.Signals = 'SIGTERM') => {
          signals.push(sig);
          if (sig === 'SIGKILL') {
            // SIGTERM is ignored (a wedged runner); only SIGKILL ends it
            ee.signalCode = 'SIGKILL';
            server.close();
            server.closeAllConnections();
            queueMicrotask(() => ee.emit('exit', null, 'SIGKILL'));
          }
          return true;
        },
      });
      const fc: FakeChild = { child: ee, signals, server: undefined as unknown as http.Server, hang: new Set(), hungRequests: [] };
      const server = http.createServer((req, res) => {
        const url = req.url ?? '';
        if (fc.hang.has(url)) {
          fc.hungRequests.push(url);
          return; // never answers
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ ok: true, protocolVersion: RUNNER_PROTOCOL_VERSION, astroReady: true, astroState: 'ready', originalBase: '/' }),
        );
      });
      server.listen(Number(opts.env?.RUNNER_PORT), '127.0.0.1');
      fc.server = server;
      children.push(fc);
      return ee;
    },
  };
}

const supOpts = (workspacesDir: string, extra: Record<string, unknown> = {}) => ({
  workspacesDir,
  controlPlaneInternalUrl: path.join(workspacesDir, 'cp'),
  repo: 'test/site',
  baseBranch: 'main',
  modelId: 'haiku-latest',
  thinkingLevel: 'off' as const,
  gitBotName: 'Bot',
  gitBotEmail: 'bot@x.test',
  warmPoolSize: 0,
  maxActiveWorkspaces: 5,
  bindHost: '127.0.0.1',
  runnerEntry: '/fake-runner.js',
  ...extra,
});

describe('supervisor timers on the injected clock', () => {
  it('a hanging supervisor->runner call times out exactly at the fake deadline; stop escalates SIGTERM -> SIGKILL on manual time', async () => {
    const root = await tmpDir('halley-clock-sup-');
    const sessionId = `clk-${process.pid}-${Date.now()}`;
    await fs.mkdir(path.join(root, 'sessions', sessionId, 'workspace', '.git'), { recursive: true });
    const children: FakeChild[] = [];
    const clock = new ManualClock();
    const sup = createWorkspaceSupervisor(
      supOpts(root, { clock, processRunner: fakeRunnerProcessRunner(children) }),
    );
    cleanups.push(() => setProcessRunner(null));
    cleanups.push(() => {
      for (const c of children) {
        c.server.close();
        c.server.closeAllConnections();
      }
    });

    const startRes = await drive(
      sup.app.request(`/api/sessions/${sessionId}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseBranch: 'main', workingBranch: 'halley/clk', workspaceToken: 't' }),
      }),
      clock,
      350, // boot health-poll interval, should the first probe race the fake server's listen
    );
    expect(startRes.status).toBe(200);
    expect(children).toHaveLength(1);
    const fc = children[0]!;

    // 1) /health aggregates each runner's /health with a 1500ms deadline: hang it
    fc.hang.add('/health');
    const health = sup.app.request('/health');
    const h = settled(health);
    await until(() => fc.hungRequests.length === 1);
    clock.advance(1_499);
    for (let i = 0; i < 50; i++) await tick();
    expect(h.done()).toBe(false);
    clock.advance(1);
    const body = (await (await health).json()) as { activeSessionIds: string[]; astroReadySessionIds?: string[] };
    expect(body.activeSessionIds).toEqual([sessionId]);
    expect(body.astroReadySessionIds ?? []).toEqual([]); // timed out -> not listed as ready

    // 2) stop: SIGTERM is ignored; SIGKILL follows exactly HALLEY_RUNNER_STOP_GRACE_MS (5s) later
    const stop = sup.stopAll();
    const st = settled(stop);
    await until(() => fc.signals.length === 1);
    expect(fc.signals).toEqual(['SIGTERM']);
    clock.advance(4_999);
    for (let i = 0; i < 50; i++) await tick();
    expect(fc.signals).toEqual(['SIGTERM']);
    expect(st.done()).toBe(false);
    clock.advance(1);
    await stop;
    expect(fc.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
