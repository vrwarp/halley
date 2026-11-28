import path from 'node:path';
import { realClock, type Clock } from './clock.js';
import type { HalleyConfig } from './config.js';
import { backupDatabase, latestBackupDay } from './db-backup.js';
import type { ControlPlaneDb } from './db.js';
import type { WorkspaceDriver } from './drivers/workspace-driver.js';
import { ignore, logger } from './log.js';
import { mapWithConcurrency } from './concurrency.js';
import { isPublishInFlight } from './session-state.js';

/** Sessions handled in parallel by one reaper pass. */
export const REAPER_CONCURRENCY = 4;

export async function runReaperPass(
  config: HalleyConfig,
  db: ControlPlaneDb,
  driver: WorkspaceDriver,
  now = realClock.now(),
): Promise<void> {
  await driver.reconcileSessions?.().catch((err) => ignore(err, 'reaper: reconcileSessions failed'));
  const sessions = db.listSessions();
  const activeRunSessionIds = new Set(db.listActivePublishRuns().map((r) => r.session_id));
  const pruneMs = config.nodeModulesPruneDays * 24 * 60 * 60 * 1000;
  const retentionMs = config.archiveRetentionDays * 24 * 60 * 60 * 1000;

  const isPublishProtected = (s: { id: string; publish_state: string }) =>
    activeRunSessionIds.has(s.id) ||
    isPublishInFlight(s.publish_state) ||
    s.publish_state === 'failed_conflict';

  // Sessions are processed with bounded concurrency so one slow supervisor call (stop/prune/destroy)
  // can't stall the whole pass; a failure on one session never aborts the others.
  const reapOne = async (snapshot: { id: string }): Promise<void> => {
    let s = db.getSession(snapshot.id);
    if (!s) return;

    // 1. Stop idle running containers (and published/merged containers woken for read-only viewing)
    if (
      (s.status === 'running' ||
        ((s.status === 'published' || s.status === 'merged') && Boolean(s.runner_url))) &&
      !isPublishProtected(s)
    ) {
      const lastActive = new Date(s.last_active_at).getTime();
      if (now - lastActive > config.workspaceIdleTimeoutMs) {
        const freshBeforeStop = db.getSession(s.id);
        if (
          freshBeforeStop &&
          !isPublishProtected(freshBeforeStop) &&
          new Date(freshBeforeStop.last_active_at).getTime() <= now - config.workspaceIdleTimeoutMs
        ) {
          console.log(`[reaper] Putting idle ${freshBeforeStop.status} session ${freshBeforeStop.id} to sleep`);
          await driver
            .stop(freshBeforeStop)
            .catch((err) => ignore(err, 'reaper: stopping idle session failed', { sessionId: freshBeforeStop.id }));
          s = db.getSession(s.id);
          if (!s) return;
        }
      }
    }

    if (s.volume_expired_at) return;

    // 2. Slim sleeping/published/merged volumes after NODE_MODULES_PRUNE_DAYS (default 7d)
    if (
      driver.pruneNodeModules &&
      !s.node_modules_pruned_at &&
      (s.status === 'sleeping' || s.status === 'published' || s.status === 'merged') &&
      !isPublishProtected(s)
    ) {
      const refTime = new Date(s.archived_at ?? s.merged_at ?? s.last_active_at).getTime();
      if (now - refTime > pruneMs) {
        const freshBeforePrune = db.getSession(s.id);
        if (
          freshBeforePrune &&
          !freshBeforePrune.node_modules_pruned_at &&
          (freshBeforePrune.status === 'sleeping' ||
            freshBeforePrune.status === 'published' ||
            freshBeforePrune.status === 'merged') &&
          !isPublishProtected(freshBeforePrune)
        ) {
          console.log(`[reaper] Pruning node_modules for idle/archived session ${freshBeforePrune.id}`);
          try {
            await driver.pruneNodeModules(freshBeforePrune);
            db.updateSession(freshBeforePrune.id, {
              node_modules_pruned_at: new Date(now).toISOString(),
            });
          } catch (err) {
            console.warn(
              `[reaper] Skipping node_modules_pruned_at stamp for ${freshBeforePrune.id} after error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          s = db.getSession(s.id);
          if (!s) return;
        }
      }
    }

    // 3. Clean up published session volumes after ARCHIVE_RETENTION_DAYS (default 420d)
    //    ('merged' sessions are still awaiting deploy verification and keep their volume)
    if (s.status === 'published' && !isPublishProtected(s)) {
      const refIso = s.archived_at ?? s.merged_at ?? s.last_active_at;
      const archivedAt = new Date(refIso).getTime();
      if (now - archivedAt > retentionMs) {
        console.log(`[reaper] Expiring archived volume for published session ${s.id}`);
        try {
          await driver.destroy(s);
          db.updateSession(s.id, {
            archived_at: null,
            volume_expired_at: new Date(now).toISOString(),
          });
        } catch (err) {
          // Only stamp volume_expired_at once the volume is really gone; retry next pass.
          logger.warn('reaper: destroying expired published volume failed; will retry', { sessionId: s.id, err });
        }
      }
      return;
    }

    // 4. Expire abandoned drafts after ARCHIVE_RETENTION_DAYS (default 420d) from last activity
    if ((s.status === 'sleeping' || s.status === 'error') && !isPublishProtected(s)) {
      const lastActive = new Date(s.last_active_at).getTime();
      if (now - lastActive > retentionMs) {
        const freshBeforeExpire = db.getSession(s.id);
        if (
          freshBeforeExpire &&
          (freshBeforeExpire.status === 'sleeping' || freshBeforeExpire.status === 'error') &&
          !isPublishProtected(freshBeforeExpire)
        ) {
          console.log(`[reaper] Expiring abandoned draft volume for session ${freshBeforeExpire.id}`);
          try {
            await driver.destroy(freshBeforeExpire);
            db.updateSession(freshBeforeExpire.id, {
              volume_expired_at: new Date(now).toISOString(),
            });
          } catch (err) {
            logger.warn('reaper: destroying abandoned draft volume failed; will retry', {
              sessionId: freshBeforeExpire.id,
              err,
            });
          }
        }
      }
    }
  };
  await mapWithConcurrency(sessions, REAPER_CONCURRENCY, (snapshot) =>
    reapOne(snapshot).catch((err) => logger.error('reaper: session pass failed', { sessionId: snapshot.id, err })),
  );
}

const RETENTION_INTERVAL_MS = 60 * 60_000;
const BACKUP_RETRY_AFTER_FAILURE_MS = 60 * 60_000;

export interface MaintenanceState {
  lastRetentionAt: number;
  /** Epoch ms of the last successful backup (or the newest backup file's day on first run). */
  lastBackupAt: number | null | undefined;
  lastBackupAttemptAt: number;
}

export function newMaintenanceState(): MaintenanceState {
  return { lastRetentionAt: 0, lastBackupAt: undefined, lastBackupAttemptAt: 0 };
}

/**
 * Housekeeping that must stay off the request path: spend_events retention (hourly) and the
 * daily online SQLite backup (VACUUM INTO in a worker thread). Never throws.
 */
export async function runMaintenancePass(
  config: HalleyConfig,
  db: ControlPlaneDb,
  state: MaintenanceState,
  now = realClock.now(),
): Promise<void> {
  if (now - state.lastRetentionAt >= RETENTION_INTERVAL_MS) {
    state.lastRetentionAt = now;
    try {
      const removed = db.pruneSpendEvents(config.spendEventRetentionDays, now);
      if (removed > 0) {
        logger.info('retention: rolled up and removed old spend events', {
          removed,
          retentionDays: config.spendEventRetentionDays,
        });
      }
    } catch (err) {
      logger.error('retention: pruning spend events failed', { err });
    }
  }

  if (config.dbBackupIntervalMs <= 0) return;
  const backupDir = path.join(config.dataDir, 'backups');
  try {
    if (state.lastBackupAt === undefined) state.lastBackupAt = await latestBackupDay(backupDir);
    const due = state.lastBackupAt === null || now - state.lastBackupAt >= config.dbBackupIntervalMs;
    const backedOff = now - state.lastBackupAttemptAt < BACKUP_RETRY_AFTER_FAILURE_MS;
    if (!due || backedOff) return;
    state.lastBackupAttemptAt = now;
    await backupDatabase(db.path, backupDir, { keep: config.dbBackupKeep, now });
    state.lastBackupAt = now;
    state.lastBackupAttemptAt = 0;
  } catch (err) {
    logger.error('database backup failed; will retry later', { err, backupDir });
  }
}

export interface ReaperDeps {
  clock?: Clock;
  intervalMs?: number;
  /** Extra maintenance run after each pass (e.g. manual-merge reconciliation); failures are logged. */
  extraPasses?: Array<{ name: string; run: () => Promise<unknown> }>;
}

export function startSessionReaper(
  config: HalleyConfig,
  db: ControlPlaneDb,
  driver: WorkspaceDriver,
  deps: ReaperDeps = {},
): () => void {
  const clock = deps.clock ?? realClock;
  const intervalMs = deps.intervalMs ?? 60_000;
  const maintenance = newMaintenanceState();
  let inFlight = false;
  let stopped = false;
  let timer: ReturnType<Clock['setTimeout']> | null = null;
  const tick = () => {
    if (stopped) return;
    if (!inFlight) {
      inFlight = true;
      void runReaperPass(config, db, driver, clock.now())
        .catch((err) => logger.error('reaper pass failed', { err }))
        .then(() => runMaintenancePass(config, db, maintenance, clock.now()))
        .then(async () => {
          for (const pass of deps.extraPasses ?? []) {
            if (stopped) return;
            await pass.run().catch((err) => logger.error('maintenance pass failed', { pass: pass.name, err }));
          }
        })
        .finally(() => {
          inFlight = false;
        });
    }
    timer = clock.setTimeout(tick, intervalMs);
  };
  timer = clock.setTimeout(tick, intervalMs);

  return () => {
    stopped = true;
    clock.clearTimeout(timer);
  };
}
