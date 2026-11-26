import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { BootProgressDto } from '@halley/shared';
import type { SessionRecord } from '../db.js';

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

const DEFAULT_CRASH_WINDOW_MS = 10 * 60_000;
const DEFAULT_CRASH_THRESHOLD = 3;
const DEFAULT_COOLDOWNS_MS = [60_000, 120_000, 300_000];

export class CrashLoopTracker {
  private records = new Map<string, CrashRecord>();
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly cooldownsMs: number[];

  constructor(opts?: { threshold?: number; windowMs?: number; cooldownsMs?: number[] }) {
    this.threshold = opts?.threshold ?? DEFAULT_CRASH_THRESHOLD;
    this.windowMs = opts?.windowMs ?? DEFAULT_CRASH_WINDOW_MS;
    this.cooldownsMs = opts?.cooldownsMs ?? DEFAULT_COOLDOWNS_MS;
  }

  assertCanAttempt(sessionId: string, now = Date.now()): void {
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
    const now = opts?.now ?? Date.now();
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
    return this.getInfo(sessionId, now)!;
  }

  recordSuccess(sessionId: string): void {
    this.records.delete(sessionId);
  }

  reset(sessionId: string): void {
    this.records.delete(sessionId);
  }

  getInfo(sessionId: string, now = Date.now()): WorkspaceCrashInfo | null {
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
  pushSessionBranch(session: SessionRecord, token: string): Promise<void>;
  fetchIntoSession(session: SessionRecord, token: string): Promise<void>;
  setBootProgressListener?(listener: BootProgressListener): void;
  getBootProgress?(sessionId: string): BootProgressDto | null;
  getCrashInfo?(sessionId: string): WorkspaceCrashInfo | null;
  getSessionLogs?(sessionId: string): Promise<string[]>;
  runDoctorChecks?(): Promise<DoctorCheckResult>;
  reconcileSessions?(): Promise<void>;
  startWarmPool?(): void;
  stopWarmPool?(): Promise<void>;
  reserveWarmWorkspace?(): Promise<WarmReservation | null> | WarmReservation | null;
  getWarmPoolStatus?(): WarmPoolStatus;
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
    await fs.rm(scriptPath, { force: true }).catch(() => {});
  }
}

export async function runGit(
  cwd: string,
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'safe.directory=*', ...args], {
    cwd,
    env: { ...process.env, ...extraEnv },
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
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

  const exists = await fs
    .access(path.join(mirrorDir, 'HEAD'))
    .then(() => true)
    .catch(() => false);

  const runWithAuth = async (args: string[], cwd: string) => {
    if (token && !localSourcePath) {
      return withGitAskPass(token, (env) => runGit(cwd, args, env));
    }
    return runGit(cwd, args);
  };

  if (!exists) {
    await fs.mkdir(mirrorDir, { recursive: true });
    await runGit(mirrorDir, ['init', '--bare']);
    await runGit(mirrorDir, ['remote', 'add', 'origin', remoteUrl]);
  } else {
    await runGit(mirrorDir, ['remote', 'set-url', 'origin', remoteUrl]).catch(() => {});
    // Self-heal legacy `git clone --mirror` volumes where remote.origin.mirror=true breaks explicit refspec pushes
    await runGit(mirrorDir, ['config', '--unset-all', 'remote.origin.mirror']).catch(() => {});
  }

  await runWithAuth(
    [
      '-c',
      'http.lowSpeedLimit=1',
      '-c',
      'http.lowSpeedTime=30',
      'fetch',
      'origin',
      `+refs/heads/${baseBranch}:refs/heads/${baseBranch}`,
    ],
    mirrorDir,
  );
  await runGit(mirrorDir, ['symbolic-ref', 'HEAD', `refs/heads/${baseBranch}`]).catch(() => {});
  return mirrorDir;
}
