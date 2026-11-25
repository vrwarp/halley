import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface NodeModulesMeta {
  mode: 'hardlinked' | 'detached' | 'symlink';
  hash: string;
}

const NM_META_FILE = 'nm-mode.json';

async function fileExists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

/**
 * Computes a stable SHA-256 hash of `package.json` plus the lockfile (`package-lock.json` or `pnpm-lock.yaml`).
 */
export async function computeDependencyHash(workspaceDir: string): Promise<string | null> {
  const pkgPath = path.join(workspaceDir, 'package.json');
  if (!(await fileExists(pkgPath))) return null;

  const hash = crypto.createHash('sha256');
  hash.update('package.json\0');
  hash.update(await fs.readFile(pkgPath));

  for (const lockName of ['package-lock.json', 'pnpm-lock.yaml']) {
    const lockPath = path.join(workspaceDir, lockName);
    if (await fileExists(lockPath)) {
      hash.update(`\0${lockName}\0`);
      hash.update(await fs.readFile(lockPath));
      break;
    }
  }
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
      return { mode: parsed.mode, hash: parsed.hash };
    }
  } catch {
    // not present
  }
  return null;
}

export async function writeNodeModulesMeta(stateDir: string, meta: NodeModulesMeta): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, NM_META_FILE), JSON.stringify(meta, null, 2), 'utf8');
}

async function runPackageInstall(workspaceDir: string, pkgCacheDir: string): Promise<void> {
  const hasPkgLock = await fileExists(path.join(workspaceDir, 'package-lock.json'));
  const hasPnpmLock = await fileExists(path.join(workspaceDir, 'pnpm-lock.yaml'));
  const hasPkgJson = await fileExists(path.join(workspaceDir, 'package.json'));
  if (!hasPkgJson) return;

  await fs.mkdir(pkgCacheDir, { recursive: true });
  if (hasPkgLock) {
    await execFileAsync(
      'npm',
      ['ci', '--cache', path.join(pkgCacheDir, 'npm'), '--prefer-offline', '--ignore-scripts'],
      { cwd: workspaceDir, maxBuffer: 32 * 1024 * 1024 },
    );
  } else if (hasPnpmLock) {
    await execFileAsync(
      'pnpm',
      ['install', '--store-dir', path.join(pkgCacheDir, 'pnpm'), '--frozen-lockfile'],
      { cwd: workspaceDir, maxBuffer: 32 * 1024 * 1024 },
    );
  } else {
    await execFileAsync(
      'npm',
      ['install', '--cache', path.join(pkgCacheDir, 'npm'), '--prefer-offline', '--ignore-scripts'],
      { cwd: workspaceDir, maxBuffer: 32 * 1024 * 1024 },
    );
  }
}

/**
 * Detaches a session from the shared hardlinked `node_modules` cache before a package
 * manager mutation runs, preventing in-place writes from modifying shared inodes.
 */
export async function detachHardlinkedNodeModules(
  workspaceDir: string,
  stateDir: string,
): Promise<boolean> {
  const meta = await readNodeModulesMeta(stateDir);
  if (meta?.mode !== 'hardlinked') return false;
  const nmPath = path.join(workspaceDir, 'node_modules');
  await fs.rm(nmPath, { recursive: true, force: true });
  const hash = (await computeDependencyHash(workspaceDir)) ?? meta.hash;
  await writeNodeModulesMeta(stateDir, { mode: 'detached', hash });
  return true;
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
  } catch {
    return fileExists(nmPath);
  }
}

export class NodeModulesCacheManager {
  private inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly nmCacheDir: string,
    private readonly pkgCacheDir: string,
    private readonly maxCachedHashes = 2,
  ) {}

  /**
   * Ensures a session workspace has an up-to-date, healthy `node_modules`.
   * - If `devLocalRepo` has pre-installed `node_modules`, symlinks it (fast local/E2E path).
   * - If `node_modules` is missing or incomplete/corrupt, populates atomically via hardlinked
   *   copy (`cp -al` into a staging dir then rename) from the lockfile-hashed cache.
   * - If `node_modules` exists in `hardlinked` mode and the lockfile hash changed (copy-on-change),
   *   detaches and runs a fresh isolated install in the session workspace.
   */
  async ensureSessionNodeModules(opts: {
    workspaceDir: string;
    stateDir: string;
    devLocalRepo?: string;
    onInstalling?: () => void;
  }): Promise<void> {
    const { workspaceDir, stateDir, devLocalRepo, onInstalling } = opts;
    const nmPath = path.join(workspaceDir, 'node_modules');
    const hash = await computeDependencyHash(workspaceDir);
    if (!hash) return;

    const hasNm = await fileExists(nmPath);
    const healthy = hasNm && (await isNodeModulesHealthy(nmPath, workspaceDir));
    const meta = await readNodeModulesMeta(stateDir);

    if (healthy) {
      if (!meta || meta.hash === hash) {
        return;
      }
      // Lockfile / package.json changed while node_modules exists -> copy-on-change detach & install
      onInstalling?.();
      await fs.rm(nmPath, { recursive: true, force: true });
      await runPackageInstall(workspaceDir, this.pkgCacheDir);
      await writeNodeModulesMeta(stateDir, { mode: 'detached', hash });
      return;
    }

    if (hasNm && !healthy) {
      // Self-heal partial/empty node_modules left behind by an interrupted install or copy
      await fs.rm(nmPath, { recursive: true, force: true }).catch(() => {});
    }

    // Fast path for local dev / E2E tests with a local fixture repo
    if (devLocalRepo) {
      const srcModules = path.join(devLocalRepo, 'node_modules');
      if (await fileExists(srcModules)) {
        await fs.symlink(srcModules, nmPath);
        await writeNodeModulesMeta(stateDir, { mode: 'symlink', hash });
        return;
      }
    }

    onInstalling?.();
    const cachedNmPath = await this.ensureCachedInstall(hash, workspaceDir);
    const stagingNmPath = path.join(workspaceDir, `.node_modules.tmp-${crypto.randomUUID().slice(0, 8)}`);
    try {
      await execFileAsync('cp', ['-al', cachedNmPath, stagingNmPath], { maxBuffer: 16 * 1024 * 1024 });
      await fs.rename(stagingNmPath, nmPath);
      if (!(await isNodeModulesHealthy(nmPath, workspaceDir))) {
        throw new Error('Hardlinked node_modules failed health check');
      }
      await writeNodeModulesMeta(stateDir, { mode: 'hardlinked', hash });
    } catch {
      // Fallback if cross-device, cp -al unsupported, or health check failed: real detached install
      await fs.rm(stagingNmPath, { recursive: true, force: true }).catch(() => {});
      await fs.rm(nmPath, { recursive: true, force: true }).catch(() => {});
      await runPackageInstall(workspaceDir, this.pkgCacheDir);
      await writeNodeModulesMeta(stateDir, { mode: 'detached', hash });
    }
  }

  private async ensureCachedInstall(hash: string, sourceWorkspaceDir: string): Promise<string> {
    const targetDir = path.join(this.nmCacheDir, hash);
    const readyFile = path.join(targetDir, '.ready');
    const cachedNm = path.join(targetDir, 'node_modules');

    if ((await fileExists(readyFile)) && (await isNodeModulesHealthy(cachedNm, sourceWorkspaceDir))) {
      const now = new Date();
      await fs.utimes(readyFile, now, now).catch(() => {});
      return cachedNm;
    }
    if (await fileExists(targetDir)) {
      await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
    }

    const existing = this.inflight.get(hash);
    if (existing) return existing;

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
        await fs.writeFile(path.join(tmpDir, '.ready'), new Date().toISOString(), 'utf8');
        // Atomic rename; if another worker raced, remove tmpDir
        try {
          await fs.rename(tmpDir, targetDir);
        } catch {
          if (!(await fileExists(readyFile))) throw new Error(`Failed to finalize nm-cache ${hash}`);
          await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
        await this.pruneOldCaches().catch(() => {});
        return cachedNm;
      } catch (err) {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
    })().finally(() => {
      this.inflight.delete(hash);
    });

    this.inflight.set(hash, promise);
    return promise;
  }

  async pruneOldCaches(): Promise<void> {
    const entries = await fs.readdir(this.nmCacheDir, { withFileTypes: true }).catch(() => []);
    const readyDirs: Array<{ name: string; mtimeMs: number }> = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.tmp-')) continue;
      const readyPath = path.join(this.nmCacheDir, e.name, '.ready');
      try {
        const st = await fs.stat(readyPath);
        readyDirs.push({ name: e.name, mtimeMs: st.mtimeMs });
      } catch {
        // incomplete dir; ignore
      }
    }
    readyDirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of readyDirs.slice(this.maxCachedHashes)) {
      await fs.rm(path.join(this.nmCacheDir, stale.name), { recursive: true, force: true }).catch(() => {});
    }
  }
}
