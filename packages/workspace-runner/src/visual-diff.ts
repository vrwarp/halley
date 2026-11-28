import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ChangeCardDto,
  ConflictResolutionRecordDto,
  GitFileChange,
} from '@halley/shared';
import { inferRouteFromFilePath } from './conflict-protocol.js';
import { readFileOr } from './fs-util.js';
import { logger } from './log.js';
import { getProcessRunner } from './proc.js';

/** `git show <ref>:<path>` / `git log` on a path or range the base does not have: an expected miss. */
const GIT_MISSING_OBJECT_RE = /does not exist in|exists on disk, but not in|bad revision|unknown revision|invalid object name|path '.*' does not exist/i;

/**
 * stdout of a read-only git command, or '' on failure. Change cards are best-effort, so a failure
 * never fails the request, but only "object/path not in that revision" is expected (debug); any
 * other failure (timeout, corrupt repo, missing git) is logged at warn.
 */
async function gitQuiet(cwd: string, args: string[]): Promise<string> {
  const r = await getProcessRunner().exec('git', args, { cwd, maxBuffer: 8 * 1024 * 1024, timeoutMs: 60_000 });
  if (r.code === 0) return r.stdout;
  const fields = { cwd, args: args.slice(0, 3), code: r.code, stderr: r.stderr.slice(0, 500) };
  if (!r.timedOut && !r.spawnError && GIT_MISSING_OBJECT_RE.test(r.stderr)) {
    logger.debug('visual-diff: git object not in revision', fields);
  } else {
    logger.warn('visual-diff: git command failed; change card degraded', { ...fields, timedOut: r.timedOut });
  }
  return '';
}

const IMAGE_EXT_RE = /\.(?:webp|png|jpe?g|gif|svg|avif)$/i;

/**
 * Simple word-level diff between two short text snippets for plain-language change cards.
 */
export function computeWordDiff(
  before: string,
  after: string,
): Array<{ type: 'equal' | 'add' | 'del'; value: string }> {
  const a = before.trim().split(/\s+/).filter(Boolean);
  const b = after.trim().split(/\s+/).filter(Boolean);
  if (a.length === 0 && b.length === 0) return [];
  if (a.length > 120 || b.length > 120) {
    return [
      ...(before.trim() ? [{ type: 'del' as const, value: before.trim().slice(0, 180) }] : []),
      ...(after.trim() ? [{ type: 'add' as const, value: after.trim().slice(0, 180) }] : []),
    ];
  }

  // LCS matrix for word-level diff
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? 1 + dp[i + 1]![j + 1]! : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const raw: Array<{ type: 'equal' | 'add' | 'del'; value: string }> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      raw.push({ type: 'equal', value: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      raw.push({ type: 'del', value: a[i]! });
      i++;
    } else {
      raw.push({ type: 'add', value: b[j]! });
      j++;
    }
  }
  while (i < m) raw.push({ type: 'del', value: a[i++]! });
  while (j < n) raw.push({ type: 'add', value: b[j++]! });

  // Coalesce consecutive tokens of the same type
  const merged: Array<{ type: 'equal' | 'add' | 'del'; value: string }> = [];
  for (const tok of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.type === tok.type) {
      prev.value += ` ${tok.value}`;
    } else {
      merged.push({ ...tok });
    }
  }
  return merged;
}

/**
 * Extracts readable changed fields from two JSON strings (e.g. sermon series JSON).
 */
export function computeJsonFieldDiff(
  beforeStr: string,
  afterStr: string,
): Array<{ field: string; before: string; after: string }> {
  try {
    const bObj = beforeStr ? (JSON.parse(beforeStr) as Record<string, unknown>) : {};
    const aObj = afterStr ? (JSON.parse(afterStr) as Record<string, unknown>) : {};
    const keys = new Set([...Object.keys(bObj), ...Object.keys(aObj)]);
    const rows: Array<{ field: string; before: string; after: string }> = [];
    for (const k of keys) {
      const bv = JSON.stringify(bObj[k] ?? '');
      const av = JSON.stringify(aObj[k] ?? '');
      if (bv !== av) {
        rows.push({
          field: k,
          before: typeof bObj[k] === 'string' ? bObj[k] : bv.slice(0, 120),
          after: typeof aObj[k] === 'string' ? aObj[k] : av.slice(0, 120),
        });
      }
    }
    return rows.slice(0, 15);
  } catch (err) {
    // Not JSON (or not an object) on one side: no field-level rows; the card still shows the file
    logger.debug('visual-diff: JSON field diff unavailable', { err: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

function extractDiffTextSnippets(diff: string): { before: string; after: string } {
  const removed: string[] = [];
  const added: string[] = [];
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) continue;
    if (line.startsWith('-')) removed.push(line.slice(1).replace(/<[^>]+>/g, ' ').trim());
    else if (line.startsWith('+')) added.push(line.slice(1).replace(/<[^>]+>/g, ' ').trim());
  }
  return {
    before: removed.filter(Boolean).join(' ').slice(0, 240),
    after: added.filter(Boolean).join(' ').slice(0, 240),
  };
}

function humanTitleForFile(relPath: string): string {
  const route = inferRouteFromFilePath(relPath);
  if (relPath.startsWith('src/content/sermons/')) {
    const slug = path.basename(relPath, '.json').replace(/-/g, ' ');
    return `Sermon series: ${slug}`;
  }
  if (relPath.startsWith('public/images/')) {
    return `Photo: ${path.basename(relPath)}`;
  }
  if (relPath === 'src/data/site.ts') return 'Site-wide settings & navigation';
  if (route === '/') return 'Homepage';
  if (route === 'All pages') return `Shared layout (${path.basename(relPath)})`;
  if (route === 'Shared component') return `Shared component (${path.basename(relPath)})`;
  return `Page ${route}`;
}

const SERMON_INDEX_FIELDS = new Set([
  'title',
  'book',
  'dateRange',
  'description',
  'coverImage',
  'featured',
  'order',
]);

function normalizeRoutePath(route?: string | null): string | null {
  if (!route) return null;
  const trimmed = route.trim();
  if (!trimmed || !trimmed.startsWith('/')) return null;
  const noQuery = trimmed.split(/[?#]/)[0] || '/';
  if (noQuery.includes('..') || noQuery.includes('[')) return null;
  return noQuery.length > 1 ? noQuery.replace(/\/+$/, '') : '/';
}

/**
 * Resolves up to 4 target routes to screenshot in Publish -> Visual Review:
 * - Explicit static `src/pages/*` routes
 * - `src/content/sermons/<slug>.json` -> `/sermons/<slug>` (+ `/sermons` if index-card fields changed)
 * - Shared files (`src/components/*`, `src/layouts/*`, `src/styles/*`, `src/data/site.ts`, `public/images/*`)
 *   prioritize the editor's active `activeRoute` first, plus `/` if different.
 */
export function resolveVisualReviewRoutes(
  cards: ChangeCardDto[],
  activeRoute?: string | null,
  maxRoutes = 4,
): string[] {
  const normActive = normalizeRoutePath(activeRoute);
  const routes: string[] = [];
  const pushUnique = (r: string | null) => {
    if (!r || routes.includes(r)) return;
    routes.push(r);
  };

  let hasSharedChange = false;

  for (const card of cards) {
    const normPath = card.path.replace(/\\/g, '/');
    if (normPath.startsWith('src/content/sermons/') && normPath.endsWith('.json')) {
      const slug = path.basename(normPath, '.json');
      if (slug && card.status !== 'deleted') {
        pushUnique(`/sermons/${slug}`);
      }
      const touchesIndex =
        card.status === 'added' ||
        card.status === 'untracked' ||
        card.status === 'deleted' ||
        (card.jsonFields ?? []).some((f) => SERMON_INDEX_FIELDS.has(f.field));
      if (touchesIndex) {
        pushUnique('/sermons');
      }
      continue;
    }

    const inferred = inferRouteFromFilePath(normPath);
    if (inferred === 'All pages' || inferred === 'Site imagery' || inferred === 'Shared component') {
      hasSharedChange = true;
      continue;
    }

    const explicit = normalizeRoutePath(inferred);
    if (explicit) {
      pushUnique(explicit);
    } else {
      hasSharedChange = true;
    }
  }

  if (hasSharedChange) {
    const prioritized: string[] = [];
    if (normActive) prioritized.push(normActive);
    if (!prioritized.includes('/')) prioritized.push('/');
    for (const r of routes) {
      if (!prioritized.includes(r)) prioritized.push(r);
    }
    return prioritized.slice(0, maxRoutes);
  }

  if (routes.length === 0) {
    return [normActive || '/'];
  }

  return routes.slice(0, maxRoutes);
}

export async function buildChangeCards(
  repoRoot: string,
  changes: GitFileChange[],
  opts: {
    baseRef: string;
    prevBaseSha?: string | null;
    editorName: string;
    conflictRecords?: ConflictResolutionRecordDto[];
  },
): Promise<ChangeCardDto[]> {
  const conflictMap = new Map((opts.conflictRecords ?? []).map((r) => [r.path, r]));

  // Find files touched upstream since prevBaseSha for overwrite safety-net warnings
  const upstreamTouched = new Map<string, string>();
  if (opts.prevBaseSha) {
    const logOut = await gitQuiet(repoRoot, [
      'log',
      '--no-merges',
      '--name-only',
      '--format=COMMIT|%an|%aI|%s',
      `${opts.prevBaseSha}..${opts.baseRef}`,
    ]);
    let curMeta = '';
    for (const line of logOut.split(/\r?\n/)) {
      if (line.startsWith('COMMIT|')) {
        const [, author = 'a teammate', date = ''] = line.split('|');
        const dateStr = date ? new Date(date).toLocaleDateString() : 'recently';
        curMeta = `${author} (${dateStr})`;
      } else if (line.trim() && curMeta) {
        if (!upstreamTouched.has(line.trim())) {
          upstreamTouched.set(line.trim(), curMeta);
        }
      }
    }
  }

  const cards: ChangeCardDto[] = [];
  for (const c of changes) {
    const isImage = IMAGE_EXT_RE.test(c.path);
    const route = inferRouteFromFilePath(c.path);
    const conflict = conflictMap.get(c.path);
    const upstreamInfo = upstreamTouched.get(c.path);
    const overwriteWarning =
      upstreamInfo && !conflict
        ? `This file was also updated on the live site by ${upstreamInfo} — double-check you didn't overwrite their change.`
        : undefined;

    let jsonFields: ChangeCardDto['jsonFields'];
    let wordDiff: ChangeCardDto['wordDiff'];
    let beforePreview: string | undefined;
    let afterPreview: string | undefined;

    if (c.path.endsWith('.json') && !isImage) {
      const beforeJson = await gitQuiet(repoRoot, ['show', `${opts.baseRef}:${c.path}`]);
      // deleted files have no working-tree side
      const afterJson = await readFileOr(path.join(repoRoot, c.path), '', 'visual-diff: read changed JSON file');
      jsonFields = computeJsonFieldDiff(beforeJson, afterJson);
    } else if (!isImage) {
      const snippets = extractDiffTextSnippets(c.diff);
      beforePreview = snippets.before || undefined;
      afterPreview = snippets.after || undefined;
      if (snippets.before || snippets.after) {
        wordDiff = computeWordDiff(snippets.before, snippets.after);
      }
    }

    const summary =
      c.status === 'added' || c.status === 'untracked'
        ? `Added ${path.basename(c.path)}`
        : c.status === 'deleted'
          ? `Removed ${path.basename(c.path)}`
          : jsonFields && jsonFields.length > 0
            ? `Updated ${jsonFields.map((f) => f.field).slice(0, 3).join(', ')}`
            : `Updated ${c.additions} line${c.additions === 1 ? '' : 's'}, removed ${c.deletions}`;

    cards.push({
      id: `card-${c.path}`,
      path: c.path,
      status: c.status,
      title: humanTitleForFile(c.path),
      route:
        route === 'All pages' || route === 'Site imagery' || route === 'Shared component'
          ? '/'
          : route,
      summary,
      attribution: opts.editorName,
      conflictBadge:
        conflict?.status === 'auto_resolved'
          ? 'auto_resolved'
          : conflict?.status === 'needs_review'
            ? 'needs_review'
            : conflict?.status === 'chosen'
              ? 'chosen'
              : undefined,
      overwriteWarning,
      isImage,
      beforePreview,
      afterPreview,
      wordDiff,
      jsonFields,
      diff: c.diff,
      included: true,
    });
  }
  return cards;
}
