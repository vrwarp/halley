import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { StagedAttachment } from '@halley/shared';
import sharp from 'sharp';
import { writeFileAtomic } from './fs-util.js';
import { ignore, ignoreCodes } from './log.js';

export class UploadManager {
  /** stagedId -> file name inside uploadDir. */
  private readonly index = new Map<string, string>();

  constructor(private uploadDir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.uploadDir, { recursive: true });
  }

  async stageImage(
    filename: string,
    mimeType: string,
    bytes: Buffer,
  ): Promise<StagedAttachment> {
    await this.init();
    const stagedId = crypto.randomUUID();
    let safeExt = path.extname(filename).replace(/[^a-zA-Z0-9.]/g, '').toLowerCase() || '.bin';
    let finalBytes = bytes;
    let finalMime = mimeType;

    // Strip EXIF/GPS/XMP metadata at upload time while applying EXIF orientation first
    // so portrait phone photos stay upright and zero location metadata persists on disk.
    try {
      const meta = await sharp(bytes).metadata();
      if (meta.format) {
        const oriented = sharp(bytes).rotate();
        if (meta.format === 'jpeg') {
          finalBytes = await oriented.jpeg({ quality: 95, mozjpeg: false }).toBuffer();
          safeExt = '.jpg';
          finalMime = 'image/jpeg';
        } else if (meta.format === 'png') {
          finalBytes = await oriented.png().toBuffer();
          safeExt = '.png';
          finalMime = 'image/png';
        } else if (meta.format === 'webp') {
          finalBytes = await oriented.webp({ quality: 95 }).toBuffer();
          safeExt = '.webp';
          finalMime = 'image/webp';
        } else if (meta.format !== 'svg' && meta.format !== 'gif') {
          // HEIC / AVIF / TIFF -> high-quality WebP without metadata
          finalBytes = await oriented.webp({ quality: 92 }).toBuffer();
          safeExt = '.webp';
          finalMime = 'image/webp';
        }
      }
    } catch (err) {
      // Non-image or undecodable buffer — store as-is
      ignore(err, 'uploads: image normalization failed; storing original bytes', { name: filename });
    }

    const dest = path.join(this.uploadDir, `${stagedId}${safeExt}`);
    // resolveStagedFile may read it concurrently: only ever a complete file under the final name
    await writeFileAtomic(dest, finalBytes);
    this.index.set(stagedId, path.basename(dest));

    let thumbnailDataUrl: string | undefined;
    try {
      const thumb = await sharp(finalBytes)
        .rotate()
        .resize({ width: 160, height: 160, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 72 })
        .toBuffer();
      thumbnailDataUrl = `data:image/webp;base64,${thumb.toString('base64')}`;
    } catch (err) {
      ignore(err, 'uploads: thumbnail generation failed', { name: filename });
      thumbnailDataUrl = undefined;
    }

    return {
      stagedId,
      filename: path.basename(filename),
      mimeType: finalMime,
      sizeBytes: finalBytes.length,
      thumbnailDataUrl,
    };
  }

  /**
   * Absolute path of a staged upload, or null. Served from an in-memory index filled at staging
   * time (no readdir per attachment); a miss (runner restarted since staging) falls back to one
   * directory scan, which then indexes every staged file. Matches the exact `<stagedId>.<ext>`
   * name only (never a prefix of another id).
   */
  async resolveStagedPath(stagedId: string): Promise<string | null> {
    if (!STAGED_ID_RE.test(stagedId)) return null;
    const known = this.index.get(stagedId);
    if (known) return path.join(this.uploadDir, known);
    await this.init();
    for (const name of await fs.readdir(this.uploadDir)) {
      const id = stagedIdOf(name);
      if (id) this.index.set(id, name);
    }
    const found = this.index.get(stagedId);
    return found ? path.join(this.uploadDir, found) : null;
  }

  async resolveStagedFile(stagedId: string): Promise<{ path: string; bytes: Buffer } | null> {
    const full = await this.resolveStagedPath(stagedId);
    if (!full) return null;
    try {
      return { path: full, bytes: await fs.readFile(full) };
    } catch (err) {
      // pruned since it was indexed
      ignoreCodes(err, ['ENOENT'], 'uploads: read staged file', { stagedId });
      this.index.delete(stagedId);
      return null;
    }
  }
}

const STAGED_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `<uuid>.<ext>` -> uuid (temp files start with '.', so they never match). */
function stagedIdOf(name: string): string | null {
  const dot = name.indexOf('.');
  const id = dot === -1 ? name : name.slice(0, dot);
  return STAGED_ID_RE.test(id) ? id : null;
}

export interface UploadPruneResult {
  removedFiles: number;
  removedBytes: number;
  keptBytes: number;
}

/**
 * Bounds a session's staged-upload dir: removes files older than `maxAgeMs`, then the oldest files
 * until the total is at most `maxBytes`. Never touches anything but regular files directly inside
 * `uploadDir` (uploads are staged there; committed images live in the repo, not here).
 */
export async function pruneUploadDir(
  uploadDir: string,
  opts: { maxAgeMs: number; maxBytes: number; now?: number },
): Promise<UploadPruneResult> {
  const now = opts.now ?? Date.now();
  const result: UploadPruneResult = { removedFiles: 0, removedBytes: 0, keptBytes: 0 };
  let names: string[];
  try {
    names = await fs.readdir(uploadDir);
  } catch (err) {
    ignoreCodes(err, ['ENOENT', 'ENOTDIR'], 'uploads: read upload dir for pruning', { uploadDir });
    return result;
  }
  const files: Array<{ full: string; size: number; mtimeMs: number }> = [];
  for (const name of names) {
    const full = path.join(uploadDir, name);
    try {
      const st = await fs.lstat(full);
      if (st.isFile()) files.push({ full, size: st.size, mtimeMs: st.mtimeMs });
    } catch (err) {
      ignoreCodes(err, ['ENOENT'], 'uploads: stat upload for pruning', { full });
    }
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  let total = files.reduce((n, f) => n + f.size, 0);
  for (const f of files) {
    const tooOld = now - f.mtimeMs > opts.maxAgeMs;
    if (!tooOld && total <= opts.maxBytes) break;
    try {
      await fs.rm(f.full, { force: true });
      result.removedFiles++;
      result.removedBytes += f.size;
      total -= f.size;
    } catch (err) {
      ignore(err, 'uploads: remove pruned upload', { full: f.full });
    }
  }
  result.keptBytes = total;
  return result;
}
