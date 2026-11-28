import { realClock, type Clock, type IdGenerator } from './clock.js';

interface StoredImage {
  bytes: Buffer;
  contentType: string;
  expiresAt: number;
}

/**
 * Short-lived in-memory store for review screenshots, so responses carry an id URL
 * (`/api/screenshots/<id>`, served as binary with HTTP caching) instead of multi-megabyte base64
 * data URLs inside JSON. Bounded by total bytes (oldest evicted first) and a TTL.
 */
export class ScreenshotStore {
  private readonly images = new Map<string, StoredImage>();
  private totalBytes = 0;
  private readonly clock: Clock;
  private readonly randomUUID: IdGenerator;
  readonly maxBytes: number;
  readonly ttlMs: number;

  constructor(opts: { clock?: Clock; randomUUID?: IdGenerator; maxBytes?: number; ttlMs?: number } = {}) {
    this.clock = opts.clock ?? realClock;
    this.randomUUID = opts.randomUUID ?? (() => crypto.randomUUID());
    this.maxBytes = opts.maxBytes ?? 128 * 1024 * 1024;
    this.ttlMs = opts.ttlMs ?? 15 * 60_000;
  }

  put(bytes: Buffer, contentType: string): string {
    const now = this.clock.now();
    this.evict(now, bytes.byteLength);
    const id = this.randomUUID();
    this.images.set(id, { bytes, contentType, expiresAt: now + this.ttlMs });
    this.totalBytes += bytes.byteLength;
    return id;
  }

  get(id: string): StoredImage | null {
    const img = this.images.get(id);
    if (!img) return null;
    if (img.expiresAt <= this.clock.now()) {
      this.delete(id, img);
      return null;
    }
    return img;
  }

  get size(): number {
    return this.images.size;
  }

  private delete(id: string, img: StoredImage): void {
    this.images.delete(id);
    this.totalBytes -= img.bytes.byteLength;
  }

  private evict(now: number, incoming: number): void {
    // Insertion order == age order: drop expired and oldest entries until the new image fits
    for (const [id, img] of this.images) {
      if (img.expiresAt > now && this.totalBytes + incoming <= this.maxBytes) break;
      this.delete(id, img);
    }
  }
}

const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,/i;

/**
 * Replaces every `*DataUrl` string holding a base64 image (at any depth of `value`) with an id URL
 * served from `store`. Field names stay the same, so clients that use them as <img src> or fetch()
 * them keep working.
 */
export function externalizeDataUrls<T>(value: T, store: ScreenshotStore, urlFor: (id: string) => string): T {
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (!v || typeof v !== 'object') return;
    const obj = v as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const field = obj[key];
      if (typeof field === 'string') {
        if (!key.endsWith('DataUrl')) continue;
        const m = DATA_URL_RE.exec(field);
        if (!m) continue;
        const bytes = Buffer.from(field.slice(m[0].length), 'base64');
        obj[key] = urlFor(store.put(bytes, m[1]!.toLowerCase()));
      } else if (field && typeof field === 'object') {
        walk(field);
      }
    }
  };
  walk(value);
  return value;
}
