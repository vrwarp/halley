import type { RevertedCommitSummaryDto, SessionArchiveDto } from '@halley/shared';
import type { SessionRecord } from './db.js';
import { ignore } from './log.js';

interface TranscriptEntryShape {
  role?: string;
  text?: string;
  isIntermediate?: boolean;
  attachments?: Array<{ stagedId: string; filename: string }>;
}

const HEADER_PREFIXES = [
  '[Halley Page Request] ',
  '[Current Preview] ',
  '[Selected Element ',
  '[Uploaded Image] ',
];

/**
 * Strips Halley's injected per-turn metadata header lines (`[Current Preview]`,
 * `[Selected Element ...]`, `[Uploaded Image]`, `[Halley Page Request]`) so handoff
 * digests spend their character budget on the editor's actual request text.
 */
export function stripInjectedPromptHeaders(raw: string): string {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  let idx = 0;
  while (idx < lines.length) {
    const trimmed = lines[idx]!.trim();
    if (!trimmed) {
      idx += 1;
      continue;
    }
    if (HEADER_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
      idx += 1;
      continue;
    }
    break;
  }
  return lines.slice(idx).join('\n').trim();
}

function compactText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export interface ExtractedTurnPair {
  user: string;
  assistant?: string;
}

export function extractTranscriptTurnDigest(
  transcriptJson: string,
  opts: {
    maxTurns?: number;
    maxUserChars?: number;
    maxAssistantChars?: number;
    maxTotalChars?: number;
    includeStagedUploads?: boolean;
  } = {},
): {
  turns: ExtractedTurnPair[];
  stagedUploads: string[];
  formatted: string;
} {
  const maxTurns = opts.maxTurns ?? 8;
  const maxUserChars = opts.maxUserChars ?? 600;
  const maxAssistantChars = opts.maxAssistantChars ?? 400;
  const maxTotalChars = opts.maxTotalChars ?? 4000;

  let entries: TranscriptEntryShape[] = [];
  try {
    const parsed = JSON.parse(transcriptJson) as { entries?: TranscriptEntryShape[] } | null;
    entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    // A corrupt archived transcript only loses the conversational part of the handoff.
    ignore(err, 'handoff: archived transcript is not valid JSON; omitting conversation turns', {
      length: transcriptJson.length,
    });
    return { turns: [], stagedUploads: [], formatted: '' };
  }

  const allTurns: ExtractedTurnPair[] = [];
  let current: ExtractedTurnPair | null = null;

  for (const entry of entries) {
    if (entry.role === 'user' && typeof entry.text === 'string') {
      const cleaned = stripInjectedPromptHeaders(entry.text);
      if (!cleaned) continue;
      if (current) allTurns.push(current);
      current = { user: compactText(cleaned, maxUserChars) };
    } else if (
      entry.role === 'assistant' &&
      !entry.isIntermediate &&
      typeof entry.text === 'string' &&
      entry.text.trim()
    ) {
      if (current) {
        current.assistant = compactText(entry.text, maxAssistantChars);
      }
    }
  }
  if (current) allTurns.push(current);

  const recent = allTurns.slice(-maxTurns);
  const selected: ExtractedTurnPair[] = [];
  let totalChars = 0;

  // Fill from most recent backwards so the latest turns always survive the cap
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const turn = recent[i]!;
    const block = turn.assistant
      ? `- User: ${turn.user}\n  Halley: ${turn.assistant}`
      : `- User: ${turn.user}`;
    if (selected.length > 0 && totalChars + block.length + 1 > maxTotalChars) {
      break;
    }
    selected.unshift(turn);
    totalChars += block.length + 1;
  }

  const stagedUploads = opts.includeStagedUploads
    ? entries
        .flatMap((e) => e.attachments ?? [])
        .slice(-10)
        .map((a) => `${a.filename} (stagedId=${a.stagedId})`)
    : [];

  const formatted = selected
    .map((t) =>
      t.assistant ? `- User: ${t.user}\n  Halley: ${t.assistant}` : `- User: ${t.user}`,
    )
    .join('\n');

  return { turns: selected, stagedUploads, formatted };
}

function formatDiffSummaryFiles(diffSummary: string | null | undefined): string[] {
  if (!diffSummary || diffSummary === '[]') return [];
  let diffs: unknown;
  try {
    diffs = JSON.parse(diffSummary);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    ignore(err, 'handoff: stored diff summary is not valid JSON; omitting file list', {
      length: diffSummary.length,
    });
    return [];
  }
  if (!Array.isArray(diffs)) {
    ignore(null, 'handoff: stored diff summary is not an array; omitting file list', { type: typeof diffs });
    return [];
  }
  return (diffs as Array<{ path: string; status: string; additions?: number; deletions?: number }>)
    .slice(0, 20)
    .map((d) => {
      const counts =
        typeof d.additions === 'number' || typeof d.deletions === 'number'
          ? `, +${d.additions ?? 0}/-${d.deletions ?? 0}`
          : '';
      return `${d.path} (${d.status}${counts})`;
    });
}

export function buildContinuationHandoffSummary(
  src: Pick<SessionRecord, 'title' | 'status' | 'pr_number' | 'owner_name'>,
  archive: SessionArchiveDto | null,
  priorHandoff?: string | null,
): string {
  const lines: string[] = [];
  if (priorHandoff) {
    lines.push(`Earlier lineage summary: ${priorHandoff.slice(0, 600)}`);
  }
  const statusLabel =
    src.status === 'published'
      ? `published${src.pr_number ? ` as PR #${src.pr_number}` : ''}`
      : src.status === 'merged'
        ? `merged${src.pr_number ? ` as PR #${src.pr_number}` : ''}`
        : 'in-progress draft';
  lines.push(
    `This session continues "${src.title}" (${statusLabel}, edited by ${src.owner_name || 'a teammate'}).`,
  );
  if (src.status === 'published' || src.status === 'merged') {
    lines.push('Those published changes are already live on the main branch.');
  }

  const touched = formatDiffSummaryFiles(archive?.diffSummary);
  if (touched.length > 0) {
    lines.push(`Files touched previously: ${touched.join(', ')}.`);
  }

  if (archive?.transcriptJson) {
    const includeStagedUploads = src.status !== 'published' && src.status !== 'merged';
    const digest = extractTranscriptTurnDigest(archive.transcriptJson, {
      includeStagedUploads,
    });
    if (digest.formatted) {
      lines.push(`Recent conversation from the prior thread:\n${digest.formatted}`);
    }
    if (digest.stagedUploads.length > 0) {
      lines.push(`Staged uploads carried over: ${digest.stagedUploads.join(', ')}.`);
    }
  }

  return lines.join('\n');
}

export interface BuildUndoHandoffInput {
  baseBranch: string;
  targetTitle: string;
  targetShas: string[];
  revertReason: string;
  revertStatus?: 'clean' | 'conflict' | 'nothing_to_undo' | null;
  revertCheckpointSha?: string | null;
  revertedCommits?: RevertedCommitSummaryDto[];
  conflictedFiles?: string[];
  srcSession?: Pick<SessionRecord, 'title' | 'status' | 'pr_number' | 'owner_name'> | null;
  srcArchive?: SessionArchiveDto | null;
  priorHandoff?: string | null;
}

export function buildUndoHandoffSummary(input: BuildUndoHandoffInput): string {
  const lines: string[] = [];
  const primarySha = input.targetShas[0] ?? '';
  const shortShas = input.targetShas.map((s) => s.slice(0, 7)).filter(Boolean);
  const shaList = shortShas.join(', ') || 'unknown';
  const shortPrimary = shortShas[0] || 'HEAD~1';

  lines.push(
    `UNDO DRAFT CONTEXT: This workspace started as an Undo branch reverting published commit${input.targetShas.length === 1 ? '' : 's'} ${shaList} ("${input.targetTitle}").`,
  );

  if (input.revertStatus === 'conflict') {
    const conflictList = (input.conflictedFiles ?? []).join(', ');
    lines.push(
      `Working-tree state: \`git revert\` hit conflicts${conflictList ? ` in: ${conflictList}` : ''}. Inspect conflict state and \`git show ${shortPrimary}\` before editing.`,
    );
  } else {
    const ckptNote = input.revertCheckpointSha
      ? ` at checkpoint ${input.revertCheckpointSha.slice(0, 7)}`
      : '';
    lines.push(
      `Working-tree state: \`git revert\` has ALREADY undone ALL changes from ${shaList} in HEAD${ckptNote}, while \`origin/${input.baseBranch}\` still has the published commit.`,
    );
  }

  lines.push(
    `Partial-undo rule: Because every change from ${shaList} is already removed from the working tree, if the user asks to undo ONLY a specific item (or to keep the other updates from that batch), do NOT assume there is nothing to do when grep finds 0 matches. Inspect \`git show ${shortPrimary}\` (or \`git show ${shortPrimary} -- <path>\`) and re-apply/restore the parts the user wants to keep while leaving the unwanted item undone.`,
  );

  if (input.revertReason.trim()) {
    lines.push(
      `Editor's stated reason when starting this undo (passive background context — only make changes the user asks for in chat): "${input.revertReason.trim()}"`,
    );
  }

  const commits = input.revertedCommits ?? [];
  if (commits.length > 0) {
    for (const cm of commits) {
      const authorPart = cm.author ? ` by ${cm.author}` : '';
      lines.push(`Reverted commit ${cm.shortSha}${authorPart}: ${cm.subject}`);
      if (!input.srcSession && cm.body) {
        lines.push(`Commit description: ${compactText(cm.body, 500)}`);
      }
      if (cm.files.length > 0) {
        const fileSummary = cm.files
          .slice(0, 20)
          .map((f) => `${f.path} (${f.status}, +${f.additions}/-${f.deletions})`)
          .join(', ');
        lines.push(`Files affected in ${cm.shortSha}: ${fileSummary}.`);
      }
    }
    lines.push(`Tip: Run \`git show ${shortPrimary} -- <path>\` if you need exact line-level hunks.`);
  } else {
    const fallbackFiles = formatDiffSummaryFiles(input.srcArchive?.diffSummary);
    if (fallbackFiles.length > 0) {
      lines.push(`Files affected in ${shortPrimary}: ${fallbackFiles.join(', ')}.`);
      lines.push(`Tip: Run \`git show ${shortPrimary} -- <path>\` if you need exact line-level hunks.`);
    }
  }

  if (input.priorHandoff) {
    lines.push(`Earlier lineage summary: ${input.priorHandoff.slice(0, 600)}`);
  }

  if (input.srcSession && input.srcArchive?.transcriptJson) {
    const digest = extractTranscriptTurnDigest(input.srcArchive.transcriptJson, {
      includeStagedUploads: false,
    });
    if (digest.formatted) {
      lines.push(
        `Prior conversation from the reverted session "${input.srcSession.title}" (edited by ${input.srcSession.owner_name || 'a teammate'}):\n${digest.formatted}`,
      );
    }
  }

  return lines.join('\n');
}
