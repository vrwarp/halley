import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { errCode, ignore, ignoreCodes, logger } from './log.js';
import { pathExists, readFileOr, realpathOrNull, writeFileAtomic } from './fs-util.js';
import { execFileGroup } from './proc.js';

// All external commands run in their own process group so a timeout kills npm/pnpm and every
// grandchild (node-gyp, git, postinstall scripts) instead of only the direct child.
const execFileAsync = execFileGroup;

export interface NodeModulesMeta {
  mode: 'hardlinked' | 'detached' | 'symlink';
  hash: string;
  /** Set by the cache verifier when the shared cache entry this session links to was found mutated. */
  integrity?: {
    status: 'linked-to-corrupt-cache';
    flaggedAt: string;
    quarantinedAs: string;
    paths: string[];
  };
}

const NM_META_FILE = 'nm-mode.json';

function fileExists(p: string): Promise<boolean> {
  return pathExists(p, 'nm-cache: probe path');
}

const toolVersionCache = new Map<string, Promise<string>>();

/** `<tool> --version`, memoized per process (one spawn per tool for the process lifetime). */
export function getPackageManagerVersion(tool: 'npm' | 'pnpm'): Promise<string> {
  const override = process.env[`HALLEY_${tool.toUpperCase()}_VERSION`];
  if (override) return Promise.resolve(override);
  let p = toolVersionCache.get(tool);
  if (!p) {
    p = execFileAsync(tool, ['--version'], { timeoutMs: 15_000, maxBuffer: 64 * 1024 })
      .then((r) => r.stdout.trim())
      .catch((err) => {
        // Not installed: still hash deterministically, but a later install will fail loudly anyway
        logger.warn('nm-cache: could not determine package manager version', { tool, err });
        toolVersionCache.delete(tool);
        return 'unknown';
      });
    toolVersionCache.set(tool, p);
  }
  return p;
}

/**
 * Computes a stable SHA-256 hash of everything that determines the installed `node_modules`:
 * `package.json`, the lockfile (`package-lock.json` or `pnpm-lock.yaml`), `.npmrc`, the Node major
 * version (native addons / engines) and the version of the package manager that will install it.
 */
export async function computeDependencyHash(workspaceDir: string): Promise<string | null> {
  const pkgPath = path.join(workspaceDir, 'package.json');
  if (!(await fileExists(pkgPath))) return null;

  const hash = crypto.createHash('sha256');
  hash.update('package.json\0');
  hash.update(await fs.readFile(pkgPath));

  let tool: 'npm' | 'pnpm' = 'npm';
  for (const lockName of ['package-lock.json', 'pnpm-lock.yaml']) {
    const lockPath = path.join(workspaceDir, lockName);
    if (await fileExists(lockPath)) {
      hash.update(`\0${lockName}\0`);
      hash.update(await fs.readFile(lockPath));
      if (lockName === 'pnpm-lock.yaml') tool = 'pnpm';
      break;
    }
  }
  const npmrc = await fs.readFile(path.join(workspaceDir, '.npmrc')).catch((err) => {
    ignoreCodes(err, ['ENOENT'], 'nm-cache: read .npmrc for dependency hash', { workspaceDir });
    return null;
  });
  if (npmrc) {
    hash.update('\0.npmrc\0');
    hash.update(npmrc);
  }
  hash.update(`\0node-major\0${process.versions.node.split('.')[0]}`);
  hash.update(`\0${tool}\0${await getPackageManagerVersion(tool)}`);
  return hash.digest('hex').slice(0, 24);
}

export async function readNodeModulesMeta(stateDir: string): Promise<NodeModulesMeta | null> {
  try {
    const raw = await fs.readFile(path.join(stateDir, NM_META_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Partial<NodeModulesMeta>;
    if (
      (parsed.mode === 'hardlinked' || parsed.mode === 'detached' || parsed.mode === 'symlink') &&
      typeof parsed.hash === 'string'
    ) {
      return {
        mode: parsed.mode,
        hash: parsed.hash,
        ...(parsed.integrity ? { integrity: parsed.integrity } : {}),
      };
    }
  } catch (err) {
    ignoreCodes(err, ['ENOENT'], 'nm-cache: read node_modules meta', { stateDir });
  }
  return null;
}

export async function writeNodeModulesMeta(stateDir: string, meta: NodeModulesMeta): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
  const target = path.join(stateDir, NM_META_FILE);
  await writeFileAtomic(target, JSON.stringify(meta, null, 2), { durable: true });
}

export async function runPackageInstall(workspaceDir: string, pkgCacheDir: string): Promise<void> {
  const hasPkgLock = await fileExists(path.join(workspaceDir, 'package-lock.json'));
  const hasPnpmLock = await fileExists(path.join(workspaceDir, 'pnpm-lock.yaml'));
  const hasPkgJson = await fileExists(path.join(workspaceDir, 'package.json'));
  if (!hasPkgJson) return;

  await fs.mkdir(pkgCacheDir, { recursive: true });
  const installTimeoutMs = 180_000;
  if (hasPkgLock) {
    await execFileAsync(
      'npm',
      ['ci', '--cache', path.join(pkgCacheDir, 'npm'), '--prefer-offline', '--ignore-scripts'],
      { cwd: workspaceDir, maxBuffer: 32 * 1024 * 1024, timeoutMs: installTimeoutMs },
    );
  } else if (hasPnpmLock) {
    await execFileAsync(
      'pnpm',
      ['install', '--store-dir', path.join(pkgCacheDir, 'pnpm'), '--frozen-lockfile'],
      { cwd: workspaceDir, maxBuffer: 32 * 1024 * 1024, timeoutMs: installTimeoutMs },
    );
  } else {
    // No lockfile: resolution depends on the registry state at install time, so two sessions with the
    // same package.json may get different trees. Behaviour kept; made visible.
    logger.warn('nm-cache: no lockfile; running a non-deterministic npm install', { workspaceDir });
    await execFileAsync(
      'npm',
      ['install', '--cache', path.join(pkgCacheDir, 'npm'), '--prefer-offline', '--ignore-scripts'],
      { cwd: workspaceDir, maxBuffer: 32 * 1024 * 1024, timeoutMs: installTimeoutMs },
    );
  }
}

/**
 * Makes regular files inside a golden cached `node_modules` read-only (`chmod a-w`) while
 * keeping directories writable (`u+rwx`). This prevents in-place file mutations from corrupting
 * shared hardlinked inodes across sessions while allowing fast `fs.rm` unlinking without EACCES.
 */
async function markRegularFilesReadOnly(rootDir: string): Promise<void> {
  await execFileAsync('find', [rootDir, '-type', 'f', '-exec', 'chmod', 'a-w', '{}', '+'], {
    maxBuffer: 16 * 1024 * 1024,
    timeoutMs: 60_000,
  }).catch((err) =>
    // Non-fatal, but without it in-place writes could corrupt inodes shared by every session
    logger.warn('nm-cache: failed to mark cached node_modules read-only', { rootDir, err }),
  );
}

/**
 * Detaches a session from the shared hardlinked or symlinked `node_modules` cache before a package
 * manager mutation runs, preventing in-place writes from modifying shared inodes or host fixtures.
 */
let cpSupportsReflink: boolean | null = null;

const NM_SCRATCH_EXCLUDES = ['/.node_modules.tmp-*/', '/.node_modules.old-*/'];

/**
 * Keeps node_modules staging/old dirs out of `git add -A` (a checkpoint racing a background delete
 * of `.node_modules.old-*` would otherwise stage thousands of files).
 */
async function ensureNodeModulesScratchExcluded(workspaceDir: string): Promise<void> {
  const infoDir = path.join(workspaceDir, '.git', 'info');
  if (!(await fileExists(path.join(workspaceDir, '.git')))) return;
  try {
    await fs.mkdir(infoDir, { recursive: true });
    const excludePath = path.join(infoDir, 'exclude');
    const content = await readFileOr(excludePath, '', 'nm-cache: read .git/info/exclude');
    const lines = new Set(content.split(/\r?\n/).map((l) => l.trim()));
    const toAdd = NM_SCRATCH_EXCLUDES.filter((p) => !lines.has(p));
    if (toAdd.length === 0) return;
    const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    await writeFileAtomic(excludePath, `${content}${prefix}${toAdd.join('\n')}\n`);
  } catch (err) {
    ignore(err, 'nm-cache: update .git/info/exclude', { workspaceDir });
  }
}

/**
 * Copies `srcDir` to `destDir` as independent files (new inodes). Uses `cp --reflink=auto` so
 * copy-on-write filesystems (btrfs/xfs/zfs) make this near-instant; elsewhere it is a plain
 * `cp -a`. Hardlinks *within* the tree are preserved, hardlinks to the shared cache are not.
 */
async function copyTreeIndependent(srcDir: string, destDir: string): Promise<void> {
  const base = ['-a', `${srcDir}/.`, destDir];
  await fs.mkdir(destDir, { recursive: true });
  if (cpSupportsReflink !== false) {
    try {
      await execFileAsync('cp', ['--reflink=auto', ...base], { maxBuffer: 4 * 1024 * 1024, timeoutMs: 180_000 });
      cpSupportsReflink = true;
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/reflink|unrecognized option|illegal option|invalid option/i.test(msg)) throw err;
      cpSupportsReflink = false;
      await fs.rm(destDir, { recursive: true, force: true });
      await fs.mkdir(destDir, { recursive: true });
    }
  }
  await execFileAsync('cp', base, { maxBuffer: 4 * 1024 * 1024, timeoutMs: 180_000 });
}

/**
 * Detaches a session from the shared hardlinked or symlinked `node_modules` cache before a package
 * manager mutation runs, preventing in-place writes from modifying shared inodes or host fixtures.
 *
 * Copy-on-write and atomic with respect to the live `astro dev` server: the shared tree is copied
 * into a staging dir as real (writable) files, then swapped into place with two renames; the old
 * tree is deleted only after the swap. `node_modules` is never absent for longer than the
 * rename window. If anything fails the original tree stays in place and the error is logged.
 * Afterwards a working `node_modules` is ensured in every mode (falling back to an install).
 */
export async function detachHardlinkedNodeModules(
  workspaceDir: string,
  stateDir: string,
  pkgCacheDir?: string,
): Promise<boolean> {
  const meta = await readNodeModulesMeta(stateDir);
  const nmPath = path.join(workspaceDir, 'node_modules');
  if (!meta || (meta.mode !== 'hardlinked' && meta.mode !== 'symlink')) {
    await ensureNodeModulesPresent(workspaceDir, pkgCacheDir);
    return false;
  }
  const hash = (await computeDependencyHash(workspaceDir)) ?? meta.hash;
  await ensureNodeModulesScratchExcluded(workspaceDir);
  const suffix = crypto.randomUUID().slice(0, 8);
  const stagingPath = path.join(workspaceDir, `.node_modules.tmp-${suffix}`);
  const oldPath = path.join(workspaceDir, `.node_modules.old-${suffix}`);
  const t0 = Date.now();

  let detached = false;
  try {
    const srcReal = await realpathOrNull(nmPath, 'nm-cache: resolve node_modules before detach');
    if (srcReal) {
      await copyTreeIndependent(srcReal, stagingPath);
      // Golden cache files are a-w; the private copy must be writable for npm/pnpm in-place edits
      await execFileAsync('chmod', ['-R', 'u+w', stagingPath], {
        maxBuffer: 4 * 1024 * 1024,
        timeoutMs: 120_000,
      });
      const st = await fs.lstat(nmPath);
      if (st.isSymbolicLink()) {
        // rename(2) cannot replace a symlink with a directory: unlink then rename (µs window)
        await fs.unlink(nmPath);
        await fs.rename(stagingPath, nmPath);
      } else {
        await fs.rename(nmPath, oldPath);
        try {
          await fs.rename(stagingPath, nmPath);
        } catch (err) {
          await fs.rename(oldPath, nmPath).catch((e) => ignore(e, 'nm-cache: restore original node_modules'));
          throw err;
        }
      }
      detached = true;
    } else if (pkgCacheDir) {
      // Nothing to copy (node_modules missing): a real install is the only way to get a working tree
      await runPackageInstall(workspaceDir, pkgCacheDir);
      detached = true;
    }
  } catch (err) {
    logger.error('nm-cache: copy-on-write detach failed; keeping the shared node_modules in place', {
      workspaceDir,
      mode: meta.mode,
      err,
    });
  } finally {
    await fs.rm(stagingPath, { recursive: true, force: true }).catch((e) => ignore(e, 'nm-cache: remove detach staging'));
  }
  // Deleting the old hardlinked tree only unlinks names; never blocks the agent's command
  void fs.rm(oldPath, { recursive: true, force: true }).catch((e) => ignore(e, 'nm-cache: remove old node_modules'));

  if (detached) {
    await writeNodeModulesMeta(stateDir, { mode: 'detached', hash });
    logger.info('nm-cache: detached node_modules from shared cache', {
      workspaceDir,
      fromMode: meta.mode,
      ms: Date.now() - t0,
    });
  }
  await ensureNodeModulesPresent(workspaceDir, pkgCacheDir);
  return detached;
}

/**
 * Puts a moved-aside `node_modules` back after a failed reinstall (removing the partial tree the
 * failed install left). The meta file still names the old hash, so the next start retries.
 */
async function restorePreviousNodeModules(
  nmPath: string,
  previousNmPath: string | null,
  workspaceDir: string,
): Promise<void> {
  if (!previousNmPath) return;
  try {
    await fs.rm(nmPath, { recursive: true, force: true });
    await fs.rename(previousNmPath, nmPath);
    logger.warn('nm-cache: dependency install failed; kept the previous node_modules', { workspaceDir });
  } catch (err) {
    logger.error('nm-cache: could not restore the previous node_modules after a failed install', {
      workspaceDir,
      previousNmPath,
      err,
    });
  }
}

/** Removes a superseded tree in the background (unlinking hardlinks never blocks the caller). */
function discardPreviousNodeModules(previousNmPath: string | null): void {
  if (!previousNmPath) return;
  void fs
    .rm(previousNmPath, { recursive: true, force: true })
    .catch((e) => ignore(e, 'nm-cache: remove superseded node_modules', { previousNmPath }));
}

/** Last-resort guarantee that the workspace has a usable `node_modules` (installs when missing/broken). */
async function ensureNodeModulesPresent(workspaceDir: string, pkgCacheDir?: string): Promise<void> {
  const nmPath = path.join(workspaceDir, 'node_modules');
  if (!(await fileExists(path.join(workspaceDir, 'package.json')))) return;
  if (await isNodeModulesHealthy(nmPath, workspaceDir)) return;
  if (!pkgCacheDir) {
    logger.error('nm-cache: node_modules is missing or unhealthy and no package cache is configured', {
      workspaceDir,
    });
    return;
  }
  logger.warn('nm-cache: node_modules missing or unhealthy; reinstalling', { workspaceDir });
  try {
    await runPackageInstall(workspaceDir, pkgCacheDir);
  } catch (err) {
    logger.error('nm-cache: reinstall of missing node_modules failed', { workspaceDir, err });
  }
}

async function isNodeModulesHealthy(nmPath: string, workspaceDir: string): Promise<boolean> {
  if (!(await fileExists(nmPath))) return false;
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(workspaceDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});
    const devDeps = Object.keys(pkg.devDependencies ?? {});
    const required = deps.includes('astro')
      ? ['astro']
      : deps.length > 0
        ? [deps[0]!]
        : devDeps.length > 0
          ? [devDeps[0]!]
          : [];
    for (const dep of required) {
      if (!(await fileExists(path.join(nmPath, dep, 'package.json')))) {
        return false;
      }
    }
    return true;
  } catch (err) {
    ignore(err, 'nm-cache: unreadable package.json during health check', { workspaceDir });
    return fileExists(nmPath);
  }
}

// ---------------------------------------------------------------------------------------------
// Cache integrity manifest
//
// Every session runs as the same uid, so a session can `chmod u+w` and rewrite a hardlinked inode
// inside nm-cache/<hash>/node_modules, silently corrupting every other session that links to it.
// When an entry is built we record (relative path, size, mtimeNs, mode) of every regular file in a
// sorted TSV (`manifest.tsv`) plus its sha256 (`manifest.sha256`). Before linking from an entry the
// manifest is checked against the inodes (lstat; hardlinks share size/mtime/mode with the cache).
// ---------------------------------------------------------------------------------------------

const MANIFEST_FILE = 'manifest.tsv';
const MANIFEST_SHA_FILE = 'manifest.sha256';

export interface ManifestEntry {
  rel: string;
  size: bigint;
  mtimeNs: bigint;
  mode: number;
}

export interface IntegrityMismatch {
  rel: string;
  reason: 'missing' | 'size' | 'mtime' | 'mode' | 'type' | 'error';
}

export interface IntegrityReport {
  ok: boolean;
  mode: 'full' | 'sample' | 'manifest-only';
  checked: number;
  total: number;
  ms: number;
  mismatches: IntegrityMismatch[];
  /** The manifest itself is missing/unreadable or its checksum does not match. */
  manifestCorrupt?: boolean;
}

/** Yields to the event loop (between synchronous stat chunks, so HTTP handling never stalls). */
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Synchronous `lstat` in chunks of STAT_CHUNK with an event-loop yield between chunks: measured
 * ~10x faster than promise-based lstat through the libuv threadpool (11k files: 20ms vs 200ms)
 * while blocking the loop for only a few ms at a time.
 */
const STAT_CHUNK = 2_048;

/** Lists every regular file under `rootDir` with size / mtimeNs / mode (symlinks and dirs skipped). */
export async function collectManifestEntries(rootDir: string): Promise<ManifestEntry[]> {
  const out: ManifestEntry[] = [];
  const dirs: string[] = [''];
  let sinceYield = 0;
  while (dirs.length > 0) {
    const relDir = dirs.pop()!;
    const entries = fsSync.readdirSync(path.join(rootDir, relDir), { withFileTypes: true });
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) dirs.push(rel);
      else if (e.isFile()) {
        const st = fsSync.lstatSync(path.join(rootDir, rel), { bigint: true });
        out.push({ rel, size: st.size, mtimeNs: st.mtimeNs, mode: Number(st.mode & 0o7777n) });
      }
    }
    sinceYield += entries.length;
    if (sinceYield >= STAT_CHUNK) {
      sinceYield = 0;
      await yieldToLoop();
    }
  }
  out.sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0));
  return out;
}

export function serializeManifest(entries: readonly ManifestEntry[]): string {
  let tsv = '';
  for (const e of entries) tsv += `${e.rel}\t${e.size}\t${e.mtimeNs}\t${e.mode.toString(8)}\n`;
  return tsv;
}

export function parseManifest(tsv: string): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  for (const line of tsv.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length !== 4) throw new Error(`Malformed manifest line: ${line.slice(0, 200)}`);
    out.push({ rel: parts[0]!, size: BigInt(parts[1]!), mtimeNs: BigInt(parts[2]!), mode: parseInt(parts[3]!, 8) });
  }
  return out;
}

/** Writes `manifest.tsv` + `manifest.sha256` for `<entryDir>/node_modules` into `entryDir`. */
export async function writeCacheManifest(entryDir: string): Promise<{ files: number; ms: number }> {
  const t0 = Date.now();
  const entries = await collectManifestEntries(path.join(entryDir, 'node_modules'));
  const tsv = serializeManifest(entries);
  const sha = crypto.createHash('sha256').update(tsv).digest('hex');
  // manifest first, its sha LAST: a crash in between leaves a sha mismatch (detected as corrupt),
  // never a sha that vouches for a half-written manifest
  await writeFileAtomic(path.join(entryDir, MANIFEST_FILE), tsv, { durable: true });
  await writeFileAtomic(path.join(entryDir, MANIFEST_SHA_FILE), `${sha}\n`, { durable: true });
  return { files: entries.length, ms: Date.now() - t0 };
}

const manifestMemo = new Map<string, { sha: string; entries: ManifestEntry[] }>();

/** Reads + checksums a manifest; parsed entries are memoized by checksum (manifests are immutable). */
async function loadManifest(entryDir: string): Promise<ManifestEntry[] | null> {
  let tsv: string;
  let expected: string;
  try {
    [tsv, expected] = await Promise.all([
      fs.readFile(path.join(entryDir, MANIFEST_FILE), 'utf8'),
      fs.readFile(path.join(entryDir, MANIFEST_SHA_FILE), 'utf8'),
    ]);
  } catch (err) {
    ignoreCodes(err, ['ENOENT'], 'nm-cache: read cache manifest', { entryDir });
    return null;
  }
  const sha = crypto.createHash('sha256').update(tsv).digest('hex');
  if (sha !== expected.trim()) return null;
  const memo = manifestMemo.get(entryDir);
  if (memo?.sha === sha) return memo.entries;
  const entries = parseManifest(tsv);
  manifestMemo.set(entryDir, { sha, entries });
  return entries;
}

export async function hasCacheManifest(entryDir: string): Promise<boolean> {
  return fileExists(path.join(entryDir, MANIFEST_SHA_FILE));
}

/**
 * Checks `<entryDir>/node_modules` against its manifest. `sample` limits the check to the entries
 * with `index % sample.of === sample.slice` (a deterministic rotating slice: after `of` calls with
 * consecutive slices every file has been checked once).
 */
export async function verifyCacheEntry(
  entryDir: string,
  opts: {
    sample?: { slice: number; of: number } | ((total: number) => { slice: number; of: number } | undefined);
    maxMismatches?: number;
  } = {},
): Promise<IntegrityReport> {
  const t0 = Date.now();
  const entries = await loadManifest(entryDir);
  if (!entries) {
    return { ok: false, mode: 'manifest-only', checked: 0, total: 0, ms: Date.now() - t0, mismatches: [], manifestCorrupt: true };
  }
  const nmDir = path.join(entryDir, 'node_modules');
  const requested = typeof opts.sample === 'function' ? opts.sample(entries.length) : opts.sample;
  const sample = requested && requested.of > 1 ? requested : undefined;
  const subset = sample ? entries.filter((_, i) => i % sample.of === sample.slice % sample.of) : entries;
  const maxMismatches = opts.maxMismatches ?? 50;
  const mismatches: IntegrityMismatch[] = [];
  for (let i = 0; i < subset.length && mismatches.length < maxMismatches; i++) {
    const e = subset[i]!;
    try {
      const st = fsSync.lstatSync(path.join(nmDir, e.rel), { bigint: true, throwIfNoEntry: false });
      if (!st) mismatches.push({ rel: e.rel, reason: 'missing' });
      else if (!st.isFile()) mismatches.push({ rel: e.rel, reason: 'type' });
      else if (st.size !== e.size) mismatches.push({ rel: e.rel, reason: 'size' });
      else if (st.mtimeNs !== e.mtimeNs) mismatches.push({ rel: e.rel, reason: 'mtime' });
      else if (Number(st.mode & 0o7777n) !== e.mode) mismatches.push({ rel: e.rel, reason: 'mode' });
    } catch (err) {
      mismatches.push({ rel: e.rel, reason: errCode(err) === 'ENOTDIR' ? 'missing' : 'error' });
    }
    if (i % STAT_CHUNK === STAT_CHUNK - 1) await yieldToLoop();
  }
  return {
    ok: mismatches.length === 0,
    mode: sample ? 'sample' : 'full',
    checked: subset.length,
    total: entries.length,
    ms: Date.now() - t0,
    mismatches,
  };
}

/** Entries at or below this many files are fully verified before every link (see README numbers). */
const DEFAULT_FULL_VERIFY_MAX_FILES = 60_000;
/** Size of one rotating sample slice for larger entries. */
const DEFAULT_SAMPLE_FILES = 8_000;

export interface NodeModulesCacheOptions {
  /** Where session dirs live (`<sessionsRoot>/<id>/state/nm-mode.json`); default `<nmCacheDir>/../sessions`. */
  sessionsRoot?: string;
  fullVerifyMaxFiles?: number;
  sampleFiles?: number;
  /** Called after an entry was quarantined (sessions already flagged). */
  onQuarantine?: (info: { hash: string; quarantinedAs: string; mismatches: IntegrityMismatch[] }) => void;
}

/** Directory (inside nm-cache) holding cross-process link references: `.refs/<hash>/<ref>`. */
const REFS_DIR = '.refs';
/** A reference older than this is ignored even if its pid is alive (pid reuse guard). */
const REF_MAX_AGE_MS = 60 * 60_000;

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists but owned by someone else -> alive; ESRCH: gone
    if (errCode(err) === 'EPERM') return true;
    ignoreCodes(err, ['ESRCH'], 'nm-cache: probe shared-ref owner pid', { pid });
    return false;
  }
}

/**
 * Cross-process coordination: the supervisor, every runner and verify each own a manager over the
 * SAME nm-cache directory. A linker takes a SHARED reference (a file `.refs/<hash>/<pid>-<id>-*`)
 * for the whole lookup + `cp -al`; prune / incomplete-entry removal are EXCLUSIVE: they skip an entry
 * with a live reference from another manager, rename it out of the way, re-check (closing the
 * check-then-rename race) and only then delete it. References of dead processes are ignored and
 * swept. Quarantine is a rename (it never deletes data): an in-flight `cp -al` from it fails and
 * falls back to a detached install; the quarantined copy itself is deleted later only when unreferenced.
 */
export class NodeModulesCacheManager {
  private inflight = new Map<string, Promise<string>>();
  /** Identifies this manager's reference files (several managers can share one process). */
  private readonly instanceId = crypto.randomUUID().slice(0, 8);
  private activeReadRefs = new Map<string, number>();
  private linkCounters = new Map<string, number>();
  private readonly sessionsRoot: string;
  private readonly fullVerifyMaxFiles: number;
  private readonly sampleFiles: number;
  /** Last integrity result per hash (exposed for diagnostics / tests). */
  readonly lastIntegrity = new Map<string, IntegrityReport>();

  constructor(
    private readonly nmCacheDir: string,
    private readonly pkgCacheDir: string,
    private readonly maxCachedHashes = 2,
    private readonly cacheOpts: NodeModulesCacheOptions = {},
  ) {
    this.sessionsRoot = cacheOpts.sessionsRoot ?? path.join(path.dirname(nmCacheDir), 'sessions');
    this.fullVerifyMaxFiles = cacheOpts.fullVerifyMaxFiles ?? envNumber('HALLEY_NM_VERIFY_FULL_MAX_FILES', DEFAULT_FULL_VERIFY_MAX_FILES);
    this.sampleFiles = cacheOpts.sampleFiles ?? envNumber('HALLEY_NM_VERIFY_SAMPLE_FILES', DEFAULT_SAMPLE_FILES);
  }

  private acquireReadRef(hash: string): () => void {
    this.activeReadRefs.set(hash, (this.activeReadRefs.get(hash) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.activeReadRefs.get(hash) ?? 1) - 1;
      if (next <= 0) this.activeReadRefs.delete(hash);
      else this.activeReadRefs.set(hash, next);
    };
  }

  /**
   * Takes a shared cross-process reference on cache entry `hash` (see class doc). The returned
   * function releases it. Exposed for tests and for callers that read an entry directly.
   */
  async acquireSharedRef(hash: string): Promise<() => Promise<void>> {
    const dir = path.join(this.nmCacheDir, REFS_DIR, hash);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${process.pid}-${this.instanceId}-${crypto.randomUUID().slice(0, 8)}`);
    await fs.writeFile(file, '');
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await fs.rm(file, { force: true }).catch((e) => ignore(e, 'nm-cache: release shared ref', { hash }));
    };
  }

  /** True when a manager OTHER than this one holds a live reference on `hash` (dead ones are swept). */
  async hasForeignRefs(hash: string): Promise<boolean> {
    const dir = path.join(this.nmCacheDir, REFS_DIR, hash);
    const names = await fs.readdir(dir).catch((err) => {
      ignoreCodes(err, ['ENOENT'], 'nm-cache: list shared refs', { hash });
      return [] as string[];
    });
    const now = Date.now();
    let live = false;
    for (const name of names) {
      const [pidText, instance] = name.split('-');
      if (instance === this.instanceId) continue; // our own users are counted in activeReadRefs
      const file = path.join(dir, name);
      const st = await fs.stat(file).catch((err) => {
        ignoreCodes(err, ['ENOENT'], 'nm-cache: stat shared ref', { hash });
        return null;
      });
      if (!st) continue;
      if (pidAlive(Number(pidText)) && now - st.mtimeMs < REF_MAX_AGE_MS) {
        live = true;
        continue;
      }
      await fs.rm(file, { force: true }).catch((e) => ignore(e, 'nm-cache: sweep dead shared ref', { hash, name }));
    }
    return live;
  }

  /**
   * Deletes cache dir `name` only if no other manager references it, without a check-then-delete
   * race: rename away, re-check, then delete (or rename back). Returns true when removed.
   */
  private async removeEntryExclusive(name: string, reason: string): Promise<boolean> {
    if (await this.hasForeignRefs(name)) return false;
    const entryDir = path.join(this.nmCacheDir, name);
    const doomed = path.join(this.nmCacheDir, `.tmp-deleting-${name}-${crypto.randomUUID().slice(0, 8)}`);
    try {
      await fs.rename(entryDir, doomed);
    } catch (err) {
      ignoreCodes(err, ['ENOENT'], 'nm-cache: move entry aside for removal', { name, reason });
      return false;
    }
    if (await this.hasForeignRefs(name)) {
      // a linker referenced it in between: put it back untouched
      await fs.rename(doomed, entryDir).catch((e) => ignore(e, 'nm-cache: restore referenced entry', { name }));
      return false;
    }
    manifestMemo.delete(entryDir);
    await fs.rm(doomed, { recursive: true, force: true }).catch((e) => ignore(e, `nm-cache: ${reason}`, { name }));
    return true;
  }

  /** True while any link/build is using the cache (background verification waits for idle). */
  isBusy(): boolean {
    return this.inflight.size > 0 || this.activeReadRefs.size > 0;
  }

  /**
   * Ensures a session workspace has an up-to-date, healthy `node_modules`.
   * - Holds a reference-counted read lease on `hash` during `cp -al` so `pruneOldCaches`
   *   can never delete the source directory mid-copy.
   * - Golden cached files are marked `a-w` (read-only) so accidental in-place writes fail
   *   instead of corrupting shared inodes across sessions; the manifest check catches the rest.
   */
  async ensureSessionNodeModules(opts: {
    workspaceDir: string;
    stateDir: string;
    devLocalRepo?: string;
    onInstalling?: () => void;
  }): Promise<{ action: 'unchanged' | 'symlinked' | 'hardlinked' | 'installed'; hash: string | null }> {
    const { workspaceDir, stateDir, devLocalRepo, onInstalling } = opts;
    const nmPath = path.join(workspaceDir, 'node_modules');
    const hash = await computeDependencyHash(workspaceDir);
    if (!hash) return { action: 'unchanged', hash: null };

    const hasNm = await fileExists(nmPath);
    const healthy = hasNm && (await isNodeModulesHealthy(nmPath, workspaceDir));
    const meta = await readNodeModulesMeta(stateDir);

    // A healthy-but-stale tree is moved aside (not deleted) until its replacement is in place: if the
    // install times out or fails, the session keeps the node_modules it had instead of none at all.
    let previousNmPath: string | null = null;
    if (healthy) {
      if (!meta || (meta.hash === hash && !meta.integrity)) {
        return { action: 'unchanged', hash };
      }
      // Lockfile / package.json changed (or the linked cache was found corrupt) -> relink or install
      await ensureNodeModulesScratchExcluded(workspaceDir);
      previousNmPath = path.join(workspaceDir, `.node_modules.old-${crypto.randomUUID().slice(0, 8)}`);
      await fs.rename(nmPath, previousNmPath);
    } else if (hasNm) {
      // Self-heal partial/empty node_modules left behind by an interrupted install or copy
      await fs
        .rm(nmPath, { recursive: true, force: true })
        .catch((e) => ignore(e, 'nm-cache: remove unhealthy node_modules', { workspaceDir }));
    }

    try {
      const res = await this.installSessionNodeModules(workspaceDir, stateDir, hash, devLocalRepo, onInstalling);
      discardPreviousNodeModules(previousNmPath);
      return res;
    } catch (err) {
      await restorePreviousNodeModules(nmPath, previousNmPath, workspaceDir);
      throw err;
    }
  }

  /** Links (or, as a fallback, installs) a fresh `node_modules` for `hash` into an empty slot. */
  private async installSessionNodeModules(
    workspaceDir: string,
    stateDir: string,
    hash: string,
    devLocalRepo: string | undefined,
    onInstalling: (() => void) | undefined,
  ): Promise<{ action: 'symlinked' | 'hardlinked' | 'installed'; hash: string }> {
    const nmPath = path.join(workspaceDir, 'node_modules');
    // Fast path for local dev / E2E tests with a local fixture repo (only when hash matches fixture)
    if (devLocalRepo) {
      const fixtureHash = await computeDependencyHash(devLocalRepo).catch((e) => {
        ignore(e, 'nm-cache: hash dev fixture repo', { devLocalRepo });
        return null;
      });
      const srcModules = path.join(devLocalRepo, 'node_modules');
      if ((!fixtureHash || fixtureHash === hash) && (await fileExists(srcModules))) {
        await fs.symlink(srcModules, nmPath);
        await writeNodeModulesMeta(stateDir, { mode: 'symlink', hash });
        return { action: 'symlinked', hash };
      }
    }

    onInstalling?.();
    await ensureNodeModulesScratchExcluded(workspaceDir);
    const releaseRef = this.acquireReadRef(hash);
    // taken BEFORE the entry is looked up, so an exclusive remover in another process either sees
    // it or has already moved the entry away (then we rebuild)
    const releaseShared = await this.acquireSharedRef(hash);
    const stagingNmPath = path.join(workspaceDir, `.node_modules.tmp-${crypto.randomUUID().slice(0, 8)}`);
    try {
      const cachedNmPath = await this.ensureCachedInstall(hash, workspaceDir);
      await execFileAsync('cp', ['-al', cachedNmPath, stagingNmPath], {
        maxBuffer: 16 * 1024 * 1024,
        timeoutMs: 90_000,
      });
      await fs.rename(stagingNmPath, nmPath);
      if (!(await isNodeModulesHealthy(nmPath, workspaceDir))) {
        throw new Error('Hardlinked node_modules failed health check');
      }
      await writeNodeModulesMeta(stateDir, { mode: 'hardlinked', hash });
      return { action: 'hardlinked', hash };
    } catch (err) {
      // Fallback if cross-device, cp -al unsupported, or health check failed: real detached install
      logger.warn('nm-cache: hardlinked install failed, falling back to a detached install', {
        hash,
        workspaceDir,
        err,
      });
      await fs
        .rm(stagingNmPath, { recursive: true, force: true })
        .catch((e) => ignore(e, 'nm-cache: remove link staging dir', { stagingNmPath }));
      await fs
        .rm(nmPath, { recursive: true, force: true })
        .catch((e) => ignore(e, 'nm-cache: remove partial node_modules before fallback install', { nmPath }));
      await runPackageInstall(workspaceDir, this.pkgCacheDir);
      await writeNodeModulesMeta(stateDir, { mode: 'detached', hash });
      return { action: 'installed', hash };
    } finally {
      releaseRef();
      await releaseShared();
    }
  }

  /** Chooses full vs rotating-sample verification for an entry with `total` files. */
  private sampleFor(hash: string, total: number): { slice: number; of: number } | undefined {
    if (total <= this.fullVerifyMaxFiles) return undefined;
    const of = Math.max(2, Math.ceil(total / Math.max(1, this.sampleFiles)));
    const n = this.linkCounters.get(hash) ?? 0;
    this.linkCounters.set(hash, n + 1);
    return { slice: n % of, of };
  }

  /**
   * Verifies a ready cache entry; on mismatch quarantines it (rename to `<hash>.corrupt-<ts>`), flags
   * the sessions linked to it and returns false so the caller rebuilds. Entries built before
   * manifests existed get one written now (trust on first use).
   */
  async verifyEntry(hash: string, opts: { full?: boolean } = {}): Promise<boolean> {
    const entryDir = path.join(this.nmCacheDir, hash);
    if (!(await hasCacheManifest(entryDir))) {
      const res = await writeCacheManifest(entryDir);
      logger.info('nm-cache: wrote integrity manifest for a pre-existing cache entry', { hash, ...res });
      return true;
    }
    const report = await verifyCacheEntry(entryDir, {
      sample: opts.full ? undefined : (total) => this.sampleFor(hash, total),
    });
    this.lastIntegrity.set(hash, report);
    if (report.ok) {
      logger.debug('nm-cache: cache entry integrity ok', { hash, mode: report.mode, checked: report.checked, ms: report.ms });
      return true;
    }
    await this.quarantine(hash, report);
    return false;
  }

  private async quarantine(hash: string, report: IntegrityReport): Promise<void> {
    const entryDir = path.join(this.nmCacheDir, hash);
    const quarantinedAs = `${hash}.corrupt-${Date.now()}`;
    const dest = path.join(this.nmCacheDir, quarantinedAs);
    // Deliberately does NOT wait for other processes' shared refs: the entry is known corrupt, so an
    // in-flight `cp -al` from it must not complete. The rename is non-destructive (nothing is deleted
    // while a reader may hold it; deletion of quarantined entries is ref-checked), and a link that
    // fails here falls back to a fresh install, which is the correct outcome for a corrupt source.
    try {
      await fs.rename(entryDir, dest);
    } catch (err) {
      if (errCode(err) === 'ENOENT') return; // a concurrent verifier already quarantined it
      throw err;
    }
    manifestMemo.delete(entryDir);
    const paths = report.mismatches.slice(0, 20).map((m) => `${m.rel} (${m.reason})`);
    logger.error('nm-cache: shared node_modules cache entry was modified; quarantined and will rebuild', {
      hash,
      quarantinedAs,
      manifestCorrupt: report.manifestCorrupt ?? false,
      mismatchCount: report.mismatches.length,
      paths,
    });
    const flagged = await this.flagLinkedSessions(hash, quarantinedAs, paths);
    this.cacheOpts.onQuarantine?.({ hash, quarantinedAs, mismatches: report.mismatches });
    if (flagged.length > 0) {
      logger.warn('nm-cache: sessions are linked to a corrupt cache entry; they relink on next start', {
        hash,
        sessionIds: flagged,
      });
    }
  }

  /** Marks `nm-mode.json` of every session hardlinked to `hash` so its next start relinks. */
  private async flagLinkedSessions(hash: string, quarantinedAs: string, paths: string[]): Promise<string[]> {
    const ids = await fs.readdir(this.sessionsRoot).catch((err) => {
      ignoreCodes(err, ['ENOENT'], 'nm-cache: list sessions to flag', { sessionsRoot: this.sessionsRoot });
      return [] as string[];
    });
    const flagged: string[] = [];
    for (const id of ids) {
      const stateDir = path.join(this.sessionsRoot, id, 'state');
      const meta = await readNodeModulesMeta(stateDir);
      if (!meta || meta.mode !== 'hardlinked' || meta.hash !== hash) continue;
      try {
        await writeNodeModulesMeta(stateDir, {
          ...meta,
          integrity: { status: 'linked-to-corrupt-cache', flaggedAt: new Date().toISOString(), quarantinedAs, paths },
        });
        flagged.push(id);
      } catch (err) {
        logger.error('nm-cache: failed to flag session linked to corrupt cache', { sessionId: id, err });
      }
    }
    return flagged;
  }

  /** Full verification of every ready entry (run off the request path: supervisor idle / hourly). */
  async verifyAll(): Promise<{ verified: number; quarantined: string[] }> {
    const entries = await fs.readdir(this.nmCacheDir, { withFileTypes: true }).catch((err) => {
      ignoreCodes(err, ['ENOENT'], 'nm-cache: list cache entries for verification');
      return [];
    });
    const quarantined: string[] = [];
    let verified = 0;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name.includes('.corrupt-')) continue;
      if (this.inflight.has(e.name)) continue;
      if (!(await fileExists(path.join(this.nmCacheDir, e.name, '.ready')))) continue;
      const ok = await this.verifyEntry(e.name, { full: true }).catch((err) => {
        logger.error('nm-cache: background verification failed', { hash: e.name, err });
        return true;
      });
      verified++;
      if (!ok) quarantined.push(e.name);
    }
    return { verified, quarantined };
  }

  private async ensureCachedInstall(hash: string, sourceWorkspaceDir: string): Promise<string> {
    const targetDir = path.join(this.nmCacheDir, hash);
    const readyFile = path.join(targetDir, '.ready');
    const cachedNm = path.join(targetDir, 'node_modules');

    const existing = this.inflight.get(hash);
    if (existing) return existing;

    if ((await fileExists(readyFile)) && (await isNodeModulesHealthy(cachedNm, sourceWorkspaceDir))) {
      if (await this.verifyEntry(hash)) {
        const now = new Date();
        await fs.utimes(readyFile, now, now).catch((e) => ignore(e, 'nm-cache: touch .ready', { hash }));
        return cachedNm;
      }
      // quarantined: fall through and rebuild
    }
    // (the caller itself holds one in-process ref)
    if ((await fileExists(targetDir)) && (this.activeReadRefs.get(hash) ?? 0) <= 1) {
      await this.removeEntryExclusive(hash, 'remove incomplete cache entry');
    }

    const raced = this.inflight.get(hash);
    if (raced) return raced;

    const promise = (async () => {
      await fs.mkdir(this.nmCacheDir, { recursive: true });
      const tmpDir = path.join(this.nmCacheDir, `.tmp-${hash}-${crypto.randomUUID().slice(0, 8)}`);
      await fs.mkdir(tmpDir, { recursive: true });
      try {
        for (const name of ['package.json', 'package-lock.json', 'pnpm-lock.yaml', '.npmrc']) {
          const src = path.join(sourceWorkspaceDir, name);
          if (await fileExists(src)) {
            await fs.copyFile(src, path.join(tmpDir, name));
          }
        }
        await runPackageInstall(tmpDir, this.pkgCacheDir);
        await markRegularFilesReadOnly(path.join(tmpDir, 'node_modules'));
        const manifest = await writeCacheManifest(tmpDir);
        logger.info('nm-cache: built cache entry', { hash, files: manifest.files, manifestMs: manifest.ms });
        await writeFileAtomic(path.join(tmpDir, '.ready'), new Date().toISOString(), { durable: true });
        try {
          await fs.rename(tmpDir, targetDir);
        } catch (err) {
          if (!(await fileExists(readyFile))) throw new Error(`Failed to finalize nm-cache ${hash}`, { cause: err });
          // another process finalized the same hash first: use theirs
          ignoreCodes(err, ['ENOTEMPTY', 'EEXIST'], 'nm-cache: finalize raced another builder', { hash });
          await fs
            .rm(tmpDir, { recursive: true, force: true })
            .catch((e) => ignore(e, 'nm-cache: remove redundant cache build', { tmpDir }));
        }
        await this.pruneOldCaches().catch((e) => ignore(e, 'nm-cache: prune old caches'));
        return cachedNm;
      } catch (err) {
        await fs
          .rm(tmpDir, { recursive: true, force: true })
          .catch((e) => ignore(e, 'nm-cache: remove failed cache build', { tmpDir }));
        throw err;
      }
    })().finally(() => {
      this.inflight.delete(hash);
    });

    this.inflight.set(hash, promise);
    return promise;
  }

  async pruneOldCaches(): Promise<void> {
    const entries = await fs.readdir(this.nmCacheDir, { withFileTypes: true }).catch((err) => {
      ignoreCodes(err, ['ENOENT'], 'nm-cache: list cache entries for pruning');
      return [];
    });
    const readyDirs: Array<{ name: string; mtimeMs: number }> = [];
    const now = Date.now();
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue; // .tmp-* builds, .refs
      const corrupt = /\.corrupt-(\d+)$/.exec(e.name);
      if (corrupt) {
        // Quarantined entries are kept a day for forensics; sessions keep their own hardlinks
        if (now - Number(corrupt[1]) > 24 * 60 * 60_000) {
          await this.removeEntryExclusive(e.name, 'remove old quarantined entry');
        }
        continue;
      }
      if ((this.activeReadRefs.get(e.name) ?? 0) > 0 || this.inflight.has(e.name)) continue;
      const readyPath = path.join(this.nmCacheDir, e.name, '.ready');
      try {
        const st = await fs.stat(readyPath);
        readyDirs.push({ name: e.name, mtimeMs: st.mtimeMs });
      } catch (err) {
        // incomplete dir (being built by another process, or abandoned): left to the startup sweep
        ignoreCodes(err, ['ENOENT'], 'nm-cache: stat .ready while pruning', { name: e.name });
      }
    }
    readyDirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of readyDirs.slice(this.maxCachedHashes)) {
      if ((this.activeReadRefs.get(stale.name) ?? 0) > 0) continue;
      const removed = await this.removeEntryExclusive(stale.name, 'remove stale cache entry');
      if (!removed) logger.debug('nm-cache: stale entry still referenced by another process; kept', { name: stale.name });
    }
  }
}

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
