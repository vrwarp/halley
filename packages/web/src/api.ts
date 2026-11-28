import type {
  AllowlistEntryDto,
  AstroAuditReportDto,
  ChangeCardDto,
  CheckpointInfo,
  CreatePageRequest,
  CreatePageResultDto,
  EditorSessionDto,
  EscalationEstimateDto,
  GitFileChange,
  LiveHistoryEntryDto,
  MergeReviewStateDto,
  OptimizeAiEstimateDto,
  PageCreationOptionsDto,
  PageRequestMetadata,
  SiteRouteEntryDto,
  SpendStatusDto,
  StagedAttachment,
  TranscriptEntryDto,
  UserDto,
  VerificationCheckResult,
  VisualDiffPageDto,
} from '@halley/shared';

/** Error thrown by {@link apiFetch}; carries the HTTP status (0 for network failures). */
export class ApiError extends Error {
  readonly status: number;
  readonly url: string;
  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.url = url;
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** `error` string from a JSON error body; undefined for non-JSON bodies (e.g. a proxy HTML page). */
function serverErrorMessage(raw: string): string | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    // Expected: non-JSON error bodies (proxy/HTML pages). Anything else is a real bug.
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
  const error = (data as { error?: unknown } | null)?.error;
  return typeof error === 'string' && error ? error : undefined;
}

async function apiFetch<T>(url: string, init?: RequestInit, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, signal ? { ...init, signal } : init);
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new ApiError(
      `Network error contacting ${url}: ${err instanceof Error ? err.message : String(err)}`,
      0,
      url,
    );
  }
  const raw = await res.text();
  if (!res.ok) {
    const serverMessage = serverErrorMessage(raw);
    throw new ApiError(
      serverMessage ? `${serverMessage} (HTTP ${res.status})` : `Request failed (HTTP ${res.status})`,
      res.status,
      url,
    );
  }
  if (res.status === 204) return undefined as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    const ct = res.headers.get('content-type') ?? 'unknown content-type';
    throw new ApiError(
      `Unexpected non-JSON response from ${url} (HTTP ${res.status}, ${ct})`,
      res.status,
      url,
    );
  }
}

export interface AuthMeResponse {
  authenticated: boolean;
  devLoginEnabled?: boolean;
  googleEnabled?: boolean;
  repo: string;
  baseBranch?: string;
  user?: UserDto;
  spend?: SpendStatusDto;
}

export interface PriorThreadDto {
  parentSessionId: string;
  parentTitle: string;
  parentStatus: string;
  parentPublishedAt: string;
  entries: TranscriptEntryDto[];
}

export const api = {
  me: (signal?: AbortSignal) => apiFetch<AuthMeResponse>('/api/auth/me', undefined, signal),
  devLogin: (email?: string, name?: string) =>
    apiFetch<{ user: UserDto; spend: SpendStatusDto }>('/api/auth/dev-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name }),
    }),
  logout: () => apiFetch<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  updatePreferences: (persona: 'non-technical' | 'developer') =>
    apiFetch<{ user: UserDto }>('/api/auth/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona }),
    }),

  listSessions: (signal?: AbortSignal) =>
    apiFetch<{ sessions: EditorSessionDto[]; spend: SpendStatusDto }>('/api/sessions', undefined, signal),
  listHistory: () => apiFetch<{ entries: LiveHistoryEntryDto[] }>('/api/history'),
  createSession: (title: string) =>
    apiFetch<{ session: EditorSessionDto }>('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }),
  getSession: (id: string, signal?: AbortSignal) =>
    apiFetch<{ session: EditorSessionDto; spend: SpendStatusDto }>(`/api/sessions/${id}`, undefined, signal),
  wakeSession: (id: string) =>
    apiFetch<{ session: EditorSessionDto }>(`/api/sessions/${id}/wake`, { method: 'POST' }),
  restartSession: (id: string) =>
    apiFetch<{ session: EditorSessionDto }>(`/api/sessions/${id}/restart`, { method: 'POST' }),
  duplicateSession: (id: string) =>
    apiFetch<{ session: EditorSessionDto }>(`/api/sessions/${id}/duplicate`, { method: 'POST' }),
  revertPublication: (body: {
    sessionId?: string;
    sha?: string;
    shas?: string[];
    reason: string;
    title?: string;
  }) =>
    apiFetch<{ session: EditorSessionDto; revertResult?: Record<string, unknown> | null }>(
      '/api/sessions/revert',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
  retryDeploy: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/sessions/${id}/retry-deploy`, { method: 'POST' }),
  takeoverSession: (id: string) =>
    apiFetch<{ session: EditorSessionDto }>(`/api/sessions/${id}/takeover`, { method: 'POST' }),
  deleteSession: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/sessions/${id}`, { method: 'DELETE' }),

  getRoutes: (id: string) =>
    apiFetch<{ routes: SiteRouteEntryDto[] }>(`/api/sessions/${id}/routes`),
  getPageOptions: (id: string) =>
    apiFetch<PageCreationOptionsDto>(`/api/sessions/${id}/page-options`),
  createPage: (id: string, req: CreatePageRequest) =>
    apiFetch<CreatePageResultDto>(`/api/sessions/${id}/pages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),
  retryPageRequest: (id: string, pageRequestId: string, viewport?: 'desktop' | 'tablet' | 'mobile') =>
    apiFetch<{ ok: boolean; pageRequest?: PageRequestMetadata }>(
      `/api/sessions/${id}/pages/${encodeURIComponent(pageRequestId)}/retry`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewport }),
      },
    ),
  deletePage: (id: string, route: string) =>
    apiFetch<{ ok: boolean; deletedFile: string }>(
      `/api/sessions/${id}/pages?route=${encodeURIComponent(route)}`,
      { method: 'DELETE' },
    ),
  setPageVisibility: (
    id: string,
    route: string,
    unlisted: boolean,
    viewport?: 'desktop' | 'tablet' | 'mobile',
  ) =>
    apiFetch<{ ok: boolean; route: string; unlisted: boolean; file: string }>(
      `/api/sessions/${id}/pages/visibility`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ route, unlisted, viewport }),
      },
    ),
  renamePage: (id: string, fromRoute: string, toSection: string, toSlug: string) =>
    apiFetch<{
      ok: boolean;
      fromRoute: string;
      toRoute: string;
      file: string;
      updatedReferencesCount: number;
    }>(`/api/sessions/${id}/pages/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromRoute, toSection, toSlug }),
    }),
  getChanges: (id: string) =>
    apiFetch<{ changes: GitFileChange[]; checkpoints: CheckpointInfo[] }>(`/api/sessions/${id}/changes`),
  getReview: (
    id: string,
    screenshots = false,
    viewport: 'desktop' | 'mobile' = 'desktop',
    activeRoute?: string,
  ) => {
    const qs = new URLSearchParams({
      screenshots: screenshots ? '1' : '0',
      viewport,
    });
    if (activeRoute) qs.set('activeRoute', activeRoute);
    return apiFetch<{
      cards: ChangeCardDto[];
      pages: VisualDiffPageDto[];
      targetRoutes?: string[];
      mergeReview: MergeReviewStateDto | null;
      baseSha: string;
      prevBaseSha: string | null;
    }>(`/api/sessions/${id}/review?${qs.toString()}`);
  },
  getReviewScreenshot: (
    id: string,
    opts: {
      route: string;
      viewport: 'desktop' | 'mobile';
      signal?: AbortSignal;
    },
  ) => {
    const qs = new URLSearchParams({
      route: opts.route,
      viewport: opts.viewport,
    });
    return apiFetch<{ page: VisualDiffPageDto }>(
      `/api/sessions/${id}/review/screenshot?${qs.toString()}`,
      opts.signal ? { signal: opts.signal } : undefined,
    );
  },
  getUpstreamStatus: (id: string) =>
    apiFetch<{
      behind: boolean;
      latestMainSha: string;
      newerCommits: Array<{ sha: string; shortSha: string; author: string; date: string; subject: string }>;
      coEditors: Array<{ sessionId: string; title: string; ownerName: string; changedFilesCount: number }>;
    }>(`/api/sessions/${id}/upstream-status`),
  syncSession: (
    id: string,
    opts?: {
      kind?: 'sync' | 'publish' | 'revert';
      autoSyncOnly?: boolean;
      autoApplyCleanOnly?: boolean;
    },
  ) =>
    apiFetch<{
      review?: MergeReviewStateDto;
      heldForUser?: boolean;
      overlapCount?: number;
    }>(`/api/sessions/${id}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts ?? {}),
    }),
  chooseSyncConflicts: (
    id: string,
    choices: Array<{ recordId: string; optionId: string; customInstruction?: string }>,
  ) =>
    apiFetch<{ review: MergeReviewStateDto }>(`/api/sessions/${id}/sync/choose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choices }),
    }),
  undoSync: (id: string, targetSha?: string) =>
    apiFetch<{ ok: boolean }>(`/api/sessions/${id}/sync/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetSha }),
    }),
  estimateEscalation: (id: string, body: { recordIds?: string[]; userNote?: string }) =>
    apiFetch<{ estimate: EscalationEstimateDto }>(`/api/sessions/${id}/sync/estimate-escalation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  escalateMerge: (
    id: string,
    body: { recordIds?: string[]; userNote?: string; ceilingUsd?: number },
  ) =>
    apiFetch<{ review: MergeReviewStateDto }>(`/api/sessions/${id}/sync/escalate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  applyAdvancedMerge: (id: string, picks: Array<{ path: string; use: 'advanced' | 'first' }>) =>
    apiFetch<{ review: MergeReviewStateDto }>(`/api/sessions/${id}/sync/apply-advanced`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ picks }),
    }),
  revertFile: (id: string, filePath: string) =>
    apiFetch<{ ok: boolean }>(`/api/sessions/${id}/revert-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    }),
  undoCheckpoint: (id: string, targetSha: string) =>
    apiFetch<{ ok: boolean; checkpoint: CheckpointInfo | null }>(`/api/sessions/${id}/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetSha }),
    }),
  runVerify: (id: string) =>
    apiFetch<{ allPassed: boolean; results: VerificationCheckResult[] }>(
      `/api/sessions/${id}/verify`,
      { method: 'POST' },
    ),
  uploadImage: async (id: string, file: File): Promise<StagedAttachment> => {
    const fd = new FormData();
    fd.append('file', file);
    const data = await apiFetch<{ attachment: StagedAttachment }>(`/api/sessions/${id}/uploads`, {
      method: 'POST',
      body: fd,
    });
    return data.attachment;
  },
  publish: (
    id: string,
    title: string,
    summary: string,
    opts?: { excludePaths?: string[]; background?: boolean },
  ) =>
    apiFetch<{ ok: boolean; started?: boolean }>(`/api/sessions/${id}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        summary,
        ...(opts?.excludePaths && opts.excludePaths.length > 0
          ? { excludePaths: opts.excludePaths }
          : {}),
        background: opts?.background ?? true,
      }),
    }),
  fixWithPi: (id: string, errorSummary: string, logs?: string) =>
    apiFetch<{ ok: boolean }>(`/api/sessions/${id}/fix-with-pi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ errorSummary, logs }),
    }),
  sendClientMessage: (id: string, msg: unknown) =>
    apiFetch<{ ok: boolean }>(`/api/sessions/${id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    }),
  getTranscript: (id: string, signal?: AbortSignal) =>
    apiFetch<{
      entries: TranscriptEntryDto[];
      live: import('@halley/shared').LiveRunStateDto;
      volumeExpired?: boolean;
      priorThread?: PriorThreadDto | null;
      pageRequests?: PageRequestMetadata[];
    }>(`/api/sessions/${id}/transcript`, undefined, signal),
  getDebugTrace: (id: string) =>
    apiFetch<import('@halley/shared').DebugTraceDto>(`/api/sessions/${id}/debug-trace`),

  adminOverview: () =>
    apiFetch<{
      allowlist: AllowlistEntryDto[];
      users: UserDto[];
      dailyCapUsd: number;
      todaySpend: Array<{
        userId: string;
        email: string;
        name: string;
        isAdmin: number;
        costUsd: number;
        inputTokens: number;
        outputTokens: number;
        extraGrantedUsd: number;
      }>;
      spendByPurpose?: Array<{
        purpose: string;
        requestCount: number;
        costUsd: number;
        inputTokens: number;
        outputTokens: number;
      }>;
      sessions: EditorSessionDto[];
    }>('/api/admin/overview'),
  addAllowlist: (kind: 'email' | 'domain', value: string) =>
    apiFetch<{ entry: AllowlistEntryDto }>('/api/admin/allowlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, value }),
    }),
  removeAllowlist: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/admin/allowlist/${id}`, { method: 'DELETE' }),
  setDailyCap: (dailyCapUsd: number) =>
    apiFetch<{ dailyCapUsd: number }>('/api/admin/cap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dailyCapUsd }),
    }),
  grantExtra: (userId: string, extraUsd = 10) =>
    apiFetch<{ ok: boolean }>(`/api/admin/users/${userId}/grant-extra`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extraUsd }),
    }),
  sleepSession: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/admin/sessions/${id}/sleep`, { method: 'POST' }),

  adminOptimizeLatest: () =>
    apiFetch<{
      report: AstroAuditReportDto | null;
      defaultModelId: string;
      escalationModelId: string;
      aiCeilingUsd: number;
    }>('/api/admin/optimize/latest'),
  adminOptimizeScan: (force = false) =>
    apiFetch<{
      report: AstroAuditReportDto;
      defaultModelId: string;
      escalationModelId: string;
    }>('/api/admin/optimize/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    }),
  adminOptimizeAiEstimate: (sha: string) =>
    apiFetch<{ estimate: OptimizeAiEstimateDto }>('/api/admin/optimize/ai-estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha }),
    }),
  adminOptimizeAiReview: (sha: string) =>
    apiFetch<{ report: AstroAuditReportDto }>('/api/admin/optimize/ai-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha }),
    }),
  adminCreateOptimizationDraft: (body: {
    sha: string;
    findingIds: string[];
    useEscalationModel?: boolean;
    title?: string;
  }) =>
    apiFetch<{ session: EditorSessionDto }>('/api/admin/optimize/create-draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
};
