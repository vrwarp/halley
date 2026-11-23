import type {
  AllowlistEntryDto,
  CheckpointInfo,
  EditorSessionDto,
  GitFileChange,
  SpendStatusDto,
  StagedAttachment,
  UserDto,
  VerificationCheckResult,
} from '@halley/shared';

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
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

export const api = {
  me: () => apiFetch<AuthMeResponse>('/api/auth/me'),
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

  listSessions: () =>
    apiFetch<{ sessions: EditorSessionDto[]; spend: SpendStatusDto }>('/api/sessions'),
  createSession: (title: string) =>
    apiFetch<{ session: EditorSessionDto }>('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }),
  getSession: (id: string) =>
    apiFetch<{ session: EditorSessionDto; spend: SpendStatusDto }>(`/api/sessions/${id}`),
  duplicateSession: (id: string) =>
    apiFetch<{ session: EditorSessionDto }>(`/api/sessions/${id}/duplicate`, { method: 'POST' }),
  takeoverSession: (id: string) =>
    apiFetch<{ session: EditorSessionDto }>(`/api/sessions/${id}/takeover`, { method: 'POST' }),
  deleteSession: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/sessions/${id}`, { method: 'DELETE' }),

  getRoutes: (id: string) =>
    apiFetch<{ routes: Array<{ route: string; label: string; unlisted?: boolean }> }>(
      `/api/sessions/${id}/routes`,
    ),
  getChanges: (id: string) =>
    apiFetch<{ changes: GitFileChange[]; checkpoints: CheckpointInfo[] }>(`/api/sessions/${id}/changes`),
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
    const res = await fetch(`/api/sessions/${id}/uploads`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error('Upload failed');
    const data = (await res.json()) as { attachment: StagedAttachment };
    return data.attachment;
  },
  publish: (id: string, title: string, summary: string) =>
    apiFetch<{ ok: boolean }>(`/api/sessions/${id}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, summary }),
    }),
  fixWithPi: (id: string, errorSummary: string, logs?: string) =>
    apiFetch<{ ok: boolean }>(`/api/sessions/${id}/fix-with-pi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ errorSummary, logs }),
    }),

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
};
