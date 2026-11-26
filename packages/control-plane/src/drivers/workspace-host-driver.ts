import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORKSPACE_HOST_PROTOCOL_VERSION,
  type BootProgressDto,
  type BootStage,
} from '@halley/shared';
import type { HalleyConfig } from '../config.js';
import type { ControlPlaneDb, SessionRecord } from '../db.js';
import { configureBareMirrorForHttp } from '../git-http.js';
import type { GitHubService } from '../github/client.js';
import { hashWorkspaceToken } from '../proxy/llm-proxy.js';
import {
  CrashLoopTracker,
  WorkspaceCrashLoopError,
  ensureBareMirror,
  runGit,
  withGitAskPass,
  type BootProgressListener,
  type DoctorCheckResult,
  type DuplicateMode,
  type WarmPoolStatus,
  type WarmReservation,
  type WorkspaceCrashInfo,
  type WorkspaceDriver,
  type WorkspaceEndpoint,
} from './workspace-driver.js';

const IN_FLIGHT_PUBLISH_STATES = new Set([
  'verifying',
  'rebasing',
  'resolving_conflicts',
  'pushing_pr',
  'waiting_ci',
  'deploying_pages',
]);

interface SupervisorHealthResponse {
  ok: boolean;
  protocolVersion: number;
  instanceId: string;
  activeSessionIds: string[];
  activeCount: number;
  maxActiveWorkspaces: number;
  warmPool: WarmPoolStatus;
  buildQueue: {
    activeSessionId: string | null;
    queueLength: number;
    queuedSessionIds: string[];
  };
  diskUsage: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPercent: number;
  } | null;
}

async function getFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Failed to allocate loopback port')));
      }
    });
    srv.on('error', reject);
  });
}

export class WorkspaceHostDriver implements WorkspaceDriver {
  private sessionTokens = new Map<string, string>();
  private booting = new Map<string, Promise<WorkspaceEndpoint>>();
  private bootProgress = new Map<string, BootProgressDto>();
  private bootProgressListener: BootProgressListener | null = null;
  private crashTracker = new CrashLoopTracker();

  private localSupervisorProc: ChildProcess | null = null;
  private resolvedHostUrl: string | null = null;
  private startingSupervisor: Promise<string> | null = null;
  private lastSupervisorInstanceId: string | null = null;
  private mirrorSyncInflight: Promise<string> | null = null;
  private lastMirrorSyncAt = 0;
  private lastWarmPoolStatus: WarmPoolStatus = {
    enabled: false,
    target: 0,
    ready: 0,
    warming: 0,
  };

  constructor(
    private config: HalleyConfig,
    private db: ControlPlaneDb,
    private github: GitHubService,
  ) {
    if (config.workspaceHostUrl) {
      this.resolvedHostUrl = config.workspaceHostUrl.replace(/\/+$/, '');
    }
  }

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

  getWarmPoolStatus(): WarmPoolStatus {
    return this.lastWarmPoolStatus;
  }

  private emitProgress(
    sessionId: string,
    stage: BootStage,
    message: string,
    opts?: {
      detail?: string;
      warmHit?: boolean;
      startedAt?: string;
      crashLoop?: boolean;
      oom?: boolean;
      retryAfterSec?: number;
    },
  ): BootProgressDto {
    const prev = this.bootProgress.get(sessionId);
    const now = new Date().toISOString();
    const progress: BootProgressDto = {
      stage,
      message,
      detail: opts?.detail,
      startedAt: opts?.startedAt ?? prev?.startedAt ?? now,
      updatedAt: now,
      warmHit: opts?.warmHit ?? prev?.warmHit,
      crashLoop: opts?.crashLoop,
      oom: opts?.oom,
      retryAfterSec: opts?.retryAfterSec,
    };
    this.bootProgress.set(sessionId, progress);
    this.bootProgressListener?.(sessionId, progress);
    return progress;
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.config.workspaceHostSecret) {
      headers['Authorization'] = `Bearer ${this.config.workspaceHostSecret}`;
    }
    return headers;
  }

  private resolveSupervisorEntry(): string {
    return path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../workspace-runner/dist/supervisor.js',
    );
  }

  /**
   * Returns the base URL of the workspaces supervisor.
   * When `WORKSPACE_HOST_URL` is unset (local dev & E2E tests), automatically spawns
   * the same supervisor binary as a local child process on a free loopback port.
   */
  async getHostUrl(): Promise<string> {
    if (this.resolvedHostUrl) {
      if (!this.config.workspaceHostUrl && this.localSupervisorProc?.exitCode !== null) {
        // Local supervisor exited; respawn it
        this.resolvedHostUrl = null;
      } else {
        return this.resolvedHostUrl;
      }
    }

    if (this.startingSupervisor) return this.startingSupervisor;

    this.startingSupervisor = (async () => {
      const port = await getFreeLoopbackPort();
      const url = `http://127.0.0.1:${port}`;
      const workspacesDir = path.join(this.config.dataDir, 'workspaces');
      await fs.mkdir(workspacesDir, { recursive: true });

      const entry = this.resolveSupervisorEntry();
      const child = spawn(process.execPath, [entry], {
        env: {
          ...process.env,
          SUPERVISOR_PORT: String(port),
          SUPERVISOR_BIND_HOST: '127.0.0.1',
          WORKSPACES_DIR: workspacesDir,
          CONTROL_PLANE_INTERNAL_URL:
            this.config.controlPlaneInternalUrl || `http://127.0.0.1:${this.config.port}`,
          ...(this.config.workspaceHostSecret
            ? { WORKSPACE_HOST_SECRET: this.config.workspaceHostSecret }
            : {}),
          HALLEY_REPO: this.config.repo,
          HALLEY_BASE_BRANCH: this.config.baseBranch,
          HALLEY_MODEL_ID: this.config.modelId,
          HALLEY_THINKING_LEVEL: this.config.thinkingLevel,
          HALLEY_GIT_BOT_NAME: this.config.gitBotName,
          HALLEY_GIT_BOT_EMAIL: this.config.gitBotEmail,
          HALLEY_WARM_POOL_SIZE: String(this.config.warmPoolSize),
          MAX_ACTIVE_WORKSPACES: String(this.config.maxActiveWorkspaces),
          ...(this.config.devLocalRepo ? { HALLEY_DEV_LOCAL_REPO: this.config.devLocalRepo } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.localSupervisorProc = child;
      child.stdout?.on('data', (d) => process.stdout.write(d));
      child.stderr?.on('data', (d) => process.stderr.write(d));
      child.on('exit', () => {
        if (this.localSupervisorProc === child) {
          this.localSupervisorProc = null;
          this.resolvedHostUrl = null;
        }
      });

      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(`Local workspace supervisor exited unexpectedly (code=${child.exitCode})`);
        }
        try {
          const res = await fetch(`${url}/health`, {
            headers: this.authHeaders(),
            signal: AbortSignal.timeout(1500),
          });
          if (res.ok) {
            this.resolvedHostUrl = url;
            return url;
          }
        } catch {
          // still starting
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error('Timed out waiting for local workspace supervisor to start');
    })().finally(() => {
      this.startingSupervisor = null;
    });

    return this.startingSupervisor;
  }

  private async fetchSupervisorHealth(hostUrl: string): Promise<SupervisorHealthResponse> {
    const res = await fetch(`${hostUrl}/health`, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 401) {
      throw new Error(
        'Unauthorized contacting workspaces supervisor — ensure WORKSPACE_HOST_SECRET matches on both control-plane and workspaces.',
      );
    }
    if (!res.ok) {
      throw new Error(`Workspaces supervisor health check failed (HTTP ${res.status})`);
    }
    const data = (await res.json()) as SupervisorHealthResponse;
    if (data.protocolVersion !== WORKSPACE_HOST_PROTOCOL_VERSION) {
      throw new Error(
        `Workspace host protocol version mismatch (control-plane expects v${WORKSPACE_HOST_PROTOCOL_VERSION}, workspaces is v${data.protocolVersion}). Please update both halley-control-plane and halley-workspace images to the same version.`,
      );
    }
    if (data.warmPool) {
      this.lastWarmPoolStatus = data.warmPool;
    }
    return data;
  }

  /**
   * Reconciles DB session states against the live workspaces supervisor.
   * After a `workspaces` container restart or OOM, any session marked `running` in SQLite
   * that is no longer active on the supervisor is flipped to `sleeping` so the next open
   * wakes it cleanly.
   */
  async reconcileSessions(): Promise<void> {
    const hostUrl = await this.getHostUrl();
    const health = await this.fetchSupervisorHealth(hostUrl);
    this.reconcileFromHealth(health);
  }

  private reconcileFromHealth(health: SupervisorHealthResponse): void {
    const restarted =
      this.lastSupervisorInstanceId !== null &&
      this.lastSupervisorInstanceId !== health.instanceId;
    this.lastSupervisorInstanceId = health.instanceId;

    const activeSet = new Set(health.activeSessionIds ?? []);
    const sessions = this.db.listSessions();
    let reconciled = 0;
    for (const s of sessions) {
      const hasLiveUrls = Boolean(s.runner_url || s.astro_url);
      const isMarkedRunning =
        s.status === 'running' ||
        ((s.status === 'published' || s.status === 'merged') && hasLiveUrls);
      if (isMarkedRunning && !activeSet.has(s.id)) {
        const isFrozen = s.status === 'published' || s.status === 'merged';
        this.db.updateSession(s.id, {
          status: isFrozen ? s.status : 'sleeping',
          runner_url: null,
          astro_url: null,
        });
        reconciled++;
      }
    }
    if (restarted || reconciled > 0) {
      console.log(
        `[halley-host-driver] Reconciled ${reconciled} session(s) against supervisor ${health.instanceId.slice(0, 8)}${restarted ? ' (supervisor restarted)' : ''}`,
      );
    }
  }

  async ensureControlPlaneMirror(
    baseBranch = this.config.baseBranch,
    opts?: { force?: boolean; allowStaleOnError?: boolean; ttlMs?: number; token?: string },
  ): Promise<string> {
    const mirrorDir = path.join(this.config.dataDir, 'git-mirror', 'repo.git');
    const ttlMs = opts?.ttlMs ?? 15_000;
    const mirrorExists = await fs
      .access(path.join(mirrorDir, 'HEAD'))
      .then(() => true)
      .catch(() => false);

    if (!opts?.force && mirrorExists && Date.now() - this.lastMirrorSyncAt < ttlMs) {
      return mirrorDir;
    }

    if (this.mirrorSyncInflight) {
      try {
        return await this.mirrorSyncInflight;
      } catch (err) {
        if (opts?.allowStaleOnError && mirrorExists) {
          return mirrorDir;
        }
        throw err;
      }
    }

    const syncPromise = (async () => {
      const token = this.config.devLocalRepo
        ? undefined
        : opts?.token || (await this.github.getAccessToken().catch(() => undefined));
      await ensureBareMirror(
        mirrorDir,
        this.config.repo,
        token,
        this.config.devLocalRepo || undefined,
        baseBranch,
      );
      await configureBareMirrorForHttp(mirrorDir);
      this.lastMirrorSyncAt = Date.now();
      return mirrorDir;
    })().finally(() => {
      if (this.mirrorSyncInflight === syncPromise) {
        this.mirrorSyncInflight = null;
      }
    });

    this.mirrorSyncInflight = syncPromise;
    try {
      return await syncPromise;
    } catch (err) {
      if (opts?.allowStaleOnError && mirrorExists) {
        console.warn(
          `[halley-host-driver] GitHub mirror sync failed (${err instanceof Error ? err.message : String(err)}); continuing with existing local mirror.`,
        );
        return mirrorDir;
      }
      throw err;
    }
  }

  async reserveWarmWorkspace(): Promise<WarmReservation | null> {
    try {
      const hostUrl = await this.getHostUrl();
      const res = await fetch(`${hostUrl}/api/warm/reserve`, {
        method: 'POST',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { reserved: WarmReservation | null };
      if (data.reserved) {
        this.emitProgress(data.reserved.id, 'claiming_warm', 'Connecting to ready workspace…', {
          warmHit: true,
        });
      }
      return data.reserved;
    } catch {
      return null;
    }
  }

  async ensureRunning(session: SessionRecord): Promise<WorkspaceEndpoint> {
    const pending = this.booting.get(session.id);
    if (pending) return pending;

    try {
      this.crashTracker.assertCanAttempt(session.id);
    } catch (err) {
      if (err instanceof WorkspaceCrashLoopError) {
        this.emitProgress(
          session.id,
          'error',
          err.oom ? 'Workspace ran out of memory' : 'Workspace paused after repeated crashes',
          {
            detail: err.message,
            crashLoop: true,
            oom: err.oom,
            retryAfterSec: err.retryAfterSec,
          },
        );
      }
      throw err;
    }

    const p = this.startOrWake(session).finally(() => this.booting.delete(session.id));
    this.booting.set(session.id, p);
    return p;
  }

  private async startOrWake(session: SessionRecord): Promise<WorkspaceEndpoint> {
    const isFrozen = session.status === 'published' || session.status === 'merged';
    try {
      const hostUrl = await this.getHostUrl();
      const health = await this.fetchSupervisorHealth(hostUrl);
      if (
        this.lastSupervisorInstanceId === null ||
        this.lastSupervisorInstanceId !== health.instanceId
      ) {
        this.reconcileFromHealth(health);
      }

      // Refresh control-plane's bare mirror before asking workspaces to clone/sync
      this.emitProgress(session.id, 'syncing_repo', 'Syncing latest website repository…');
      await this.ensureControlPlaneMirror(session.base_branch, { allowStaleOnError: true });

      const workspaceToken = this.ensureSessionToken(session.id);
      const persona = this.db.getUserById(session.owner_user_id)?.persona ?? 'non-technical';
      const protectedSessionIds = this.db
        .listSessions()
        .filter((s) => IN_FLIGHT_PUBLISH_STATES.has(s.publish_state))
        .map((s) => s.id);

      // Poll supervisor boot progress while /start runs
      let stopPolling = false;
      const pollProgress = async () => {
        while (!stopPolling) {
          try {
            const pRes = await fetch(
              `${hostUrl}/api/sessions/${encodeURIComponent(session.id)}/progress`,
              { headers: this.authHeaders(), signal: AbortSignal.timeout(1500) },
            );
            if (pRes.ok) {
              const pData = (await pRes.json()) as { progress: BootProgressDto | null };
              if (pData.progress && pData.progress.stage !== 'ready') {
                this.emitProgress(session.id, pData.progress.stage, pData.progress.message, {
                  detail: pData.progress.detail,
                  warmHit: pData.progress.warmHit,
                  startedAt: pData.progress.startedAt,
                });
              }
            }
          } catch {
            // ignore transient progress poll failure
          }
          await new Promise((r) => setTimeout(r, 400));
        }
      };
      const pollLoop = pollProgress();

      let startRes: Response;
      try {
        startRes = await fetch(
          `${hostUrl}/api/sessions/${encodeURIComponent(session.id)}/start`,
          {
            method: 'POST',
            headers: this.authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
              baseBranch: session.base_branch,
              workingBranch: session.working_branch,
              baseSha: session.base_sha,
              workspaceToken,
              persona,
              editorName: session.owner_name || 'Editor',
              editorEmail: session.owner_email || 'editor@example.com',
              readOnly: isFrozen,
              protectedSessionIds,
            }),
            signal: AbortSignal.timeout(120_000),
          },
        );
      } finally {
        stopPolling = true;
        await pollLoop.catch(() => {});
      }

      if (!startRes.ok) {
        const errData = (await startRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(errData.error || `Workspace start failed (HTTP ${startRes.status})`);
      }

      const started = (await startRes.json()) as {
        runnerPort: number;
        astroPort: number;
        astroBase: string;
        baseSha: string;
        instanceId: string;
      };

      const hostHostname = new URL(hostUrl).hostname;
      const runnerUrl = `http://${hostHostname}:${started.runnerPort}`;
      const astroUrl = `http://${hostHostname}:${started.astroPort}`;
      const astroBase = started.astroBase || session.astro_base || '/';
      const baseSha = started.baseSha || session.base_sha;

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
      console.error(`[halley-host-driver] Failed to start session ${session.id.slice(0, 8)}: ${msg}`);
      const info = this.crashTracker.recordFailure(session.id, msg);
      this.emitProgress(
        session.id,
        'error',
        info.crashLoop ? 'Workspace paused after repeated crashes' : 'Workspace failed to start',
        {
          detail: msg,
          crashLoop: info.crashLoop,
          oom: info.oom,
          retryAfterSec: info.retryAfterSec,
        },
      );
      if (info.crashLoop) {
        this.db.updateSession(session.id, { status: 'error', runner_url: null, astro_url: null });
      }
      throw err;
    }
  }

  async stop(session: SessionRecord): Promise<void> {
    this.bootProgress.delete(session.id);
    try {
      const hostUrl = await this.getHostUrl();
      await fetch(`${hostUrl}/api/sessions/${encodeURIComponent(session.id)}/stop`, {
        method: 'POST',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    } catch {
      // supervisor unavailable
    }
    const isFrozen = session.status === 'published' || session.status === 'merged';
    this.db.updateSession(session.id, {
      status: isFrozen ? session.status : 'sleeping',
      runner_url: null,
      astro_url: null,
    });
  }

  async restart(session: SessionRecord): Promise<WorkspaceEndpoint> {
    this.crashTracker.reset(session.id);
    this.bootProgress.delete(session.id);
    try {
      const hostUrl = await this.getHostUrl();
      await fetch(`${hostUrl}/api/sessions/${encodeURIComponent(session.id)}/restart`, {
        method: 'POST',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    } catch {
      // ignore
    }
    this.db.updateSession(session.id, {
      status: 'starting',
      runner_url: null,
      astro_url: null,
    });
    const fresh = this.db.getSession(session.id) ?? session;
    return this.ensureRunning(fresh);
  }

  async destroy(session: SessionRecord): Promise<void> {
    this.bootProgress.delete(session.id);
    try {
      const hostUrl = await this.getHostUrl();
      await fetch(`${hostUrl}/api/sessions/${encodeURIComponent(session.id)}`, {
        method: 'DELETE',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
    } catch {
      // ignore
    }
  }

  async pruneNodeModules(session: SessionRecord): Promise<void> {
    const hostUrl = await this.getHostUrl();
    const res = await fetch(
      `${hostUrl}/api/sessions/${encodeURIComponent(session.id)}/prune-node-modules`,
      {
        method: 'POST',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) {
      throw new Error(`Failed to prune node_modules (${res.status})`);
    }
  }

  async duplicateWorkspace(
    source: SessionRecord,
    target: SessionRecord,
    mode: DuplicateMode = 'branch-off',
  ): Promise<void> {
    const hostUrl = await this.getHostUrl();
    const res = await fetch(
      `${hostUrl}/api/sessions/${encodeURIComponent(source.id)}/duplicate`,
      {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          targetSessionId: target.id,
          targetWorkingBranch: target.working_branch,
          mode,
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) {
      throw new Error(`Failed to duplicate workspace (${res.status}): ${await res.text()}`);
    }
  }

  async fetchIntoSession(session: SessionRecord, token: string): Promise<void> {
    // 1. Update control-plane's bare mirror from GitHub (using GitHub token strictly in control-plane)
    await this.ensureControlPlaneMirror(session.base_branch, {
      force: true,
      token: token || undefined,
    });

    // 2. Ask workspaces supervisor to fetch from control-plane's internal HTTP git server
    const hostUrl = await this.getHostUrl();
    const res = await fetch(
      `${hostUrl}/api/sessions/${encodeURIComponent(session.id)}/git/fetch`,
      {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ baseBranch: session.base_branch }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) {
      throw new Error(`Workspace git fetch failed (${res.status}): ${await res.text()}`);
    }
  }

  async pushSessionBranch(session: SessionRecord, token: string): Promise<void> {
    // 1. Ensure control-plane's bare mirror is ready to receive the halley/* branch
    const mirrorDir = await this.ensureControlPlaneMirror(session.base_branch, {
      allowStaleOnError: true,
      token: token || undefined,
    });

    // 2. Ask workspaces supervisor to push session.working_branch to control-plane's internal HTTP git server
    const hostUrl = await this.getHostUrl();
    const res = await fetch(
      `${hostUrl}/api/sessions/${encodeURIComponent(session.id)}/git/push`,
      {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ workingBranch: session.working_branch }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) {
      throw new Error(`Workspace git push to control-plane failed (${res.status}): ${await res.text()}`);
    }

    // 3. Push the received halley/* branch from control-plane's bare mirror to GitHub (or devLocalRepo)
    if (!session.working_branch.startsWith('halley/')) {
      throw new Error(`Refusing to push non-halley branch: ${session.working_branch}`);
    }
    const refspec = `refs/heads/${session.working_branch}:refs/heads/${session.working_branch}`;
    await runGit(mirrorDir, ['config', '--unset-all', 'remote.origin.mirror']).catch(() => {});
    if (this.config.devLocalRepo) {
      await runGit(mirrorDir, ['-c', 'remote.origin.mirror=false', 'push', '--force', 'origin', refspec]);
      return;
    }
    await withGitAskPass(token, async (env) => {
      // Bare mirrors don't maintain standard refs/remotes/origin/* tracking refs (and legacy --mirror
      // configs map +refs/*:refs/*), which causes bare --force-with-lease to fail with "(stale info)".
      // Each halley/* branch is owned exclusively by this single session.
      await runGit(
        mirrorDir,
        ['-c', 'remote.origin.mirror=false', 'push', '--force', 'origin', refspec],
        env,
      );
    });
  }

  async getSessionLogs(sessionId: string): Promise<string[]> {
    try {
      const hostUrl = await this.getHostUrl();
      const res = await fetch(
        `${hostUrl}/api/sessions/${encodeURIComponent(sessionId)}/logs`,
        { headers: this.authHeaders(), signal: AbortSignal.timeout(3000) },
      );
      if (!res.ok) return [];
      const data = (await res.json()) as { lines?: string[] };
      return Array.isArray(data.lines) ? data.lines : [];
    } catch {
      return [];
    }
  }

  async runDoctorChecks(): Promise<DoctorCheckResult> {
    const warnings: string[] = [];
    const errors: string[] = [];
    const details: Record<string, unknown> = {
      mode: this.config.workspaceHostUrl ? 'remote-workspaces' : 'local-supervisor',
      workspaceHostUrl: this.config.workspaceHostUrl || '(auto-spawned local)',
      protocolVersion: WORKSPACE_HOST_PROTOCOL_VERSION,
      dataDir: this.config.dataDir,
      maxActiveWorkspaces: this.config.maxActiveWorkspaces,
    };

    try {
      const hostUrl = await this.getHostUrl();
      const health = await this.fetchSupervisorHealth(hostUrl);
      this.reconcileFromHealth(health);
      details.supervisor = {
        instanceId: health.instanceId,
        protocolVersion: health.protocolVersion,
        activeCount: health.activeCount,
        maxActiveWorkspaces: health.maxActiveWorkspaces,
        warmPool: health.warmPool,
        buildQueue: health.buildQueue,
        diskUsage: health.diskUsage,
      };
      if (health.diskUsage && health.diskUsage.usedPercent >= 80) {
        warnings.push(
          `/workspaces disk usage is high (${health.diskUsage.usedPercent}% used). Consider pruning old sessions or expanding storage.`,
        );
      }
    } catch (err) {
      errors.push(
        `Workspaces supervisor check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!this.config.anthropicApiKey) {
      warnings.push('ANTHROPIC_API_KEY is empty — Pi AI chat requests will fail until configured.');
    }
    if (!this.config.githubToken && !this.config.githubAppId && !this.config.devLocalRepo) {
      warnings.push('Neither GITHUB_APP_ID nor GITHUB_TOKEN is configured — publishing PRs will fail.');
    }

    return { ok: errors.length === 0, warnings, errors, details };
  }

  async close(): Promise<void> {
    if (this.localSupervisorProc && this.localSupervisorProc.exitCode === null) {
      this.localSupervisorProc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 1500);
        t.unref?.();
        this.localSupervisorProc?.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
      if (this.localSupervisorProc && this.localSupervisorProc.exitCode === null) {
        this.localSupervisorProc.kill('SIGKILL');
      }
      this.localSupervisorProc = null;
      this.resolvedHostUrl = null;
    }
  }
}
