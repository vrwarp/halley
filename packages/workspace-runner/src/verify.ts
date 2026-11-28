import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
import { realClock, type Clock, type TimerHandle } from './clock.js';
import { pathExists, readdirEntriesOrEmpty, readFileOr, realpathOrNull, writeFileAtomic } from './fs-util.js';
import {
  errCode,
  ignore,
  ignoreCodes,
  ignoreExpected,
  isMissingPathError,
  logger,
  MISSING_PATH_CODES,
  orDefault,
} from './log.js';
import { computeDependencyHash, NodeModulesCacheManager } from './nm-cache.js';
import { execFileGroup, getProcessRunner, killProcessGroup as killGroup, withMaxOldSpace } from './proc.js';

// Every git/shell command goes through the injectable ProcessRunner (own process group each)
const execFileAsync = execFileGroup;

/** Process groups of every in-flight `runShell` child, so shutdown can kill orphan-prone builds. */
const activeShellChildren = new Set<ChildProcess>();

/** Signals every in-flight `runShell` process group (used by runner shutdown). */
export function killActiveShellGroups(signal: NodeJS.Signals = 'SIGTERM'): number {
  let n = 0;
  for (const child of activeShellChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      killGroup(child, signal);
      n++;
    }
  }
  return n;
}
const HAS_NICE_BIN = fsSync.existsSync('/usr/bin/nice') || fsSync.existsSync('/bin/nice');

/** Deadline for one-shot build-lock calls (acquire headers, promote, release). */
const BUILD_LOCK_CALL_TIMEOUT_MS = 5_000;
/** The acquire stream answers immediately (queue events follow in the body). */
const BUILD_LOCK_ACQUIRE_HEADERS_TIMEOUT_MS = 15_000;

function sleepOn(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => {
    clock.setTimeout(resolve, ms);
  });
}

/** Missing file → debug; anything else (parse/schema/permission errors) → warn. */
function ignoreUnlessMissing(err: unknown, reason: string, fields?: Record<string, unknown>): void {
  if (isMissingPathError(err)) ignoreExpected(err, reason, fields);
  else ignore(err, reason, fields);
}

/** Errors produced by aborting a run (AbortController / preemption / revocation). */
function isAbortLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || /preempted|aborted/i.test(err.message);
}

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
  // not a git checkout (plain directory verification): nothing to exclude from
  if (!(await pathExists(path.join(repoRoot, '.git'), 'verify: probe .git'))) return;
  try {
    await fs.mkdir(gitInfoDir, { recursive: true });
    let content = '';
    try {
      content = await fs.readFile(excludePath, 'utf8');
    } catch (err) {
      // file does not exist yet
      ignoreCodes(err, ['ENOENT'], 'verify: read .git/info/exclude');
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
      await writeFileAtomic(excludePath, `${content}${prefix}${toAdd.join('\n')}\n`);
    }
  } catch (err) {
    // non-fatal (e.g. git worktree with .git file)
    ignoreCodes(err, ['ENOTDIR', 'ENOENT'], 'verify: add build artifacts to .git/info/exclude', { repoRoot });
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
    // Two git processes in every case (was 3 clean / 5 dirty): `add -A` into a throw-away copy of
    // the index (excluding .github, like sanitizeProtectedPaths), then `write-tree`. A clean tree
    // yields exactly HEAD^{tree}, so keys before and after createCheckpoint still match.
    if (!(await pathExists(path.join(repoRoot, '.git'), 'verify: probe .git for tree key'))) {
      logger.debug('verify: not a git work tree; tree-key cache disabled', { repoRoot });
      return null;
    }
    const resolvedRoot = path.resolve(repoRoot);
    if (!artifactsExcludedRepos.has(resolvedRoot)) {
      await ensureBuildArtifactsExcluded(repoRoot);
      artifactsExcludedRepos.add(resolvedRoot);
    }

    const tmpIndex = path.join(os.tmpdir(), `halley-tree-idx-${crypto.randomUUID()}`);
    try {
      try {
        await fs.copyFile(path.join(repoRoot, '.git', 'index'), tmpIndex);
      } catch (err) {
        // No index yet (fresh repo) or a worktree `.git` file: git creates tmpIndex on add
        ignoreCodes(err, ['ENOENT', 'ENOTDIR'], 'verify: copy git index for tree key', { repoRoot });
      }
      const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
      await execFileAsync('git', ['add', '-A', '--', '.', ':(exclude).github'], {
        cwd: repoRoot,
        env,
        maxBuffer: 8 * 1024 * 1024,
        timeoutMs: 60_000,
      });
      const { stdout } = await execFileAsync('git', ['write-tree'], { cwd: repoRoot, env, timeoutMs: 60_000 });
      return stdout.trim() || null;
    } catch (err) {
      if (/not a git repository/i.test((err as { stderr?: string }).stderr ?? '')) {
        logger.debug('verify: not a git work tree; tree-key cache disabled', { repoRoot });
      } else {
        logger.warn('verify: computing the working tree key failed; tree-key cache disabled for this run', {
          repoRoot,
          err,
        });
      }
      return null;
    } finally {
      await fs.rm(tmpIndex, { force: true }).catch((e) => ignore(e, 'verify: remove temporary index'));
    }
  });
}

/** Repos whose `.git/info/exclude` already lists the build artifacts (checked once per process). */
const artifactsExcludedRepos = new Set<string>();

export interface RunShellOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  priority?: BuildPriority;
  /** Drives the timeout, kill escalation and `durationMs` (tests pass a ManualClock). */
  clock?: Clock;
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
  const clock = opts.clock ?? realClock;

  if (opts.signal?.aborted) {
    return {
      passed: false,
      durationMs: 0,
      output: '[Aborted before start]',
      aborted: true,
      transient: true,
    };
  }

  const start = clock.now();
  // Builds get their own heap cap (the runner's NODE_OPTIONS carries the runner's cap, which must
  // not leak into `astro build`). Other inherited NODE_OPTIONS flags are preserved.
  const buildHeapMb = Number(process.env.HALLEY_BUILD_MAX_OLD_SPACE_MB) || 1024;
  const nodeOptions = withMaxOldSpace(process.env.NODE_OPTIONS, buildHeapMb);

  const niceLevel = priority === 'speculative' ? '15' : '10';
  const spawnCmd = HAS_NICE_BIN ? 'nice' : 'bash';
  const spawnArgs = HAS_NICE_BIN ? ['-n', niceLevel, 'bash', '-lc', command] : ['-lc', command];

  return new Promise((resolve) => {
    const child = getProcessRunner().spawn(spawnCmd, spawnArgs, {
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
    activeShellChildren.add(child);

    const chunks: string[] = [];
    let totalBytes = 0;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let spawnErrored = false;
    let killEscalationTimer: TimerHandle | null = null;
    let forceResolveTimer: TimerHandle | null = null;

    const append = (buf: Buffer) => {
      if (totalBytes > 64_000) return;
      const str = buf.toString('utf8');
      totalBytes += str.length;
      chunks.push(str);
    };

    const killProcessGroup = (signal: NodeJS.Signals) => killGroup(child, signal);

    const terminateWithEscalation = () => {
      killProcessGroup('SIGTERM');
      if (!killEscalationTimer) {
        killEscalationTimer = clock.setTimeout(() => {
          killProcessGroup('SIGKILL');
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, 1_000);
        killEscalationTimer.unref?.();
      }
      if (!forceResolveTimer) {
        forceResolveTimer = clock.setTimeout(() => {
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
      activeShellChildren.delete(child);
      clock.clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      clock.clearTimeout(killEscalationTimer);
      clock.clearTimeout(forceResolveTimer);
      resolve({
        passed: passed && !timedOut && !aborted && !spawnErrored,
        durationMs: clock.now() - start,
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

    const timer = clock.setTimeout(() => {
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
  const entries = await readdirEntriesOrEmpty(dir, 'verify: list directory for checks');
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
      } catch (err) {
        // invalid json is reported by astro check (schema); only note it here
        ignoreExpected(err, 'verify: unreadable content JSON during asset check', { file: jf });
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
    } catch (err) {
      ignoreCodes(err, ['ENOENT'], 'verify: read source file for placeholder check', { file });
    }
  }

  const distFiles = await walkFiles(path.join(repoRoot, 'dist'), new Set(['.html']));
  for (const file of distFiles) {
    try {
      const text = await fs.readFile(file, 'utf8');
      if (text.includes(HALLEY_PLACEHOLDER_ATTR)) {
        issues.push(`${path.relative(repoRoot, file)}: built HTML still contains an unfinished Halley placeholder`);
      }
    } catch (err) {
      ignoreCodes(err, ['ENOENT'], 'verify: read built HTML for placeholder check', { file });
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
  const distExists = await pathExists(distDir, 'verify: probe dist/');

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
  } catch (err) {
    ignoreCodes(err, ['ENOENT'], 'verify: read sitemaps from dist', { distDir });
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
  } catch (err) {
    ignoreCodes(err, ['ENOENT'], 'verify: read dist/index.html for site chrome', { distDir });
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
      } catch (err) {
        if (errCode(err) !== 'ENOENT') ignore(err, 'verify: read built page', { file: c });
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
  /**
   * W7: the supervisor revoked this lease (max lease time exceeded or forced preemption). The build
   * must stop immediately; the queue admits the next build only after this lease is released or the
   * supervisor's kill fallback completes.
   */
  onLeaseRevoked?: () => void;
  /** Clock for retry backoffs (defaults to the repo's verification clock, see configureVerification). */
  clock?: Clock;
}

const ASTRO_CONFIG_NAMES = ['astro.config.mjs', 'astro.config.ts', 'astro.config.js', 'astro.config.mts', 'astro.config.cjs'];

/** sha256 over the dependency hash and the astro config of the checked-out sandbox tree. */
async function sandboxAstroCacheKey(sandboxRepoDir: string): Promise<string> {
  const h = crypto.createHash('sha256');
  h.update(`deps\0${(await computeDependencyHash(sandboxRepoDir)) ?? 'none'}`);
  for (const name of ASTRO_CONFIG_NAMES) {
    const content = await readFileOr(path.join(sandboxRepoDir, name), null, 'verify: read astro config for cache key');
    if (content !== null) h.update(`\0${name}\0${content}`);
  }
  return h.digest('hex').slice(0, 32);
}

/** Exported for tests. */
export async function syncVerifySandboxToTree(
  sourceRepoRoot: string,
  treeSha: string,
  verifySandboxRoot: string,
): Promise<string> {
  const sandboxRepoDir = path.join(verifySandboxRoot, 'workspace');
  const sandboxStateDir = path.join(verifySandboxRoot, 'state');
  await fs.mkdir(sandboxRepoDir, { recursive: true });
  await fs.mkdir(sandboxStateDir, { recursive: true });

  const hasGit = await pathExists(path.join(sandboxRepoDir, '.git'), 'verify: probe sandbox .git');
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
  await writeFileAtomic(path.join(infoDir, 'alternates'), `${alternates.join('\n')}\n`);

  await execFileAsync('git', ['-c', 'safe.directory=*', 'read-tree', '--reset', '-u', treeSha], {
    cwd: sandboxRepoDir,
    maxBuffer: 16 * 1024 * 1024,
  });
  await execFileAsync(
    'git',
    ['-c', 'safe.directory=*', 'clean', '-fd', '-e', 'node_modules', '-e', '.astro'],
    { cwd: sandboxRepoDir, maxBuffer: 16 * 1024 * 1024 },
  );

  // The sandbox is shared by every session in the container. Its warm `.astro/` cache (content
  // layer store, generated types) is only valid for the dependency set + astro config that built
  // it: keyed by both and wiped when the key changes (another session, a dependency/config edit).
  const cacheKey = await sandboxAstroCacheKey(sandboxRepoDir);
  const keyFile = path.join(sandboxStateDir, 'astro-cache-key');
  const previousKey = await readFileOr(keyFile, null, 'verify: read sandbox .astro cache key');
  if (previousKey?.trim() !== cacheKey) {
    await fs.rm(path.join(sandboxRepoDir, '.astro'), { recursive: true, force: true });
    await writeFileAtomic(keyFile, `${cacheKey}\n`);
  }

  // node_modules ALWAYS points at the CURRENT session's dependency tree (never a previous
  // session's link left in the shared sandbox).
  const sourceNmReal = await realpathOrNull(
    path.join(sourceRepoRoot, 'node_modules'),
    'verify: resolve session node_modules',
  );
  const sandboxNmPath = path.join(sandboxRepoDir, 'node_modules');
  const sandboxNmIsLink = await fs.lstat(sandboxNmPath).then(
    (st) => st.isSymbolicLink(),
    (err) => {
      if (!isMissingPathError(err)) ignore(err, 'verify: lstat sandbox node_modules');
      return false;
    },
  );
  if (sourceNmReal) {
    // missing or dangling sandbox link: replaced below
    const currentSandboxNm = await realpathOrNull(sandboxNmPath, 'verify: resolve sandbox node_modules');
    if (currentSandboxNm !== sourceNmReal || !sandboxNmIsLink) {
      await fs
        .rm(sandboxNmPath, { recursive: true, force: true })
        .catch((e) => ignore(e, 'verify: remove stale sandbox node_modules link'));
      await fs.symlink(sourceNmReal, sandboxNmPath, 'dir');
    }
  } else {
    // this session has no tree of its own: a link into another session's tree must not be reused
    if (sandboxNmIsLink) {
      await fs.rm(sandboxNmPath, { force: true }).catch((e) => ignore(e, 'verify: remove foreign sandbox node_modules link'));
    }
    if (
      (await pathExists(path.join(sandboxRepoDir, 'package-lock.json'), 'verify: probe sandbox lockfile')) ||
      (await pathExists(path.join(sandboxRepoDir, 'pnpm-lock.yaml'), 'verify: probe sandbox lockfile'))
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
  }

  return sandboxRepoDir;
}

export async function promoteSupervisorBuildLock(
  supervisorUrl: string,
  hostSecret: string | undefined,
  leaseId: string,
  clock: Clock = realClock,
): Promise<boolean> {
  const base = supervisorUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (hostSecret) headers['Authorization'] = `Bearer ${hostSecret}`;
  try {
    const res = await fetch(`${base}/internal/build-lock/promote`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ leaseId }),
      signal: clock.timeoutSignal(BUILD_LOCK_CALL_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn('verify: build lock promotion refused by supervisor', { leaseId, status: res.status });
      return false;
    }
    // an unreadable answer is treated as "not promoted": the caller restarts the run in foreground
    const data = (await orDefault(res.json(), {}, 'verify: parse build lock promotion response', {
      fields: { leaseId },
    })) as { promoted?: boolean };
    return Boolean(data.promoted);
  } catch (err) {
    // supervisor unreachable: same safe answer (caller aborts the speculative run and starts fresh)
    ignore(err, 'verify: promote build lock lease', { leaseId });
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

  // The response headers must arrive within BUILD_LOCK_ACQUIRE_HEADERS_TIMEOUT_MS (on the injected clock); the
  // NDJSON body then stays open while queued / holding the lease, bounded by the caller's signal and
  // the supervisor's own queue timeout + lease ceiling.
  const clock = opts?.clock ?? realClock;
  const acquireAc = new AbortController();
  const onCallerAbort = () => acquireAc.abort(opts?.signal?.reason);
  if (opts?.signal?.aborted) onCallerAbort();
  else opts?.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const headerTimer = clock.setTimeout(() => {
    acquireAc.abort(new DOMException('Build lock acquire: no response from supervisor', 'TimeoutError'));
  }, BUILD_LOCK_ACQUIRE_HEADERS_TIMEOUT_MS);
  headerTimer.unref?.();
  let res: Response;
  try {
    res = await fetch(`${supervisorUrl}/internal/build-lock/acquire`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sessionId: opts?.sessionId || 'unknown', priority }),
      signal: acquireAc.signal,
    });
  } catch (err) {
    opts?.signal?.removeEventListener('abort', onCallerAbort);
    throw err;
  } finally {
    clock.clearTimeout(headerTimer);
  }

  if (!res.ok || !res.body) {
    const text = await orDefault(res.text(), res.statusText, 'build lock: read acquire error body');
    throw new Error(`Failed to acquire build lock (${res.status}): ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let leaseId = '';
  let preempted = false;

  let revoked = false;
  const parseLine = (line: string): 'acquired' | 'preempted' | 'revoked' | 'other' => {
    const evt = JSON.parse(line) as {
      event: 'queued' | 'acquired' | 'preempted' | 'revoked' | 'heartbeat' | 'timeout' | 'error';
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
    if (evt.event === 'revoked') {
      if (!revoked) {
        revoked = true;
        logger.warn('build lock revoked by supervisor; aborting build', { leaseId, reason: evt.message });
        opts?.onLeaseRevoked?.();
      }
      return 'revoked';
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
    } catch (err) {
      ignoreExpected(err, 'build lock: cancel stream reader');
    }
    try {
      reader.releaseLock();
    } catch (err) {
      ignoreExpected(err, 'build lock: release stream reader');
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

  // Keep reading the open NDJSON stream for every lease so preemption (speculative) and revocation
  // (any priority, W7) events abort the running build immediately.
  {
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
                  const kind = parseLine(line);
                  if (kind === 'preempted' || kind === 'revoked') return;
                } catch (e) {
                  ignore(e, 'build lock: malformed stream line');
                }
              }
              nl = buffer.indexOf('\n');
            }
          }
          if (done) break;
        }
      } catch (err) {
        // stream aborted on release/promote: expected
        ignoreExpected(err, 'build lock: stream watcher ended');
      }
    })();
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
          signal: clock.timeoutSignal(BUILD_LOCK_CALL_TIMEOUT_MS),
        });
        if (relRes.ok) break;
        logger.warn('build lock: release refused', { leaseId, status: relRes.status, attempt });
      } catch (err) {
        // the supervisor also reclaims the lease when this stream closes / the lease times out
        ignore(err, 'build lock: release lease', { leaseId, attempt });
      }
      if (attempt === 0) await sleepOn(clock, 150);
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
  /** Drives every timer of this repo's verification runs (shell timeouts, kill escalation, backoff). */
  clock: Clock;
}

const MAX_CACHE_ENTRIES = 8;
const repoStates = new Map<string, RepoVerifyState>();

function getRepoState(repoRoot: string): RepoVerifyState {
  const key = path.resolve(repoRoot);
  let state = repoStates.get(key);
  if (!state) {
    state = { cache: new Map(), inFlight: null, clock: realClock };
    repoStates.set(key, state);
  }
  return state;
}

/**
 * Injects the clock used by verification runs for `repoRoot` (createRunner passes its clock; tests
 * pass a ManualClock). Returns a function restoring the previous clock.
 */
export function configureVerification(repoRoot: string, deps: { clock?: Clock }): () => void {
  const state = getRepoState(repoRoot);
  const prev = state.clock;
  state.clock = deps.clock ?? realClock;
  return () => {
    state.clock = prev;
  };
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
  } catch (err) {
    // Speculative work is optional: preemption / invalidation aborts are routine (debug); anything
    // else (supervisor down, git failure) is logged and the foreground verify will retry for real
    if (isAbortLikeError(err)) ignoreExpected(err, 'verify: speculative run aborted', { repoRoot });
    else ignore(err, 'verify: speculative run failed', { repoRoot });
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
              state.clock,
            );
            if (!promoted) {
              // Lease was already preempted by another session: abort the speculative run and start fresh
              existing.abortController.abort();
              await existing.promise.catch((e) => ignoreExpected(e, 'verify: aborted speculative run'));
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
        await existing.promise.catch((e) => ignoreExpected(e, 'verify: aborted stale speculative run'));
        continue;
      }

      // Existing run is foreground for a different tree
      if (priority === 'speculative') {
        return { allPassed: false, results: [], aborted: true };
      }
      // the other run's outcome belongs to its caller; we only wait for it to finish
      await existing.promise.catch((e) => ignoreExpected(e, 'verify: waited on foreground run for another tree'));
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
            clock: lockOpts?.clock ?? state.clock,
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
                  state.clock,
                );
              }
            },
            onPreempted: () => {
              if (runEntry.priority === 'speculative') {
                ac.abort();
                lockOpts?.onPreempted?.();
              }
            },
            // Revocation applies to foreground leases too: stop the build (runShell kills its group)
            onLeaseRevoked: () => {
              ac.abort();
              lockOpts?.onLeaseRevoked?.();
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
                logger.warn('verify: sandbox sync failed; verifying in the session workspace', {
                  repoRoot,
                  treeSha,
                  err,
                });
                targetRepoDir = repoRoot;
              }
            }
            return runAllVerificationChecksUnlocked(targetRepoDir, {
              clock: state.clock,
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
  opts?: { signal?: AbortSignal; getPriority?: () => BuildPriority; clock?: Clock },
): Promise<InternalVerifyRunResult> {
  const results: VerificationCheckResult[] = [];
  const originalBase = await detectAstroBase(repoRoot);
  await ensureBuildArtifactsExcluded(repoRoot);

  let halleyConfig: HalleyRepoConfig | undefined;
  try {
    const raw = await fs.readFile(path.join(repoRoot, '.halley.json'), 'utf8');
    halleyConfig = HalleyRepoConfigSchema.parse(JSON.parse(raw));
  } catch (err) {
    // no .halley.json is the default setup; an invalid one silently falling back to the default
    // checks would hide the repo's own checks, so that is a warning
    ignoreUnlessMissing(err, 'verify: unreadable .halley.json; using default checks', { repoRoot });
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
          clock: opts?.clock,
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
      } catch (err) {
        ignoreUnlessMissing(err, 'verify: unreadable package.json; no npm checks', { repoRoot });
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
          clock: opts?.clock,
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
    await fs
      .rm(path.join(repoRoot, 'dist'), { recursive: true, force: true })
      .catch((e) => ignore(e, 'verify: remove dist/ after verification'));
  }
}

