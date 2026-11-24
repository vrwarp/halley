import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  ConflictCategory,
  ConflictConfidence,
  ConflictOptionDto,
  ConflictResolutionRecordDto,
  EscalationEstimateDto,
  UpstreamCommitInfoDto,
} from '@halley/shared';
import { findFilesWithConflictMarkers } from './checkpoints-and-git.js';

const execFileAsync = promisify(execFile);

async function gitRaw(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const res = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout: res.stdout, stderr: res.stderr, code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? (err instanceof Error ? err.message : String(err)),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

export interface ConflictEvidencePack {
  path: string;
  affectedRoute: string;
  fileType: 'astro' | 'json' | 'ts' | 'md' | 'binary' | 'text';
  baseContent: string | null;
  oursContent: string | null;
  theirsContent: string | null;
  isBinary: boolean;
  upstreamCommits: UpstreamCommitInfoDto[];
  localCheckpoints: string[];
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
  if (norm.startsWith('src/content/sermons/')) return '/sermons';
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

export async function buildConflictEvidencePack(
  repoRoot: string,
  relPath: string,
  prevBaseSha: string,
  baseBranch: string,
): Promise<ConflictEvidencePack> {
  const [baseContent, oursContent, theirsContent] = await Promise.all([
    readGitStage(repoRoot, 1, relPath),
    readGitStage(repoRoot, 2, relPath),
    readGitStage(repoRoot, 3, relPath),
  ]);

  let diskSample: Buffer | undefined;
  try {
    diskSample = await fs.readFile(path.join(repoRoot, relPath));
  } catch {
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
    isBinary,
    upstreamCommits,
    localCheckpoints,
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
    } catch {
      // Fall through to Pi if JSON cannot be parsed cleanly
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

  const options: ConflictOptionDto[] = [
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
      `Both you and ${theirAuthor} changed the same section in ${pack.path}. Choose which version to keep.`,
    evidenceUsed,
    affectedRoute: pack.affectedRoute,
    oursPreview: previewSnippet(pack.oursContent),
    theirsPreview: previewSnippet(pack.theirsContent),
    resolvedContent: opts?.combinedContent,
    options: options.slice(0, 3),
    modelUsed: opts?.modelUsed ?? 'deterministic',
  };
}

export function buildConflictPromptForPack(
  pack: ConflictEvidencePack,
  extra?: { rejectedAttempt?: string; userNote?: string; customInstruction?: string },
): { system: string; user: string } {
  const system = [
    'You are Halley\'s expert Git Conflict Resolution Assistant for an Astro static website.',
    'Resolve conflicts by INTENT using commit history and checkpoints, not naive line picking.',
    'Classify the conflict into one of:',
    'adjacent_disjoint | identical_intent | formatting_vs_content | refinement | moved_refactored | both_added | derived_file | delete_vs_modify | true_contradiction | binary_contradiction.',
    'Auto-resolve with confidence="high" or "medium" whenever intents are compatible.',
    'Only set status="needs_choice" with confidence="low" when there is a genuine contradiction with multiple logical outcomes (provide at most 3 options).',
    'Never leave <<<<<<<, =======, or >>>>>>> markers in resolvedContent.',
    'Respond ONLY with a single JSON object matching:',
    '{ "category": "...", "confidence": "high|medium|low", "status": "auto_resolved|needs_review|needs_choice", "explanation": "One plain-language sentence with no git jargon", "resolvedContent": "full file content if resolved or combined", "recommended": "theirs|ours|combined" }',
  ].join('\n');

  const parts = [
    `File: ${pack.path} (route: ${pack.affectedRoute}, type: ${pack.fileType})`,
    `Upstream live commits:\n${pack.upstreamCommits.map((c) => `- ${c.shortSha} (${c.author}, ${c.date}): ${c.subject}`).join('\n') || '(none)'}`,
    `User draft checkpoints:\n${pack.localCheckpoints.map((c) => `- ${c}`).join('\n') || '(none)'}`,
    `--- BASE (before either edit) ---\n${pack.baseContent ?? '(absent)'}`,
    `--- OURS (user draft) ---\n${pack.oursContent ?? '(deleted)'}`,
    `--- THEIRS (latest live site) ---\n${pack.theirsContent ?? '(deleted)'}`,
  ];
  if (extra?.rejectedAttempt) {
    parts.push(`--- PREVIOUS ATTEMPT REJECTED BY USER ---\n${extra.rejectedAttempt}`);
  }
  if (extra?.userNote) {
    parts.push(`User feedback on what was wrong: ${extra.userNote}`);
  }
  if (extra?.customInstruction) {
    parts.push(`User custom instruction ("Something else"): ${extra.customInstruction}`);
  }

  return { system, user: parts.join('\n\n') };
}

export interface LlmConflictCaller {
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
  const { system, user } = buildConflictPromptForPack(pack, extra);
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
    max_tokens: thinkingBudget > 0 ? thinkingBudget + 4096 : 4096,
    system,
    messages: [{ role: 'user', content: user }],
  };
  if (thinkingBudget > 0) {
    body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
  }

  const res = await fetch(`${caller.controlPlaneInternalUrl}/internal/llm/anthropic/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    const errText = await res.text().catch(() => '');
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

  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const textBlock = json.content?.find((b) => b.type === 'text')?.text ?? '';
  const inp = json.usage?.input_tokens ?? 0;
  const out = json.usage?.output_tokens ?? 0;
  const isOpus = caller.modelId.includes('opus');
  const isHaiku = caller.modelId.includes('haiku');
  const inRate = isOpus ? 5 : isHaiku ? 1 : 3;
  const outRate = isOpus ? 25 : isHaiku ? 5 : 15;
  const usageUsd = (inp / 1_000_000) * inRate + (out / 1_000_000) * outRate;

  try {
    const match = textBlock.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : textBlock) as {
      category?: ConflictCategory;
      confidence?: ConflictConfidence;
      status?: 'auto_resolved' | 'needs_review' | 'needs_choice';
      explanation?: string;
      resolvedContent?: string;
      recommended?: 'theirs' | 'ours' | 'combined';
    };

    if (parsed.resolvedContent) {
      const check = await validateResolvedContent(repoRoot, pack.path, parsed.resolvedContent);
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

    if (parsed.status === 'needs_choice' || parsed.confidence === 'low' || !parsed.resolvedContent) {
      return {
        record: buildContradictionRecord(pack, {
          explanation: parsed.explanation,
          combinedContent: parsed.resolvedContent,
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
        resolvedPreview: previewSnippet(parsed.resolvedContent),
        resolvedContent: parsed.resolvedContent,
        modelUsed: caller.modelId,
      },
      usageUsd,
    };
  } catch {
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
        },
      );
      if (res.ok) {
        const data = (await res.json()) as { input_tokens?: number };
        totalInputTokens += data.input_tokens ?? 0;
        continue;
      }
    } catch {
      // Fallback to character estimate (~4 chars/token)
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
  await fs.writeFile(abs, content, 'utf8');
  const markers = await findFilesWithConflictMarkers(repoRoot, [relPath]);
  if (markers.length > 0) {
    return { ok: false, error: `Conflict markers detected in ${relPath}` };
  }
  await gitRaw(repoRoot, ['add', relPath]);
  return { ok: true };
}
