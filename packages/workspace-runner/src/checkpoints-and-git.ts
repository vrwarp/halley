import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CheckpointInfo, GitFileChange, RevertedCommitSummaryDto } from '@halley/shared';

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

const repoGitQueues = new Map<string, Promise<unknown>>();

export function withRepoGitLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(repoRoot);
  const prev = repoGitQueues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  repoGitQueues.set(key, tail);
  void tail.finally(() => {
    if (repoGitQueues.get(key) === tail) {
      repoGitQueues.delete(key);
    }
  });
  return next;
}

export async function hasUnmergedGitState(
  repoRoot: string,
  opts?: { allowActiveRevert?: boolean },
): Promise<boolean> {
  const gitDir = path.join(repoRoot, '.git');
  const markers = opts?.allowActiveRevert ? ['MERGE_HEAD'] : ['MERGE_HEAD', 'REVERT_HEAD'];
  for (const marker of markers) {
    const exists = await fs
      .access(path.join(gitDir, marker))
      .then(() => true)
      .catch(() => false);
    if (exists) return true;
  }
  const unmerged = await git(repoRoot, ['diff', '--name-only', '--diff-filter=U']);
  return Boolean(unmerged.stdout.trim());
}

export async function createCheckpoint(
  repoRoot: string,
  summary: string,
  identity: GitIdentity,
  opts?: { allowActiveRevert?: boolean },
): Promise<CheckpointInfo | null> {
  return withRepoGitLock(repoRoot, async () => {
    // Never stage/commit while a merge or revert has unresolved conflicts (would commit raw <<<<<<< markers)
    if (await hasUnmergedGitState(repoRoot, opts)) {
      return null;
    }
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
  });
}

export async function ensureGitRerere(repoRoot: string): Promise<void> {
  await git(repoRoot, ['config', 'rerere.enabled', 'true']);
  await git(repoRoot, ['config', 'rerere.autoupdate', 'true']);
}

const CONFLICT_MARKER_RE = /^(<{7}(?: |\r?$)|={7}\r?$|>{7}(?: |\r?$))/m;

export async function findFilesWithConflictMarkers(
  repoRoot: string,
  relPaths: string[],
): Promise<string[]> {
  const dirty: string[] = [];
  for (const rel of relPaths) {
    try {
      const buf = await fs.readFile(path.join(repoRoot, rel));
      // Skip binary files (contains NUL byte in first 8KB)
      if (buf.subarray(0, 8192).includes(0)) continue;
      if (CONFLICT_MARKER_RE.test(buf.toString('utf8'))) {
        dirty.push(rel);
      }
    } catch {
      // file may have been deleted as part of resolution
    }
  }
  return dirty;
}

export async function listCheckpoints(
  repoRoot: string,
  baseSha: string,
): Promise<CheckpointInfo[]> {
  // Use --first-parent so upstream commits merged from origin/main never pollute user checkpoints
  const args = baseSha
    ? ['log', '--first-parent', `${baseSha}..HEAD`, '--format=%H|%h|%s|%aI|%an|%P']
    : ['log', '--first-parent', '-n', '30', '--format=%H|%h|%s|%aI|%an|%P'];
  const res = await git(repoRoot, args);
  if (res.code !== 0 || !res.stdout.trim()) return [];

  return res.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const [sha = '', shortSha = '', message = '', timestamp = '', author = '', parents = ''] =
        line.split('|');
      const parentList = parents.trim().split(/\s+/).filter(Boolean);
      const isSyncBoundary =
        parentList.length > 1 || /^halley-sync:/i.test(message);
      const summary = message.replace(/^halley-(?:checkpoint|undo|sync):\s*/i, '');
      return {
        sha,
        shortSha,
        message,
        summary,
        timestamp,
        author,
        ...(isSyncBoundary ? { isSyncBoundary: true } : {}),
      };
    })
    .filter((c) => Boolean(c.sha));
}

export async function undoToCheckpoint(
  repoRoot: string,
  targetSha: string,
  identity: GitIdentity,
): Promise<CheckpointInfo | null> {
  // Check if any first-parent sync merges happened between targetSha and HEAD.
  // If so, preserve the latest merged upstream commit so undoing a pre-sync checkpoint
  // never silently deletes teammates' live changes.
  const syncMerges = await git(repoRoot, [
    'log',
    '--first-parent',
    '--merges',
    '-n',
    '1',
    '--format=%P',
    `${targetSha}..HEAD`,
  ]);
  const latestMergeParents = syncMerges.stdout.trim().split(/\s+/).filter(Boolean);
  const latestUpstreamSha = latestMergeParents.length >= 2 ? latestMergeParents[1]! : null;

  if (latestUpstreamSha) {
    const mergeTree = await git(repoRoot, [
      'merge-tree',
      '--write-tree',
      '--name-only',
      targetSha,
      latestUpstreamSha,
    ]);

    if (mergeTree.code === 0) {
      const treeSha = mergeTree.stdout.trim().split(/\r?\n/)[0]?.trim();
      if (!treeSha) {
        throw new Error(`Failed to compute merged tree when restoring ${targetSha}`);
      }
      const readTree = await git(repoRoot, ['read-tree', '--reset', '-u', treeSha]);
      if (readTree.code !== 0) {
        throw new Error(`Failed to apply restored tree: ${readTree.stderr}`);
      }
      await git(repoRoot, ['clean', '-fd']);
      await sanitizeProtectedPaths(repoRoot);
      const shortTarget = targetSha.slice(0, 7);
      return createCheckpoint(repoRoot, `Undo to ${shortTarget} (kept live updates)`, identity);
    }

    // If re-merging targetSha with latestUpstreamSha conflicts, merge-tree STILL outputs a valid
    // 3-way merged tree on line 1 (with all non-conflicting upstream changes intact, and conflict
    // markers only in conflictedPaths). Apply that tree, then preserve latestUpstreamSha on the
    // colliding files so teammates' live changes aren't wiped and zero markers remain.
    const lines = mergeTree.stdout.trim().split(/\r?\n/);
    const treeSha = lines[0]?.trim();
    const conflictedPaths: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i]?.trim() ?? '';
      if (!l) break;
      conflictedPaths.push(l);
    }
    if (treeSha && /^[0-9a-f]{40}$/i.test(treeSha)) {
      const readTree = await git(repoRoot, ['read-tree', '--reset', '-u', treeSha]);
      if (readTree.code !== 0) {
        throw new Error(`Failed to apply merged tree: ${readTree.stderr}`);
      }
    } else {
      await git(repoRoot, ['rm', '-rf', '--ignore-unmatch', '.']);
      const checkout = await git(repoRoot, ['checkout', targetSha, '--', '.']);
      if (checkout.code !== 0) {
        throw new Error(`Failed to restore checkpoint ${targetSha}: ${checkout.stderr}`);
      }
    }
    for (const p of conflictedPaths) {
      const inUpstream = await git(repoRoot, ['cat-file', '-e', `${latestUpstreamSha}:${p}`]);
      if (inUpstream.code === 0) {
        await git(repoRoot, ['checkout', latestUpstreamSha, '--', p]);
      } else {
        await fs.rm(path.join(repoRoot, p), { force: true });
      }
    }
    await git(repoRoot, ['clean', '-fd']);
    await sanitizeProtectedPaths(repoRoot);
    const shortTarget = targetSha.slice(0, 7);
    return createCheckpoint(repoRoot, `Undo to ${shortTarget} (kept live updates)`, identity);
  }

  // Standard pre-sync undo: remove untracked files created after targetSha, then restore tracked files
  await git(repoRoot, ['rm', '-rf', '--ignore-unmatch', '.']);
  const checkout = await git(repoRoot, ['checkout', targetSha, '--', '.']);
  if (checkout.code !== 0) {
    throw new Error(`Failed to restore checkpoint ${targetSha}: ${checkout.stderr}`);
  }
  await git(repoRoot, ['clean', '-fd']);
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
  newBaseSha?: string;
  prevBaseSha?: string;
  preSyncSha?: string;
  alreadyUpToDate?: boolean;
  error?: string;
}

/**
 * Merges `origin/<baseBranch>` into the current session branch (replacing multi-commit rebase
 * so conflicts are resolved once against the net diff, while PR squash-merge keeps main linear).
 */
export async function mergeWithBase(
  repoRoot: string,
  opts: {
    baseBranch: string;
    identity: GitIdentity;
    gitEnv?: Record<string, string>;
    skipFetch?: boolean;
    onResolveConflict?: (conflictedFiles: string[]) => Promise<boolean>;
  },
): Promise<RebaseOutcome> {
  await ensureGitRerere(repoRoot);

  if (!opts.skipFetch) {
    const fetch = await git(repoRoot, ['fetch', 'origin', opts.baseBranch], opts.gitEnv);
    if (fetch.code !== 0) {
      return { status: 'conflict', conflictedFiles: [], error: `Fetch failed: ${fetch.stderr}` };
    }
  }

  const baseRef = `origin/${opts.baseBranch}`;
  const headRes = await git(repoRoot, ['rev-parse', 'HEAD']);
  const upstreamRes = await git(repoRoot, ['rev-parse', baseRef]);
  const mergeBaseRes = await git(repoRoot, ['merge-base', 'HEAD', baseRef]);
  const preSyncSha = headRes.stdout.trim();
  const newBaseSha = upstreamRes.stdout.trim();
  const prevBaseSha = mergeBaseRes.stdout.trim();

  if (prevBaseSha && newBaseSha && prevBaseSha === newBaseSha) {
    return {
      status: 'clean',
      conflictedFiles: [],
      newBaseSha,
      prevBaseSha,
      preSyncSha,
      alreadyUpToDate: true,
    };
  }

  const merge = await git(
    repoRoot,
    [
      '-c',
      `user.name=${opts.identity.botName}`,
      '-c',
      `user.email=${opts.identity.botEmail}`,
      'merge',
      '--no-ff',
      '-m',
      `halley-sync: Updated from live site (${newBaseSha.slice(0, 7)})`,
      baseRef,
    ],
    opts.gitEnv,
  );

  if (merge.code === 0) {
    return {
      status: 'clean',
      conflictedFiles: [],
      newBaseSha,
      prevBaseSha,
      preSyncSha,
      alreadyUpToDate: false,
    };
  }

  const unmerged = await git(repoRoot, ['diff', '--name-only', '--diff-filter=U']);
  const conflictedFiles = unmerged.stdout.trim().split(/\r?\n/).filter(Boolean);

  if (conflictedFiles.length > 0 && opts.onResolveConflict) {
    const resolved = await opts.onResolveConflict(conflictedFiles);
    if (resolved) {
      // Hard check: verify zero conflict markers remain and no unmerged entries exist
      const remainingMarkers = await findFilesWithConflictMarkers(repoRoot, conflictedFiles);
      const stillUnmerged = await git(repoRoot, ['diff', '--name-only', '--diff-filter=U']);
      const unmergedList = stillUnmerged.stdout.trim().split(/\r?\n/).filter(Boolean);

      if (remainingMarkers.length === 0 && unmergedList.length === 0) {
        const commit = await git(
          repoRoot,
          [
            '-c',
            `user.name=${opts.identity.botName}`,
            '-c',
            `user.email=${opts.identity.botEmail}`,
            'commit',
            '--no-edit',
          ],
          { ...opts.gitEnv, GIT_EDITOR: 'true' },
        );
        if (commit.code === 0) {
          return {
            status: 'resolved',
            conflictedFiles,
            newBaseSha,
            prevBaseSha,
            preSyncSha,
            alreadyUpToDate: false,
          };
        }
      }
    }
  }

  await git(repoRoot, ['merge', '--abort']);
  return {
    status: 'conflict',
    conflictedFiles,
    newBaseSha,
    prevBaseSha,
    preSyncSha,
    error: 'Automatic conflict resolution could not complete cleanly.',
  };
}

/** Backwards-compatible alias for merge-based sync with baseBranch. */
export async function rebaseOnBase(
  repoRoot: string,
  opts: {
    baseBranch: string;
    identity: GitIdentity;
    gitEnv?: Record<string, string>;
    onResolveConflict?: (conflictedFiles: string[]) => Promise<boolean>;
  },
): Promise<RebaseOutcome> {
  return mergeWithBase(repoRoot, opts);
}

function mapGitStatusCode(code: string): 'modified' | 'added' | 'deleted' | 'renamed' {
  const c = code.trim().charAt(0).toUpperCase();
  if (c === 'A') return 'added';
  if (c === 'D') return 'deleted';
  if (c === 'R' || c === 'C') return 'renamed';
  return 'modified';
}

export async function inspectCommitsForRevert(
  repoRoot: string,
  shas: string[],
): Promise<RevertedCommitSummaryDto[]> {
  const summaries: RevertedCommitSummaryDto[] = [];
  for (const rawSha of shas) {
    const metaRes = await git(repoRoot, [
      'show',
      '-s',
      '--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%b',
      rawSha,
    ]);
    if (metaRes.code !== 0 || !metaRes.stdout.trim()) continue;
    const [sha = rawSha, shortSha = rawSha.slice(0, 7), author = '', date = '', subject = '', body = ''] =
      metaRes.stdout.split('\0');

    const statusRes = await git(repoRoot, [
      'diff-tree',
      '--no-commit-id',
      '--name-status',
      '-r',
      '--root',
      sha,
    ]);
    const statusByPath = new Map<string, 'modified' | 'added' | 'deleted' | 'renamed'>();
    for (const line of statusRes.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      const code = parts[0] ?? 'M';
      const filePath = (parts.length >= 3 ? parts[2] : parts[1])?.trim();
      if (filePath) {
        statusByPath.set(filePath, mapGitStatusCode(code));
      }
    }

    const numstatRes = await git(repoRoot, [
      'diff-tree',
      '--no-commit-id',
      '--numstat',
      '-r',
      '--root',
      sha,
    ]);
    const files: RevertedCommitSummaryDto['files'] = [];
    for (const line of numstatRes.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const additions = parts[0] === '-' ? 0 : Number.parseInt(parts[0] ?? '0', 10) || 0;
      const deletions = parts[1] === '-' ? 0 : Number.parseInt(parts[1] ?? '0', 10) || 0;
      const filePath = parts.slice(2).join('\t').trim();
      if (!filePath) continue;
      files.push({
        path: filePath,
        status: statusByPath.get(filePath) ?? 'modified',
        additions,
        deletions,
      });
    }

    summaries.push({
      sha: sha.trim(),
      shortSha: shortSha.trim(),
      author: author.trim(),
      date: date.trim(),
      subject: subject.trim(),
      body: body.trim(),
      files,
    });
  }
  return summaries;
}

/**
 * Starts reverting one or more published commits on top of HEAD using `git revert --no-commit`.
 * Clean reverts are committed as a checkpoint immediately ($0 AI); conflicting reverts leave
 * unmerged index stages so the Conflict Resolution Protocol can inspect :1:/:2:/:3: evidence.
 */
export async function startRevertCommits(
  repoRoot: string,
  shas: string[],
  identity: GitIdentity,
): Promise<{
  status: 'clean' | 'conflict' | 'nothing_to_undo';
  revertCheckpointSha?: string;
  revertedCommits: RevertedCommitSummaryDto[];
  conflictedFiles: string[];
  error?: string;
}> {
  if (shas.length === 0) {
    return { status: 'nothing_to_undo', revertedCommits: [], conflictedFiles: [] };
  }
  await ensureGitRerere(repoRoot);
  const revertedCommits = await inspectCommitsForRevert(repoRoot, shas).catch(() => []);

  const res = await git(repoRoot, ['revert', '--no-commit', ...shas]);
  if (res.code === 0) {
    await sanitizeProtectedPaths(repoRoot);
    const status = await git(repoRoot, ['status', '--porcelain']);
    if (!status.stdout.trim()) {
      return { status: 'nothing_to_undo', revertedCommits, conflictedFiles: [] };
    }
    const ckpt = await createCheckpoint(
      repoRoot,
      `Undo published edit (${shas.map((s) => s.slice(0, 7)).join(', ')})`,
      identity,
      { allowActiveRevert: true },
    );
    return {
      status: 'clean',
      revertCheckpointSha: ckpt?.sha,
      revertedCommits,
      conflictedFiles: [],
    };
  }

  const unmerged = await git(repoRoot, ['diff', '--name-only', '--diff-filter=U']);
  const conflictedFiles = unmerged.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (conflictedFiles.length === 0) {
    await git(repoRoot, ['revert', '--abort']).catch(() => {});
    return {
      status: 'conflict',
      revertedCommits,
      conflictedFiles: [],
      error: res.stderr || 'Could not revert the selected commit.',
    };
  }
  return { status: 'conflict', revertedCommits, conflictedFiles };
}

/** Single-step "Undo update" back to the pre-sync snapshot SHA. */
export async function resetToRef(repoRoot: string, targetSha: string): Promise<boolean> {
  await git(repoRoot, ['merge', '--abort']).catch(() => {});
  await git(repoRoot, ['revert', '--abort']).catch(() => {});
  const res = await git(repoRoot, ['reset', '--hard', targetSha]);
  if (res.code !== 0) return false;
  await git(repoRoot, ['clean', '-fd']);
  return true;
}
