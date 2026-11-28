import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AstroAuditReportDto, BootProgressDto } from '@halley/shared';
import { realClock, type Clock } from '../clock.js';
import type { SessionRecord } from '../db.js';
import { ignore } from '../log.js';

const execFileAsync = promisify(execFile);

export interface WorkspaceEndpoint {
  runnerUrl: string;
  astroUrl: string;
  astroBase: string;
  baseSha: string;
}

export interface WarmReservation {
  id: string;
  volumeName: string;
  rawToken: string;
  adoptedWarming: boolean;
}

export interface WarmPoolStatus {
  enabled: boolean;
  target: number;
  ready: number;
  warming: number;
}

export type BootProgressListener = (sessionId: string, progress: BootProgressDto) => void;

export type DuplicateMode = 'branch-off' | 'fresh-from-main';

export interface WorkspaceCrashInfo {
  crashLoop: boolean;
  oom: boolean;
  failureCount: number;
  lastError?: string;
  retryAfterSec?: number;
}

export class WorkspaceCrashLoopError extends Error {
  readonly crashLoop = true;
  readonly oom: boolean;
  readonly retryAfterSec: number;
  readonly failureCount: number;
  readonly lastError: string;

  constructor(opts: {
    oom: boolean;
    retryAfterSec: number;
    failureCount: number;
    lastError: string;
  }) {
    const prefix = opts.oom
      ? 'Workspace ran out of memory (OOM) repeatedly and was paused to prevent a crash loop.'
      : 'Workspace crashed repeatedly and was paused to prevent a crash loop.';
    super(`${prefix} ${opts.lastError}`.trim());
    this.name = 'WorkspaceCrashLoopError';
    this.oom = opts.oom;
    this.retryAfterSec = opts.retryAfterSec;
    this.failureCount = opts.failureCount;
    this.lastError = opts.lastError;
  }
}

interface CrashRecord {
  failures: number[];
  openCount: number;
  openUntil: number;
  lastError: string;
  oom: boolean;
}

/** Durable backing store for CrashLoopTracker (ControlPlaneDb implements it), so a restart can't re-arm a loop. */
export interface CrashLoopStore {
  listCrashLoopRecords(): Array<{ sessionId: string; record: CrashRecord }>;
  saveCrashLoopRecord(sessionId: string, record: CrashRecord): void;
  deleteCrashLoopRecord(sessionId: string): void;
}

const DEFAULT_CRASH_WINDOW_MS = 10 * 60_000;
const DEFAULT_CRASH_THRESHOLD = 3;
const DEFAULT_COOLDOWNS_MS = [60_000, 120_000, 300_000];

export class CrashLoopTracker {
  private records = new Map<string, CrashRecord>();
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly cooldownsMs: number[];
  private readonly clock: Clock;

  private readonly store: CrashLoopStore | null;

  /**
   * With `store`, state is loaded once at construction and written through on every change; reads
   * stay in memory (assertCanAttempt is on the boot path).
   */
  constructor(opts?: {
    threshold?: number;
    windowMs?: number;
    cooldownsMs?: number[];
    clock?: Clock;
    store?: CrashLoopStore;
  }) {
    this.clock = opts?.clock ?? realClock;
    this.threshold = opts?.threshold ?? DEFAULT_CRASH_THRESHOLD;
    this.windowMs = opts?.windowMs ?? DEFAULT_CRASH_WINDOW_MS;
    this.cooldownsMs = opts?.cooldownsMs ?? DEFAULT_COOLDOWNS_MS;
    this.store = opts?.store ?? null;
    if (this.store) {
      const now = this.clock.now();
      for (const { sessionId, record } of this.store.listCrashLoopRecords()) {
        // Drop rows that no longer matter (no recent failure, breaker closed)
        const recent = record.failures.some((ts) => now - ts < this.windowMs);
        if (!recent && record.openUntil <= now) this.store.deleteCrashLoopRecord(sessionId);
        else this.records.set(sessionId, record);
      }
    }
  }

  assertCanAttempt(sessionId: string, now = this.clock.now()): void {
    const rec = this.records.get(sessionId);
    if (!rec) return;
    if (rec.openUntil > now) {
      const retryAfterSec = Math.max(1, Math.ceil((rec.openUntil - now) / 1000));
      throw new WorkspaceCrashLoopError({
        oom: rec.oom,
        retryAfterSec,
        failureCount: rec.failures.length,
        lastError: rec.lastError,
      });
    }
  }

  recordFailure(
    sessionId: string,
    error: string,
    opts?: { oom?: boolean; now?: number },
  ): WorkspaceCrashInfo {
    const now = opts?.now ?? this.clock.now();
    const prev = this.records.get(sessionId) ?? {
      failures: [],
      openCount: 0,
      openUntil: 0,
      lastError: '',
      oom: false,
    };
    const failures = prev.failures.filter((ts) => now - ts < this.windowMs);
    failures.push(now);
    const oom = Boolean(opts?.oom) || prev.oom;

    let openCount = prev.openCount;
    let openUntil = prev.openUntil;
    if (failures.length >= this.threshold) {
      const cooldown =
        this.cooldownsMs[Math.min(openCount, this.cooldownsMs.length - 1)] ?? 300_000;
      openUntil = now + cooldown;
      openCount += 1;
    }

    const updated: CrashRecord = {
      failures,
      openCount,
      openUntil,
      lastError: error,
      oom,
    };
    this.records.set(sessionId, updated);
    this.store?.saveCrashLoopRecord(sessionId, updated);
    return this.getInfo(sessionId, now)!;
  }

  recordSuccess(sessionId: string): void {
    this.forget(sessionId);
  }

  reset(sessionId: string): void {
    this.forget(sessionId);
  }

  private forget(sessionId: string): void {
    // Only touch the store when there was state: a boot success must not cost a write
    if (this.records.delete(sessionId)) this.store?.deleteCrashLoopRecord(sessionId);
  }

  getInfo(sessionId: string, now = this.clock.now()): WorkspaceCrashInfo | null {
    const rec = this.records.get(sessionId);
    if (!rec) return null;
    const recent = rec.failures.filter((ts) => now - ts < this.windowMs);
    const isOpen = rec.openUntil > now;
    if (recent.length === 0 && !isOpen) return null;
    return {
      crashLoop: isOpen,
      oom: rec.oom,
      failureCount: recent.length,
      lastError: rec.lastError,
      retryAfterSec: isOpen ? Math.max(1, Math.ceil((rec.openUntil - now) / 1000)) : undefined,
    };
  }
}

export interface DoctorCheckResult {
  ok: boolean;
  warnings: string[];
  errors: string[];
  details: Record<string, unknown>;
}

export interface WorkspaceDriver {
  setRawWorkspaceToken?(sessionId: string, token: string): void;
  ensureRunning(session: SessionRecord): Promise<WorkspaceEndpoint>;
  stop(session: SessionRecord): Promise<void>;
  destroy(session: SessionRecord): Promise<void>;
  restart?(session: SessionRecord): Promise<WorkspaceEndpoint>;
  pruneNodeModules?(session: SessionRecord): Promise<void>;
  duplicateWorkspace(
    source: SessionRecord,
    target: SessionRecord,
    mode?: DuplicateMode,
  ): Promise<void>;
  /**
   * Pushes the session branch to GitHub. With `opts.sha`, exactly that (verified) commit must be
   * what lands on the branch; implementations fail closed otherwise.
   */
  pushSessionBranch(session: SessionRecord, token: string, opts?: { sha?: string }): Promise<void>;
  fetchIntoSession(session: SessionRecord, token: string): Promise<void>;
  setBootProgressListener?(listener: BootProgressListener): void;
  getBootProgress?(sessionId: string): BootProgressDto | null;
  getCrashInfo?(sessionId: string): WorkspaceCrashInfo | null;
  getSessionLogs?(sessionId: string): Promise<string[]>;
  runDoctorChecks?(): Promise<DoctorCheckResult>;
  reconcileSessions?(): Promise<void>;
  /** Readiness of the workspaces supervisor (cached, single-flight); absent → not checked. */
  getSupervisorReadiness?(): Promise<{ ok: boolean; error?: string; ageMs?: number }>;
  startWarmPool?(): void;
  stopWarmPool?(): Promise<void>;
  reserveWarmWorkspace?(): Promise<WarmReservation | null> | WarmReservation | null;
  releaseWarmWorkspace?(id: string): Promise<void>;
  getWarmPoolStatus?(): WarmPoolStatus;
  touchSession?(sessionId: string): void;
  notifyMirrorUpdated?(baseBranch: string): void;
  deferSpeculativeBuilds?(durationMs: number): void;
  isSessionAstroReady?(sessionId: string): boolean;
  scanRepository?(baseBranch: string): Promise<{
    sha: string;
    report: AstroAuditReportDto;
    digest: string;
  }>;
  close?(): Promise<void>;
}

/**
 * Creates a transient GIT_ASKPASS script for a single git command and deletes it immediately after.
 * Credentials are never written to .git/config or container env.
 */
export async function withGitAskPass<T>(
  token: string,
  fn: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const scriptPath = path.join(
    os.tmpdir(),
    `halley-askpass-${process.pid}-${crypto.randomUUID()}.sh`,
  );
  const script = `#!/bin/sh
case "$1" in
  *Username*) echo "x-access-token" ;;
  *) echo "$HALLEY_GIT_TOKEN" ;;
esac
`;
  await fs.writeFile(scriptPath, script, { mode: 0o700 });
  try {
    return await fn({
      GIT_ASKPASS: scriptPath,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      HALLEY_GIT_TOKEN: token,
    });
  } finally {
    await fs
      .rm(scriptPath, { force: true })
      .catch((err) => ignore(err, 'removing transient GIT_ASKPASS script failed', { scriptPath }));
  }
}

export async function runGit(
  cwd: string,
  args: string[],
  extraEnv?: Record<string, string>,
  timeoutMs = 30_000,
): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'safe.directory=*', ...args], {
    cwd,
    env: { ...process.env, ...extraEnv },
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return stdout.trim();
}

/** `git config --unset-all`; exit code 5 ("key not set") is the expected no-op case. */
export async function unsetGitConfig(cwd: string, key: string): Promise<void> {
  try {
    await runGit(cwd, ['config', '--unset-all', key]);
  } catch (err) {
    if ((err as { code?: unknown }).code === 5) return;
    ignore(err, 'git config --unset-all failed', { cwd, key });
  }
}

/**
 * True when `p` exists. Only "does not exist" (ENOENT/ENOTDIR) maps to false; any other access
 * error (EACCES, EIO, ...) propagates instead of silently looking like a missing path.
 */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw err;
  }
}

export async function ensureBareMirror(
  mirrorDir: string,
  repoSlug: string,
  token?: string,
  localSourcePath?: string,
  baseBranch = 'main',
): Promise<string> {
  const remoteUrl = localSourcePath
    ? localSourcePath
    : `https://github.com/${repoSlug}.git`;

  const exists = await pathExists(path.join(mirrorDir, 'HEAD'));

  const runWithAuth = async (args: string[], cwd: string, timeoutMs = 45_000) => {
    if (token && !localSourcePath) {
      return withGitAskPass(token, (env) => runGit(cwd, args, env, timeoutMs));
    }
    return runGit(cwd, args, undefined, timeoutMs);
  };

  if (!exists) {
    await fs.mkdir(mirrorDir, { recursive: true });
    await runGit(mirrorDir, ['init', '--bare']);
    await runGit(mirrorDir, ['remote', 'add', 'origin', remoteUrl]);
  } else {
    await runGit(mirrorDir, ['remote', 'set-url', 'origin', remoteUrl]).catch(async (err) => {
      // A mirror created without an origin remote: add it instead
      ignore(err, 'mirror: set-url origin failed; adding remote', { mirrorDir }, 'debug');
      await runGit(mirrorDir, ['remote', 'add', 'origin', remoteUrl]);
    });
    // Self-heal legacy `git clone --mirror` volumes where remote.origin.mirror=true breaks explicit refspec pushes
    await unsetGitConfig(mirrorDir, 'remote.origin.mirror');
  }

  await runWithAuth(
    [
      '-c',
      'http.lowSpeedLimit=1',
      '-c',
      'http.lowSpeedTime=20',
      'fetch',
      'origin',
      `+refs/heads/${baseBranch}:refs/heads/${baseBranch}`,
    ],
    mirrorDir,
    45_000,
  );
  await runGit(mirrorDir, ['symbolic-ref', 'HEAD', `refs/heads/${baseBranch}`]).catch((err) =>
    ignore(err, 'mirror: pointing HEAD at the base branch failed', { mirrorDir, baseBranch }),
  );
  return mirrorDir;
}
