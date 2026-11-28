import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CheckpointInfo, GitFileChange, RevertedCommitSummaryDto } from '@halley/shared';
import { ignore, ignoreCodes, ignoreExpected, isMissingPathError, logger } from './log.js';
import { pathExists } from './fs-util.js';
import { getProcessRunner, processResultError } from './proc.js';
import { realClock, sleep, type Clock } from './clock.js';

/**
 * Clock for the git-lock retry backoff and the stale-lock age check (lock mtime vs `clock.now()`:
 * wall time with the real clock). Process-wide like the ProcessRunner seam; createRunner installs
 * its injected clock and restores the previous one on shutdown.
 */
let gitClock: Clock = realClock;

/** Installs `clock` (null/undefined: the real clock) for git lock handling; returns a restore function. */
export function configureGitClock(clock: Clock | null | undefined): () => void {
  const prev = gitClock;
  gitClock = clock ?? realClock;
  return () => {
    gitClock = prev;
  };
}

/** Delay between retries of a git command that hit a held `.git/*.lock`. */
export const GIT_LOCK_RETRY_DELAY_MS = 300;

export interface GitIdentity {
  botName: string;
  botEmail: string;
  editorName: string;
  editorEmail: string;
}

function normalizeGitIdentity(identity?: Partial<GitIdentity> | null): GitIdentity {
  return {
    botName: identity?.botName?.trim() || 'Halley Bot',
    botEmail: identity?.botEmail?.trim() || 'halley-bot@users.noreply.github.com',
    editorName: identity?.editorName?.trim() || 'Editor',
    editorEmail: identity?.editorEmail?.trim() || 'editor@users.noreply.github.com',
  };
}

/** Thrown when a checkpoint could not be created for a reason other than "nothing to commit". */
export class CheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointError';
  }
}

async function gitUnlocked(
  cwd: string,
  args: string[],
  extraEnv?: Record<string, string>,
  timeoutMs = 60_000,
  maxBuffer = 32 * 1024 * 1024,
): Promise<{ stdout: string; stderr: string; code: number }> {
  // Own process group: a timeout also kills git-remote-https / credential helpers / hooks
  const r = await getProcessRunner().exec('git', ['-c', 'safe.directory=*', ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
    maxBuffer,
    timeoutMs,
    clock: gitClock,
  });
  if (r.code === 0 || r.stderr) return r;
  // no stderr (spawn failure, timeout, killed): synthesize one so callers' messages say why
  return { ...r, stderr: processResultError('git', args, r, { timeoutMs, maxBuffer }).message };
}

const GIT_LOCK_ERROR_RE = /index\.lock|Unable to create '.*\.lock'|another git process seems to be running/i;

/** Age after which a leftover `.git/*.lock` (from a killed git process) is considered stale. */
function staleGitLockMs(): number {
  const raw = Number(process.env.HALLEY_STALE_GIT_LOCK_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10_000;
}

/**
 * Removes `.git/index.lock` / `.git/HEAD.lock` left behind by a git process that was killed
 * (SIGKILL, OOM, container stop). Only called while this process holds the repo git lock, so no
 * git command issued by this runner can own the lock; the age threshold protects git commands
 * started by other processes (agent shell, supervisor fetch/push) which hold it only briefly.
 */
async function clearStaleGitLocks(repoRoot: string, maxAgeMs = staleGitLockMs()): Promise<boolean> {
  let removed = false;
  for (const name of ['index.lock', 'HEAD.lock']) {
    const lockPath = path.join(repoRoot, '.git', name);
    let st: fsSync.Stats;
    try {
      st = await fs.stat(lockPath);
    } catch (err) {
      // no lock file is the common case (runs on every lock acquisition): not logged
      if (!isMissingPathError(err)) ignore(err, 'git: stat lock file', { lockPath });
      continue;
    }
    const ageMs = gitClock.now() - st.mtimeMs;
    if (ageMs < maxAgeMs) continue;
    try {
      await fs.unlink(lockPath);
      removed = true;
      logger.warn('git: removed stale lock file left by a killed git process', {
        repoRoot,
        lock: name,
        ageMs: Math.round(ageMs),
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('git: failed to remove stale lock file', { repoRoot, lock: name, err });
      }
    }
  }
  return removed;
}

/**
 * Runs a mutating git command, retrying briefly when `.git/index.lock` is held (a concurrent git
 * process outside this runner) and clearing the lock once it becomes stale.
 */
async function gitWithLockRetry(
  repoRoot: string,
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  let res = await gitUnlocked(repoRoot, args, extraEnv);
  for (let attempt = 0; attempt < 4 && res.code !== 0 && GIT_LOCK_ERROR_RE.test(res.stderr); attempt++) {
    await sleep(gitClock, GIT_LOCK_RETRY_DELAY_MS);
    await clearStaleGitLocks(repoRoot);
    res = await gitUnlocked(repoRoot, args, extraEnv);
  }
  return res;
}

const repoGitQueues = new Map<string, Promise<unknown>>();
const heldRepoLocks = new AsyncLocalStorage<Set<string>>();

/**
 * Housekeeping done once per outermost repo-lock acquisition (two `stat` calls in the common case):
 * stale lock removal (W3) and completion of an interrupted sync merge (W4).
 */
async function prepareRepoUnderLock(repoRoot: string): Promise<void> {
  try {
    await clearStaleGitLocks(repoRoot);
    const report = await recoverInterruptedSyncUnlocked(repoRoot);
    if (report.action !== 'none') {
      pendingRecoveryReports.set(path.resolve(repoRoot), report);
    }
  } catch (err) {
    ignore(err, 'git: repo housekeeping before lock', { repoRoot });
  }
}

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

  const run = () => {
    const nextHeld = new Set(currentHeld ?? []);
    nextHeld.add(key);
    return heldRepoLocks.run(nextHeld, async () => {
      await prepareRepoUnderLock(key);
      return fn();
    });
  };
  const prev = repoGitQueues.get(key) ?? Promise.resolve();
  const next = prev.then(run, run);
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

/** True when the current async context already holds the repo git lock for `repoRoot`. */
export function holdsRepoGitLock(repoRoot: string): boolean {
  return heldRepoLocks.getStore()?.has(path.resolve(repoRoot)) ?? false;
}

// ---------------------------------------------------------------------------------------------
// W4: sync-merge intent journal
// ---------------------------------------------------------------------------------------------
//
// Applying a merge commit needs two steps: update the index + working tree (`read-tree --reset -u`)
// and move HEAD (`update-ref`). Neither order is crash-safe on its own:
//  - tree first, then HEAD (the order used here): a crash in between leaves the merged tree under
//    the OLD HEAD, and the next checkpoint would commit upstream's changes as a single-parent
//    "user edit", losing the merge parent.
//  - HEAD first, then tree: a crash in between leaves the PRE-sync tree under the merge HEAD, and
//    the next checkpoint would silently commit a revert of upstream's changes. Worse, because
//    the working tree may also hold edits made after the crash, the two cannot be told apart.
// We keep tree-first (the working tree only ever moves forward to the fully-built merge commit,
// which already contains every user change because a checkpoint is taken before the sync) and
// make it recoverable with an fsync'd intent journal written before `read-tree` and removed after
// `update-ref`. Recovery (on runner startup and on every repo-lock acquisition, so before every
// checkpoint): HEAD == preSyncSha -> re-run `read-tree --reset -u merge` (idempotent) and
// `update-ref HEAD merge pre`; HEAD == mergeCommitSha -> both steps finished, drop the journal;
// anything else -> HEAD was moved deliberately afterwards, drop the journal and log.

export interface SyncIntent {
  version: 1;
  kind: 'sync' | 'revert';
  preSyncSha: string;
  mergeCommitSha: string;
  newBaseSha?: string;
  prevBaseSha?: string;
  createdAt: string;
}

export interface SyncRecoveryReport {
  action: 'none' | 'completed' | 'cleared' | 'stale' | 'failed';
  intent?: SyncIntent;
  error?: string;
}

const pendingRecoveryReports = new Map<string, SyncRecoveryReport>();

function syncIntentPath(repoRoot: string): string {
  return path.join(repoRoot, '.git', 'halley-sync-intent.json');
}

async function fsyncDir(dir: string): Promise<void> {
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(dir, 'r');
    await fh.sync();
  } catch (err) {
    // directory fsync is unsupported on some filesystems; the rename is still atomic
    ignoreCodes(err, ['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'], 'git: fsync directory', { dir });
  } finally {
    await fh?.close().catch((e) => ignore(e, 'git: close directory handle after fsync', { dir }));
  }
}

/** Atomically and durably writes the sync intent journal (tmp + fsync + rename + dir fsync). */
export async function writeSyncIntent(
  repoRoot: string,
  intent: Omit<SyncIntent, 'version' | 'createdAt'> & Partial<Pick<SyncIntent, 'createdAt'>>,
): Promise<void> {
  const target = syncIntentPath(repoRoot);
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 6)}`;
  const body: SyncIntent = { version: 1, createdAt: new Date().toISOString(), ...intent };
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(body), 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, target);
  await fsyncDir(path.dirname(target));
}

async function clearSyncIntent(repoRoot: string): Promise<void> {
  await fs.rm(syncIntentPath(repoRoot), { force: true });
  await fsyncDir(path.join(repoRoot, '.git'));
}

export async function readSyncIntent(repoRoot: string): Promise<SyncIntent | null> {
  let raw: string;
  try {
    raw = await fs.readFile(syncIntentPath(repoRoot), 'utf8');
  } catch (err) {
    ignoreCodes(err, ['ENOENT'], 'git: read sync intent journal', { repoRoot });
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SyncIntent>;
    if (
      typeof parsed.preSyncSha === 'string' &&
      typeof parsed.mergeCommitSha === 'string' &&
      /^[0-9a-f]{40}$/i.test(parsed.preSyncSha) &&
      /^[0-9a-f]{40}$/i.test(parsed.mergeCommitSha)
    ) {
      return {
        version: 1,
        kind: parsed.kind === 'revert' ? 'revert' : 'sync',
        preSyncSha: parsed.preSyncSha,
        mergeCommitSha: parsed.mergeCommitSha,
        newBaseSha: parsed.newBaseSha,
        prevBaseSha: parsed.prevBaseSha,
        createdAt: parsed.createdAt ?? '',
      };
    }
  } catch (err) {
    // corrupt (torn writes are impossible with tmp+rename, but be defensive): logged + removed below
    ignore(err, 'git: parse sync intent journal', { repoRoot });
  }
  logger.error('git: unreadable sync intent journal; removing it', { repoRoot });
  await clearSyncIntent(repoRoot).catch((e) => ignore(e, 'git: remove corrupt sync intent'));
  return null;
}

async function recoverInterruptedSyncUnlocked(repoRoot: string): Promise<SyncRecoveryReport> {
  const exists = await pathExists(syncIntentPath(repoRoot), 'git: probe sync intent journal');
  if (!exists) return { action: 'none' };
  const intent = await readSyncIntent(repoRoot);
  if (!intent) return { action: 'none' };
  const head = (await gitUnlocked(repoRoot, ['rev-parse', 'HEAD'])).stdout.trim();
  if (head === intent.mergeCommitSha) {
    // update-ref ran (it only runs after read-tree succeeded): the operation is complete
    await clearSyncIntent(repoRoot);
    logger.info('git: sync intent already applied; cleared journal', { repoRoot, head });
    return { action: 'cleared', intent };
  }
  if (head !== intent.preSyncSha) {
    await clearSyncIntent(repoRoot);
    logger.warn('git: HEAD moved since interrupted sync; discarding stale sync intent', {
      repoRoot,
      head,
      intent,
    });
    return { action: 'stale', intent };
  }
  const exists2 = await gitUnlocked(repoRoot, ['cat-file', '-e', `${intent.mergeCommitSha}^{commit}`]);
  if (exists2.code !== 0) {
    await clearSyncIntent(repoRoot);
    logger.error('git: interrupted sync references a missing merge commit; discarding intent', {
      repoRoot,
      intent,
    });
    return { action: 'stale', intent, error: 'merge commit missing' };
  }
  // Two-way merge preSync -> merge: idempotent whether the crashed read-tree finished or never
  // ran, and it KEEPS working-tree edits to paths the merge does not touch (a one-way
  // `read-tree --reset -u` would overwrite every stat-dirty file).
  let readTree = await gitWithLockRetry(repoRoot, ['read-tree', '-m', '-u', intent.preSyncSha, intent.mergeCommitSha]);
  if (readTree.code !== 0) {
    // Torn working tree (crash mid-checkout) or edits overlapping upstream's changes: pin
    // everything on disk first so the forced re-apply below can never lose data.
    try {
      const pinned = await snapshotViaTempIndex(
        repoRoot,
        normalizeGitIdentity(null),
        'halley-autosave: Working tree before completing an interrupted live-site update',
      );
      await gitUnlocked(repoRoot, ['update-ref', `${AUTOSAVE_REF_PREFIX}${Date.now()}-recovery`, pinned]);
    } catch (err) {
      logger.error('git: could not snapshot working tree before sync recovery; leaving journal', { repoRoot, err });
      return { action: 'failed', intent, error: err instanceof Error ? err.message : String(err) };
    }
    readTree = await gitWithLockRetry(repoRoot, ['read-tree', '--reset', '-u', intent.mergeCommitSha]);
  }
  if (readTree.code !== 0) {
    logger.error('git: failed to re-apply interrupted sync tree', { repoRoot, intent, stderr: readTree.stderr });
    return { action: 'failed', intent, error: readTree.stderr };
  }
  const upd = await gitWithLockRetry(repoRoot, ['update-ref', 'HEAD', intent.mergeCommitSha, intent.preSyncSha]);
  if (upd.code !== 0) {
    logger.error('git: failed to advance HEAD for interrupted sync', { repoRoot, intent, stderr: upd.stderr });
    return { action: 'failed', intent, error: upd.stderr };
  }
  await clearSyncIntent(repoRoot);
  logger.warn('git: completed a sync merge interrupted by a crash', { repoRoot, intent });
  return { action: 'completed', intent };
}

/**
 * Completes (or clears) a sync merge interrupted between `read-tree -u` and `update-ref`.
 * Safe to call any time; runs automatically on every repo-lock acquisition. Returns what was done
 * (including recoveries performed implicitly by an earlier lock acquisition) so the caller can
 * reconcile session metadata such as `baseSha`.
 */
export async function recoverInterruptedSync(repoRoot: string): Promise<SyncRecoveryReport> {
  return withRepoGitLock(repoRoot, async () => {
    const key = path.resolve(repoRoot);
    const earlier = pendingRecoveryReports.get(key);
    pendingRecoveryReports.delete(key);
    const now = await recoverInterruptedSyncUnlocked(repoRoot);
    return now.action !== 'none' ? now : (earlier ?? now);
  });
}

/**
 * Crash-safe application of a prepared merge commit: journal -> read-tree -u -> update-ref -> clear.
 * On a failed step the working tree is rolled back to `preSha` so nothing half-applied remains.
 */
async function applyMergeCommitUnlocked(
  repoRoot: string,
  preSha: string,
  mergeSha: string,
  meta: Pick<SyncIntent, 'kind' | 'newBaseSha' | 'prevBaseSha'>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await writeSyncIntent(repoRoot, { ...meta, preSyncSha: preSha, mergeCommitSha: mergeSha });
  const rollback = async (why: string) => {
    const back = await gitUnlocked(repoRoot, ['read-tree', '--reset', '-u', preSha]);
    if (back.code === 0) {
      await clearSyncIntent(repoRoot).catch((e) => ignore(e, 'git: clear sync intent after rollback'));
    } else {
      // Leave the journal: the next lock acquisition will complete the merge consistently
      logger.error('git: rollback after failed merge apply failed; journal kept for recovery', {
        repoRoot,
        why,
        stderr: back.stderr,
      });
    }
  };
  const readRes = await gitWithLockRetry(repoRoot, ['read-tree', '--reset', '-u', mergeSha]);
  if (readRes.code !== 0) {
    await rollback('read-tree');
    return { ok: false, error: `Failed to update working tree: ${readRes.stderr}` };
  }
  const refRes = await gitWithLockRetry(repoRoot, ['update-ref', 'HEAD', mergeSha, preSha]);
  if (refRes.code !== 0) {
    await rollback('update-ref');
    return { ok: false, error: `Failed to advance HEAD: ${refRes.stderr}` };
  }
  await clearSyncIntent(repoRoot);
  return { ok: true };
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
      if (await pathExists(path.join(gitDir, marker), 'git: probe merge/revert marker')) return true;
    }
    const unmerged = await gitUnlocked(repoRoot, ['diff', '--name-only', '--diff-filter=U']);
    return Boolean(unmerged.stdout.trim());
  });
}

/**
 * Commits all working-tree changes as a checkpoint.
 * - Returns `null` ONLY when there is nothing to commit (or a merge/revert is in progress).
 * - Throws `CheckpointError` when git fails (`add`/`commit` error, unrecoverable lock, interrupted
 *   sync that could not be recovered) so callers can surface the failure instead of silently
 *   dropping every subsequent checkpoint.
 */
export async function createCheckpoint(
  repoRoot: string,
  summary: string,
  identity: GitIdentity,
  opts?: { allowActiveRevert?: boolean },
): Promise<CheckpointInfo | null> {
  return withRepoGitLock(repoRoot, async () => {
    if (await readSyncIntent(repoRoot)) {
      // Never commit an un-advanced merged tree as a plain user edit (W4)
      throw new CheckpointError('An interrupted live-site update could not be recovered; refusing to checkpoint.');
    }
    if (await hasUnmergedGitState(repoRoot, opts)) {
      return null;
    }
    await sanitizeProtectedPaths(repoRoot);
    const status = await gitUnlocked(repoRoot, ['status', '--porcelain']);
    if (status.code !== 0) {
      throw new CheckpointError(`git status failed: ${status.stderr.trim()}`);
    }
    if (!status.stdout.trim()) return null;

    const add = await gitWithLockRetry(repoRoot, ['add', '-A']);
    if (add.code !== 0) {
      logger.error('checkpoint: git add -A failed', { repoRoot, stderr: add.stderr });
      throw new CheckpointError(`git add -A failed: ${add.stderr.trim()}`);
    }
    const id = normalizeGitIdentity(identity);
    const cleanMsg = summary.replace(/\r?\n/g, ' ').trim() || 'Update website';
    const fullMsg = `halley-checkpoint: ${cleanMsg}\n\nCo-authored-by: ${id.editorName} <${id.editorEmail}>`;

    const commit = await gitWithLockRetry(repoRoot, [
      '-c',
      `user.name=${id.botName}`,
      '-c',
      `user.email=${id.botEmail}`,
      'commit',
      '-m',
      fullMsg,
    ]);
    if (commit.code !== 0) {
      if (/nothing (?:added )?to commit|no changes added to commit/i.test(`${commit.stdout}\n${commit.stderr}`)) {
        return null;
      }
      logger.error('checkpoint: git commit failed', { repoRoot, stderr: commit.stderr, stdout: commit.stdout });
      throw new CheckpointError(`git commit failed: ${(commit.stderr || commit.stdout).trim()}`);
    }

    const head = await gitUnlocked(repoRoot, ['log', '-1', '--format=%H|%h|%s|%aI|%an']);
    const [sha, shortSha, message, timestamp, author] = head.stdout.trim().split('|');
    if (!sha) throw new CheckpointError(`Could not read new checkpoint: ${head.stderr.trim()}`);

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

const AUTOSAVE_REF_PREFIX = 'refs/halley/autosave/';
const MAX_AUTOSAVE_REFS = 20;

/**
 * W2: snapshots uncommitted work before a destructive tree operation (undo, restore, reset,
 * revert). Must be called while holding the repo lock (it takes it re-entrantly).
 * - Normal state: an ordinary "Auto-save before …" checkpoint on HEAD, so it shows up in the
 *   user's checkpoint history and can be restored from the UI.
 * - Merge/revert in progress (index cannot be committed): a snapshot commit built in a temporary
 *   index, without touching HEAD or the real index.
 * Either way the commit is also pinned under `refs/halley/autosave/*` so it stays reachable (and is
 * never garbage collected) even after HEAD is moved backwards by a reset.
 * Returns the snapshot SHA, or null when the tree was clean. Throws if the snapshot fails: callers
 * must then abort the destructive operation.
 */
export async function snapshotUncommittedWork(
  repoRoot: string,
  identity: GitIdentity | undefined,
  label: string,
): Promise<string | null> {
  return withRepoGitLock(repoRoot, async () => {
    const status = await gitUnlocked(repoRoot, ['status', '--porcelain', '--untracked-files=all']);
    if (status.code !== 0) {
      throw new CheckpointError(`Cannot inspect uncommitted work before ${label}: ${status.stderr.trim()}`);
    }
    // .github edits are reverted by policy and never part of a user snapshot
    const dirty = status.stdout
      .split(/\r?\n/)
      .filter((l) => l.trim() && !/^.. "?\.github\//.test(l));
    if (dirty.length === 0) return null;

    const id = normalizeGitIdentity(identity);
    let sha: string | null = null;
    if (!(await hasUnmergedGitState(repoRoot))) {
      const ckpt = await createCheckpoint(repoRoot, `Auto-save before ${label}`, id);
      sha = ckpt?.sha ?? null;
    }
    if (!sha) {
      sha = await snapshotViaTempIndex(repoRoot, id, `halley-autosave: Auto-save before ${label}`);
    }
    const refName = `${AUTOSAVE_REF_PREFIX}${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
    const upd = await gitUnlocked(repoRoot, ['update-ref', refName, sha]);
    if (upd.code !== 0) {
      throw new CheckpointError(`Failed to pin auto-save ${sha.slice(0, 7)}: ${upd.stderr.trim()}`);
    }
    logger.info('git: auto-saved uncommitted work before destructive operation', {
      repoRoot,
      label,
      sha,
      ref: refName,
      files: dirty.length,
    });
    await pruneAutosaveRefs(repoRoot).catch((e) => ignore(e, 'git: prune autosave refs'));
    return sha;
  });
}

async function snapshotViaTempIndex(repoRoot: string, id: GitIdentity, message: string): Promise<string> {
  const tmpIndex = path.join(os.tmpdir(), `halley-autosave-${crypto.randomUUID()}.index`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    const headRes = await gitUnlocked(repoRoot, ['rev-parse', '--verify', '-q', 'HEAD']);
    const head = headRes.stdout.trim();
    if (head) {
      const rt = await gitUnlocked(repoRoot, ['read-tree', head], env);
      if (rt.code !== 0) throw new CheckpointError(`auto-save read-tree failed: ${rt.stderr.trim()}`);
    }
    const add = await gitUnlocked(repoRoot, ['add', '-A', '--', '.', ':(exclude).github'], env);
    if (add.code !== 0) throw new CheckpointError(`auto-save add failed: ${add.stderr.trim()}`);
    const wt = await gitUnlocked(repoRoot, ['write-tree'], env);
    const tree = wt.stdout.trim();
    if (wt.code !== 0 || !/^[0-9a-f]{40}$/i.test(tree)) {
      throw new CheckpointError(`auto-save write-tree failed: ${wt.stderr.trim()}`);
    }
    const ct = await gitUnlocked(
      repoRoot,
      ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message],
      {
        GIT_AUTHOR_NAME: id.botName,
        GIT_AUTHOR_EMAIL: id.botEmail,
        GIT_COMMITTER_NAME: id.botName,
        GIT_COMMITTER_EMAIL: id.botEmail,
      },
    );
    const sha = ct.stdout.trim();
    if (ct.code !== 0 || !/^[0-9a-f]{40}$/i.test(sha)) {
      throw new CheckpointError(`auto-save commit-tree failed: ${ct.stderr.trim()}`);
    }
    return sha;
  } finally {
    await fs.rm(tmpIndex, { force: true }).catch((e) => ignore(e, 'git: remove temporary index', { tmpIndex }));
  }
}

async function pruneAutosaveRefs(repoRoot: string): Promise<void> {
  const res = await gitUnlocked(repoRoot, [
    'for-each-ref',
    '--sort=-refname',
    '--format=%(refname)',
    AUTOSAVE_REF_PREFIX,
  ]);
  const refs = res.stdout.split(/\r?\n/).filter(Boolean);
  for (const ref of refs.slice(MAX_AUTOSAVE_REFS)) {
    await gitUnlocked(repoRoot, ['update-ref', '-d', ref]);
  }
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
    } catch (err) {
      // file may have been deleted as part of resolution
      ignoreCodes(err, ['ENOENT', 'EISDIR'], 'git: scan file for conflict markers', { rel });
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
    // W2: pending inline edits / new files must survive the destructive read-tree + clean below
    await snapshotUncommittedWork(repoRoot, identity, `undo to ${targetSha.slice(0, 7)}`);
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

/** Splits `git diff -z --name-status` output into (status, path) where renames/copies report the OLD path. */
function parseNameStatusZ(out: string): Array<{ code: string; file: string }> {
  const parts = out.split('\0');
  const res: Array<{ code: string; file: string }> = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++] ?? '';
    if (!code) continue;
    const first = parts[i++] ?? '';
    if (code.startsWith('R') || code.startsWith('C')) i++; // skip the new path
    if (first) res.push({ code, file: first });
  }
  return res;
}

/** Parses `git diff -z --numstat --no-renames` into ordered (path, additions, deletions). */
function parseNumstatZ(out: string): Array<{ file: string; add: number; del: number }> {
  const res: Array<{ file: string; add: number; del: number }> = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const t1 = rec.indexOf('\t');
    const t2 = t1 === -1 ? -1 : rec.indexOf('\t', t1 + 1);
    if (t2 === -1) continue;
    res.push({
      add: Number(rec.slice(0, t1)) || 0, // binary files report "-"
      del: Number(rec.slice(t1 + 1, t2)) || 0,
      file: rec.slice(t2 + 1),
    });
  }
  return res;
}

/** Splits a full `git diff` patch into per-file sections (each starts with `diff --git `). */
function splitPatchSections(patch: string): string[] {
  const sections: string[] = [];
  if (!patch) return sections;
  const starts: number[] = [];
  if (patch.startsWith('diff --git ')) starts.push(0);
  let idx = patch.indexOf('\ndiff --git ');
  while (idx !== -1) {
    starts.push(idx + 1);
    idx = patch.indexOf('\ndiff --git ', idx + 1);
  }
  for (let i = 0; i < starts.length; i++) {
    sections.push(patch.slice(starts[i]!, i + 1 < starts.length ? starts[i + 1]! : patch.length));
  }
  return sections;
}

// Read-only inspections must not take `.git/index.lock` (they would make concurrent mutating git
// commands, e.g. the agent's `git add`, fail); the first `diff` still refreshes the index.
const READ_ONLY_GIT_ENV = { GIT_OPTIONAL_LOCKS: '0' };

/**
 * Lists the working tree's changes relative to `baseRef` with per-file stats and patches.
 *
 * W5: uses a constant number of git processes (name-status, untracked, numstat, patch) regardless
 * of how many files changed, instead of two per file. Output is identical to the former per-file
 * implementation (`git diff --numstat|patch baseRef -- <file>`): per-path stats and patches are
 * computed with rename detection off, exactly like single-path invocations, while statuses still
 * come from the rename-aware `--name-status` (renames report the old path as `renamed`).
 */
export async function getGitChanges(
  repoRoot: string,
  baseRef: string,
): Promise<GitFileChange[]> {
  return withRepoGitLock(repoRoot, async () => {
    const [diffRes, untracked] = await Promise.all([
      gitUnlocked(repoRoot, ['diff', '-z', '--name-status', baseRef]),
      gitUnlocked(repoRoot, ['ls-files', '-z', '--others', '--exclude-standard'], READ_ONLY_GIT_ENV),
    ]);
    const statusMap = new Map<string, GitFileChange['status']>();
    if (diffRes.code === 0) {
      for (const { code, file } of parseNameStatusZ(diffRes.stdout)) {
        if (code.startsWith('A')) statusMap.set(file, 'added');
        else if (code.startsWith('D')) statusMap.set(file, 'deleted');
        else if (code.startsWith('R')) statusMap.set(file, 'renamed');
        else statusMap.set(file, 'modified');
      }
    }
    for (const file of untracked.stdout.split('\0')) {
      if (file.trim()) statusMap.set(file.trim(), 'untracked');
    }

    const tracked = [...statusMap.values()].some((st) => st !== 'untracked');
    const stats = new Map<string, { add: number; del: number; diff: string }>();
    if (tracked) {
      const [numstatRes, patchRes] = await Promise.all([
        gitUnlocked(repoRoot, ['diff', '-z', '--numstat', '--no-renames', baseRef], READ_ONLY_GIT_ENV),
        gitUnlocked(repoRoot, ['diff', '--no-renames', baseRef], READ_ONLY_GIT_ENV, 60_000, 256 * 1024 * 1024),
      ]);
      const nums = parseNumstatZ(numstatRes.stdout);
      const sections = splitPatchSections(patchRes.stdout);
      if (numstatRes.code === 0 && patchRes.code === 0 && nums.length === sections.length) {
        nums.forEach((n, i) => stats.set(n.file, { add: n.add, del: n.del, diff: sections[i]! }));
      } else {
        // Unusual diff shapes (typechanges split into two sections, unmerged entries, >256MB):
        // fall back to exact per-file invocations only for this call.
        logger.warn('git: getGitChanges batched diff mismatch; falling back to per-file diffs', {
          repoRoot,
          numstat: nums.length,
          sections: sections.length,
        });
        for (const [filePath, status] of statusMap) {
          if (status === 'untracked') continue;
          const numstat = await gitUnlocked(repoRoot, ['diff', '--numstat', baseRef, '--', filePath], READ_ONLY_GIT_ENV);
          const [addStr = '0', delStr = '0'] = numstat.stdout.trim().split(/\s+/);
          const patch = await gitUnlocked(repoRoot, ['diff', baseRef, '--', filePath], READ_ONLY_GIT_ENV);
          stats.set(filePath, { add: Number(addStr) || 0, del: Number(delStr) || 0, diff: patch.stdout });
        }
      }
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
      const st = stats.get(filePath);
      changes.push({
        path: filePath,
        status,
        additions: st?.add ?? 0,
        deletions: st?.del ?? 0,
        diff: st?.diff ?? '',
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
    await snapshotUncommittedWork(repoRoot, identity, `reverting ${relPath}`);
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
      const id = normalizeGitIdentity(opts.identity);
      const commitMsg = `halley-sync: Updated from live site (${newBaseSha.slice(0, 7)})`;
      const commitTree = await gitUnlocked(
        repoRoot,
        ['commit-tree', treeSha, '-p', preSyncSha, '-p', newBaseSha, '-m', commitMsg],
        {
          GIT_AUTHOR_NAME: id.botName,
          GIT_AUTHOR_EMAIL: id.botEmail,
          GIT_COMMITTER_NAME: id.botName,
          GIT_COMMITTER_EMAIL: id.botEmail,
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

      const applied = await applyMergeCommitUnlocked(repoRoot, preSyncSha, mergeCommitSha, {
        kind: 'sync',
        newBaseSha,
        prevBaseSha,
      });
      if (!applied.ok) {
        return {
          status: 'error',
          preSyncSha,
          prevBaseSha,
          newBaseSha,
          conflictedFiles: [],
          error: applied.error,
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
    /** Recorded in the crash-recovery journal so a resumed runner knows whether baseSha moved. */
    intentKind?: 'sync' | 'revert';
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
          await fs
            .rm(tmpBlobFile, { force: true })
            .catch((e) => ignore(e, 'git: remove temporary blob file', { tmpBlobFile }));
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

      const id = normalizeGitIdentity(opts.identity);
      const msg =
        opts.commitMessage || `halley-sync: Updated from live site (${opts.newBaseSha.slice(0, 7)})`;
      const commitRes = await gitUnlocked(
        repoRoot,
        ['commit-tree', finalTreeSha, '-p', currentHeadSha, '-p', opts.newBaseSha, '-m', msg],
        {
          GIT_AUTHOR_NAME: id.botName,
          GIT_AUTHOR_EMAIL: id.botEmail,
          GIT_COMMITTER_NAME: id.botName,
          GIT_COMMITTER_EMAIL: id.botEmail,
        },
      );
      const mergeCommitSha = commitRes.stdout.trim();
      if (commitRes.code !== 0 || !/^[0-9a-f]{40}$/i.test(mergeCommitSha)) {
        return { ok: false, error: `Failed to create merge commit: ${commitRes.stderr}` };
      }

      const applied = await applyMergeCommitUnlocked(repoRoot, currentHeadSha, mergeCommitSha, {
        kind: opts.intentKind ?? 'sync',
        newBaseSha: opts.newBaseSha,
      });
      if (!applied.ok) {
        return { ok: false, error: applied.error };
      }
      await gitUnlocked(repoRoot, ['clean', '-fd']);
      return { ok: true, mergeCommitSha };
    } finally {
      await fs.rm(tmpIndex, { force: true }).catch((e) => ignore(e, 'git: remove temporary index', { tmpIndex }));
    }
  });
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
    // W2: `read-tree --reset -u` / `revert --no-commit` below would discard or absorb pending edits
    await snapshotUncommittedWork(repoRoot, identity, 'undoing a published edit');
    const revertedCommits = await inspectCommitsForRevert(repoRoot, shas).catch((e) => {
      ignore(e, 'git: inspect commits for revert', { repoRoot });
      return [];
    });
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
          const applied = await gitWithLockRetry(repoRoot, ['read-tree', '--reset', '-u', treeSha]);
          if (applied.code !== 0) {
            logger.error('git: failed to apply revert tree', { repoRoot, stderr: applied.stderr });
            return {
              status: 'conflict',
              revertedCommits,
              conflictedFiles: [],
              error: `Failed to apply undo: ${applied.stderr.trim()}`,
            };
          }
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
      // gitUnlocked never rejects (it returns a code); a failing abort is reported via the result
      const abort = await gitUnlocked(repoRoot, ['revert', '--abort']);
      if (abort.code !== 0) ignoreExpected(abort.stderr, 'git: revert --abort (no revert in progress)', { repoRoot });
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

/**
 * Single-step "Undo update" back to the pre-sync snapshot SHA without destructive rm -rf.
 * Uncommitted work (and any in-progress merge/revert state) is auto-saved first under
 * `refs/halley/autosave/*`, because HEAD moves backwards and nothing else would reference it.
 */
export async function resetToRef(
  repoRoot: string,
  targetSha: string,
  identity?: GitIdentity,
): Promise<boolean> {
  return withRepoGitLock(repoRoot, async () => {
    await snapshotUncommittedWork(repoRoot, identity, `restoring ${targetSha.slice(0, 7)}`);
    await gitUnlocked(repoRoot, ['merge', '--abort']);
    await gitUnlocked(repoRoot, ['revert', '--abort']);
    const readTree = await gitWithLockRetry(repoRoot, ['read-tree', '--reset', '-u', targetSha]);
    if (readTree.code !== 0) {
      const hard = await gitWithLockRetry(repoRoot, ['reset', '--hard', targetSha]);
      if (hard.code !== 0) {
        logger.error('git: resetToRef failed', { repoRoot, targetSha, stderr: hard.stderr });
        return false;
      }
    } else {
      const upd = await gitWithLockRetry(repoRoot, ['update-ref', 'HEAD', targetSha]);
      if (upd.code !== 0) {
        logger.error('git: resetToRef update-ref failed', { repoRoot, targetSha, stderr: upd.stderr });
        return false;
      }
    }
    await gitUnlocked(repoRoot, ['clean', '-fd']);
    return true;
  });
}

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;
const SAFE_BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+(?<!\.lock)(?<![/.])$/;

export class GitRemoteError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 502,
  ) {
    super(message);
    this.name = 'GitRemoteError';
  }
}

function authArgs(authBearer?: string): string[] {
  return authBearer ? ['-c', `http.extraHeader=Authorization: Bearer ${authBearer}`] : [];
}

/**
 * `git fetch origin <baseBranch>` under the repo lock (never races checkpoints / syncs of this
 * process). Used by the runner's `/internal/git/fetch` and by the supervisor when no runner is up.
 */
export async function fetchBaseBranchLocked(
  repoRoot: string,
  opts: { baseBranch: string; remoteUrl?: string; authBearer?: string; timeoutMs?: number },
): Promise<void> {
  if (!SAFE_BRANCH_RE.test(opts.baseBranch)) throw new GitRemoteError(`Invalid branch name: ${opts.baseBranch}`, 400);
  await withRepoGitLock(repoRoot, async () => {
    if (opts.remoteUrl) {
      const set = await gitUnlocked(repoRoot, ['remote', 'set-url', 'origin', opts.remoteUrl]);
      if (set.code !== 0) ignore(set.stderr, 'git: set origin url before fetch', { repoRoot });
    }
    const res = await gitUnlocked(
      repoRoot,
      [...authArgs(opts.authBearer), 'fetch', 'origin', opts.baseBranch],
      undefined,
      opts.timeoutMs ?? 120_000,
    );
    if (res.code !== 0) throw new GitRemoteError(`git fetch failed: ${res.stderr.trim().slice(0, 2000)}`, 502);
  });
}

/**
 * Force-pushes exactly one commit to `refs/heads/<branch>` under the repo lock: `sha` when given
 * (must exist locally), otherwise HEAD resolved once up front, so a checkpoint landing mid-push can
 * never change what is published. Returns the pushed sha.
 */
export async function pushCommitLocked(
  repoRoot: string,
  opts: { branch: string; sha?: string; remoteUrl?: string; authBearer?: string; timeoutMs?: number },
): Promise<{ pushedSha: string }> {
  if (!SAFE_BRANCH_RE.test(opts.branch)) throw new GitRemoteError(`Invalid branch name: ${opts.branch}`, 400);
  if (opts.sha !== undefined && !SHA_RE.test(opts.sha)) {
    throw new GitRemoteError(`Invalid sha: ${String(opts.sha).slice(0, 80)}`, 400);
  }
  return withRepoGitLock(repoRoot, async () => {
    let target: string;
    if (opts.sha) {
      const exists = await gitUnlocked(repoRoot, ['cat-file', '-e', `${opts.sha}^{commit}`]);
      if (exists.code !== 0) throw new GitRemoteError(`Commit ${opts.sha} does not exist in the session repository`, 409);
      target = opts.sha.toLowerCase();
    } else {
      const head = await gitUnlocked(repoRoot, ['rev-parse', 'HEAD']);
      target = head.stdout.trim();
      if (head.code !== 0 || !SHA_RE.test(target)) {
        throw new GitRemoteError(`Cannot resolve HEAD: ${head.stderr.trim().slice(0, 500)}`, 404);
      }
    }
    if (opts.remoteUrl) {
      const set = await gitUnlocked(repoRoot, ['remote', 'set-url', 'origin', opts.remoteUrl]);
      if (set.code !== 0) ignore(set.stderr, 'git: set origin url before push', { repoRoot });
    }
    const res = await gitUnlocked(
      repoRoot,
      [...authArgs(opts.authBearer), 'push', '--force', 'origin', `${target}:refs/heads/${opts.branch}`],
      undefined,
      opts.timeoutMs ?? 120_000,
    );
    if (res.code !== 0) throw new GitRemoteError(`git push failed: ${res.stderr.trim().slice(0, 2000)}`, 502);
    return { pushedSha: target };
  });
}
