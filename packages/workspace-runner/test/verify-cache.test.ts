import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { FifoBuildQueue } from '../src/build-queue.js';
import { createCheckpoint } from '../src/checkpoints-and-git.js';
import { ManualClock } from '../src/clock.js';
import {
  clearVerificationCache,
  computeWorkingTreeKey,
  configureVerification,
  invalidateSpeculativeVerification,
  runAllVerificationChecks,
  runShell,
  runSpeculativeVerification,
} from '../src/verify.js';

/** Resolves on the next call of the returned callback (an event the code under test emits). */
function nextEvent<T = void>(): { promise: Promise<T>; fire: (v: T) => void } {
  let fire!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    fire = r;
  });
  return { promise, fire };
}

const execFileAsync = promisify(execFile);

const identity = {
  botName: 'Halley Bot',
  botEmail: 'halley-bot@users.noreply.github.com',
  editorName: 'Sarah',
  editorEmail: 'sarah@thecrossing.website',
};

async function initTempAstroRepo(
  tmp: string,
  checkCommand: string,
  opts?: { withGitignore?: boolean },
): Promise<void> {
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: tmp });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp });
  await fs.mkdir(path.join(tmp, 'src/pages'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'src/pages/index.astro'), '<h1>Hello</h1>\n');
  await fs.writeFile(
    path.join(tmp, 'astro.config.mjs'),
    `export default { base: '/' };\n`,
  );
  await fs.writeFile(
    path.join(tmp, '.halley.json'),
    JSON.stringify({
      checks: [{ name: 'Mock build', command: checkCommand }],
    }),
  );
  if (opts?.withGitignore) {
    await fs.writeFile(path.join(tmp, '.gitignore'), 'dist/\n.astro/\n');
  }
  await execFileAsync('git', ['add', '-A'], { cwd: tmp });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: tmp });
}

async function startMockBuildLockServer(): Promise<{
  url: string;
  queue: FifoBuildQueue;
  promotedLeases: string[];
  onPromoted: (fn: (leaseId: string) => void) => void;
  close: () => Promise<void>;
}> {
  const queue = new FifoBuildQueue(30_000);
  const promotedLeases: string[] = [];
  const promotedListeners: Array<(leaseId: string) => void> = [];
  const streamClosers = new Map<string, () => void>();

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
      sessionId?: string;
      priority?: 'foreground' | 'speculative';
      leaseId?: string;
    };

    if (req.method === 'POST' && req.url === '/internal/build-lock/acquire') {
      const priority = body.priority === 'speculative' ? 'speculative' : 'foreground';
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
      });
      const ac = new AbortController();
      req.on('close', () => ac.abort());
      let closed = false;
      let acquiredLeaseId: string | null = null;
      const closeRes = () => {
        if (closed) return;
        closed = true;
        if (acquiredLeaseId) streamClosers.delete(acquiredLeaseId);
        try {
          res.end();
        } catch {
          // ignore
        }
      };

      void queue
        .acquire(body.sessionId || 'unknown', {
          priority,
          signal: ac.signal,
          onQueued: (pos) => {
            if (!closed) res.write(`${JSON.stringify({ event: 'queued', position: pos })}\n`);
          },
          onPreempted:
            priority === 'speculative'
              ? () => {
                  if (!closed) {
                    res.write(`${JSON.stringify({ event: 'preempted', leaseId: acquiredLeaseId })}\n`);
                  }
                  closeRes();
                }
              : undefined,
        })
        .then((lease) => {
          acquiredLeaseId = lease.leaseId;
          if (!closed) {
            res.write(`${JSON.stringify({ event: 'acquired', leaseId: lease.leaseId })}\n`);
          }
          if (priority === 'speculative') {
            streamClosers.set(lease.leaseId, closeRes);
          } else {
            closeRes();
          }
        })
        .catch((err) => {
          if (!closed) {
            res.write(`${JSON.stringify({ event: 'error', message: String(err) })}\n`);
          }
          closeRes();
        });
      return;
    }

    if (req.method === 'POST' && req.url === '/internal/build-lock/promote') {
      const promoted = body.leaseId ? queue.promoteToForeground(body.leaseId) : false;
      if (promoted && body.leaseId) {
        promotedLeases.push(body.leaseId);
        for (const fn of promotedListeners) fn(body.leaseId);
      }
      if (body.leaseId) streamClosers.get(body.leaseId)?.();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, promoted }));
      return;
    }

    if (req.method === 'POST' && req.url === '/internal/build-lock/release') {
      const released = body.leaseId ? queue.releaseByLease(body.leaseId) : false;
      if (body.leaseId) streamClosers.get(body.leaseId)?.();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, released }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        queue,
        promotedLeases,
        onPromoted: (fn) => promotedListeners.push(fn),
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe('verification tree-SHA cache, coalescing, preemption & .astro retention', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('memoizes by Git tree SHA across uncommitted edits and createCheckpoint, preserves .astro/, and never stages .astro/', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-vcache-'));
    cleanups.push(async () => {
      clearVerificationCache(tmp);
      await fs.rm(tmp, { recursive: true, force: true });
    });

    const counterFile = path.join(tmp, '..', `count-${path.basename(tmp)}.txt`);
    cleanups.push(async () => {
      await fs.rm(counterFile, { force: true });
    });

    // Deliberately omit .gitignore to verify .git/info/exclude protects .astro/ and dist/
    await initTempAstroRepo(
      tmp,
      `mkdir -p .astro dist && echo warm > .astro/cache.txt && echo html > dist/index.html && echo x >> ${JSON.stringify(counterFile)}`,
      { withGitignore: false },
    );

    // Edit a page (uncommitted) and compute its working tree key
    await fs.writeFile(path.join(tmp, 'src/pages/index.astro'), '<h1>Updated</h1>\n');
    const dirtyTreeKey = await computeWorkingTreeKey(tmp);
    expect(dirtyTreeKey).toMatch(/^[0-9a-f]{40}$/);

    // 1st run executes the build
    const r1 = await runAllVerificationChecks(tmp);
    expect(r1.allPassed).toBe(true);
    expect(r1.fromCache).toBeUndefined();

    // dist/ was cleaned up, .astro/ was preserved
    await expect(fs.access(path.join(tmp, 'dist'))).rejects.toThrow();
    expect(await fs.readFile(path.join(tmp, '.astro/cache.txt'), 'utf8')).toContain('warm');

    // createCheckpoint commits the edit without staging .astro/ and yields the exact same tree SHA
    const ckpt = await createCheckpoint(tmp, 'Update heading', identity);
    expect(ckpt).not.toBeNull();
    const { stdout: committedFiles } = await execFileAsync(
      'git',
      ['show', '--pretty=', '--name-only', 'HEAD'],
      { cwd: tmp },
    );
    expect(committedFiles).not.toContain('.astro/');
    expect(committedFiles).not.toContain('dist/');

    const cleanTreeKey = await computeWorkingTreeKey(tmp);
    expect(cleanTreeKey).toBe(dirtyTreeKey);

    // 2nd run hits the tree-SHA cache without executing the shell command again
    const r2 = await runAllVerificationChecks(tmp);
    expect(r2.allPassed).toBe(true);
    expect(r2.fromCache).toBe(true);

    const runs = (await fs.readFile(counterFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
    expect(runs).toHaveLength(1);
  });

  it('caches deterministic check failures for the same tree and invalidates on file change', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-vfail-'));
    cleanups.push(async () => {
      clearVerificationCache(tmp);
      await fs.rm(tmp, { recursive: true, force: true });
    });

    const counterFile = path.join(tmp, '..', `failcount-${path.basename(tmp)}.txt`);
    cleanups.push(async () => {
      await fs.rm(counterFile, { force: true });
    });

    await initTempAstroRepo(
      tmp,
      `echo x >> ${JSON.stringify(counterFile)} && echo "type error" >&2 && exit 1`,
    );

    const r1 = await runAllVerificationChecks(tmp);
    expect(r1.allPassed).toBe(false);
    expect(r1.fromCache).toBeUndefined();

    const r2 = await runAllVerificationChecks(tmp);
    expect(r2.allPassed).toBe(false);
    expect(r2.fromCache).toBe(true);

    const runs = (await fs.readFile(counterFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
    expect(runs).toHaveLength(1);
  });

  it('coalesces a foreground Publish into an in-flight speculative build on the same tree and promotes its supervisor lease', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-vcoal-'));
    const mockLock = await startMockBuildLockServer();
    // shell timeouts / kill escalation of these runs are on a manual clock: nothing is time-driven
    const restoreClock = configureVerification(tmp, { clock: new ManualClock() });
    cleanups.push(async () => {
      restoreClock();
      clearVerificationCache(tmp);
      await mockLock.close();
      await fs.rm(tmp, { recursive: true, force: true });
    });

    const counterFile = path.join(tmp, '..', `coalcount-${path.basename(tmp)}.txt`);
    // the build blocks on this FIFO until the test opens the gate (no sleeps, no timing windows)
    const gate = path.join(tmp, '..', `coalgate-${path.basename(tmp)}`);
    await execFileAsync('mkfifo', [gate]);
    cleanups.push(async () => {
      await fs.rm(counterFile, { force: true });
      await fs.rm(gate, { force: true });
    });

    await initTempAstroRepo(
      tmp,
      `echo x >> ${JSON.stringify(counterFile)} && cat ${JSON.stringify(gate)} >/dev/null && echo ok`,
    );

    const leased = nextEvent();
    const specPromise = runSpeculativeVerification(tmp, {
      supervisorUrl: mockLock.url,
      sessionId: 'sess-A',
      onLeaseAcquired: () => leased.fire(),
    });
    await leased.promise; // speculative run is in flight and holds the supervisor lease

    const promoted = nextEvent<string>();
    mockLock.onPromoted((id) => promoted.fire(id));
    const fgPromise = runAllVerificationChecks(tmp, {
      supervisorUrl: mockLock.url,
      sessionId: 'sess-A',
      priority: 'foreground',
    });
    await promoted.promise; // the foreground call joined the speculative run and promoted it
    await fs.writeFile(gate, 'go\n'); // let the single build finish

    const [fgResult, specResult] = await Promise.all([fgPromise, specPromise]);
    expect(fgResult.allPassed).toBe(true);
    expect(specResult?.allPassed).toBe(true);
    expect(mockLock.promotedLeases.length).toBe(1);

    const runs = (await fs.readFile(counterFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
    expect(runs).toHaveLength(1);
  });

  it('aborts a stale speculative build on edit invalidation without caching it, and preempts across sessions when another editor publishes', async () => {
    const tmpA = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-vpreempt-a-'));
    const tmpB = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-vpreempt-b-'));
    const mockLock = await startMockBuildLockServer();
    const restoreA = configureVerification(tmpA, { clock: new ManualClock() });
    const restoreB = configureVerification(tmpB, { clock: new ManualClock() });
    // A's build never finishes on its own (blocks on a FIFO nobody writes): only an abort ends it
    const neverOpened = path.join(tmpA, '..', `never-${path.basename(tmpA)}`);
    await execFileAsync('mkfifo', [neverOpened]);
    cleanups.push(async () => {
      restoreA();
      restoreB();
      clearVerificationCache(tmpA);
      clearVerificationCache(tmpB);
      await mockLock.close();
      await fs.rm(tmpA, { recursive: true, force: true });
      await fs.rm(tmpB, { recursive: true, force: true });
      await fs.rm(neverOpened, { force: true });
    });

    await initTempAstroRepo(tmpA, `cat ${JSON.stringify(neverOpened)} && echo A-done`);
    await initTempAstroRepo(tmpB, 'echo B-done');

    // 1. Cross-session preemption: A holds the lock speculatively, B's foreground build preempts it
    //    (if preemption did not work, B would wait on A's never-ending build and the test would hang)
    const leasedA = nextEvent();
    const specA = runSpeculativeVerification(tmpA, {
      supervisorUrl: mockLock.url,
      sessionId: 'sess-A',
      onLeaseAcquired: () => leasedA.fire(),
    });
    await leasedA.promise;

    const resB = await runAllVerificationChecks(tmpB, {
      supervisorUrl: mockLock.url,
      sessionId: 'sess-B',
      priority: 'foreground',
    });
    const resA = await specA;

    expect(resB.allPassed).toBe(true);
    expect(resA).toBeNull(); // Preempted & aborted

    // 2. Own-session edit invalidation: speculative again, invalidated while running -> aborts cleanly
    const leasedA2 = nextEvent();
    const specA2 = runSpeculativeVerification(tmpA, {
      supervisorUrl: mockLock.url,
      sessionId: 'sess-A',
      onLeaseAcquired: () => leasedA2.fire(),
    });
    await leasedA2.promise;
    invalidateSpeculativeVerification(tmpA);
    const resA2 = await specA2;
    expect(resA2).toBeNull();
    // nothing was cached for the aborted tree: the next foreground run would execute the build
    expect(await computeWorkingTreeKey(tmpA)).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('runShell timers on an injected clock', () => {
  it('times out, then escalates SIGTERM -> SIGKILL, purely on the injected clock', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-vshell-'));
    const ready = path.join(tmp, 'ready.fifo');
    await execFileAsync('mkfifo', [ready]);
    try {
      // 1) plain timeout: SIGTERM ends the group as soon as the manual clock passes the deadline
      const clock = new ManualClock();
      const p1 = runShell(tmp, 'sleep 30', { timeoutMs: 60_000, clock });
      clock.advance(59_999);
      expect(clock.pendingTimers()).toBe(1); // still only the timeout timer: no escalation yet
      clock.advance(1);
      const r1 = await p1;
      expect(r1.passed).toBe(false);
      expect(r1.transient).toBe(true);
      expect(r1.output).toContain('[Timed out after 60s]');
      expect(r1.durationMs).toBe(60_000);

      // 2) a build that ignores SIGTERM is SIGKILLed 1s (of injected time) later
      const clock2 = new ManualClock();
      const p2 = runShell(tmp, `trap '' TERM; echo $$ > ${JSON.stringify(ready)}; sleep 30`, {
        timeoutMs: 10_000,
        clock: clock2,
      });
      const pid = Number((await fs.readFile(ready, 'utf8')).trim()); // shell is up and ignoring TERM
      clock2.advance(10_000); // timeout -> SIGTERM (ignored)
      expect(() => process.kill(pid, 0)).not.toThrow(); // survived SIGTERM
      expect(clock2.pendingTimers()).toBe(2); // kill escalation + force-resolve armed
      clock2.advance(1_000); // -> SIGKILL of the group
      const r2 = await p2;
      expect(r2.passed).toBe(false);
      expect(r2.output).toContain('[Timed out after 10s]');
      expect(r2.durationMs).toBe(11_000);
      expect(clock2.pendingTimers()).toBe(0);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
