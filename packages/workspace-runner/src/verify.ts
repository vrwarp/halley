import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { discoverSiteRoutes } from '@halley/astro-dev-edit';
import {
  HALLEY_PLACEHOLDER_ATTR,
  HalleyRepoConfigSchema,
  type HalleyRepoConfig,
  type VerificationCheckResult,
} from '@halley/shared';
import { detectAstroBase } from './astro-manager.js';
import type { BuildPriority } from './build-queue.js';
import { withRepoGitLock } from './checkpoints-and-git.js';
import { NodeModulesCacheManager } from './nm-cache.js';

const execFileAsync = promisify(execFile);
const HAS_NICE_BIN = fsSync.existsSync('/usr/bin/nice') || fsSync.existsSync('/bin/nice');

const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * Formats verification results compactly for LLM tool output: passing checks
 * get a single concise summary line (avoiding 14KB+ of static-route build logs
 * bloating every subsequent turn), while failing checks include full output.
 */
export function formatCompactCheckSummary(results: VerificationCheckResult[]): string {
  return results
    .map((r) => {
      const clean = stripAnsi(r.output).trim();
      if (!r.passed) {
        return `[FAIL] ${r.name} (${r.durationMs}ms)\n${clean}`;
      }
      const lines = clean
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const summaryHints = lines.filter((l) =>
        /(?:verified|Result \(|errors|warnings|page\(s\) built|Indexed \d+ pages|verification passed)/i.test(l),
      );
      const tail =
        summaryHints.length > 0
          ? summaryHints.slice(-3).join(' · ')
          : lines.at(-1) ?? 'OK';
      return `[PASS] ${r.name} (${r.durationMs}ms) — ${tail}`;
    })
    .join('\n');
}

/**
 * Ensures `.astro/` and `dist/` are listed in `.git/info/exclude` so keeping
 * `.astro/` warm across verification runs never pollutes `git status` or gets
 * staged by `git add -A` in repos that omit `.astro/` from `.gitignore`.
 */
export async function ensureBuildArtifactsExcluded(repoRoot: string): Promise<void> {
  const gitInfoDir = path.join(repoRoot, '.git', 'info');
  const excludePath = path.join(gitInfoDir, 'exclude');
  try {
    await fs.access(path.join(repoRoot, '.git'));
  } catch {
    return;
  }
  try {
    await fs.mkdir(gitInfoDir, { recursive: true });
    let content = '';
    try {
      content = await fs.readFile(excludePath, 'utf8');
    } catch {
      // file does not exist yet
    }
    const existingLines = new Set(content.split(/\r?\n/).map((l) => l.trim()));
    const toAdd: string[] = [];
    for (const pattern of ['.astro/', 'dist/']) {
      if (!existingLines.has(pattern) && !existingLines.has(pattern.replace(/\/$/, ''))) {
        toAdd.push(pattern);
      }
    }
    if (toAdd.length > 0) {
      const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
      await fs.writeFile(excludePath, `${content}${prefix}${toAdd.join('\n')}\n`, 'utf8');
    }
  } catch {
    // non-fatal (e.g. git worktree with .git file)
  }
}

/**
 * Computes a side-effect-free Git tree SHA representing the current working tree
 * (excluding `.astro/`, `dist/`, and any `.github/` mutations). Identical file
 * contents before and after `createCheckpoint` produce the exact same tree SHA.
 * Returns `null` when `repoRoot` is not a Git repository.
 */
export async function computeWorkingTreeKey(repoRoot: string): Promise<string | null> {
  return withRepoGitLock(repoRoot, async () => {
    try {
      const inside = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: repoRoot,
      });
      if (inside.stdout.trim() !== 'true') return null;
    } catch {
      return null;
    }

    await ensureBuildArtifactsExcluded(repoRoot);

    // Fast path: clean working tree -> HEAD^{tree}
    try {
      const status = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: repoRoot,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (!status.stdout.trim()) {
        const tree = await execFileAsync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repoRoot });
        const sha = tree.stdout.trim();
        if (sha) return sha;
      }
    } catch {
      // Fall through to temp-index tree calculation (e.g. unborn HEAD)
    }

    // Dirty working tree: compute tree SHA using a temporary GIT_INDEX_FILE
    const tmpIndex = path.join(os.tmpdir(), `halley-tree-idx-${crypto.randomUUID()}`);
    try {
      const realIndex = path.join(repoRoot, '.git', 'index');
      try {
        await fs.copyFile(realIndex, tmpIndex);
      } catch {
        // No index yet; git will create tmpIndex on git add -A
      }
      const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
      await execFileAsync('git', ['add', '-A'], { cwd: repoRoot, env, maxBuffer: 8 * 1024 * 1024 });
      // Mirror sanitizeProtectedPaths so .github edits don't alter tree hash unexpectedly
      await execFileAsync('git', ['reset', '-q', 'HEAD', '--', '.github'], { cwd: repoRoot, env }).catch(
        async () => {
          await execFileAsync('git', ['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', '.github'], {
            cwd: repoRoot,
            env,
          }).catch(() => {});
        },
      );
      const { stdout } = await execFileAsync('git', ['write-tree'], { cwd: repoRoot, env });
      return stdout.trim() || null;
    } catch {
      return null;
    } finally {
      await fs.rm(tmpIndex, { force: true }).catch(() => {});
    }
  });
}

export interface RunShellOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  priority?: BuildPriority;
}

export async function runShell(
  cwd: string,
  command: string,
  timeoutOrOpts: number | RunShellOptions = 180_000,
): Promise<{
  passed: boolean;
  durationMs: number;
  output: string;
  aborted?: boolean;
  transient?: boolean;
}> {
  const opts: RunShellOptions =
    typeof timeoutOrOpts === 'number' ? { timeoutMs: timeoutOrOpts } : timeoutOrOpts;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const priority: BuildPriority = opts.priority ?? 'foreground';

  if (opts.signal?.aborted) {
    return {
      passed: false,
      durationMs: 0,
      output: '[Aborted before start]',
      aborted: true,
      transient: true,
    };
  }

  const start = Date.now();
  const existingNodeOpts = process.env.NODE_OPTIONS || '';
  const nodeOptions = existingNodeOpts.includes('--max-old-space-size')
    ? existingNodeOpts
    : `${existingNodeOpts} --max-old-space-size=1024`.trim();

  const niceLevel = priority === 'speculative' ? '15' : '10';
  const spawnCmd = HAS_NICE_BIN ? 'nice' : 'bash';
  const spawnArgs = HAS_NICE_BIN ? ['-n', niceLevel, 'bash', '-lc', command] : ['-lc', command];

  return new Promise((resolve) => {
    const child = spawn(spawnCmd, spawnArgs, {
      cwd,
      // Own process group so timeout/abort kills npm/astro/esbuild/pagefind grandchildren too;
      // otherwise orphaned grandchildren keep stdout/stderr pipes open and 'close' never fires.
      detached: true,
      env: {
        ...process.env,
        WORKSPACE_TOKEN: '',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        CI: '1',
        UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '4',
        NODE_OPTIONS: nodeOptions,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const chunks: string[] = [];
    let totalBytes = 0;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let spawnErrored = false;
    let killEscalationTimer: NodeJS.Timeout | null = null;
    let forceResolveTimer: NodeJS.Timeout | null = null;

    const append = (buf: Buffer) => {
      if (totalBytes > 64_000) return;
      const str = buf.toString('utf8');
      totalBytes += str.length;
      chunks.push(str);
    };

    const killProcessGroup = (signal: NodeJS.Signals) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Process group may already have exited
        }
      }
      try {
        child.kill(signal);
      } catch {
        // ignore
      }
    };

    const terminateWithEscalation = () => {
      killProcessGroup('SIGTERM');
      if (!killEscalationTimer) {
        killEscalationTimer = setTimeout(() => {
          killProcessGroup('SIGKILL');
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, 1_000);
        killEscalationTimer.unref?.();
      }
      if (!forceResolveTimer) {
        forceResolveTimer = setTimeout(() => {
          finish(false);
        }, 2_500);
        forceResolveTimer.unref?.();
      }
    };

    const onAbort = () => {
      if (settled) return;
      aborted = true;
      chunks.push('\n[Aborted]');
      terminateWithEscalation();
    };

    const finish = (passed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (killEscalationTimer) clearTimeout(killEscalationTimer);
      if (forceResolveTimer) clearTimeout(forceResolveTimer);
      resolve({
        passed: passed && !timedOut && !aborted && !spawnErrored,
        durationMs: Date.now() - start,
        output: stripAnsi(chunks.join('')).trim(),
        ...(aborted ? { aborted: true } : {}),
        ...(aborted || timedOut || spawnErrored ? { transient: true } : {}),
      });
    };

    if (opts.signal) {
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const timer = setTimeout(() => {
      timedOut = true;
      chunks.push(`\n[Timed out after ${Math.round(timeoutMs / 1000)}s]`);
      terminateWithEscalation();
    }, timeoutMs);
    timer.unref?.();

    child.on('error', (err) => {
      spawnErrored = true;
      chunks.push(`\n[Spawn error: ${err.message}]`);
      finish(false);
    });

    child.on('close', (code) => {
      finish(code === 0);
    });
  });
}

async function walkFiles(dir: string, extFilter?: Set<string>): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkFiles(full, extFilter)));
    } else if (!extFilter || extFilter.has(path.extname(e.name))) {
      out.push(full);
    }
  }
  return out;
}

export async function runAstroHygieneGuard(
  repoRoot: string,
  originalBase: string,
  config?: HalleyRepoConfig,
): Promise<VerificationCheckResult> {
  const start = Date.now();
  const issues: string[] = [];

  const forbidLinks = config?.hygiene?.forbidRootRelativeLinks ?? originalBase !== '/';
  const verifyAssets = config?.hygiene?.verifyPublicAssets ?? true;

  if (forbidLinks) {
    const astroFiles = await walkFiles(path.join(repoRoot, 'src'), new Set(['.astro']));
    for (const file of astroFiles) {
      const text = await fs.readFile(file, 'utf8');
      const matches = text.match(/(?:href|src)=["']\/(?!\/)[^"']*["']/g);
      if (matches) {
        const rel = path.relative(repoRoot, file);
        issues.push(`${rel}: hardcoded root-relative path ${matches.join(', ')} — use url(...) helper instead`);
      }
    }
  }

  if (verifyAssets) {
    // Check JSON content collections for coverImage / image fields
    const contentDir = path.join(repoRoot, 'src', 'content');
    const jsonFiles = await walkFiles(contentDir, new Set(['.json']));
    for (const jf of jsonFiles) {
      try {
        const parsed = JSON.parse(await fs.readFile(jf, 'utf8')) as Record<string, unknown>;
        if (typeof parsed.coverImage === 'string' && parsed.coverImage.startsWith('/')) {
          const asset = path.join(repoRoot, 'public', parsed.coverImage.replace(/^\/+/, ''));
          try {
            await fs.access(asset);
          } catch {
            issues.push(`${path.relative(repoRoot, jf)}: missing public asset ${parsed.coverImage}`);
          }
        }
      } catch {
        // ignore invalid json here (astro check catches schema)
      }
    }

    // Check url('/...') static asset references (images, PDFs, icons, fonts, media) in src/
    const STATIC_ASSET_EXT_RE = /\.(?:webp|png|jpe?g|gif|svg|ico|avif|pdf|mp3|mp4|webm|woff2?|ttf|otf)$/i;
    const srcFiles = await walkFiles(path.join(repoRoot, 'src'), new Set(['.astro', '.ts', '.tsx']));
    for (const sf of srcFiles) {
      const text = await fs.readFile(sf, 'utf8');
      const refs = [...text.matchAll(/url\(\s*['"](\/[^'"?#]+)(?:[?#][^'"]*)?['"]\s*\)/g)];
      for (const m of refs) {
        const assetRel = m[1]!;
        if (!STATIC_ASSET_EXT_RE.test(assetRel)) continue;
        const abs = path.join(repoRoot, 'public', assetRel.replace(/^\/+/, ''));
        try {
          await fs.access(abs);
        } catch {
          issues.push(`${path.relative(repoRoot, sf)}: missing public asset ${assetRel}`);
        }
      }
    }
  }

  return {
    name: 'Astro hygiene & assets',
    command: 'halley-hygiene-guard',
    passed: issues.length === 0,
    durationMs: Date.now() - start,
    output: issues.length === 0 ? 'All subpath links and public assets verified.' : issues.join('\n'),
  };
}

export async function runUnfinishedPagesCheck(repoRoot: string): Promise<VerificationCheckResult> {
  const start = Date.now();
  const issues: string[] = [];

  const srcFiles = await walkFiles(path.join(repoRoot, 'src'), new Set(['.astro', '.md', '.mdx']));
  for (const file of srcFiles) {
    try {
      const text = await fs.readFile(file, 'utf8');
      if (text.includes(HALLEY_PLACEHOLDER_ATTR)) {
        issues.push(`${path.relative(repoRoot, file)}: still contains an unfinished Halley placeholder`);
      }
    } catch {
      // ignore
    }
  }

  const distFiles = await walkFiles(path.join(repoRoot, 'dist'), new Set(['.html']));
  for (const file of distFiles) {
    try {
      const text = await fs.readFile(file, 'utf8');
      if (text.includes(HALLEY_PLACEHOLDER_ATTR)) {
        issues.push(`${path.relative(repoRoot, file)}: built HTML still contains an unfinished Halley placeholder`);
      }
    } catch {
      // ignore
    }
  }

  return {
    name: 'No unfinished pages',
    command: 'halley-unfinished-pages',
    passed: issues.length === 0,
    durationMs: Date.now() - start,
    output:
      issues.length === 0
        ? 'No unfinished page placeholders found.'
        : issues.join('\n'),
  };
}

export async function runUnlistedIntegrityCheck(
  repoRoot: string,
  originalBase: string,
): Promise<VerificationCheckResult> {
  const start = Date.now();
  const issues: string[] = [];

  const routes = await discoverSiteRoutes(repoRoot);
  const unlisted = routes.filter((r) => r.unlisted);

  if (unlisted.length === 0) {
    return {
      name: 'Unlisted page integrity',
      command: 'halley-unlisted-integrity',
      passed: true,
      durationMs: Date.now() - start,
      output: 'No unlisted pages to verify.',
    };
  }

  const distDir = path.join(repoRoot, 'dist');
  const distExists = await fs
    .access(distDir)
    .then(() => true)
    .catch(() => false);

  if (!distExists) {
    return {
      name: 'Unlisted page integrity',
      command: 'halley-unlisted-integrity',
      passed: true,
      durationMs: Date.now() - start,
      output: 'Skipped (dist/ not built yet).',
    };
  }

  // Read all sitemap*.xml files in dist/
  const sitemapContents: Array<{ name: string; text: string }> = [];
  try {
    const distEntries = await fs.readdir(distDir, { withFileTypes: true });
    for (const e of distEntries) {
      if (e.isFile() && /^sitemap.*\.xml$/i.test(e.name)) {
        const text = await fs.readFile(path.join(distDir, e.name), 'utf8');
        sitemapContents.push({ name: e.name, text });
      }
    }
  } catch {
    // ignore
  }

  // Read header/nav/footer markup from dist/index.html
  let chromeHtml = '';
  try {
    const indexHtml = await fs.readFile(path.join(distDir, 'index.html'), 'utf8');
    const blocks = [
      ...(indexHtml.match(/<header\b[\s\S]*?<\/header>/gi) ?? []),
      ...(indexHtml.match(/<nav\b[\s\S]*?<\/nav>/gi) ?? []),
      ...(indexHtml.match(/<footer\b[\s\S]*?<\/footer>/gi) ?? []),
    ];
    chromeHtml = blocks.join('\n');
  } catch {
    // ignore
  }

  const basePrefix = originalBase === '/' ? '' : originalBase.replace(/\/$/, '');

  for (const page of unlisted) {
    const clean = page.route.replace(/^\/+/, '').replace(/\/+$/, '');
    const htmlCandidates = [
      path.join(distDir, clean, 'index.html'),
      path.join(distDir, `${clean}.html`),
    ];
    let builtHtml: string | null = null;
    for (const c of htmlCandidates) {
      try {
        builtHtml = await fs.readFile(c, 'utf8');
        break;
      } catch {
        // try next
      }
    }

    if (builtHtml !== null) {
      const hasNoindex =
        /<meta\b[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(builtHtml) ||
        /<meta\b[^>]*content=["'][^"']*noindex[^"']*["'][^>]*name=["']robots["']/i.test(builtHtml);
      if (!hasNoindex) {
        issues.push(`${page.route}: built HTML is missing a <meta name="robots" content="noindex"> tag`);
      }
    }

    const fullRoutePath = `${basePrefix}${page.route}`;
    const routePattern = new RegExp(
      `${fullRoutePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\/?(?:<|"|'|\\s))`,
      'i',
    );

    for (const sm of sitemapContents) {
      if (routePattern.test(sm.text)) {
        issues.push(`${page.route}: unlisted page still appears in dist/${sm.name}`);
      }
    }

    if (chromeHtml) {
      const hrefRe = new RegExp(
        `href=["'](?:https?:\\/\\/[^"']*)?${fullRoutePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/?["']`,
        'i',
      );
      if (hrefRe.test(chromeHtml)) {
        issues.push(`${page.route}: unlisted page is linked from the site header/nav/footer`);
      }
    }
  }

  return {
    name: 'Unlisted page integrity',
    command: 'halley-unlisted-integrity',
    passed: issues.length === 0,
    durationMs: Date.now() - start,
    output:
      issues.length === 0
        ? `Verified ${unlisted.length} unlisted page(s): noindex present, excluded from sitemaps and navigation.`
        : issues.join('\n'),
  };
}

export interface BuildLockClientOptions {
  supervisorUrl?: string;
  hostSecret?: string;
  sessionId?: string;
  verifySandboxDir?: string;
  priority?: BuildPriority;
  signal?: AbortSignal;
  bypassCache?: boolean;
  onQueued?: (position: number, message: string) => void;
  onAcquired?: () => void;
  onLeaseAcquired?: (leaseId: string) => void;
  onPreempted?: () => void;
}

async function syncVerifySandboxToTree(
  sourceRepoRoot: string,
  treeSha: string,
  verifySandboxRoot: string,
): Promise<string> {
  const sandboxRepoDir = path.join(verifySandboxRoot, 'workspace');
  const sandboxStateDir = path.join(verifySandboxRoot, 'state');
  await fs.mkdir(sandboxRepoDir, { recursive: true });
  await fs.mkdir(sandboxStateDir, { recursive: true });

  const hasGit = await fs
    .access(path.join(sandboxRepoDir, '.git'))
    .then(() => true)
    .catch(() => false);
  if (!hasGit) {
    await execFileAsync('git', ['init', '-q'], { cwd: sandboxRepoDir });
  }

  const infoDir = path.join(sandboxRepoDir, '.git', 'objects', 'info');
  await fs.mkdir(infoDir, { recursive: true });
  const alternates: string[] = [path.resolve(sourceRepoRoot, '.git', 'objects')];
  if (process.env.HALLEY_MIRROR_PATH) {
    const mirrorObjs = path.resolve(process.env.HALLEY_MIRROR_PATH, 'objects');
    if (fsSync.existsSync(mirrorObjs)) {
      alternates.push(mirrorObjs);
    }
  }
  await fs.writeFile(path.join(infoDir, 'alternates'), `${alternates.join('\n')}\n`, 'utf8');

  await execFileAsync('git', ['-c', 'safe.directory=*', 'read-tree', '--reset', '-u', treeSha], {
    cwd: sandboxRepoDir,
    maxBuffer: 16 * 1024 * 1024,
  });
  await execFileAsync(
    'git',
    ['-c', 'safe.directory=*', 'clean', '-fd', '-e', 'node_modules', '-e', '.astro'],
    { cwd: sandboxRepoDir, maxBuffer: 16 * 1024 * 1024 },
  );

  const sourceNmReal = await fs
    .realpath(path.join(sourceRepoRoot, 'node_modules'))
    .catch(() => null);
  const sandboxNmPath = path.join(sandboxRepoDir, 'node_modules');
  if (sourceNmReal) {
    const currentSandboxNm = await fs.realpath(sandboxNmPath).catch(() => null);
    if (currentSandboxNm !== sourceNmReal) {
      await fs.rm(sandboxNmPath, { recursive: true, force: true }).catch(() => {});
      await fs.symlink(sourceNmReal, sandboxNmPath, 'dir');
    }
  } else if (
    await fs
      .access(path.join(sandboxRepoDir, 'package-lock.json'))
      .then(() => true)
      .catch(() =>
        fs
          .access(path.join(sandboxRepoDir, 'pnpm-lock.yaml'))
          .then(() => true)
          .catch(() => false),
      )
  ) {
    const nmCacheDir =
      process.env.HALLEY_NM_CACHE_DIR || path.join(path.dirname(verifySandboxRoot), 'nm-cache');
    const pkgCacheDir =
      process.env.HALLEY_PKG_CACHE_DIR || path.join(path.dirname(verifySandboxRoot), 'pkg-cache');
    const nmCache = new NodeModulesCacheManager(nmCacheDir, pkgCacheDir, 2);
    await nmCache.ensureSessionNodeModules({
      workspaceDir: sandboxRepoDir,
      stateDir: sandboxStateDir,
      devLocalRepo: process.env.HALLEY_DEV_LOCAL_REPO || undefined,
    });
  }

  return sandboxRepoDir;
}

export async function promoteSupervisorBuildLock(
  supervisorUrl: string,
  hostSecret: string | undefined,
  leaseId: string,
): Promise<boolean> {
  const base = supervisorUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (hostSecret) headers['Authorization'] = `Bearer ${hostSecret}`;
  try {
    const res = await fetch(`${base}/internal/build-lock/promote`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ leaseId }),
    });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => ({}))) as { promoted?: boolean };
    return Boolean(data.promoted);
  } catch {
    return false;
  }
}

/**
 * Acquires the container-wide priority FIFO build lock from the workspaces supervisor when
 * `supervisorUrl` is configured, streaming queue position (and speculative preemption) updates
 * via NDJSON. Falls back to in-process execution if running standalone without a supervisor.
 */
export async function withSupervisorBuildLock<T>(
  opts: BuildLockClientOptions | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const supervisorUrl = opts?.supervisorUrl?.replace(/\/+$/, '');
  if (!supervisorUrl) {
    return fn();
  }

  const priority: BuildPriority = opts?.priority ?? 'foreground';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts?.hostSecret) {
    headers['Authorization'] = `Bearer ${opts.hostSecret}`;
  }

  const res = await fetch(`${supervisorUrl}/internal/build-lock/acquire`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sessionId: opts?.sessionId || 'unknown', priority }),
    signal: opts?.signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to acquire build lock (${res.status}): ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let leaseId = '';
  let preempted = false;

  const parseLine = (line: string): 'acquired' | 'preempted' | 'other' => {
    const evt = JSON.parse(line) as {
      event: 'queued' | 'acquired' | 'preempted' | 'timeout' | 'error';
      position?: number;
      leaseId?: string;
      message?: string;
    };
    if (evt.event === 'queued' && typeof evt.position === 'number') {
      const msg =
        evt.message ||
        `Waiting for another editor's checks to finish (position ${evt.position})…`;
      opts?.onQueued?.(evt.position, msg);
      return 'other';
    }
    if (evt.event === 'acquired' && evt.leaseId) {
      leaseId = evt.leaseId;
      opts?.onAcquired?.();
      opts?.onLeaseAcquired?.(evt.leaseId);
      return 'acquired';
    }
    if (evt.event === 'preempted') {
      preempted = true;
      opts?.onPreempted?.();
      return 'preempted';
    }
    if (evt.event === 'timeout' || evt.event === 'error') {
      throw new Error(evt.message || 'Timed out waiting for build queue');
    }
    return 'other';
  };

  let readerClosed = false;
  const closeReader = async () => {
    if (readerClosed) return;
    readerClosed = true;
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf('\n');
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) {
            const kind = parseLine(line);
            if (kind === 'acquired' || kind === 'preempted') break;
          }
          nl = buffer.indexOf('\n');
        }
        if (leaseId || preempted) break;
      }
      if (done) break;
    }
  } catch (err) {
    await closeReader();
    throw err;
  }

  if (preempted) {
    await closeReader();
    throw new Error('Speculative build lock preempted');
  }

  if (!leaseId) {
    await closeReader();
    throw new Error('Build lock stream closed before lock was acquired');
  }

  // For speculative leases, keep reading the open NDJSON stream so preemption events fire immediately
  if (priority === 'speculative') {
    void (async () => {
      try {
        while (!readerClosed) {
          const { value, done } = await reader.read();
          if (value) {
            buffer += decoder.decode(value, { stream: true });
            let nl = buffer.indexOf('\n');
            while (nl !== -1) {
              const line = buffer.slice(0, nl).trim();
              buffer = buffer.slice(nl + 1);
              if (line) {
                try {
                  if (parseLine(line) === 'preempted') return;
                } catch {
                  // ignore malformed trailing line
                }
              }
              nl = buffer.indexOf('\n');
            }
          }
          if (done) break;
        }
      } catch {
        // stream aborted on release/promote
      }
    })();
  } else {
    await closeReader();
  }

  try {
    return await fn();
  } finally {
    await closeReader();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const relRes = await fetch(`${supervisorUrl}/internal/build-lock/release`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ leaseId }),
          signal: AbortSignal.timeout(5_000),
        });
        if (relRes.ok) break;
      } catch {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 150));
      }
    }
  }
}

export interface VerificationRunResult {
  allPassed: boolean;
  results: VerificationCheckResult[];
  fromCache?: boolean;
  aborted?: boolean;
}

interface InternalVerifyRunResult extends VerificationRunResult {
  transient?: boolean;
}

interface InFlightVerify {
  treeSha: string | null;
  priority: BuildPriority;
  abortController: AbortController;
  leaseId: string | null;
  supervisorUrl?: string;
  hostSecret?: string;
  promise: Promise<InternalVerifyRunResult>;
}

interface RepoVerifyState {
  cache: Map<string, { allPassed: boolean; results: VerificationCheckResult[] }>;
  inFlight: InFlightVerify | null;
}

const MAX_CACHE_ENTRIES = 8;
const repoStates = new Map<string, RepoVerifyState>();

function getRepoState(repoRoot: string): RepoVerifyState {
  const key = path.resolve(repoRoot);
  let state = repoStates.get(key);
  if (!state) {
    state = { cache: new Map(), inFlight: null };
    repoStates.set(key, state);
  }
  return state;
}

function setCachedResult(
  state: RepoVerifyState,
  treeSha: string,
  entry: { allPassed: boolean; results: VerificationCheckResult[] },
): void {
  state.cache.delete(treeSha);
  state.cache.set(treeSha, entry);
  while (state.cache.size > MAX_CACHE_ENTRIES) {
    const oldest = state.cache.keys().next().value;
    if (oldest !== undefined) state.cache.delete(oldest);
    else break;
  }
}

/**
 * Immediately cancels any in-flight speculative verification for `repoRoot`
 * (e.g. when the user starts typing, submits an AI prompt, or syncs/reverts).
 */
export function invalidateSpeculativeVerification(repoRoot: string): void {
  const state = repoStates.get(path.resolve(repoRoot));
  if (state?.inFlight && state.inFlight.priority === 'speculative') {
    state.inFlight.abortController.abort();
  }
}

/** Clears cached verification results for `repoRoot` (primarily for tests). */
export function clearVerificationCache(repoRoot: string): void {
  const state = repoStates.get(path.resolve(repoRoot));
  if (state) {
    state.cache.clear();
  }
}

/**
 * Runs a low-priority speculative verification in the background, populating the
 * tree-SHA cache silently. Swallows abort/preemption errors cleanly.
 */
export async function runSpeculativeVerification(
  repoRoot: string,
  lockOpts?: Omit<BuildLockClientOptions, 'priority'>,
): Promise<VerificationRunResult | null> {
  try {
    const res = await runAllVerificationChecks(repoRoot, {
      ...lockOpts,
      priority: 'speculative',
    });
    return res.aborted ? null : res;
  } catch {
    return null;
  }
}

export async function runAllVerificationChecks(
  repoRoot: string,
  lockOpts?: BuildLockClientOptions,
): Promise<VerificationRunResult> {
  const priority: BuildPriority = lockOpts?.priority ?? 'foreground';
  const state = getRepoState(repoRoot);

  // Retry loop handles the rare race where a coalesced speculative run gets
  // preempted right before promotion completes.
  for (let attempt = 0; attempt < 2; attempt++) {
    const treeSha = await computeWorkingTreeKey(repoRoot);

    if (treeSha && !lockOpts?.bypassCache) {
      const cached = state.cache.get(treeSha);
      if (cached) {
        // Refresh LRU order
        setCachedResult(state, treeSha, cached);
        return {
          allPassed: cached.allPassed,
          results: cached.results,
          fromCache: true,
        };
      }
    }

    const existing = state.inFlight;
    if (existing) {
      // Same-tree coalescing
      if (treeSha && existing.treeSha === treeSha && !existing.abortController.signal.aborted) {
        if (existing.priority === 'speculative' && priority === 'foreground') {
          if (existing.leaseId && existing.supervisorUrl) {
            const promoted = await promoteSupervisorBuildLock(
              existing.supervisorUrl,
              existing.hostSecret,
              existing.leaseId,
            );
            if (!promoted) {
              // Lease was already preempted by another session: abort the speculative run and start fresh
              existing.abortController.abort();
              await existing.promise.catch(() => {});
              continue;
            }
          }
          existing.priority = 'foreground';
        }
        const joined = await existing.promise;
        if (joined.aborted && priority === 'foreground') {
          continue;
        }
        return {
          allPassed: joined.allPassed,
          results: joined.results,
          ...(joined.aborted ? { aborted: true } : {}),
        };
      }

      if (existing.priority === 'speculative') {
        // Abort stale speculative run (different tree or already aborting)
        existing.abortController.abort();
        await existing.promise.catch(() => {});
        continue;
      }

      // Existing run is foreground for a different tree
      if (priority === 'speculative') {
        return { allPassed: false, results: [], aborted: true };
      }
      await existing.promise.catch(() => {});
      continue;
    }

    const ac = new AbortController();
    if (lockOpts?.signal) {
      if (lockOpts.signal.aborted) {
        return { allPassed: false, results: [], aborted: true };
      }
      lockOpts.signal.addEventListener('abort', () => ac.abort(), { once: true });
    }

    const runEntry: InFlightVerify = {
      treeSha,
      priority,
      abortController: ac,
      leaseId: null,
      supervisorUrl: lockOpts?.supervisorUrl,
      hostSecret: lockOpts?.hostSecret,
      promise: Promise.resolve({ allPassed: false, results: [] }),
    };

    const execPromise = (async (): Promise<InternalVerifyRunResult> => {
      try {
        const outcome = await withSupervisorBuildLock(
          {
            ...lockOpts,
            priority,
            signal: ac.signal,
            onLeaseAcquired: (leaseId) => {
              runEntry.leaseId = leaseId;
              lockOpts?.onLeaseAcquired?.(leaseId);
              // If coalesced into foreground while waiting in queue, promote immediately
              if (
                priority === 'speculative' &&
                runEntry.priority === 'foreground' &&
                runEntry.supervisorUrl
              ) {
                void promoteSupervisorBuildLock(
                  runEntry.supervisorUrl,
                  runEntry.hostSecret,
                  leaseId,
                );
              }
            },
            onPreempted: () => {
              if (runEntry.priority === 'speculative') {
                ac.abort();
                lockOpts?.onPreempted?.();
              }
            },
          },
          async () => {
            const sandboxRoot =
              lockOpts?.verifySandboxDir || process.env.HALLEY_VERIFY_SANDBOX_DIR || '';
            let targetRepoDir = repoRoot;
            if (sandboxRoot && treeSha) {
              try {
                targetRepoDir = await syncVerifySandboxToTree(repoRoot, treeSha, sandboxRoot);
              } catch (err) {
                console.warn(
                  '[halley-verify] Falling back to session workspace after verify-sandbox sync error:',
                  err,
                );
                targetRepoDir = repoRoot;
              }
            }
            return runAllVerificationChecksUnlocked(targetRepoDir, {
              signal: ac.signal,
              getPriority: () => runEntry.priority,
            });
          },
        );

        if (!outcome.aborted && !outcome.transient && treeSha) {
          const afterTreeSha = await computeWorkingTreeKey(repoRoot);
          if (afterTreeSha === treeSha) {
            setCachedResult(state, treeSha, {
              allPassed: outcome.allPassed,
              results: outcome.results,
            });
          }
        }
        return outcome;
      } catch (err) {
        if (ac.signal.aborted || priority === 'speculative') {
          return { allPassed: false, results: [], aborted: true, transient: true };
        }
        throw err;
      } finally {
        if (state.inFlight === runEntry) {
          state.inFlight = null;
        }
      }
    })();

    runEntry.promise = execPromise;
    state.inFlight = runEntry;

    const finalRes = await execPromise;
    return {
      allPassed: finalRes.allPassed,
      results: finalRes.results,
      ...(finalRes.aborted ? { aborted: true } : {}),
    };
  }

  return { allPassed: false, results: [], aborted: true };
}

async function runAllVerificationChecksUnlocked(
  repoRoot: string,
  opts?: { signal?: AbortSignal; getPriority?: () => BuildPriority },
): Promise<InternalVerifyRunResult> {
  const results: VerificationCheckResult[] = [];
  const originalBase = await detectAstroBase(repoRoot);
  await ensureBuildArtifactsExcluded(repoRoot);

  let halleyConfig: HalleyRepoConfig | undefined;
  try {
    const raw = await fs.readFile(path.join(repoRoot, '.halley.json'), 'utf8');
    halleyConfig = HalleyRepoConfigSchema.parse(JSON.parse(raw));
  } catch {
    halleyConfig = undefined;
  }

  let aborted = false;
  let transient = false;

  try {
    if (opts?.signal?.aborted) {
      return { allPassed: false, results, aborted: true, transient: true };
    }
    results.push(await runAstroHygieneGuard(repoRoot, originalBase, halleyConfig));
    results.push(await runUnfinishedPagesCheck(repoRoot));

    let buildSucceeded = true;

    if (halleyConfig?.checks && halleyConfig.checks.length > 0) {
      for (const c of halleyConfig.checks) {
        if (opts?.signal?.aborted) {
          aborted = true;
          transient = true;
          break;
        }
        const res = await runShell(repoRoot, c.command, {
          signal: opts?.signal,
          priority: opts?.getPriority?.() ?? 'foreground',
        });
        if (res.aborted) aborted = true;
        if (res.transient) transient = true;
        results.push({
          name: c.name,
          command: c.command,
          passed: res.passed,
          durationMs: res.durationMs,
          output: res.output,
        });
        if (!res.passed) buildSucceeded = false;
        if (aborted) break;
      }
    } else {
      let scripts: Record<string, string> = {};
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
          scripts?: Record<string, string>;
        };
        scripts = pkg.scripts ?? {};
      } catch {
        scripts = {};
      }

      const ordered: Array<{ name: string; script: string }> = [];
      if (scripts.check) ordered.push({ name: 'Type & Astro check', script: 'npm run check' });
      if (scripts.build) ordered.push({ name: 'Production build', script: 'npm run build' });
      for (const key of Object.keys(scripts).sort()) {
        if (key.startsWith('verify:')) {
          ordered.push({ name: `Verify (${key.slice('verify:'.length)})`, script: `npm run ${key}` });
        }
      }

      for (const item of ordered) {
        if (opts?.signal?.aborted) {
          aborted = true;
          transient = true;
          break;
        }
        const res = await runShell(repoRoot, item.script, {
          signal: opts?.signal,
          priority: opts?.getPriority?.() ?? 'foreground',
        });
        if (res.aborted) aborted = true;
        if (res.transient) transient = true;
        results.push({
          name: item.name,
          command: item.script,
          passed: res.passed,
          durationMs: res.durationMs,
          output: res.output,
        });
        if (aborted) {
          buildSucceeded = false;
          break;
        }
        if (!res.passed && item.script === 'npm run build') {
          buildSucceeded = false;
          // Skip verify:* if build itself failed
          break;
        }
      }
    }

    if (!aborted && buildSucceeded) {
      results.push(await runUnlistedIntegrityCheck(repoRoot, originalBase));
    }

    return {
      allPassed: !aborted && results.every((r) => r.passed),
      results,
      ...(aborted ? { aborted: true } : {}),
      ...(transient ? { transient: true } : {}),
    };
  } finally {
    // Reclaim large dist/ output while keeping .astro/ warm across verification runs
    await fs.rm(path.join(repoRoot, 'dist'), { recursive: true, force: true }).catch(() => {});
  }
}

