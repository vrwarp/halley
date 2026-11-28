import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type BootProgressDto, type BootStage } from '@halley/shared';
import { correlationHeaders, errCode, ignore } from '../log.js';
import { type ProcessRunner } from '../proc.js';
import { type Clock } from '../clock.js';

/** Marker file written into warm-standby slot dirs; only dirs carrying it are swept at startup. */
export const WARM_SLOT_MARKER = '.warm-slot';

export const MAX_LOG_LINES_PER_SESSION = 500;
/** Log buffers kept for sessions that are no longer running (most recent first survive). */
export const MAX_IDLE_LOG_BUFFERS = 100;
/** Deleted-session tombstones only need to outlive an in-flight boot of that session. */
export const MAX_DELETED_TOMBSTONES = 1_000;
export const DELETED_TOMBSTONE_TTL_MS = 60 * 60_000;
/** stopAll waits at most the stop grace plus this for all runners to be stopped. */
export const STOP_ALL_EXTRA_MS = 10_000;

/** Refusal because /workspaces is (nearly) full; mapped to HTTP 507 Insufficient Storage. */
export class DiskPressureError extends Error {
  readonly status = 507 as const;
  constructor(
    readonly operation: string,
    readonly freeBytes: number,
    readonly thresholdBytes: number,
  ) {
    super(
      `Not enough free disk space on the workspace volume to ${operation} ` +
        `(${Math.round(freeBytes / 1024 / 1024)} MB free, need ${Math.round(thresholdBytes / 1024 / 1024)} MB). ` +
        'An administrator needs to free space (old sessions, caches) before new workspaces can start.',
    );
    this.name = 'DiskPressureError';
  }
}

/** Boot failure that must not be retried by the health poll loop (crash, protocol mismatch, deleted). */
export class FatalBootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalBootError';
  }
}

export interface StartPhaseTimings {
  path: 'cold' | 'wake' | 'warm-claim' | 'warm-standby';
  phasesMs: Record<string, number>;
  totalMs: number;
  at: string;
}

export const BOOT_STAGE_MESSAGES: Partial<Record<BootStage, string>> = {
  syncing_repo: 'Syncing latest website repository…',
  cloning_repo: 'Cloning website files…',
  installing_deps: 'Installing project packages…',
  starting_preview: 'Starting Astro live preview…',
  starting_ai: 'Starting AI editing assistant…',
  claiming_warm: 'Connecting to ready workspace…',
  ready: 'Workspace ready!',
};

export interface SupervisorOptions {
  workspacesDir: string;
  controlPlaneInternalUrl: string;
  hostSecret?: string;
  repo: string;
  baseBranch: string;
  modelId: string;
  thinkingLevel: 'off' | 'low' | 'medium' | 'high';
  gitBotName: string;
  gitBotEmail: string;
  warmPoolSize: number;
  maxActiveWorkspaces: number;
  buildQueueTimeoutMs?: number;
  devLocalRepo?: string;
  runnerEntry?: string;
  bindHost?: string;
  port?: number;
  /**
   * Child-process seam for git (mirror/fetch/push), npm/pnpm installs, du and the runner processes.
   * Installed process-wide when given (tests inject a recording/faulting runner).
   */
  processRunner?: ProcessRunner;
  /**
   * Clock for every behaviour-affecting supervisor timer: runner/control-plane fetch deadlines,
   * boot health polling, stop grace -> SIGKILL, warm-pool health and maintenance intervals,
   * tombstone / reservation / idle ages. Defaults to the real clock; tests pass a ManualClock.
   */
  clock?: Clock;
}

export interface ManagedSession {
  id: string;
  proc: ChildProcess;
  runnerPort: number;
  astroPort: number;
  astroBase: string;
  baseSha: string;
  workspaceToken: string;
  lastActiveAt: number;
  isWarmStandby: boolean;
  /** Set by stopSessionProcess: an exit after this is expected, not a crash. */
  stopRequested?: boolean;
}

export interface CrashedSessionInfo {
  id: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  at: string;
  /** Exit 137 / SIGKILL without a stop request is almost always the kernel OOM killer. */
  oom: boolean;
  warmStandby: boolean;
  logTail: string[];
}

export const MAX_CRASH_RECORDS = 50;

export interface WarmSlot {
  id: string;
  rawToken: string;
  state: 'warming' | 'ready' | 'failed';
  runnerPort: number;
  astroPort: number;
  astroBase: string;
  baseSha: string;
  progress: BootProgressDto;
  bootPromise: Promise<void>;
  claimedBySessionId: string | null;
  reservedAt?: number;
}

export interface DiskUsageInfo {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

/** fetch to a local runner/astro port, forwarding the current request's correlation ids. */
export function runnerFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const corr = correlationHeaders();
  if (Object.keys(corr).length === 0) return fetch(url, init);
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(corr)) if (!headers.has(k)) headers.set(k, v);
  return fetch(url, { ...init, headers });
}

export async function fileExists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    (err) => {
      if (errCode(err) !== 'ENOENT') ignore(err, 'supervisor: access check', { path: p });
      return false;
    },
  );
}

export function parseBootStageFromLine(line: string): { stage: BootStage; message: string } | null {
  const m = line.match(/\[halley-boot\]\s+([a-z_]+)/);
  const stage = m?.[1] as BootStage | undefined;
  if (!stage) return null;
  const message = BOOT_STAGE_MESSAGES[stage];
  if (!message) return null;
  return { stage, message };
}
