import type { VisualDiffHighlightDto, VisualDiffPageDto } from '@halley/shared';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

export type ScreenshotViewport = 'desktop' | 'mobile';

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
const REVIEW_IMAGE_QUALITY = 88;
const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60_000; // 1 hour
const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_SETTLE_WAIT_MS = 40;
const DEFAULT_LIVE_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const DEFAULT_LIVE_CACHE_TTL_MS = 10 * 60_000;

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
  /** Byte budget for LRU-cached Live site compressed captures (default: 24 MB). */
  liveCacheMaxBytes?: number;
  /** TTL for cached Live site captures (default: 10 minutes). */
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

interface CompressedCapture {
  dataUrl: string;
  byteLength: number;
  height: number;
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
  signal?: AbortSignal;
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

  private readonly liveCache: ByteLruCache<CompressedCapture>;

  constructor(opts: ScreenshotServiceOptions = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.settleWaitMs = opts.settleWaitMs ?? DEFAULT_SETTLE_WAIT_MS;
    this.maxConcurrency = Math.max(1, opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    this.liveCache = new ByteLruCache<CompressedCapture>(
      opts.liveCacheMaxBytes ?? DEFAULT_LIVE_CACHE_MAX_BYTES,
      32,
      opts.liveCacheTtlMs ?? DEFAULT_LIVE_CACHE_TTL_MS,
    );
    this.launchBrowser =
      opts.launchBrowser ??
      (() =>
        chromium.launch({
          headless: true,
          timeout: 30_000,
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
      let launchTimer: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        launchTimer = setTimeout(
          () => reject(new Error('Timed out launching Chromium browser after 30s')),
          30_000,
        );
      });
      this.launchPromise = Promise.race([this.launchBrowser(), timeoutPromise])
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
          if (launchTimer) clearTimeout(launchTimer);
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

  private async withSlot<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closed) {
      throw new Error('ScreenshotService has been closed');
    }
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('Screenshot request aborted');
    }
    if (this.activeSlots >= this.maxConcurrency) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          const idx = this.waitQueue.indexOf(wake);
          if (idx !== -1) this.waitQueue.splice(idx, 1);
          reject(
            signal?.reason instanceof Error
              ? signal.reason
              : new Error('Screenshot request aborted'),
          );
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        this.waitQueue.push(wake);
      });
    }
    if (this.closed) {
      throw new Error('ScreenshotService has been closed');
    }
    if (signal?.aborted) {
      const next = this.waitQueue.shift();
      if (next) next();
      throw signal.reason instanceof Error ? signal.reason : new Error('Screenshot request aborted');
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
   * Captures a compressed full-page screenshot directly via Chromium CDP WebP (q=88),
   * avoiding any Node.js image-encoding CPU/RAM overhead. Falls back to JPEG (q=88)
   * when CDP is unavailable (e.g., mocked unit tests).
   */
  private async captureFullPageCompressed(
    context: BrowserContext,
    page: Page,
    width: number,
    captureHeight: number,
  ): Promise<CompressedCapture> {
    if (typeof (context as { newCDPSession?: unknown }).newCDPSession === 'function') {
      try {
        const cdp = await context.newCDPSession(page);
        let cdpTimer: ReturnType<typeof setTimeout> | null = null;
        try {
          const result = (await Promise.race([
            cdp.send('Page.captureScreenshot', {
              format: 'webp',
              quality: REVIEW_IMAGE_QUALITY,
              captureBeyondViewport: true,
              clip: { x: 0, y: 0, width, height: captureHeight, scale: 1 },
            }),
            new Promise<never>((_, reject) => {
              cdpTimer = setTimeout(
                () => reject(new Error('CDP Page.captureScreenshot timed out after 20s')),
                20_000,
              );
            }),
          ])) as { data?: string };
          if (result?.data) {
            return {
              dataUrl: `data:image/webp;base64,${result.data}`,
              byteLength: Math.ceil((result.data.length * 3) / 4),
              height: captureHeight,
            };
          }
        } finally {
          if (cdpTimer) clearTimeout(cdpTimer);
          await cdp.detach().catch(() => {});
        }
      } catch {
        // Fall back to Playwright JPEG screenshot below
      }
    }

    const jpg = await page.screenshot({
      type: 'jpeg',
      quality: REVIEW_IMAGE_QUALITY,
      fullPage: true,
      clip: { x: 0, y: 0, width, height: captureHeight },
    });
    return {
      dataUrl: `data:image/jpeg;base64,${jpg.toString('base64')}`,
      byteLength: jpg.length,
      height: captureHeight,
    };
  }

  /**
   * Capture a screenshot using the shared warm Chromium browser (used by Pi's screenshot_page tool).
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

  private async captureDraftFull(
    draftUrl: string,
    size: { width: number; height: number },
    draftFiles: string[],
    mergedFromLiveFiles: string[],
    fallbackTitle: string,
    signal?: AbortSignal,
  ): Promise<{ title: string; capture: CompressedCapture; highlights: VisualDiffHighlightDto[] } | null> {
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

        const capture = await this.captureFullPageCompressed(context, page, size.width, captureHeight);
        return { title, capture, highlights };
      } catch {
        return null;
      } finally {
        await context.close().catch(() => {});
      }
    }, signal);
  }

  private async captureLiveFull(
    liveUrl: string,
    viewport: ScreenshotViewport,
    size: { width: number; height: number },
    baseSha?: string | null,
    signal?: AbortSignal,
  ): Promise<CompressedCapture | null> {
    const cacheKey = `${liveUrl}|${viewport}|${baseSha || 'live'}`;
    const cached = this.liveCache.get(cacheKey);
    if (cached) return cached;

    return this.withSlot(async () => {
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
        const captured = await this.captureFullPageCompressed(context, livePage, size.width, liveHeight);
        this.liveCache.set(cacheKey, captured, captured.byteLength);
        return captured;
      } catch {
        return null;
      } finally {
        await context.close().catch(() => {});
      }
    }, signal);
  }

  /**
   * Captures a single route's full-page compressed Live & Draft screenshots in parallel.
   * Perceptual diffing, hunk cropping, and height-alignment padding run client-side in a Web Worker.
   */
  async captureRouteReview(opts: CaptureRouteReviewOptions): Promise<VisualDiffPageDto> {
    if (this.closed) {
      throw new Error('ScreenshotService has been closed');
    }

    const viewport: ScreenshotViewport = opts.viewport === 'mobile' ? 'mobile' : 'desktop';
    const size = VIEWPORT_SIZES[viewport];
    const route = opts.route.startsWith('/') ? opts.route : `/${opts.route}`;
    const draftUrl = `${opts.draftBaseUrl.replace(/\/$/, '')}${route === '/' ? '/' : route}`;
    const liveUrl = opts.liveBaseUrl
      ? `${opts.liveBaseUrl.replace(/\/$/, '')}${route === '/' ? '/' : route}`
      : null;
    const fallbackTitle = route === '/' ? 'Homepage' : route;

    const [draftRes, liveCap] = await Promise.all([
      this.captureDraftFull(
        draftUrl,
        size,
        [...new Set(opts.draftFiles)],
        [...new Set(opts.mergedFromLiveFiles)],
        fallbackTitle,
        opts.signal,
      ),
      liveUrl
        ? this.captureLiveFull(liveUrl, viewport, size, opts.baseSha, opts.signal)
        : Promise.resolve(null),
    ]);

    if (!draftRes) {
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

    const shot = {
      draftScreenshotDataUrl: draftRes.capture.dataUrl,
      liveScreenshotDataUrl: liveCap?.dataUrl,
      highlights: draftRes.highlights,
      width: size.width,
      height: draftRes.capture.height,
      fullWidth: size.width,
      fullHeight: draftRes.capture.height,
      hasFullPage: true,
    };

    return {
      route,
      title: draftRes.title,
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
