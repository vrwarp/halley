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
  const sessions = db.listSessions();
  const pruneMs = config.nodeModulesPruneDays * 24 * 60 * 60 * 1000;
  const retentionMs = config.archiveRetentionDays * 24 * 60 * 60 * 1000;

  for (const s of sessions) {
    // 1. Stop idle running containers (and published/merged containers woken for read-only viewing)
    if (
      (s.status === 'running' ||
        ((s.status === 'published' || s.status === 'merged') && Boolean(s.runner_url))) &&
      !IN_FLIGHT_PUBLISH_STATES.has(s.publish_state)
    ) {
      const lastActive = new Date(s.last_active_at).getTime();
      if (now - lastActive > config.workspaceIdleTimeoutMs) {
        console.log(`[reaper] Putting idle ${s.status} session ${s.id} to sleep`);
        await driver.stop(s).catch(() => {});
      }
    }

    if (s.volume_expired_at) continue;

    // 2. Slim sleeping/published/merged volumes after NODE_MODULES_PRUNE_DAYS (default 7d)
    if (
      driver.pruneNodeModules &&
      !s.node_modules_pruned_at &&
      (s.status === 'sleeping' || s.status === 'published' || s.status === 'merged') &&
      !IN_FLIGHT_PUBLISH_STATES.has(s.publish_state)
    ) {
      const refTime = new Date(s.archived_at ?? s.merged_at ?? s.last_active_at).getTime();
      if (now - refTime > pruneMs) {
        console.log(`[reaper] Pruning node_modules for idle/archived session ${s.id}`);
        await driver.pruneNodeModules(s).catch(() => {});
        db.updateSession(s.id, { node_modules_pruned_at: new Date(now).toISOString() });
      }
    }

    // 3. Clean up published/merged session volumes after ARCHIVE_RETENTION_DAYS (default 420d)
    if (s.status === 'published') {
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

    // 4. Expire abandoned drafts after ARCHIVE_RETENTION_DAYS (default 420d) from last activity (no warning)
    // Skip sessions with an in-flight publish or in the 'merged' state.
    if (
      (s.status === 'sleeping' || s.status === 'error') &&
      !IN_FLIGHT_PUBLISH_STATES.has(s.publish_state)
    ) {
      const lastActive = new Date(s.last_active_at).getTime();
      if (now - lastActive > retentionMs) {
        console.log(`[reaper] Expiring abandoned draft volume for session ${s.id}`);
        await driver.destroy(s).catch(() => {});
        db.updateSession(s.id, {
          volume_expired_at: new Date(now).toISOString(),
        });
      }
    }
  }
}

export function startSessionReaper(
  config: HalleyConfig,
  db: ControlPlaneDb,
  driver: WorkspaceDriver,
): () => void {
  const interval = setInterval(() => {
    void runReaperPass(config, db, driver);
  }, 60_000);

  return () => clearInterval(interval);
}
