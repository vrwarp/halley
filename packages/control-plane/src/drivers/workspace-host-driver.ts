import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  WORKSPACE_HOST_PROTOCOL_VERSION,
  type AstroAuditReportDto,
  type BootProgressDto,
  type BootStage,
} from '@halley/shared';
import {
  deriveInternalHostToken,
  deriveWorkspaceToken,
  hashWorkspaceToken,
} from '@halley/shared/auth';
import { realClock, timeoutSignal, type Clock, type FetchFn } from '../clock.js';
import type { HalleyConfig } from '../config.js';
import type { ControlPlaneDb, SessionRecord } from '../db.js';
import { configureBareMirrorForHttp } from '../git-http.js';
import type { GitHubService } from '../github/client.js';
import { ignore, logger, orDefault } from '../log.js';
import { correlationHeaders } from '../request-context.js';
import { isPublishInFlight } from '../session-state.js';
import {
  CrashLoopTracker,
  WorkspaceCrashLoopError,
  ensureBareMirror,
  pathExists,
  runGit,
  unsetGitConfig,
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

// Supervisor responses are validated at the boundary: a mis-matched/half-upgraded supervisor must
// produce a clear error, not `undefined` ports or a silently empty active-session list.
const SupervisorHealthSchema = z
  .object({
    protocolVersion: z.number(),
    instanceId: z.string().min(1),
    activeSessionIds: z.array(z.string()),
    astroReadySessionIds: z.array(z.string()).optional(),
    activeCount: z.number().optional(),
    maxActiveWorkspaces: z.number().optional(),
    warmPool: z
      .object({ enabled: z.boolean(), target: z.number(), ready: z.number(), warming: z.number() })
      .passthrough()
      .optional(),
    diskUsage: z.object({ usedPercent: z.number() }).passthrough().nullable().optional(),
  })
  .passthrough();

const HandshakeResponseSchema = z
  .object({ ok: z.literal(true), instanceId: z.string().optional(), protocolVersion: z.number().optional() })
  .passthrough();

const StartResponseSchema = z
  .object({
    runnerPort: z.number().int().positive(),
    astroPort: z.number().int().positive(),
    astroBase: z.string().optional(),
    baseSha: z.string().optional(),
    instanceId: z.string().optional(),
  })
  .passthrough();

function parseSupervisorResponse<S extends z.ZodTypeAny>(schema: S, data: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      `Workspaces supervisor returned an invalid ${what} response: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

interface SupervisorHealthResponse {
  ok: boolean;
  protocolVersion: number;
  instanceId: string;
  activeSessionIds: string[];
  astroReadySessionIds?: string[];
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

export async function getFreeLoopbackPort(): Promise<number> {
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

export interface WorkspaceHostDriverDeps {
  clock?: Clock;
  fetch?: FetchFn;
  /** Loopback port probe for the local supervisor (tests inject collisions). */
  allocatePort?: () => Promise<number>;
  /** Local supervisor entry script (default: workspace-runner/dist/supervisor.js). */
  supervisorEntry?: string;
}

/** Spawn attempts when the probed port is taken before the local supervisor binds it. */
export const LOCAL_SUPERVISOR_PORT_ATTEMPTS = 3;

export interface SupervisorReadiness {
  ok: boolean;
  error?: string;
  /** Age of the health sample the answer is based on. */
  ageMs?: number;
}

export class WorkspaceHostDriver implements WorkspaceDriver {
  private readonly internalHostToken: string;
  private readonly clock: Clock;
  private readonly fetchImpl: FetchFn;
  private customSessionTokens = new Map<string, string>();
  /**
   * Single-flight per session for ensureRunning/restart: registered synchronously before any
   * await, so concurrent callers (preview assets, chat ws, publish) share one boot.
   */
  private ensureInflight = new Map<string, Promise<WorkspaceEndpoint>>();
  /** Sessions whose start/wake is in progress (reconcile must not clear their URLs meanwhile). */
  private booting = new Map<string, Promise<WorkspaceEndpoint>>();
  private lastHealthError: { message: string; at: number } | null = null;
  private bootProgress = new Map<string, BootProgressDto>();
  private bootProgressListener: BootProgressListener | null = null;
  private crashTracker: CrashLoopTracker;

  private localSupervisorProc: ChildProcess | null = null;
  private readonly allocatePort: () => Promise<number>;
  private readonly supervisorEntry: string | null;
  private resolvedHostUrl: string | null = null;
  private startingSupervisor: Promise<string> | null = null;
  private lastSupervisorInstanceId: string | null = null;
  private handshookInstanceId: string | null = null;
  private astroReadySet = new Set<string>();
  private lastTouchedAt = new Map<string, number>();
  private cachedHealth: { data: SupervisorHealthResponse; at: number } | null = null;
  private healthInflight: Promise<SupervisorHealthResponse> | null = null;
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
    deps: WorkspaceHostDriverDeps = {},
  ) {
    this.clock = deps.clock ?? realClock;
    this.fetchImpl = deps.fetch ?? ((...args) => fetch(...args));
    this.allocatePort = deps.allocatePort ?? getFreeLoopbackPort;
    this.supervisorEntry = deps.supervisorEntry ?? null;
    this.crashTracker = new CrashLoopTracker({ clock: this.clock, store: db });
    this.internalHostToken =
      config.workspaceHostSecret || deriveInternalHostToken(config.sessionSecret);
    if (config.workspaceHostUrl) {
      this.resolvedHostUrl = config.workspaceHostUrl.replace(/\/+$/, '');
    }
  }

  setRawWorkspaceToken(sessionId: string, token: string): void {
    if (token && token.trim().length > 0) {
      this.customSessionTokens.set(sessionId, token);
    }
  }

  ensureSessionToken(sessionId: string): string {
    const custom = this.customSessionTokens.get(sessionId);
    if (custom && custom.trim().length > 0) return custom;
    const row = this.db.getSession(sessionId);
    const rawToken = deriveWorkspaceToken(
      this.config.sessionSecret,
      sessionId,
      row?.token_epoch ?? 0,
    );
    const expectedHash = hashWorkspaceToken(rawToken);
    if (row && row.workspace_token_hash !== expectedHash) {
      this.db.updateSession(sessionId, { workspace_token_hash: expectedHash });
    }
    return rawToken;
  }

  isSessionAstroReady(sessionId: string): boolean {
    if (this.astroReadySet.has(sessionId)) return true;
    if (!this.cachedHealth) {
      const s = this.db.getSession(sessionId);
      return Boolean(s?.astro_url && s.status === 'running');
    }
    return false;
  }

  touchSession(sessionId: string): void {
    const now = this.clock.now();
    const prev = this.lastTouchedAt.get(sessionId) ?? 0;
    if (now - prev < 15_000) return;
    this.lastTouchedAt.set(sessionId, now);
    const hostUrl = this.resolvedHostUrl;
    if (!hostUrl) return;
    void this.fetchImpl(`${hostUrl}/api/sessions/${encodeURIComponent(sessionId)}/touch`, {
      method: 'POST',
      headers: this.authHeaders(),
      signal: this.clock.timeoutSignal(2000),
    }).catch((err) => ignore(err, 'supervisor touch failed', { sessionId }, 'debug'));
  }

  notifyMirrorUpdated(baseBranch: string): void {
    const hostUrl = this.resolvedHostUrl;
    if (!hostUrl) return;
    void this.fetchImpl(`${hostUrl}/api/mirror/notify-updated`, {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ baseBranch }),
      signal: this.clock.timeoutSignal(3000),
    }).catch((err) => ignore(err, 'supervisor mirror notify failed', { baseBranch }, 'debug'));
  }

  deferSpeculativeBuilds(durationMs: number): void {
    const hostUrl = this.resolvedHostUrl;
    if (!hostUrl) return;
    void this.fetchImpl(`${hostUrl}/internal/build-lock/defer-speculative`, {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ durationMs }),
      signal: this.clock.timeoutSignal(2000),
    }).catch((err) => ignore(err, 'supervisor defer-speculative failed', { durationMs }, 'debug'));
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
    const now = new Date(this.clock.now()).toISOString();
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
    return {
      ...correlationHeaders(),
      ...extra,
      Authorization: `Bearer ${this.internalHostToken}`,
    };
  }

  private async performHandshake(hostUrl: string): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${hostUrl}/api/handshake`, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ internalHostToken: this.internalHostToken }),
        signal: this.clock.timeoutSignal(3000),
      });
      if (!res.ok) return false;
      const body = await orDefault(res.json(), null, 'supervisor handshake: response is not JSON', { hostUrl }, 'debug');
      return HandshakeResponseSchema.safeParse(body).success;
    } catch (err) {
      ignore(err, 'supervisor handshake failed', { hostUrl }, 'debug');
      return false;
    }
  }

  private async launchLocalSupervisor(
    port: number,
    workspacesDir: string,
  ): Promise<{ kind: 'ready'; url: string } | { kind: 'port_in_use' | 'failed'; error: Error }> {
    const url = `http://127.0.0.1:${port}`;
    const entry = this.supervisorEntry ?? this.resolveSupervisorEntry();
    const child = spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        SUPERVISOR_PORT: String(port),
        SUPERVISOR_BIND_HOST: '127.0.0.1',
        // We are its parent: if this control plane dies, the local supervisor (and its sessions) exit
        // instead of running on unsupervised.
        HALLEY_EXIT_WITH_PARENT: '1',
        WORKSPACES_DIR: workspacesDir,
        CONTROL_PLANE_INTERNAL_URL: this.config.controlPlaneInternalUrl || `http://127.0.0.1:${this.config.port}`,
        WORKSPACE_HOST_SECRET: this.internalHostToken,
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
    let portInUse = false;
    // Only the head of the output is scanned: a bind failure is reported right at startup
    let scanned = 0;
    const scan = (d: Buffer) => {
      if (portInUse || scanned > 64 * 1024) return;
      scanned += d.length;
      if (d.includes('EADDRINUSE')) portInUse = true;
    };
    child.stdout?.on('data', (d: Buffer) => {
      scan(d);
      process.stdout.write(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      scan(d);
      process.stderr.write(d);
    });
    child.on('exit', () => {
      if (this.localSupervisorProc === child) {
        this.localSupervisorProc = null;
        this.resolvedHostUrl = null;
      }
    });
    const giveUp = async (kind: 'port_in_use' | 'failed', error: Error) => {
      if (child.exitCode === null) {
        const exited = new Promise<void>((r) => child.once('exit', () => r()));
        child.kill('SIGKILL');
        await exited;
      }
      return { kind, error };
    };

    const deadline = this.clock.now() + 20_000;
    let lastErr: unknown = null;
    while (this.clock.now() < deadline) {
      if (portInUse) return giveUp('port_in_use', new Error(`Local workspace supervisor could not bind port ${port} (EADDRINUSE)`));
      if (child.exitCode !== null) {
        return giveUp('failed', new Error(`Local workspace supervisor exited unexpectedly (code=${child.exitCode})`));
      }
      try {
        const res = await this.fetchImpl(`${url}/health`, {
          headers: this.authHeaders(),
          signal: this.clock.timeoutSignal(1500),
        });
        // A 200 from an authenticated /health is our child (a foreign squatter can't pass auth)
        if (res.ok && !portInUse) {
          this.resolvedHostUrl = url;
          return { kind: 'ready', url };
        }
      } catch (err) {
        lastErr = err; // expected while the child is still binding its port
      }
      await this.clock.sleep(150);
    }
    return giveUp(
      'failed',
      new Error(
        `Timed out waiting for local workspace supervisor to start${lastErr instanceof Error ? ` (${lastErr.message})` : ''}`,
      ),
    );
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
      const workspacesDir = path.join(this.config.dataDir, 'workspaces');
      await fs.mkdir(workspacesDir, { recursive: true });
      // The port is probed then handed to the child, which binds it a moment later: another
      // process can take it in between. The supervisor reports a failed bind (EADDRINUSE) on its
      // output; on that we kill it and retry with a fresh port.
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= LOCAL_SUPERVISOR_PORT_ATTEMPTS; attempt++) {
        const port = await this.allocatePort();
        const outcome = await this.launchLocalSupervisor(port, workspacesDir);
        if (outcome.kind === 'ready') return outcome.url;
        lastError = outcome.error;
        if (outcome.kind !== 'port_in_use') throw outcome.error;
        logger.warn('local workspace supervisor: port taken before it could bind; retrying on a fresh port', {
          port,
          attempt,
        });
      }
      throw lastError instanceof Error ? lastError : new Error('Local workspace supervisor could not bind a port');
    })().finally(() => {
      this.startingSupervisor = null;
    });

    return this.startingSupervisor;
  }

  /** Single-flight: concurrent callers share one in-flight /health request. */
  private fetchSupervisorHealth(hostUrl: string): Promise<SupervisorHealthResponse> {
    if (this.healthInflight) return this.healthInflight;
    const p = this.fetchSupervisorHealthOnce(hostUrl)
      .then(
        (data) => {
          this.lastHealthError = null;
          return data;
        },
        (err: unknown) => {
          this.lastHealthError = { message: err instanceof Error ? err.message : String(err), at: this.clock.now() };
          throw err;
        },
      )
      .finally(() => {
        if (this.healthInflight === p) this.healthInflight = null;
      });
    this.healthInflight = p;
    return p;
  }

  private async fetchSupervisorHealthOnce(hostUrl: string): Promise<SupervisorHealthResponse> {
    // Ensure zero-config HKDF handshake is pushed when connecting to remote workspaces container
    if (this.config.workspaceHostUrl && !this.config.workspaceHostSecret && !this.handshookInstanceId) {
      await this.performHandshake(hostUrl);
    }

    let res = await this.fetchImpl(`${hostUrl}/health`, {
      headers: this.authHeaders(),
      signal: this.clock.timeoutSignal(4000),
    });
    if (res.status === 401 && this.config.workspaceHostUrl && !this.config.workspaceHostSecret) {
      const ok = await this.performHandshake(hostUrl);
      if (ok) {
        res = await this.fetchImpl(`${hostUrl}/health`, {
          headers: this.authHeaders(),
          signal: this.clock.timeoutSignal(4000),
        });
      }
    }
    if (res.status === 401) {
      throw new Error(
        'Unauthorized contacting workspaces supervisor — ensure SESSION_SECRET / WORKSPACE_HOST_SECRET matches on control-plane and workspaces.',
      );
    }
    if (!res.ok) {
      throw new Error(`Workspaces supervisor health check failed (HTTP ${res.status})`);
    }
    const data = parseSupervisorResponse(
      SupervisorHealthSchema,
      await orDefault(res.json(), null, 'supervisor health: response is not JSON', {}, 'debug'),
      'health',
    ) as unknown as SupervisorHealthResponse;
    if (data.protocolVersion !== WORKSPACE_HOST_PROTOCOL_VERSION) {
      throw new Error(
        `Workspace host protocol version mismatch (control-plane expects v${WORKSPACE_HOST_PROTOCOL_VERSION}, workspaces is v${data.protocolVersion}). Please update both halley-control-plane and halley-workspace images to the same version.`,
      );
    }
    if (this.config.workspaceHostUrl && this.handshookInstanceId !== data.instanceId) {
      const ok = await this.performHandshake(hostUrl);
      if (ok) this.handshookInstanceId = data.instanceId;
    }
    if (data.warmPool) {
      this.lastWarmPoolStatus = data.warmPool;
    }
    this.astroReadySet = new Set(data.astroReadySessionIds ?? data.activeSessionIds ?? []);
    this.cachedHealth = { data, at: this.clock.now() };
    return data;
  }

  private async getCachedSupervisorHealth(
    hostUrl: string,
    maxAgeMs = 3_000,
  ): Promise<SupervisorHealthResponse> {
    if (this.cachedHealth && this.clock.now() - this.cachedHealth.at < maxAgeMs) {
      return this.cachedHealth.data;
    }
    return this.fetchSupervisorHealth(hostUrl);
  }

  /**
   * Readiness probe answer: a fresh-enough cached health sample, else one single-flight /health
   * call. A recent failure is reused for `maxAgeMs` so a down supervisor is not hammered by probes.
   */
  async getSupervisorReadiness(maxAgeMs = 5_000): Promise<SupervisorReadiness> {
    const now = this.clock.now();
    if (this.cachedHealth && now - this.cachedHealth.at < maxAgeMs) {
      return { ok: true, ageMs: now - this.cachedHealth.at };
    }
    if (this.lastHealthError && now - this.lastHealthError.at < maxAgeMs && !this.healthInflight) {
      return { ok: false, error: this.lastHealthError.message, ageMs: now - this.lastHealthError.at };
    }
    try {
      const hostUrl = await this.getHostUrl();
      await this.getCachedSupervisorHealth(hostUrl, maxAgeMs);
      return { ok: true, ageMs: 0 };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), ageMs: 0 };
    }
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
    if (restarted) {
      this.handshookInstanceId = null;
    }

    const activeSet = new Set(health.activeSessionIds ?? []);
    this.astroReadySet = new Set(health.astroReadySessionIds ?? health.activeSessionIds ?? []);
    const sessions = this.db.listSessions();
    let reconciled = 0;
    for (const s of sessions) {
      if (this.booting.has(s.id)) continue;
      const hasLiveUrls = Boolean(s.runner_url || s.astro_url);
      const isMarkedActive =
        s.status === 'running' ||
        s.status === 'starting' ||
        ((s.status === 'published' || s.status === 'merged') && hasLiveUrls);
      if (isMarkedActive && !activeSet.has(s.id)) {
        const isFrozen = s.status === 'published' || s.status === 'merged';
        this.db.transitionSession(s.id, {
          expectedEpoch: s.lease_epoch,
          allowUnfreeze: isFrozen,
          patch: {
            status: isFrozen ? s.status : 'sleeping',
            runner_url: null,
            astro_url: null,
          },
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
    const mirrorExists = await pathExists(path.join(mirrorDir, 'HEAD'));

    if (!opts?.force && mirrorExists && this.clock.now() - this.lastMirrorSyncAt < ttlMs) {
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
        : opts?.token ||
          (await this.github.getAccessToken().catch((err) => {
            ignore(err, 'mirror sync: no GitHub token; fetching anonymously', { baseBranch }, 'debug');
            return undefined;
          }));
      await ensureBareMirror(
        mirrorDir,
        this.config.repo,
        token,
        this.config.devLocalRepo || undefined,
        baseBranch,
      );
      await configureBareMirrorForHttp(mirrorDir);
      this.lastMirrorSyncAt = this.clock.now();
      this.notifyMirrorUpdated(baseBranch);
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
      const res = await this.fetchImpl(`${hostUrl}/api/warm/reserve`, {
        method: 'POST',
        headers: this.authHeaders(),
        signal: this.clock.timeoutSignal(3000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { reserved: WarmReservation | null };
      if (data.reserved) {
        this.emitProgress(data.reserved.id, 'claiming_warm', 'Connecting to ready workspace…', {
          warmHit: true,
        });
      }
      return data.reserved;
    } catch (err) {
      ignore(err, 'warm pool reserve failed; booting a fresh workspace', {}, 'debug');
      return null;
    }
  }

  async releaseWarmWorkspace(id: string): Promise<void> {
    this.bootProgress.delete(id);
    try {
      const hostUrl = await this.getHostUrl();
      const res = await this.fetchImpl(`${hostUrl}/api/warm/release/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: this.authHeaders(),
        signal: this.clock.timeoutSignal(5000),
      });
      if (!res.ok && res.status !== 404) {
        logger.warn('warm pool release returned an error', { warmId: id, status: res.status });
      }
    } catch (err) {
      // The supervisor reclaims unclaimed reservations on its own; leave a trace only
      ignore(err, 'warm pool release failed', { warmId: id });
    }
  }

  ensureRunning(session: SessionRecord): Promise<WorkspaceEndpoint> {
    // Strictly single-flight: the promise is registered before any await, so N concurrent callers
    // for a sleeping session produce exactly one supervisor /start.
    const pending = this.ensureInflight.get(session.id);
    if (pending) return pending;
    const p: Promise<WorkspaceEndpoint> = this.ensureRunningOnce(session).finally(() => {
      if (this.ensureInflight.get(session.id) === p) this.ensureInflight.delete(session.id);
    });
    this.ensureInflight.set(session.id, p);
    return p;
  }

  private async ensureRunningOnce(session: SessionRecord): Promise<WorkspaceEndpoint> {
    const latest = this.db.getSession(session.id) ?? session;

    // Fast path: if the session already has live URLs and the supervisor confirms it is active,
    // return immediately without hitting GitHub, emitting boot_progress, or writing to SQLite.
    if (latest.runner_url && latest.astro_url) {
      this.ensureSessionToken(latest.id);
      try {
        const hostUrl = await this.getHostUrl();
        const health = await this.getCachedSupervisorHealth(hostUrl);
        if (health.activeSessionIds?.includes(latest.id)) {
          return {
            runnerUrl: latest.runner_url,
            astroUrl: latest.astro_url,
            astroBase: latest.astro_base || '/',
            baseSha: latest.base_sha,
          };
        }
        // Supervisor no longer has this session active (e.g. LRU eviction or restart)
        this.reconcileFromHealth(health);
        this.cachedHealth = null;
      } catch (err) {
        // Fall through to the full startOrWake, which retries health with a deadline
        ignore(err, 'ensureRunning fast path: supervisor health unavailable', { sessionId: latest.id }, 'debug');
      }
    }

    return this.bootSession(this.db.getSession(session.id) ?? latest);
  }

  /** Crash-loop gate + startOrWake, tracked in `booting` so reconcile leaves the row alone. */
  private bootSession(latest: SessionRecord): Promise<WorkspaceEndpoint> {
    try {
      this.crashTracker.assertCanAttempt(latest.id);
    } catch (err) {
      if (err instanceof WorkspaceCrashLoopError) {
        this.emitProgress(
          latest.id,
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
      return Promise.reject(err);
    }

    const p: Promise<WorkspaceEndpoint> = this.startOrWake(latest).finally(() => {
      if (this.booting.get(latest.id) === p) {
        this.booting.delete(latest.id);
      }
    });
    this.booting.set(latest.id, p);
    return p;
  }

  private async startOrWake(session: SessionRecord): Promise<WorkspaceEndpoint> {
    const startRow = this.db.getSession(session.id) ?? session;
    const leaseEpoch = startRow.lease_epoch ?? 0;
    const initialFrozen = startRow.status === 'published' || startRow.status === 'merged';
    try {
      const hostUrl = await this.getHostUrl();
      let health: SupervisorHealthResponse;
      const healthDeadline = this.clock.now() + 15_000;
      for (;;) {
        try {
          health = await this.fetchSupervisorHealth(hostUrl);
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isPermanent =
            msg.includes('Unauthorized') || msg.includes('protocol version mismatch');
          if (isPermanent || this.clock.now() >= healthDeadline) {
            throw err;
          }
          ignore(err, 'supervisor health check failed; retrying', { sessionId: session.id }, 'debug');
          await this.clock.sleep(1_000);
        }
      }
      // Always reconcile DB state against supervisor activeSessionIds so LRU-evicted
      // sessions (where instanceId did not change) have their stale URLs cleared promptly.
      this.reconcileFromHealth(health);

      const alreadyActiveOnSupervisor = health.activeSessionIds?.includes(session.id) ?? false;

      // Refresh control-plane's bare mirror before asking workspaces to clone/sync
      if (!alreadyActiveOnSupervisor) {
        this.emitProgress(session.id, 'syncing_repo', 'Syncing latest website repository…');
        await this.ensureControlPlaneMirror(session.base_branch, { allowStaleOnError: true });
      }

      const currentRow = this.db.getSession(session.id) ?? startRow;
      const isFrozenNow = currentRow.status === 'published' || currentRow.status === 'merged';
      const workspaceToken = this.ensureSessionToken(session.id);
      const persona = this.db.getUserById(currentRow.owner_user_id)?.persona ?? 'non-technical';
      const activeRunIds = new Set(this.db.listActivePublishRuns().map((r) => r.session_id));
      const protectedSessionIds = this.db
        .listSessions()
        .filter(
          (s) =>
            activeRunIds.has(s.id) ||
            isPublishInFlight(s.publish_state) ||
            s.publish_state === 'failed_conflict',
        )
        .map((s) => s.id);

      // Poll supervisor boot progress while /start runs
      const pollAbort = new AbortController();
      let pollDelayMs = 400;
      let lastProgressKey: string | null = null;
      const pollProgress = async () => {
        while (!pollAbort.signal.aborted) {
          try {
            const pRes = await this.fetchImpl(
              `${hostUrl}/api/sessions/${encodeURIComponent(session.id)}/progress`,
              {
                headers: this.authHeaders(),
                signal: timeoutSignal(this.clock, 1500, pollAbort.signal),
              },
            );
            if (pRes.ok && !pollAbort.signal.aborted) {
              const pData = (await pRes.json()) as { progress: BootProgressDto | null };
              if (pData.progress && pData.progress.stage !== 'ready') {
                this.emitProgress(session.id, pData.progress.stage, pData.progress.message, {
                  detail: pData.progress.detail,
                  warmHit: pData.progress.warmHit,
                  startedAt: pData.progress.startedAt,
                });
              }
            }
          } catch (err) {
            // Expected when /start finishes (abort) or a single poll times out; progress is cosmetic
            if (!pollAbort.signal.aborted) {
              ignore(err, 'boot progress poll failed', { sessionId: session.id }, 'debug');
            }
          }
          if (pollAbort.signal.aborted) break;
          // Back off while the stage is unchanged (400ms -> 3s); a stage change resets it
          const cur = this.bootProgress.get(session.id);
          const key = cur ? `${cur.stage}\u0000${cur.message}` : '';
          pollDelayMs = key !== lastProgressKey ? 400 : Math.min(3000, Math.round(pollDelayMs * 1.5));
          lastProgressKey = key;
          await this.clock.sleep(pollDelayMs, pollAbort.signal);
        }
      };
      const pollLoop = alreadyActiveOnSupervisor ? Promise.resolve() : pollProgress();

      let startRes: Response;
      try {
        startRes = await this.fetchImpl(
          `${hostUrl}/api/sessions/${encodeURIComponent(session.id)}/start`,
          {
            method: 'POST',
            headers: this.authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
              baseBranch: currentRow.base_branch,
              workingBranch: currentRow.working_branch,
              baseSha: currentRow.base_sha,
              workspaceToken,
              persona,
              editorName: currentRow.owner_name || 'Editor',
              editorEmail: currentRow.owner_email || 'editor@example.com',
              readOnly: isFrozenNow,
              protectedSessionIds,
            }),
            signal: this.clock.timeoutSignal(120_000),
          },
        );
      } finally {
        pollAbort.abort();
        await pollLoop.catch((err) => ignore(err, 'boot progress poll loop failed', { sessionId: session.id }, 'debug'));
      }

      if (!startRes.ok) {
        const errData = (await orDefault(startRes.json(), {}, 'workspace start: error response is not JSON', {
          sessionId: session.id,
          status: startRes.status,
        }, 'debug')) as { error?: string };
        throw new Error(errData.error || `Workspace start failed (HTTP ${startRes.status})`);
      }

      const started = parseSupervisorResponse(
        StartResponseSchema,
        await orDefault(startRes.json(), null, 'workspace start: response is not JSON', { sessionId: session.id }, 'debug'),
        'start',
      );

      const hostHostname = new URL(hostUrl).hostname;
      const runnerUrl = `http://${hostHostname}:${started.runnerPort}`;
      const astroUrl = `http://${hostHostname}:${started.astroPort}`;
      const astroBase = started.astroBase || currentRow.astro_base || '/';
      const baseSha = started.baseSha || currentRow.base_sha;

      const afterStartRow = this.db.getSession(session.id);
      if (!afterStartRow) {
        // Session was deleted while booting; tear down immediately
        await this.fetchImpl(`${hostUrl}/api/sessions/${encodeURIComponent(session.id)}`, {
          method: 'DELETE',
          headers: this.authHeaders(),
          signal: this.clock.timeoutSignal(5000),
        }).catch((err) =>
          ignore(err, 'tearing down workspace of a session deleted during startup failed', { sessionId: session.id }),
        );
        throw new Error('Session was deleted during startup');
      }

      const frozenAfter =
        initialFrozen || afterStartRow.status === 'published' || afterStartRow.status === 'merged';
      this.db.transitionSession(session.id, {
        expectedEpoch: leaseEpoch,
        allowUnfreeze: frozenAfter,
        patch: {
          status: frozenAfter ? afterStartRow.status : 'running',
          base_sha: baseSha,
          runner_url: runnerUrl,
          astro_url: astroUrl,
          astro_base: astroBase,
          node_modules_pruned_at: null,
          last_active_at: new Date(this.clock.now()).toISOString(),
        },
      });

      this.astroReadySet.add(session.id);
      this.cachedHealth = null;
      this.crashTracker.recordSuccess(session.id);
      if (!alreadyActiveOnSupervisor) {
        this.emitProgress(session.id, 'ready', 'Workspace ready!');
      }
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
        this.db.transitionSession(session.id, {
          expectedEpoch: leaseEpoch,
          patch: { status: 'error', runner_url: null, astro_url: null },
        });
      }
      throw err;
    }
  }

  async stop(session: SessionRecord): Promise<void> {
    this.bootProgress.delete(session.id);
    this.astroReadySet.delete(session.id);
    this.lastTouchedAt.delete(session.id);
    this.cachedHealth = null;
    try {
      const hostUrl = await this.getHostUrl();
      const res = await this.fetchImpl(`${hostUrl}/api/sessions/${encodeURIComponent(session.id)}/stop`, {
        method: 'POST',
        headers: this.authHeaders(),
        signal: this.clock.timeoutSignal(5000),
      });
      if (!res.ok && res.status !== 404) {
        logger.warn('supervisor stop returned an error; marking session asleep anyway', {
          sessionId: session.id,
          status: res.status,
        });
      }
    } catch (err) {
      // Supervisor unavailable: the reconcile pass will catch up once it is back.
      ignore(err, 'supervisor stop failed; marking session asleep anyway', { sessionId: session.id });
    }
    const latest = this.db.getSession(session.id) ?? session;
    const isFrozen = latest.status === 'published' || latest.status === 'merged';
    this.db.transitionSession(session.id, {
      bumpEpoch: true,
      allowUnfreeze: isFrozen,
      patch: {
        status: isFrozen ? latest.status : 'sleeping',
        runner_url: null,
        astro_url: null,
      },
    });
  }

  /**
   * Restarts the workspace. Registers itself as the session's single in-flight boot (so concurrent
   * ensureRunning callers join the restart instead of starting their own), and first lets any boot
   * already in flight settle (bounded) so the two never race on the supervisor or the lease.
   */
  restart(session: SessionRecord): Promise<WorkspaceEndpoint> {
    const previous = this.ensureInflight.get(session.id);
    const p: Promise<WorkspaceEndpoint> = this.restartOnce(session, previous).finally(() => {
      if (this.ensureInflight.get(session.id) === p) this.ensureInflight.delete(session.id);
    });
    this.ensureInflight.set(session.id, p);
    return p;
  }

  private async restartOnce(
    session: SessionRecord,
    previous: Promise<WorkspaceEndpoint> | undefined,
  ): Promise<WorkspaceEndpoint> {
    if (previous) {
      let timer: ReturnType<Clock['setTimeout']> | null = null;
      await Promise.race([
        previous.then(
          () => undefined,
          (err) => ignore(err, 'restart: superseded boot failed', { sessionId: session.id }, 'debug'),
        ),
        new Promise<void>((resolve) => {
          timer = this.clock.setTimeout(resolve, 15_000);
        }),
      ]);
      this.clock.clearTimeout(timer);
    }
    this.crashTracker.reset(session.id);
    this.bootProgress.delete(session.id);
    this.astroReadySet.delete(session.id);
    this.cachedHealth = null;
    const latestBefore = this.db.getSession(session.id) ?? session;
    const isFrozen = latestBefore.status === 'published' || latestBefore.status === 'merged';
    this.db.transitionSession(session.id, {
      bumpEpoch: true,
      allowUnfreeze: isFrozen,
      patch: {
        status: isFrozen ? latestBefore.status : 'starting',
        runner_url: null,
        astro_url: null,
      },
    });
    try {
      const hostUrl = await this.getHostUrl();
      const res = await this.fetchImpl(`${hostUrl}/api/sessions/${encodeURIComponent(session.id)}/restart`, {
        method: 'POST',
        headers: this.authHeaders(),
        signal: this.clock.timeoutSignal(5000),
      });
      if (!res.ok && res.status !== 404) {
        logger.warn('supervisor restart returned an error; starting the workspace anyway', {
          sessionId: session.id,
          status: res.status,
        });
      }
    } catch (err) {
      // The boot below goes through /start, which recreates the runner if it is not running
      ignore(err, 'supervisor restart request failed; starting the workspace anyway', { sessionId: session.id });
    }
    const fresh = this.db.getSession(session.id) ?? session;
    return this.bootSession(fresh);
  }

  async destroy(session: SessionRecord): Promise<void> {
    this.bootProgress.delete(session.id);
    this.astroReadySet.delete(session.id);
    this.customSessionTokens.delete(session.id);
    this.lastTouchedAt.delete(session.id);
    this.crashTracker.reset(session.id);
    this.booting.delete(session.id);
    this.ensureInflight.delete(session.id);
    this.cachedHealth = null;
    this.db.transitionSession(session.id, {
      bumpEpoch: true,
      allowUnfreeze: true,
      patch: { runner_url: null, astro_url: null },
    });
    // Failures propagate: callers (reaper, DELETE /api/sessions/:id) must not record the volume as
    // gone or drop the DB row when the supervisor did not actually delete it.
    const hostUrl = await this.getHostUrl();
    const res = await this.fetchImpl(`${hostUrl}/api/sessions/${encodeURIComponent(session.id)}`, {
      method: 'DELETE',
      headers: this.authHeaders(),
      signal: this.clock.timeoutSignal(10_000),
    });
    if (!res.ok && res.status !== 404) {
      const body = await orDefault(res.text(), '', 'workspace destroy: reading error body failed', {
        sessionId: session.id,
        status: res.status,
      }, 'debug');
      throw new Error(`Workspace destroy failed (HTTP ${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
  }

  async pruneNodeModules(session: SessionRecord): Promise<void> {
    const hostUrl = await this.getHostUrl();
    const res = await this.fetchImpl(
      `${hostUrl}/api/sessions/${encodeURIComponent(session.id)}/prune-node-modules`,
      {
        method: 'POST',
        headers: this.authHeaders(),
        signal: this.clock.timeoutSignal(15_000),
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
    const res = await this.fetchImpl(
      `${hostUrl}/api/sessions/${encodeURIComponent(source.id)}/duplicate`,
      {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          targetSessionId: target.id,
          targetWorkingBranch: target.working_branch,
          mode,
        }),
        signal: this.clock.timeoutSignal(30_000),
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
    const res = await this.fetchImpl(
      `${hostUrl}/api/sessions/${encodeURIComponent(session.id)}/git/fetch`,
      {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ baseBranch: session.base_branch }),
        signal: this.clock.timeoutSignal(30_000),
      },
    );
    if (!res.ok) {
      throw new Error(`Workspace git fetch failed (${res.status}): ${await res.text()}`);
    }
  }

  async pushSessionBranch(session: SessionRecord, token: string, opts?: { sha?: string }): Promise<void> {
    // 1. Ensure control-plane's bare mirror is ready to receive the halley/* branch
    const mirrorDir = await this.ensureControlPlaneMirror(session.base_branch, {
      allowStaleOnError: true,
      token: token || undefined,
    });

    // 2. Ask workspaces supervisor to push session.working_branch to control-plane's internal HTTP git server
    const hostUrl = await this.getHostUrl();
    const res = await this.fetchImpl(
      `${hostUrl}/api/sessions/${encodeURIComponent(session.id)}/git/push`,
      {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        // `sha`: the exact verified commit the supervisor must push (`<sha>:refs/heads/<branch>`)
        body: JSON.stringify({ workingBranch: session.working_branch, ...(opts?.sha ? { sha: opts.sha } : {}) }),
        signal: this.clock.timeoutSignal(30_000),
      },
    );
    if (!res.ok) {
      throw new Error(`Workspace git push to control-plane failed (${res.status}): ${await res.text()}`);
    }

    // 3. Push the received halley/* branch from control-plane's bare mirror to GitHub (or devLocalRepo)
    if (!session.working_branch.startsWith('halley/')) {
      throw new Error(`Refusing to push non-halley branch: ${session.working_branch}`);
    }
    if (opts?.sha) {
      // Fail closed: never forward anything but the verified commit (an older supervisor pushes
      // whatever HEAD is at push time, which may include unverified edits).
      const received = await runGit(mirrorDir, ['rev-parse', '--verify', `refs/heads/${session.working_branch}^{commit}`]);
      if (received !== opts.sha) {
        throw new Error(
          `Workspace pushed ${received.slice(0, 7)} but the verified commit is ${opts.sha.slice(0, 7)}; refusing to publish unverified changes. Please click Publish again.`,
        );
      }
    }
    const refspec = `refs/heads/${session.working_branch}:refs/heads/${session.working_branch}`;
    await unsetGitConfig(mirrorDir, 'remote.origin.mirror');
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
        [
          '-c',
          'remote.origin.mirror=false',
          '-c',
          'http.lowSpeedLimit=1',
          '-c',
          'http.lowSpeedTime=20',
          'push',
          '--force',
          'origin',
          refspec,
        ],
        env,
        45_000,
      );
    });
  }

  async getSessionLogs(sessionId: string): Promise<string[]> {
    try {
      const hostUrl = await this.getHostUrl();
      const res = await this.fetchImpl(
        `${hostUrl}/api/sessions/${encodeURIComponent(sessionId)}/logs`,
        { headers: this.authHeaders(), signal: this.clock.timeoutSignal(3000) },
      );
      if (!res.ok) return [];
      const data = (await res.json()) as { lines?: string[] };
      return Array.isArray(data.lines) ? data.lines : [];
    } catch (err) {
      ignore(err, 'reading session logs from supervisor failed', { sessionId }, 'debug');
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

  async scanRepository(baseBranch: string): Promise<{
    sha: string;
    report: AstroAuditReportDto;
    digest: string;
  }> {
    const hostUrl = await this.getHostUrl();
    await this.ensureControlPlaneMirror(baseBranch, { allowStaleOnError: true });
    const res = await this.fetchImpl(`${hostUrl}/api/optimize/scan`, {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        baseBranch,
        repo: this.config.repo,
      }),
      signal: this.clock.timeoutSignal(45_000),
    });
    if (!res.ok) {
      const errData = (await orDefault(res.json(), {}, 'optimize scan: error response is not JSON', {
        status: res.status,
      }, 'debug')) as { error?: string };
      throw new Error(
        errData.error || `Repository optimization scan failed (HTTP ${res.status})`,
      );
    }
    return (await res.json()) as {
      sha: string;
      report: AstroAuditReportDto;
      digest: string;
    };
  }

  async close(): Promise<void> {
    if (this.localSupervisorProc && this.localSupervisorProc.exitCode === null) {
      this.localSupervisorProc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = this.clock.setTimeout(resolve, 1500);
        this.localSupervisorProc?.once('exit', () => {
          this.clock.clearTimeout(t);
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
