import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
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

async function gitUnlocked(
  cwd: string,
  args: string[],
  extraEnv?: Record<string, string>,
  timeoutMs = 60_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const res = await execFileAsync('git', ['-c', 'safe.directory=*', ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
      maxBuffer: 32 * 1024 * 1024,
      timeout: timeoutMs,
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

const repoGitQueues = new Map<string, Promise<unknown>>();
const heldRepoLocks = new AsyncLocalStorage<Set<string>>();

/**
 * Re-entrant per-repository Git serialization queue (`GitRepoActor`).
 * Prevents concurrent `.git/index.lock` and ref-update races across inline checkpoints,
 * Pi runs, syncs, reverts, and change inspections while allowing nested helpers safely.
 */
export function withRepoGitLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(repoRoot);
  const currentHeld = heldRepoLocks.getStore();
  if (currentHeld?.has(key)) {
    return fn();
  }

  const prev = repoGitQueues.get(key) ?? Promise.resolve();
  const next = prev.then(
    () => {
      const nextHeld = new Set(currentHeld ?? []);
      nextHeld.add(key);
      return heldRepoLocks.run(nextHeld, fn);
    },
    () => {
      const nextHeld = new Set(currentHeld ?? []);
      nextHeld.add(key);
      return heldRepoLocks.run(nextHeld, fn);
    },
  );
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

export async function runLockedGit(
  repoRoot: string,
  args: string[],
  extraEnv?: Record<string, string>,
  timeoutMs = 60_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return withRepoGitLock(repoRoot, () => gitUnlocked(repoRoot, args, extraEnv, timeoutMs));
}

export async function sanitizeProtectedPaths(repoRoot: string): Promise<boolean> {
  return withRepoGitLock(repoRoot, async () => {
    const diffCheck = await gitUnlocked(repoRoot, ['status', '--porcelain', '--', '.github']);
    if (!diffCheck.stdout.trim()) return false;

    const headHasGithub = await gitUnlocked(repoRoot, ['cat-file', '-e', 'HEAD:.github']);
    if (headHasGithub.code === 0) {
      await gitUnlocked(repoRoot, ['checkout', 'HEAD', '--', '.github']);
      await gitUnlocked(repoRoot, ['clean', '-fd', '--', '.github']);
    } else {
      await fs.rm(path.join(repoRoot, '.github'), { recursive: true, force: true });
    }
    return true;
  });
}

export async function hasProtectedPathChanges(
  repoRoot: string,
  baseRef: string,
): Promise<string[]> {
  return withRepoGitLock(repoRoot, async () => {
    const res = await gitUnlocked(repoRoot, ['diff', '--name-only', `${baseRef}...HEAD`, '--', '.github']);
    const stagedOrUnstaged = await gitUnlocked(repoRoot, ['status', '--porcelain', '--', '.github']);
    const files = new Set<string>();
    for (const line of res.stdout.split(/\r?\n/)) {
      if (line.trim()) files.add(line.trim());
    }
    for (const line of stagedOrUnstaged.stdout.split(/\r?\n/)) {
      const p = line.slice(3).trim();
      if (p) files.add(p);
    }
    return [...files];
  });
}

export async function hasUnmergedGitState(
  repoRoot: string,
  opts?: { allowActiveRevert?: boolean },
): Promise<boolean> {
  return withRepoGitLock(repoRoot, async () => {
    const gitDir = path.join(repoRoot, '.git');
    const markers = opts?.allowActiveRevert ? ['MERGE_HEAD'] : ['MERGE_HEAD', 'REVERT_HEAD'];
    for (const marker of markers) {
      const exists = await fs
        .access(path.join(gitDir, marker))
        .then(() => true)
        .catch(() => false);
      if (exists) return true;
    }
    const unmerged = await gitUnlocked(repoRoot, ['diff', '--name-only', '--diff-filter=U']);
    return Boolean(unmerged.stdout.trim());
  });
}

export async function createCheckpoint(
  repoRoot: string,
  summary: string,
  identity: GitIdentity,
  opts?: { allowActiveRevert?: boolean },
): Promise<CheckpointInfo | null> {
  return withRepoGitLock(repoRoot, async () => {
    if (await hasUnmergedGitState(repoRoot, opts)) {
      return null;
    }
    await sanitizeProtectedPaths(repoRoot);
    const status = await gitUnlocked(repoRoot, ['status', '--porcelain']);
    if (!status.stdout.trim()) return null;

    await gitUnlocked(repoRoot, ['add', '-A']);
    const cleanMsg = summary.replace(/\r?\n/g, ' ').trim() || 'Update website';
    const fullMsg = `halley-checkpoint: ${cleanMsg}\n\nCo-authored-by: ${identity.editorName} <${identity.editorEmail}>`;

    const commit = await gitUnlocked(repoRoot, [
      '-c',
      `user.name=${identity.botName}`,
      '-c',
      `user.email=${identity.botEmail}`,
      'commit',
      '-m',
      fullMsg,
    ]);
    if (commit.code !== 0) return null;

    const head = await gitUnlocked(repoRoot, ['log', '-1', '--format=%H|%h|%s|%aI|%an']);
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
  await withRepoGitLock(repoRoot, async () => {
    await gitUnlocked(repoRoot, ['config', 'rerere.enabled', 'true']);
    await gitUnlocked(repoRoot, ['config', 'rerere.autoupdate', 'true']);
  });
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
  return withRepoGitLock(repoRoot, async () => {
    const args = baseSha
      ? ['log', '--first-parent', `${baseSha}..HEAD`, '--format=%H|%h|%s|%aI|%an|%P']
      : ['log', '--first-parent', '-n', '30', '--format=%H|%h|%s|%aI|%an|%P'];
    const res = await gitUnlocked(repoRoot, args);
    if (res.code !== 0 || !res.stdout.trim()) return [];

    return res.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const [sha = '', shortSha = '', message = '', timestamp = '', author = '', parents = ''] =
          line.split('|');
        const parentList = parents.trim().split(/\s+/).filter(Boolean);
        const isSyncBoundary = parentList.length > 1 || /^halley-sync:/i.test(message);
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
  });
}

/**
 * Restores the working tree to `targetSha` atomically via `git read-tree --reset -u`
 * (avoiding destructive `git rm -rf .` which caused Chokidar deletion storms on NAS storage).
 * Preserves merged upstream changes if a sync merge occurred between `targetSha` and `HEAD`.
 */
export async function undoToCheckpoint(
  repoRoot: string,
  targetSha: string,
  identity: GitIdentity,
): Promise<CheckpointInfo | null> {
  return withRepoGitLock(repoRoot, async () => {
    const syncMerges = await gitUnlocked(repoRoot, [
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
      const mergeTree = await gitUnlocked(repoRoot, [
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
        const readTree = await gitUnlocked(repoRoot, ['read-tree', '--reset', '-u', treeSha]);
        if (readTree.code !== 0) {
          throw new Error(`Failed to apply restored tree: ${readTree.stderr}`);
        }
        await gitUnlocked(repoRoot, ['clean', '-fd']);
        await sanitizeProtectedPaths(repoRoot);
        const shortTarget = targetSha.slice(0, 7);
        return createCheckpoint(repoRoot, `Undo to ${shortTarget} (kept live updates)`, identity);
      }

      const lines = mergeTree.stdout.trim().split(/\r?\n/);
      const treeSha = lines[0]?.trim();
      const conflictedPaths: string[] = [];
      for (let i = 1; i < lines.length; i++) {
        const l = lines[i]?.trim() ?? '';
        if (!l) break;
        conflictedPaths.push(l);
      }
      if (treeSha && /^[0-9a-f]{40}$/i.test(treeSha)) {
        const readTree = await gitUnlocked(repoRoot, ['read-tree', '--reset', '-u', treeSha]);
        if (readTree.code !== 0) {
          throw new Error(`Failed to apply merged tree: ${readTree.stderr}`);
        }
      } else {
        const readTree = await gitUnlocked(repoRoot, ['read-tree', '--reset', '-u', `${targetSha}^{tree}`]);
        if (readTree.code !== 0) {
          throw new Error(`Failed to restore checkpoint ${targetSha}: ${readTree.stderr}`);
        }
      }
      for (const p of conflictedPaths) {
        const inUpstream = await gitUnlocked(repoRoot, ['cat-file', '-e', `${latestUpstreamSha}:${p}`]);
        if (inUpstream.code === 0) {
          await gitUnlocked(repoRoot, ['checkout', latestUpstreamSha, '--', p]);
        } else {
          await fs.rm(path.join(repoRoot, p), { force: true });
          await gitUnlocked(repoRoot, ['rm', '-f', '--ignore-unmatch', p]);
        }
      }
      await gitUnlocked(repoRoot, ['clean', '-fd']);
      await sanitizeProtectedPaths(repoRoot);
      const shortTarget = targetSha.slice(0, 7);
      const noteSuffix =
        conflictedPaths.length > 0
          ? ` (kept live updates on ${conflictedPaths.length} overlapping file${conflictedPaths.length === 1 ? '' : 's'})`
          : ' (kept live updates)';
      return createCheckpoint(repoRoot, `Undo to ${shortTarget}${noteSuffix}`, identity);
    }

    // Standard pre-sync undo: atomic read-tree update touches only changed/added/deleted files
    const readTree = await gitUnlocked(repoRoot, ['read-tree', '--reset', '-u', `${targetSha}^{tree}`]);
    if (readTree.code !== 0) {
      throw new Error(`Failed to restore checkpoint ${targetSha}: ${readTree.stderr}`);
    }
    await gitUnlocked(repoRoot, ['clean', '-fd']);
    await sanitizeProtectedPaths(repoRoot);
    const shortTarget = targetSha.slice(0, 7);
    return createCheckpoint(repoRoot, `Undo to ${shortTarget}`, identity);
  });
}

export async function getGitChanges(
  repoRoot: string,
  baseRef: string,
): Promise<GitFileChange[]> {
  return withRepoGitLock(repoRoot, async () => {
    const statusMap = new Map<string, GitFileChange['status']>();
    const diffRes = await gitUnlocked(repoRoot, ['diff', '--name-status', baseRef]);
    for (const line of diffRes.stdout.trim().split(/\r?\n/)) {
      if (!line) continue;
      const [code = 'M', file = ''] = line.split(/\t/);
      if (!file) continue;
      if (code.startsWith('A')) statusMap.set(file, 'added');
      else if (code.startsWith('D')) statusMap.set(file, 'deleted');
      else if (code.startsWith('R')) statusMap.set(file, 'renamed');
      else statusMap.set(file, 'modified');
    }

    const untracked = await gitUnlocked(repoRoot, ['ls-files', '--others', '--exclude-standard']);
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
      const numstat = await gitUnlocked(repoRoot, ['diff', '--numstat', baseRef, '--', filePath]);
      const [addStr = '0', delStr = '0'] = numstat.stdout.trim().split(/\s+/);
      const patch = await gitUnlocked(repoRoot, ['diff', baseRef, '--', filePath]);
      changes.push({
        path: filePath,
        status,
        additions: Number(addStr) || 0,
        deletions: Number(delStr) || 0,
        diff: patch.stdout,
      });
    }
    return changes;
  });
}

export async function revertSingleFile(
  repoRoot: string,
  relPath: string,
  baseRef: string,
  identity: GitIdentity,
): Promise<void> {
  return withRepoGitLock(repoRoot, async () => {
    if (relPath.startsWith('.github')) return;
    const inBase = await gitUnlocked(repoRoot, ['cat-file', '-e', `${baseRef}:${relPath}`]);
    if (inBase.code === 0) {
      await gitUnlocked(repoRoot, ['checkout', baseRef, '--', relPath]);
    } else {
      await fs.rm(path.join(repoRoot, relPath), { force: true });
      await gitUnlocked(repoRoot, ['rm', '-f', '--ignore-unmatch', relPath]);
    }
    await createCheckpoint(repoRoot, `Revert ${relPath}`, identity);
  });
}

export interface VirtualMergeResult {
  status: 'clean' | 'conflict' | 'error';
  alreadyUpToDate?: boolean;
  preSyncSha: string;
  prevBaseSha: string;
  newBaseSha: string;
  mergeCommitSha?: string;
  virtualTreeSha?: string;
  conflictedFiles: string[];
  error?: string;
}

/**
 * Computes a 3-way merge of `origin/<baseBranch>` into `HEAD` purely inside Git's object
 * database via `git merge-tree --write-tree`.
 * - Clean merges create a 2-parent merge commit via `git commit-tree` and atomically update
 *   only changed files via `git read-tree --reset -u`.
 * - Conflicted merges NEVER touch `/workspace` or `.git/MERGE_HEAD`, keeping `astro dev`
 *   100% free of `<<<<<<<` markers while conflicts are resolved!
 */
export async function virtualMergeWithBase(
  repoRoot: string,
  opts: {
    baseBranch: string;
    identity: GitIdentity;
    skipFetch?: boolean;
    fetchAuthBearer?: string;
  },
): Promise<VirtualMergeResult> {
  return withRepoGitLock(repoRoot, async () => {
    await ensureGitRerere(repoRoot);
    await createCheckpoint(repoRoot, 'Before live-site update', opts.identity);

    if (!opts.skipFetch) {
      const fetchArgs = opts.fetchAuthBearer
        ? ['-c', `http.extraHeader=Authorization: Bearer ${opts.fetchAuthBearer}`, 'fetch', 'origin', opts.baseBranch]
        : ['fetch', 'origin', opts.baseBranch];
      const fetched = await gitUnlocked(repoRoot, fetchArgs, undefined, 30_000);
      if (fetched.code !== 0) {
        return {
          status: 'error',
          preSyncSha: '',
          prevBaseSha: '',
          newBaseSha: '',
          conflictedFiles: [],
          error: `Failed to fetch latest live site (${opts.baseBranch}): ${fetched.stderr.trim() || 'git fetch failed'}`,
        };
      }
    }

    const baseRef = `origin/${opts.baseBranch}`;
    const headRes = await gitUnlocked(repoRoot, ['rev-parse', 'HEAD']);
    const upstreamRes = await gitUnlocked(repoRoot, ['rev-parse', baseRef]);
    if (headRes.code !== 0 || upstreamRes.code !== 0) {
      return {
        status: 'error',
        preSyncSha: '',
        prevBaseSha: '',
        newBaseSha: '',
        conflictedFiles: [],
        error: `Could not resolve HEAD or ${baseRef}`,
      };
    }

    const preSyncSha = headRes.stdout.trim();
    const newBaseSha = upstreamRes.stdout.trim();
    const mergeBaseRes = await gitUnlocked(repoRoot, ['merge-base', preSyncSha, newBaseSha]);
    const prevBaseSha = mergeBaseRes.stdout.trim() || preSyncSha;

    if (prevBaseSha === newBaseSha) {
      return {
        status: 'clean',
        alreadyUpToDate: true,
        preSyncSha,
        prevBaseSha,
        newBaseSha,
        conflictedFiles: [],
      };
    }

    const mergeTree = await gitUnlocked(repoRoot, [
      'merge-tree',
      '--write-tree',
      '--name-only',
      preSyncSha,
      newBaseSha,
    ]);

    const outLines = mergeTree.stdout.trim().split(/\r?\n/);
    const treeSha = outLines[0]?.trim() ?? '';

    if (mergeTree.code === 0 && /^[0-9a-f]{40}$/i.test(treeSha)) {
      const commitMsg = `halley-sync: Updated from live site (${newBaseSha.slice(0, 7)})`;
      const commitTree = await gitUnlocked(
        repoRoot,
        ['commit-tree', treeSha, '-p', preSyncSha, '-p', newBaseSha, '-m', commitMsg],
        {
          GIT_AUTHOR_NAME: opts.identity.botName,
          GIT_AUTHOR_EMAIL: opts.identity.botEmail,
          GIT_COMMITTER_NAME: opts.identity.botName,
          GIT_COMMITTER_EMAIL: opts.identity.botEmail,
        },
      );
      const mergeCommitSha = commitTree.stdout.trim();
      if (commitTree.code !== 0 || !/^[0-9a-f]{40}$/i.test(mergeCommitSha)) {
        return {
          status: 'error',
          preSyncSha,
          prevBaseSha,
          newBaseSha,
          conflictedFiles: [],
          error: `Failed to build merge commit: ${commitTree.stderr}`,
        };
      }

      const readRes = await gitUnlocked(repoRoot, ['read-tree', '--reset', '-u', mergeCommitSha]);
      if (readRes.code !== 0) {
        return {
          status: 'error',
          preSyncSha,
          prevBaseSha,
          newBaseSha,
          conflictedFiles: [],
          error: `Failed to update working tree: ${readRes.stderr}`,
        };
      }
      const refRes = await gitUnlocked(repoRoot, ['update-ref', 'HEAD', mergeCommitSha, preSyncSha]);
      if (refRes.code !== 0) {
        return {
          status: 'error',
          preSyncSha,
          prevBaseSha,
          newBaseSha,
          conflictedFiles: [],
          error: `Failed to advance HEAD: ${refRes.stderr}`,
        };
      }
      await gitUnlocked(repoRoot, ['clean', '-fd']);
      await sanitizeProtectedPaths(repoRoot);

      return {
        status: 'clean',
        alreadyUpToDate: false,
        preSyncSha,
        prevBaseSha,
        newBaseSha,
        mergeCommitSha,
        conflictedFiles: [],
      };
    }

    // Conflicted virtual merge: collect conflicted file paths from merge-tree output
    const conflictedFiles: string[] = [];
    for (let i = 1; i < outLines.length; i++) {
      const l = outLines[i]?.trim() ?? '';
      if (!l) break;
      conflictedFiles.push(l);
    }

    if (conflictedFiles.length === 0) {
      return {
        status: 'error',
        preSyncSha,
        prevBaseSha,
        newBaseSha,
        conflictedFiles: [],
        error: mergeTree.stderr.trim() || 'Merge failed unexpectedly',
      };
    }

    return {
      status: 'conflict',
      preSyncSha,
      prevBaseSha,
      newBaseSha,
      virtualTreeSha: /^[0-9a-f]{40}$/i.test(treeSha) ? treeSha : undefined,
      conflictedFiles,
    };
  });
}

/**
 * Builds and commits a resolved virtual merge using an isolated temporary `GIT_INDEX_FILE`
 * so the live working tree is never touched until the complete, validated 2-parent merge
 * commit is ready, then atomically switches `HEAD` and updates only changed files.
 */
export async function commitVirtualMergeResolution(
  repoRoot: string,
  opts: {
    virtualTreeSha?: string;
    preSyncSha: string;
    newBaseSha: string;
    resolvedFiles: Array<{ path: string; content: string | null }>;
    identity: GitIdentity;
    commitMessage?: string;
  },
): Promise<{ ok: true; mergeCommitSha: string } | { ok: false; error: string }> {
  return withRepoGitLock(repoRoot, async () => {
    await createCheckpoint(repoRoot, 'Save edits before applying merge', opts.identity);
    const currentHeadRes = await gitUnlocked(repoRoot, ['rev-parse', 'HEAD']);
    const currentHeadSha = currentHeadRes.stdout.trim();
    if (!currentHeadSha) {
      return { ok: false, error: 'Could not read HEAD' };
    }

    let seedTreeSha = opts.virtualTreeSha;
    if (!seedTreeSha || currentHeadSha !== opts.preSyncSha) {
      const recomputed = await gitUnlocked(repoRoot, [
        'merge-tree',
        '--write-tree',
        '--name-only',
        currentHeadSha,
        opts.newBaseSha,
      ]);
      const candidate = recomputed.stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
      if (!/^[0-9a-f]{40}$/i.test(candidate)) {
        return { ok: false, error: 'Failed to construct base merge tree' };
      }
      seedTreeSha = candidate;
    }

    const tmpIndex = path.join(os.tmpdir(), `halley-vmerge-${crypto.randomUUID()}.index`);
    const idxEnv = { GIT_INDEX_FILE: tmpIndex };

    try {
      const readSeed = await gitUnlocked(repoRoot, ['read-tree', seedTreeSha], idxEnv);
      if (readSeed.code !== 0) {
        return { ok: false, error: `Failed to stage merge tree: ${readSeed.stderr}` };
      }

      for (const item of opts.resolvedFiles) {
        if (item.path === '.github' || item.path.startsWith('.github/')) {
          continue;
        }
        if (item.content === null) {
          await gitUnlocked(repoRoot, ['update-index', '--force-remove', '--', item.path], idxEnv);
          continue;
        }
        if (CONFLICT_MARKER_RE.test(item.content)) {
          return { ok: false, error: `Conflict markers remain in ${item.path}` };
        }
        const tmpBlobFile = path.join(os.tmpdir(), `halley-blob-${crypto.randomUUID()}`);
        try {
          await fs.writeFile(tmpBlobFile, item.content, 'utf8');
          const hashRes = await gitUnlocked(repoRoot, ['hash-object', '-w', tmpBlobFile]);
          const blobSha = hashRes.stdout.trim();
          if (hashRes.code !== 0 || !/^[0-9a-f]{40}$/i.test(blobSha)) {
            return { ok: false, error: `Failed to hash resolved content for ${item.path}` };
          }
          const upd = await gitUnlocked(
            repoRoot,
            ['update-index', '--add', '--cacheinfo', `100644,${blobSha},${item.path}`],
            idxEnv,
          );
          if (upd.code !== 0) {
            return { ok: false, error: `Failed to stage ${item.path}: ${upd.stderr}` };
          }
        } finally {
          await fs.rm(tmpBlobFile, { force: true }).catch(() => {});
        }
      }

      // Ensure .github matches newBaseSha (protected workflows never overridden by draft)
      const baseHasGithub = await gitUnlocked(repoRoot, ['cat-file', '-e', `${opts.newBaseSha}:.github`]);
      await gitUnlocked(repoRoot, ['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', '.github'], idxEnv);
      if (baseHasGithub.code === 0) {
        await gitUnlocked(repoRoot, ['read-tree', '--prefix=.github/', `${opts.newBaseSha}:.github`], idxEnv);
      }

      const writtenTree = await gitUnlocked(repoRoot, ['write-tree'], idxEnv);
      const finalTreeSha = writtenTree.stdout.trim();
      if (writtenTree.code !== 0 || !/^[0-9a-f]{40}$/i.test(finalTreeSha)) {
        return { ok: false, error: `Failed to write resolved tree: ${writtenTree.stderr}` };
      }

      const msg =
        opts.commitMessage || `halley-sync: Updated from live site (${opts.newBaseSha.slice(0, 7)})`;
      const commitRes = await gitUnlocked(
        repoRoot,
        ['commit-tree', finalTreeSha, '-p', currentHeadSha, '-p', opts.newBaseSha, '-m', msg],
        {
          GIT_AUTHOR_NAME: opts.identity.botName,
          GIT_AUTHOR_EMAIL: opts.identity.botEmail,
          GIT_COMMITTER_NAME: opts.identity.botName,
          GIT_COMMITTER_EMAIL: opts.identity.botEmail,
        },
      );
      const mergeCommitSha = commitRes.stdout.trim();
      if (commitRes.code !== 0 || !/^[0-9a-f]{40}$/i.test(mergeCommitSha)) {
        return { ok: false, error: `Failed to create merge commit: ${commitRes.stderr}` };
      }

      const applyTree = await gitUnlocked(repoRoot, ['read-tree', '--reset', '-u', mergeCommitSha]);
      if (applyTree.code !== 0) {
        return { ok: false, error: `Failed to apply merged files: ${applyTree.stderr}` };
      }
      const updHead = await gitUnlocked(repoRoot, ['update-ref', 'HEAD', mergeCommitSha, currentHeadSha]);
      if (updHead.code !== 0) {
        return { ok: false, error: `Failed to update HEAD: ${updHead.stderr}` };
      }
      await gitUnlocked(repoRoot, ['clean', '-fd']);
      return { ok: true, mergeCommitSha };
    } finally {
      await fs.rm(tmpIndex, { force: true }).catch(() => {});
    }
  });
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
  return withRepoGitLock(repoRoot, async () => {
    const vres = await virtualMergeWithBase(repoRoot, {
      baseBranch: opts.baseBranch,
      identity: opts.identity,
      skipFetch: opts.skipFetch,
    });
    if (vres.status === 'clean') {
      return {
        status: 'clean',
        conflictedFiles: [],
        newBaseSha: vres.newBaseSha,
        prevBaseSha: vres.prevBaseSha,
        preSyncSha: vres.preSyncSha,
        alreadyUpToDate: vres.alreadyUpToDate,
      };
    }
    if (vres.status === 'error') {
      return {
        status: 'conflict',
        conflictedFiles: [],
        error: vres.error,
      };
    }

    // Fallback path only used when an explicit onResolveConflict callback expects working-tree markers
    if (vres.conflictedFiles.length > 0 && opts.onResolveConflict) {
      const baseRef = `origin/${opts.baseBranch}`;
      await gitUnlocked(
        repoRoot,
        [
          '-c',
          `user.name=${opts.identity.botName}`,
          '-c',
          `user.email=${opts.identity.botEmail}`,
          'merge',
          '--no-ff',
          '-m',
          `halley-sync: Updated from live site (${vres.newBaseSha.slice(0, 7)})`,
          baseRef,
        ],
        opts.gitEnv,
      );
      const resolved = await opts.onResolveConflict(vres.conflictedFiles);
      if (resolved) {
        const remainingMarkers = await findFilesWithConflictMarkers(repoRoot, vres.conflictedFiles);
        const stillUnmerged = await gitUnlocked(repoRoot, ['diff', '--name-only', '--diff-filter=U']);
        const unmergedList = stillUnmerged.stdout.trim().split(/\r?\n/).filter(Boolean);
        if (remainingMarkers.length === 0 && unmergedList.length === 0) {
          const commit = await gitUnlocked(
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
              conflictedFiles: vres.conflictedFiles,
              newBaseSha: vres.newBaseSha,
              prevBaseSha: vres.prevBaseSha,
              preSyncSha: vres.preSyncSha,
              alreadyUpToDate: false,
            };
          }
        }
      }
      await gitUnlocked(repoRoot, ['merge', '--abort']);
    }

    return {
      status: 'conflict',
      conflictedFiles: vres.conflictedFiles,
      newBaseSha: vres.newBaseSha,
      prevBaseSha: vres.prevBaseSha,
      preSyncSha: vres.preSyncSha,
      error: 'Automatic conflict resolution could not complete cleanly.',
    };
  });
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
  return withRepoGitLock(repoRoot, async () => {
    const summaries: RevertedCommitSummaryDto[] = [];
    for (const rawSha of shas) {
      const metaRes = await gitUnlocked(repoRoot, [
        'show',
        '-s',
        '--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%b',
        rawSha,
      ]);
      if (metaRes.code !== 0 || !metaRes.stdout.trim()) continue;
      const [sha = rawSha, shortSha = rawSha.slice(0, 7), author = '', date = '', subject = '', body = ''] =
        metaRes.stdout.split('\0');

      const statusRes = await gitUnlocked(repoRoot, [
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

      const numstatRes = await gitUnlocked(repoRoot, [
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
  });
}

export async function startRevertCommits(
  repoRoot: string,
  shas: string[],
  identity: GitIdentity,
): Promise<{
  status: 'clean' | 'conflict' | 'nothing_to_undo';
  revertCheckpointSha?: string;
  revertedCommits: RevertedCommitSummaryDto[];
  conflictedFiles: string[];
  virtualTreeSha?: string;
  preRevertSha?: string;
  targetParentSha?: string;
  error?: string;
}> {
  return withRepoGitLock(repoRoot, async () => {
    if (shas.length === 0) {
      return { status: 'nothing_to_undo', revertedCommits: [], conflictedFiles: [] };
    }
    await ensureGitRerere(repoRoot);
    const revertedCommits = await inspectCommitsForRevert(repoRoot, shas).catch(() => []);
    const preRevertSha = (await gitUnlocked(repoRoot, ['rev-parse', 'HEAD'])).stdout.trim();

    // For single-SHA reverts, use non-destructive `git merge-tree --merge-base <sha> HEAD <sha>~1`
    // so conflicting reverts ALSO keep `/workspace` completely clean of `<<<<<<<` markers!
    if (shas.length === 1) {
      const targetSha = shas[0]!;
      const parentRes = await gitUnlocked(repoRoot, ['rev-parse', `${targetSha}^1`]);
      const parentSha = parentRes.stdout.trim();
      if (parentRes.code === 0 && parentSha) {
        const mt = await gitUnlocked(repoRoot, [
          'merge-tree',
          '--write-tree',
          '--name-only',
          `--merge-base=${targetSha}`,
          preRevertSha,
          parentSha,
        ]);
        const lines = mt.stdout.trim().split(/\r?\n/);
        const treeSha = lines[0]?.trim() ?? '';
        if (mt.code === 0 && /^[0-9a-f]{40}$/i.test(treeSha)) {
          const headTree = (await gitUnlocked(repoRoot, ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
          if (treeSha === headTree) {
            return { status: 'nothing_to_undo', revertedCommits, conflictedFiles: [] };
          }
          await gitUnlocked(repoRoot, ['read-tree', '--reset', '-u', treeSha]);
          await gitUnlocked(repoRoot, ['clean', '-fd']);
          await sanitizeProtectedPaths(repoRoot);
          const ckpt = await createCheckpoint(
            repoRoot,
            `Undo published edit (${targetSha.slice(0, 7)})`,
            identity,
          );
          return {
            status: 'clean',
            revertCheckpointSha: ckpt?.sha,
            revertedCommits,
            conflictedFiles: [],
          };
        }
        const conflictedFiles: string[] = [];
        for (let i = 1; i < lines.length; i++) {
          const l = lines[i]?.trim() ?? '';
          if (!l) break;
          conflictedFiles.push(l);
        }
        if (conflictedFiles.length > 0 && /^[0-9a-f]{40}$/i.test(treeSha)) {
          return {
            status: 'conflict',
            revertedCommits,
            conflictedFiles,
            virtualTreeSha: treeSha,
            preRevertSha,
            targetParentSha: parentSha,
          };
        }
      }
    }

    const res = await gitUnlocked(repoRoot, ['revert', '--no-commit', ...shas]);
    if (res.code === 0) {
      await sanitizeProtectedPaths(repoRoot);
      const status = await gitUnlocked(repoRoot, ['status', '--porcelain']);
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

    const unmerged = await gitUnlocked(repoRoot, ['diff', '--name-only', '--diff-filter=U']);
    const conflictedFiles = unmerged.stdout.trim().split(/\r?\n/).filter(Boolean);
    if (conflictedFiles.length === 0) {
      await gitUnlocked(repoRoot, ['revert', '--abort']).catch(() => {});
      return {
        status: 'conflict',
        revertedCommits,
        conflictedFiles: [],
        error: res.stderr || 'Could not revert the selected commit.',
      };
    }
    return { status: 'conflict', revertedCommits, conflictedFiles, preRevertSha };
  });
}

/** Single-step "Undo update" back to the pre-sync snapshot SHA without destructive rm -rf. */
export async function resetToRef(repoRoot: string, targetSha: string): Promise<boolean> {
  return withRepoGitLock(repoRoot, async () => {
    await gitUnlocked(repoRoot, ['merge', '--abort']).catch(() => {});
    await gitUnlocked(repoRoot, ['revert', '--abort']).catch(() => {});
    const readTree = await gitUnlocked(repoRoot, ['read-tree', '--reset', '-u', targetSha]);
    if (readTree.code !== 0) {
      const hard = await gitUnlocked(repoRoot, ['reset', '--hard', targetSha]);
      if (hard.code !== 0) return false;
    } else {
      const upd = await gitUnlocked(repoRoot, ['update-ref', 'HEAD', targetSha]);
      if (upd.code !== 0) return false;
    }
    await gitUnlocked(repoRoot, ['clean', '-fd']);
    return true;
  });
}
