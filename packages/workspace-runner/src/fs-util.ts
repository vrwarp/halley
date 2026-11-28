/**
 * Filesystem probes with explicit "missing is expected" handling: a missing path (ENOENT/ENOTDIR)
 * is an ordinary answer and is not logged (these run in per-file loops), while any other failure
 * (EACCES, EIO, ELOOP, ...) is logged at warn level before the fallback is returned.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ignore, isMissingPathError } from './log.js';

/** True when `p` exists. Missing → false silently; other errors → logged, false. */
export async function pathExists(p: string, reason = 'fs: probe path'): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch (err) {
    if (!isMissingPathError(err)) ignore(err, reason, { path: p });
    return false;
  }
}

/** UTF-8 contents of `p`, or `fallback` when it does not exist (other read errors are logged). */
export async function readFileOr<F>(p: string, fallback: F, reason: string): Promise<string | F> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch (err) {
    if (!isMissingPathError(err)) ignore(err, reason, { path: p });
    return fallback;
  }
}

/** Resolved real path of `p`, or null when it (or a symlink target) does not exist. */
export async function realpathOrNull(p: string, reason: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch (err) {
    if (!isMissingPathError(err)) ignore(err, reason, { path: p });
    return null;
  }
}

const NO_ENTRIES: never[] = [];

/**
 * Directory entries of `dir` (with file types), or an empty list when it does not exist. Used by
 * recursive walks, where a missing directory (e.g. no `src/content`) is normal; other errors logged.
 */
export async function readdirEntriesOrEmpty(dir: string, reason: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (!isMissingPathError(err)) ignore(err, reason, { dir });
    return NO_ENTRIES;
  }
}

let atomicSeq = 0;

export interface WriteFileAtomicOptions {
  /** Encoding for string data (default utf8). */
  encoding?: BufferEncoding;
  /**
   * fsync the file before the rename and the directory after it, so the new content survives a
   * power loss / kernel crash (state + meta files). Off on hot paths (source rewrites, uploads):
   * the rename alone already guarantees readers see either the old or the complete new file.
   */
  durable?: boolean;
  mode?: number;
}

/**
 * Writes `data` to `filePath` atomically: a temp file in the SAME directory (same filesystem, so
 * the rename is atomic), then `rename` over the target. A crash mid-write leaves the previous
 * content (plus at worst a stray `.tmp-*` file), never a truncated file. The temp file is removed
 * on failure.
 */
export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  opts: WriteFileAtomicOptions = {},
): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${++atomicSeq}`);
  let fh: import('node:fs/promises').FileHandle | null = null;
  try {
    fh = await fs.open(tmp, 'w', opts.mode);
    if (typeof data === 'string') await fh.writeFile(data, opts.encoding ?? 'utf8');
    else await fh.writeFile(data);
    if (opts.durable) await fh.sync();
    await fh.close();
    fh = null;
    await fs.rename(tmp, filePath);
  } catch (err) {
    if (fh) await fh.close().catch((e) => ignore(e, 'fs: close temp file after failed write', { tmp }));
    await fs.rm(tmp, { force: true }).catch((e) => ignore(e, 'fs: remove temp file after failed write', { tmp }));
    throw err;
  }
  if (opts.durable) {
    let dh: import('node:fs/promises').FileHandle | null = null;
    try {
      dh = await fs.open(dir, 'r');
      await dh.sync();
    } catch (err) {
      // some filesystems refuse directory fsync (EINVAL/EISDIR); the rename itself already landed
      ignore(err, 'fs: fsync directory after atomic write', { dir });
    } finally {
      await dh?.close().catch((e) => ignore(e, 'fs: close directory handle', { dir }));
    }
  }
}
