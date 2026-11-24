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

export interface WorkspaceDriver {
  setRawWorkspaceToken?(sessionId: string, token: string): void;
  ensureRunning(session: SessionRecord): Promise<WorkspaceEndpoint>;
  stop(session: SessionRecord): Promise<void>;
  destroy(session: SessionRecord): Promise<void>;
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
  startWarmPool?(): void;
  stopWarmPool?(): Promise<void>;
  reserveWarmWorkspace?(): WarmReservation | null;
  getWarmPoolStatus?(): WarmPoolStatus;
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
    await fs.mkdir(path.dirname(mirrorDir), { recursive: true });
    await runWithAuth(['clone', '--mirror', remoteUrl, mirrorDir], path.dirname(mirrorDir));
  } else {
    await runWithAuth(['remote', 'update', '--prune'], mirrorDir);
  }
  return mirrorDir;
}
