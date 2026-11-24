import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  ChangeCardDto,
  ConflictResolutionRecordDto,
  GitFileChange,
} from '@halley/shared';
import { inferRouteFromFilePath } from './conflict-protocol.js';

const execFileAsync = promisify(execFile);

async function gitQuiet(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch {
    return '';
  }
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
  } catch {
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
  return `Page ${route}`;
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
      const afterJson = await fs.readFile(path.join(repoRoot, c.path), 'utf8').catch(() => '');
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
      route: route === 'All pages' || route === 'Site imagery' ? '/' : route,
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
