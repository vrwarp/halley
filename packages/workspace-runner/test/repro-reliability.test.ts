/**
 * Regression tests for the workspace-runner reliability review (W1–W8). Each test started life as
 * an empirical reproduction of a defect and now asserts the corrected behaviour.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { GitFileChange } from '@halley/shared';
import { isDependencyMutationCommand } from '../src/bash-guard.js';
import { ManualClock } from '../src/clock.js';
import {
  CheckpointError,
  configureGitClock,
  createCheckpoint,
  GIT_LOCK_RETRY_DELAY_MS,
  getGitChanges,
  readSyncIntent,
  recoverInterruptedSync,
  resetToRef,
  undoToCheckpoint,
  writeSyncIntent,
} from '../src/checkpoints-and-git.js';
import { detachHardlinkedNodeModules, readNodeModulesMeta, writeNodeModulesMeta } from '../src/nm-cache.js';
import { withMaxOldSpace } from '../src/proc.js';

const exec = promisify(execFile);
const identity = { botName: 'Bot', botEmail: 'bot@x.test', editorName: 'Ed', editorEmail: 'ed@x.test' };
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout.trim();
const tick = () => new Promise<void>((r) => setImmediate(r));
/** Event-loop turns until `cond` holds (no timed sleeps); throws after `maxTurns`. */
async function until(cond: () => boolean | Promise<boolean>, maxTurns = 100_000): Promise<void> {
  for (let i = 0; i < maxTurns; i++) {
    if (await cond()) return;
    await tick();
  }
  throw new Error('condition never became true');
}
/** Drives `p`, advancing `clock` only to timers due within `maxStepMs` (git-lock backoffs). */
async function drive<T>(p: Promise<T>, clock: ManualClock, maxStepMs: number): Promise<T> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  while (!done) {
    const due = clock.nextDueIn();
    if (due !== null && due <= maxStepMs) clock.advance(due);
    await tick();
  }
  return p;
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

/** The pre-W5 implementation (2 git processes per file), kept only as the equivalence oracle. */
async function getGitChangesLegacy(repoRoot: string, baseRef: string): Promise<GitFileChange[]> {
  const run = async (args: string[]) =>
    exec('git', args, { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 }).then(
      (r) => r.stdout,
      (e: { stdout?: string }) => e.stdout ?? '',
    );
  const statusMap = new Map<string, GitFileChange['status']>();
  for (const line of (await run(['diff', '--name-status', baseRef])).trim().split(/\r?\n/)) {
    if (!line) continue;
    const [code = 'M', file = ''] = line.split(/\t/);
    if (!file) continue;
    if (code.startsWith('A')) statusMap.set(file, 'added');
    else if (code.startsWith('D')) statusMap.set(file, 'deleted');
    else if (code.startsWith('R')) statusMap.set(file, 'renamed');
    else statusMap.set(file, 'modified');
  }
  for (const line of (await run(['ls-files', '--others', '--exclude-standard'])).trim().split(/\r?\n/)) {
    if (line.trim()) statusMap.set(line.trim(), 'untracked');
  }
  const changes: GitFileChange[] = [];
  for (const [filePath, status] of statusMap.entries()) {
    if (status === 'untracked') {
      changes.push({ path: filePath, status, additions: 0, deletions: 0, diff: `New file: ${filePath}` });
      continue;
    }
    const [addStr = '0', delStr = '0'] = (await run(['diff', '--numstat', baseRef, '--', filePath])).trim().split(/\s+/);
    const patch = await run(['diff', baseRef, '--', filePath]);
    changes.push({ path: filePath, status, additions: Number(addStr) || 0, deletions: Number(delStr) || 0, diff: patch });
  }
  return changes;
}

const exists = (p: string) => fs.access(p).then(() => true, () => false);

describe('workspace-runner reliability regressions', () => {
  it('W1: read-only tool commands never detach node_modules; a real mutation detaches copy-on-write and keeps a working tree', async () => {
    for (const cmd of ['npx prettier --check .', 'npx astro --version', 'npm exec -- tsc --noEmit', 'npm pkg get name', 'pnpm dlx cowsay hi', 'yarn dlx foo', 'corepack enable', 'npm run dev', 'npm init -y', 'pnpm info astro']) {
      expect(isDependencyMutationCommand(cmd), cmd).toBe(false);
    }
    for (const cmd of ['npm install', 'npm i lodash', 'npm ci', 'npm uninstall x', 'npm rm x', 'npm remove x', 'npm update', 'npm up', 'npm dedupe', 'npm pkg set name=x', 'npm pkg delete scripts.x', 'pnpm add x', 'pnpm install', 'pnpm remove x', 'pnpm update', 'yarn add x', 'yarn install', 'yarn remove x', 'yarn upgrade', 'yarn', 'cd site && npm install foo']) {
      expect(isDependencyMutationCommand(cmd), cmd).toBe(true);
    }

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-repro-npx-'));
    try {
      // hardlinked mode: node_modules is `cp -al` of a read-only golden cache
      const ws = path.join(tmp, 'workspace');
      const state = path.join(tmp, 'state');
      const cache = path.join(tmp, 'nm-cache/h/node_modules');
      await fs.mkdir(path.join(cache, 'astro/bin'), { recursive: true });
      await fs.writeFile(path.join(cache, 'astro/package.json'), '{"name":"astro"}');
      await fs.writeFile(path.join(cache, 'astro/bin/astro.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
      await exec('find', [cache, '-type', 'f', '-exec', 'chmod', 'a-w', '{}', '+']);
      await fs.mkdir(ws, { recursive: true });
      await git(ws, 'init', '-q');
      await fs.writeFile(path.join(ws, 'package.json'), '{"name":"t","dependencies":{"astro":"5"}}');
      await exec('cp', ['-al', cache, path.join(ws, 'node_modules')]);
      await writeNodeModulesMeta(state, { mode: 'hardlinked', hash: 'h' });
      const cacheIno = (await fs.stat(path.join(cache, 'astro/package.json'))).ino;
      expect((await fs.stat(path.join(ws, 'node_modules/astro/package.json'))).ino).toBe(cacheIno);

      expect(await detachHardlinkedNodeModules(ws, state, path.join(tmp, 'pkg-cache'))).toBe(true);
      const st = await fs.stat(path.join(ws, 'node_modules/astro/package.json'));
      expect(st.ino).not.toBe(cacheIno); // private copy, the shared inode is untouched
      expect(st.mode & 0o200).toBeTruthy(); // writable for the package manager
      expect((await fs.stat(path.join(ws, 'node_modules/astro/bin/astro.js'))).mode & 0o100).toBeTruthy(); // +x kept
      expect(await fs.readFile(path.join(ws, 'node_modules/astro/package.json'), 'utf8')).toBe('{"name":"astro"}');
      expect((await readNodeModulesMeta(state))?.mode).toBe('detached');
      // the old hardlinked tree is removed in the background (never blocks the agent): poll for it
      await until(async () => !(await fs.readdir(ws)).some((n) => n.startsWith('.node_modules.')));
      expect((await fs.readdir(ws)).filter((n) => n.startsWith('.node_modules.'))).toEqual([]);
      expect(await fs.readFile(path.join(ws, '.git/info/exclude'), 'utf8')).toContain('/.node_modules.old-*/');

      // symlink mode (local fixture): replaced by an independent real directory, fixture untouched
      const ws2 = path.join(tmp, 'ws2');
      const state2 = path.join(tmp, 'state2');
      await fs.mkdir(ws2, { recursive: true });
      await fs.writeFile(path.join(ws2, 'package.json'), '{"name":"t","dependencies":{"astro":"5"}}');
      await fs.symlink(cache, path.join(ws2, 'node_modules'));
      await writeNodeModulesMeta(state2, { mode: 'symlink', hash: 'h' });
      expect(await detachHardlinkedNodeModules(ws2, state2)).toBe(true);
      expect((await fs.lstat(path.join(ws2, 'node_modules'))).isSymbolicLink()).toBe(false);
      expect(await exists(path.join(ws2, 'node_modules/astro/package.json'))).toBe(true);
      expect(await exists(path.join(cache, 'astro/package.json'))).toBe(true);
    } finally {
      await exec('chmod', ['-R', 'u+w', tmp]).catch(() => {});
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('W2: undo and reset auto-save uncommitted work (pending inline edit + new file) so it stays recoverable', async () => {
    const tmp = await initRepo('halley-repro-undo-');
    try {
      const page = path.join(tmp, 'src/pages/index.astro');
      await fs.writeFile(page, '<p>v1</p>\n');
      const c1 = await createCheckpoint(tmp, 'one', identity);
      await fs.writeFile(page, '<p>v2</p>\n');
      await createCheckpoint(tmp, 'two', identity);

      // user makes an inline edit; its checkpoint is debounced and then cancelled by /internal/git/undo
      await fs.writeFile(page, '<p>UNSAVED-INLINE-EDIT</p>\n');
      await fs.writeFile(path.join(tmp, 'src/pages/new.astro'), '<p>UNSAVED-NEW-PAGE</p>\n');

      const undone = await undoToCheckpoint(tmp, c1!.sha, identity);
      expect(undone).not.toBeNull();

      expect(await fs.readFile(page, 'utf8')).toBe('<p>v1</p>\n');
      expect(await git(tmp, 'log', '--all', '--oneline', '-S', 'v2')).not.toBe('');
      // uncommitted work is now in history: an "Auto-save before undo" checkpoint on HEAD's first-parent chain
      expect(await git(tmp, 'log', '--oneline', '-S', 'UNSAVED-INLINE-EDIT')).toContain('Auto-save before undo');
      expect(await git(tmp, 'log', '--oneline', '-S', 'UNSAVED-NEW-PAGE')).toContain('Auto-save before undo');
      expect(await git(tmp, 'for-each-ref', 'refs/halley/autosave/')).not.toBe('');
      expect(await exists(path.join(tmp, 'src/pages/new.astro'))).toBe(false); // undo itself still applied

      // resetToRef (restore-sha / sync undo) moves HEAD backwards: auto-save stays pinned under refs/halley/autosave
      await fs.writeFile(page, '<p>UNSAVED-BEFORE-RESET</p>\n');
      const head = await git(tmp, 'rev-parse', 'HEAD');
      expect(await resetToRef(tmp, c1!.sha, identity)).toBe(true);
      expect(await git(tmp, 'rev-parse', 'HEAD')).toBe(c1!.sha);
      expect(await git(tmp, 'log', '--all', '--oneline', '-S', 'UNSAVED-BEFORE-RESET')).not.toBe('');
      expect(await git(tmp, 'merge-base', '--is-ancestor', head, 'refs/halley/autosave/' + (await git(tmp, 'for-each-ref', '--sort=-refname', '--count=1', '--format=%(refname:lstrip=3)', 'refs/halley/autosave/')))).toBe('');

      // clean tree: no auto-save noise
      const before = (await git(tmp, 'for-each-ref', 'refs/halley/autosave/')).split('\n').length;
      await resetToRef(tmp, c1!.sha, identity);
      expect((await git(tmp, 'for-each-ref', 'refs/halley/autosave/')).split('\n').length).toBe(before);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('W3: a stale .git/index.lock is cleared and checkpoints resume; a live lock surfaces an error instead of a silent null', async () => {
    const tmp = await initRepo('halley-repro-lock-');
    try {
      const page = path.join(tmp, 'src/pages/index.astro');
      const head0 = await git(tmp, 'rev-parse', 'HEAD');
      const lock = path.join(tmp, '.git/index.lock');

      // Fresh lock (another git process is mid-command): fail loudly, never pretend "nothing to commit".
      // The retry backoff and the lock age both run on a manual clock: no wall-clock waiting.
      await fs.writeFile(lock, '');
      const clock = new ManualClock(Math.floor((await fs.stat(lock)).mtimeMs));
      const restoreClock = configureGitClock(clock);
      try {
        await fs.writeFile(page, '<p>edit 0</p>\n');
        const err = await drive(createCheckpoint(tmp, 'edit 0', identity).catch((e: unknown) => e), clock, GIT_LOCK_RETRY_DELAY_MS);
        expect(err).toBeInstanceOf(CheckpointError);
      } finally {
        restoreClock();
      }
      expect(await git(tmp, 'rev-parse', 'HEAD')).toBe(head0);

      // Stale lock (left by a SIGKILLed git): removed under the repo lock, checkpoints work again
      const old = new Date(Date.now() - 60_000);
      await fs.utimes(lock, old, old);
      for (let i = 1; i <= 3; i++) {
        await fs.writeFile(page, `<p>edit ${i}</p>\n`);
        const ck = await createCheckpoint(tmp, `edit ${i}`, identity);
        expect(ck).not.toBeNull();
      }
      expect(await exists(lock)).toBe(false);
      expect(await git(tmp, 'rev-list', '--count', `${head0}..HEAD`)).toBe('3');

      // "nothing to commit" is still null, not an error
      expect(await createCheckpoint(tmp, 'noop', identity)).toBeNull();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('W4: a crash between `read-tree -u` and `update-ref` is recovered from the intent journal, preserving the merge', async () => {
    const setup = async () => {
      const tmp = await initRepo('halley-repro-merge-');
      await git(tmp, 'checkout', '-q', '-b', 'upstream');
      await fs.writeFile(path.join(tmp, 'src/pages/upstream.astro'), '<p>from live site</p>\n');
      await git(tmp, 'add', '-A');
      await git(tmp, 'commit', '-m', 'upstream change');
      const upstreamSha = await git(tmp, 'rev-parse', 'HEAD');
      await git(tmp, 'checkout', '-q', 'main');
      const preSync = await git(tmp, 'rev-parse', 'HEAD');
      const tree = (await git(tmp, 'merge-tree', '--write-tree', preSync, upstreamSha)).split('\n')[0]!;
      const mergeCommit = await git(tmp, 'commit-tree', tree, '-p', preSync, '-p', upstreamSha, '-m', 'sync');
      return { tmp, upstreamSha, preSync, mergeCommit };
    };

    // 1) crash after read-tree: the next ordinary checkpoint first completes the merge
    {
      const { tmp, upstreamSha, preSync, mergeCommit } = await setup();
      try {
        // the exact sequence of applyMergeCommit, stopped where a crash would stop it
        await writeSyncIntent(tmp, { kind: 'sync', preSyncSha: preSync, mergeCommitSha: mergeCommit, newBaseSha: upstreamSha });
        await git(tmp, 'read-tree', '--reset', '-u', mergeCommit);
        // --- process killed here: update-ref HEAD never runs ---
        expect(await git(tmp, 'rev-parse', 'HEAD')).toBe(preSync);

        await fs.writeFile(path.join(tmp, 'src/pages/index.astro'), '<p>after restart</p>\n');
        const ck = await createCheckpoint(tmp, 'Inline edit', identity);
        expect(ck).not.toBeNull();
        expect((await git(tmp, 'log', '-1', '--format=%P')).split(' ')).toEqual([mergeCommit]);
        expect(await git(tmp, 'show', '--stat', '--format=', 'HEAD')).not.toContain('upstream.astro');
        expect(await git(tmp, 'show', 'HEAD:src/pages/index.astro')).toBe('<p>after restart</p>'); // post-crash edit kept
        await exec('git', ['merge-base', '--is-ancestor', upstreamSha, 'HEAD'], { cwd: tmp }); // throws if not
        expect(await readSyncIntent(tmp)).toBeNull();
        const report = await recoverInterruptedSync(tmp);
        expect(report.action).toBe('completed'); // reported to the runner so it can fix baseSha
        expect(report.intent?.newBaseSha).toBe(upstreamSha);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    }

    // 2) crash right after the journal was written (tree untouched): startup recovery applies it
    {
      const { tmp, preSync, mergeCommit } = await setup();
      try {
        await writeSyncIntent(tmp, { kind: 'sync', preSyncSha: preSync, mergeCommitSha: mergeCommit });
        const report = await recoverInterruptedSync(tmp);
        expect(report.action).toBe('completed');
        expect(await git(tmp, 'rev-parse', 'HEAD')).toBe(mergeCommit);
        expect(await exists(path.join(tmp, 'src/pages/upstream.astro'))).toBe(true);
        expect(await git(tmp, 'status', '--porcelain')).toBe('');
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    }

    // 3) crash after update-ref but before the journal was removed: just clear it
    {
      const { tmp, preSync, mergeCommit } = await setup();
      try {
        await writeSyncIntent(tmp, { kind: 'sync', preSyncSha: preSync, mergeCommitSha: mergeCommit });
        await git(tmp, 'read-tree', '--reset', '-u', mergeCommit);
        await git(tmp, 'update-ref', 'HEAD', mergeCommit, preSync);
        expect((await recoverInterruptedSync(tmp)).action).toBe('cleared');
        expect(await readSyncIntent(tmp)).toBeNull();
        expect(await git(tmp, 'rev-parse', 'HEAD')).toBe(mergeCommit);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    }
  });

  it('W5: getGitChanges spawns a constant number of git processes regardless of changed-file count', async () => {
    const tmp = await initRepo('halley-repro-changes-');
    const shimDir = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-git-shim-'));
    const realGit = (await exec('which', ['git'])).stdout.trim();
    const counter = path.join(shimDir, 'count');
    await fs.writeFile(path.join(shimDir, 'git'), `#!/bin/sh\necho x >> ${counter}\nexec ${realGit} "$@"\n`, { mode: 0o755 });
    const oldPath = process.env.PATH;
    try {
      const measure = async (n: number) => {
        for (let i = 0; i < n; i++) await fs.writeFile(path.join(tmp, `src/pages/p${i}.astro`), '<p>a</p>\n');
        await git(tmp, 'add', '-A');
        await git(tmp, 'commit', '-qm', `add ${n}`);
        const base = await git(tmp, 'rev-parse', 'HEAD');
        for (let i = 0; i < n; i++) await fs.writeFile(path.join(tmp, `src/pages/p${i}.astro`), '<p>b</p>\n');
        await git(tmp, 'add', '-A');
        await git(tmp, 'commit', '-qm', `edit ${n}`);
        await fs.writeFile(counter, '');
        process.env.PATH = `${shimDir}:${oldPath}`;
        const t0 = performance.now();
        const changes = await getGitChanges(tmp, base);
        const ms = performance.now() - t0;
        process.env.PATH = oldPath;
        const spawns = (await fs.readFile(counter, 'utf8')).split('\n').filter(Boolean).length;
        return { n, files: changes.length, spawns, ms: Math.round(ms) };
      };
      const a = await measure(10);
      const b = await measure(100);
      console.log('[W5]', JSON.stringify(a), JSON.stringify(b));
      expect(b.files).toBe(100);
      expect(b.spawns).toBe(a.spawns); // constant w.r.t. the number of changed files
      expect(b.spawns).toBeLessThanOrEqual(4);
    } finally {
      process.env.PATH = oldPath;
      await fs.rm(tmp, { recursive: true, force: true });
      await fs.rm(shimDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('W5: batched getGitChanges output is identical to the per-file implementation', async () => {
    const tmp = await initRepo('halley-repro-changes-eq-');
    try {
      const w = (rel: string, data: string | Buffer) =>
        fs.mkdir(path.dirname(path.join(tmp, rel)), { recursive: true }).then(() => fs.writeFile(path.join(tmp, rel), data));
      await w('src/pages/modify.astro', '<p>one</p>\n<p>two</p>\n');
      await w('src/pages/delete-me.astro', '<p>bye</p>\n');
      await w('src/pages/rename-src.astro', Array.from({ length: 20 }, (_, i) => `<p>line ${i}</p>`).join('\n') + '\n');
      await w('public/img.bin', Buffer.from([0, 1, 2, 3, 0, 255, 0, 9]));
      await w('src/with space.astro', '<p>spaced</p>\n');
      await w('.gitignore', 'ignored.txt\n');
      await git(tmp, 'add', '-A');
      await git(tmp, 'commit', '-qm', 'base');
      const base = await git(tmp, 'rev-parse', 'HEAD');

      await w('src/pages/modify.astro', '<p>one</p>\n<p>TWO</p>\n<p>three</p>\n');
      await fs.rm(path.join(tmp, 'src/pages/delete-me.astro'));
      await git(tmp, 'mv', 'src/pages/rename-src.astro', 'src/pages/rename-dst.astro');
      await w('public/img.bin', Buffer.from([0, 9, 9, 9, 0, 255, 0, 1]));
      await w('src/with space.astro', '<p>spaced v2</p>\n');
      await w('src/pages/added.astro', '<p>new</p>\n');
      await git(tmp, 'add', 'src/pages/added.astro');
      await w('src/pages/untracked.astro', '<p>u</p>\n');
      await w('ignored.txt', 'nope\n');
      await fs.chmod(path.join(tmp, '.gitignore'), 0o755); // mode-only change

      const legacy = await getGitChangesLegacy(tmp, base);
      const batched = await getGitChanges(tmp, base);
      expect(legacy.map((c) => c.status).sort()).toEqual(['added', 'deleted', 'modified', 'modified', 'modified', 'modified', 'renamed', 'untracked']);
      expect(batched).toEqual(legacy);

      // also against a ref that does not exist (only untracked files are reported)
      expect(await getGitChanges(tmp, 'origin/missing')).toEqual(await getGitChangesLegacy(tmp, 'origin/missing'));
      // and with the work committed (diff against HEAD~1)
      await createCheckpoint(tmp, 'commit all', identity);
      expect(await getGitChanges(tmp, base)).toEqual(await getGitChangesLegacy(tmp, base));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('W6: runners get a merged heap cap, crashes are recorded + reported, and a restarted supervisor sweeps only marked warm-slot dirs', async () => {
    expect(withMaxOldSpace('--use-openssl-ca --max-old-space-size=8192', 1536)).toBe('--use-openssl-ca --max-old-space-size=1536');
    expect(withMaxOldSpace('--max_old_space_size 4096 --enable-source-maps', 2048)).toBe('--enable-source-maps --max-old-space-size=2048');
    expect(withMaxOldSpace(undefined, 1024)).toBe('--max-old-space-size=1024');
    const { createWorkspaceSupervisor } = await import('../src/supervisor.js');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-repro-sup-'));
    const cpCalls: string[] = [];
    const cp = http.createServer((req, res) => {
      cpCalls.push(`${req.method} ${req.url}`);
      res.end('{}');
    });
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', () => r()));
    const cpUrl = `http://127.0.0.1:${(cp.address() as net.AddressInfo).port}`;
    try {
      const sessionId = 'sess-a';
      const wsDir = path.join(tmp, 'sessions', sessionId, 'workspace');
      await fs.mkdir(path.join(wsDir, '.git'), { recursive: true });
      await fs.writeFile(path.join(wsDir, 'package.json'), '{"name":"t"}');
      const info = path.join(tmp, 'runner-info.json');
      const fakeRunner = path.join(tmp, 'fake-runner.mjs');
      await fs.writeFile(
        fakeRunner,
        `import http from 'node:http'; import fs from 'node:fs'; import v8 from 'node:v8';
fs.writeFileSync(${JSON.stringify(info)}, JSON.stringify({ pid: process.pid, execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS ?? null, heapLimitMb: Math.round(v8.getHeapStatistics().heap_size_limit / 1048576) }));
http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, protocolVersion: 2, astroReady: true, astroState: 'ready', originalBase: '/', previewBase: '/', token: 'tok' })); }).listen(Number(process.env.RUNNER_PORT), '127.0.0.1');
`,
      );
      const mk = () =>
        createWorkspaceSupervisor({
          workspacesDir: tmp,
          controlPlaneInternalUrl: cpUrl,
          repo: 'test/site',
          baseBranch: 'main',
          modelId: 'haiku-latest',
          thinkingLevel: 'off',
          gitBotName: 'Bot',
          gitBotEmail: 'bot@x.test',
          warmPoolSize: 0,
          maxActiveWorkspaces: 5,
          runnerEntry: fakeRunner,
          bindHost: '127.0.0.1',
        });
      const sup = mk();
      const start = await sup.app.request(`/api/sessions/${sessionId}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseBranch: 'main', workingBranch: 'halley/t', baseSha: 'abc1234', workspaceToken: 'tok' }),
      });
      const startBody = await start.text();
      expect(start.status, startBody).toBe(200);
      const runner = JSON.parse(await fs.readFile(info, 'utf8')) as { pid: number; execArgv: string[]; nodeOptions: string | null; heapLimitMb: number };
      console.log('[W6] runner limits', JSON.stringify(runner));
      expect(runner.execArgv).toEqual([]);
      // heap cap merged into the inherited NODE_OPTIONS (other flags kept, old cap replaced)
      expect(runner.nodeOptions).toBe(withMaxOldSpace(process.env.NODE_OPTIONS, 1536));
      expect(runner.heapLimitMb).toBeLessThan(1700);

      type Health = { activeSessionIds: string[]; crashedSessions: Array<{ id: string; code: number | null; signal: string | null; oom: boolean }> };
      const health = async (s: typeof sup) => (await (await s.app.request('/health')).json()) as Health;
      expect((await health(sup)).activeSessionIds).toEqual([sessionId]);
      expect((await health(sup)).crashedSessions).toEqual([]);

      const before = cpCalls.length;
      process.kill(runner.pid, 'SIGKILL'); // runner crash (e.g. OOM kill)
      // wait for the crash record AND the control-plane notification (no fixed sleep)
      await until(async () => (await health(sup)).crashedSessions.length > 0 && cpCalls.length > before, 1_000_000);
      const h = await health(sup);
      expect(h.activeSessionIds).toEqual([]);
      expect(h.crashedSessions).toEqual([expect.objectContaining({ id: sessionId, signal: 'SIGKILL', oom: true })]);
      expect(cpCalls.slice(before)).toEqual(['POST /internal/workspaces/session-exited']); // control plane told

      // supervisor dies without graceful shutdown; a warm slot (marked) and a real session (unmarked) are on disk
      const orphan = path.join(tmp, 'sessions', '0b8a6c1e-warm-slot-orphan');
      await fs.mkdir(path.join(orphan, 'workspace'), { recursive: true });
      await fs.writeFile(path.join(orphan, '.warm-slot'), 'x');
      const realSession = path.join(tmp, 'sessions', '5f3c2d10-real-user-session');
      await fs.mkdir(path.join(realSession, 'workspace/.node_modules.old-abcd1234/x'), { recursive: true });
      await fs.writeFile(path.join(realSession, 'workspace/page.astro'), 'user work');
      const sup2 = mk();
      await sup2.startupSweep;
      expect(await exists(orphan)).toBe(false); // swept
      expect(await fs.readFile(path.join(realSession, 'workspace/page.astro'), 'utf8')).toBe('user work'); // never touched
      expect(await exists(path.join(realSession, 'workspace/.node_modules.old-abcd1234'))).toBe(false); // scratch removed
      expect(await exists(wsDir)).toBe(true); // crashed session's dir is real work: kept
      expect((await health(sup2)).activeSessionIds).toEqual([]);
      await sup.stopAll();
      await sup2.stopAll();
    } finally {
      await new Promise<void>((r) => cp.close(() => r()));
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 60_000);
  it('W7: an overdue lease is terminated before the next build is admitted; without a terminator it is never force-freed', async () => {
    const { FifoBuildQueue } = await import('../src/build-queue.js');
    const clock = new ManualClock();
    const flush = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };

    // No kill callback: the queue must NOT admit a second build into the shared sandbox
    const q = new FifoBuildQueue(5_000, 60, 3_500, () => {}, clock);
    const l1 = await q.acquire('s1');
    let admitted = false;
    const p2 = q.acquire('s2').then((l) => {
      admitted = true;
      return l;
    });
    clock.advance(150); // well past the 60ms lease ceiling
    await flush();
    expect(admitted).toBe(false);
    expect(q.getStatus().activeSessionId).toBe('s1');
    l1.release();
    (await p2).release();

    // With a kill callback: expiry kills the holder, and only then admits the waiter
    const events: string[] = [];
    let l3: { release: () => void } | null = null;
    l3 = await q.acquire('s3', {
      onTerminate: async (reason) => {
        events.push(`terminate:${reason}`);
        await new Promise<void>((r) => clock.setTimeout(r, 40)); // process-group kill + exit
        events.push('killed');
        l3!.release();
      },
    });
    const p4 = q.acquire('s4').then((l) => {
      events.push('s4-admitted');
      return l;
    });
    clock.advance(60); // lease expires -> terminator runs
    await flush();
    expect(events).toEqual(['terminate:expired']); // not admitted while the holder is being killed
    clock.advance(40);
    const l4 = await p4;
    expect(events).toEqual(['terminate:expired', 'killed', 's4-admitted']);
    l4.release();

    // Preempted speculative holder that ignores the soft signal: killed after the grace, then foreground runs
    const q2 = new FifoBuildQueue(5_000, 60_000, 50, () => {}, clock);
    const ev2: string[] = [];
    await q2.acquire('spec', {
      priority: 'speculative',
      onPreempted: () => ev2.push('soft-preempt'),
      onTerminate: (reason) => {
        ev2.push(`terminate:${reason}`);
      },
    });
    const pfg = q2.acquire('fg', { priority: 'foreground' });
    await flush();
    expect(ev2).toEqual(['soft-preempt']);
    clock.advance(50); // preempt grace elapses on the manual clock
    const fg = await pfg;
    ev2.push('fg-admitted');
    expect(ev2).toEqual(['soft-preempt', 'terminate:preempted', 'fg-admitted']);
    fg.release();
  });

  it('W7: a revoked foreground lease aborts the running build via the supervisor stream', async () => {
    const { withSupervisorBuildLock } = await import('../src/verify.js');
    const released: string[] = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        if (req.url === '/internal/build-lock/acquire') {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          res.write(`${JSON.stringify({ event: 'acquired', leaseId: 'L1' })}\n`);
          setTimeout(() => res.write(`${JSON.stringify({ event: 'revoked', leaseId: 'L1', message: 'expired' })}\n`), 80);
          return;
        }
        if (req.url === '/internal/build-lock/release') released.push(body);
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    try {
      const url = `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`;
      const ac = new AbortController();
      const outcome = await withSupervisorBuildLock(
        { supervisorUrl: url, priority: 'foreground', sessionId: 's', onLeaseRevoked: () => ac.abort() },
        () =>
          new Promise<string>((resolve) => {
            const t = setTimeout(() => resolve('ran-to-completion'), 5_000);
            ac.signal.addEventListener('abort', () => {
              clearTimeout(t);
              resolve('aborted');
            });
          }),
      );
      expect(outcome).toBe('aborted');
      expect(released).toEqual([JSON.stringify({ leaseId: 'L1' })]);
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('W8: transcript mapping is cached per entry and per value, broadcasts are coalesced latest-wins, and the wire format is unchanged', async () => {
    const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
    const { createModels } = await import('@earendil-works/pi-ai/models');
    const { fauxAssistantMessage, fauxProvider } = await import('@earendil-works/pi-ai/providers/faux');
    const { createRegistry, Harness, MemoryStorage } = await import('@earendil-works/pi-durable');
    const { HalleyPiRuntime, LatestWinsThrottle } = await import('../src/pi-runtime.js');
    const faux = fauxProvider({ provider: 'anthropic', models: [{ id: 'claude-haiku-5-5', contextWindow: 1_000_000, maxTokens: 128_000 }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const TURNS = 12;
    faux.setResponses(Array.from({ length: TURNS }, (_, i) => () => fauxAssistantMessage(`Reply ${i} ` + 'lorem ipsum '.repeat(400))));
    const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry(), settings: {} }, BACKGROUND_CONTEXT);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type AnyValue = any;
    const values: AnyValue[] = [];
    try {
      const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: 'anthropic', modelId: 'claude-haiku-5-5' } } });
      harness.resume();
      const watch = await root.watch(BACKGROUND_CONTEXT);
      watch.start(async (call: { kind: string; value?: unknown }) => {
        if (call.kind === 'value') values.push(call.value);
      });
      for (let i = 0; i < TURNS; i++) {
        const sub = await root.submit({ type: 'input', requestId: `t${i}`, content: `Question ${i}` }, BACKGROUND_CONTEXT);
        await sub.wait(BACKGROUND_CONTEXT);
        for (let k = 0; k < 10; k++) await tick(); // let the watch deliver this turn's values
      }
      await watch.stop();
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }

    const mkRuntime = () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new HalleyPiRuntime({ repoRoot: '/nonexistent', stateDir: '/nonexistent' } as any) as any;
    const cached = mkRuntime();
    for (const v of values) {
      // identical output to an uncached mapping (= the old implementation's per-tick result)
      expect(cached.mapWatchValue(v)).toEqual(mkRuntime().mapWatchValue(v));
    }
    const last = values[values.length - 1];
    expect(cached.mapWatchValue(last)).toBe(cached.mapWatchValue(last)); // value-identity cache

    // Benchmark: 600 streaming ticks over the final 12-turn transcript (new live doc each tick, same entries)
    const ticks = Array.from({ length: 600 }, (_, i) => ({
      ...last,
      docs: { ...last.docs, 'pi.live': { run: { id: 'r' }, generation: { partial: { content: [{ type: 'text', text: `partial ${i}` }] } } } },
    }));
    const bench = (fn: () => void) => {
      const t0 = process.cpuUsage();
      fn();
      const d = process.cpuUsage(t0);
      return Math.round((d.user + d.system) / 1000);
    };
    let oldBytes = 0;
    const oldMs = bench(() => {
      for (const v of ticks) {
        // old: full re-map per tick + full serialize per tick + a /health isBusy() full re-map
        const snap = mkRuntime().mapWatchValue(v);
        oldBytes += JSON.stringify({ type: 'transcript_state', ...snap }).length;
        mkRuntime().mapWatchValue(v);
      }
    });
    // new: ticks arriving every ~20ms (120ms partials interleaved with tool/output docs), 100ms throttle
    let newBytes = 0;
    let emitted = 0;
    const rt = mkRuntime();
    let lastPayload = '';
    const newMs = bench(() => {
      let now = 0;
      let lastEmit = -Infinity;
      let pending: AnyValue = null;
      const emit = (v: AnyValue) => {
        const payload = JSON.stringify({ type: 'transcript_state', ...rt.mapWatchValue(v) });
        if (payload !== lastPayload) {
          lastPayload = payload;
          newBytes += payload.length;
          emitted++;
        }
      };
      for (const v of ticks) {
        now += 20;
        pending = v;
        Boolean(v.docs['pi.live']?.run); // isBusy(): no mapping
        if (now - lastEmit >= 100) {
          emit(pending);
          pending = null;
          lastEmit = now;
        }
      }
      if (pending) emit(pending);
    });
    console.log('[W8] 600 ticks, 12-turn transcript:', JSON.stringify({ old: { cpuMs: oldMs, bytes: oldBytes, updates: 600 }, new: { cpuMs: newMs, bytes: newBytes, updates: emitted } }));
    expect(emitted).toBeLessThanOrEqual(121);
    expect(newBytes).toBeLessThan(oldBytes / 4);

    // LatestWinsThrottle: leading edge, <=1 emission per interval, trailing edge carries the latest value
    const got: number[] = [];
    const thClock = new ManualClock();
    const th = new LatestWinsThrottle<number>(100, (v) => got.push(v), thClock);
    for (let i = 0; i < 30; i++) {
      th.push(i);
      thClock.advance(10);
    }
    thClock.advance(150);
    expect(got[0]).toBe(0);
    expect(got[got.length - 1]).toBe(29);
    expect(got.length).toBeLessThanOrEqual(6);
    th.cancel();
  }, 60_000);
});
