import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { HalleyConfig } from '../config.js';
import type { ControlPlaneDb, SessionRecord } from '../db.js';
import type { GitHubService } from '../github/client.js';
import {
  ensureBareMirror,
  runGit,
  withGitAskPass,
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

  constructor(
    private config: HalleyConfig,
    private db: ControlPlaneDb,
    private github: GitHubService,
  ) {}

  setRawWorkspaceToken(sessionId: string, token: string): void {
    this.sessionTokens.set(sessionId, token);
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.config.dataDir, 'local-workspaces', sessionId);
  }

  async ensureRunning(session: SessionRecord): Promise<WorkspaceEndpoint> {
    const existing = this.booting.get(session.id);
    if (existing) return existing;

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

  private async bootSession(session: SessionRecord): Promise<WorkspaceEndpoint> {
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
      const mirrorDir = path.join(this.config.dataDir, 'git-mirror', 'repo.git');
      const token = this.config.devLocalRepo ? undefined : await this.github.getAccessToken().catch(() => undefined);
      await ensureBareMirror(mirrorDir, session.repo, token, this.config.devLocalRepo || undefined);

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

      // Install dependencies (fast if devLocalRepo has node_modules or npm cache)
      const hasModules = await fs
        .access(path.join(workspaceDir, 'node_modules'))
        .then(() => true)
        .catch(() => false);
      if (!hasModules) {
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
    } else if (!baseSha) {
      baseSha = await runGit(workspaceDir, ['rev-parse', 'HEAD']);
    }

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
    const workspaceToken = this.sessionTokens.get(session.id) || 'dev-token';

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
        HALLEY_READ_ONLY: session.status === 'published' ? 'true' : 'false',
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

    this.db.updateSession(session.id, {
      status: session.status === 'published' ? 'published' : 'running',
      base_sha: baseSha,
      runner_url: runnerUrl,
      astro_url: astroUrl,
      astro_base: astroBase,
      last_active_at: new Date().toISOString(),
    });

    return { runnerUrl, astroUrl, astroBase, baseSha };
  }

  async stop(session: SessionRecord): Promise<void> {
    const proc = this.procs.get(session.id);
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 400));
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
    this.procs.delete(session.id);
    this.db.updateSession(session.id, {
      status: session.status === 'published' ? 'published' : 'sleeping',
      runner_url: null,
      astro_url: null,
    });
  }

  async destroy(session: SessionRecord): Promise<void> {
    await this.stop(session);
    await fs.rm(this.sessionDir(session.id), { recursive: true, force: true });
  }

  async duplicateWorkspace(source: SessionRecord, target: SessionRecord): Promise<void> {
    const srcWs = path.join(this.sessionDir(source.id), 'workspace');
    const dstBase = this.sessionDir(target.id);
    const dstWs = path.join(dstBase, 'workspace');
    await fs.mkdir(dstBase, { recursive: true });
    await runGit(dstBase, ['clone', srcWs, 'workspace']);
    if (!this.config.devLocalRepo) {
      await runGit(dstWs, ['remote', 'set-url', 'origin', `https://github.com/${target.repo}.git`]);
    }
    await runGit(dstWs, ['checkout', '-b', target.working_branch]);
    if (this.config.devLocalRepo) {
      const srcModules = path.join(this.config.devLocalRepo, 'node_modules');
      const hasSrcModules = await fs.access(srcModules).then(() => true).catch(() => false);
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
