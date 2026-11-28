import fs from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { realClock } from './clock.js';
import { ignore, logger } from './log.js';

const BACKUP_RE = /^control-plane-(\d{4}-\d{2}-\d{2})\.sqlite$/;

/**
 * `VACUUM INTO` runs on a separate read-only connection inside a worker thread, so a large
 * database never blocks the control-plane event loop (WAL lets it read a consistent snapshot while
 * the main connection keeps writing).
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
let db;
try {
  db = new DatabaseSync(workerData.dbPath, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("VACUUM INTO '" + workerData.target.replace(/'/g, "''") + "'");
  parentPort.postMessage({ ok: true });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
} finally {
  if (db) db.close();
}
`;

function vacuumInto(dbPath: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { dbPath, target } });
    let settled = false;
    worker.once('message', (msg: { ok: boolean; error?: string }) => {
      settled = true;
      if (msg.ok) resolve();
      else reject(new Error(`VACUUM INTO failed: ${msg.error}`));
    });
    worker.once('error', (err) => {
      settled = true;
      reject(err);
    });
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`backup worker exited with code ${code}`));
    });
  });
}

export interface BackupResult {
  file: string | null;
  skipped: boolean;
  pruned: string[];
}

/**
 * Writes `<backupDir>/control-plane-<UTC date>.sqlite` (at most one per day) and keeps the newest
 * `keep` backups. The copy is written to a temp name and renamed, so a crash never leaves a
 * truncated file that looks like a valid backup.
 */
export async function backupDatabase(
  dbPath: string,
  backupDir: string,
  opts: { keep: number; now?: number },
): Promise<BackupResult> {
  const date = new Date(opts.now ?? realClock.now()).toISOString().slice(0, 10);
  const name = `control-plane-${date}.sqlite`;
  const target = path.join(backupDir, name);
  await fs.mkdir(backupDir, { recursive: true });

  let skipped = false;
  const exists = await fs.stat(target).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return false;
      throw err;
    },
  );
  if (exists) {
    skipped = true;
  } else {
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
      await vacuumInto(dbPath, tmp);
      await fs.rename(tmp, target);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch((rmErr) => ignore(rmErr, 'backup: removing temp file failed', { tmp }));
      throw err;
    }
  }

  const pruned: string[] = [];
  const entries = await fs.readdir(backupDir);
  const backups = entries.filter((f) => BACKUP_RE.test(f)).sort().reverse();
  for (const old of backups.slice(Math.max(1, opts.keep))) {
    await fs.rm(path.join(backupDir, old), { force: true });
    pruned.push(old);
  }
  // Leftover temp files from a crash mid-backup
  for (const f of entries) {
    if (f.includes('.sqlite.tmp-') && !f.includes(`.tmp-${process.pid}-`)) {
      await fs.rm(path.join(backupDir, f), { force: true }).catch((err) =>
        ignore(err, 'backup: removing stale temp file failed', { file: f }),
      );
    }
  }
  if (!skipped) logger.info('database backup written', { file: target, pruned: pruned.length });
  return { file: target, skipped, pruned };
}

/** Newest backup's date (epoch ms of its UTC day), or null when there is none. */
export async function latestBackupDay(backupDir: string): Promise<number | null> {
  const entries = await fs.readdir(backupDir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [] as string[];
    throw err;
  });
  const days = entries
    .map((f) => BACKUP_RE.exec(f)?.[1])
    .filter((d): d is string => Boolean(d))
    .sort();
  const last = days[days.length - 1];
  return last ? Date.parse(`${last}T00:00:00Z`) : null;
}
