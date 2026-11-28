import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ConflictCategory,
  ConflictConfidence,
  ConflictOptionDto,
  ConflictResolutionRecordDto,
  EscalationEstimateDto,
  UpstreamCommitInfoDto,
} from '@halley/shared';
import { findFilesWithConflictMarkers } from './checkpoints-and-git.js';
import { realClock, type Clock } from './clock.js';
import { writeFileAtomic } from './fs-util.js';
import { ignore, ignoreExpected, isMissingPathError, orDefault } from './log.js';
import { getProcessRunner, processResultError } from './proc.js';

async function gitRaw(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const r = await getProcessRunner().exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  if (r.code === 0 || r.stderr) return r;
  return { ...r, stderr: processResultError('git', args, r).message };
}

export interface ConflictEvidencePack {
  path: string;
  affectedRoute: string;
  fileType: 'astro' | 'json' | 'ts' | 'md' | 'binary' | 'text';
  baseContent: string | null;
  oursContent: string | null;
  theirsContent: string | null;
  /** Optional 3-way merged file containing `<<<<<<<` / `=======` / `>>>>>>>` hunks from `git merge-tree`. */
  mergedMarkedContent?: string | null;
  isBinary: boolean;
  upstreamCommits: UpstreamCommitInfoDto[];
  localCheckpoints: string[];
  kind?: 'sync' | 'publish' | 'revert';
}

export function inferRouteFromFilePath(relPath: string): string {
  const norm = relPath.replace(/\\/g, '/');
  if (norm.startsWith('src/pages/')) {
    const sub = norm
      .slice('src/pages/'.length)
      .replace(/\.(astro|md|mdx|tsx|ts|html)$/, '')
      .replace(/\/index$/, '')
      .replace(/^index$/, '');
    return sub ? `/${sub}` : '/';
  }
  if (norm.startsWith('src/content/sermons/') && norm.endsWith('.json')) {
    const slug = path.basename(norm, '.json');
    return slug ? `/sermons/${slug}` : '/sermons';
  }
  if (norm.startsWith('src/content/sermons/')) return '/sermons';
  if (norm.startsWith('src/components/')) return 'Shared component';
  if (norm.startsWith('src/layouts/') || norm === 'src/data/site.ts' || norm.startsWith('src/styles/')) {
    return 'All pages';
  }
  if (norm.startsWith('public/images/')) return 'Site imagery';
  return '/';
}

const BINARY_EXT_RE = /\.(?:webp|png|jpe?g|gif|ico|pdf|mp3|mp4|webm|woff2?|ttf|otf|zip)$/i;
const DERIVED_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

export function detectFileType(relPath: string, sample?: Buffer): ConflictEvidencePack['fileType'] {
  if (BINARY_EXT_RE.test(relPath)) return 'binary';
  if (sample && sample.subarray(0, 8192).includes(0)) return 'binary';
  const ext = path.extname(relPath).toLowerCase();
  if (ext === '.astro') return 'astro';
  if (ext === '.json') return 'json';
  if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.mjs') return 'ts';
  if (ext === '.md' || ext === '.mdx') return 'md';
  return 'text';
}

async function readGitStage(repoRoot: string, stage: 1 | 2 | 3, relPath: string): Promise<string | null> {
  const res = await gitRaw(repoRoot, ['show', `:${stage}:${relPath}`]);
  return res.code === 0 ? res.stdout : null;
}

async function readGitRefFile(repoRoot: string, ref: string | undefined, relPath: string): Promise<string | null> {
  if (!ref) return null;
  const res = await gitRaw(repoRoot, ['show', `${ref}:${relPath}`]);
  return res.code === 0 ? res.stdout : null;
}

export async function getUpstreamCommits(
  repoRoot: string,
  fromRef: string,
  toRef: string,
  filePath?: string,
): Promise<UpstreamCommitInfoDto[]> {
  const args = [
    'log',
    '--no-merges',
    '-n',
    '30',
    '--format=%H|%h|%an|%aI|%s',
    `${fromRef}..${toRef}`,
  ];
  if (filePath) args.push('--', filePath);
  const res = await gitRaw(repoRoot, args);
  if (res.code !== 0 || !res.stdout.trim()) return [];
  return res.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const [sha = '', shortSha = '', author = 'a developer', date = '', subject = ''] = line.split('|');
      return { sha, shortSha, author, date, subject };
    })
    .filter((c) => Boolean(c.sha));
}

export interface VirtualConflictRefs {
  baseSha: string;
  oursSha: string;
  theirsSha: string;
  virtualTreeSha?: string;
}

export async function buildConflictEvidencePack(
  repoRoot: string,
  relPath: string,
  prevBaseSha: string,
  baseBranch: string,
  kind?: 'sync' | 'publish' | 'revert',
  virtualRefs?: VirtualConflictRefs,
): Promise<ConflictEvidencePack> {
  const [baseContent, oursContent, theirsContent, mergedMarkedContent] = virtualRefs
    ? await Promise.all([
        readGitRefFile(repoRoot, virtualRefs.baseSha, relPath),
        readGitRefFile(repoRoot, virtualRefs.oursSha, relPath),
        readGitRefFile(repoRoot, virtualRefs.theirsSha, relPath),
        readGitRefFile(repoRoot, virtualRefs.virtualTreeSha, relPath),
      ])
    : await Promise.all([
        readGitStage(repoRoot, 1, relPath),
        readGitStage(repoRoot, 2, relPath),
        readGitStage(repoRoot, 3, relPath),
        Promise.resolve(null),
      ]);

  let diskSample: Buffer | undefined;
  try {
    diskSample = await fs.readFile(path.join(repoRoot, relPath));
  } catch (err) {
    // deleted on one side: file type is inferred from the path alone
    if (!isMissingPathError(err)) ignore(err, 'conflict: read working-tree sample', { relPath });
    diskSample = undefined;
  }

  const fileType = detectFileType(relPath, diskSample);
  const isBinary = fileType === 'binary';
  const baseRef = `origin/${baseBranch}`;
  const upstreamCommits = prevBaseSha
    ? await getUpstreamCommits(repoRoot, prevBaseSha, baseRef, relPath)
    : [];

  const localRes = await gitRaw(repoRoot, [
    'log',
    '--first-parent',
    '-n',
    '15',
    '--format=%s',
    `${baseRef}..HEAD`,
    '--',
    relPath,
  ]);
  const localCheckpoints =
    localRes.code === 0 && localRes.stdout.trim()
      ? localRes.stdout
          .trim()
          .split(/\r?\n/)
          .map((s) => s.replace(/^halley-(?:checkpoint|undo|sync):\s*/i, ''))
      : [];

  return {
    path: relPath,
    affectedRoute: inferRouteFromFilePath(relPath),
    fileType,
    baseContent,
    oursContent,
    theirsContent,
    ...(mergedMarkedContent ? { mergedMarkedContent } : {}),
    isBinary,
    upstreamCommits,
    localCheckpoints,
    ...(kind ? { kind } : {}),
  };
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function previewSnippet(text: string | null | undefined, maxLen = 280): string {
  if (!text) return '(removed)';
  const trimmed = text.trim();
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…` : trimmed;
}

/**
 * Structural 3-way JSON merge for content collections (e.g. src/content/sermons/*.json).
 * Handles disjoint field edits, identical edits, and append-only keyed arrays (episodes).
 */
export function mergeJsonThreeWay(
  baseVal: unknown,
  oursVal: unknown,
  theirsVal: unknown,
  pathPrefix = '',
): { merged: unknown; conflicts: string[]; category: ConflictCategory } {
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  if (eq(oursVal, theirsVal)) {
    return { merged: oursVal, conflicts: [], category: 'identical_intent' };
  }
  if (eq(oursVal, baseVal)) {
    return { merged: theirsVal, conflicts: [], category: 'adjacent_disjoint' };
  }
  if (eq(theirsVal, baseVal)) {
    return { merged: oursVal, conflicts: [], category: 'adjacent_disjoint' };
  }

  // Plain objects: merge key-by-key
  if (
    baseVal &&
    oursVal &&
    theirsVal &&
    typeof baseVal === 'object' &&
    typeof oursVal === 'object' &&
    typeof theirsVal === 'object' &&
    !Array.isArray(baseVal) &&
    !Array.isArray(oursVal) &&
    !Array.isArray(theirsVal)
  ) {
    const bObj = baseVal as Record<string, unknown>;
    const oObj = oursVal as Record<string, unknown>;
    const tObj = theirsVal as Record<string, unknown>;
    const keys = new Set([...Object.keys(bObj), ...Object.keys(oObj), ...Object.keys(tObj)]);
    const out: Record<string, unknown> = {};
    const conflicts: string[] = [];
    let category: ConflictCategory = 'adjacent_disjoint';

    for (const key of keys) {
      const subPath = pathPrefix ? `${pathPrefix}.${key}` : key;
      const res = mergeJsonThreeWay(bObj[key], oObj[key], tObj[key], subPath);
      if (res.merged !== undefined) out[key] = res.merged;
      conflicts.push(...res.conflicts);
      if (res.category === 'both_added') category = 'both_added';
    }
    return { merged: out, conflicts, category };
  }

  // Arrays: union-merge append-only items or merge objects keyed by id/slug/title/date
  if (Array.isArray(baseVal) && Array.isArray(oursVal) && Array.isArray(theirsVal)) {
    const keyOf = (item: unknown): string | null => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const rec = item as Record<string, unknown>;
        for (const k of ['id', 'slug', 'youtubeId', 'title', 'date']) {
          if (typeof rec[k] === 'string' && rec[k]) return `${k}:${rec[k]}`;
        }
      }
      if (typeof item === 'string' || typeof item === 'number') return `v:${String(item)}`;
      return null;
    };

    const baseKeys = new Set(baseVal.map(keyOf).filter(Boolean));
    const oursKeys = oursVal.map(keyOf);
    const theirsKeys = theirsVal.map(keyOf);

    if (oursKeys.every(Boolean) && theirsKeys.every(Boolean)) {
      const baseMap = new Map(baseVal.map((item) => [keyOf(item)!, item]));
      const oursMap = new Map(oursVal.map((item) => [keyOf(item)!, item]));
      const theirsMap = new Map(theirsVal.map((item) => [keyOf(item)!, item]));

      const orderedKeys: string[] = [];
      const seen = new Set<string>();
      for (const k of [...oursKeys, ...theirsKeys] as string[]) {
        if (!seen.has(k)) {
          seen.add(k);
          orderedKeys.push(k);
        }
      }

      const out: unknown[] = [];
      const conflicts: string[] = [];
      let bothAdded = false;

      for (const k of orderedKeys) {
        const inB = baseKeys.has(k);
        const inO = oursMap.has(k);
        const inT = theirsMap.has(k);
        if (!inB && inO && !inT) {
          out.push(oursMap.get(k));
          bothAdded = true;
        } else if (!inB && !inO && inT) {
          out.push(theirsMap.get(k));
          bothAdded = true;
        } else if (inO && inT) {
          const res = mergeJsonThreeWay(baseMap.get(k), oursMap.get(k), theirsMap.get(k), `${pathPrefix}[${k}]`);
          out.push(res.merged);
          conflicts.push(...res.conflicts);
        } else if (inB && inO && !inT) {
          // Deleted in theirs; if untouched in ours, accept deletion, else conflict
          if (!eq(baseMap.get(k), oursMap.get(k))) {
            conflicts.push(`${pathPrefix}[${k}]`);
            out.push(oursMap.get(k));
          }
        } else if (inB && !inO && inT) {
          if (!eq(baseMap.get(k), theirsMap.get(k))) {
            conflicts.push(`${pathPrefix}[${k}]`);
            out.push(theirsMap.get(k));
          }
        }
      }

      return {
        merged: out,
        conflicts,
        category: bothAdded ? 'both_added' : 'adjacent_disjoint',
      };
    }
  }

  return {
    merged: oursVal,
    conflicts: [pathPrefix || 'root'],
    category: 'true_contradiction',
  };
}

/**
 * Step 2: Deterministic pre-pass ($0 AI, works even when daily spend cap is hit).
 * Returns a ConflictResolutionRecordDto if resolved or classified deterministically,
 * or null if Pi should inspect the evidence pack.
 */
export function tryDeterministicResolve(
  pack: ConflictEvidencePack,
): ConflictResolutionRecordDto | null {
  const id = `conflict-${crypto.createHash('sha1').update(pack.path).digest('hex').slice(0, 8)}`;
  const theirAuthor = pack.upstreamCommits[0]?.author || 'a teammate';
  const theirDate = pack.upstreamCommits[0]?.date
    ? new Date(pack.upstreamCommits[0].date).toLocaleDateString()
    : 'recently';
  const evidenceUsed = [
    ...pack.upstreamCommits.slice(0, 3).map((c) => `Live (${c.author}): ${c.subject}`),
    ...pack.localCheckpoints.slice(0, 3).map((s) => `Your edit: ${s}`),
  ];

  // 1. Derived lockfiles: take theirs (post-sync runs install)
  if (DERIVED_FILES.has(path.basename(pack.path))) {
    return {
      id,
      path: pack.path,
      category: 'derived_file',
      confidence: 'high',
      status: 'auto_resolved',
      explanation: `Took the latest ${path.basename(pack.path)} from the live site so dependencies can regenerate cleanly.`,
      evidenceUsed,
      affectedRoute: pack.affectedRoute,
      resolvedContent: pack.theirsContent ?? '',
      modelUsed: 'deterministic',
    };
  }

  // 2. Binary contradiction (e.g. both replaced the same photo)
  if (pack.isBinary) {
    return {
      id,
      path: pack.path,
      category: 'binary_contradiction',
      confidence: 'low',
      status: 'needs_choice',
      explanation: `Both you and ${theirAuthor} updated ${path.basename(pack.path)}. Choose which file to keep.`,
      evidenceUsed,
      affectedRoute: pack.affectedRoute,
      options: [
        {
          id: 'theirs',
          label: `Keep ${theirAuthor}'s version (${theirDate})`,
          description: pack.upstreamCommits[0]?.subject || 'Latest version on the live site',
          recommended: true,
          source: 'theirs',
        },
        {
          id: 'ours',
          label: 'Keep your version',
          description: pack.localCheckpoints[0] || 'Your draft upload',
          source: 'ours',
        },
      ],
      modelUsed: 'deterministic',
    };
  }

  // 3. Delete vs modify
  if (pack.oursContent === null && pack.theirsContent !== null) {
    return {
      id,
      path: pack.path,
      category: 'delete_vs_modify',
      confidence: 'low',
      status: 'needs_choice',
      explanation: `You removed ${pack.path}, while ${theirAuthor} updated it on the live site.`,
      evidenceUsed,
      affectedRoute: pack.affectedRoute,
      theirsPreview: previewSnippet(pack.theirsContent),
      options: [
        {
          id: 'theirs',
          label: `Keep ${theirAuthor}'s updated file`,
          description: pack.upstreamCommits[0]?.subject || 'Keep the live site update',
          recommended: true,
          previewText: previewSnippet(pack.theirsContent),
          source: 'theirs',
        },
        {
          id: 'ours',
          label: 'Remove the file',
          description: 'Apply your deletion',
          previewText: '(file removed)',
          source: 'ours',
        },
      ],
      modelUsed: 'deterministic',
    };
  }
  if (pack.theirsContent === null && pack.oursContent !== null) {
    return {
      id,
      path: pack.path,
      category: 'delete_vs_modify',
      confidence: 'low',
      status: 'needs_choice',
      explanation: `${theirAuthor} removed ${pack.path} on the live site, while you edited it in your draft.`,
      evidenceUsed,
      affectedRoute: pack.affectedRoute,
      oursPreview: previewSnippet(pack.oursContent),
      options: [
        {
          id: 'ours',
          label: 'Keep your edited file',
          description: 'Restore the file with your changes',
          recommended: true,
          previewText: previewSnippet(pack.oursContent),
          source: 'ours',
        },
        {
          id: 'theirs',
          label: 'Accept removal',
          description: `Discard your edits to match ${theirAuthor}'s removal`,
          previewText: '(file removed)',
          source: 'theirs',
        },
      ],
      modelUsed: 'deterministic',
    };
  }

  const base = pack.baseContent ?? '';
  const ours = pack.oursContent ?? '';
  const theirs = pack.theirsContent ?? '';

  // 4. Identical intent
  if (ours === theirs || normalizeWhitespace(ours) === normalizeWhitespace(theirs)) {
    return {
      id,
      path: pack.path,
      category: 'identical_intent',
      confidence: 'high',
      status: 'auto_resolved',
      explanation: `Both you and ${theirAuthor} made the same update in ${pack.path}.`,
      evidenceUsed,
      affectedRoute: pack.affectedRoute,
      resolvedContent: theirs,
      resolvedPreview: previewSnippet(theirs),
      modelUsed: 'deterministic',
    };
  }

  // 5. Formatting vs content
  if (base && normalizeWhitespace(base) === normalizeWhitespace(theirs)) {
    return {
      id,
      path: pack.path,
      category: 'formatting_vs_content',
      confidence: 'high',
      status: 'auto_resolved',
      explanation: `Live site only reformatted whitespace; kept your content update in ${pack.path}.`,
      evidenceUsed,
      affectedRoute: pack.affectedRoute,
      resolvedContent: ours,
      resolvedPreview: previewSnippet(ours),
      modelUsed: 'deterministic',
    };
  }
  if (base && normalizeWhitespace(base) === normalizeWhitespace(ours)) {
    return {
      id,
      path: pack.path,
      category: 'formatting_vs_content',
      confidence: 'high',
      status: 'auto_resolved',
      explanation: `Your draft only changed whitespace; kept ${theirAuthor}'s live update in ${pack.path}.`,
      evidenceUsed,
      affectedRoute: pack.affectedRoute,
      resolvedContent: theirs,
      resolvedPreview: previewSnippet(theirs),
      modelUsed: 'deterministic',
    };
  }

  // 6. Structural 3-way JSON merge (e.g. sermon collections)
  if (pack.fileType === 'json') {
    try {
      const bJson = base ? JSON.parse(base) : {};
      const oJson = JSON.parse(ours);
      const tJson = JSON.parse(theirs);
      const merged = mergeJsonThreeWay(bJson, oJson, tJson);
      if (merged.conflicts.length === 0) {
        const formatted = `${JSON.stringify(merged.merged, null, 2)}\n`;
        return {
          id,
          path: pack.path,
          category: merged.category,
          confidence: 'high',
          status: 'auto_resolved',
          explanation:
            merged.category === 'both_added'
              ? `Combined additions from both your draft and ${theirAuthor} in ${pack.path}.`
              : `Merged non-overlapping fields from your draft and ${theirAuthor} in ${pack.path}.`,
          evidenceUsed,
          affectedRoute: pack.affectedRoute,
          resolvedContent: formatted,
          resolvedPreview: previewSnippet(formatted),
          modelUsed: 'deterministic',
        };
      }
    } catch (err) {
      // Fall through to Pi if JSON cannot be parsed cleanly
      ignoreExpected(err, 'conflict: deterministic JSON merge not applicable', { path: pack.path });
    }
  }

  return null;
}

/**
 * Validates that a candidate resolution has zero conflict markers and parses cleanly
 * for JSON/TS/Astro files (Step 7 hard validation).
 */
export async function validateResolvedContent(
  repoRoot: string,
  relPath: string,
  content: string,
): Promise<{ valid: boolean; error?: string }> {
  if (/^(<{7}(?: |\r?$)|={7}\r?$|>{7}(?: |\r?$))/m.test(content)) {
    return { valid: false, error: `Conflict markers remain in ${relPath}` };
  }
  const fileType = detectFileType(relPath);
  if (fileType === 'json') {
    try {
      JSON.parse(content);
    } catch (err) {
      return {
        valid: false,
        error: `Invalid JSON in ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  if (fileType === 'astro') {
    const trimmed = content.trimStart();
    if (trimmed.startsWith('---')) {
      const closeIdx = trimmed.indexOf('\n---', 3);
      if (closeIdx === -1) {
        return { valid: false, error: `Unclosed Astro frontmatter fence in ${relPath}` };
      }
    }
  }
  void repoRoot;
  return { valid: true };
}

/**
 * Builds the default ≤3-option contradiction record when Pi is unavailable or
 * confirms a genuine human contradiction.
 */
export function buildContradictionRecord(
  pack: ConflictEvidencePack,
  opts?: {
    explanation?: string;
    combinedContent?: string;
    combinedLabel?: string;
    recommended?: 'theirs' | 'ours' | 'combined';
    modelUsed?: string;
  },
): ConflictResolutionRecordDto {
  const id = `conflict-${crypto.createHash('sha1').update(pack.path).digest('hex').slice(0, 8)}`;
  const theirAuthor = pack.upstreamCommits[0]?.author || 'a teammate';
  const theirDate = pack.upstreamCommits[0]?.date
    ? new Date(pack.upstreamCommits[0].date).toLocaleDateString()
    : 'recently';
  const evidenceUsed = [
    ...pack.upstreamCommits.slice(0, 3).map((c) => `Live (${c.author}): ${c.subject}`),
    ...pack.localCheckpoints.slice(0, 3).map((s) => `Your edit: ${s}`),
  ];

  const isRevert = pack.kind === 'revert';
  const options: ConflictOptionDto[] = isRevert
    ? [
        {
          id: 'ours',
          label: 'Keep current live site (skip undoing this file)',
          description: 'Preserves the newer live-site edits on this file',
          recommended: (opts?.recommended ?? 'ours') === 'ours',
          previewText: previewSnippet(pack.oursContent),
          source: 'ours',
        },
        {
          id: 'theirs',
          label: 'Restore earlier version (force undo)',
          description: 'Reverts this file to before the publication (overwrites newer edits)',
          recommended: opts?.recommended === 'theirs',
          previewText: previewSnippet(pack.theirsContent),
          source: 'theirs',
        },
      ]
    : [
        {
          id: 'theirs',
          label: `Keep ${theirAuthor}'s version (${theirDate})`,
          description: pack.upstreamCommits[0]?.subject || 'Matches the latest live site',
          recommended: (opts?.recommended ?? 'theirs') === 'theirs',
          previewText: previewSnippet(pack.theirsContent),
          source: 'theirs',
        },
        {
          id: 'ours',
          label: 'Keep your version',
          description: pack.localCheckpoints[0] || 'Keep your draft wording',
          recommended: opts?.recommended === 'ours',
          previewText: previewSnippet(pack.oursContent),
          source: 'ours',
        },
      ];

  if (opts?.combinedContent) {
    options.push({
      id: 'combined',
      label: opts.combinedLabel || 'Combine both updates',
      description: 'Keep the intent of both changes together',
      recommended: opts.recommended === 'combined',
      previewText: previewSnippet(opts.combinedContent),
      source: 'combined',
    });
  }

  // Always put recommended option first
  options.sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)));

  return {
    id,
    path: pack.path,
    category: 'true_contradiction',
    confidence: 'low',
    status: 'needs_choice',
    explanation:
      opts?.explanation ||
      (isRevert
        ? `Someone updated ${pack.path} after this publication. Choose whether to keep the newer live version or restore the earlier state.`
        : `Both you and ${theirAuthor} changed the same section in ${pack.path}. Choose which version to keep.`),
    evidenceUsed,
    affectedRoute: pack.affectedRoute,
    oursPreview: previewSnippet(pack.oursContent),
    theirsPreview: previewSnippet(pack.theirsContent),
    resolvedContent: opts?.combinedContent,
    options: options.slice(0, 3),
    modelUsed: opts?.modelUsed ?? 'deterministic',
  };
}

export interface ParsedConflictHunk {
  index: number;
  startChar: number;
  endChar: number;
  oursBlock: string;
  theirsBlock: string;
  contextBefore: string;
  contextAfter: string;
}

export function parseMarkedConflictHunks(markedText: string): ParsedConflictHunk[] {
  const hunks: ParsedConflictHunk[] = [];
  const re = /^<{7}[^\n]*\r?\n([\s\S]*?)^={7}\r?\n([\s\S]*?)^>{7}[^\n]*(?:\r?\n|$)/gm;
  let m: RegExpExecArray | null;
  let idx = 1;
  while ((m = re.exec(markedText)) !== null) {
    const startChar = m.index;
    const endChar = m.index + m[0].length;
    const beforeLines = markedText.slice(0, startChar).split(/\r?\n/);
    const afterLines = markedText.slice(endChar).split(/\r?\n/);
    hunks.push({
      index: idx++,
      startChar,
      endChar,
      oursBlock: m[1] ?? '',
      theirsBlock: m[2] ?? '',
      contextBefore: beforeLines.slice(-12).join('\n'),
      contextAfter: afterLines.slice(0, 12).join('\n'),
    });
  }
  return hunks;
}

export function spliceResolvedHunks(
  markedText: string,
  parsedHunks: ParsedConflictHunk[],
  replacements: Array<{ index: number; replacement: string }>,
): string | null {
  const byIdx = new Map(replacements.map((r) => [Number(r.index), r.replacement]));
  if (parsedHunks.some((h) => !byIdx.has(h.index))) return null;
  let out = '';
  let cursor = 0;
  for (const h of parsedHunks) {
    out += markedText.slice(cursor, h.startChar);
    let rep = byIdx.get(h.index) ?? '';
    const origHadTrailingNewline = markedText.slice(h.startChar, h.endChar).endsWith('\n');
    if (origHadTrailingNewline && rep.length > 0 && !rep.endsWith('\n')) {
      rep += '\n';
    }
    out += rep;
    cursor = h.endChar;
  }
  out += markedText.slice(cursor);
  return out;
}

function extractBalancedJsonObject(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced?.[1]?.trim() ?? raw.trim();
  const start = candidate.indexOf('{');
  if (start === -1) return candidate;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return candidate.slice(start, i + 1);
      }
    }
  }
  return candidate.slice(start);
}

export function buildConflictPromptForPack(
  pack: ConflictEvidencePack,
  extra?: { rejectedAttempt?: string; userNote?: string; customInstruction?: string },
): { system: string; user: string; hunks?: ParsedConflictHunk[] } {
  const parsedHunks =
    pack.mergedMarkedContent && pack.mergedMarkedContent.length > 2_500
      ? parseMarkedConflictHunks(pack.mergedMarkedContent)
      : [];
  const useHunkMode = parsedHunks.length > 0;

  const system = [
    "You are Halley's expert Git Conflict Resolution Assistant for an Astro static website.",
    'Resolve conflicts by INTENT using commit history and checkpoints, not naive line picking.',
    'Classify the conflict into one of:',
    'adjacent_disjoint | identical_intent | formatting_vs_content | refinement | moved_refactored | both_added | derived_file | delete_vs_modify | true_contradiction | binary_contradiction.',
    'Auto-resolve with confidence="high" or "medium" whenever intents are compatible.',
    'Only set status="needs_choice" with confidence="low" when there is a genuine contradiction with multiple logical outcomes (provide at most 3 options).',
    'Never leave <<<<<<<, =======, or >>>>>>> markers in your output.',
    'Respond ONLY with a single JSON object matching:',
    useHunkMode
      ? '{ "category": "...", "confidence": "high|medium|low", "status": "auto_resolved|needs_review|needs_choice", "explanation": "One plain-language sentence with no git jargon", "hunks": [{ "index": 1, "replacement": "exact merged lines for hunk 1" }], "recommended": "theirs|ours|combined" }'
      : '{ "category": "...", "confidence": "high|medium|low", "status": "auto_resolved|needs_review|needs_choice", "explanation": "One plain-language sentence with no git jargon", "resolvedContent": "full file content if resolved or combined", "recommended": "theirs|ours|combined" }',
  ].join('\n');

  const parts = [
    `File: ${pack.path} (route: ${pack.affectedRoute}, type: ${pack.fileType})`,
    `Upstream live commits:\n${pack.upstreamCommits.map((c) => `- ${c.shortSha} (${c.author}, ${c.date}): ${c.subject}`).join('\n') || '(none)'}`,
    `User draft checkpoints:\n${pack.localCheckpoints.map((c) => `- ${c}`).join('\n') || '(none)'}`,
  ];

  if (useHunkMode) {
    parts.push(
      `This file has ${parsedHunks.length} localized conflict hunk(s). Provide the exact merged replacement for every hunk index 1..${parsedHunks.length} (without surrounding context lines):`,
    );
    for (const h of parsedHunks) {
      parts.push(
        [
          `=== CONFLICT HUNK #${h.index} ===`,
          `[Context before (do NOT repeat in replacement)]:\n${h.contextBefore}`,
          `--- OURS (user draft) ---\n${h.oursBlock.replace(/\r?\n$/, '')}`,
          `--- THEIRS (latest live site) ---\n${h.theirsBlock.replace(/\r?\n$/, '')}`,
          `[Context after (do NOT repeat in replacement)]:\n${h.contextAfter}`,
        ].join('\n'),
      );
    }
  } else {
    parts.push(
      `--- BASE (before either edit) ---\n${pack.baseContent ?? '(absent)'}`,
      `--- OURS (user draft) ---\n${pack.oursContent ?? '(deleted)'}`,
      `--- THEIRS (latest live site) ---\n${pack.theirsContent ?? '(deleted)'}`,
    );
  }

  if (extra?.rejectedAttempt) {
    parts.push(`--- PREVIOUS ATTEMPT REJECTED BY USER ---\n${extra.rejectedAttempt}`);
  }
  if (extra?.userNote) {
    parts.push(`User feedback on what was wrong: ${extra.userNote}`);
  }
  if (extra?.customInstruction) {
    parts.push(`User custom instruction ("Something else"): ${extra.customInstruction}`);
  }

  return { system, user: parts.join('\n\n'), ...(useHunkMode ? { hunks: parsedHunks } : {}) };
}

/** Deadline for one conflict-resolution LLM call (thinking + an 8k-token answer). */
const CONFLICT_LLM_TIMEOUT_MS = Number(process.env.HALLEY_CONFLICT_LLM_TIMEOUT_MS || 180_000);
/** Deadline for one token-count call (cheap; falls back to a character estimate). */
const COUNT_TOKENS_TIMEOUT_MS = 15_000;

export interface LlmConflictCaller {
  /** Clock for the request deadline (defaults to the real clock). */
  clock?: Clock;
  controlPlaneInternalUrl: string;
  workspaceToken: string;
  modelId: string;
  thinkingLevel: 'off' | 'low' | 'medium' | 'high';
  purpose: 'conflict' | 'conflict-escalation';
  runId?: string;
  runCeilingUsd?: number;
}

/**
 * Calls the Anthropic Messages API through the control-plane LLM proxy (separate from the user's
 * Pi chat thread so no fake user prompts ever appear in chat).
 */
export async function resolvePackWithLlm(
  repoRoot: string,
  pack: ConflictEvidencePack,
  caller: LlmConflictCaller,
  extra?: { rejectedAttempt?: string; userNote?: string; customInstruction?: string },
): Promise<{ record: ConflictResolutionRecordDto; usageUsd: number; stoppedAtCeiling?: boolean }> {
  const { system, user, hunks: promptHunks } = buildConflictPromptForPack(pack, extra);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${caller.workspaceToken}`,
    'x-halley-purpose': caller.purpose,
  };
  if (caller.runId) headers['x-halley-run-id'] = caller.runId;
  if (caller.runCeilingUsd) headers['x-halley-run-ceiling-usd'] = String(caller.runCeilingUsd);

  const thinkingBudget =
    caller.thinkingLevel === 'high'
      ? 8000
      : caller.thinkingLevel === 'medium'
        ? 4000
        : caller.thinkingLevel === 'low'
          ? 1500
          : 0;

  const body: Record<string, unknown> = {
    model: caller.modelId,
    max_tokens: thinkingBudget > 0 ? thinkingBudget + 8192 : 8192,
    system,
    messages: [{ role: 'user', content: user }],
  };
  if (thinkingBudget > 0) {
    body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
  }

  let res: Response;
  try {
    res = await fetch(`${caller.controlPlaneInternalUrl}/internal/llm/anthropic/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: (caller.clock ?? realClock).timeoutSignal(CONFLICT_LLM_TIMEOUT_MS),
    });
  } catch (err) {
    // timeout / control plane unreachable: the user chooses, exactly like a refused call
    ignore(err, 'conflict: LLM resolution request failed', { path: pack.path });
    return {
      record: buildContradictionRecord(pack, { modelUsed: caller.modelId }),
      usageUsd: 0,
    };
  }

  if (res.status === 429) {
    // body only refines the message (ceiling vs daily budget); a failed read means "daily budget"
    const errText = await orDefault(res.text(), '', 'conflict: read 429 response body');
    const stoppedAtCeiling = errText.includes('run_ceiling_reached');
    return {
      record: buildContradictionRecord(pack, {
        explanation: stoppedAtCeiling
          ? 'Stopped to stay within the cost estimate ceiling.'
          : 'Daily AI budget reached; please choose which version to keep.',
        modelUsed: caller.modelId,
      }),
      usageUsd: 0,
      stoppedAtCeiling,
    };
  }

  if (!res.ok) {
    return {
      record: buildContradictionRecord(pack, { modelUsed: caller.modelId }),
      usageUsd: 0,
    };
  }

  let json: {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  try {
    json = (await res.json()) as typeof json;
  } catch (err) {
    // body read timed out / was cut off: same outcome as a refused call
    ignore(err, 'conflict: read LLM resolution response', { path: pack.path });
    return {
      record: buildContradictionRecord(pack, { modelUsed: caller.modelId }),
      usageUsd: 0,
    };
  }
  const textBlock = json.content?.find((b) => b.type === 'text')?.text ?? '';
  const inp = json.usage?.input_tokens ?? 0;
  const out = json.usage?.output_tokens ?? 0;
  const isOpus = caller.modelId.includes('opus');
  const isHaiku = caller.modelId.includes('haiku');
  const inRate = isOpus ? 5 : isHaiku ? 1 : 3;
  const outRate = isOpus ? 25 : isHaiku ? 5 : 15;
  const usageUsd = (inp / 1_000_000) * inRate + (out / 1_000_000) * outRate;

  try {
    const jsonText = extractBalancedJsonObject(textBlock);
    const parsed = JSON.parse(jsonText) as {
      category?: ConflictCategory;
      confidence?: ConflictConfidence;
      status?: 'auto_resolved' | 'needs_review' | 'needs_choice';
      explanation?: string;
      resolvedContent?: string;
      hunks?: Array<{ index: number; replacement: string }>;
      recommended?: 'theirs' | 'ours' | 'combined';
    };

    let finalResolvedContent = parsed.resolvedContent;
    if (
      !finalResolvedContent &&
      promptHunks &&
      promptHunks.length > 0 &&
      pack.mergedMarkedContent &&
      Array.isArray(parsed.hunks)
    ) {
      finalResolvedContent =
        spliceResolvedHunks(pack.mergedMarkedContent, promptHunks, parsed.hunks) ?? undefined;
    }

    if (finalResolvedContent) {
      const check = await validateResolvedContent(repoRoot, pack.path, finalResolvedContent);
      if (!check.valid) {
        return {
          record: buildContradictionRecord(pack, {
            explanation: `Automatic merge could not be validated (${check.error}). Please choose which version to keep.`,
            modelUsed: caller.modelId,
          }),
          usageUsd,
        };
      }
    }

    if (parsed.status === 'needs_choice' || parsed.confidence === 'low' || !finalResolvedContent) {
      return {
        record: buildContradictionRecord(pack, {
          explanation: parsed.explanation,
          combinedContent: finalResolvedContent,
          recommended: parsed.recommended,
          modelUsed: caller.modelId,
        }),
        usageUsd,
      };
    }

    const id = `conflict-${crypto.createHash('sha1').update(pack.path).digest('hex').slice(0, 8)}`;
    const status = parsed.confidence === 'medium' ? 'needs_review' : 'auto_resolved';
    return {
      record: {
        id,
        path: pack.path,
        category: parsed.category ?? 'adjacent_disjoint',
        confidence: parsed.confidence ?? 'high',
        status,
        explanation: parsed.explanation || `Combined your changes with the live site in ${pack.path}.`,
        evidenceUsed: [
          ...pack.upstreamCommits.slice(0, 3).map((c) => `Live (${c.author}): ${c.subject}`),
          ...pack.localCheckpoints.slice(0, 3).map((s) => `Your edit: ${s}`),
        ],
        affectedRoute: pack.affectedRoute,
        oursPreview: previewSnippet(pack.oursContent),
        theirsPreview: previewSnippet(pack.theirsContent),
        resolvedPreview: previewSnippet(finalResolvedContent),
        resolvedContent: finalResolvedContent,
        modelUsed: caller.modelId,
      },
      usageUsd,
    };
  } catch (err) {
    // the user is asked to choose instead; the reason is logged for diagnosis
    ignore(err, 'conflict: AI resolution failed; falling back to a manual choice', { path: pack.path });
    return {
      record: buildContradictionRecord(pack, { modelUsed: caller.modelId }),
      usageUsd,
    };
  }
}

/**
 * Computes an exact input-token estimate via Anthropic's free count_tokens endpoint
 * through the control-plane proxy, scaled for Opus medium-thinking output.
 */
export async function estimateEscalationCost(opts: {
  packs: ConflictEvidencePack[];
  controlPlaneInternalUrl: string;
  workspaceToken: string;
  /** Clock for the per-call deadline (defaults to the real clock). */
  clock?: Clock;
  escalationModelId: string;
  hardCeilingUsd: number;
  remainingBudgetUsd: number;
  firstPassUsageUsd?: number;
  userNote?: string;
}): Promise<EscalationEstimateDto> {
  let totalInputTokens = 0;

  for (const pack of opts.packs) {
    const { system, user } = buildConflictPromptForPack(pack, { userNote: opts.userNote });
    try {
      const res = await fetch(
        `${opts.controlPlaneInternalUrl}/internal/llm/anthropic/v1/messages/count_tokens`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${opts.workspaceToken}`,
            'x-halley-purpose': 'conflict-escalation',
          },
          body: JSON.stringify({
            model: opts.escalationModelId,
            system,
            messages: [{ role: 'user', content: user }],
          }),
          signal: (opts.clock ?? realClock).timeoutSignal(COUNT_TOKENS_TIMEOUT_MS),
        },
      );
      if (res.ok) {
        const data = (await res.json()) as { input_tokens?: number };
        totalInputTokens += data.input_tokens ?? 0;
        continue;
      }
    } catch (err) {
      // Fallback to character estimate (~4 chars/token)
      ignore(err, 'conflict: token count request failed; using character estimate');
    }
    totalInputTokens += Math.ceil((system.length + user.length) / 4);
  }

  // Opus 4.5 / 4.6 rates ($5/MTok in, $25/MTok out)
  const inRate = 5;
  const outRate = 25;
  const estOutPerConflictLow = 2500; // medium thinking + resolution JSON
  const estOutPerConflictHigh = 5500; // retry round + medium thinking
  const count = Math.max(1, opts.packs.length);

  const aboutUsd = Number(
    ((totalInputTokens / 1_000_000) * inRate + ((count * estOutPerConflictLow) / 1_000_000) * outRate).toFixed(2),
  );
  const upToUsd = Number(
    (
      ((totalInputTokens * 2) / 1_000_000) * inRate +
      ((count * estOutPerConflictHigh) / 1_000_000) * outRate
    ).toFixed(2),
  );

  const safeAbout = Math.max(0.02, aboutUsd);
  const safeUpTo = Math.max(safeAbout + 0.05, upToUsd);

  return {
    estimatedInputTokens: totalInputTokens,
    aboutUsd: safeAbout,
    upToUsd: safeUpTo,
    hardCeilingUsd: opts.hardCeilingUsd,
    exceedsCeiling: safeUpTo > opts.hardCeilingUsd,
    remainingBudgetUsd: Number(opts.remainingBudgetUsd.toFixed(2)),
    canAfford: opts.remainingBudgetUsd >= safeAbout,
    modelLabel: 'Advanced',
    conflictCount: opts.packs.length,
  };
}

/**
 * Applies a resolved file content (or deletion) and verifies zero conflict markers remain.
 */
export async function applyResolvedFile(
  repoRoot: string,
  relPath: string,
  content: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const abs = path.join(repoRoot, relPath);
  if (content === null) {
    await fs.rm(abs, { force: true });
    await gitRaw(repoRoot, ['rm', '-f', '--ignore-unmatch', relPath]);
    return { ok: true };
  }
  const validation = await validateResolvedContent(repoRoot, relPath, content);
  if (!validation.valid) return { ok: false, error: validation.error };

  await fs.mkdir(path.dirname(abs), { recursive: true });
  // astro dev / the agent may read it right away: never a half-written resolution
  await writeFileAtomic(abs, content);
  const markers = await findFilesWithConflictMarkers(repoRoot, [relPath]);
  if (markers.length > 0) {
    return { ok: false, error: `Conflict markers detected in ${relPath}` };
  }
  await gitRaw(repoRoot, ['add', relPath]);
  return { ok: true };
}
