import fs from 'node:fs/promises';
import path from 'node:path';
import { ignore, ignoreCodes, logger } from '../log.js';
import { envInt, execFileGroup } from '../proc.js';
import { pruneUploadDir } from '../uploads.js';
import { fileExists } from './shared.js';
import type { SupervisorContext } from './context.js';

/**
 * Periodic maintenance: package-cache and upload pruning, mirror maintenance, nm-cache
 * verification. Created by createWorkspaceSupervisor (see SupervisorContext).
 */
export function createMaintenance(ctx: SupervisorContext) {
  const {
    clock,
    sessionsRoot,
    pkgCacheDir,
    nmCache,
    bootingSessions,
    deletedSessionIds,
    logsBySession,
    pruneTombstones,
    pruneLogBuffers,
  } = ctx;
  // ---------------------------------------------------------------------------------------------
  // Periodic maintenance (hourly, off the request path; each step skips itself while busy)
  // ---------------------------------------------------------------------------------------------
  const pkgCacheMaxBytes = envInt('HALLEY_PKG_CACHE_MAX_MB', 8192, 64) * 1024 * 1024;
  const uploadMaxAgeMs = envInt('HALLEY_UPLOAD_MAX_AGE_DAYS', 14, 1) * 24 * 60 * 60_000;
  const uploadMaxBytes = envInt('HALLEY_UPLOAD_MAX_MB_PER_SESSION', 256, 1) * 1024 * 1024;
  const maintenanceIntervalMs = envInt('HALLEY_MAINTENANCE_INTERVAL_MS', 60 * 60_000, 1_000);

  async function dirSizeBytes(dir: string): Promise<number> {
    if (!(await fileExists(dir))) return 0;
    try {
      const { stdout } = await execFileGroup('du', ['-sb', dir], { timeoutMs: 120_000, maxBuffer: 64 * 1024 });
      return Number(stdout.split(/\s+/)[0]) || 0;
    } catch (err) {
      ignore(err, 'supervisor: measure directory size', { dir });
      return 0;
    }
  }

  /** pnpm store prune / npm cache verify when the shared package cache exceeds its size cap. */
  async function prunePackageCache(): Promise<{ beforeBytes: number; afterBytes: number } | null> {
    const beforeBytes = await dirSizeBytes(pkgCacheDir);
    if (beforeBytes <= pkgCacheMaxBytes) return null;
    const pnpmStore = path.join(pkgCacheDir, 'pnpm');
    const npmCache = path.join(pkgCacheDir, 'npm');
    if (await fileExists(pnpmStore)) {
      await execFileGroup('pnpm', ['store', 'prune', '--store-dir', pnpmStore], { timeoutMs: 10 * 60_000 }).catch(
        (err) => logger.warn('supervisor: pnpm store prune failed', { err }),
      );
    }
    if (await fileExists(npmCache)) {
      // `npm cache verify` garbage-collects unreferenced content and checks integrity
      await execFileGroup('npm', ['cache', 'verify', '--cache', npmCache], { timeoutMs: 10 * 60_000 }).catch(
        (err) => logger.warn('supervisor: npm cache verify failed', { err }),
      );
    }
    let afterBytes = await dirSizeBytes(pkgCacheDir);
    if (afterBytes > pkgCacheMaxBytes && (await fileExists(npmCache))) {
      // Still over the cap: the npm cache is a pure cache (installs fall back to the registry)
      await fs.rm(npmCache, { recursive: true, force: true }).catch((e) => ignore(e, 'supervisor: drop npm cache'));
      afterBytes = await dirSizeBytes(pkgCacheDir);
    }
    logger.info('supervisor: pruned package cache', { beforeBytes, afterBytes, capBytes: pkgCacheMaxBytes });
    return { beforeBytes, afterBytes };
  }

  async function pruneUploads(): Promise<number> {
    const ids = await fs.readdir(sessionsRoot).catch((err) => {
      ignoreCodes(err, ['ENOENT'], 'supervisor: list sessions for upload pruning');
      return [] as string[];
    });
    let removed = 0;
    for (const id of ids) {
      const r = await pruneUploadDir(path.join(sessionsRoot, id, 'state', 'uploads'), {
        maxAgeMs: uploadMaxAgeMs,
        maxBytes: uploadMaxBytes,
      });
      if (r.removedFiles > 0) {
        removed += r.removedFiles;
        logger.info('supervisor: pruned staged uploads', { sessionId: id, ...r });
      }
    }
    return removed;
  }

  let maintenanceRunning: Promise<Record<string, unknown>> | null = null;
  /** One maintenance pass. Exposed for tests/ops; also runs every HALLEY_MAINTENANCE_INTERVAL_MS. */
  function runMaintenance(): Promise<Record<string, unknown>> {
    if (maintenanceRunning) return maintenanceRunning;
    maintenanceRunning = (async () => {
      const report: Record<string, unknown> = {};
      const step = async (name: string, fn: () => Promise<unknown>) => {
        try {
          report[name] = await fn();
        } catch (err) {
          logger.error('supervisor: maintenance step failed', { step: name, err });
          report[name] = 'error';
        }
      };
      const idle = () => bootingSessions.size === 0 && !nmCache.isBusy();
      await step('mirror', () => ctx.runMirrorMaintenance());
      await step('nmCacheVerify', async () => (idle() ? nmCache.verifyAll() : 'skipped (busy)'));
      await step('pkgCache', async () => (idle() ? prunePackageCache() : 'skipped (busy)'));
      await step('uploads', () => pruneUploads());
      await step('buffers', async () => {
        pruneTombstones();
        pruneLogBuffers();
        return { logBuffers: logsBySession.size, tombstones: deletedSessionIds.size };
      });
      return report;
    })().finally(() => {
      maintenanceRunning = null;
    });
    return maintenanceRunning;
  }

  const maintenanceTimer = clock.setInterval(() => {
    void runMaintenance();
  }, maintenanceIntervalMs);
  maintenanceTimer.unref?.();

  return { runMaintenance, maintenanceTimer };
}
