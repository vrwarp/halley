/**
 * Failure injection through the ProcessRunner seam: deterministic simulations of child-process
 * failures that are hard to provoke for real (git dying mid-commit, read-tree failing after it
 * already rewrote the tree, npm install timing out).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CheckpointError,
  createCheckpoint,
  readSyncIntent,
  recoverInterruptedSync,
  virtualMergeWithBase,
} from '../src/checkpoints-and-git.js';
import { NodeModulesCacheManager, readNodeModulesMeta, writeNodeModulesMeta } from '../src/nm-cache.js';
import {
  execFileGroup,
  getProcessRunner,
  realProcessRunner,
  setProcessRunner,
  type ExecGroupOptions,
  type ProcessResult,
  type ProcessRunner,
} from '../src/proc.js';

const exec = promisify(execFile);
const identity = { botName: 'Bot', botEmail: 'bot@x.test', editorName: 'Ed', editorEmail: 'ed@x.test' };
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout.trim();
const exists = (p: string) => fs.access(p).then(() => true, () => false);

interface ExecCall {
  cmd: string;
  args: readonly string[];
  cwd?: string;
}

/**
 * Records every exec; `fault` decides per call: return a ProcessResult to fake the outcome, or
 * undefined to run the real command. Spawns always go to the real runner.
 */
function faultingRunner(
  fault: (call: ExecCall, real: () => Promise<ProcessResult>) => Promise<ProcessResult | undefined> | ProcessResult | undefined,
): ProcessRunner & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    calls,
    async exec(cmd: string, args: readonly string[], opts?: ExecGroupOptions) {
      const call = { cmd, args, cwd: opts?.cwd };
      calls.push(call);
      const real = () => realProcessRunner.exec(cmd, args, opts);
      return (await fault(call, real)) ?? real();
    },
    spawn: realProcessRunner.spawn,
  };
}

/** `git <subcommand>` regardless of leading `-c k=v` options. */
function gitSubcommand(call: ExecCall): string | undefined {
  if (call.cmd !== 'git') return undefined;
  for (let i = 0; i < call.args.length; i++) {
    if (call.args[i] === '-c') {
      i++;
      continue;
    }
    return call.args[i];
  }
  return undefined;
}

async function initRepo(prefix: string) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await git(tmp, 'init', '-b', 'main');
  await git(tmp, 'config', 'user.name', 'T');
  await git(tmp, 'config', 'user.email', 't@x.test');
  await fs.mkdir(path.join(tmp, 'src/pages'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'src/pages/index.astro'), '<p>v0</p>\n');
  await git(tmp, 'add', '-A');
  await git(tmp, 'commit', '-m', 'init');
  return tmp;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('ProcessRunner seam', () => {
  it('setProcessRunner nests/restores and execFileGroup keeps its execFile-compatible errors', async () => {
    expect(getProcessRunner()).toBe(realProcessRunner);
    const fake = faultingRunner(() => ({ code: 3, stdout: 'out', stderr: 'boom' }));
    const restore = setProcessRunner(fake);
    const inner = faultingRunner(() => ({ code: 0, stdout: 'inner', stderr: '' }));
    const restoreInner = setProcessRunner(inner);
    expect((await execFileGroup('anything', ['x'])).stdout).toBe('inner');
    restoreInner();
    const err = (await execFileGroup('anything', ['x']).catch((e: unknown) => e)) as {
      code: number;
      stdout: string;
      stderr: string;
      message: string;
    };
    expect(err.code).toBe(3);
    expect(err.stdout).toBe('out');
    expect(err.stderr).toBe('boom');
    expect(err.message).toContain('exited with 3');
    restore();
    expect(getProcessRunner()).toBe(realProcessRunner);

    // the real runner: spawn errors and timeouts are results, not rejections
    const missing = await realProcessRunner.exec('/nonexistent/binary-xyz', []);
    expect(missing.code).toBe(1);
    expect(missing.spawnError?.code).toBe('ENOENT');
    const slow = await realProcessRunner.exec('sleep', ['5'], { timeoutMs: 50, killGraceMs: 50 });
    expect(slow.timedOut).toBe(true);
    expect(slow.code).toBe(1);
  });

  it('git commit dying mid-checkpoint throws CheckpointError and leaves HEAD, the work and the locks consistent', async () => {
    const repo = await initRepo('halley-pr-commit-');
    cleanups.push(() => fs.rm(repo, { recursive: true, force: true }));
    const head0 = await git(repo, 'rev-parse', 'HEAD');
    await fs.writeFile(path.join(repo, 'src/pages/index.astro'), '<p>unsaved edit</p>\n');
    await fs.writeFile(path.join(repo, 'src/pages/new.astro'), '<p>new page</p>\n');

    const runner = faultingRunner((call) =>
      gitSubcommand(call) === 'commit'
        ? // killed by its timeout: no stderr, process group gone
          { code: 1, stdout: '', stderr: '', signal: 'SIGTERM', timedOut: true }
        : undefined,
    );
    const restore = setProcessRunner(runner);
    cleanups.push(restore);

    const err = await createCheckpoint(repo, 'Edit', identity).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CheckpointError);
    expect((err as Error).message).toMatch(/git commit failed:[\s\S]*timed out/);
    expect(runner.calls.some((c) => gitSubcommand(c) === 'add')).toBe(true);

    // consistent: HEAD unmoved, the edit and the new file still on disk, no lock left behind
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(head0);
    expect(await fs.readFile(path.join(repo, 'src/pages/index.astro'), 'utf8')).toBe('<p>unsaved edit</p>\n');
    expect(await fs.readFile(path.join(repo, 'src/pages/new.astro'), 'utf8')).toBe('<p>new page</p>\n');
    expect(await exists(path.join(repo, '.git/index.lock'))).toBe(false);
    expect(await git(repo, 'fsck', '--no-progress')).toBe('');

    // and the next checkpoint (git healthy again) commits exactly that work
    restore();
    const ck = await createCheckpoint(repo, 'Edit', identity);
    expect(ck).not.toBeNull();
    expect((await git(repo, 'show', '--name-only', '--format=', 'HEAD')).split('\n').sort()).toEqual([
      'src/pages/index.astro',
      'src/pages/new.astro',
    ]);
    expect(await git(repo, 'status', '--porcelain')).toBe('');
  });

  async function setupSync(prefix: string) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    const bare = path.join(root, 'remote.git');
    const ws = path.join(root, 'ws');
    const up = path.join(root, 'up');
    await exec('git', ['init', '--bare', '-b', 'main', bare]);
    await exec('git', ['clone', '-q', bare, up]);
    await git(up, 'config', 'user.name', 'T');
    await git(up, 'config', 'user.email', 't@x.test');
    await fs.writeFile(path.join(up, 'page.txt'), 'v0\n');
    await git(up, 'add', '-A');
    await git(up, 'commit', '-m', 'init');
    await git(up, 'push', '-q', 'origin', 'main');
    await exec('git', ['clone', '-q', bare, ws]);
    await git(ws, 'checkout', '-q', '-b', 'halley/edit');
    await fs.writeFile(path.join(ws, 'mine.txt'), 'local edit\n');
    await createCheckpoint(ws, 'Local edit', identity);
    // live site moves on (non-conflicting)
    await fs.writeFile(path.join(up, 'live.txt'), 'from live site\n');
    await git(up, 'add', '-A');
    await git(up, 'commit', '-m', 'live update');
    await git(up, 'push', '-q', 'origin', 'main');
    return { root, ws };
  }

  it('read-tree failing during sync (after rewriting the tree) is rolled back from the intent journal', async () => {
    const { root, ws } = await setupSync('halley-pr-sync-');
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const preSync = await git(ws, 'rev-parse', 'HEAD');

    let journalSeenAtFault = false;
    let faulted = false;
    const runner = faultingRunner(async (call, real) => {
      if (gitSubcommand(call) !== 'read-tree' || faulted || !call.args.includes('--reset')) return undefined;
      faulted = true;
      journalSeenAtFault = (await readSyncIntent(ws)) !== null;
      // worst case: the working tree WAS rewritten, then git reports failure (e.g. index write error)
      await real();
      return { code: 128, stdout: '', stderr: 'fatal: unable to write new index file' };
    });
    cleanups.push(setProcessRunner(runner));

    const res = await virtualMergeWithBase(ws, { baseBranch: 'main', identity });
    expect(res.status).toBe('error');
    expect(res.error).toContain('unable to write new index file');
    expect(journalSeenAtFault).toBe(true); // journal is written before the tree is touched
    // rolled back: HEAD and tree are exactly the pre-sync state, journal removed
    expect(await git(ws, 'rev-parse', 'HEAD')).toBe(preSync);
    expect(await exists(path.join(ws, 'live.txt'))).toBe(false);
    expect(await fs.readFile(path.join(ws, 'mine.txt'), 'utf8')).toBe('local edit\n');
    expect(await git(ws, 'status', '--porcelain')).toBe('');
    expect(await readSyncIntent(ws)).toBeNull();
  });

  it('when the rollback read-tree fails too, the kept journal lets recovery complete the merge consistently', async () => {
    const { root, ws } = await setupSync('halley-pr-sync2-');
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const preSync = await git(ws, 'rev-parse', 'HEAD');

    let readTrees = 0;
    const runner = faultingRunner(async (call, real) => {
      if (gitSubcommand(call) !== 'read-tree' || !call.args.includes('--reset')) return undefined;
      readTrees++;
      if (readTrees === 1) {
        await real(); // tree rewritten to the merge, then reported as failed
        return { code: 128, stdout: '', stderr: 'fatal: unable to write new index file' };
      }
      if (readTrees === 2) return { code: 128, stdout: '', stderr: 'fatal: disk full' }; // rollback fails
      return undefined;
    });
    const restore = setProcessRunner(runner);
    cleanups.push(restore);

    const res = await virtualMergeWithBase(ws, { baseBranch: 'main', identity });
    expect(res.status).toBe('error');
    const intent = await readSyncIntent(ws);
    expect(intent?.preSyncSha).toBe(preSync);
    expect(await git(ws, 'rev-parse', 'HEAD')).toBe(preSync); // update-ref never ran

    // git healthy again: recovery (also run on every lock acquisition) finishes the merge
    restore();
    const report = await recoverInterruptedSync(ws);
    expect(report.action).toBe('completed');
    expect(await git(ws, 'rev-parse', 'HEAD')).toBe(intent!.mergeCommitSha);
    expect(await fs.readFile(path.join(ws, 'live.txt'), 'utf8')).toBe('from live site\n');
    expect(await fs.readFile(path.join(ws, 'mine.txt'), 'utf8')).toBe('local edit\n');
    expect(await git(ws, 'status', '--porcelain')).toBe('');
    expect(await readSyncIntent(ws)).toBeNull();
  });

  it('an npm install that times out keeps the session’s original node_modules', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-pr-npm-'));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const ws = path.join(root, 'workspace');
    const state = path.join(root, 'state');
    await fs.mkdir(path.join(ws, 'node_modules', 'astro'), { recursive: true });
    await fs.writeFile(path.join(ws, 'package.json'), JSON.stringify({ dependencies: { astro: '5.0.0' } }));
    await fs.writeFile(path.join(ws, 'package-lock.json'), '{"lockfileVersion":3}');
    await fs.writeFile(path.join(ws, 'node_modules', 'astro', 'package.json'), '{"name":"astro","version":"4.0.0"}');
    // installed for an older lockfile: the manager must reinstall
    await writeNodeModulesMeta(state, { mode: 'detached', hash: 'old-lockfile-hash' });

    const prevNpmVersion = process.env.HALLEY_NPM_VERSION;
    process.env.HALLEY_NPM_VERSION = '10.0.0'; // no `npm --version` spawn
    cleanups.push(() => {
      if (prevNpmVersion === undefined) delete process.env.HALLEY_NPM_VERSION;
      else process.env.HALLEY_NPM_VERSION = prevNpmVersion;
    });

    const runner = faultingRunner(async (call) => {
      if (call.cmd !== 'npm') return undefined;
      // npm ci removes node_modules first and gets killed half-way through extracting
      if (call.cwd) {
        await fs.rm(path.join(call.cwd, 'node_modules'), { recursive: true, force: true });
        await fs.mkdir(path.join(call.cwd, 'node_modules', '.partial'), { recursive: true });
      }
      return { code: 1, stdout: '', stderr: '', signal: 'SIGTERM', timedOut: true };
    });
    cleanups.push(setProcessRunner(runner));

    const mgr = new NodeModulesCacheManager(path.join(root, 'nm-cache'), path.join(root, 'pkg-cache'), 2);
    const err = await mgr.ensureSessionNodeModules({ workspaceDir: ws, stateDir: state }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/timed out/);
    // both the shared cache build and the detached fallback were attempted
    expect(runner.calls.filter((c) => c.cmd === 'npm' && c.args[0] === 'ci')).toHaveLength(2);

    // the original tree is back in place, untouched; no partial/scratch dirs; meta still names it
    expect(await fs.readFile(path.join(ws, 'node_modules', 'astro', 'package.json'), 'utf8')).toBe(
      '{"name":"astro","version":"4.0.0"}',
    );
    expect(await exists(path.join(ws, 'node_modules', '.partial'))).toBe(false);
    expect((await fs.readdir(ws)).filter((n) => n.startsWith('.node_modules.'))).toEqual([]);
    expect((await readNodeModulesMeta(state))?.hash).toBe('old-lockfile-hash');
  });
});
