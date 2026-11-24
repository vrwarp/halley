import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AllowlistEntryDto,
  EditorSessionDto,
  PublishState,
  SessionArchiveDto,
  SessionKind,
  SessionStatus,
  SpendStatusDto,
  UserDto,
} from '@halley/shared';
import type { HalleyConfig } from './config.js';

export interface SessionRecord {
  id: string;
  title: string;
  slug: string;
  kind: SessionKind;
  parent_session_id: string | null;
  reverts_sha: string | null;
  revert_reason: string | null;
  owner_user_id: string;
  owner_name?: string;
  owner_email?: string;
  owner_picture?: string | null;
  repo: string;
  base_branch: string;
  working_branch: string;
  base_sha: string;
  prev_base_sha: string | null;
  status: SessionStatus;
  publish_state: PublishState;
  publish_error: string | null;
  pr_number: number | null;
  pr_url: string | null;
  merged_sha: string | null;
  merged_at: string | null;
  volume_name: string;
  container_id: string | null;
  runner_url: string | null;
  astro_url: string | null;
  workspace_token_hash: string;
  astro_base: string;
  changed_files_count: number;
  last_active_at: string;
  archived_at: string | null;
  node_modules_pruned_at: string | null;
  volume_expired_at: string | null;
  created_at: string;
}

export class ControlPlaneDb {
  readonly db: DatabaseSync;

  constructor(dbPath: string, private config: HalleyConfig) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
    this.seedAllowlist();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        picture TEXT,
        is_admin INTEGER NOT NULL DEFAULT 0,
        persona TEXT NOT NULL DEFAULT 'non-technical',
        created_at TEXT NOT NULL,
        last_login_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS allowlist (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('email', 'domain')),
        value TEXT NOT NULL,
        added_by TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(kind, value)
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS daily_spend (
        user_id TEXT NOT NULL,
        utc_date TEXT NOT NULL,
        cost_usd REAL NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        extra_granted_usd REAL NOT NULL DEFAULT 0,
        PRIMARY KEY(user_id, utc_date)
      );

      CREATE TABLE IF NOT EXISTS editor_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        slug TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'edit',
        parent_session_id TEXT,
        reverts_sha TEXT,
        revert_reason TEXT,
        owner_user_id TEXT NOT NULL REFERENCES users(id),
        repo TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        working_branch TEXT NOT NULL,
        base_sha TEXT NOT NULL DEFAULT '',
        prev_base_sha TEXT,
        status TEXT NOT NULL DEFAULT 'starting',
        publish_state TEXT NOT NULL DEFAULT 'idle',
        publish_error TEXT,
        pr_number INTEGER,
        pr_url TEXT,
        merged_sha TEXT,
        merged_at TEXT,
        volume_name TEXT NOT NULL,
        container_id TEXT,
        runner_url TEXT,
        astro_url TEXT,
        workspace_token_hash TEXT NOT NULL,
        astro_base TEXT NOT NULL DEFAULT '/',
        changed_files_count INTEGER NOT NULL DEFAULT 0,
        last_active_at TEXT NOT NULL,
        archived_at TEXT,
        node_modules_pruned_at TEXT,
        volume_expired_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_archives (
        session_id TEXT PRIMARY KEY REFERENCES editor_sessions(id) ON DELETE CASCADE,
        transcript_json TEXT NOT NULL,
        handoff_summary TEXT,
        diff_summary TEXT NOT NULL DEFAULT '[]',
        merged_sha TEXT,
        pr_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS spend_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_id TEXT,
        utc_date TEXT NOT NULL,
        purpose TEXT NOT NULL DEFAULT 'chat',
        model TEXT NOT NULL DEFAULT '',
        cost_usd REAL NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);

    // Idempotent migrations for existing SQLite databases created before P0
    const cols = new Set(
      (this.db.prepare('PRAGMA table_info(editor_sessions)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    const addCol = (name: string, def: string) => {
      if (!cols.has(name)) {
        this.db.exec(`ALTER TABLE editor_sessions ADD COLUMN ${name} ${def}`);
      }
    };
    addCol('kind', "TEXT NOT NULL DEFAULT 'edit'");
    addCol('parent_session_id', 'TEXT');
    addCol('reverts_sha', 'TEXT');
    addCol('revert_reason', 'TEXT');
    addCol('prev_base_sha', 'TEXT');
    addCol('node_modules_pruned_at', 'TEXT');
    addCol('volume_expired_at', 'TEXT');

    const existingCap = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('daily_cost_cap_usd') as { value: string } | undefined;
    if (!existingCap) {
      this.db
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
        .run('daily_cost_cap_usd', String(this.config.dailyCostCapUsd));
    }
  }

  private seedAllowlist(): void {
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO allowlist (id, kind, value, added_by, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const email of [...this.config.adminEmails, ...this.config.allowedEmails]) {
      insert.run(crypto.randomUUID(), 'email', email.toLowerCase(), 'env', now);
    }
    for (const domain of this.config.allowedDomains) {
      insert.run(crypto.randomUUID(), 'domain', domain.toLowerCase(), 'env', now);
    }
  }

  isEmailAllowed(email: string): boolean {
    const norm = email.trim().toLowerCase();
    if (this.config.adminEmails.includes(norm)) return true;
    const domain = norm.split('@')[1] ?? '';
    const row = this.db
      .prepare(
        "SELECT 1 FROM allowlist WHERE (kind = 'email' AND value = ?) OR (kind = 'domain' AND value = ?) LIMIT 1",
      )
      .get(norm, domain);
    return Boolean(row);
  }

  upsertUser(input: { email: string; name: string; picture: string | null }): UserDto {
    const email = input.email.trim().toLowerCase();
    const now = new Date().toISOString();
    const isAdminEnv = this.config.adminEmails.includes(email);

    const existing = this.db
      .prepare('SELECT * FROM users WHERE email = ?')
      .get(email) as
      | { id: string; email: string; name: string; picture: string | null; is_admin: number; persona?: string }
      | undefined;

    if (existing) {
      const nextAdmin = isAdminEnv ? 1 : existing.is_admin;
      const persona = existing.persona === 'developer' ? 'developer' : 'non-technical';
      this.db
        .prepare('UPDATE users SET name = ?, picture = ?, is_admin = ?, last_login_at = ? WHERE id = ?')
        .run(input.name, input.picture, nextAdmin, now, existing.id);
      return {
        id: existing.id,
        email: existing.email,
        name: input.name,
        picture: input.picture,
        isAdmin: nextAdmin === 1,
        persona,
      };
    }

    const id = crypto.randomUUID();
    const isAdmin = isAdminEnv ? 1 : 0;
    this.db
      .prepare(
        'INSERT INTO users (id, email, name, picture, is_admin, persona, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, email, input.name, input.picture, isAdmin, 'non-technical', now, now);

    return {
      id,
      email,
      name: input.name,
      picture: input.picture,
      isAdmin: isAdmin === 1,
      persona: 'non-technical',
    };
  }

  getUserById(id: string): UserDto | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
      | { id: string; email: string; name: string; picture: string | null; is_admin: number; persona?: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      picture: row.picture,
      isAdmin: row.is_admin === 1,
      persona: row.persona === 'developer' ? 'developer' : 'non-technical',
    };
  }

  listUsers(): UserDto[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY email ASC').all() as Array<{
      id: string;
      email: string;
      name: string;
      picture: string | null;
      is_admin: number;
      persona?: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      picture: r.picture,
      isAdmin: r.is_admin === 1,
      persona: r.persona === 'developer' ? 'developer' : 'non-technical',
    }));
  }

  setUserPersona(userId: string, persona: 'non-technical' | 'developer'): void {
    this.db.prepare('UPDATE users SET persona = ? WHERE id = ?').run(persona, userId);
  }

  setUserAdmin(userId: string, isAdmin: boolean): void {
    this.db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, userId);
  }

  listAllowlist(): AllowlistEntryDto[] {
    const rows = this.db
      .prepare('SELECT * FROM allowlist ORDER BY kind ASC, value ASC')
      .all() as Array<{
      id: string;
      kind: 'email' | 'domain';
      value: string;
      added_by: string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      value: r.value,
      addedBy: r.added_by,
      createdAt: r.created_at,
    }));
  }

  addAllowlist(kind: 'email' | 'domain', value: string, addedBy: string): AllowlistEntryDto {
    const clean = value.trim().toLowerCase().replace(/^@/, '');
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare('INSERT OR IGNORE INTO allowlist (id, kind, value, added_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, kind, clean, addedBy, now);
    return { id, kind, value: clean, addedBy, createdAt: now };
  }

  removeAllowlist(id: string): void {
    this.db.prepare('DELETE FROM allowlist WHERE id = ?').run(id);
  }

  getDailyCapUsd(): number {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('daily_cost_cap_usd') as { value: string } | undefined;
    return row ? Number(row.value) : this.config.dailyCostCapUsd;
  }

  setDailyCapUsd(cap: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('daily_cost_cap_usd', String(cap));
  }

  getSpendStatus(userId: string, utcDate = new Date().toISOString().slice(0, 10)): SpendStatusDto {
    const cap = this.getDailyCapUsd();
    const row = this.db
      .prepare('SELECT cost_usd, extra_granted_usd FROM daily_spend WHERE user_id = ? AND utc_date = ?')
      .get(userId, utcDate) as { cost_usd: number; extra_granted_usd: number } | undefined;
    const spent = row?.cost_usd ?? 0;
    const extra = row?.extra_granted_usd ?? 0;
    return {
      spentTodayUsd: Number(spent.toFixed(4)),
      dailyCapUsd: cap,
      extraGrantedUsd: extra,
      capped: spent >= cap + extra,
    };
  }

  recordSpend(
    userId: string,
    costUsd: number,
    inputTokens: number,
    outputTokens: number,
    utcDate = new Date().toISOString().slice(0, 10),
    meta?: { sessionId?: string; purpose?: string; model?: string },
  ): SpendStatusDto {
    this.db
      .prepare(
        `INSERT INTO daily_spend (user_id, utc_date, cost_usd, input_tokens, output_tokens, extra_granted_usd)
         VALUES (?, ?, ?, ?, ?, 0)
         ON CONFLICT(user_id, utc_date) DO UPDATE SET
           cost_usd = cost_usd + excluded.cost_usd,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens`,
      )
      .run(userId, utcDate, costUsd, inputTokens, outputTokens);
    if (meta) {
      this.db
        .prepare(
          `INSERT INTO spend_events (id, user_id, session_id, utc_date, purpose, model, cost_usd, input_tokens, output_tokens, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          userId,
          meta.sessionId ?? null,
          utcDate,
          meta.purpose ?? 'chat',
          meta.model ?? '',
          costUsd,
          inputTokens,
          outputTokens,
          new Date().toISOString(),
        );
    }
    return this.getSpendStatus(userId, utcDate);
  }

  listTodaySpendByPurpose(utcDate = new Date().toISOString().slice(0, 10)) {
    return this.db
      .prepare(
        `SELECT purpose,
                COUNT(*) as requestCount,
                COALESCE(SUM(cost_usd), 0) as costUsd,
                COALESCE(SUM(input_tokens), 0) as inputTokens,
                COALESCE(SUM(output_tokens), 0) as outputTokens
         FROM spend_events
         WHERE utc_date = ?
         GROUP BY purpose
         ORDER BY costUsd DESC`,
      )
      .all(utcDate) as Array<{
      purpose: string;
      requestCount: number;
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
    }>;
  }

  grantExtraSpend(userId: string, extraUsd: number, utcDate = new Date().toISOString().slice(0, 10)): void {
    this.db
      .prepare(
        `INSERT INTO daily_spend (user_id, utc_date, cost_usd, input_tokens, output_tokens, extra_granted_usd)
         VALUES (?, ?, 0, 0, 0, ?)
         ON CONFLICT(user_id, utc_date) DO UPDATE SET
           extra_granted_usd = extra_granted_usd + excluded.extra_granted_usd`,
      )
      .run(userId, utcDate, extraUsd);
  }

  listTodaySpendByUser(utcDate = new Date().toISOString().slice(0, 10)) {
    return this.db
      .prepare(
        `SELECT u.id as userId, u.email, u.name, u.is_admin as isAdmin,
                COALESCE(d.cost_usd, 0) as costUsd,
                COALESCE(d.input_tokens, 0) as inputTokens,
                COALESCE(d.output_tokens, 0) as outputTokens,
                COALESCE(d.extra_granted_usd, 0) as extraGrantedUsd
         FROM users u
         LEFT JOIN daily_spend d ON d.user_id = u.id AND d.utc_date = ?
         ORDER BY costUsd DESC, u.email ASC`,
      )
      .all(utcDate);
  }

  createSession(input: {
    id: string;
    title: string;
    slug: string;
    kind?: SessionKind;
    parentSessionId?: string | null;
    revertsSha?: string | null;
    revertReason?: string | null;
    ownerUserId: string;
    repo: string;
    baseBranch: string;
    workingBranch: string;
    baseSha?: string;
    volumeName: string;
    workspaceTokenHash: string;
  }): SessionRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO editor_sessions (
           id, title, slug, kind, parent_session_id, reverts_sha, revert_reason,
           owner_user_id, repo, base_branch, working_branch, base_sha,
           status, publish_state, volume_name, workspace_token_hash, last_active_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', 'idle', ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.title,
        input.slug,
        input.kind ?? 'edit',
        input.parentSessionId ?? null,
        input.revertsSha ?? null,
        input.revertReason ?? null,
        input.ownerUserId,
        input.repo,
        input.baseBranch,
        input.workingBranch,
        input.baseSha ?? '',
        input.volumeName,
        input.workspaceTokenHash,
        now,
        now,
      );
    return this.getSession(input.id)!;
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db
      .prepare(
        `SELECT s.*, u.name as owner_name, u.email as owner_email, u.picture as owner_picture
         FROM editor_sessions s
         JOIN users u ON u.id = s.owner_user_id
         WHERE s.id = ?`,
      )
      .get(id) as SessionRecord | undefined;
    return row ?? null;
  }

  getSessionByTokenHash(hash: string): SessionRecord | null {
    const row = this.db
      .prepare(
        `SELECT s.*, u.name as owner_name, u.email as owner_email, u.picture as owner_picture
         FROM editor_sessions s
         JOIN users u ON u.id = s.owner_user_id
         WHERE s.workspace_token_hash = ?`,
      )
      .get(hash) as SessionRecord | undefined;
    return row ?? null;
  }

  listSessions(): SessionRecord[] {
    return this.db
      .prepare(
        `SELECT s.*, u.name as owner_name, u.email as owner_email, u.picture as owner_picture
         FROM editor_sessions s
         JOIN users u ON u.id = s.owner_user_id
         ORDER BY s.last_active_at DESC`,
      )
      .all() as unknown as SessionRecord[];
  }

  updateSession(id: string, patch: Partial<SessionRecord>): void {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const cols = entries.map(([k]) => `${k} = ?`).join(', ');
    const vals = entries.map(([, v]) => v as string | number | null);
    this.db.prepare(`UPDATE editor_sessions SET ${cols} WHERE id = ?`).run(...vals, id);
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM editor_sessions WHERE id = ?').run(id);
  }

  upsertSessionArchive(input: {
    sessionId: string;
    transcriptJson: string;
    handoffSummary?: string | null;
    diffSummary?: string;
    mergedSha?: string | null;
    prUrl?: string | null;
  }): SessionArchiveDto {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO session_archives (
           session_id, transcript_json, handoff_summary, diff_summary, merged_sha, pr_url, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           transcript_json = excluded.transcript_json,
           handoff_summary = COALESCE(excluded.handoff_summary, session_archives.handoff_summary),
           diff_summary = excluded.diff_summary,
           merged_sha = COALESCE(excluded.merged_sha, session_archives.merged_sha),
           pr_url = COALESCE(excluded.pr_url, session_archives.pr_url),
           updated_at = excluded.updated_at`,
      )
      .run(
        input.sessionId,
        input.transcriptJson,
        input.handoffSummary ?? null,
        input.diffSummary ?? '[]',
        input.mergedSha ?? null,
        input.prUrl ?? null,
        now,
        now,
      );
    return this.getSessionArchive(input.sessionId)!;
  }

  getSessionArchive(sessionId: string): SessionArchiveDto | null {
    const row = this.db
      .prepare('SELECT * FROM session_archives WHERE session_id = ?')
      .get(sessionId) as
      | {
          session_id: string;
          transcript_json: string;
          handoff_summary: string | null;
          diff_summary: string;
          merged_sha: string | null;
          pr_url: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      sessionId: row.session_id,
      transcriptJson: row.transcript_json,
      handoffSummary: row.handoff_summary,
      diffSummary: row.diff_summary,
      mergedSha: row.merged_sha,
      prUrl: row.pr_url,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  setArchiveHandoffSummary(sessionId: string, handoffSummary: string): void {
    this.db
      .prepare('UPDATE session_archives SET handoff_summary = ?, updated_at = ? WHERE session_id = ?')
      .run(handoffSummary, new Date().toISOString(), sessionId);
  }

  hasInFlightRevertForSha(revertsSha: string, excludeSessionId?: string): SessionRecord | null {
    const row = this.db
      .prepare(
        `SELECT s.*, u.name as owner_name, u.email as owner_email, u.picture as owner_picture
         FROM editor_sessions s
         JOIN users u ON u.id = s.owner_user_id
         WHERE s.kind = 'revert'
           AND s.reverts_sha = ?
           AND s.id != ?
           AND s.publish_state IN ('verifying', 'rebasing', 'resolving_conflicts', 'pushing_pr', 'waiting_ci', 'deploying_pages')
         LIMIT 1`,
      )
      .get(revertsSha, excludeSessionId ?? '') as SessionRecord | undefined;
    return row ?? null;
  }

  toSessionDto(row: SessionRecord, viewer: UserDto): EditorSessionDto {
    const isOwner = row.owner_user_id === viewer.id;
    const isFrozen = row.status === 'published' || row.status === 'merged';
    return {
      id: row.id,
      title: row.title,
      slug: row.slug,
      kind: row.kind ?? 'edit',
      parentSessionId: row.parent_session_id ?? null,
      revertsSha: row.reverts_sha ?? null,
      revertReason: row.revert_reason ?? null,
      ownerUserId: row.owner_user_id,
      ownerName: row.owner_name ?? 'Editor',
      ownerEmail: row.owner_email ?? '',
      ownerPicture: row.owner_picture ?? null,
      isOwner,
      canEdit: (isOwner || viewer.isAdmin) && !isFrozen,
      repo: row.repo,
      baseBranch: row.base_branch,
      workingBranch: row.working_branch,
      baseSha: row.base_sha,
      prevBaseSha: row.prev_base_sha ?? null,
      status: row.status,
      publishState: row.publish_state,
      publishError: row.publish_error,
      prNumber: row.pr_number,
      prUrl: row.pr_url,
      mergedSha: row.merged_sha ?? null,
      mergedAt: row.merged_at ?? null,
      archivedAt: row.archived_at ?? null,
      volumeExpired: Boolean(row.volume_expired_at),
      astroBase: row.astro_base,
      changedFilesCount: row.changed_files_count,
      lastActiveAt: row.last_active_at,
      createdAt: row.created_at,
    };
  }
}
