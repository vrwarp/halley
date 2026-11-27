import crypto from 'node:crypto';
import type { HalleyConfig } from '../config.js';

export interface PrInfo {
  number: number;
  url: string;
  nodeId: string;
  headSha: string;
}

export interface CheckStatusSummary {
  state: 'pending' | 'passed' | 'failed';
  totalCount: number;
  failedSummary?: string;
  failedLogs?: string;
}

export interface MainDeployStatusResult {
  state: 'waiting_for_run' | 'pending' | 'deployed' | 'failed';
  workflowName?: string;
  runUrl?: string;
  conclusion?: string | null;
}

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

const DEFAULT_DEPLOY_WORKFLOW_RE = /(?:^|[\s/_-])(deploy|pages)(?:$|[\s/._-])/i;

export function matchesDeployWorkflow(
  workflow: { name?: string | null; path?: string | null },
  configured?: string,
): boolean {
  const name = (workflow.name ?? '').trim();
  const wfPath = (workflow.path ?? '').trim();
  const target = (configured ?? '').trim().toLowerCase();
  if (target) {
    const lowerName = name.toLowerCase();
    const lowerPath = wfPath.toLowerCase();
    return lowerName === target || lowerPath === target || lowerPath.endsWith(`/${target}`);
  }
  return DEFAULT_DEPLOY_WORKFLOW_RE.test(wfPath) || DEFAULT_DEPLOY_WORKFLOW_RE.test(name);
}

export class GitHubService {
  private cachedInstallToken: { token: string; expiresAt: number } | null = null;

  constructor(private config: HalleyConfig) {}

  get ownerRepo(): { owner: string; repo: string } {
    const [owner = '', repo = ''] = this.config.repo.split('/');
    return { owner, repo };
  }

  private createAppJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iat: now - 60,
        exp: now + 9 * 60,
        iss: this.config.githubAppId,
      }),
    ).toString('base64url');
    const signingInput = `${header}.${payload}`;
    const sig = crypto
      .createSign('RSA-SHA256')
      .update(signingInput)
      .sign(this.config.githubAppPrivateKey, 'base64url');
    return `${signingInput}.${sig}`;
  }

  async getAccessToken(): Promise<string> {
    if (this.config.githubAppId && this.config.githubAppPrivateKey && this.config.githubAppInstallationId) {
      if (this.cachedInstallToken && Date.now() < this.cachedInstallToken.expiresAt - 120_000) {
        return this.cachedInstallToken.token;
      }
      const jwt = this.createAppJwt();
      const res = await fetch(
        `${this.config.githubApiBaseUrl}/app/installations/${this.config.githubAppInstallationId}/access_tokens`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'halley-editor',
          },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!res.ok) {
        throw new GitHubApiError(
          res.status,
          `/app/installations/${this.config.githubAppInstallationId}/access_tokens`,
          `GitHub App token failed: ${res.status} ${await res.text()}`,
        );
      }
      const data = (await res.json()) as { token: string; expires_at: string };
      this.cachedInstallToken = {
        token: data.token,
        expiresAt: new Date(data.expires_at).getTime(),
      };
      return data.token;
    }

    if (this.config.githubToken) {
      return this.config.githubToken;
    }
    throw new Error('No GitHub App or GITHUB_TOKEN configured');
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.getAccessToken();
    const res = await fetch(`${this.config.githubApiBaseUrl}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'halley-editor',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new GitHubApiError(
        res.status,
        path,
        `GitHub API ${path} failed (${res.status}): ${await res.text()}`,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async createOrUpdatePr(input: {
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<PrInfo> {
    const { owner, repo } = this.ownerRepo;
    const existing = await this.api<
      Array<{ number: number; html_url: string; node_id: string; head: { sha: string } }>
    >(`/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.headBranch}`)}`);

    if (existing[0]) {
      const updated = await this.api<{
        number: number;
        html_url: string;
        node_id: string;
        head: { sha: string };
      }>(`/repos/${owner}/${repo}/pulls/${existing[0].number}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: input.title, body: input.body }),
      });
      return {
        number: updated.number,
        url: updated.html_url,
        nodeId: updated.node_id,
        headSha: updated.head.sha,
      };
    }

    const created = await this.api<{
      number: number;
      html_url: string;
      node_id: string;
      head: { sha: string };
    }>(`/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.headBranch,
        base: input.baseBranch,
      }),
    });

    return {
      number: created.number,
      url: created.html_url,
      nodeId: created.node_id,
      headSha: created.head.sha,
    };
  }

  async tryEnableNativeAutoMerge(
    prNodeId: string,
    commitHeadline: string,
    commitBody?: string,
  ): Promise<boolean> {
    try {
      const token = await this.getAccessToken();
      const res = await fetch(`${this.config.githubApiBaseUrl}/graphql`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'halley-editor',
        },
        body: JSON.stringify({
          query: `mutation($id: ID!, $headline: String!, $body: String) {
            enablePullRequestAutoMerge(input: {
              pullRequestId: $id,
              mergeMethod: SQUASH,
              commitHeadline: $headline,
              commitBody: $body
            }) {
              pullRequest { id }
            }
          }`,
          variables: {
            id: prNodeId,
            headline: commitHeadline,
            body: commitBody ?? null,
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { errors?: unknown[] };
      return !json.errors?.length;
    } catch {
      return false;
    }
  }

  async getPrState(prNumber: number): Promise<{
    merged: boolean;
    mergeCommitSha: string | null;
    state: 'open' | 'closed';
    headSha: string;
  }> {
    const { owner, repo } = this.ownerRepo;
    const pr = await this.api<{
      merged: boolean;
      merge_commit_sha: string | null;
      state: 'open' | 'closed';
      head: { sha: string };
    }>(`/repos/${owner}/${repo}/pulls/${prNumber}`);
    return {
      merged: pr.merged,
      mergeCommitSha: pr.merge_commit_sha,
      state: pr.state,
      headSha: pr.head.sha,
    };
  }

  async checkCommitStatus(headSha: string): Promise<CheckStatusSummary> {
    const { owner, repo } = this.ownerRepo;
    type CheckRunItem = {
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
      output?: { title?: string; summary?: string };
    };

    const allCheckRuns: CheckRunItem[] = [];
    let reportedTotalRuns = 0;
    for (let page = 1; page <= 5; page++) {
      const runsPage = await this.api<{
        total_count: number;
        check_runs: CheckRunItem[];
      }>(
        `/repos/${owner}/${repo}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100&page=${page}`,
      );
      reportedTotalRuns = Math.max(reportedTotalRuns, runsPage.total_count ?? 0);
      const batch = runsPage.check_runs ?? [];
      allCheckRuns.push(...batch);
      if (batch.length < 100 || allCheckRuns.length >= reportedTotalRuns) {
        break;
      }
    }

    // Also query legacy commit statuses (e.g. external status webhooks). Gracefully ignore 404 on minimal test mocks.
    let latestByContext = new Map<string, { state: string; description?: string | null }>();
    try {
      const combined = await this.api<{
        state?: string;
        statuses?: Array<{ context?: string; state?: string; description?: string | null; id?: number }>;
      }>(`/repos/${owner}/${repo}/commits/${encodeURIComponent(headSha)}/status?per_page=100`);
      for (const st of combined.statuses ?? []) {
        const ctx = (st.context || '').trim();
        if (!ctx || !st.state) continue;
        if (!latestByContext.has(ctx)) {
          latestByContext.set(ctx, { state: st.state, description: st.description });
        }
      }
    } catch (err) {
      if (!(err instanceof GitHubApiError && err.status === 404)) {
        // Non-404 status errors: surface only if check-runs are empty so transient status API hiccups don't mask real errors
        if (allCheckRuns.length === 0) throw err;
      }
      latestByContext = new Map();
    }

    const statusEntries = [...latestByContext.entries()];
    const totalCount = Math.max(reportedTotalRuns, allCheckRuns.length) + statusEntries.length;

    if (totalCount === 0) {
      return { state: 'passed', totalCount: 0 };
    }

    const failedRuns = allCheckRuns.filter(
      (r) =>
        r.status === 'completed' &&
        r.conclusion &&
        !['success', 'neutral', 'skipped'].includes(r.conclusion),
    );
    const failedStatuses = statusEntries.filter(
      ([, st]) => st.state === 'failure' || st.state === 'error',
    );

    if (failedRuns.length > 0 || failedStatuses.length > 0) {
      const names = [
        ...failedRuns.map((f) => `${f.name} (${f.conclusion})`),
        ...failedStatuses.map(([ctx, st]) => `${ctx} (${st.state})`),
      ].join(', ');
      const details = [
        ...failedRuns.map((f) => `### ${f.name}\n${f.output?.title ?? ''}\n${f.output?.summary ?? ''}`),
        ...failedStatuses.map(([ctx, st]) => `### ${ctx}\n${st.description ?? st.state}`),
      ]
        .join('\n\n')
        .slice(0, 4000);
      return {
        state: 'failed',
        totalCount,
        failedSummary: `GitHub checks failed: ${names}`,
        failedLogs: details || names,
      };
    }

    const pendingRuns = allCheckRuns.some((r) => r.status !== 'completed');
    const pendingStatuses = statusEntries.some(([, st]) => st.state === 'pending');
    return { state: pendingRuns || pendingStatuses ? 'pending' : 'passed', totalCount };
  }

  async squashMergePr(input: {
    prNumber: number;
    commitTitle: string;
    commitMessage: string;
    headSha?: string;
  }): Promise<string> {
    const { owner, repo } = this.ownerRepo;
    const res = await this.api<{ sha: string }>(`/repos/${owner}/${repo}/pulls/${input.prNumber}/merge`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merge_method: 'squash',
        commit_title: input.commitTitle,
        commit_message: input.commitMessage,
        ...(input.headSha ? { sha: input.headSha } : {}),
      }),
    });
    return res.sha;
  }

  async hasActiveCiWorkflow(): Promise<boolean> {
    const { owner, repo } = this.ownerRepo;
    const data = await this.api<{
      workflows: Array<{
        id: number;
        name: string;
        path: string;
        state: string;
      }>;
    }>(`/repos/${owner}/${repo}/actions/workflows?per_page=50`);

    const active = (data.workflows ?? []).filter((w) => w.state === 'active');
    if (active.length === 0) return false;

    // Fast path: any dedicated non-deploy workflow (e.g. ci.yml / verify.yml)
    if (active.some((w) => !matchesDeployWorkflow(w, this.config.deployWorkflow))) {
      return true;
    }

    // Combined workflow path: inspect active deploy-named workflows (e.g. build-and-deploy.yml)
    // to check whether they ALSO trigger on `pull_request` / `pull_request_target`.
    for (const wf of active) {
      if (!wf.path) continue;
      const cleanPath = wf.path.replace(/^\/+/, '');
      try {
        const contentRes = await this.api<{ content?: string; encoding?: string }>(
          `/repos/${owner}/${repo}/contents/${cleanPath
            .split('/')
            .map(encodeURIComponent)
            .join('/')}?ref=${encodeURIComponent(this.config.baseBranch)}`,
        );
        if (contentRes.content) {
          const decoded =
            contentRes.encoding === 'base64'
              ? Buffer.from(contentRes.content.replace(/\s+/g, ''), 'base64').toString('utf8')
              : contentRes.content;
          const uncommented = decoded
            .split(/\r?\n/)
            .map((line) => line.replace(/#.*$/, ''))
            .join('\n');
          if (/\bpull_request(?:_target)?\b/.test(uncommented)) {
            return true;
          }
        }
      } catch {
        // Ignore missing contents endpoint (e.g. dynamic GitHub Pages workflow)
      }
    }

    return false;
  }

  async hasActiveDeployWorkflow(): Promise<boolean> {
    const { owner, repo } = this.ownerRepo;
    const data = await this.api<{
      workflows: Array<{
        id: number;
        name: string;
        path: string;
        state: string;
      }>;
    }>(`/repos/${owner}/${repo}/actions/workflows?per_page=50`);

    return (data.workflows ?? []).some(
      (w) => w.state === 'active' && matchesDeployWorkflow(w, this.config.deployWorkflow),
    );
  }

  async checkMainDeployStatus(mergeSha: string): Promise<MainDeployStatusResult> {
    const { owner, repo } = this.ownerRepo;
    const runs = await this.api<{
      workflow_runs: Array<{
        id: number;
        name: string;
        path?: string;
        event?: string;
        status: string;
        conclusion: string | null;
        html_url?: string;
      }>;
    }>(`/repos/${owner}/${repo}/actions/runs?head_sha=${encodeURIComponent(mergeSha)}&per_page=20`);

    const matchingRuns = (runs.workflow_runs ?? []).filter((r) => {
      if (r.event && !['push', 'workflow_dispatch', 'dynamic'].includes(r.event)) {
        return false;
      }
      return matchesDeployWorkflow(r, this.config.deployWorkflow);
    });

    if (matchingRuns.length === 0) {
      return { state: 'waiting_for_run' };
    }

    // Group by workflow identity and evaluate only the latest run per workflow (handles re-runs/dispatches)
    const latestByWorkflow = new Map<string, (typeof matchingRuns)[number]>();
    for (const run of matchingRuns) {
      const key = (run.path || run.name || String(run.id)).toLowerCase();
      const prev = latestByWorkflow.get(key);
      if (!prev || run.id > prev.id) {
        latestByWorkflow.set(key, run);
      }
    }
    const latestRuns = [...latestByWorkflow.values()];

    const pendingRun = latestRuns.find((r) => r.status !== 'completed');
    if (pendingRun) {
      return {
        state: 'pending',
        workflowName: pendingRun.name,
        runUrl: pendingRun.html_url,
      };
    }

    const failedRun = latestRuns.find((r) => r.conclusion !== 'success');
    if (failedRun) {
      return {
        state: 'failed',
        workflowName: failedRun.name,
        runUrl: failedRun.html_url,
        conclusion: failedRun.conclusion,
      };
    }

    const primary = latestRuns[0];
    return {
      state: 'deployed',
      workflowName: primary?.name,
      runUrl: primary?.html_url,
      conclusion: 'success',
    };
  }

  async listMainCommits(
    baseBranch: string,
    limit = 30,
  ): Promise<
    Array<{
      sha: string;
      shortSha: string;
      author: string;
      date: string;
      subject: string;
    }>
  > {
    const { owner, repo } = this.ownerRepo;
    try {
      const commits = await this.api<
        Array<{
          sha: string;
          commit: {
            message: string;
            author?: { name?: string; date?: string };
          };
          author?: { login?: string } | null;
        }>
      >(`/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(baseBranch)}&per_page=${limit}`);
      return commits.map((c) => ({
        sha: c.sha,
        shortSha: c.sha.slice(0, 7),
        author: c.commit.author?.name || c.author?.login || 'a developer',
        date: c.commit.author?.date || new Date().toISOString(),
        subject: (c.commit.message || '').split(/\r?\n/)[0] || 'Commit',
      }));
    } catch {
      return [];
    }
  }

  async getCommitFilesOrThrow(sha: string): Promise<string[]> {
    const { owner, repo } = this.ownerRepo;
    const data = await this.api<{ files?: Array<{ filename: string }> }>(
      `/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}`,
    );
    return (data.files ?? []).map((f) => f.filename);
  }

  async getCommitFiles(sha: string): Promise<string[]> {
    try {
      return await this.getCommitFilesOrThrow(sha);
    } catch {
      return [];
    }
  }
}
