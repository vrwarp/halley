import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
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
import { realClock, type Clock } from './clock.js';
import type { HalleyConfig } from './config.js';
import { ignore } from './log.js';
import {
  ALLOWED_STATUS_SOURCES,
  IN_FLIGHT_PUBLISH_STATES_SQL,
  PUBLISH_STATE_SET,
  SESSION_STATUS_SET,
} from './session-state.js';

export interface SessionRecord {
  id: string;
  title: string;
  slug: string;
  kind: SessionKind;
  parent_session_id: string | null;
  reverts_sha: string | null;
  revert_reason: string | null;
  initial_revert_sha: string | null;
  /** Pending revert-start inputs (JSON {shas, targetTitle, srcSessionId}) until it succeeds (Undo drafts only). */
  revert_pending_json?: string | null;
  /** Last revert-start failure; a `retryable:` prefix means the request never reached the runner. */
  revert_start_error?: string | null;
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

/** Persisted crash-loop breaker state for one session (see CrashLoopTracker). */
export interface CrashLoopRecord {
  failures: number[];
  openCount: number;
  openUntil: number;
  lastError: string;
  oom: boolean;
}

function parseFailures(json: string): number[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return []; // a corrupt row only loses the failure history, never blocks a boot
  }
}

export class InvalidSessionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSessionStateError';
  }
}

function assertValidSessionPatch(patch: Partial<SessionRecord>): void {
  if (patch.status !== undefined && !SESSION_STATUS_SET.has(patch.status)) {
    throw new InvalidSessionStateError(`Unknown session status ${JSON.stringify(patch.status)}`);
  }
  if (patch.publish_state !== undefined && !PUBLISH_STATE_SET.has(patch.publish_state)) {
    throw new InvalidSessionStateError(`Unknown publish_state ${JSON.stringify(patch.publish_state)}`);
  }
}

const MAX_CACHED_STATEMENTS = 512;
export const ACTIVITY_WRITE_INTERVAL_MS = 15_000;

interface Migration {
  version: number;
  name: string;
  up: (db: ControlPlaneDb) => void;
}

const BASELINE_SCHEMA_SQL = `

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
`;

/**
 * Ordered schema migrations. Append only; never edit an applied one. Each must be idempotent
 * against a database that already has its effect (pre-versioning databases replay them).
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'baseline schema + pre-versioning column additions',
    up: (d) => {
      d.db.exec(BASELINE_SCHEMA_SQL);
      const cols = d.tableColumns('editor_sessions');
      const addCol = (name: string, def: string) => {
        if (!cols.has(name)) d.db.exec(`ALTER TABLE editor_sessions ADD COLUMN ${name} ${def}`);
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
    },
  },
  {
    version: 2,
    name: 'indexes for hot lookups',
    up: (d) => {
      d.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON editor_sessions(workspace_token_hash);
        CREATE INDEX IF NOT EXISTS idx_sessions_status_active ON editor_sessions(status, last_active_at);
        CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON editor_sessions(last_active_at);
        CREATE INDEX IF NOT EXISTS idx_sessions_owner ON editor_sessions(owner_user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_reverts_sha ON editor_sessions(reverts_sha) WHERE reverts_sha IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_spend_events_user_day ON spend_events(user_id, utc_date);
        CREATE INDEX IF NOT EXISTS idx_spend_events_day_purpose ON spend_events(utc_date, purpose);
        CREATE INDEX IF NOT EXISTS idx_publish_runs_step ON publish_runs(step, updated_at);
      `);
    },
  },
  {
    version: 3,
    name: 'spend_daily_purpose rollup for spend_events retention',
    up: (d) => {
      d.db.exec(`
        CREATE TABLE IF NOT EXISTS spend_daily_purpose (
          user_id TEXT NOT NULL,
          utc_date TEXT NOT NULL,
          purpose TEXT NOT NULL,
          request_count INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(user_id, utc_date, purpose)
        );
      `);
    },
  },
  {
    version: 4,
    name: 'durable crash-loop breaker state and revert-start markers',
    up: (d) => {
      d.db.exec(`
        CREATE TABLE IF NOT EXISTS workspace_crash_loops (
          session_id TEXT PRIMARY KEY,
          failures_json TEXT NOT NULL,
          open_count INTEGER NOT NULL DEFAULT 0,
          open_until INTEGER NOT NULL DEFAULT 0,
          last_error TEXT NOT NULL DEFAULT '',
          oom INTEGER NOT NULL DEFAULT 0
        );
      `);
      const cols = d.tableColumns('editor_sessions');
      // Undo draft whose revert-start has not succeeded yet: {shas, targetTitle, srcSessionId}
      if (!cols.has('revert_pending_json')) d.db.exec('ALTER TABLE editor_sessions ADD COLUMN revert_pending_json TEXT');
      // Last revert-start failure ('retryable:' prefix = the request never reached the runner)
      if (!cols.has('revert_start_error')) d.db.exec('ALTER TABLE editor_sessions ADD COLUMN revert_start_error TEXT');
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export class ControlPlaneDb {
  readonly db: DatabaseSync;
  /** Prepared statements cached per SQL string: preparing is the dominant cost of a point query. */
  private statementCache = new Map<string, StatementSync>();
  private txDepth = 0;
  /** sessionId → epoch ms of the last last_active_at write done via touchSessionActivity. */
  private lastActivityWriteAt = new Map<string, number>();

  readonly path: string;

  private readonly clock: Clock;
  private readonly randomUUID: () => string;

  constructor(
    dbPath: string,
    private config: HalleyConfig,
    deps: { clock?: Clock; randomUUID?: () => string } = {},
  ) {
    this.clock = deps.clock ?? realClock;
    this.randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());
    this.path = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.seedAllowlist();
  }

  /** Current time as an ISO-8601 string, from the injected clock. */
  nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  /** Today's UTC date (YYYY-MM-DD), from the injected clock. */
  private todayUtc(): string {
    return this.nowIso().slice(0, 10);
  }

  close(): void {
    this.statementCache.clear();
    if (!this.db.isOpen) return;
    try {
      this.db.close();
    } catch (err) {
      ignore(err, 'closing the database failed');
    }
  }

  /** Cheap liveness probe: a trivial query on the shared connection. */
  ping(): boolean {
    try {
      return this.db.isOpen && (this.prepared('SELECT 1 AS ok').get() as { ok: number } | undefined)?.ok === 1;
    } catch (err) {
      ignore(err, 'database ping failed', {}, 'debug');
      return false;
    }
  }

  /** Returns a cached prepared statement for `sql` (prepared once per distinct SQL string). */
  prepared(sql: string): StatementSync {
    let stmt = this.statementCache.get(sql);
    if (!stmt) {
      if (this.statementCache.size >= MAX_CACHED_STATEMENTS) this.statementCache.clear();
      stmt = this.db.prepare(sql);
      this.statementCache.set(sql, stmt);
    }
    return stmt;
  }

  /**
   * Marks a session as active (`last_active_at = now`), writing at most once per `minIntervalMs`
   * per session. Hot paths (every preview asset, every LLM call, every chat frame) use this so
   * idle tracking costs ~0 writes per request. Returns true when a write happened.
   * Does not bump state_version: activity is not a state change.
   */
  touchSessionActivity(sessionId: string, nowMs = this.clock.now(), minIntervalMs = ACTIVITY_WRITE_INTERVAL_MS): boolean {
    const prev = this.lastActivityWriteAt.get(sessionId);
    if (prev !== undefined && nowMs - prev < minIntervalMs) return false;
    this.lastActivityWriteAt.set(sessionId, nowMs);
    if (this.lastActivityWriteAt.size > 10_000) {
      // Bound memory: drop entries old enough that they would not throttle anything anyway.
      for (const [id, at] of this.lastActivityWriteAt) {
        if (nowMs - at >= minIntervalMs) this.lastActivityWriteAt.delete(id);
      }
    }
    this.prepared('UPDATE editor_sessions SET last_active_at = ? WHERE id = ?').run(
      new Date(nowMs).toISOString(),
      sessionId,
    );
    return true;
  }

  /**
   * Runs `fn` inside a single SQLite write transaction (BEGIN IMMEDIATE). Nested calls join the
   * outer transaction. `fn` must be synchronous: never await inside a transaction.
   */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth += 1;
      try {
        return fn();
      } finally {
        this.txDepth -= 1;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth = 1;
    try {
      const result = fn();
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        throw new Error('db.transaction callback must be synchronous');
      }
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      if (this.db.isOpen && this.db.isTransaction) {
        try {
          this.db.exec('ROLLBACK');
        } catch (rollbackErr) {
          ignore(rollbackErr, 'rollback failed; surfacing the original error');
        }
      }
      // else: SQLite already rolled back (e.g. SQLITE_FULL) or the db was closed: nothing to undo
      throw err;
    } finally {
      this.txDepth = 0;
    }
  }

  /** Applied migrations, newest last (`schema_version` holds one row per applied version). */
  schemaVersion(): number {
    const row = this.prepared('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null } | undefined;
    return row?.v ?? 0;
  }

  /**
   * Runs every migration newer than the recorded schema version, in order, each in its own
   * transaction. Migration 1 is the pre-versioning schema and is idempotent, so databases created
   * before `schema_version` existed are adopted safely.
   */
  private migrate(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    const current = this.schemaVersion();
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      this.transaction(() => {
        m.up(this);
        this.prepared('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(
          m.version,
          m.name,
          this.nowIso(),
        );
      });
    }

    const existingCap = this.prepared('SELECT value FROM settings WHERE key = ?')
      .get('daily_cost_cap_usd') as { value: string } | undefined;
    if (!existingCap) {
      this.prepared('INSERT INTO settings (key, value) VALUES (?, ?)')
        .run('daily_cost_cap_usd', String(this.config.dailyCostCapUsd));
    }
  }

  /** Columns of `table` (used by idempotent ADD COLUMN migrations). */
  tableColumns(table: string): Set<string> {
    return new Set(
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
    );
  }

  /**
   * Retention: spend_events older than `retentionDays` are rolled up into spend_daily_purpose
   * (per user/day/purpose) and daily_spend (backfilled only where missing: recordSpend already
   * keeps it current), then deleted. Returns the number of events removed.
   */
  pruneSpendEvents(retentionDays: number, nowMs = this.clock.now()): number {
    const cutoff = new Date(nowMs - retentionDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return this.transaction(() => {
      this.prepared(
        `INSERT INTO spend_daily_purpose (user_id, utc_date, purpose, request_count, cost_usd, input_tokens, output_tokens)
         SELECT user_id, utc_date, purpose, COUNT(*), COALESCE(SUM(cost_usd), 0), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0)
         FROM spend_events WHERE utc_date < ?
         GROUP BY user_id, utc_date, purpose
         ON CONFLICT(user_id, utc_date, purpose) DO UPDATE SET
           request_count = request_count + excluded.request_count,
           cost_usd = cost_usd + excluded.cost_usd,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens`,
      ).run(cutoff);
      this.prepared(
        `INSERT INTO daily_spend (user_id, utc_date, cost_usd, input_tokens, output_tokens, extra_granted_usd)
         SELECT user_id, utc_date, COALESCE(SUM(cost_usd), 0), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0), 0
         FROM spend_events WHERE utc_date < ?
         GROUP BY user_id, utc_date
         ON CONFLICT(user_id, utc_date) DO NOTHING`,
      ).run(cutoff);
      return Number(this.prepared('DELETE FROM spend_events WHERE utc_date < ?').run(cutoff).changes);
    });
  }

  private seedAllowlist(): void {
    const now = this.nowIso();
    const insert = this.prepared(
      'INSERT OR IGNORE INTO allowlist (id, kind, value, added_by, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const email of [...this.config.adminEmails, ...this.config.allowedEmails]) {
      insert.run(this.randomUUID(), 'email', email.toLowerCase(), 'env', now);
    }
    for (const domain of this.config.allowedDomains) {
      insert.run(this.randomUUID(), 'domain', domain.toLowerCase(), 'env', now);
    }
  }

  isEmailAllowed(email: string): boolean {
    const norm = email.trim().toLowerCase();
    if (this.config.adminEmails.includes(norm)) return true;
    const domain = norm.split('@')[1] ?? '';
    const row = this.prepared(
        "SELECT 1 FROM allowlist WHERE (kind = 'email' AND value = ?) OR (kind = 'domain' AND value = ?) LIMIT 1",
      )
      .get(norm, domain);
    return Boolean(row);
  }

  upsertUser(input: { email: string; name: string; picture: string | null }): UserDto {
    const email = input.email.trim().toLowerCase();
    const now = this.nowIso();
    const isAdminEnv = this.config.adminEmails.includes(email);

    const existing = this.prepared('SELECT * FROM users WHERE email = ?')
      .get(email) as
      | { id: string; email: string; name: string; picture: string | null; is_admin: number; persona?: string }
      | undefined;

    if (existing) {
      const nextAdmin = isAdminEnv ? 1 : existing.is_admin;
      const persona = existing.persona === 'developer' ? 'developer' : 'non-technical';
      this.prepared('UPDATE users SET name = ?, picture = ?, is_admin = ?, last_login_at = ? WHERE id = ?')
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

    const id = this.randomUUID();
    const isAdmin = isAdminEnv ? 1 : 0;
    this.prepared(
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
    const row = this.prepared('SELECT * FROM users WHERE id = ?').get(id) as
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
    const rows = this.prepared('SELECT * FROM users ORDER BY email ASC').all() as Array<{
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
    this.prepared('UPDATE users SET persona = ? WHERE id = ?').run(persona, userId);
  }

  setUserAdmin(userId: string, isAdmin: boolean): void {
    this.prepared('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, userId);
  }

  listAllowlist(): AllowlistEntryDto[] {
    const rows = this.prepared('SELECT * FROM allowlist ORDER BY kind ASC, value ASC')
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
    const id = this.randomUUID();
    const now = this.nowIso();
    this.prepared('INSERT OR IGNORE INTO allowlist (id, kind, value, added_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, kind, clean, addedBy, now);
    return { id, kind, value: clean, addedBy, createdAt: now };
  }

  removeAllowlist(id: string): void {
    this.prepared('DELETE FROM allowlist WHERE id = ?').run(id);
  }

  getDailyCapUsd(): number {
    const row = this.prepared('SELECT value FROM settings WHERE key = ?')
      .get('daily_cost_cap_usd') as { value: string } | undefined;
    return row ? Number(row.value) : this.config.dailyCostCapUsd;
  }

  setDailyCapUsd(cap: number): void {
    this.prepared('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('daily_cost_cap_usd', String(cap));
  }

  getSpendStatus(userId: string, utcDate = this.todayUtc()): SpendStatusDto {
    const cap = this.getDailyCapUsd();
    const row = this.prepared('SELECT cost_usd, extra_granted_usd FROM daily_spend WHERE user_id = ? AND utc_date = ?')
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
    utcDate = this.todayUtc(),
    meta?: { sessionId?: string; purpose?: string; model?: string },
  ): SpendStatusDto {
    this.prepared(
        `INSERT INTO daily_spend (user_id, utc_date, cost_usd, input_tokens, output_tokens, extra_granted_usd)
         VALUES (?, ?, ?, ?, ?, 0)
         ON CONFLICT(user_id, utc_date) DO UPDATE SET
           cost_usd = cost_usd + excluded.cost_usd,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens`,
      )
      .run(userId, utcDate, costUsd, inputTokens, outputTokens);
    if (meta) {
      this.prepared(
          `INSERT INTO spend_events (id, user_id, session_id, utc_date, purpose, model, cost_usd, input_tokens, output_tokens, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.randomUUID(),
          userId,
          meta.sessionId ?? null,
          utcDate,
          meta.purpose ?? 'chat',
          meta.model ?? '',
          costUsd,
          inputTokens,
          outputTokens,
          this.nowIso(),
        );
    }
    return this.getSpendStatus(userId, utcDate);
  }

  listTodaySpendByPurpose(utcDate = this.todayUtc()) {
    return this.prepared(
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

  grantExtraSpend(userId: string, extraUsd: number, utcDate = this.todayUtc()): void {
    this.prepared(
        `INSERT INTO daily_spend (user_id, utc_date, cost_usd, input_tokens, output_tokens, extra_granted_usd)
         VALUES (?, ?, 0, 0, 0, ?)
         ON CONFLICT(user_id, utc_date) DO UPDATE SET
           extra_granted_usd = extra_granted_usd + excluded.extra_granted_usd`,
      )
      .run(userId, utcDate, extraUsd);
  }

  listTodaySpendByUser(utcDate = this.todayUtc()) {
    return this.prepared(
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
    const now = this.nowIso();
    this.tokenMisses.clear();
    this.prepared(
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
    const row = this.prepared(
        `SELECT s.*, u.name as owner_name, u.email as owner_email, u.picture as owner_picture
         FROM editor_sessions s
         JOIN users u ON u.id = s.owner_user_id
         WHERE s.id = ?`,
      )
      .get(id) as SessionRecord | undefined;
    return row ?? null;
  }

  getSessionByTokenHash(hash: string): SessionRecord | null {
    const row = this.prepared(
        `SELECT s.*, u.name as owner_name, u.email as owner_email, u.picture as owner_picture
         FROM editor_sessions s
         JOIN users u ON u.id = s.owner_user_id
         WHERE s.workspace_token_hash = ?`,
      )
      .get(hash) as SessionRecord | undefined;
    return row ?? null;
  }

  /**
   * Token hashes that matched no session, with their expiry (clock ms). The token is an HKDF output
   * that does not embed the session id, so a miss on the indexed hash lookup needs an O(sessions)
   * HKDF scan (for rows whose stored hash went stale); caching misses keeps repeated bad tokens O(1).
   * Cleared whenever a session's token can change (create, token hash/epoch update, delete).
   */
  private tokenMisses = new Map<string, number>();
  static readonly TOKEN_MISS_TTL_MS = 60_000;
  static readonly TOKEN_MISS_MAX = 1024;

  resolveSessionByWorkspaceToken(rawToken: string): SessionRecord | null {
    if (!rawToken) return null;
    const hash = hashWorkspaceToken(rawToken);
    const direct = this.getSessionByTokenHash(hash);
    if (direct) return direct;
    const now = this.clock.now();
    const missUntil = this.tokenMisses.get(hash);
    if (missUntil !== undefined) {
      if (missUntil > now) return null;
      this.tokenMisses.delete(hash);
    }
    const found = this.scanForDerivedToken(rawToken);
    if (!found) {
      if (this.tokenMisses.size >= ControlPlaneDb.TOKEN_MISS_MAX) this.tokenMisses.clear();
      this.tokenMisses.set(hash, now + ControlPlaneDb.TOKEN_MISS_TTL_MS);
    }
    return found;
  }

  private scanForDerivedToken(rawToken: string): SessionRecord | null {
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
    return this.prepared(
        `SELECT s.*, u.name as owner_name, u.email as owner_email, u.picture as owner_picture
         FROM editor_sessions s
         JOIN users u ON u.id = s.owner_user_id
         ORDER BY s.last_active_at DESC`,
      )
      .all() as unknown as SessionRecord[];
  }

  /** Sessions with a PR that is not yet recorded as merged/published (manual-merge reconciliation). */
  listSessionsWithUnmergedPr(): SessionRecord[] {
    return this.prepared(
        `SELECT s.*, u.name as owner_name, u.email as owner_email, u.picture as owner_picture
         FROM editor_sessions s
         JOIN users u ON u.id = s.owner_user_id
         WHERE s.pr_number IS NOT NULL AND s.status NOT IN ('published', 'merged')
         ORDER BY s.last_active_at DESC`,
      )
      .all() as unknown as SessionRecord[];
  }

  /** Session ids owned by `userId` (indexed; used for per-user spend broadcasts). */
  listSessionIdsByOwner(userId: string): string[] {
    return (
      this.prepared('SELECT id FROM editor_sessions WHERE owner_user_id = ?').all(userId) as Array<{ id: string }>
    ).map((r) => r.id);
  }

  listSessionsByOwner(userId: string): SessionRecord[] {
    return this.prepared(
      `SELECT s.*, u.name as owner_name, u.email as owner_email, u.picture as owner_picture
       FROM editor_sessions s
       JOIN users u ON u.id = s.owner_user_id
       WHERE s.owner_user_id = ?
       ORDER BY s.last_active_at DESC`,
    ).all(userId) as unknown as SessionRecord[];
  }

  updateSession(id: string, patch: Partial<SessionRecord>): void {
    assertValidSessionPatch(patch);
    if (patch.workspace_token_hash !== undefined || patch.token_epoch !== undefined) this.tokenMisses.clear();
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const hasStateVer = entries.some(([k]) => k === 'state_version');
    const setClauses = entries.map(([k]) => `${k} = ?`);
    if (!hasStateVer) {
      setClauses.push('state_version = state_version + 1');
    }
    const vals = entries.map(([, v]) => v as string | number | null);
    this.prepared(`UPDATE editor_sessions SET ${setClauses.join(', ')} WHERE id = ?`).run(...vals, id);
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
    assertValidSessionPatch(opts.patch);
    if (opts.patch.workspace_token_hash !== undefined || opts.patch.token_epoch !== undefined) this.tokenMisses.clear();
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

    const res = this.prepared(`UPDATE editor_sessions SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`)
      .run(...vals);
    if (res.changes === 0) return null;
    return this.getSession(id);
  }

  /**
   * The single sanctioned way to change `status` outside explicit lease CAS transitions: only
   * moves allowed by ALLOWED_STATUS_SOURCES are applied (e.g. never published → running).
   * Returns the updated row, or null when the transition was refused.
   */
  setSessionStatus(
    id: string,
    status: SessionStatus,
    patch: Omit<Partial<SessionRecord>, 'status'> = {},
  ): SessionRecord | null {
    return this.transitionSession(id, {
      fromStatuses: ALLOWED_STATUS_SOURCES[status],
      allowUnfreeze: status === 'merged' || status === 'published',
      patch: { ...patch, status },
    });
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
    const now = this.nowIso();
    this.prepared(
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
    const row = this.prepared('SELECT * FROM publish_runs WHERE session_id = ?')
      .get(sessionId) as PublishRunRecord | undefined;
    return row ?? null;
  }

  listActivePublishRuns(): PublishRunRecord[] {
    return this.prepared(
        `SELECT * FROM publish_runs
         WHERE step IN ${IN_FLIGHT_PUBLISH_STATES_SQL}
         ORDER BY updated_at ASC`,
      )
      .all() as unknown as PublishRunRecord[];
  }

  deletePublishRun(sessionId: string): void {
    this.prepared('DELETE FROM publish_runs WHERE session_id = ?').run(sessionId);
  }

  deleteSession(id: string): void {
    this.lastActivityWriteAt.delete(id);
    this.tokenMisses.clear();
    this.transaction(() => {
      this.prepared('DELETE FROM editor_sessions WHERE id = ?').run(id);
      this.prepared('DELETE FROM workspace_crash_loops WHERE session_id = ?').run(id);
    });
  }

  // ---- crash-loop breaker state (CrashLoopTracker's durable store) ----

  listCrashLoopRecords(): Array<{ sessionId: string; record: CrashLoopRecord }> {
    const rows = this.prepared('SELECT * FROM workspace_crash_loops').all() as Array<{
      session_id: string;
      failures_json: string;
      open_count: number;
      open_until: number;
      last_error: string;
      oom: number;
    }>;
    return rows.map((r) => ({
      sessionId: r.session_id,
      record: {
        failures: parseFailures(r.failures_json),
        openCount: Number(r.open_count),
        openUntil: Number(r.open_until),
        lastError: r.last_error,
        oom: r.oom === 1,
      },
    }));
  }

  saveCrashLoopRecord(sessionId: string, rec: CrashLoopRecord): void {
    this.prepared(
      `INSERT INTO workspace_crash_loops (session_id, failures_json, open_count, open_until, last_error, oom)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         failures_json = excluded.failures_json, open_count = excluded.open_count,
         open_until = excluded.open_until, last_error = excluded.last_error, oom = excluded.oom`,
    ).run(sessionId, JSON.stringify(rec.failures), rec.openCount, rec.openUntil, rec.lastError, rec.oom ? 1 : 0);
  }

  deleteCrashLoopRecord(sessionId: string): void {
    this.prepared('DELETE FROM workspace_crash_loops WHERE session_id = ?').run(sessionId);
  }

  upsertSessionArchive(input: {
    sessionId: string;
    transcriptJson: string;
    handoffSummary?: string | null;
    diffSummary?: string;
    mergedSha?: string | null;
    prUrl?: string | null;
  }): SessionArchiveDto {
    const now = this.nowIso();
    this.prepared(
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
    const row = this.prepared('SELECT * FROM session_archives WHERE session_id = ?')
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
    this.prepared('UPDATE session_archives SET handoff_summary = ?, updated_at = ? WHERE session_id = ?')
      .run(handoffSummary, this.nowIso(), sessionId);
  }

  hasInFlightRevertForSha(revertsSha: string, excludeSessionId?: string): SessionRecord | null {
    const row = this.prepared(
        `SELECT s.*, u.name as owner_name, u.email as owner_email, u.picture as owner_picture
         FROM editor_sessions s
         JOIN users u ON u.id = s.owner_user_id
         WHERE s.kind = 'revert'
           AND s.reverts_sha = ?
           AND s.id != ?
           AND s.publish_state IN ${IN_FLIGHT_PUBLISH_STATES_SQL}
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

    const prevRow = this.prepared(
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
    const row = this.prepared('SELECT * FROM astro_audit_reports WHERE sha = ?')
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
    const row = this.prepared(
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
    const now = this.nowIso();
    this.prepared(
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
    const now = this.nowIso();
    this.prepared(
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
