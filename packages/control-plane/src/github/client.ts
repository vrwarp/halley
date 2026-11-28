import crypto from 'node:crypto';
import { realClock, type Clock, type FetchFn } from '../clock.js';
import type { HalleyConfig } from '../config.js';
import { ignore, logger } from '../log.js';

/**
 * Retry policy for every GitHub call (REST, GraphQL, App token minting). One mechanism: bounded
 * exponential backoff with jitter, Retry-After / x-ratelimit-reset aware, timed on the injected clock.
 */
export interface GitHubRetryOptions {
  /** Total attempts including the first (default 4). Takes precedence over `maxRetries`. */
  maxAttempts?: number;
  /** Retries after the first attempt (`maxAttempts - 1`); kept for callers that think in retries. */
  maxRetries?: number;
  /** Base delay before doubling: attempt 1 waits ~base, attempt 2 ~2x base, ... (default 1000ms). */
  baseDelayMs?: number;
  /** Upper bound for any single wait, including Retry-After / rate-limit reset (default 15s). */
  maxDelayMs?: number;
  /**
   * Fraction of each exponential delay that is randomised, in [0, 1] (default 0.5): the wait is
   * `exp * (1 - ratio) + random * exp * ratio`. 0 gives exact 1s, 2s, 4s... (deterministic tests).
   */
  jitterRatio?: number;
  /** Override the wait (tests); defaults to the injected clock's sleep. */
  sleep?: (ms: number) => Promise<void>;
}

interface ResolvedRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

const DEFAULT_RETRY: ResolvedRetryOptions = {
  maxAttempts: 4,
  baseDelayMs: 1000,
  maxDelayMs: 15_000,
  jitterRatio: 0.5,
};

function resolveRetryOptions(opts: GitHubRetryOptions | undefined): ResolvedRetryOptions {
  const maxAttempts =
    opts?.maxAttempts ?? (opts?.maxRetries !== undefined ? opts.maxRetries + 1 : DEFAULT_RETRY.maxAttempts);
  return {
    maxAttempts: Math.max(1, Math.floor(maxAttempts)),
    baseDelayMs: Math.max(0, opts?.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs),
    maxDelayMs: Math.max(0, opts?.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs),
    jitterRatio: Math.min(1, Math.max(0, opts?.jitterRatio ?? DEFAULT_RETRY.jitterRatio)),
  };
}

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD']);

export function isTransientGitHubStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

const TRANSIENT_NETWORK_RE =
  /fetch failed|timeout|timed out|aborted|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR|socket hang up|network/i;

/** 429/5xx responses and network-level failures (resets, DNS, timeouts) are worth another attempt. */
export function isTransientGitHubError(err: unknown): boolean {
  if (err instanceof GitHubApiError) return isTransientGitHubStatus(err.status);
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  if (TRANSIENT_NETWORK_RE.test(err.message)) return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    if (TRANSIENT_NETWORK_RE.test(cause.message)) return true;
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && TRANSIENT_NETWORK_RE.test(code)) return true;
  }
  return false;
}

/** Retry-After (delta-seconds or HTTP date) in ms, clamped to [0, maxDelayMs]; null when absent/invalid. */
export function parseRetryAfterMs(
  headerValue: string | null,
  maxDelayMs: number,
  now = realClock.now(),
): number | null {
  const trimmed = headerValue?.trim();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.min(maxDelayMs, Math.max(0, Number(trimmed) * 1000));
  }
  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    return Math.min(maxDelayMs, Math.max(0, parsedDate - now));
  }
  return null;
}

export interface GitHubServiceDeps {
  fetch?: FetchFn;
  clock?: Clock;
}

/**
 * Delay before attempt `attempt + 1` (attempt is 1-based): honour Retry-After / x-ratelimit-reset
 * (capped at maxDelayMs), else exponential backoff with `jitterRatio` of it randomised.
 */
export function computeRetryDelayMs(
  attempt: number,
  res: Pick<Response, 'headers' | 'status'> | null,
  opts: GitHubRetryOptions = {},
  now = realClock.now(),
): number {
  const o = resolveRetryOptions(opts);
  if (res) {
    const retryAfter = parseRetryAfterMs(res.headers.get('retry-after'), o.maxDelayMs, now);
    if (retryAfter !== null) return retryAfter;
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    if (remaining === '0' && reset && Number.isFinite(Number(reset))) {
      const ms = Number(reset) * 1000 - now;
      if (ms >= 0) return Math.min(ms, o.maxDelayMs);
    }
  }
  const exp = Math.min(o.maxDelayMs, o.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (1 - o.jitterRatio) + Math.random() * exp * o.jitterRatio);
}

export interface PrInfo {
  number: number;
  url: string;
  nodeId: string;
  headSha: string;
  /** ISO timestamp of the PR's last update (bumped by pushes and edits), when GitHub returned it. */
  updatedAt?: string;
}

export interface MainCommit {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  subject: string;
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
  private readonly retry: ResolvedRetryOptions;
  private readonly retryInput: GitHubRetryOptions;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly fetchImpl: FetchFn;
  private readonly clock: Clock;
  /** Short-lived cache for commit lists (history / upstream-status pages hit these on every load). */
  private commitListCache = new Map<string, { at: number; value: Promise<MainCommit[]> }>();
  static readonly COMMIT_LIST_TTL_MS = 30_000;

  constructor(
    private config: HalleyConfig,
    retry?: GitHubRetryOptions,
    deps: GitHubServiceDeps = {},
  ) {
    this.retryInput = { ...retry };
    this.retry = resolveRetryOptions(retry);
    this.fetchImpl = deps.fetch ?? ((...args) => fetch(...args));
    this.clock = deps.clock ?? realClock;
    this.sleepImpl = retry?.sleep ?? ((ms) => this.clock.sleep(ms));
  }

  private backoff(attempt: number, res: Pick<Response, 'headers' | 'status'> | null): Promise<void> {
    return this.sleepImpl(computeRetryDelayMs(attempt, res, this.retryInput, this.clock.now()));
  }

  get ownerRepo(): { owner: string; repo: string } {
    const [owner = '', repo = ''] = this.config.repo.split('/');
    return { owner, repo };
  }

  /**
   * The single retry loop behind every GitHub call. Each attempt gets a fresh init (and so a fresh
   * token / JWT) and a 15s deadline on the injected clock unless the caller passed a signal.
   * Network failures and 429/5xx are retried when `canRetry`; a caller abort never is.
   */
  private async request(
    url: string,
    pathForError: string,
    buildInit: () => Promise<RequestInit> | RequestInit,
    opts: { canRetry: boolean; formatError?: (status: number, bodyText: string) => string },
  ): Promise<Response> {
    const maxAttempts = opts.canRetry ? this.retry.maxAttempts : 1;
    for (let attempt = 1; ; attempt++) {
      const init = await buildInit();
      const callerSignal = init.signal;
      let res: Response;
      try {
        res = await this.fetchImpl(url, { ...init, signal: callerSignal ?? this.clock.timeoutSignal(15_000) });
      } catch (err) {
        if (callerSignal?.aborted || attempt >= maxAttempts) throw err;
        const delay = computeRetryDelayMs(attempt, null, this.retryInput, this.clock.now());
        logger.warn('github request network error; retrying', {
          path: pathForError,
          method: init.method ?? 'GET',
          attempt,
          delayMs: delay,
          err,
        });
        await this.sleepImpl(delay);
        continue;
      }
      if (res.ok) return res;
      const text = await res.text().catch((err) => {
        ignore(err, 'github: reading error body failed', { path: pathForError, status: res.status }, 'debug');
        return '';
      });
      if (attempt < maxAttempts && isTransientGitHubStatus(res.status)) {
        const delay = computeRetryDelayMs(attempt, res, this.retryInput, this.clock.now());
        logger.warn('github request transient error; retrying', {
          path: pathForError,
          method: init.method ?? 'GET',
          status: res.status,
          attempt,
          delayMs: delay,
        });
        await this.sleepImpl(delay);
        continue;
      }
      throw new GitHubApiError(
        res.status,
        pathForError,
        opts.formatError ? opts.formatError(res.status, text) : `GitHub API ${pathForError} failed (${res.status}): ${text}`,
      );
    }
  }

  private createAppJwt(): string {
    const now = Math.floor(this.clock.now() / 1000);
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
      if (this.cachedInstallToken && this.clock.now() < this.cachedInstallToken.expiresAt - 120_000) {
        return this.cachedInstallToken.token;
      }
      // Minting an installation token has no side effects beyond a fresh token: safe to retry
      const tokenPath = `/app/installations/${this.config.githubAppInstallationId}/access_tokens`;
      const res = await this.request(
        `${this.config.githubApiBaseUrl}${tokenPath}`,
        tokenPath,
        () => ({
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.createAppJwt()}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'halley-editor',
          },
        }),
        {
          canRetry: true,
          formatError: (status, bodyText) => `GitHub App token failed: ${status} ${bodyText}`,
        },
      );
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

  /**
   * REST call through the shared retry loop. Only idempotent methods (GET/HEAD) are retried unless
   * `retryable` is set; non-idempotent writes get their own lookup-before-retry logic.
   */
  private async api<T>(path: string, init?: RequestInit & { retryable?: boolean }): Promise<T> {
    const method = (init?.method ?? 'GET').toUpperCase();
    const { retryable, ...fetchInit } = init ?? {};
    const res = await this.request(
      `${this.config.githubApiBaseUrl}${path}`,
      path,
      async () => {
        const token = await this.getAccessToken();
        return {
          ...fetchInit,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'halley-editor',
            ...(fetchInit.headers ?? {}),
          },
        };
      },
      { canRetry: retryable ?? IDEMPOTENT_METHODS.has(method) },
    );
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Open PR whose head is `headBranch` (used to re-adopt a PR created just before a crash). */
  async findOpenPrForBranch(headBranch: string): Promise<PrInfo | null> {
    const { owner, repo } = this.ownerRepo;
    const existing = await this.api<
      Array<{ number: number; html_url: string; node_id: string; head: { sha: string }; updated_at?: string }>
    >(`/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${headBranch}`)}`);
    const pr = existing[0];
    if (!pr) return null;
    return {
      number: pr.number,
      url: pr.html_url,
      nodeId: pr.node_id,
      headSha: pr.head.sha,
      ...(pr.updated_at ? { updatedAt: pr.updated_at } : {}),
    };
  }

  /**
   * Opens (or updates) the PR for `headBranch`, safe to retry: every attempt first looks up an open
   * PR by head, so a POST whose response was lost (502 after GitHub created the PR, network reset)
   * is adopted on the next attempt instead of creating a duplicate. A 422 "A pull request already
   * exists" is treated the same way.
   */
  async createOrUpdatePr(input: {
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<PrInfo> {
    const { owner, repo } = this.ownerRepo;
    type PrResponse = { number: number; html_url: string; node_id: string; head: { sha: string } };
    const toInfo = (pr: PrResponse): PrInfo => ({
      number: pr.number,
      url: pr.html_url,
      nodeId: pr.node_id,
      headSha: pr.head.sha,
    });
    // Only the non-idempotent POST is retried here. The lookup GET and the PATCH already go through
    // api()'s own retry loop, so their exhausted failures propagate instead of being retried twice.
    const maxAttempts = this.retry.maxAttempts;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const existing = await this.findOpenPrForBranch(input.headBranch);
      if (existing) {
        // PATCH of title/body is idempotent: let api() retry transient failures itself
        const updated = await this.api<PrResponse>(`/repos/${owner}/${repo}/pulls/${existing.number}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: input.title, body: input.body }),
          retryable: true,
        });
        return toInfo(updated);
      }
      try {
        const created = await this.api<PrResponse>(`/repos/${owner}/${repo}/pulls`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: input.title,
            body: input.body,
            head: input.headBranch,
            base: input.baseBranch,
          }),
        });
        return toInfo(created);
      } catch (err) {
        lastErr = err;
        const alreadyExists =
          err instanceof GitHubApiError && err.status === 422 && /pull request already exists/i.test(err.message);
        if (!alreadyExists && !isTransientGitHubError(err)) throw err;
        if (attempt >= maxAttempts) break;
        logger.warn('github: creating PR failed; re-checking for an existing PR before retrying', {
          headBranch: input.headBranch,
          attempt,
          alreadyExists,
          err,
        });
        // "already exists" → look it up right away; transient → back off first
        if (!alreadyExists) await this.backoff(attempt, null);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('Creating the pull request failed');
  }

  /**
   * GraphQL POST. The auto-merge mutations used here are idempotent, so network errors and
   * 429/5xx are retried with the shared backoff.
   */
  private async graphql(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<{ errors?: Array<{ message?: string; type?: string }> }> {
    const res = await this.request(
      `${this.config.githubApiBaseUrl}/graphql`,
      '/graphql',
      async () => {
        const token = await this.getAccessToken();
        return {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'halley-editor',
          },
          body: JSON.stringify({ query, variables }),
        };
      },
      { canRetry: true, formatError: (status, text) => `GitHub GraphQL failed (${status}): ${text}` },
    );
    return (await res.json()) as { errors?: Array<{ message?: string; type?: string }> };
  }

  private static graphqlErrorText(errors: Array<{ message?: string }> | undefined): string {
    return (errors ?? []).map((e) => e?.message ?? '').join('; ');
  }

  /**
   * Arms GitHub native auto-merge (squash). Idempotent and retried; an "already enabled" error
   * (a retry after a lost response) counts as success.
   */
  async tryEnableNativeAutoMerge(
    prNodeId: string,
    commitHeadline: string,
    commitBody?: string,
  ): Promise<boolean> {
    try {
      const json = await this.graphql(
        `mutation($id: ID!, $headline: String!, $body: String) {
            enablePullRequestAutoMerge(input: {
              pullRequestId: $id,
              mergeMethod: SQUASH,
              commitHeadline: $headline,
              commitBody: $body
            }) {
              pullRequest { id }
            }
          }`,
        { id: prNodeId, headline: commitHeadline, body: commitBody ?? null },
      );
      if (!json.errors?.length) return true;
      const text = GitHubService.graphqlErrorText(json.errors);
      if (/already enabled|auto-?merge is already|already in auto-?merge/i.test(text)) return true;
      ignore(
        new Error(text),
        'enabling native auto-merge was refused; falling back to control-plane squash merge',
        { prNodeId },
        'debug',
      );
      return false;
    } catch (err) {
      ignore(err, 'enabling native auto-merge failed; falling back to control-plane squash merge', {
        prNodeId,
      });
      return false;
    }
  }

  /** Best-effort: disarm GitHub native auto-merge so a failed/abandoned publish cannot self-merge. */
  async tryDisableNativeAutoMerge(prNodeId: string): Promise<boolean> {
    try {
      const json = await this.graphql(
        `mutation($id: ID!) {
            disablePullRequestAutoMerge(input: { pullRequestId: $id }) {
              pullRequest { id }
            }
          }`,
        { id: prNodeId },
      );
      if (!json.errors?.length) return true;
      const text = GitHubService.graphqlErrorText(json.errors);
      // Retried after a lost response, or never armed: either way it is now disarmed
      if (/not enabled|already disabled|auto-?merge is not|not in auto-?merge/i.test(text)) return true;
      ignore(new Error(text), 'disabling native auto-merge was refused', { prNodeId });
      return false;
    } catch (err) {
      ignore(err, 'disabling native auto-merge failed', { prNodeId });
      return false;
    }
  }

  async getPrState(prNumber: number): Promise<{
    merged: boolean;
    mergeCommitSha: string | null;
    state: 'open' | 'closed';
    headSha: string;
    nodeId: string | null;
  }> {
    const { owner, repo } = this.ownerRepo;
    const pr = await this.api<{
      merged: boolean;
      merge_commit_sha: string | null;
      state: 'open' | 'closed';
      head: { sha: string };
      node_id?: string;
    }>(`/repos/${owner}/${repo}/pulls/${prNumber}`);
    return {
      merged: pr.merged,
      mergeCommitSha: pr.merge_commit_sha,
      state: pr.state,
      headSha: pr.head.sha,
      nodeId: pr.node_id ?? null,
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

  /**
   * Squash-merges the PR, pinned to `headSha` so GitHub refuses (409) if the head moved. Safe to
   * retry: after any failure the PR is re-read, and an already-merged PR returns its merge commit
   * (a retried PUT whose first response was lost reports 405 "already merged").
   */
  async squashMergePr(input: {
    prNumber: number;
    commitTitle: string;
    commitMessage: string;
    headSha?: string;
  }): Promise<string> {
    const { owner, repo } = this.ownerRepo;
    const maxAttempts = Math.max(1, this.retry.maxAttempts);
    for (let attempt = 1; ; attempt++) {
      try {
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
      } catch (err) {
        const status = err instanceof GitHubApiError ? err.status : null;
        const transient = isTransientGitHubError(err);
        if (status === 405 || status === 409 || transient) {
          // The merge may have happened (lost response / concurrent native auto-merge): re-read
          const pr = await this.getPrState(input.prNumber).catch((readErr) => {
            ignore(readErr, 'github: re-reading PR after merge failure failed', { prNumber: input.prNumber });
            return null;
          });
          if (pr?.merged && pr.mergeCommitSha) return pr.mergeCommitSha;
          if (status === 409 && pr && input.headSha && pr.headSha !== input.headSha) {
            throw new GitHubApiError(
              409,
              `/repos/${owner}/${repo}/pulls/${input.prNumber}/merge`,
              `Pull request head changed (${pr.headSha.slice(0, 7)}), refusing to merge unverified commit ${input.headSha.slice(0, 7)}`,
            );
          }
        }
        if (!transient || attempt >= maxAttempts) throw err;
        logger.warn('github: squash merge transient failure; retrying', { prNumber: input.prNumber, attempt, err });
        await this.backoff(attempt, null);
      }
    }
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
      } catch (err) {
        // Expected: dynamic GitHub Pages workflows have no contents entry (404). Anything else is
        // surprising enough to leave a trace, but must not fail the CI-presence probe.
        if (!(err instanceof GitHubApiError && err.status === 404)) {
          ignore(err, 'github: reading workflow file failed', { path: cleanPath });
        }
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

  /**
   * Recent commits on `baseBranch` (empty list when GitHub is unavailable). Cached for ~30s and
   * single-flight per (branch, limit): history/upstream-status pages call this on every load.
   */
  async listMainCommits(baseBranch: string, limit = 30): Promise<MainCommit[]> {
    const key = `${baseBranch}\u0000${limit}`;
    const now = this.clock.now();
    const hit = this.commitListCache.get(key);
    if (hit && now - hit.at < GitHubService.COMMIT_LIST_TTL_MS) return hit.value;
    const value = this.fetchMainCommits(baseBranch, limit);
    this.commitListCache.set(key, { at: now, value });
    const result = await value;
    // Do not keep an empty (failed) result for the full TTL: retry on the next call
    if (result.length === 0 && this.commitListCache.get(key)?.value === value) this.commitListCache.delete(key);
    return result;
  }

  private async fetchMainCommits(baseBranch: string, limit: number): Promise<MainCommit[]> {
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
        date: c.commit.author?.date || new Date(this.clock.now()).toISOString(),
        subject: (c.commit.message || '').split(/\r?\n/)[0] || 'Commit',
      }));
    } catch (err) {
      ignore(err, 'github: listing base branch commits failed; returning none', { baseBranch }, 'debug');
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
    } catch (err) {
      ignore(err, 'github: reading commit files failed; returning none', { sha }, 'debug');
      return [];
    }
  }
}
