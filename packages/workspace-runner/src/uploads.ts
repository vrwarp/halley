import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { StagedAttachment } from '@halley/shared';
import sharp from 'sharp';

export class UploadManager {
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
    } catch {
      // Non-image or undecodable buffer — store as-is
    }

    const dest = path.join(this.uploadDir, `${stagedId}${safeExt}`);
    await fs.writeFile(dest, finalBytes);

    let thumbnailDataUrl: string | undefined;
    try {
      const thumb = await sharp(finalBytes)
        .rotate()
        .resize({ width: 160, height: 160, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 72 })
        .toBuffer();
      thumbnailDataUrl = `data:image/webp;base64,${thumb.toString('base64')}`;
    } catch {
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

  async resolveStagedFile(stagedId: string): Promise<{ path: string; bytes: Buffer } | null> {
    await this.init();
    const entries = await fs.readdir(this.uploadDir);
    const match = entries.find((e) => e.startsWith(stagedId));
    if (!match) return null;
    const full = path.join(this.uploadDir, match);
    const bytes = await fs.readFile(full);
    return { path: full, bytes };
  }
}
