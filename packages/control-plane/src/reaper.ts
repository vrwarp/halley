import type { HalleyConfig } from './config.js';
import type { ControlPlaneDb } from './db.js';
import type { WorkspaceDriver } from './drivers/workspace-driver.js';

export function startSessionReaper(
  config: HalleyConfig,
  db: ControlPlaneDb,
  driver: WorkspaceDriver,
): () => void {
  const interval = setInterval(async () => {
    const now = Date.now();
    const sessions = db.listSessions();

    for (const s of sessions) {
      // 1. Stop idle running containers (keep volume intact for cold resume)
      if (s.status === 'running') {
        const lastActive = new Date(s.last_active_at).getTime();
        if (now - lastActive > config.workspaceIdleTimeoutMs) {
          console.log(`[reaper] Putting idle session ${s.id} to sleep`);
          await driver.stop(s).catch(() => {});
        }
      }

      // 2. Clean up archived/published session volumes after ARCHIVE_RETENTION_DAYS (default 7d)
      if (s.status === 'published' && s.archived_at) {
        const archivedAt = new Date(s.archived_at).getTime();
        const retentionMs = config.archiveRetentionDays * 24 * 60 * 60 * 1000;
        if (now - archivedAt > retentionMs) {
          console.log(`[reaper] Cleaning up archived volume for session ${s.id}`);
          await driver.destroy(s).catch(() => {});
          db.updateSession(s.id, { archived_at: null });
        }
      }
    }
  }, 60_000);

  return () => clearInterval(interval);
}
