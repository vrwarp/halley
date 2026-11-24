import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { discoverSiteRoutes } from '@halley/astro-dev-edit';
import {
  HALLEY_PLACEHOLDER_ATTR,
  HalleyRepoConfigSchema,
  type HalleyRepoConfig,
  type VerificationCheckResult,
} from '@halley/shared';
import { detectAstroBase } from './astro-manager.js';

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

async function runShell(
  cwd: string,
  command: string,
  timeoutMs = 180_000,
): Promise<{ passed: boolean; durationMs: number; output: string }> {
  const start = Date.now();
  const existingNodeOpts = process.env.NODE_OPTIONS || '';
  const nodeOptions = existingNodeOpts.includes('--max-old-space-size')
    ? existingNodeOpts
    : `${existingNodeOpts} --max-old-space-size=1024`.trim();
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      cwd,
      env: {
        ...process.env,
        WORKSPACE_TOKEN: '',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        CI: '1',
        NODE_OPTIONS: nodeOptions,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const chunks: string[] = [];
    let totalBytes = 0;
    const append = (buf: Buffer) => {
      if (totalBytes > 64_000) return;
      const str = buf.toString('utf8');
      totalBytes += str.length;
      chunks.push(str);
    };

    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      chunks.push('\n[Timed out]');
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        passed: code === 0,
        durationMs: Date.now() - start,
        output: stripAnsi(chunks.join('')).trim(),
      });
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

let verifyQueue: Promise<unknown> = Promise.resolve();

export function runAllVerificationChecks(
  repoRoot: string,
): Promise<{ allPassed: boolean; results: VerificationCheckResult[] }> {
  const run = () => runAllVerificationChecksUnlocked(repoRoot);
  const result = verifyQueue.then(run, run);
  verifyQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function runAllVerificationChecksUnlocked(
  repoRoot: string,
): Promise<{ allPassed: boolean; results: VerificationCheckResult[] }> {
  const results: VerificationCheckResult[] = [];
  const originalBase = await detectAstroBase(repoRoot);

  let halleyConfig: HalleyRepoConfig | undefined;
  try {
    const raw = await fs.readFile(path.join(repoRoot, '.halley.json'), 'utf8');
    halleyConfig = HalleyRepoConfigSchema.parse(JSON.parse(raw));
  } catch {
    halleyConfig = undefined;
  }

  results.push(await runAstroHygieneGuard(repoRoot, originalBase, halleyConfig));
  results.push(await runUnfinishedPagesCheck(repoRoot));

  let buildSucceeded = true;

  if (halleyConfig?.checks && halleyConfig.checks.length > 0) {
    for (const c of halleyConfig.checks) {
      const res = await runShell(repoRoot, c.command);
      results.push({ name: c.name, command: c.command, ...res });
      if (!res.passed) buildSucceeded = false;
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
      const res = await runShell(repoRoot, item.script);
      results.push({ name: item.name, command: item.script, ...res });
      if (!res.passed && item.script === 'npm run build') {
        buildSucceeded = false;
        // Skip verify:* if build itself failed
        break;
      }
    }
  }

  if (buildSucceeded) {
    results.push(await runUnlistedIntegrityCheck(repoRoot, originalBase));
  }

  return {
    allPassed: results.every((r) => r.passed),
    results,
  };
}

