import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CheckpointInfo, GitFileChange } from '@halley/shared';

const execFileAsync = promisify(execFile);

export interface GitIdentity {
  botName: string;
  botEmail: string;
  editorName: string;
  editorEmail: string;
}

async function git(
  cwd: string,
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const res = await execFileAsync('git', args, {
      cwd,
      env: { ...process.env, ...extraEnv },
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

export async function sanitizeProtectedPaths(repoRoot: string): Promise<boolean> {
  const diffCheck = await git(repoRoot, ['status', '--porcelain', '--', '.github']);
  if (!diffCheck.stdout.trim()) return false;

  const headHasGithub = await git(repoRoot, ['cat-file', '-e', 'HEAD:.github']);
  if (headHasGithub.code === 0) {
    await git(repoRoot, ['checkout', 'HEAD', '--', '.github']);
    await git(repoRoot, ['clean', '-fd', '--', '.github']);
  } else {
    await fs.rm(path.join(repoRoot, '.github'), { recursive: true, force: true });
  }
  return true;
}

export async function hasProtectedPathChanges(
  repoRoot: string,
  baseRef: string,
): Promise<string[]> {
  const res = await git(repoRoot, ['diff', '--name-only', `${baseRef}...HEAD`, '--', '.github']);
  const stagedOrUnstaged = await git(repoRoot, ['status', '--porcelain', '--', '.github']);
  const files = new Set<string>();
  for (const line of res.stdout.split(/\r?\n/)) {
    if (line.trim()) files.add(line.trim());
  }
  for (const line of stagedOrUnstaged.stdout.split(/\r?\n/)) {
    const p = line.slice(3).trim();
    if (p) files.add(p);
  }
  return [...files];
}

export async function createCheckpoint(
  repoRoot: string,
  summary: string,
  identity: GitIdentity,
): Promise<CheckpointInfo | null> {
  await sanitizeProtectedPaths(repoRoot);
  const status = await git(repoRoot, ['status', '--porcelain']);
  if (!status.stdout.trim()) return null;

  await git(repoRoot, ['add', '-A']);
  const cleanMsg = summary.replace(/\r?\n/g, ' ').trim() || 'Update website';
  const fullMsg = `halley-checkpoint: ${cleanMsg}\n\nCo-authored-by: ${identity.editorName} <${identity.editorEmail}>`;

  const commit = await git(
    repoRoot,
    [
      '-c',
      `user.name=${identity.botName}`,
      '-c',
      `user.email=${identity.botEmail}`,
      'commit',
      '-m',
      fullMsg,
    ],
  );
  if (commit.code !== 0) return null;

  const head = await git(repoRoot, ['log', '-1', '--format=%H|%h|%s|%aI|%an']);
  const [sha, shortSha, message, timestamp, author] = head.stdout.trim().split('|');
  if (!sha) return null;

  return {
    sha,
    shortSha: shortSha ?? sha.slice(0, 7),
    message: message ?? cleanMsg,
    summary: cleanMsg,
    timestamp: timestamp ?? new Date().toISOString(),
    author: author ?? identity.botName,
  };
}

export async function listCheckpoints(
  repoRoot: string,
  baseSha: string,
): Promise<CheckpointInfo[]> {
  const range = baseSha ? `${baseSha}..HEAD` : '-n 30';
  const args = baseSha
    ? ['log', range, '--format=%H|%h|%s|%aI|%an']
    : ['log', '-n', '30', '--format=%H|%h|%s|%aI|%an'];
  const res = await git(repoRoot, args);
  if (res.code !== 0 || !res.stdout.trim()) return [];

  return res.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const [sha = '', shortSha = '', message = '', timestamp = '', author = ''] = line.split('|');
      const summary = message.replace(/^halley-(?:checkpoint|undo):\s*/i, '');
      return { sha, shortSha, message, summary, timestamp, author };
    })
    .filter((c) => Boolean(c.sha));
}

export async function undoToCheckpoint(
  repoRoot: string,
  targetSha: string,
  identity: GitIdentity,
): Promise<CheckpointInfo | null> {
  // Remove untracked files created after targetSha, then restore tracked files to targetSha
  await git(repoRoot, ['rm', '-rf', '--ignore-unmatch', '.']);
  const checkout = await git(repoRoot, ['checkout', targetSha, '--', '.']);
  if (checkout.code !== 0) {
    throw new Error(`Failed to restore checkpoint ${targetSha}: ${checkout.stderr}`);
  }
  await sanitizeProtectedPaths(repoRoot);
  const shortTarget = targetSha.slice(0, 7);
  return createCheckpoint(repoRoot, `Undo to ${shortTarget}`, identity);
}

export async function getGitChanges(
  repoRoot: string,
  baseRef: string,
): Promise<GitFileChange[]> {
  // Show combined diff of working tree + unmerged commits vs baseRef
  const statusMap = new Map<string, GitFileChange['status']>();
  const diffRes = await git(repoRoot, ['diff', '--name-status', baseRef]);
  for (const line of diffRes.stdout.trim().split(/\r?\n/)) {
    if (!line) continue;
    const [code = 'M', file = ''] = line.split(/\t/);
    if (!file) continue;
    if (code.startsWith('A')) statusMap.set(file, 'added');
    else if (code.startsWith('D')) statusMap.set(file, 'deleted');
    else if (code.startsWith('R')) statusMap.set(file, 'renamed');
    else statusMap.set(file, 'modified');
  }

  const untracked = await git(repoRoot, ['ls-files', '--others', '--exclude-standard']);
  for (const line of untracked.stdout.trim().split(/\r?\n/)) {
    if (line.trim()) statusMap.set(line.trim(), 'untracked');
  }

  const changes: GitFileChange[] = [];
  for (const [filePath, status] of statusMap.entries()) {
    if (status === 'untracked') {
      changes.push({
        path: filePath,
        status,
        additions: 0,
        deletions: 0,
        diff: `New file: ${filePath}`,
      });
      continue;
    }
    const numstat = await git(repoRoot, ['diff', '--numstat', baseRef, '--', filePath]);
    const [addStr = '0', delStr = '0'] = numstat.stdout.trim().split(/\s+/);
    const patch = await git(repoRoot, ['diff', baseRef, '--', filePath]);
    changes.push({
      path: filePath,
      status,
      additions: Number(addStr) || 0,
      deletions: Number(delStr) || 0,
      diff: patch.stdout,
    });
  }
  return changes;
}

export async function revertSingleFile(
  repoRoot: string,
  relPath: string,
  baseRef: string,
  identity: GitIdentity,
): Promise<void> {
  if (relPath.startsWith('.github')) return;
  const inBase = await git(repoRoot, ['cat-file', '-e', `${baseRef}:${relPath}`]);
  if (inBase.code === 0) {
    await git(repoRoot, ['checkout', baseRef, '--', relPath]);
  } else {
    await fs.rm(path.join(repoRoot, relPath), { force: true });
  }
  await createCheckpoint(repoRoot, `Revert ${relPath}`, identity);
}

export interface RebaseOutcome {
  status: 'clean' | 'resolved' | 'conflict';
  conflictedFiles: string[];
  error?: string;
}

export async function rebaseOnBase(
  repoRoot: string,
  opts: {
    baseBranch: string;
    identity: GitIdentity;
    gitEnv?: Record<string, string>;
    onResolveConflict?: (conflictedFiles: string[]) => Promise<boolean>;
  },
): Promise<RebaseOutcome> {
  const fetch = await git(repoRoot, ['fetch', 'origin', opts.baseBranch], opts.gitEnv);
  if (fetch.code !== 0) {
    return { status: 'conflict', conflictedFiles: [], error: `Fetch failed: ${fetch.stderr}` };
  }

  const rebase = await git(
    repoRoot,
    [
      '-c',
      `user.name=${opts.identity.botName}`,
      '-c',
      `user.email=${opts.identity.botEmail}`,
      'rebase',
      `origin/${opts.baseBranch}`,
    ],
    opts.gitEnv,
  );
  if (rebase.code === 0) {
    await sanitizeProtectedPaths(repoRoot);
    return { status: 'clean', conflictedFiles: [] };
  }

  const unmerged = await git(repoRoot, ['diff', '--name-only', '--diff-filter=U']);
  const conflictedFiles = unmerged.stdout.trim().split(/\r?\n/).filter(Boolean);

  if (conflictedFiles.length > 0 && opts.onResolveConflict) {
    const resolved = await opts.onResolveConflict(conflictedFiles);
    if (resolved) {
      await sanitizeProtectedPaths(repoRoot);
      const cont = await git(
        repoRoot,
        ['-c', `user.name=${opts.identity.botName}`, '-c', `user.email=${opts.identity.botEmail}`, 'rebase', '--continue'],
        { ...opts.gitEnv, GIT_EDITOR: 'true' },
      );
      if (cont.code === 0) {
        return { status: 'resolved', conflictedFiles };
      }
    }
  }

  await git(repoRoot, ['rebase', '--abort']);
  return {
    status: 'conflict',
    conflictedFiles,
    error: 'Automatic conflict resolution could not complete cleanly.',
  };
}
