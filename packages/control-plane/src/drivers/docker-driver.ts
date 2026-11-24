import { execFile } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import type { HalleyConfig } from '../config.js';
import type { ControlPlaneDb, SessionRecord } from '../db.js';
import type { GitHubService } from '../github/client.js';
import {
  ensureBareMirror,
  withGitAskPass,
  type WorkspaceDriver,
  type WorkspaceEndpoint,
} from './workspace-driver.js';

const execFileAsync = promisify(execFile);

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

  constructor(
    private config: HalleyConfig,
    private db: ControlPlaneDb,
    private github: GitHubService,
  ) {}

  setRawWorkspaceToken(sessionId: string, token: string): void {
    this.sessionTokens.set(sessionId, token);
  }

  private containerName(sessionId: string): string {
    return `halley-ws-${sessionId.slice(0, 12)}`;
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
  private async ensureImagePresent(image: string): Promise<string | undefined> {
    const inspect = await dockerRequest<{ Id?: string }>(
      'GET',
      `/images/${encodeURIComponent(image)}/json`,
    );
    if (inspect.status === 200) return inspect.data?.Id;

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

  async runDoctorChecks(): Promise<DoctorCheckResult> {
    const warnings: string[] = [];
    const errors: string[] = [];
    const details: Record<string, unknown> = {
      workspaceDriver: this.config.workspaceDriver,
      workspaceImage: this.config.workspaceImage,
      dataDir: this.config.dataDir,
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

  private async startOrResume(session: SessionRecord): Promise<WorkspaceEndpoint> {
    const name = this.containerName(session.id);
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

    const targetImageId = await this.ensureImagePresent(this.config.workspaceImage);
    const networkName = await this.resolveDockerNetwork();

    let inspect = await dockerRequest<{
      State?: { Running?: boolean; Status?: string; ExitCode?: number };
      Image?: string;
      Id?: string;
    }>('GET', `/containers/${name}/json`);

    // Self-heal stale, broken, or outdated stopped containers while preserving the session volume
    if (inspect.status === 200) {
      const state = inspect.data?.State;
      const status = state?.Status || '';
      const isBrokenState = status === 'created' || status === 'dead' || (!state?.Running && (state?.ExitCode ?? 0) !== 0 && state?.ExitCode !== 137 && state?.ExitCode !== 143);
      const isOutdatedStopped = !state?.Running && targetImageId && inspect.data?.Image && inspect.data.Image !== targetImageId;
      if (isBrokenState || isOutdatedStopped) {
        console.log(
          `[halley-docker] Recreating container ${name} (status=${status}, exit=${state?.ExitCode ?? 0}, outdated=${Boolean(isOutdatedStopped)}) while preserving volume ${session.volume_name}`,
        );
        await dockerRequest('DELETE', `/containers/${name}?force=true`).catch(() => {});
        inspect = { status: 404, data: {} };
      }
    }

    if (inspect.status === 404) {
      await dockerRequest('POST', '/volumes/create', { Name: session.volume_name });
      await dockerRequest('POST', '/volumes/create', { Name: 'halley-pkg-cache' });
      await dockerRequest('POST', '/volumes/create', { Name: 'halley-git-mirror' });

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
        `WORKSPACE_TOKEN=${this.sessionTokens.get(session.id) || ''}`,
        `HALLEY_MODEL_ID=${this.config.modelId}`,
        `HALLEY_THINKING_LEVEL=${this.config.thinkingLevel}`,
        `HALLEY_PERSONA=${this.db.getUserById(session.owner_user_id)?.persona ?? 'non-technical'}`,
        `HALLEY_GIT_BOT_NAME=${this.config.gitBotName}`,
        `HALLEY_GIT_BOT_EMAIL=${this.config.gitBotEmail}`,
        `HALLEY_EDITOR_NAME=${session.owner_name || 'Editor'}`,
        `HALLEY_EDITOR_EMAIL=${session.owner_email || 'editor@example.com'}`,
        `HALLEY_READ_ONLY=${session.status === 'published' ? 'true' : 'false'}`,
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
      const startRes = await dockerRequest<{ message?: string }>('POST', `/containers/${name}/start`);
      if (startRes.status >= 400) {
        throw new Error(`Docker start failed (${startRes.status}): ${JSON.stringify(startRes.data)}`);
      }
    }

    const runnerUrl = `http://${name}:4100`;
    const astroUrl = `http://${name}:4321`;
    let astroBase = session.astro_base || '/';

    const deadline = Date.now() + 60_000;
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
      await new Promise((r) => setTimeout(r, 500));
    }

    this.db.updateSession(session.id, {
      status: session.status === 'published' ? 'published' : 'running',
      runner_url: runnerUrl,
      astro_url: astroUrl,
      astro_base: astroBase,
      last_active_at: new Date().toISOString(),
    });

    return { runnerUrl, astroUrl, astroBase, baseSha: session.base_sha };
  }

  async stop(session: SessionRecord): Promise<void> {
    const name = this.containerName(session.id);
    await dockerRequest('POST', `/containers/${name}/stop?t=5`).catch(() => {});
    this.db.updateSession(session.id, {
      status: session.status === 'published' ? 'published' : 'sleeping',
      runner_url: null,
      astro_url: null,
    });
  }

  async destroy(session: SessionRecord): Promise<void> {
    const name = this.containerName(session.id);
    await dockerRequest('DELETE', `/containers/${name}?force=true`).catch(() => {});
    await dockerRequest('DELETE', `/volumes/${session.volume_name}`).catch(() => {});
  }

  async duplicateWorkspace(source: SessionRecord, target: SessionRecord): Promise<void> {
    await dockerRequest('POST', '/volumes/create', { Name: target.volume_name });
    // Copy workspace git repo from source volume to target volume and checkout new branch
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
      `cp -a /src/workspace /dst/workspace && cd /dst/workspace && git checkout -b ${target.working_branch}`,
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
