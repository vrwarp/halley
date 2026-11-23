import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  HalleyRepoConfigSchema,
  type HalleyRepoConfig,
  type VerificationCheckResult,
} from '@halley/shared';
import { detectAstroBase } from './astro-manager.js';

async function runShell(
  cwd: string,
  command: string,
  timeoutMs = 180_000,
): Promise<{ passed: boolean; durationMs: number; output: string }> {
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      cwd,
      env: {
        ...process.env,
        WORKSPACE_TOKEN: '',
        FORCE_COLOR: '0',
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
        output: chunks.join('').trim(),
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

    // Check url('/images/...') references in src/
    const srcFiles = await walkFiles(path.join(repoRoot, 'src'), new Set(['.astro', '.ts', '.tsx']));
    for (const sf of srcFiles) {
      const text = await fs.readFile(sf, 'utf8');
      const refs = [...text.matchAll(/url\(\s*['"](\/images\/[^'"]+)['"]\s*\)/g)];
      for (const m of refs) {
        const imgRel = m[1]!;
        const abs = path.join(repoRoot, 'public', imgRel.replace(/^\/+/, ''));
        try {
          await fs.access(abs);
        } catch {
          issues.push(`${path.relative(repoRoot, sf)}: missing public asset ${imgRel}`);
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

export async function runAllVerificationChecks(
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

  if (halleyConfig?.checks && halleyConfig.checks.length > 0) {
    for (const c of halleyConfig.checks) {
      const res = await runShell(repoRoot, c.command);
      results.push({ name: c.name, command: c.command, ...res });
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
        // Skip verify:* if build itself failed
        break;
      }
    }
  }

  return {
    allPassed: results.every((r) => r.passed),
    results,
  };
}
