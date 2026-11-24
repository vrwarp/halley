import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import type { BootProgressDto, BootStage } from '@halley/shared';
import type { HalleyConfig } from '../config.js';
import type { ControlPlaneDb, SessionRecord } from '../db.js';
import type { GitHubService } from '../github/client.js';
import { hashWorkspaceToken } from '../proxy/llm-proxy.js';
import {
  ensureBareMirror,
  runGit,
  withGitAskPass,
  type BootProgressListener,
  type WarmPoolStatus,
  type WarmReservation,
  type WorkspaceDriver,
  type WorkspaceEndpoint,
} from './workspace-driver.js';

const execFileAsync = promisify(execFile);

/** Returns true if a container's Env array is missing WORKSPACE_TOKEN or has an empty value. */
export function hasEmptyWorkspaceToken(env?: string[]): boolean {
  if (!Array.isArray(env)) return false;
  const entry = env.find((e) => e.startsWith('WORKSPACE_TOKEN='));
  if (entry === undefined) return true;
  return entry.slice('WORKSPACE_TOKEN='.length).trim().length === 0;
}

const BOOT_STAGE_MESSAGES: Partial<Record<BootStage, string>> = {
  cloning_repo: 'Cloning website files…',
  installing_deps: 'Installing project packages…',
  starting_preview: 'Starting Astro live preview…',
  starting_ai: 'Starting AI editing assistant…',
  ready: 'Workspace ready!',
};

function parseBootStageFromLogs(logs: string): { stage: BootStage; message: string } | null {
  const matches = [...logs.matchAll(/\[halley-boot\]\s+([a-z_]+)/g)];
  const last = matches.at(-1)?.[1] as BootStage | undefined;
  if (!last) return null;
  const message = BOOT_STAGE_MESSAGES[last];
  if (!message) return null;
  return { stage: last, message };
}

interface WarmSlot {
  id: string;
  volumeName: string;
  containerName: string;
  rawToken: string;
  containerId: string | null;
  state: 'warming' | 'ready' | 'failed';
  baseSha: string;
  astroBase: string;
  runnerUrl: string;
  astroUrl: string;
  progress: BootProgressDto;
  bootPromise: Promise<void>;
  claimedBySessionId: string | null;
}

function dockerRequest<T>(
  method: string,
  reqPath: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        socketPath: '/var/run/docker.sock',
        path: reqPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data: unknown = text;
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            // keep text
          }
          resolve({ status: res.statusCode ?? 500, data: data as T });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export interface DoctorCheckResult {
  ok: boolean;
  warnings: string[];
  errors: string[];
  details: Record<string, unknown>;
}

export class DockerWorkspaceDriver implements WorkspaceDriver {
  private sessionTokens = new Map<string, string>();
  private booting = new Map<string, Promise<WorkspaceEndpoint>>();
  private pullingImages = new Map<string, Promise<void>>();
  private resolvedNetwork: string | null = null;
  private bootProgress = new Map<string, BootProgressDto>();
  private bootProgressListener: BootProgressListener | null = null;

  private warmPool: WarmSlot[] = [];
  private reservedWarmSlots = new Map<string, WarmSlot>();
  private warmPoolRunning = false;
  private warmHealthTimer: NodeJS.Timeout | null = null;

  constructor(
    private config: HalleyConfig,
    private db: ControlPlaneDb,
    private github: GitHubService,
  ) {}

  setRawWorkspaceToken(sessionId: string, token: string): void {
    this.sessionTokens.set(sessionId, token);
  }

  /**
   * Returns the cached raw WORKSPACE_TOKEN for a session, or mints a fresh one
   * and updates workspace_token_hash in SQLite (e.g. when recreating a container
   * after a control-plane restart wiped the in-memory token map).
   */
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

  private emitProgress(
    sessionId: string,
    stage: BootStage,
    message: string,
    opts?: { detail?: string; warmHit?: boolean; startedAt?: string },
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
    };
    this.bootProgress.set(sessionId, progress);
    this.bootProgressListener?.(sessionId, progress);
    return progress;
  }

  private containerName(sessionId: string): string {
    return `halley-ws-${sessionId.slice(0, 12)}`;
  }

  getWarmPoolStatus(): WarmPoolStatus {
    return {
      enabled: this.config.warmPoolSize > 0,
      target: this.config.warmPoolSize,
      ready: this.warmPool.filter((s) => s.state === 'ready').length,
      warming: this.warmPool.filter((s) => s.state === 'warming').length,
    };
  }

  startWarmPool(): void {
    if (this.config.warmPoolSize <= 0 || this.warmPoolRunning) return;
    this.warmPoolRunning = true;
    console.log(`[halley-warm-pool] Starting warm standby pool (target=${this.config.warmPoolSize})`);

    void this.cleanupOrphanedWarmContainers()
      .catch((err) => {
        console.warn('[halley-warm-pool] Failed to clean up orphaned warm containers:', err);
      })
      .finally(() => {
        if (this.warmPoolRunning) {
          this.replenishWarmPool();
        }
      });

    this.warmHealthTimer = setInterval(() => {
      void this.checkWarmPoolHealth();
    }, 120_000);
    this.warmHealthTimer.unref?.();
  }

  async stopWarmPool(): Promise<void> {
    this.warmPoolRunning = false;
    if (this.warmHealthTimer) {
      clearInterval(this.warmHealthTimer);
      this.warmHealthTimer = null;
    }
    const slots = this.warmPool.splice(0, this.warmPool.length);
    await Promise.all(slots.map((slot) => this.destroyWarmSlot(slot)));
  }

  reserveWarmWorkspace(): WarmReservation | null {
    if (this.config.warmPoolSize <= 0) return null;

    // Prefer an already-ready hot container; otherwise adopt an in-progress warming container
    let idx = this.warmPool.findIndex((s) => s.state === 'ready');
    if (idx === -1) {
      idx = this.warmPool.findIndex((s) => s.state === 'warming');
    }
    if (idx === -1) return null;

    const [slot] = this.warmPool.splice(idx, 1);
    if (!slot) return null;

    slot.claimedBySessionId = slot.id;
    this.reservedWarmSlots.set(slot.id, slot);

    const adoptedWarming = slot.state === 'warming';
    if (adoptedWarming) {
      this.emitProgress(slot.id, slot.progress.stage, slot.progress.message, {
        startedAt: slot.progress.startedAt,
        warmHit: true,
      });
    } else {
      this.emitProgress(slot.id, 'claiming_warm', 'Connecting to ready workspace…', {
        warmHit: true,
      });
    }

    // Replenish a fresh warm standby container in the background for the next edit
    setTimeout(() => {
      if (this.warmPoolRunning) this.replenishWarmPool();
    }, 100);

    return {
      id: slot.id,
      volumeName: slot.volumeName,
      rawToken: slot.rawToken,
      adoptedWarming,
    };
  }

  private async cleanupOrphanedWarmContainers(): Promise<void> {
    const activeSessionIds = new Set(this.db.listSessions().map((s) => s.id));
    const filter = encodeURIComponent(JSON.stringify({ label: ['halley.role=warm-standby'] }));
    const res = await dockerRequest<
      Array<{ Id: string; Names?: string[]; Labels?: Record<string, string> }>
    >('GET', `/containers/json?all=true&filters=${filter}`);
    if (res.status !== 200 || !Array.isArray(res.data)) return;

    for (const c of res.data) {
      const warmId = c.Labels?.['halley.warm_id'];
      if (warmId && activeSessionIds.has(warmId)) {
        // Already claimed by a real session — leave it untouched
        continue;
      }
      console.log(`[halley-warm-pool] Cleaning up orphaned standby container ${c.Names?.[0] ?? c.Id.slice(0, 12)}`);
      await dockerRequest('DELETE', `/containers/${c.Id}?force=true`).catch(() => {});
      if (warmId) {
        await dockerRequest('DELETE', `/volumes/halley-ws-${warmId}`).catch(() => {});
      }
    }
  }

  private async checkWarmPoolHealth(): Promise<void> {
    if (!this.warmPoolRunning) return;
    const toRemove: WarmSlot[] = [];
    for (const slot of this.warmPool) {
      if (slot.state !== 'ready') continue;
      try {
        const res = await fetch(`${slot.runnerUrl}/health`, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) toRemove.push(slot);
      } catch {
        toRemove.push(slot);
      }
    }
    for (const slot of toRemove) {
      const idx = this.warmPool.indexOf(slot);
      if (idx !== -1) this.warmPool.splice(idx, 1);
      console.warn(`[halley-warm-pool] Standby container ${slot.containerName} became unhealthy; replacing…`);
      await this.destroyWarmSlot(slot);
    }
    this.replenishWarmPool();
  }

  private replenishWarmPool(): void {
    if (!this.warmPoolRunning) return;
    // Remove any failed slots first
    this.warmPool = this.warmPool.filter((s) => s.state !== 'failed');

    while (this.warmPool.length < this.config.warmPoolSize) {
      const id = crypto.randomUUID();
      const volumeName = `halley-ws-${id}`;
      const containerName = this.containerName(id);
      const rawToken = crypto.randomBytes(24).toString('hex');
      const now = new Date().toISOString();

      const slot: WarmSlot = {
        id,
        volumeName,
        containerName,
        rawToken,
        containerId: null,
        state: 'warming',
        baseSha: '',
        astroBase: '/',
        runnerUrl: `http://${containerName}:4100`,
        astroUrl: `http://${containerName}:4321`,
        progress: {
          stage: 'syncing_repo',
          message: 'Preparing standby workspace…',
          startedAt: now,
          updatedAt: now,
          warmHit: true,
        },
        bootPromise: Promise.resolve(),
        claimedBySessionId: null,
      };

      slot.bootPromise = this.bootWarmSlot(slot);
      this.warmPool.push(slot);
    }
  }

  private async destroyWarmSlot(slot: WarmSlot): Promise<void> {
    await dockerRequest('DELETE', `/containers/${slot.containerName}?force=true`).catch(() => {});
    await dockerRequest('DELETE', `/volumes/${slot.volumeName}`).catch(() => {});
  }

  private updateWarmSlotProgress(slot: WarmSlot, stage: BootStage, message: string): void {
    const now = new Date().toISOString();
    slot.progress = {
      stage,
      message,
      startedAt: slot.progress.startedAt,
      updatedAt: now,
      warmHit: true,
    };
    if (slot.claimedBySessionId) {
      this.emitProgress(slot.claimedBySessionId, stage, message, {
        startedAt: slot.progress.startedAt,
        warmHit: true,
      });
    }
  }

  private async bootWarmSlot(slot: WarmSlot): Promise<void> {
    try {
      console.log(`[halley-warm-pool] Warming standby container ${slot.containerName}…`);
      this.updateWarmSlotProgress(slot, 'syncing_repo', 'Syncing latest website repository…');
      const token = this.config.devLocalRepo
        ? ''
        : await this.github.getAccessToken().catch(() => '');
      const mirrorDir = path.join(this.config.dataDir, 'git-mirror', 'repo.git');
      await ensureBareMirror(
        mirrorDir,
        this.config.repo,
        token || undefined,
        this.config.devLocalRepo || undefined,
      );
      slot.baseSha = await runGit(mirrorDir, ['rev-parse', `refs/heads/${this.config.baseBranch}`]).catch(() => '');

      this.updateWarmSlotProgress(slot, 'checking_image', 'Checking workspace container image…');
      await this.ensureImagePresent(this.config.workspaceImage, () => {
        this.updateWarmSlotProgress(slot, 'pulling_image', 'Pulling workspace container image…');
      });
      const networkName = await this.resolveDockerNetwork();

      this.updateWarmSlotProgress(slot, 'creating_container', 'Creating standby workspace container…');
      await dockerRequest('POST', '/volumes/create', { Name: slot.volumeName });
      await dockerRequest('POST', '/volumes/create', { Name: 'halley-pkg-cache' });
      await dockerRequest('POST', '/volumes/create', { Name: 'halley-git-mirror' });

      const env = [
        `HALLEY_SESSION_ID=${slot.id}`,
        `HALLEY_REPO=${this.config.repo}`,
        `HALLEY_BASE_BRANCH=${this.config.baseBranch}`,
        `HALLEY_WORKING_BRANCH=halley/standby-${slot.id.slice(0, 6)}`,
        `HALLEY_BASE_SHA=${slot.baseSha}`,
        `HALLEY_MIRROR_PATH=/halley-mirror/repo.git`,
        `RUNNER_PORT=4100`,
        `ASTRO_PORT=4321`,
        `CONTROL_PLANE_INTERNAL_URL=${this.config.controlPlaneInternalUrl}`,
        `WORKSPACE_TOKEN=${slot.rawToken}`,
        `HALLEY_MODEL_ID=${this.config.modelId}`,
        `HALLEY_THINKING_LEVEL=${this.config.thinkingLevel}`,
        `HALLEY_PERSONA=non-technical`,
        `HALLEY_GIT_BOT_NAME=${this.config.gitBotName}`,
        `HALLEY_GIT_BOT_EMAIL=${this.config.gitBotEmail}`,
        `HALLEY_EDITOR_NAME=Editor`,
        `HALLEY_EDITOR_EMAIL=editor@example.com`,
        `HALLEY_READ_ONLY=false`,
      ];

      const created = await dockerRequest<{ Id: string }>('POST', `/containers/create?name=${slot.containerName}`, {
        Image: this.config.workspaceImage,
        Env: env,
        Labels: {
          'halley.role': 'warm-standby',
          'halley.warm_id': slot.id,
          'halley.repo': this.config.repo,
        },
        HostConfig: {
          NetworkMode: networkName,
          Binds: [
            `${slot.volumeName}:/halley-volume`,
            `halley-pkg-cache:/halley-pkg-cache`,
            `halley-git-mirror:/halley-mirror`,
          ],
          Memory: 2 * 1024 * 1024 * 1024,
        },
      });
      if (created.status >= 400) {
        throw new Error(`Docker create failed: ${JSON.stringify(created.data)}`);
      }
      slot.containerId = created.data.Id;

      await execFileAsync('docker', ['cp', mirrorDir, `${slot.containerName}:/halley-mirror/`]);

      this.updateWarmSlotProgress(slot, 'starting_container', 'Starting workspace container…');
      const startRes = await dockerRequest<{ message?: string }>('POST', `/containers/${slot.containerName}/start`);
      if (startRes.status >= 400) {
        throw new Error(`Docker start failed (${startRes.status}): ${JSON.stringify(startRes.data)}`);
      }

      const health = await this.pollContainerReady(
        slot.containerName,
        slot.runnerUrl,
        (stage, msg) => this.updateWarmSlotProgress(slot, stage, msg),
      );
      slot.astroBase = health.originalBase || '/';
      if (health.baseSha) slot.baseSha = health.baseSha;
      slot.state = 'ready';
      console.log(`[halley-warm-pool] Standby container ${slot.containerName} is hot & ready (baseSha=${slot.baseSha.slice(0, 7)})`);
    } catch (err) {
      slot.state = 'failed';
      console.warn(`[halley-warm-pool] Failed to warm standby container ${slot.containerName}:`, err);
      const idx = this.warmPool.indexOf(slot);
      if (idx !== -1) this.warmPool.splice(idx, 1);
      await this.destroyWarmSlot(slot);
      // Retry warming after a backoff if not claimed
      if (!slot.claimedBySessionId && this.warmPoolRunning) {
        setTimeout(() => {
          if (this.warmPoolRunning) this.replenishWarmPool();
        }, 30_000).unref?.();
      }
    }
  }

  /**
   * Resolves which user-defined Docker bridge network workspace containers should join.
   * Priority:
   * 1. Explicit `WORKSPACE_DOCKER_NETWORK` if configured and present on the Docker daemon.
   * 2. Auto-detect `control-plane`'s own attached non-default network via container self-inspect.
   * 3. Auto-create a user-defined bridge network `halley-net`.
   */
  async resolveDockerNetwork(): Promise<string> {
    if (this.resolvedNetwork) return this.resolvedNetwork;

    if (this.config.workspaceDockerNetwork) {
      const check = await dockerRequest('GET', `/networks/${encodeURIComponent(this.config.workspaceDockerNetwork)}`);
      if (check.status === 200) {
        this.resolvedNetwork = this.config.workspaceDockerNetwork;
        return this.resolvedNetwork;
      }
      console.warn(
        `[halley-docker] Configured WORKSPACE_DOCKER_NETWORK="${this.config.workspaceDockerNetwork}" not found; auto-detecting network…`,
      );
    }

    const os = await import('node:os');
    const self = await dockerRequest<{
      NetworkSettings?: { Networks?: Record<string, unknown> };
    }>('GET', `/containers/${encodeURIComponent(os.hostname())}/json`).catch(() => null);

    if (self?.status === 200 && self.data?.NetworkSettings?.Networks) {
      const attached = Object.keys(self.data.NetworkSettings.Networks).filter(
        (n) => n !== 'bridge' && n !== 'host' && n !== 'none',
      );
      if (attached[0]) {
        this.resolvedNetwork = attached[0];
        return this.resolvedNetwork;
      }
    }

    const fallback = this.config.workspaceDockerNetwork || 'halley-net';
    const checkFallback = await dockerRequest('GET', `/networks/${encodeURIComponent(fallback)}`);
    if (checkFallback.status === 404) {
      await dockerRequest('POST', '/networks/create', {
        Name: fallback,
        Driver: 'bridge',
      });
    }
    this.resolvedNetwork = fallback;
    return this.resolvedNetwork;
  }

  /**
   * Ensures `this.config.workspaceImage` exists locally on the Docker host; if missing,
   * automatically pulls it via `/images/create` (deduplicated across concurrent boots).
   */
  private async ensureImagePresent(
    image: string,
    onPullStart?: () => void,
  ): Promise<string | undefined> {
    const inspect = await dockerRequest<{ Id?: string }>(
      'GET',
      `/images/${encodeURIComponent(image)}/json`,
    );
    if (inspect.status === 200) return inspect.data?.Id;

    onPullStart?.();
    let pullPromise = this.pullingImages.get(image);
    if (!pullPromise) {
      console.log(`[halley-docker] Workspace image "${image}" not found locally — pulling from registry…`);
      pullPromise = new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            socketPath: '/var/run/docker.sock',
            path: `/images/create?fromImage=${encodeURIComponent(image)}`,
            method: 'POST',
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              if ((res.statusCode ?? 500) >= 400) {
                reject(
                  new Error(
                    `Failed to pull workspace image "${image}" (HTTP ${res.statusCode}): ${Buffer.concat(chunks).toString('utf8')}`,
                  ),
                );
                return;
              }
              console.log(`[halley-docker] Pulled workspace image "${image}" successfully.`);
              resolve();
            });
          },
        );
        req.on('error', reject);
        req.end();
      }).finally(() => {
        this.pullingImages.delete(image);
      });
      this.pullingImages.set(image, pullPromise);
    }

    await pullPromise;
    const after = await dockerRequest<{ Id?: string }>('GET', `/images/${encodeURIComponent(image)}/json`);
    return after.status === 200 ? after.data?.Id : undefined;
  }

  private async pollContainerReady(
    name: string,
    runnerUrl: string,
    onStage: (stage: BootStage, message: string) => void,
    timeoutMs = 120_000,
  ): Promise<{ originalBase?: string; astroReady?: boolean; baseSha?: string }> {
    const deadline = Date.now() + timeoutMs;
    let pollCount = 0;
    let lastStage: BootStage | null = null;

    while (Date.now() < deadline) {
      pollCount++;
      try {
        const res = await fetch(`${runnerUrl}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          const health = (await res.json()) as {
            originalBase?: string;
            astroReady?: boolean;
            baseSha?: string;
          };
          if (health.astroReady) return health;
        }
      } catch {
        // still booting
      }

      // Periodically read tail of container logs for [halley-boot] stage markers
      if (pollCount === 1 || pollCount % 2 === 0) {
        try {
          const logsRes = await dockerRequest<string>(
            'GET',
            `/containers/${name}/logs?stdout=1&stderr=1&tail=15`,
          );
          if (logsRes.status === 200 && typeof logsRes.data === 'string') {
            const parsed = parseBootStageFromLogs(logsRes.data);
            if (parsed && parsed.stage !== lastStage) {
              lastStage = parsed.stage;
              onStage(parsed.stage, parsed.message);
            }
          }
        } catch {
          // ignore log read failure
        }
      }

      // Periodically verify container didn't crash on startup
      if (pollCount % 6 === 0) {
        const check = await dockerRequest<{
          State?: { Running?: boolean; Status?: string; ExitCode?: number };
        }>('GET', `/containers/${name}/json`).catch(() => null);
        if (check?.status === 200 && check.data?.State && !check.data.State.Running) {
          const logsRes = await dockerRequest<string>(
            'GET',
            `/containers/${name}/logs?stdout=1&stderr=1&tail=25`,
          ).catch(() => null);
          const snippet =
            typeof logsRes?.data === 'string'
              ? logsRes.data.replace(/[^\x20-\x7E\r\n\t]/g, '').trim().slice(-500)
              : '';
          throw new Error(
            `Workspace container exited unexpectedly (exit=${check.data.State.ExitCode ?? '?'}). ${snippet}`,
          );
        }
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    throw new Error('Timed out waiting for workspace container to become ready');
  }

  async runDoctorChecks(): Promise<DoctorCheckResult> {
    const warnings: string[] = [];
    const errors: string[] = [];
    const details: Record<string, unknown> = {
      workspaceDriver: this.config.workspaceDriver,
      workspaceImage: this.config.workspaceImage,
      dataDir: this.config.dataDir,
      warmPool: this.getWarmPoolStatus(),
    };

    try {
      const ping = await dockerRequest<{ ApiVersion?: string }>('GET', '/version');
      if (ping.status !== 200) {
        errors.push(`Docker daemon returned HTTP ${ping.status} on /var/run/docker.sock`);
      } else {
        details.dockerApiVersion = ping.data?.ApiVersion;
      }
    } catch (err) {
      errors.push(
        `Cannot reach /var/run/docker.sock (${err instanceof Error ? err.message : String(err)}). Mount /var/run/docker.sock:/var/run/docker.sock into control-plane.`,
      );
      return { ok: false, warnings, errors, details };
    }

    const os = await import('node:os');
    const self = await dockerRequest<{
      NetworkSettings?: { Networks?: Record<string, unknown> };
      Mounts?: Array<{ Type: string; Destination: string }>;
    }>('GET', `/containers/${encodeURIComponent(os.hostname())}/json`).catch(() => null);

    if (self?.status === 200) {
      const nets = Object.keys(self.data?.NetworkSettings?.Networks ?? {});
      details.controlPlaneNetworks = nets;
      if (nets.length === 1 && nets[0] === 'bridge') {
        errors.push(
          'control-plane is attached only to Docker default "bridge" network, which disables container-name DNS. Attach control-plane to a user-defined bridge network (e.g. halley-net).',
        );
      }
      const resolvedData = path.resolve(this.config.dataDir);
      const hasDataMount = (self.data?.Mounts ?? []).some(
        (m) => resolvedData === path.resolve(m.Destination) || resolvedData.startsWith(path.resolve(m.Destination) + '/'),
      );
      details.dataDirMounted = hasDataMount;
      if (!hasDataMount) {
        warnings.push(
          `DATA_DIR (${resolvedData}) is not on a mounted Docker volume/bind-mount — SQLite sessions & spend history will be lost if control-plane is recreated. Mount a persistent volume to /data and keep DATA_DIR=/data.`,
        );
      }
    }

    const imgCheck = await dockerRequest('GET', `/images/${encodeURIComponent(this.config.workspaceImage)}/json`);
    details.workspaceImagePresent = imgCheck.status === 200;
    if (imgCheck.status !== 200) {
      warnings.push(
        `Workspace image "${this.config.workspaceImage}" is not cached locally yet; Halley will auto-pull it when the first session starts.`,
      );
    }

    if (!this.config.anthropicApiKey) {
      warnings.push('ANTHROPIC_API_KEY is empty — Pi AI chat requests will fail until configured.');
    }
    if (!this.config.githubToken && !this.config.githubAppId) {
      warnings.push('Neither GITHUB_APP_ID nor GITHUB_TOKEN is configured — publishing PRs will fail.');
    }

    return { ok: errors.length === 0, warnings, errors, details };
  }

  async ensureRunning(session: SessionRecord): Promise<WorkspaceEndpoint> {
    const pending = this.booting.get(session.id);
    if (pending) return pending;

    const p = this.startOrResume(session).finally(() => this.booting.delete(session.id));
    this.booting.set(session.id, p);
    return p;
  }

  private async claimWarmSlot(
    session: SessionRecord,
    slot: WarmSlot,
  ): Promise<WorkspaceEndpoint | null> {
    try {
      if (slot.state === 'warming') {
        await slot.bootPromise;
      }
      if (slot.state !== 'ready') {
        await this.destroyWarmSlot(slot);
        return null;
      }

      // Quick liveness check before claiming
      const healthRes = await fetch(`${slot.runnerUrl}/health`, { signal: AbortSignal.timeout(4000) });
      if (!healthRes.ok) {
        await this.destroyWarmSlot(slot);
        return null;
      }

      this.emitProgress(session.id, 'claiming_warm', 'Connecting to ready workspace…', {
        warmHit: true,
      });

      const token = this.config.devLocalRepo
        ? ''
        : await this.github.getAccessToken().catch(() => '');
      const mirrorDir = path.join(this.config.dataDir, 'git-mirror', 'repo.git');
      await ensureBareMirror(
        mirrorDir,
        session.repo,
        token || undefined,
        this.config.devLocalRepo || undefined,
      );
      const mirrorHead = await runGit(mirrorDir, ['rev-parse', `refs/heads/${session.base_branch}`]).catch(() => '');
      const needsSync = Boolean(mirrorHead && slot.baseSha && mirrorHead !== slot.baseSha);

      if (needsSync) {
        this.emitProgress(session.id, 'syncing_repo', 'Syncing latest website updates…', {
          warmHit: true,
        });
        await execFileAsync('docker', ['cp', mirrorDir, `${slot.containerName}:/halley-mirror/`]);
      }

      const isFrozen = session.status === 'published' || session.status === 'merged';
      const persona = this.db.getUserById(session.owner_user_id)?.persona ?? 'non-technical';
      const claimRes = await fetch(`${slot.runnerUrl}/internal/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workingBranch: session.working_branch,
          baseBranch: session.base_branch,
          editorName: session.owner_name || 'Editor',
          editorEmail: session.owner_email || 'editor@example.com',
          persona,
          readOnly: isFrozen,
          syncFromMirror: needsSync,
        }),
      });
      if (!claimRes.ok) {
        throw new Error(`Warm claim failed (${claimRes.status}): ${await claimRes.text()}`);
      }
      const claimed = (await claimRes.json()) as {
        baseSha?: string;
        originalBase?: string;
      };

      const astroBase = claimed.originalBase || slot.astroBase || '/';
      const baseSha = claimed.baseSha || slot.baseSha || session.base_sha;

      this.db.updateSession(session.id, {
        container_id: slot.containerId,
        status: isFrozen ? session.status : 'running',
        base_sha: baseSha,
        runner_url: slot.runnerUrl,
        astro_url: slot.astroUrl,
        astro_base: astroBase,
        node_modules_pruned_at: null,
        last_active_at: new Date().toISOString(),
      });

      this.emitProgress(session.id, 'ready', 'Workspace ready!', { warmHit: true });
      console.log(
        `[halley-warm-pool] Claimed warm container ${slot.containerName} for session ${session.id} (synced=${needsSync})`,
      );
      return {
        runnerUrl: slot.runnerUrl,
        astroUrl: slot.astroUrl,
        astroBase,
        baseSha,
      };
    } catch (err) {
      console.warn(`[halley-warm-pool] Claim failed for ${slot.containerName}, falling back to cold boot:`, err);
      await this.destroyWarmSlot(slot);
      return null;
    }
  }

  private async startOrResume(session: SessionRecord): Promise<WorkspaceEndpoint> {
    // Fast-path: if this session reserved a warm standby container, claim it directly
    const reservedWarm = this.reservedWarmSlots.get(session.id);
    if (reservedWarm) {
      this.reservedWarmSlots.delete(session.id);
      const claimed = await this.claimWarmSlot(session, reservedWarm);
      if (claimed) return claimed;
    }

    const name = this.containerName(session.id);
    const isFrozen = session.status === 'published' || session.status === 'merged';
    try {
      // Fast-path: if container is already running & healthy (and has a valid WORKSPACE_TOKEN), return immediately
      let inspect = await dockerRequest<{
        State?: { Running?: boolean; Status?: string; ExitCode?: number };
        Config?: { Env?: string[] };
        Image?: string;
        Id?: string;
      }>('GET', `/containers/${name}/json`);

      if (
        inspect.status === 200 &&
        inspect.data?.State?.Running &&
        !hasEmptyWorkspaceToken(inspect.data?.Config?.Env)
      ) {
        const runnerUrl = `http://${name}:4100`;
        const astroUrl = `http://${name}:4321`;
        try {
          const res = await fetch(`${runnerUrl}/health`, { signal: AbortSignal.timeout(2000) });
          if (res.ok) {
            const health = (await res.json()) as {
              originalBase?: string;
              astroReady?: boolean;
              baseSha?: string;
            };
            if (health.astroReady) {
              const astroBase = health.originalBase || session.astro_base || '/';
              const baseSha = health.baseSha || session.base_sha;
              this.db.updateSession(session.id, {
                status: isFrozen ? session.status : 'running',
                runner_url: runnerUrl,
                astro_url: astroUrl,
                astro_base: astroBase,
                base_sha: baseSha,
                node_modules_pruned_at: null,
                last_active_at: new Date().toISOString(),
              });
              this.emitProgress(session.id, 'ready', 'Workspace ready!');
              return { runnerUrl, astroUrl, astroBase, baseSha };
            }
          }
        } catch {
          // container is running but still booting; fall through to poll
        }
      }

      this.emitProgress(session.id, 'syncing_repo', 'Syncing latest website repository…');
      const token = this.config.devLocalRepo
        ? ''
        : await this.github.getAccessToken().catch(() => '');
      const mirrorDir = path.join(this.config.dataDir, 'git-mirror', 'repo.git');
      await ensureBareMirror(
        mirrorDir,
        session.repo,
        token || undefined,
        this.config.devLocalRepo || undefined,
      );

      this.emitProgress(session.id, 'checking_image', 'Checking workspace container image…');
      const targetImageId = await this.ensureImagePresent(this.config.workspaceImage, () => {
        this.emitProgress(session.id, 'pulling_image', 'Pulling workspace container image…');
      });
      const networkName = await this.resolveDockerNetwork();

      // Re-inspect after mirror/image check
      inspect = await dockerRequest<{
        State?: { Running?: boolean; Status?: string; ExitCode?: number };
        Config?: { Env?: string[] };
        Image?: string;
        Id?: string;
      }>('GET', `/containers/${name}/json`);

      // Self-heal stale, broken, tokenless, or outdated stopped containers while preserving the session volume
      if (inspect.status === 200) {
        const state = inspect.data?.State;
        const status = state?.Status || '';
        const isBrokenState =
          status === 'created' ||
          status === 'dead' ||
          (!state?.Running &&
            (state?.ExitCode ?? 0) !== 0 &&
            state?.ExitCode !== 137 &&
            state?.ExitCode !== 143);
        const isOutdatedStopped =
          !state?.Running &&
          targetImageId &&
          inspect.data?.Image &&
          inspect.data.Image !== targetImageId;
        const hasMissingToken = hasEmptyWorkspaceToken(inspect.data?.Config?.Env);
        if (isBrokenState || isOutdatedStopped || hasMissingToken) {
          console.log(
            `[halley-docker] Recreating container ${name} (status=${status}, exit=${state?.ExitCode ?? 0}, outdated=${Boolean(isOutdatedStopped)}, missingToken=${hasMissingToken}) while preserving volume ${session.volume_name}`,
          );
          await dockerRequest('DELETE', `/containers/${name}?force=true`).catch(() => {});
          inspect = { status: 404, data: {} };
        }
      }

      if (inspect.status === 404) {
        this.emitProgress(session.id, 'creating_container', 'Creating isolated workspace container…');
        await dockerRequest('POST', '/volumes/create', { Name: session.volume_name });
        await dockerRequest('POST', '/volumes/create', { Name: 'halley-pkg-cache' });
        await dockerRequest('POST', '/volumes/create', { Name: 'halley-git-mirror' });

        const workspaceToken = this.ensureSessionToken(session.id);
        const env = [
          `HALLEY_SESSION_ID=${session.id}`,
          `HALLEY_REPO=${session.repo}`,
          `HALLEY_BASE_BRANCH=${session.base_branch}`,
          `HALLEY_WORKING_BRANCH=${session.working_branch}`,
          `HALLEY_BASE_SHA=${session.base_sha}`,
          `HALLEY_MIRROR_PATH=/halley-mirror/repo.git`,
          `RUNNER_PORT=4100`,
          `ASTRO_PORT=4321`,
          `CONTROL_PLANE_INTERNAL_URL=${this.config.controlPlaneInternalUrl}`,
          `WORKSPACE_TOKEN=${workspaceToken}`,
          `HALLEY_MODEL_ID=${this.config.modelId}`,
          `HALLEY_THINKING_LEVEL=${this.config.thinkingLevel}`,
          `HALLEY_PERSONA=${this.db.getUserById(session.owner_user_id)?.persona ?? 'non-technical'}`,
          `HALLEY_GIT_BOT_NAME=${this.config.gitBotName}`,
          `HALLEY_GIT_BOT_EMAIL=${this.config.gitBotEmail}`,
          `HALLEY_EDITOR_NAME=${session.owner_name || 'Editor'}`,
          `HALLEY_EDITOR_EMAIL=${session.owner_email || 'editor@example.com'}`,
          `HALLEY_READ_ONLY=${isFrozen ? 'true' : 'false'}`,
        ];

        const created = await dockerRequest<{ Id: string }>('POST', `/containers/create?name=${name}`, {
          Image: this.config.workspaceImage,
          Env: env,
          HostConfig: {
            NetworkMode: networkName,
            Binds: [
              `${session.volume_name}:/halley-volume`,
              `halley-pkg-cache:/halley-pkg-cache`,
              `halley-git-mirror:/halley-mirror`,
            ],
            Memory: 2 * 1024 * 1024 * 1024,
          },
        });
        if (created.status >= 400) {
          throw new Error(`Docker create failed: ${JSON.stringify(created.data)}`);
        }
        this.db.updateSession(session.id, { container_id: created.data.Id });

        // Sync bare git mirror into the named Docker volume via docker cp (works regardless of host paths,
        // custom container names, or DATA_DIR settings — zero host bind-mount path dependencies).
        await execFileAsync('docker', ['cp', mirrorDir, `${name}:/halley-mirror/`]);
      }

      if (!inspect.data?.State?.Running) {
        this.emitProgress(session.id, 'starting_container', 'Starting workspace container…');
        const startRes = await dockerRequest<{ message?: string }>('POST', `/containers/${name}/start`);
        if (startRes.status >= 400) {
          throw new Error(`Docker start failed (${startRes.status}): ${JSON.stringify(startRes.data)}`);
        }
      }

      const runnerUrl = `http://${name}:4100`;
      const astroUrl = `http://${name}:4321`;

      const health = await this.pollContainerReady(name, runnerUrl, (stage, message) => {
        this.emitProgress(session.id, stage, message);
      });
      const astroBase = health.originalBase || session.astro_base || '/';
      const baseSha = health.baseSha || session.base_sha;

      this.db.updateSession(session.id, {
        status: isFrozen ? session.status : 'running',
        base_sha: baseSha,
        runner_url: runnerUrl,
        astro_url: astroUrl,
        astro_base: astroBase,
        node_modules_pruned_at: null,
        last_active_at: new Date().toISOString(),
      });

      this.emitProgress(session.id, 'ready', 'Workspace ready!');
      return { runnerUrl, astroUrl, astroBase, baseSha };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emitProgress(session.id, 'error', 'Workspace failed to start', { detail: msg });
      throw err;
    }
  }

  async stop(session: SessionRecord): Promise<void> {
    const name = this.containerName(session.id);
    this.bootProgress.delete(session.id);
    await dockerRequest('POST', `/containers/${name}/stop?t=5`).catch(() => {});
    const isFrozen = session.status === 'published' || session.status === 'merged';
    this.db.updateSession(session.id, {
      status: isFrozen ? session.status : 'sleeping',
      runner_url: null,
      astro_url: null,
    });
  }

  async destroy(session: SessionRecord): Promise<void> {
    const name = this.containerName(session.id);
    this.bootProgress.delete(session.id);
    this.reservedWarmSlots.delete(session.id);
    await dockerRequest('DELETE', `/containers/${name}?force=true`).catch(() => {});
    await dockerRequest('DELETE', `/volumes/${session.volume_name}`).catch(() => {});
  }

  async pruneNodeModules(session: SessionRecord): Promise<void> {
    await execFileAsync('docker', [
      'run',
      '--rm',
      '-v',
      `${session.volume_name}:/halley-volume`,
      this.config.workspaceImage,
      'sh',
      '-c',
      'rm -rf /halley-volume/workspace/node_modules',
    ]);
  }

  async duplicateWorkspace(
    source: SessionRecord,
    target: SessionRecord,
    mode: 'branch-off' | 'fresh-from-main' = 'branch-off',
  ): Promise<void> {
    await dockerRequest('POST', '/volumes/create', { Name: target.volume_name });
    if (mode === 'fresh-from-main') {
      // Leave volume empty so the container clones cleanly from latest origin/main on boot
      return;
    }
    // Copy workspace git repo (including uncommitted edits) + staged uploads (NOT live pi.sqlite per Q18)
    await execFileAsync('docker', [
      'run',
      '--rm',
      '-v',
      `${source.volume_name}:/src:ro`,
      '-v',
      `${target.volume_name}:/dst`,
      this.config.workspaceImage,
      'sh',
      '-c',
      [
        'mkdir -p /dst/state',
        'cp -a /src/workspace /dst/workspace',
        'if [ -d /src/state/uploads ]; then cp -a /src/state/uploads /dst/state/uploads; fi',
        `cd /dst/workspace && git checkout -b ${target.working_branch}`,
      ].join(' && '),
    ]);
  }

  async pushSessionBranch(session: SessionRecord, token: string): Promise<void> {
    const name = this.containerName(session.id);
    await withGitAskPass(token, async () => {
      await execFileAsync('docker', [
        'exec',
        '-e',
        `HALLEY_GIT_TOKEN=${token}`,
        name,
        'sh',
        '-c',
        `cd /halley-volume/workspace && git -c credential.helper='!f() { echo "username=x-access-token"; echo "password=$HALLEY_GIT_TOKEN"; }; f' push --force-with-lease origin ${session.working_branch}`,
      ]);
    });
  }

  async fetchIntoSession(session: SessionRecord, token: string): Promise<void> {
    const name = this.containerName(session.id);
    await execFileAsync('docker', [
      'exec',
      '-e',
      `HALLEY_GIT_TOKEN=${token}`,
      name,
      'sh',
      '-c',
      `cd /halley-volume/workspace && git -c credential.helper='!f() { echo "username=x-access-token"; echo "password=$HALLEY_GIT_TOKEN"; }; f' fetch origin ${session.base_branch}`,
    ]);
  }
}
