import type { VisualDiffHighlightDto, VisualDiffPageDto } from '@halley/shared';
import { chromium, type Browser, type Page } from 'playwright';
import { buildVisualDiffShot } from './visual-diff-crop.js';

export type ScreenshotViewport = 'desktop' | 'mobile';
export type ReviewScreenshotMode = 'cropped' | 'full';

export const VIEWPORT_SIZES: Record<ScreenshotViewport, { width: number; height: number }> = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
};

export interface ScreenshotRequest {
  url: string;
  viewport: ScreenshotViewport;
  fullPage?: boolean;
}

const MAX_FULL_PAGE_HEIGHT = 3600;
const MAX_REVIEW_CAPTURE_HEIGHT = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60_000; // 1 hour
const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_SETTLE_WAIT_MS = 40;
const DEFAULT_LIVE_CACHE_MAX_BYTES = 40 * 1024 * 1024;
const DEFAULT_LIVE_CACHE_TTL_MS = 10 * 60_000;
const FULL_PAIR_CACHE_MAX_BYTES = 25 * 1024 * 1024;
const FULL_PAIR_CACHE_TTL_MS = 90_000;

const DETERMINISTIC_CAPTURE_CSS = `
  astro-dev-toolbar { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

export interface ScreenshotResult {
  data: Buffer;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
}

export interface ScreenshotServiceOptions {
  /** Idle duration before closing the warm Chromium browser (default: 1 hour). */
  idleTimeoutMs?: number;
  /** Optional custom browser launcher for tests. */
  launchBrowser?: () => Promise<Browser>;
  /** Extra settle wait after load + font/image readiness (ms, default: 40). */
  settleWaitMs?: number;
  /** Maximum concurrent browser pages across all captures (default: 3). */
  maxConcurrency?: number;
  /** Byte budget for LRU-cached Live site PNG captures (default: 40 MB). */
  liveCacheMaxBytes?: number;
  /** TTL for cached Live site PNG captures (default: 10 minutes). */
  liveCacheTtlMs?: number;
}

interface ByteCacheEntry<T> {
  value: T;
  bytes: number;
  expiresAt: number;
}

class ByteLruCache<T> {
  private readonly map = new Map<string, ByteCacheEntry<T>>();
  private totalBytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly maxEntries: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.delete(key);
      return undefined;
    }
    // Refresh LRU order
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, bytes: number): void {
    if (this.maxBytes <= 0 || bytes > this.maxBytes) return;
    if (this.map.has(key)) this.delete(key);

    while (
      (this.totalBytes + bytes > this.maxBytes || this.map.size >= this.maxEntries) &&
      this.map.size > 0
    ) {
      const oldestKey = this.map.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.delete(oldestKey);
    }

    this.map.set(key, { value, bytes, expiresAt: Date.now() + this.ttlMs });
    this.totalBytes += bytes;
  }

  delete(key: string): void {
    const entry = this.map.get(key);
    if (!entry) return;
    this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.totalBytes = 0;
  }
}

interface RawLiveCapture {
  buf: Buffer;
  height: number;
}

interface RawReviewPair {
  title: string;
  draftBuf: Buffer;
  draftHeight: number;
  liveBuf?: Buffer;
  highlights: VisualDiffHighlightDto[];
}

export interface CaptureRouteReviewOptions {
  route: string;
  draftFiles: string[];
  mergedFromLiveFiles: string[];
  draftBaseUrl: string;
  liveBaseUrl?: string | null;
  baseSha?: string | null;
  liveTimestamp: string;
  viewport?: ScreenshotViewport;
  mode?: ReviewScreenshotMode;
}

export class ScreenshotService {
  private readonly idleTimeoutMs: number;
  private readonly launchBrowser: () => Promise<Browser>;
  private readonly settleWaitMs: number;
  private readonly maxConcurrency: number;

  private browser: Browser | null = null;
  private launchPromise: Promise<Browser> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private activeSlots = 0;
  private readonly waitQueue: Array<() => void> = [];
  private closed = false;

  private readonly liveCache: ByteLruCache<RawLiveCapture>;
  private readonly reviewPairCache: ByteLruCache<RawReviewPair>;

  constructor(opts: ScreenshotServiceOptions = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.settleWaitMs = opts.settleWaitMs ?? DEFAULT_SETTLE_WAIT_MS;
    this.maxConcurrency = Math.max(1, opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    this.liveCache = new ByteLruCache<RawLiveCapture>(
      opts.liveCacheMaxBytes ?? DEFAULT_LIVE_CACHE_MAX_BYTES,
      24,
      opts.liveCacheTtlMs ?? DEFAULT_LIVE_CACHE_TTL_MS,
    );
    this.reviewPairCache = new ByteLruCache<RawReviewPair>(
      FULL_PAIR_CACHE_MAX_BYTES,
      16,
      FULL_PAIR_CACHE_TTL_MS,
    );
    this.launchBrowser =
      opts.launchBrowser ??
      (() =>
        chromium.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        }));
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleIdleClose(): void {
    this.clearIdleTimer();
    if (this.closed || !this.browser || this.activeSlots > 0 || this.idleTimeoutMs <= 0) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.activeSlots === 0 && this.browser) {
        void this.closeBrowser();
      }
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) {
      return this.browser;
    }
    this.browser = null;

    if (!this.launchPromise) {
      this.launchPromise = this.launchBrowser()
        .then((b) => {
          this.browser = b;
          b.on('disconnected', () => {
            if (this.browser === b) {
              this.browser = null;
              this.clearIdleTimer();
            }
          });
          return b;
        })
        .finally(() => {
          this.launchPromise = null;
        });
    }

    return this.launchPromise;
  }

  private async closeBrowser(): Promise<void> {
    this.clearIdleTimer();
    const b = this.browser;
    this.browser = null;
    if (b) {
      await b.close().catch(() => {});
    }
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new Error('ScreenshotService has been closed');
    }
    if (this.activeSlots >= this.maxConcurrency) {
      await new Promise<void>((resolve) => {
        this.waitQueue.push(resolve);
      });
    }
    if (this.closed) {
      throw new Error('ScreenshotService has been closed');
    }
    this.activeSlots += 1;
    this.clearIdleTimer();
    try {
      return await fn();
    } finally {
      this.activeSlots -= 1;
      const next = this.waitQueue.shift();
      if (next) {
        next();
      } else if (this.activeSlots === 0) {
        this.scheduleIdleClose();
      }
    }
  }

  /**
   * Non-blockingly warms the shared Chromium browser (e.g., when a session opens)
   * while still honoring idleTimeoutMs auto-close.
   */
  prewarm(): void {
    if (this.closed || this.browser?.isConnected() || this.launchPromise) {
      return;
    }
    void this.ensureBrowser()
      .then(() => {
        if (this.activeSlots === 0) {
          this.scheduleIdleClose();
        }
      })
      .catch(() => {});
  }

  private async gotoAndReady(
    page: Page,
    url: string,
    timeoutMs: number,
  ): Promise<{ status: () => number } | null> {
    const res = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });

    // Real Playwright pages expose addStyleTag; guard so minimal fake Page mocks in unit tests stay clean
    if (typeof (page as { addStyleTag?: unknown }).addStyleTag === 'function') {
      await page.addStyleTag({ content: DETERMINISTIC_CAPTURE_CSS }).catch(() => {});
      await page
        .evaluate(async () => {
          const doc = (
            globalThis as unknown as {
              document?: {
                fonts?: { ready?: Promise<unknown> };
                images?: Iterable<{
                  complete?: boolean;
                  loading?: string;
                  decode?: () => Promise<void>;
                }>;
              };
              requestAnimationFrame?: (cb: () => void) => number;
            }
          ).document;
          const fontWait = doc?.fonts?.ready
            ? Promise.race([
                doc.fonts.ready.catch(() => {}),
                new Promise((r) => setTimeout(r, 1200)),
              ])
            : Promise.resolve();

          const imgPromises: Array<Promise<unknown>> = [];
          if (doc?.images) {
            for (const img of doc.images) {
              if (!img.complete && img.loading !== 'lazy' && typeof img.decode === 'function') {
                imgPromises.push(img.decode().catch(() => {}));
              }
            }
          }
          const imgWait =
            imgPromises.length > 0
              ? Promise.race([
                  Promise.allSettled(imgPromises),
                  new Promise((r) => setTimeout(r, 1200)),
                ])
              : Promise.resolve();

          await Promise.all([fontWait, imgWait]);
          const raf = (globalThis as unknown as { requestAnimationFrame?: (cb: () => void) => number })
            .requestAnimationFrame;
          if (typeof raf === 'function') {
            await new Promise<void>((resolve) => raf(() => raf(() => resolve())));
          }
        })
        .catch(() => {});
    }

    if (this.settleWaitMs > 0) {
      await page.waitForTimeout(this.settleWaitMs);
    }

    return res as { status: () => number } | null;
  }

  /**
   * Capture a screenshot using the shared warm Chromium browser (used by Pi's screenshot_page tool).
   * Bounded concurrency allows parallel desktop + mobile captures while keeping RAM bounded.
   */
  capture(req: ScreenshotRequest): Promise<ScreenshotResult> {
    if (this.closed) {
      return Promise.reject(new Error('ScreenshotService has been closed'));
    }

    return this.withSlot(async () => {
      const size = VIEWPORT_SIZES[req.viewport];
      const browser = await this.ensureBrowser();
      const context = await browser.newContext({
        viewport: size,
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
      });
      try {
        const page = await context.newPage();
        await this.gotoAndReady(page, req.url, 25_000);
        if (req.fullPage) {
          let captureHeight = size.height;
          if (typeof page.evaluate === 'function') {
            const docHeight = await page
              .evaluate<number>(
                'Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement ? document.documentElement.scrollHeight : 0)',
              )
              .catch(() => size.height);
            captureHeight = Math.min(Math.max(docHeight || size.height, size.height), MAX_FULL_PAGE_HEIGHT);
          }
          const data = await page.screenshot({
            type: 'jpeg',
            quality: 80,
            fullPage: true,
            clip: { x: 0, y: 0, width: size.width, height: captureHeight },
          });
          return { data, mimeType: 'image/jpeg', width: size.width, height: captureHeight };
        }
        const data = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: false });
        return { data, mimeType: 'image/jpeg', width: size.width, height: size.height };
      } finally {
        await context.close().catch(() => {});
      }
    });
  }

  private async captureDraftRaw(
    draftUrl: string,
    size: { width: number; height: number },
    draftFiles: string[],
    mergedFromLiveFiles: string[],
    fallbackTitle: string,
  ): Promise<{ title: string; buf: Buffer; height: number; highlights: VisualDiffHighlightDto[] } | null> {
    return this.withSlot(async () => {
      const browser = await this.ensureBrowser();
      const context = await browser.newContext({
        viewport: size,
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
      });
      try {
        const page = await context.newPage();
        await this.gotoAndReady(page, draftUrl, 20_000);
        const title = (await page.title().catch(() => '')) || fallbackTitle;

        let captureHeight = size.height;
        let highlights: VisualDiffHighlightDto[] = [];

        if (typeof page.evaluate === 'function') {
          const docHeight = await page
            .evaluate<number>(
              'Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement ? document.documentElement.scrollHeight : 0)',
            )
            .catch(() => size.height);
          captureHeight = Math.min(
            Math.max(docHeight || size.height, size.height),
            MAX_REVIEW_CAPTURE_HEIGHT,
          );

          highlights = await page
            .evaluate(
              ({
                dFiles,
                mFiles,
                vpW,
                vpH,
              }: {
                dFiles: string[];
                mFiles: string[];
                vpW: number;
                vpH: number;
              }) => {
                const out: Array<{
                  x: number;
                  y: number;
                  width: number;
                  height: number;
                  kind: 'draft' | 'merged_from_live';
                  file: string;
                }> = [];
                const doc = (
                  globalThis as unknown as {
                    document: {
                      querySelectorAll: (sel: string) => Iterable<{
                        getAttribute: (name: string) => string | null;
                        getBoundingClientRect: () => {
                          left: number;
                          top: number;
                          width: number;
                          height: number;
                          bottom: number;
                        };
                      }>;
                    };
                  }
                ).document;
                const els = doc.querySelectorAll('[data-astro-source-file]');
                for (const el of els) {
                  const src = (el.getAttribute('data-astro-source-file') || '').replace(/\\/g, '/');
                  const isDraft = dFiles.some((f) => src.endsWith(f));
                  const isMerged = mFiles.some((f) => src.endsWith(f));
                  if (!isDraft && !isMerged) continue;
                  const rect = el.getBoundingClientRect();
                  if (rect.width < 8 || rect.height < 8 || rect.top >= vpH || rect.bottom <= 0) continue;
                  const clampedTop = Math.max(0, rect.top);
                  const clampedBottom = Math.min(vpH, rect.bottom);
                  const clampedHeight = clampedBottom - clampedTop;
                  if (clampedHeight < 4) continue;
                  out.push({
                    x: Math.round((Math.max(0, rect.left) / vpW) * 1000) / 10,
                    y: Math.round((clampedTop / vpH) * 1000) / 10,
                    width: Math.round((Math.min(vpW - Math.max(0, rect.left), rect.width) / vpW) * 1000) / 10,
                    height: Math.round((clampedHeight / vpH) * 1000) / 10,
                    kind: isDraft ? 'draft' : 'merged_from_live',
                    file: src,
                  });
                  if (out.length >= 24) break;
                }
                return out;
              },
              { dFiles: draftFiles, mFiles: mergedFromLiveFiles, vpW: size.width, vpH: captureHeight },
            )
            .catch(() => []);
        }

        const png = await page.screenshot({
          type: 'png',
          fullPage: true,
          clip: { x: 0, y: 0, width: size.width, height: captureHeight },
        });
        return { title, buf: png, height: captureHeight, highlights };
      } catch {
        return null;
      } finally {
        await context.close().catch(() => {});
      }
    });
  }

  private async captureLiveRaw(
    liveUrl: string,
    viewport: ScreenshotViewport,
    size: { width: number; height: number },
    baseSha?: string | null,
  ): Promise<RawLiveCapture | null> {
    const cacheKey = `${liveUrl}|${viewport}|${baseSha || 'live'}`;
    const cached = this.liveCache.get(cacheKey);
    if (cached) return cached;

    return this.withSlot(async () => {
      // Re-check cache after acquiring slot
      const afterWait = this.liveCache.get(cacheKey);
      if (afterWait) return afterWait;

      const browser = await this.ensureBrowser();
      const context = await browser.newContext({
        viewport: size,
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
      });
      try {
        const livePage = await context.newPage();
        const liveRes = await this.gotoAndReady(livePage, liveUrl, 15_000);
        if (liveRes && typeof liveRes.status === 'function' && liveRes.status() >= 400) {
          return null;
        }
        let liveHeight = size.height;
        if (typeof livePage.evaluate === 'function') {
          const liveDocHeight = await livePage
            .evaluate<number>(
              'Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement ? document.documentElement.scrollHeight : 0)',
            )
            .catch(() => size.height);
          liveHeight = Math.min(
            Math.max(liveDocHeight || size.height, size.height),
            MAX_REVIEW_CAPTURE_HEIGHT,
          );
        }
        const livePng = await livePage.screenshot({
          type: 'png',
          fullPage: true,
          clip: { x: 0, y: 0, width: size.width, height: liveHeight },
        });
        const captured: RawLiveCapture = { buf: livePng, height: liveHeight };
        this.liveCache.set(cacheKey, captured, livePng.length);
        return captured;
      } catch {
        return null;
      } finally {
        await context.close().catch(() => {});
      }
    });
  }

  /**
   * Captures a single route's Live vs Draft review screenshot in either 'cropped' (default)
   * or 'full' mode. Draft and Live capture concurrently; Live PNGs are LRU-cached by baseSha.
   */
  async captureRouteReview(opts: CaptureRouteReviewOptions): Promise<VisualDiffPageDto> {
    if (this.closed) {
      throw new Error('ScreenshotService has been closed');
    }

    const viewport: ScreenshotViewport = opts.viewport === 'mobile' ? 'mobile' : 'desktop';
    const mode: ReviewScreenshotMode = opts.mode === 'full' ? 'full' : 'cropped';
    const size = VIEWPORT_SIZES[viewport];
    const route = opts.route.startsWith('/') ? opts.route : `/${opts.route}`;
    const draftUrl = `${opts.draftBaseUrl.replace(/\/$/, '')}${route === '/' ? '/' : route}`;
    const liveUrl = opts.liveBaseUrl
      ? `${opts.liveBaseUrl.replace(/\/$/, '')}${route === '/' ? '/' : route}`
      : null;
    const fallbackTitle = route === '/' ? 'Homepage' : route;
    const pairCacheKey = `${draftUrl}|${liveUrl || ''}|${viewport}|${opts.baseSha || ''}`;

    let rawPair: RawReviewPair | undefined;
    if (mode === 'full') {
      rawPair = this.reviewPairCache.get(pairCacheKey);
    }

    if (!rawPair) {
      const [draftCap, liveCap] = await Promise.all([
        this.captureDraftRaw(
          draftUrl,
          size,
          [...new Set(opts.draftFiles)],
          [...new Set(opts.mergedFromLiveFiles)],
          fallbackTitle,
        ),
        liveUrl ? this.captureLiveRaw(liveUrl, viewport, size, opts.baseSha) : Promise.resolve(null),
      ]);

      if (draftCap) {
        rawPair = {
          title: draftCap.title,
          draftBuf: draftCap.buf,
          draftHeight: draftCap.height,
          liveBuf: liveCap?.buf,
          highlights: draftCap.highlights,
        };
        this.reviewPairCache.set(
          pairCacheKey,
          rawPair,
          draftCap.buf.length + (liveCap?.buf.length ?? 0),
        );
      }
    }

    if (!rawPair) {
      const emptyShot = {
        highlights: [],
        width: size.width,
        height: size.height,
      };
      return {
        route,
        title: fallbackTitle,
        highlights: [],
        viewport,
        shots: { [viewport]: emptyShot },
        liveTimestamp: opts.liveTimestamp,
      };
    }

    const shot = await buildVisualDiffShot({
      draftBuf: rawPair.draftBuf,
      liveBuf: rawPair.liveBuf,
      highlights: rawPair.highlights,
      fallbackWidth: size.width,
      fallbackHeight: rawPair.draftHeight,
      mode,
    });

    return {
      route,
      title: rawPair.title,
      liveScreenshotDataUrl: viewport === 'desktop' ? shot.liveScreenshotDataUrl : undefined,
      draftScreenshotDataUrl: viewport === 'desktop' ? shot.draftScreenshotDataUrl : undefined,
      mobileLiveScreenshotDataUrl: viewport === 'mobile' ? shot.liveScreenshotDataUrl : undefined,
      mobileDraftScreenshotDataUrl: viewport === 'mobile' ? shot.draftScreenshotDataUrl : undefined,
      highlights: shot.highlights,
      viewport,
      shots: {
        [viewport]: shot,
      },
      liveTimestamp: opts.liveTimestamp,
    };
  }

  /**
   * Captures Live vs Draft review screenshots for up to 4 routes in parallel
   * using the shared warm Chromium browser.
   */
  async captureLiveVsDraftPages(opts: {
    routes: string[];
    draftFiles: string[];
    mergedFromLiveFiles: string[];
    draftBaseUrl: string;
    liveBaseUrl?: string | null;
    baseSha?: string | null;
    liveTimestamp: string;
    viewport?: ScreenshotViewport;
    mode?: ReviewScreenshotMode;
  }): Promise<VisualDiffPageDto[]> {
    if (this.closed) {
      throw new Error('ScreenshotService has been closed');
    }

    const uniqueRoutes = [
      ...new Set(opts.routes.map((r) => (r.startsWith('/') ? r : `/${r}`))),
    ].slice(0, 4);
    if (uniqueRoutes.length === 0) return [];

    return Promise.all(
      uniqueRoutes.map((route) =>
        this.captureRouteReview({
          route,
          draftFiles: opts.draftFiles,
          mergedFromLiveFiles: opts.mergedFromLiveFiles,
          draftBaseUrl: opts.draftBaseUrl,
          liveBaseUrl: opts.liveBaseUrl,
          baseSha: opts.baseSha,
          liveTimestamp: opts.liveTimestamp,
          viewport: opts.viewport,
          mode: opts.mode,
        }),
      ),
    );
  }

  isBrowserRunning(): boolean {
    return Boolean(this.browser?.isConnected());
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearIdleTimer();
    this.liveCache.clear();
    this.reviewPairCache.clear();
    while (this.waitQueue.length > 0) {
      this.waitQueue.shift()?.();
    }
    if (this.launchPromise) {
      const b = await this.launchPromise.catch(() => null);
      if (b) await b.close().catch(() => {});
    }
    await this.closeBrowser();
  }
}
