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
    const safeExt = path.extname(filename).replace(/[^a-zA-Z0-9.]/g, '') || '.bin';
    const dest = path.join(this.uploadDir, `${stagedId}${safeExt}`);
    await fs.writeFile(dest, bytes);

    let thumbnailDataUrl: string | undefined;
    try {
      const thumb = await sharp(bytes)
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
      mimeType,
      sizeBytes: bytes.length,
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
