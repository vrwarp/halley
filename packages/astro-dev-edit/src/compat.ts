/**
 * Version compatibility between the site's Astro (whose bundled @astrojs/compiler emits the
 * `data-astro-source-loc` attributes) and the @astrojs/compiler this package parses with.
 *
 * The classifier relies on the Astro 5 / compiler 2.x loc convention (see findElementAtLoc). If
 * the site runs another Astro major, or its compiler major differs from ours, locs and offsets
 * may not line up — so inline editing is disabled (everything is classified as agent-editable)
 * instead of risking a write to the wrong span.
 */
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMissingPathError, warnUnexpected } from './diagnostics.js';

export const SUPPORTED_ASTRO_MAJORS: readonly number[] = [5];

export interface AstroVersionInfo {
  /** Astro version installed in the site (null when it cannot be resolved). */
  siteAstro: string | null;
  /** @astrojs/compiler used by the site's Astro. */
  siteCompiler: string | null;
  /** @astrojs/compiler bundled with this package (used for classification). */
  bundledCompiler: string | null;
  /** Set when inline editing must be disabled. */
  disabledReason?: string;
}

const major = (v: string | null) => (v ? Number.parseInt(v.split('.')[0] ?? '', 10) : Number.NaN);

/** Resolves `pkg` from `fromDir` and walks up from its entry to its package.json. */
async function resolvePackage(pkg: string, fromDir: string): Promise<{ version: string; dir: string } | null> {
  let entry: string;
  try {
    entry = createRequire(path.join(fromDir, 'noop.js')).resolve(pkg);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return null;
    warnUnexpected(`resolving ${pkg} from ${fromDir}`, err);
    return null;
  }
  let dir = path.dirname(entry);
  for (let i = 0; i < 8; i++) {
    try {
      const json = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (json.name === pkg && json.version) return { version: json.version, dir };
    } catch (err) {
      if (!isMissingPathError(err)) warnUnexpected(`reading ${dir}/package.json`, err);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function detectAstroVersions(repoRoot: string): Promise<AstroVersionInfo> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const [astro, bundled] = await Promise.all([
    resolvePackage('astro', repoRoot),
    resolvePackage('@astrojs/compiler', here),
  ]);
  const siteCompiler = astro ? await resolvePackage('@astrojs/compiler', astro.dir) : null;
  const info: AstroVersionInfo = {
    siteAstro: astro?.version ?? null,
    siteCompiler: siteCompiler?.version ?? null,
    bundledCompiler: bundled?.version ?? null,
  };
  if (info.siteAstro && !SUPPORTED_ASTRO_MAJORS.includes(major(info.siteAstro))) {
    info.disabledReason =
      `Inline editing is disabled: this site uses Astro ${info.siteAstro}, but the editor supports Astro ` +
      `${SUPPORTED_ASTRO_MAJORS.join('/')}.x. Ask Halley to make the change instead.`;
  } else if (info.siteCompiler && info.bundledCompiler && major(info.siteCompiler) !== major(info.bundledCompiler)) {
    info.disabledReason =
      `Inline editing is disabled: the site's @astrojs/compiler ${info.siteCompiler} differs from the ` +
      `editor's ${info.bundledCompiler}. Ask Halley to make the change instead.`;
  }
  return info;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; info: Promise<AstroVersionInfo> }>();

/** Cached (per repo root, 60s) compatibility check; logs versions when first computed. */
export function getAstroCompat(repoRoot: string): Promise<AstroVersionInfo> {
  const key = path.resolve(repoRoot);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.info;
  const info = detectAstroVersions(key);
  cache.set(key, { at: Date.now(), info });
  return info;
}

export async function inlineEditingDisabledReason(repoRoot: string): Promise<string | undefined> {
  return (await getAstroCompat(repoRoot)).disabledReason;
}

export function formatAstroVersions(info: AstroVersionInfo): string {
  return (
    `site astro ${info.siteAstro ?? 'unresolved'} (compiler ${info.siteCompiler ?? 'unresolved'}), ` +
    `editor @astrojs/compiler ${info.bundledCompiler ?? 'unresolved'}`
  );
}
