import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { BootProgressDto, BootStage } from '@halley/shared';
import type { HalleyConfig } from '../config.js';
import type { ControlPlaneDb, SessionRecord } from '../db.js';
import type { GitHubService } from '../github/client.js';
import { hashWorkspaceToken } from '../proxy/llm-proxy.js';
import {
  CrashLoopTracker,
  WorkspaceCrashLoopError,
  ensureBareMirror,
  runGit,
  withGitAskPass,
  type BootProgressListener,
  type WorkspaceCrashInfo,
  type WorkspaceDriver,
  type WorkspaceEndpoint,
} from './workspace-driver.js';

const require = createRequire(import.meta.url);

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Failed to allocate port')));
      }
    });
    srv.on('error', reject);
  });
}

export class LocalWorkspaceDriver implements WorkspaceDriver {
  private procs = new Map<string, ChildProcess>();
  private booting = new Map<string, Promise<WorkspaceEndpoint>>();
  private sessionTokens = new Map<string, string>();
  private bootProgress = new Map<string, BootProgressDto>();
  private bootProgressListener: BootProgressListener | null = null;
  private crashTracker = new CrashLoopTracker();

  constructor(
    private config: HalleyConfig,
    private db: ControlPlaneDb,
    private github: GitHubService,
  ) {}

  setRawWorkspaceToken(sessionId: string, token: string): void {
    this.sessionTokens.set(sessionId, token);
  }

  ensureSessionToken(sessionId: string): string {
    const existing = this.sessionTokens.get(sessionId);
    if (existing && existing.trim().length > 0) return existing;
    const rawToken = crypto.randomBytes(24).toString('hex');
    this.db.updateSession(sessionId, { workspace_token_hash: hashWorkspaceToken(rawToken) });
    this.sessionTokens.set(sessionId, rawToken);
    return rawToken;
  }

  setBootProgressListener(listener: BootProgressListener): void {
    this.bootProgressListener = listener;
  }

  getBootProgress(sessionId: string): BootProgressDto | null {
    return this.bootProgress.get(sessionId) ?? null;
  }

  getCrashInfo(sessionId: string): WorkspaceCrashInfo | null {
    return this.crashTracker.getInfo(sessionId);
  }

  private emitProgress(
    sessionId: string,
    stage: BootStage,
    message: string,
    detail?: string,
    extra?: { crashLoop?: boolean; oom?: boolean; retryAfterSec?: number },
  ): void {
    const prev = this.bootProgress.get(sessionId);
    const now = new Date().toISOString();
    const progress: BootProgressDto = {
      stage,
      message,
      detail,
      startedAt: prev?.startedAt ?? now,
      updatedAt: now,
      crashLoop: extra?.crashLoop,
      oom: extra?.oom,
      retryAfterSec: extra?.retryAfterSec,
    };
    this.bootProgress.set(sessionId, progress);
    this.bootProgressListener?.(sessionId, progress);
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.config.dataDir, 'local-workspaces', sessionId);
  }

  async ensureRunning(session: SessionRecord): Promise<WorkspaceEndpoint> {
    const existing = this.booting.get(session.id);
    if (existing) return existing;

    try {
      this.crashTracker.assertCanAttempt(session.id);
    } catch (err) {
      if (err instanceof WorkspaceCrashLoopError) {
        this.emitProgress(session.id, 'error', 'Workspace paused after repeated crashes', err.message, {
          crashLoop: true,
          oom: err.oom,
          retryAfterSec: err.retryAfterSec,
        });
      }
      throw err;
    }

    if (session.status === 'running' && session.runner_url && session.astro_url && this.procs.has(session.id)) {
      return {
        runnerUrl: session.runner_url,
        astroUrl: session.astro_url,
        astroBase: session.astro_base,
        baseSha: session.base_sha,
      };
    }

    const p = this.bootSession(session).finally(() => {
      this.booting.delete(session.id);
    });
    this.booting.set(session.id, p);
    return p;
  }

  async restart(session: SessionRecord): Promise<WorkspaceEndpoint> {
    this.crashTracker.reset(session.id);
    await this.stop(session);
    this.db.updateSession(session.id, { status: 'starting' });
    const fresh = this.db.getSession(session.id) ?? session;
    return this.ensureRunning(fresh);
  }

  private async bootSession(session: SessionRecord): Promise<WorkspaceEndpoint> {
    try {
      const baseDir = this.sessionDir(session.id);
      const workspaceDir = path.join(baseDir, 'workspace');
      const stateDir = path.join(baseDir, 'state');
      await fs.mkdir(stateDir, { recursive: true });

      const repoReady = await fs
        .access(path.join(workspaceDir, '.git'))
        .then(() => true)
        .catch(() => false);

      let baseSha = session.base_sha;
      if (!repoReady) {
        this.emitProgress(session.id, 'syncing_repo', 'Syncing latest website repository…');
        const mirrorDir = path.join(this.config.dataDir, 'git-mirror', 'repo.git');
        const token = this.config.devLocalRepo ? undefined : await this.github.getAccessToken().catch(() => undefined);
        await ensureBareMirror(mirrorDir, session.repo, token, this.config.devLocalRepo || undefined);

        this.emitProgress(session.id, 'cloning_repo', 'Cloning website files…');
        await fs.mkdir(baseDir, { recursive: true });
        await runGit(baseDir, ['clone', mirrorDir, 'workspace']);
        if (this.config.devLocalRepo) {
          await runGit(workspaceDir, ['remote', 'set-url', 'origin', this.config.devLocalRepo]);
        } else {
          await runGit(workspaceDir, [
            'remote',
            'set-url',
            'origin',
            `https://github.com/${session.repo}.git`,
          ]);
        }
        await runGit(workspaceDir, ['checkout', '-B', session.working_branch, session.base_branch]);
        baseSha = await runGit(workspaceDir, ['rev-parse', 'HEAD']);
      } else if (!baseSha) {
        baseSha = await runGit(workspaceDir, ['rev-parse', 'HEAD']);
      }

      // Install or restore dependencies (including after 7-day node_modules pruning)
      const hasModules = await fs
        .access(path.join(workspaceDir, 'node_modules'))
        .then(() => true)
        .catch(() => false);
      if (!hasModules) {
        this.emitProgress(session.id, 'installing_deps', 'Installing project packages…');
        if (this.config.devLocalRepo) {
          const srcModules = path.join(this.config.devLocalRepo, 'node_modules');
          const hasSrcModules = await fs.access(srcModules).then(() => true).catch(() => false);
          if (hasSrcModules) {
            await fs.symlink(srcModules, path.join(workspaceDir, 'node_modules'));
          }
        } else {
          const hasPkgLock = await fs.access(path.join(workspaceDir, 'package-lock.json')).then(() => true).catch(() => false);
          const hasPnpmLock = await fs.access(path.join(workspaceDir, 'pnpm-lock.yaml')).then(() => true).catch(() => false);
          const { execFile } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const execFileAsync = promisify(execFile);
          if (hasPkgLock) {
            await execFileAsync('npm', ['ci', '--ignore-scripts'], { cwd: workspaceDir, maxBuffer: 16 * 1024 * 1024 });
          } else if (hasPnpmLock) {
            await execFileAsync('pnpm', ['install', '--frozen-lockfile'], { cwd: workspaceDir, maxBuffer: 16 * 1024 * 1024 });
          } else {
            await execFileAsync('npm', ['install', '--ignore-scripts'], { cwd: workspaceDir, maxBuffer: 16 * 1024 * 1024 });
          }
        }
      }

      this.emitProgress(session.id, 'starting_preview', 'Starting Astro live preview…');

    const runnerPort = await getFreePort();
    const astroPort = await getFreePort();
    let runnerEntry: string;
    try {
      runnerEntry = require.resolve('@halley/workspace-runner');
    } catch {
      const { fileURLToPath } = await import('node:url');
      runnerEntry = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../workspace-runner/dist/index.js',
      );
    }
    const workspaceToken = this.ensureSessionToken(session.id);

    const child = spawn(process.execPath, [runnerEntry], {
      cwd: workspaceDir,
      env: {
        ...process.env,
        HALLEY_WORKSPACE_DIR: workspaceDir,
        HALLEY_STATE_DIR: stateDir,
        HALLEY_SESSION_ID: session.id,
        HALLEY_BASE_BRANCH: session.base_branch,
        HALLEY_BASE_SHA: baseSha,
        RUNNER_PORT: String(runnerPort),
        ASTRO_PORT: String(astroPort),
        CONTROL_PLANE_INTERNAL_URL: `http://127.0.0.1:${this.config.port}`,
        WORKSPACE_TOKEN: workspaceToken,
        HALLEY_MODEL_ID: this.config.modelId,
        HALLEY_THINKING_LEVEL: this.config.thinkingLevel,
        HALLEY_PERSONA: this.db.getUserById(session.owner_user_id)?.persona ?? 'non-technical',
        HALLEY_GIT_BOT_NAME: this.config.gitBotName,
        HALLEY_GIT_BOT_EMAIL: this.config.gitBotEmail,
        HALLEY_EDITOR_NAME: session.owner_name || 'Editor',
        HALLEY_EDITOR_EMAIL: session.owner_email || 'editor@example.com',
        HALLEY_READ_ONLY:
          session.status === 'published' || session.status === 'merged' ? 'true' : 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.procs.set(session.id, child);
    child.stdout?.on('data', (d) => process.stdout.write(`[ws:${session.id.slice(0, 6)}] ${d}`));
    child.stderr?.on('data', (d) => process.stderr.write(`[ws:${session.id.slice(0, 6)}] ${d}`));
    child.on('exit', () => {
      this.procs.delete(session.id);
      const cur = this.db.getSession(session.id);
      if (cur && cur.status === 'running') {
        this.db.updateSession(session.id, { status: 'sleeping', runner_url: null, astro_url: null });
      }
    });

    const runnerUrl = `http://127.0.0.1:${runnerPort}`;
    const astroUrl = `http://127.0.0.1:${astroPort}`;
    let astroBase = '/';

    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${runnerUrl}/health`);
        if (res.ok) {
          const health = (await res.json()) as { originalBase?: string; astroReady?: boolean };
          astroBase = health.originalBase || '/';
          if (health.astroReady) break;
        }
      } catch {
        // booting
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    const isFrozen = session.status === 'published' || session.status === 'merged';
    this.db.updateSession(session.id, {
      status: isFrozen ? session.status : 'running',
      base_sha: baseSha,
      runner_url: runnerUrl,
      astro_url: astroUrl,
      astro_base: astroBase,
      node_modules_pruned_at: null,
      last_active_at: new Date().toISOString(),
    });

    this.crashTracker.recordSuccess(session.id);
    this.emitProgress(session.id, 'ready', 'Workspace ready!');
    return { runnerUrl, astroUrl, astroBase, baseSha };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const info = this.crashTracker.recordFailure(session.id, msg);
      this.emitProgress(
        session.id,
        'error',
        info.crashLoop ? 'Workspace paused after repeated crashes' : 'Workspace failed to start',
        msg,
        { crashLoop: info.crashLoop, oom: info.oom, retryAfterSec: info.retryAfterSec },
      );
      if (info.crashLoop) {
        this.db.updateSession(session.id, { status: 'error', runner_url: null, astro_url: null });
      }
      throw err;
    }
  }

  async stop(session: SessionRecord): Promise<void> {
    this.bootProgress.delete(session.id);
    const proc = this.procs.get(session.id);
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 400));
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
    this.procs.delete(session.id);
    const isFrozen = session.status === 'published' || session.status === 'merged';
    this.db.updateSession(session.id, {
      status: isFrozen ? session.status : 'sleeping',
      runner_url: null,
      astro_url: null,
    });
  }

  async destroy(session: SessionRecord): Promise<void> {
    await this.stop(session);
    await fs.rm(this.sessionDir(session.id), { recursive: true, force: true });
  }

  async pruneNodeModules(session: SessionRecord): Promise<void> {
    const nmPath = path.join(this.sessionDir(session.id), 'workspace', 'node_modules');
    await fs.rm(nmPath, { recursive: true, force: true }).catch(() => {});
  }

  async duplicateWorkspace(
    source: SessionRecord,
    target: SessionRecord,
    mode: 'branch-off' | 'fresh-from-main' = 'branch-off',
  ): Promise<void> {
    const dstBase = this.sessionDir(target.id);
    await fs.mkdir(path.join(dstBase, 'state'), { recursive: true });

    if (mode === 'fresh-from-main') {
      // Leave workspace absent so ensureRunning clones cleanly from latest origin/main
      return;
    }

    const srcBase = this.sessionDir(source.id);
    const srcWs = path.join(srcBase, 'workspace');
    const dstWs = path.join(dstBase, 'workspace');

    const hasSrcRepo = await fs
      .access(path.join(srcWs, '.git'))
      .then(() => true)
      .catch(() => false);
    if (!hasSrcRepo) {
      // Source workspace hasn't finished cloning yet; leave absent so ensureRunning clones cleanly
      return;
    }

    // Copy full workspace directory including dirty uncommitted files (excluding node_modules)
    await fs.cp(srcWs, dstWs, {
      recursive: true,
      filter: (srcPath) => path.basename(srcPath) !== 'node_modules',
    });

    // Copy staged uploads (NOT live pi.sqlite per Q18)
    const srcUploads = path.join(srcBase, 'state', 'uploads');
    const hasUploads = await fs
      .access(srcUploads)
      .then(() => true)
      .catch(() => false);
    if (hasUploads) {
      await fs.cp(srcUploads, path.join(dstBase, 'state', 'uploads'), { recursive: true });
    }

    if (!this.config.devLocalRepo) {
      await runGit(dstWs, ['remote', 'set-url', 'origin', `https://github.com/${target.repo}.git`]);
    }
    await runGit(dstWs, ['checkout', '-b', target.working_branch]);

    if (this.config.devLocalRepo) {
      const srcModules = path.join(this.config.devLocalRepo, 'node_modules');
      const hasSrcModules = await fs
        .access(srcModules)
        .then(() => true)
        .catch(() => false);
      if (hasSrcModules) {
        await fs.symlink(srcModules, path.join(dstWs, 'node_modules')).catch(() => {});
      }
    }
  }

  async pushSessionBranch(session: SessionRecord, token: string): Promise<void> {
    const ws = path.join(this.sessionDir(session.id), 'workspace');
    if (this.config.devLocalRepo) {
      await runGit(ws, ['push', '--force-with-lease', 'origin', session.working_branch]);
      return;
    }
    await withGitAskPass(token, (env) =>
      runGit(ws, ['push', '--force-with-lease', 'origin', session.working_branch], env),
    );
  }

  async fetchIntoSession(session: SessionRecord, token: string): Promise<void> {
    const ws = path.join(this.sessionDir(session.id), 'workspace');
    if (this.config.devLocalRepo) {
      await runGit(ws, ['fetch', 'origin', session.base_branch]);
      return;
    }
    await withGitAskPass(token, (env) =>
      runGit(ws, ['fetch', 'origin', session.base_branch], env),
    );
  }
}
