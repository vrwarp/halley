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
  failedSummary?: string;
  failedLogs?: string;
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
        },
      );
      if (!res.ok) {
        throw new Error(`GitHub App token failed: ${res.status} ${await res.text()}`);
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
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'halley-editor',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub API ${path} failed (${res.status}): ${await res.text()}`);
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

  async tryEnableNativeAutoMerge(prNodeId: string, commitHeadline: string): Promise<boolean> {
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
          query: `mutation($id: ID!, $headline: String!) {
            enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH, commitHeadline: $headline }) {
              pullRequest { id }
            }
          }`,
          variables: { id: prNodeId, headline: commitHeadline },
        }),
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
    const runs = await this.api<{
      total_count: number;
      check_runs: Array<{
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        output?: { title?: string; summary?: string };
      }>;
    }>(`/repos/${owner}/${repo}/commits/${headSha}/check-runs`);

    if (runs.total_count === 0) {
      return { state: 'passed' };
    }

    const failed = runs.check_runs.filter(
      (r) =>
        r.status === 'completed' &&
        r.conclusion &&
        !['success', 'neutral', 'skipped'].includes(r.conclusion),
    );
    if (failed.length > 0) {
      const names = failed.map((f) => `${f.name} (${f.conclusion})`).join(', ');
      const details = failed
        .map((f) => `### ${f.name}\n${f.output?.title ?? ''}\n${f.output?.summary ?? ''}`)
        .join('\n\n')
        .slice(0, 4000);
      return {
        state: 'failed',
        failedSummary: `GitHub checks failed: ${names}`,
        failedLogs: details || names,
      };
    }

    const pending = runs.check_runs.some((r) => r.status !== 'completed');
    return { state: pending ? 'pending' : 'passed' };
  }

  async squashMergePr(input: {
    prNumber: number;
    commitTitle: string;
    commitMessage: string;
  }): Promise<string> {
    const { owner, repo } = this.ownerRepo;
    const res = await this.api<{ sha: string }>(`/repos/${owner}/${repo}/pulls/${input.prNumber}/merge`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merge_method: 'squash',
        commit_title: input.commitTitle,
        commit_message: input.commitMessage,
      }),
    });
    return res.sha;
  }

  async checkMainDeployStatus(mergeSha: string): Promise<'pending' | 'deployed' | 'failed'> {
    const { owner, repo } = this.ownerRepo;
    const runs = await this.api<{
      workflow_runs: Array<{
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
      }>;
    }>(`/repos/${owner}/${repo}/actions/runs?head_sha=${mergeSha}&per_page=10`);

    if (runs.workflow_runs.length === 0) {
      return 'deployed';
    }
    const anyFailed = runs.workflow_runs.some(
      (r) => r.status === 'completed' && r.conclusion && !['success', 'neutral', 'skipped'].includes(r.conclusion),
    );
    if (anyFailed) return 'failed';
    const anyPending = runs.workflow_runs.some((r) => r.status !== 'completed');
    return anyPending ? 'pending' : 'deployed';
  }
}
