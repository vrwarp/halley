import type { HalleyConfig } from './config.js';
import type { ControlPlaneDb } from './db.js';
import type { WorkspaceDriver } from './drivers/workspace-driver.js';

const IN_FLIGHT_PUBLISH_STATES = new Set([
  'verifying',
  'rebasing',
  'resolving_conflicts',
  'pushing_pr',
  'waiting_ci',
  'deploying_pages',
]);

export async function runReaperPass(
  config: HalleyConfig,
  db: ControlPlaneDb,
  driver: WorkspaceDriver,
  now = Date.now(),
): Promise<void> {
  await driver.reconcileSessions?.().catch(() => {});
  const sessions = db.listSessions();
  const activeRunSessionIds = new Set(db.listActivePublishRuns().map((r) => r.session_id));
  const pruneMs = config.nodeModulesPruneDays * 24 * 60 * 60 * 1000;
  const retentionMs = config.archiveRetentionDays * 24 * 60 * 60 * 1000;

  const isPublishProtected = (s: { id: string; publish_state: string }) =>
    activeRunSessionIds.has(s.id) ||
    IN_FLIGHT_PUBLISH_STATES.has(s.publish_state) ||
    s.publish_state === 'failed_conflict';

  for (const snapshot of sessions) {
    let s = db.getSession(snapshot.id);
    if (!s) continue;

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
          await driver.stop(freshBeforeStop).catch(() => {});
          s = db.getSession(s.id);
          if (!s) continue;
        }
      }
    }

    if (s.volume_expired_at) continue;

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
          if (!s) continue;
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
        await driver.destroy(s).catch(() => {});
        db.updateSession(s.id, {
          archived_at: null,
          volume_expired_at: new Date(now).toISOString(),
        });
      }
      continue;
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
          await driver.destroy(freshBeforeExpire).catch(() => {});
          db.updateSession(freshBeforeExpire.id, {
            volume_expired_at: new Date(now).toISOString(),
          });
        }
      }
    }
  }
}

export function startSessionReaper(
  config: HalleyConfig,
  db: ControlPlaneDb,
  driver: WorkspaceDriver,
): () => void {
  let inFlight = false;
  const interval = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void runReaperPass(config, db, driver).finally(() => {
      inFlight = false;
    });
  }, 60_000);

  return () => clearInterval(interval);
}
