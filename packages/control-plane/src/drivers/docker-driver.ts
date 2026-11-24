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

export class DockerWorkspaceDriver implements WorkspaceDriver {
  private sessionTokens = new Map<string, string>();
  private booting = new Map<string, Promise<WorkspaceEndpoint>>();

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

  async ensureRunning(session: SessionRecord): Promise<WorkspaceEndpoint> {
    const pending = this.booting.get(session.id);
    if (pending) return pending;

    const p = this.startOrResume(session).finally(() => this.booting.delete(session.id));
    this.booting.set(session.id, p);
    return p;
  }

  private async startOrResume(session: SessionRecord): Promise<WorkspaceEndpoint> {
    const name = this.containerName(session.id);
    const token = await this.github.getAccessToken().catch(() => '');
    const mirrorDir = path.join(this.config.dataDir, 'git-mirror', 'repo.git');
    await ensureBareMirror(mirrorDir, session.repo, token || undefined);

    const inspect = await dockerRequest<{ State?: { Running?: boolean }; Id?: string }>(
      'GET',
      `/containers/${name}/json`,
    );

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
          NetworkMode: this.config.workspaceDockerNetwork,
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
      await dockerRequest('POST', `/containers/${name}/start`);
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
