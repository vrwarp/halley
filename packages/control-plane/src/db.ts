import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AllowlistEntryDto,
  AstroAuditReportDto,
  EditorSessionDto,
  OptimizationFindingDto,
  PublishState,
  SessionArchiveDto,
  SessionKind,
  SessionStatus,
  SpendStatusDto,
  UserDto,
} from '@halley/shared';
import { deriveWorkspaceToken, hashWorkspaceToken, safeEqualToken } from '@halley/shared/auth';
import type { HalleyConfig } from './config.js';

export interface SessionRecord {
  id: string;
  title: string;
  slug: string;
  kind: SessionKind;
  parent_session_id: string | null;
  reverts_sha: string | null;
  revert_reason: string | null;
  initial_revert_sha: string | null;
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
  optimize_escalation_allowed: number;
  active_model_label: string | null;
  state_version: number;
  lease_epoch: number;
  token_epoch: number;
  last_active_at: string;
  archived_at: string | null;
  node_modules_pruned_at: string | null;
  volume_expired_at: string | null;
  created_at: string;
}

export interface PublishRunRecord {
  session_id: string;
  run_id: string;
  actor_user_id: string;
  title: string | null;
  summary: string | null;
  exclude_paths_json: string | null;
  step: PublishState;
  local_head_sha: string | null;
  pre_exclude_sha: string | null;
  pr_number: number | null;
  pr_url: string | null;
  merged_sha: string | null;
  native_auto_merge: number;
  error: string | null;
  started_at: string;
  updated_at: string;
}

export class ControlPlaneDb {
  readonly db: DatabaseSync;

  constructor(dbPath: string, private config: HalleyConfig) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.seedAllowlist();
  }

  close(): void {
    try {
      if (this.db.isOpen) {
        this.db.close();
      }
    } catch {
      // ignore already-closed DB
    }
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
        initial_revert_sha TEXT,
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

      CREATE TABLE IF NOT EXISTS publish_runs (
        session_id TEXT PRIMARY KEY REFERENCES editor_sessions(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        title TEXT,
        summary TEXT,
        exclude_paths_json TEXT,
        step TEXT NOT NULL,
        local_head_sha TEXT,
        pre_exclude_sha TEXT,
        pr_number INTEGER,
        pr_url TEXT,
        merged_sha TEXT,
        native_auto_merge INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS astro_audit_reports (
        sha TEXT PRIMARY KEY,
        base_branch TEXT NOT NULL,
        score INTEGER NOT NULL,
        inline_editable_pct REAL NOT NULL DEFAULT 0,
        report_json TEXT NOT NULL,
        digest_text TEXT NOT NULL DEFAULT '',
        ai_reviewed_at TEXT,
        ai_summary TEXT,
        ai_findings_json TEXT,
        ai_cost_usd REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // Idempotent migrations for existing SQLite databases created before P0/v2
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
    addCol('initial_revert_sha', 'TEXT');
    addCol('prev_base_sha', 'TEXT');
    addCol('node_modules_pruned_at', 'TEXT');
    addCol('volume_expired_at', 'TEXT');
    addCol('optimize_escalation_allowed', 'INTEGER NOT NULL DEFAULT 0');
    addCol('active_model_label', 'TEXT');
    addCol('state_version', 'INTEGER NOT NULL DEFAULT 1');
    addCol('lease_epoch', 'INTEGER NOT NULL DEFAULT 0');
    addCol('token_epoch', 'INTEGER NOT NULL DEFAULT 0');

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

  resolveSessionByWorkspaceToken(rawToken: string): SessionRecord | null {
    if (!rawToken) return null;
    const direct = this.getSessionByTokenHash(hashWorkspaceToken(rawToken));
    if (direct) return direct;

    for (const s of this.listSessions()) {
      const derived = deriveWorkspaceToken(this.config.sessionSecret, s.id, s.token_epoch ?? 0);
      if (safeEqualToken(rawToken, derived)) {
        const derivedHash = hashWorkspaceToken(derived);
        if (s.workspace_token_hash !== derivedHash) {
          this.updateSession(s.id, { workspace_token_hash: derivedHash });
        }
        return this.getSession(s.id);
      }
    }
    return null;
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
    const hasStateVer = entries.some(([k]) => k === 'state_version');
    const setClauses = entries.map(([k]) => `${k} = ?`);
    if (!hasStateVer) {
      setClauses.push('state_version = state_version + 1');
    }
    const vals = entries.map(([, v]) => v as string | number | null);
    this.db.prepare(`UPDATE editor_sessions SET ${setClauses.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  /**
   * Atomic compare-and-swap (CAS) session state transition.
   * Guards expected status/epoch in SQLite so background reapers, stale boot promises,
   * or concurrent wake/restart calls never clobber a newer lease or un-freeze a merged session.
   */
  transitionSession(
    id: string,
    opts: {
      fromStatuses?: SessionStatus[];
      expectedEpoch?: number;
      bumpEpoch?: boolean;
      allowUnfreeze?: boolean;
      patch: Partial<SessionRecord>;
    },
  ): SessionRecord | null {
    const entries = Object.entries(opts.patch).filter(
      ([k, v]) => v !== undefined && k !== 'state_version' && k !== 'lease_epoch',
    );
    const setClauses = entries.map(([k]) => `${k} = ?`);
    setClauses.push('state_version = state_version + 1');
    if (opts.bumpEpoch) {
      setClauses.push('lease_epoch = lease_epoch + 1');
    }
    const vals: Array<string | number | null> = entries.map(([, v]) => v as string | number | null);

    const whereClauses: string[] = ['id = ?'];
    vals.push(id);

    if (opts.fromStatuses && opts.fromStatuses.length > 0) {
      whereClauses.push(`status IN (${opts.fromStatuses.map(() => '?').join(', ')})`);
      vals.push(...opts.fromStatuses);
    }
    if (opts.expectedEpoch !== undefined) {
      whereClauses.push('lease_epoch = ?');
      vals.push(opts.expectedEpoch);
    }
    const nextStatus = opts.patch.status;
    if (
      !opts.allowUnfreeze &&
      nextStatus !== undefined &&
      nextStatus !== 'merged' &&
      nextStatus !== 'published'
    ) {
      whereClauses.push("status NOT IN ('merged', 'published')");
    }

    const res = this.db
      .prepare(`UPDATE editor_sessions SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`)
      .run(...vals);
    if (res.changes === 0) return null;
    return this.getSession(id);
  }

  upsertPublishRun(input: {
    sessionId: string;
    runId: string;
    actorUserId: string;
    title?: string | null;
    summary?: string | null;
    excludePathsJson?: string | null;
    step: PublishState;
    localHeadSha?: string | null;
    preExcludeSha?: string | null;
    prNumber?: number | null;
    prUrl?: string | null;
    mergedSha?: string | null;
    nativeAutoMerge?: boolean;
    error?: string | null;
  }): PublishRunRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO publish_runs (
           session_id, run_id, actor_user_id, title, summary, exclude_paths_json, step,
           local_head_sha, pre_exclude_sha, pr_number, pr_url, merged_sha, native_auto_merge,
           error, started_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           run_id = excluded.run_id,
           actor_user_id = excluded.actor_user_id,
           title = COALESCE(excluded.title, publish_runs.title),
           summary = COALESCE(excluded.summary, publish_runs.summary),
           exclude_paths_json = COALESCE(excluded.exclude_paths_json, publish_runs.exclude_paths_json),
           step = excluded.step,
           local_head_sha = COALESCE(excluded.local_head_sha, publish_runs.local_head_sha),
           pre_exclude_sha = COALESCE(excluded.pre_exclude_sha, publish_runs.pre_exclude_sha),
           pr_number = COALESCE(excluded.pr_number, publish_runs.pr_number),
           pr_url = COALESCE(excluded.pr_url, publish_runs.pr_url),
           merged_sha = COALESCE(excluded.merged_sha, publish_runs.merged_sha),
           native_auto_merge = CASE WHEN excluded.native_auto_merge = 1 THEN 1 ELSE publish_runs.native_auto_merge END,
           error = excluded.error,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.sessionId,
        input.runId,
        input.actorUserId,
        input.title ?? null,
        input.summary ?? null,
        input.excludePathsJson ?? null,
        input.step,
        input.localHeadSha ?? null,
        input.preExcludeSha ?? null,
        input.prNumber ?? null,
        input.prUrl ?? null,
        input.mergedSha ?? null,
        input.nativeAutoMerge ? 1 : 0,
        input.error ?? null,
        now,
        now,
      );
    return this.getPublishRun(input.sessionId)!;
  }

  getPublishRun(sessionId: string): PublishRunRecord | null {
    const row = this.db
      .prepare('SELECT * FROM publish_runs WHERE session_id = ?')
      .get(sessionId) as PublishRunRecord | undefined;
    return row ?? null;
  }

  listActivePublishRuns(): PublishRunRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM publish_runs
         WHERE step IN ('rebasing', 'resolving_conflicts', 'verifying', 'pushing_pr', 'waiting_ci', 'deploying_pages')
         ORDER BY updated_at ASC`,
      )
      .all() as unknown as PublishRunRecord[];
  }

  deletePublishRun(sessionId: string): void {
    this.db.prepare('DELETE FROM publish_runs WHERE session_id = ?').run(sessionId);
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

  /**
   * Converts a `revert` draft into a standard `continuation` (when it has a parent session)
   * or `edit` session once files diverge from the initial full revert. Clears `reverts_sha`
   * so Live History does not badge the original commit as wholly undone, and updates an
   * untouched `Undo: <X>` title to `Continued: <X>` / `Adjusted: <X>`.
   */
  convertRevertSession(sessionId: string): SessionRecord | null {
    const existing = this.getSession(sessionId);
    if (!existing || existing.kind !== 'revert') return null;

    const nextKind: SessionKind = existing.parent_session_id ? 'continuation' : 'edit';
    let nextTitle = existing.title;
    if (existing.title.startsWith('Undo: ')) {
      const base = existing.title.slice('Undo: '.length).trim() || 'Website update';
      nextTitle = existing.parent_session_id ? `Continued: ${base}` : `Adjusted: ${base}`;
    }

    this.updateSession(sessionId, {
      kind: nextKind,
      reverts_sha: null,
      title: nextTitle,
    });
    return this.getSession(sessionId);
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
      activeModelLabel: row.active_model_label ?? null,
      lastActiveAt: row.last_active_at,
      createdAt: row.created_at,
    };
  }

  private hydrateAuditReportRow(row: {
    sha: string;
    base_branch: string;
    score: number;
    inline_editable_pct: number;
    report_json: string;
    digest_text: string;
    ai_reviewed_at: string | null;
    ai_summary: string | null;
    ai_findings_json: string | null;
    ai_cost_usd: number;
    created_at: string;
    updated_at: string;
  }): { report: AstroAuditReportDto; digest: string } {
    const parsed = JSON.parse(row.report_json) as AstroAuditReportDto;
    const aiFindings: OptimizationFindingDto[] = row.ai_findings_json
      ? (JSON.parse(row.ai_findings_json) as OptimizationFindingDto[])
      : [];
    const staticFindings = parsed.findings.filter((f) => f.source !== 'ai');
    const mergedFindings = [...staticFindings, ...aiFindings];

    const prevRow = this.db
      .prepare(
        `SELECT sha, score, inline_editable_pct, created_at
         FROM astro_audit_reports
         WHERE base_branch = ?
           AND sha != ?
           AND rowid < (SELECT rowid FROM astro_audit_reports WHERE sha = ?)
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(row.base_branch, row.sha, row.sha) as
      | { sha: string; score: number; inline_editable_pct: number; created_at: string }
      | undefined;

    return {
      digest: row.digest_text,
      report: {
        ...parsed,
        score: row.score,
        findings: mergedFindings,
        aiReviewedAt: row.ai_reviewed_at,
        aiSummary: row.ai_summary,
        aiCostUsd: Number((row.ai_cost_usd ?? 0).toFixed(4)),
        createdAt: row.created_at,
        previousReport: prevRow
          ? {
              sha: prevRow.sha,
              shortSha: prevRow.sha.slice(0, 7),
              score: prevRow.score,
              inlineEditablePct: prevRow.inline_editable_pct,
              createdAt: prevRow.created_at,
            }
          : null,
      },
    };
  }

  getAuditReport(sha: string): { report: AstroAuditReportDto; digest: string } | null {
    const row = this.db
      .prepare('SELECT * FROM astro_audit_reports WHERE sha = ?')
      .get(sha) as
      | {
          sha: string;
          base_branch: string;
          score: number;
          inline_editable_pct: number;
          report_json: string;
          digest_text: string;
          ai_reviewed_at: string | null;
          ai_summary: string | null;
          ai_findings_json: string | null;
          ai_cost_usd: number;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    return this.hydrateAuditReportRow(row);
  }

  getLatestAuditReport(baseBranch: string): { report: AstroAuditReportDto; digest: string } | null {
    const row = this.db
      .prepare(
        'SELECT * FROM astro_audit_reports WHERE base_branch = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      )
      .get(baseBranch) as
      | {
          sha: string;
          base_branch: string;
          score: number;
          inline_editable_pct: number;
          report_json: string;
          digest_text: string;
          ai_reviewed_at: string | null;
          ai_summary: string | null;
          ai_findings_json: string | null;
          ai_cost_usd: number;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    return this.hydrateAuditReportRow(row);
  }

  upsertStaticAuditReport(input: {
    sha: string;
    baseBranch: string;
    report: AstroAuditReportDto;
    digest: string;
  }): AstroAuditReportDto {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO astro_audit_reports (
           sha, base_branch, score, inline_editable_pct, report_json, digest_text, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sha) DO UPDATE SET
           score = excluded.score,
           inline_editable_pct = excluded.inline_editable_pct,
           report_json = excluded.report_json,
           digest_text = excluded.digest_text,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.sha,
        input.baseBranch,
        input.report.score,
        input.report.metrics.inlineEditablePct,
        JSON.stringify(input.report),
        input.digest,
        now,
        now,
      );
    return this.getAuditReport(input.sha)!.report;
  }

  saveAiAuditReview(input: {
    sha: string;
    summary: string;
    findings: OptimizationFindingDto[];
    costUsd: number;
    updatedScore?: number;
  }): AstroAuditReportDto | null {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE astro_audit_reports
         SET ai_reviewed_at = ?,
             ai_summary = ?,
             ai_findings_json = ?,
             ai_cost_usd = ai_cost_usd + ?,
             score = COALESCE(?, score),
             updated_at = ?
         WHERE sha = ?`,
      )
      .run(
        now,
        input.summary,
        JSON.stringify(input.findings),
        input.costUsd,
        input.updatedScore ?? null,
        now,
        input.sha,
      );
    return this.getAuditReport(input.sha)?.report ?? null;
  }
}
