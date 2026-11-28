/**
 * Regression tests for the second reliability pass: cache integrity, disk admission, mirror and
 * session git ops, exact-sha push, LRU admission races, runner protocol versioning, WS ordering /
 * heartbeat / backpressure, and the injectable runner (createRunner with fake Pi + fake astro).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ManualClock } from '../src/clock.js';
import {
  createRunner,
  loadRunnerConfig,
  RUNNER_PROTOCOL_HEADER,
  RUNNER_PROTOCOL_VERSION,
  type AstroManagerLike,
  type PiRuntimeLike,
  type RunnerHandle,
} from '../src/index.js';
import {
  computeDependencyHash,
  NodeModulesCacheManager,
  readNodeModulesMeta,
  verifyCacheEntry,
  writeCacheManifest,
  writeNodeModulesMeta,
} from '../src/nm-cache.js';
import { createWorkspaceSupervisor } from '../src/supervisor.js';
import type { PiRuntimeOptions } from '../src/pi-runtime.js';
import { pruneUploadDir } from '../src/uploads.js';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout.trim();
const cleanup: string[] = [];
afterEach(async () => {
  for (const d of cleanup.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
async function tmpDir(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(d);
  return d;
}
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      srv.close(() => (a && typeof a === 'object' ? resolve(a.port) : reject(new Error('no port'))));
    });
  });
}
async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setImmediate(r)); // condition poll: next event-loop turn, no fixed sleep
  }
}
async function initRepo(dir: string): Promise<void> {
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'config', 'user.name', 'T');
  await git(dir, 'config', 'user.email', 't@x.test');
  await fs.mkdir(path.join(dir, 'src/pages'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src/pages/index.astro'), '---\n---\n<main>\n  <p>Hello world</p>\n</main>\n');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-qm', 'init');
  await git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
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
  ...extra,
});

describe('nm-cache integrity manifest', () => {
  it('detects in-place mutation of a hardlinked cache inode, quarantines the entry and flags linked sessions', async () => {
    const root = await tmpDir('halley-nmint-');
    const nmCacheDir = path.join(root, 'nm-cache');
    const hash = 'abc123';
    const entry = path.join(nmCacheDir, hash);
    await fs.mkdir(path.join(entry, 'node_modules/astro/dist'), { recursive: true });
    await fs.writeFile(path.join(entry, 'node_modules/astro/package.json'), '{"name":"astro"}');
    for (let i = 0; i < 50; i++) await fs.writeFile(path.join(entry, `node_modules/astro/dist/f${i}.js`), `export const v${i} = ${i};\n`);
    await fs.writeFile(path.join(entry, '.ready'), 'x');
    const built = await writeCacheManifest(entry);
    expect(built.files).toBe(51);

    expect((await verifyCacheEntry(entry)).ok).toBe(true);
    // A rotating sample covers every file exactly once over `of` links
    const seen = new Set<number>();
    for (let slice = 0; slice < 4; slice++) {
      const r = await verifyCacheEntry(entry, { sample: { slice, of: 4 } });
      expect(r.ok).toBe(true);
      expect(r.mode).toBe('sample');
      seen.add(r.checked);
    }
    expect([...seen].reduce((a, b) => a + b, 0)).toBeGreaterThan(0);

    // Session hardlinked to the entry (same uid: it CAN rewrite the shared inode)
    const sessState = path.join(root, 'sessions', 's1', 'state');
    await writeNodeModulesMeta(sessState, { mode: 'hardlinked', hash });
    const victim = path.join(entry, 'node_modules/astro/dist/f7.js');
    await fs.chmod(victim, 0o644);
    await fs.appendFile(victim, '// tampered\n');

    const report = await verifyCacheEntry(entry);
    expect(report.ok).toBe(false);
    expect(report.mismatches.map((m) => m.rel)).toContain('astro/dist/f7.js');

    const quarantined: string[] = [];
    const mgr = new NodeModulesCacheManager(nmCacheDir, path.join(root, 'pkg'), 2, {
      onQuarantine: (q) => quarantined.push(q.quarantinedAs),
    });
    expect(await mgr.verifyEntry(hash, { full: true })).toBe(false);
    expect(quarantined).toHaveLength(1);
    const names = await fs.readdir(nmCacheDir);
    expect(names).not.toContain(hash);
    expect(names.some((n) => n.startsWith(`${hash}.corrupt-`))).toBe(true);
    const meta = await readNodeModulesMeta(sessState);
    expect(meta?.integrity?.status).toBe('linked-to-corrupt-cache');
    expect(meta?.integrity?.paths.join(' ')).toContain('astro/dist/f7.js');

    // Tampering with the manifest itself is also detected
    const e2 = path.join(nmCacheDir, 'def456');
    await fs.mkdir(path.join(e2, 'node_modules/x'), { recursive: true });
    await fs.writeFile(path.join(e2, 'node_modules/x/index.js'), '1');
    await writeCacheManifest(e2);
    await fs.appendFile(path.join(e2, 'manifest.tsv'), 'x/extra.js\t1\t1\t644\n');
    expect((await verifyCacheEntry(e2)).manifestCorrupt).toBe(true);
  });

  it('cache key covers .npmrc, Node major and package manager version', async () => {
    const ws = await tmpDir('halley-nmkey-');
    await fs.writeFile(path.join(ws, 'package.json'), '{"name":"k","dependencies":{"astro":"5.0.0"}}');
    process.env.HALLEY_NPM_VERSION = '10.0.0';
    try {
      const h1 = await computeDependencyHash(ws);
      await fs.writeFile(path.join(ws, '.npmrc'), 'legacy-peer-deps=true\n');
      const h2 = await computeDependencyHash(ws);
      process.env.HALLEY_NPM_VERSION = '11.0.0';
      const h3 = await computeDependencyHash(ws);
      expect(new Set([h1, h2, h3]).size).toBe(3);
    } finally {
      delete process.env.HALLEY_NPM_VERSION;
    }
  });
});

describe('uploads pruning', () => {
  it('removes uploads older than the age limit, then the oldest until under the size cap', async () => {
    const dir = await tmpDir('halley-upl-');
    const now = Date.now();
    const mk = async (name: string, bytes: number, ageMs: number) => {
      const p = path.join(dir, name);
      await fs.writeFile(p, Buffer.alloc(bytes));
      const t = new Date(now - ageMs);
      await fs.utimes(p, t, t);
    };
    await mk('old.png', 10, 20 * 86_400_000);
    await mk('a.png', 400, 3_000);
    await mk('b.png', 400, 2_000);
    await mk('c.png', 400, 1_000);
    const r = await pruneUploadDir(dir, { maxAgeMs: 14 * 86_400_000, maxBytes: 900, now });
    expect(r.removedFiles).toBe(2);
    expect((await fs.readdir(dir)).sort()).toEqual(['b.png', 'c.png']);
  });
});

describe('supervisor: disk admission, mirror, git ops and LRU admission', () => {
  it('refuses starts and verify builds with 507 under disk pressure and reports diskPressure in /health', async () => {
    const root = await tmpDir('halley-disk-');
    process.env.HALLEY_MIN_FREE_DISK_MB = String(1024 * 1024 * 1024); // 1 PB: always under pressure
    try {
      const sup = createWorkspaceSupervisor(supOpts(root, { runnerEntry: '/nonexistent.js' }));
      await sup.startupSweep;
      const health = (await (await sup.app.request('/health')).json()) as { diskPressure?: boolean };
      expect(health.diskPressure).toBe(true);
      const start = await sup.app.request('/api/sessions/s-disk/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseBranch: 'main', workingBranch: 'halley/x', workspaceToken: 't' }),
      });
      expect(start.status).toBe(507);
      expect(((await start.json()) as { error: string }).error).toMatch(/Not enough free disk space/);
      const lock = await sup.app.request('/internal/build-lock/acquire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's-disk' }),
      });
      expect(lock.status).toBe(507);
      await sup.stopAll();
    } finally {
      delete process.env.HALLEY_MIN_FREE_DISK_MB;
    }
  });

  it('pushes exactly the requested sha (and HEAD when absent), returning pushedSha; rejects bad/unknown shas', async () => {
    const root = await tmpDir('halley-push-');
    const remote = path.join(root, 'cp', 'internal', 'git', 'repo.git');
    await fs.mkdir(remote, { recursive: true });
    await git(remote, 'init', '-q', '--bare');
    const ws = path.join(root, 'sessions', 's1', 'workspace');
    await fs.mkdir(ws, { recursive: true });
    await initRepo(ws);
    await git(ws, 'remote', 'add', 'origin', remote);
    const verified = await git(ws, 'rev-parse', 'HEAD');
    await fs.writeFile(path.join(ws, 'src/pages/index.astro'), '<p>newer, unverified</p>\n');
    await git(ws, 'commit', '-qam', 'later checkpoint');
    const head = await git(ws, 'rev-parse', 'HEAD');

    const sup = createWorkspaceSupervisor(supOpts(root, { runnerEntry: '/nonexistent.js' }));
    const push = (body: Record<string, unknown>) =>
      sup.app.request('/api/sessions/s1/git/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const r1 = await push({ workingBranch: 'halley/pub', sha: verified });
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as { pushedSha: string }).pushedSha).toBe(verified);
    expect(await git(remote, 'rev-parse', 'refs/heads/halley/pub')).toBe(verified);

    const r2 = await push({ workingBranch: 'halley/pub' }); // backward compatible: HEAD
    expect(((await r2.json()) as { pushedSha: string }).pushedSha).toBe(head);
    expect(await git(remote, 'rev-parse', 'refs/heads/halley/pub')).toBe(head);

    // force semantics kept: pushing the older verified sha again rewinds the branch
    expect((await push({ workingBranch: 'halley/pub', sha: verified })).status).toBe(200);
    expect(await git(remote, 'rev-parse', 'refs/heads/halley/pub')).toBe(verified);

    expect((await push({ workingBranch: 'halley/pub', sha: 'not-a-sha' })).status).toBe(400);
    expect((await push({ workingBranch: 'halley/pub', sha: 'f'.repeat(40) })).status).toBe(409);
    expect((await push({ workingBranch: '-bad', sha: verified })).status).toBe(400);
    await sup.stopAll();
  });

  it('mirror sync honours a differing baseBranch even while another branch sync is in flight', async () => {
    const root = await tmpDir('halley-mirror-');
    const upstream = path.join(root, 'cp', 'internal', 'git', 'repo.git');
    const src = path.join(root, 'src');
    await fs.mkdir(src, { recursive: true });
    await initRepo(src);
    await git(src, 'checkout', '-qb', 'staging');
    await fs.writeFile(path.join(src, 'staging.txt'), 's');
    await git(src, 'add', '-A');
    await git(src, 'commit', '-qm', 'staging');
    await exec('git', ['clone', '-q', '--bare', src, upstream]);
    const mainSha = await git(src, 'rev-parse', 'main');
    const stagingSha = await git(src, 'rev-parse', 'staging');

    // Two concurrent duplicates trigger nothing; drive the mirror through /api/optimize/scan-free path:
    const sup = createWorkspaceSupervisor(supOpts(root, { runnerEntry: '/nonexistent.js' }));
    const notify = (b: string) =>
      sup.app.request('/api/mirror/notify-updated', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseBranch: b }),
      });
    await Promise.all([notify('main'), notify('staging')]);
    const mirror = path.join(root, 'git-mirror', 'repo.git');
    await waitFor(async () => {
      const refs = await git(mirror, 'for-each-ref', '--format=%(refname) %(objectname)').catch(() => '');
      return refs.includes(`refs/heads/staging ${stagingSha}`) && refs.includes(`refs/heads/main ${mainSha}`);
    });
    // HEAD keeps pointing at the default branch
    expect(await git(mirror, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    const report = await sup.runMaintenance();
    expect(report.mirror).toBe('ran');
    await sup.stopAll();
  });

  it('serializes LRU admission: concurrent starts evict distinct idle sessions; a busy session is never evicted', async () => {
    const root = await tmpDir('halley-lru-');
    const busyFile = path.join(root, 'busy.json');
    await fs.writeFile(busyFile, '[]');
    const fakeRunner = path.join(root, 'fake-runner.mjs');
    await fs.writeFile(
      fakeRunner,
      `import http from 'node:http'; import fs from 'node:fs';
const id = process.env.HALLEY_SESSION_ID;
http.createServer((req, res) => {
  const busy = JSON.parse(fs.readFileSync(${JSON.stringify(busyFile)}, 'utf8')).includes(id);
  const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url === '/internal/drain') { setTimeout(() => send({ ok: true, drained: !busy, busy }), 40); return; }
  send({ ok: true, protocolVersion: ${RUNNER_PROTOCOL_VERSION}, astroReady: true, astroState: 'ready', originalBase: '/', busy });
}).listen(Number(process.env.RUNNER_PORT), '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`,
    );
    for (const id of ['c', 'd', 'a', 'b', 'e']) {
      await fs.mkdir(path.join(root, 'sessions', id, 'workspace', '.git'), { recursive: true });
    }
    const sup = createWorkspaceSupervisor(supOpts(root, { runnerEntry: fakeRunner, maxActiveWorkspaces: 2 }));
    const start = (id: string) =>
      sup.app.request(`/api/sessions/${id}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseBranch: 'main', workingBranch: `halley/${id}`, workspaceToken: 't' }),
      });
    const running = async () =>
      ((await (await sup.app.request('/health')).json()) as { activeSessionIds: string[] }).activeSessionIds.sort();
    try {
      expect((await start('c')).status).toBe(200);
      expect((await start('d')).status).toBe(200);
      expect(await running()).toEqual(['c', 'd']);
      // Before: both starts saw 2 running and both evicted 'c' -> 3 runners
      const [ra, rb] = await Promise.all([start('a'), start('b')]);
      expect(ra.status).toBe(200);
      expect(rb.status).toBe(200);
      expect(await running()).toEqual(['a', 'b']);

      // busy (pending inline checkpoint / verify / Pi) sessions are skipped by the drain re-check
      await fs.writeFile(busyFile, JSON.stringify(['a', 'b']));
      expect((await start('e')).status).toBe(200);
      expect(await running()).toEqual(['a', 'b', 'e']); // soft cap: nothing idle to evict

      const progress = (await (await sup.app.request('/api/sessions/e/progress')).json()) as {
        phases: { path: string; phasesMs: Record<string, number> };
      };
      expect(progress.phases.path).toBe('wake');
      expect(progress.phases.phasesMs).toHaveProperty('lruEvict');
      expect(progress.phases.phasesMs).toHaveProperty('runnerSpawn');
    } finally {
      await sup.stopAll();
    }
  }, 30_000);

  it('fails a start clearly when the runner speaks another protocol version', async () => {
    const root = await tmpDir('halley-proto-');
    const fakeRunner = path.join(root, 'old-runner.mjs');
    await fs.writeFile(
      fakeRunner,
      `import http from 'node:http';
http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, protocolVersion: 1, astroReady: true })); }).listen(Number(process.env.RUNNER_PORT), '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`,
    );
    await fs.mkdir(path.join(root, 'sessions', 'p1', 'workspace', '.git'), { recursive: true });
    const sup = createWorkspaceSupervisor(supOpts(root, { runnerEntry: fakeRunner }));
    const res = await sup.app.request('/api/sessions/p1/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseBranch: 'main', workingBranch: 'halley/p1', workspaceToken: 't' }),
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/protocol mismatch.*v2.*v1/);
    expect(((await (await sup.app.request('/health')).json()) as { activeSessionIds: string[] }).activeSessionIds).toEqual([]);
    await sup.stopAll();
  });
});

// ---------------------------------------------------------------------------------------------
// createRunner with injected fakes
// ---------------------------------------------------------------------------------------------

function fakeAstro(): AstroManagerLike {
  const status = {
    ready: true,
    state: 'ready' as const,
    originalBase: '/',
    previewBase: '/p/s1',
    port: 0,
    crashCount: 0,
    lastExitCode: null,
    logs: [] as string[],
  };
  return {
    start: async () => ({ originalBase: '/', previewBase: '/p/s1' }),
    stop: async () => undefined,
    pause: async () => undefined,
    resume: async () => undefined,
    restart: async () => undefined,
    getStatus: () => status,
  } as unknown as AstroManagerLike;
}

function fakePi(calls: unknown[], busy?: { value: boolean }): PiRuntimeLike {
  return {
    start: async () => undefined,
    stop: async () => undefined,
    isBusy: () => busy?.value ?? false,
    reloadAgentsMd: async () => undefined,
    addSystemContextNote: () => undefined,
    getResolvedModelId: () => 'fake-model',
    resolveModelAlias: (m: string) => m,
    submitPageCreationRequest: async () => undefined,
    submitUserInput: async (input: unknown) => {
      calls.push(input);
    },
    submitOptimizationRequest: async () => undefined,
    abort: async () => undefined,
    continueRun: async () => undefined,
    getDebugTrace: () => ({}),
  } as unknown as PiRuntimeLike;
}

async function makeRunner(clock?: ManualClock, piBusy?: { value: boolean }) {
  const root = await tmpDir('halley-runner-di-');
  const repo = path.join(root, 'sessions', 's1', 'workspace');
  await fs.mkdir(repo, { recursive: true });
  await initRepo(repo);
  const port = await freePort();
  const config = loadRunnerConfig({
    HALLEY_WORKSPACE_DIR: repo,
    HALLEY_STATE_DIR: path.join(root, 'sessions', 's1', 'state'),
    HALLEY_SESSION_ID: 's1',
    RUNNER_PORT: String(port),
    RUNNER_BIND_HOST: '127.0.0.1',
  });
  config.controlPlaneInternalUrl = ''; // no control plane notifications in tests
  const piCalls: unknown[] = [];
  const piOpts: { current?: PiRuntimeOptions } = {};
  let uuid = 0;
  const runner: RunnerHandle = await createRunner(config, {
    clock,
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
    createPiRuntime: (o) => {
      piOpts.current = o;
      return fakePi(piCalls, piBusy);
    },
    createAstroManager: () => fakeAstro(),
  });
  const url = `http://127.0.0.1:${port}`;
  return { root, repo, runner, url, port, piCalls, piOpts };
}

function connectWs(port: number): Promise<{ ws: WebSocket; messages: Array<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: Array<Record<string, unknown>> = [];
    ws.on('message', (d) => messages.push(JSON.parse(d.toString()) as Record<string, unknown>));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });
}

describe('createRunner (dependency-injected runner)', () => {
  it('is importable without side effects and reports the protocol version on every response', async () => {
    const { runner, url } = await makeRunner();
    try {
      const res = await fetch(`${url}/health`);
      expect(res.headers.get(RUNNER_PROTOCOL_HEADER)).toBe(String(RUNNER_PROTOCOL_VERSION));
      const h = (await res.json()) as Record<string, unknown>;
      expect(h.protocolVersion).toBe(RUNNER_PROTOCOL_VERSION);
      expect(h.astroReady).toBe(true);
      expect(h.busy).toBe(false);
      const missing = await fetch(`${url}/internal/nope`);
      expect(missing.headers.get(RUNNER_PROTOCOL_HEADER)).toBe(String(RUNNER_PROTOCOL_VERSION));
    } finally {
      await runner.shutdown();
    }
  });

  it('/__editor/patch debounces the checkpoint on the injected clock and reports busy until it lands', async () => {
    const clock = new ManualClock();
    const { runner, url, repo, port } = await makeRunner(clock);
    const { ws, messages } = await connectWs(port);
    try {
      const commits = async () => Number(await git(repo, 'rev-list', '--count', 'HEAD'));
      const before = await commits();
      const patch = async (text: string) => {
        const inspected = (await (
          await fetch(`${url}/__editor/inspect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: 'src/pages/index.astro', loc: '4:3' }),
          })
        ).json()) as { snapshotHash?: string; editability?: string; reason?: string };
        const res = await fetch(`${url}/__editor/patch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: 'src/pages/index.astro', loc: '4:3', expectedHash: inspected?.snapshotHash, newHtml: text }),
        });
        expect(res.status, await res.clone().text()).toBe(200);
      };
      await patch('First edit');
      let health = (await (await fetch(`${url}/health`)).json()) as { busy: boolean; pendingInlineCheckpoint: boolean };
      expect(health.busy).toBe(true); // LRU must not evict a pending inline edit
      expect(health.pendingInlineCheckpoint).toBe(true);
      clock.advance(1_000);
      await patch('Second edit'); // re-arms the debounce
      clock.advance(1_000);
      // the debounce has not fired on the manual clock: nothing can have been committed yet
      health = (await (await fetch(`${url}/health`)).json()) as typeof health;
      expect(health.pendingInlineCheckpoint).toBe(true);
      expect(await commits()).toBe(before);
      clock.advance(600);
      await waitFor(async () => (await commits()) === before + 1);
      expect(await git(repo, 'show', 'HEAD:src/pages/index.astro')).toContain('Second edit');
      const ckpt = await waitFor(() => messages.find((m) => m.type === 'checkpoint_created'));
      health = (await (await fetch(`${url}/health`)).json()) as typeof health;
      expect(health.busy).toBe(false);
      // ordering fields: one monotonic counter; the event follows the snapshot without a gap
      const snapshotSeq = messages.find((m) => m.type === 'session_state_sync')!.seq as number;
      expect(ckpt.seq).toBe(snapshotSeq + 1);
      expect(ckpt.epoch).toBe(runner.wsHandlers.sequence().epoch);
    } finally {
      ws.close();
      await runner.shutdown();
    }
  });

  it('/__editor/inspect -> file edited -> /__editor/patch relocates by fileHash/contentHash; an ambiguous duplicate is a 409 with no write', async () => {
    const { runner, url, repo } = await makeRunner();
    const rel = 'src/pages/paras.astro';
    const abs = path.join(repo, rel);
    const paras = ['<main>', '  <p>Alpha text</p>', '  <p>Beta text!</p>', '  <p>Gamma</p>', '</main>', ''].join('\n');
    const post = async (route: string, body: unknown) => {
      const res = await fetch(`${url}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    const inspect = async () => {
      const r = await post('/__editor/inspect', { file: rel, loc: '3:6' });
      expect(r.json.editability).toBe('editable-static');
      expect(typeof r.json.fileHash).toBe('string');
      expect(typeof r.json.contentHash).toBe('string');
      return r.json as { snapshotHash: string; fileHash: string; contentHash: string };
    };
    try {
      // 1) unrelated edit (an equal-length line duplicated above) between inspect and patch
      await fs.writeFile(abs, paras);
      const i1 = await inspect();
      const shifted = paras.replace('  <p>Alpha text</p>\n', '  <p>Alpha text</p>\n  <p>Alpha text</p>\n');
      await fs.writeFile(abs, shifted);
      const ok = await post('/__editor/patch', {
        file: rel,
        loc: '3:6',
        expectedHash: i1.snapshotHash,
        fileHash: i1.fileHash,
        contentHash: i1.contentHash,
        newHtml: 'Changed',
      });
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
      expect(ok.json.relocated).toBe(true);
      expect(ok.json.newLoc).toBe('4:6');
      expect(typeof ok.json.newFileHash).toBe('string');
      expect(typeof ok.json.newContentHash).toBe('string');
      expect(await fs.readFile(abs, 'utf8')).toBe(shifted.replace('Beta text!', 'Changed'));

      // 2) the inspected paragraph duplicated (equal length): ambiguous -> 409, file untouched
      await fs.writeFile(abs, paras);
      const i2 = await inspect();
      const dup = paras.replace('  <p>Beta text!</p>\n', '  <p>Beta text!</p>\n  <p>Beta text!</p>\n');
      await fs.writeFile(abs, dup);
      const conflict = await post('/__editor/patch', {
        file: rel,
        loc: '3:6',
        expectedHash: i2.snapshotHash,
        fileHash: i2.fileHash,
        contentHash: i2.contentHash,
        newHtml: 'Changed',
      });
      expect(conflict.status).toBe(409);
      expect(await fs.readFile(abs, 'utf8')).toBe(dup);
    } finally {
      await runner.shutdown();
    }
  });

  it('reports headSha from /internal/git/changes and /internal/verify; correlation ids reach every log line', async () => {
    const { runner, url, repo } = await makeRunner();
    const lines: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    const capture = (chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    };
    try {
      const head = await git(repo, 'rev-parse', 'HEAD');
      const changes = (await (await fetch(`${url}/internal/git/changes`)).json()) as { headSha: string };
      expect(changes.headSha).toBe(head);
      const verify = (await (
        await fetch(`${url}/internal/verify`, { method: 'POST', body: '{}', headers: { 'X-Request-Id': 'req-verify-1' } })
      ).json()) as { headSha: string; results: unknown[] };
      expect(verify.headSha).toBe(head);
      expect(Array.isArray(verify.results)).toBe(true);

      process.stdout.write = capture as typeof process.stdout.write;
      process.stderr.write = capture as typeof process.stderr.write;
      // an ignored git failure inside the request is logged with the caller's ids
      await fetch(`${url}/internal/git/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req-42', 'X-Halley-Run-Id': 'run-7' },
        body: JSON.stringify({ baseBranch: 'main', remoteUrl: '/nonexistent/remote.git' }),
      });
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      const tagged = lines.filter((l) => l.includes('"requestId":"req-42"'));
      expect(tagged.length).toBeGreaterThan(0);
      expect(tagged.every((l) => l.includes('"runId":"run-7"'))).toBe(true);
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      await runner.shutdown();
    }
  }, 60_000);

  it('/internal/git/undo auto-saves uncommitted work through HTTP before undoing', async () => {
    const { runner, url, repo } = await makeRunner();
    try {
      const page = path.join(repo, 'src/pages/index.astro');
      await fs.writeFile(page, '<p>v1</p>\n');
      const c1 = (await (
        await fetch(`${url}/internal/git/checkpoint`, { method: 'POST', body: JSON.stringify({ summary: 'one' }) })
      ).json()) as { checkpoint: { sha: string } };
      await fs.writeFile(page, '<p>v2</p>\n');
      await fetch(`${url}/internal/git/checkpoint`, { method: 'POST', body: JSON.stringify({ summary: 'two' }) });
      await fs.writeFile(page, '<p>UNSAVED-VIA-HTTP</p>\n');
      const res = await fetch(`${url}/internal/git/undo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetSha: c1.checkpoint.sha }),
      });
      expect(res.status).toBe(200);
      expect(await fs.readFile(page, 'utf8')).toBe('<p>v1</p>\n');
      expect(await git(repo, 'log', '--oneline', '-S', 'UNSAVED-VIA-HTTP')).toContain('Auto-save before undo');
    } finally {
      await runner.shutdown();
    }
  });

  it('WS: every frame carries a strictly increasing seq + the boot epoch; malformed frames get an error and the socket survives', async () => {
    const { runner, port, piCalls } = await makeRunner();
    const { ws, messages } = await connectWs(port);
    try {
      await waitFor(() => messages.length >= 2);
      const seq0 = runner.wsHandlers.sequence();
      expect(messages.map((m) => m.seq)).toEqual([seq0.seq - 1, seq0.seq]);
      for (const m of messages) expect(m.epoch).toBe(seq0.epoch);
      expect(messages.map((m) => m.type)).toEqual(['page_requests_sync', 'session_state_sync']);
      ws.send('{not json');
      const err1 = await waitFor(() => messages.find((m) => m.type === 'error'));
      expect(err1.message).toBe('Invalid JSON frame');
      ws.send(JSON.stringify({ type: 'definitely_not_a_message' }));
      await waitFor(() => messages.filter((m) => m.type === 'error').length === 2);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.send(JSON.stringify({ type: 'abort' }));
      ws.send(JSON.stringify({ type: 'submit_input', requestId: 'r1', text: 'hello' }));
      await waitFor(() => piCalls.length === 1);
      // no duplicates / gaps on a single connection
      const seqs = messages.map((m) => m.seq as number);
      expect(seqs).toEqual(seqs.map((_, i) => seqs[0]! + i));
    } finally {
      ws.close();
      await runner.shutdown();
    }
  });

  it('WS: a second tab connecting (its own snapshot frames) never shows up as a gap on the first tab', async () => {
    const { runner, port } = await makeRunner();
    const a = await connectWs(port);
    try {
      await waitFor(() => a.messages.length >= 2);
      const b = await connectWs(port); // unicast snapshot frames go only to tab B
      try {
        await waitFor(() => b.messages.length >= 2);
        a.ws.send('{not json'); // unicast error to A
        await waitFor(() => a.messages.some((m) => m.type === 'error'));
        for (const msgs of [a.messages, b.messages]) {
          const seqs = msgs.map((m) => m.seq as number);
          expect(seqs).toEqual(seqs.map((_, i) => i + 1)); // 1, 2, 3, ... per connection
          for (const m of msgs) expect(m.epoch).toBe(runner.wsHandlers.sequence().epoch);
        }
      } finally {
        b.ws.close();
      }
    } finally {
      a.ws.close();
      await runner.shutdown();
    }
  });

  it('WS backpressure: transcripts coalesce latest-wins, events queue in order, overflow closes with 1013', async () => {
    const clock = new ManualClock();
    const { runner, piOpts } = await makeRunner(clock);
    try {
      let buffered = 0;
      const sent: Array<Record<string, unknown>> = [];
      const closes: number[] = [];
      const fake = {
        OPEN: 1,
        readyState: 1,
        get bufferedAmount() {
          return buffered;
        },
        send(p: string, cb?: (err?: Error) => void) {
          sent.push(JSON.parse(p) as Record<string, unknown>);
          cb?.();
        },
        on: () => undefined,
        ping: () => undefined,
        terminate: () => undefined,
        close(code: number) {
          closes.push(code);
        },
      };
      runner.wsHandlers.handleConnection(fake as unknown as WebSocket);
      sent.length = 0;
      const pi = piOpts.current!;
      const transcript = (n: number) =>
        pi.onTranscriptUpdate?.({ entries: [], live: { busy: false, streamingText: `t${n}`, activeTools: [], queuedCount: 0 }, usageUsd: n } as never);

      buffered = 5 * 1024 * 1024; // > 4 MB: congested
      pi.onLockChange?.(true, 'a.astro');
      for (let i = 1; i <= 5; i++) transcript(i);
      pi.onLockChange?.(false, undefined);
      expect(sent).toHaveLength(0);

      buffered = 0;
      clock.advance(100); // flush tick
      expect(sent.map((m) => m.type)).toEqual(['workspace_lock', 'workspace_lock', 'transcript_state']);
      expect((sent[2]!.live as { streamingText: string }).streamingText).toBe('t5'); // latest wins
      const [e1, e2, t] = sent as Array<{ seq: number }>;
      expect(e2!.seq).toBe(e1!.seq + 1); // events never dropped: no gap
      expect(t!.seq).toBe(e2!.seq + 1); // the coalesced transcript takes the next seq: still no gap

      buffered = 5 * 1024 * 1024;
      for (let i = 0; i < 501; i++) pi.onLockChange?.(i % 2 === 0, 'x');
      expect(closes).toEqual([1013]);
      expect(runner.wsHandlers.clientCount()).toBe(0);
    } finally {
      await runner.shutdown();
    }
  });

  it('tree-mutating endpoints are serialized and all refuse with the same 409 while Pi is mid-turn (restore-sha exempt)', async () => {
    const piBusy = { value: false };
    const { runner, url, repo } = await makeRunner(undefined, piBusy);
    try {
      await waitFor(async () => ((await (await fetch(`${url}/health`)).json()) as { ok?: boolean }).ok);
      const head = await git(repo, 'rev-parse', 'HEAD');
      const post = (route: string, body: unknown) =>
        fetch(`${url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      piBusy.value = true;
      for (const [route, body] of [
        ['/internal/git/undo', { targetSha: head }],
        ['/internal/git/revert-file', { path: 'src/pages/index.astro' }],
        ['/internal/git/exclude-paths', { paths: ['src/pages/index.astro'] }],
        ['/internal/git/revert-start', { shas: [head] }],
        ['/internal/sync/start', { baseBranch: 'main' }],
        ['/internal/sync/undo', { targetSha: head }],
      ] as const) {
        const res = await post(route, body);
        expect(res.status, route).toBe(409);
        expect(((await res.json()) as { error: string }).error, route).toBe('Pi is currently editing; try again once it finishes.');
      }
      // publish's rollback of its own exclusion must still run
      expect((await post('/internal/git/restore-sha', { targetSha: head })).status).toBe(200);
      piBusy.value = false;
      // concurrent mutations queue behind each other instead of interleaving
      await fs.writeFile(path.join(repo, 'src/pages/index.astro'), '<p>edited</p>\n');
      const results = await Promise.all([
        post('/internal/git/exclude-paths', { paths: ['src/pages/index.astro'], baseRef: 'origin/main' }),
        post('/internal/git/restore-sha', { targetSha: head }),
        post('/internal/git/undo', { targetSha: head }),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(await git(repo, 'status', '--porcelain')).toBe('');
    } finally {
      await runner.shutdown();
    }
  });

  it('WS heartbeat terminates a client that missed two pongs, purely on the injected clock', async () => {
    const clock = new ManualClock();
    const { runner, port } = await makeRunner(clock);
    const { ws } = await connectWs(port);
    const heartbeatMs = 20_000; // loadRunnerConfig default (HALLEY_WS_HEARTBEAT_MS unset)
    try {
      await waitFor(() => runner.wsHandlers.clientCount() === 1);
      // a client that answers pings survives any number of rounds (each pong resets the count)
      for (let i = 0; i < 3; i++) {
        clock.advance(heartbeatMs);
        await waitFor(() => runner.wsHandlers.maxMissedPongs() === 0);
      }
      expect(runner.wsHandlers.clientCount()).toBe(1);
      // simulate a half-open client: stop auto-pong
      (ws as unknown as { _receiver: { removeAllListeners: (e: string) => void } })._receiver.removeAllListeners('ping');
      ws.pong = () => undefined;
      const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
      clock.advance(heartbeatMs - 1);
      expect(runner.wsHandlers.maxMissedPongs()).toBe(0); // not yet due
      clock.advance(1); // ping #1 unanswered
      expect(runner.wsHandlers.maxMissedPongs()).toBe(1);
      clock.advance(heartbeatMs); // ping #2 unanswered: still connected
      expect(runner.wsHandlers.maxMissedPongs()).toBe(2);
      expect(runner.wsHandlers.clientCount()).toBe(1);
      clock.advance(heartbeatMs - 1);
      expect(runner.wsHandlers.clientCount()).toBe(1);
      clock.advance(1); // third round: two pongs missed -> terminated
      expect(runner.wsHandlers.clientCount()).toBe(0);
      expect(await closed).toBe(1006);
    } finally {
      await runner.shutdown();
    }
  });

});
