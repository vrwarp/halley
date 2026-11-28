import type { VisualDiffHighlightDto, VisualDiffPageDto } from '@halley/shared';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { realClock, type Clock, type TimerHandle } from './clock.js';
import { ignore, logger, orDefault } from './log.js';

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
const DEFAULT_MAX_CONCURRENCY = Math.max(
  1,
  Number(process.env.HALLEY_SCREENSHOT_CONCURRENCY || 2) || 2,
);
const DEFAULT_SETTLE_WAIT_MS = 40;
const DEFAULT_MAX_QUEUE = Math.max(0, Number(process.env.HALLEY_SCREENSHOT_MAX_QUEUE || 16) || 16);
/** Covers queue wait + newContext + goto + readiness + screenshot + close. */
const DEFAULT_CAPTURE_DEADLINE_MS = 60_000;
const DEFAULT_RECYCLE_AFTER_CAPTURES = 200;
const BROWSER_CLOSE_TIMEOUT_MS = 5_000;

/** Too many captures already waiting: callers should answer 503 and let the client retry. */
export class ScreenshotBusyError extends Error {
  readonly status = 503;
  constructor(queued: number) {
    super(`Screenshot service is busy (${queued} captures already queued); please retry shortly`);
    this.name = 'ScreenshotBusyError';
  }
}

export class ScreenshotTimeoutError extends Error {
  readonly status = 504;
  constructor(ms: number) {
    super(`Screenshot capture did not finish within ${ms}ms`);
    this.name = 'ScreenshotTimeoutError';
  }
}

/** Per-capture bookkeeping: the browser it used and the contexts it opened (closed on timeout). */
interface CaptureLease {
  browser: Browser | null;
  contexts: Set<BrowserContext>;
}
const DEFAULT_LIVE_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const DEFAULT_LIVE_CACHE_TTL_MS = 10 * 60_000;

const DETERMINISTIC_CAPTURE_CSS = `
  html, body { scroll-behavior: auto !important; }
  astro-dev-toolbar { display: none !important; visibility: hidden !important; opacity: 0 !important; pointer-events: none !important; }
  *, *::before, *::after {
    content-visibility: visible !important;
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
  /** Maximum concurrent browser pages across all captures (default: 2). */
  maxConcurrency?: number;
  /** Byte budget for LRU-cached Live site compressed captures (default: 24 MB). */
  liveCacheMaxBytes?: number;
  /** TTL for cached Live site captures (default: 10 minutes). */
  liveCacheTtlMs?: number;
  /** Max captures waiting for a slot before new ones are rejected with ScreenshotBusyError (default 16). */
  maxQueue?: number;
  /** Deadline per capture including queue wait (default 60s). */
  captureDeadlineMs?: number;
  /** Relaunch Chromium after this many captures to bound leaks (default 200). */
  recycleAfterCaptures?: number;
  /** Time source for deadlines, idle close, launch/close bounds and cache TTLs (default: real time). */
  clock?: Clock;
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
    private readonly clock: Clock,
  ) {}

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this.clock.now() > entry.expiresAt) {
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

    this.map.set(key, { value, bytes, expiresAt: this.clock.now() + this.ttlMs });
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
  private idleTimer: TimerHandle | null = null;
  private readonly clock: Clock;
  private readonly maxQueue: number;
  private readonly captureDeadlineMs: number;
  private readonly recycleAfterCaptures: number;
  private activeSlots = 0;
  /** Waiters are granted a slot directly by the releasing capture (no window for queue-jumping). */
  private readonly waitQueue: Array<() => void> = [];
  private closed = false;
  private capturesOnBrowser = 0;
  private browserLeases = new Map<Browser, number>();
  private retiredBrowsers = new Set<Browser>();
  /** Counters for tests/metrics. */
  readonly stats = { timeouts: 0, rejectedBusy: 0, recycles: 0 };

  private readonly liveCache: ByteLruCache<CompressedCapture>;

  constructor(opts: ScreenshotServiceOptions = {}) {
    this.clock = opts.clock ?? realClock;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.settleWaitMs = opts.settleWaitMs ?? DEFAULT_SETTLE_WAIT_MS;
    this.maxConcurrency = Math.max(1, opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    this.maxQueue = Math.max(0, opts.maxQueue ?? DEFAULT_MAX_QUEUE);
    this.captureDeadlineMs = Math.max(1, opts.captureDeadlineMs ?? DEFAULT_CAPTURE_DEADLINE_MS);
    this.recycleAfterCaptures = Math.max(1, opts.recycleAfterCaptures ?? DEFAULT_RECYCLE_AFTER_CAPTURES);
    this.liveCache = new ByteLruCache<CompressedCapture>(
      opts.liveCacheMaxBytes ?? DEFAULT_LIVE_CACHE_MAX_BYTES,
      32,
      opts.liveCacheTtlMs ?? DEFAULT_LIVE_CACHE_TTL_MS,
      this.clock,
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
      this.clock.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleIdleClose(): void {
    this.clearIdleTimer();
    if (this.closed || !this.browser || this.activeSlots > 0 || this.idleTimeoutMs <= 0) {
      return;
    }
    // realClock timers are unref'd: a warm idle browser never keeps the process alive.
    this.idleTimer = this.clock.setTimeout(() => {
      this.idleTimer = null;
      if (this.activeSlots === 0 && this.browser) {
        void this.closeBrowser();
      }
    }, this.idleTimeoutMs);
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) {
      return this.browser;
    }
    this.browser = null;

    if (!this.launchPromise) {
      let launchTimer: TimerHandle | null = null;
      let timedOut = false;
      const rawLaunch = this.launchBrowser();
      rawLaunch
        .then((b) => {
          if (timedOut || this.closed) {
            void b.close().catch((err) => ignore(err, 'screenshot: closing late-launched browser failed', {}, 'debug'));
          }
        })
        .catch((err) => ignore(err, 'screenshot: Chromium launch failed', {}, 'debug')); // surfaced via the race below
      const timeoutPromise = new Promise<never>((_, reject) => {
        launchTimer = this.clock.setTimeout(() => {
          timedOut = true;
          reject(new Error('Timed out launching Chromium browser after 30s'));
        }, 30_000);
      });
      this.launchPromise = Promise.race([rawLaunch, timeoutPromise])
        .then((b) => {
          if (this.closed) {
            void b.close().catch((err) => ignore(err, 'screenshot: closing browser after shutdown failed', {}, 'debug'));
            throw new Error('ScreenshotService has been closed');
          }
          this.browser = b;
          this.capturesOnBrowser = 0;
          b.on('disconnected', () => {
            if (this.browser === b) {
              this.browser = null;
              this.clearIdleTimer();
            }
          });
          return b;
        })
        .finally(() => {
          this.clock.clearTimeout(launchTimer);
          this.launchPromise = null;
        });
    }

    return this.launchPromise;
  }

  private async closeBrowser(): Promise<void> {
    this.clearIdleTimer();
    const b = this.browser;
    this.browser = null;
    if (b) await this.closeBrowserBounded(b);
  }

  /** browser.close() can itself hang on a wedged Chromium: never wait more than a few seconds. */
  private async closeBrowserBounded(b: Browser): Promise<void> {
    let timer: TimerHandle | null = null;
    await Promise.race([
      b.close().catch((err) => ignore(err, 'screenshot: closing browser failed', {}, 'debug')),
      new Promise<void>((resolve) => {
        timer = this.clock.setTimeout(() => {
          logger.warn('screenshot: browser close timed out; abandoning it');
          resolve();
        }, BROWSER_CLOSE_TIMEOUT_MS);
      }),
    ]);
    this.clock.clearTimeout(timer);
  }

  /** Stops handing `b` to new captures; it is closed once its in-flight captures finish (or now). */
  private retireBrowser(b: Browser, reason: string, force = false): void {
    if (this.browser === b) {
      this.browser = null;
      this.capturesOnBrowser = 0;
    }
    if (this.retiredBrowsers.has(b) && !force) return;
    this.retiredBrowsers.add(b);
    this.stats.recycles += 1;
    logger.info('screenshot: recycling Chromium', { reason });
    if (force || (this.browserLeases.get(b) ?? 0) === 0) {
      this.retiredBrowsers.delete(b);
      void this.closeBrowserBounded(b);
    }
  }

  private async leaseBrowser(lease: CaptureLease): Promise<Browser> {
    let b = await this.ensureBrowser();
    if (this.capturesOnBrowser >= this.recycleAfterCaptures) {
      this.retireBrowser(b, `served ${this.capturesOnBrowser} captures`);
      b = await this.ensureBrowser();
    }
    this.capturesOnBrowser += 1;
    this.browserLeases.set(b, (this.browserLeases.get(b) ?? 0) + 1);
    lease.browser = b;
    return b;
  }

  private releaseBrowser(lease: CaptureLease): void {
    const b = lease.browser;
    if (!b) return;
    lease.browser = null;
    const n = (this.browserLeases.get(b) ?? 1) - 1;
    if (n <= 0) {
      this.browserLeases.delete(b);
      if (this.retiredBrowsers.delete(b)) void this.closeBrowserBounded(b);
    } else {
      this.browserLeases.set(b, n);
    }
  }

  private async newLeasedContext(lease: CaptureLease, size: { width: number; height: number }): Promise<BrowserContext> {
    const browser = await this.leaseBrowser(lease);
    const context = await browser.newContext({
      viewport: size,
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
    });
    lease.contexts.add(context);
    return context;
  }

  private async closeContext(lease: CaptureLease, context: BrowserContext): Promise<void> {
    lease.contexts.delete(context);
    await context.close().catch((err) => ignore(err, 'screenshot: closing browser context failed', {}, 'debug'));
  }

  private acquireSlot(signal: AbortSignal | undefined, deadline: AbortSignal): Promise<void> {
    if (this.activeSlots < this.maxConcurrency) {
      this.activeSlots += 1;
      return Promise.resolve();
    }
    if (this.waitQueue.length >= this.maxQueue) {
      this.stats.rejectedBusy += 1;
      return Promise.reject(new ScreenshotBusyError(this.waitQueue.length));
    }
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
        deadline.removeEventListener('abort', onAbort);
      };
      // Called by releaseSlot(): the slot is transferred to us (activeSlots already counts it)
      const grant = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        const idx = this.waitQueue.indexOf(grant);
        if (idx !== -1) this.waitQueue.splice(idx, 1);
        const reason = deadline.aborted ? deadline.reason : signal?.reason;
        reject(reason instanceof Error ? reason : new Error('Screenshot request aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      deadline.addEventListener('abort', onAbort, { once: true });
      this.waitQueue.push(grant);
    });
  }

  private releaseSlot(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next(); // hand the slot over
      return;
    }
    this.activeSlots -= 1;
    if (this.activeSlots === 0) this.scheduleIdleClose();
  }

  /**
   * Runs one capture under a concurrency slot and a hard deadline covering the queue wait and all
   * browser work. On timeout the capture's contexts are closed and its browser is recycled: a
   * hung-but-connected Chromium must not pin slots forever.
   */
  private async withSlot<T>(fn: (lease: CaptureLease) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closed) {
      throw new Error('ScreenshotService has been closed');
    }
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('Screenshot request aborted');
    }
    const deadline = new AbortController();
    const deadlineMs = this.captureDeadlineMs;
    const timer = this.clock.setTimeout(() => deadline.abort(new ScreenshotTimeoutError(deadlineMs)), deadlineMs);
    try {
      await this.acquireSlot(signal, deadline.signal);
    } catch (err) {
      this.clock.clearTimeout(timer);
      if (err instanceof ScreenshotTimeoutError) this.stats.timeouts += 1;
      throw err;
    }
    const lease: CaptureLease = { browser: null, contexts: new Set() };
    try {
      if (this.closed) {
        throw new Error('ScreenshotService has been closed');
      }
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('Screenshot request aborted');
      }
      this.clearIdleTimer();
      const work = fn(lease);
      const timedOut = new Promise<never>((_, reject) => {
        const onDeadline = () => reject(deadline.signal.reason);
        if (deadline.signal.aborted) onDeadline();
        else deadline.signal.addEventListener('abort', onDeadline, { once: true });
      });
      try {
        return await Promise.race([work, timedOut]);
      } catch (err) {
        if (err instanceof ScreenshotTimeoutError) {
          this.stats.timeouts += 1;
          // The hung work keeps running detached; make sure its eventual rejection is observed
          work.catch((lateErr) => ignore(lateErr, 'screenshot: timed-out capture finished with an error', {}, 'debug'));
          logger.warn('screenshot: capture timed out; closing its contexts and recycling Chromium', {
            deadlineMs,
            contexts: lease.contexts.size,
          });
          for (const ctx of lease.contexts) void this.closeContext(lease, ctx);
          if (lease.browser) this.retireBrowser(lease.browser, 'capture timed out', true);
        }
        throw err;
      }
    } finally {
      this.clock.clearTimeout(timer);
      this.releaseBrowser(lease);
      this.releaseSlot();
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
      .catch((err) => ignore(err, 'screenshot: prewarming Chromium failed', {}));
  }

  private async gotoAndReady(
    page: Page,
    url: string,
    timeoutMs: number,
    opts?: { loadAllImages?: boolean; maxImageY?: number },
  ): Promise<{ status: () => number } | null> {
    const loadAllImages = opts?.loadAllImages === true;
    const maxImageY = opts?.maxImageY ?? MAX_REVIEW_CAPTURE_HEIGHT;

    // Crucial for Blink/Chromium: <img loading="lazy"> latches Blink's internal
    // LazyLoadImageObserver deferred-paint flag at HTML parse/insertion time, causing
    // offscreen images to stay unpainted during fullPage / captureBeyondViewport even
    // after download completes. Intercepting <img> nodes at document_start via
    // addInitScript ensures Blink treats them as native eager + sync-decoded from birth.
    if (loadAllImages && typeof (page as { addInitScript?: unknown }).addInitScript === 'function') {
      await page
        .addInitScript((cssText: string) => {
          const g = globalThis as unknown as {
            MutationObserver?: new (
              cb: (muts: Array<{ addedNodes: Iterable<unknown>; target?: unknown }>) => void,
            ) => {
              observe: (target: unknown, opts: Record<string, unknown>) => void;
              disconnect?: () => void;
            };
            document?: {
              documentElement?: { appendChild?: (n: unknown) => void };
              head?: { appendChild?: (n: unknown) => void };
              createElement?: (tag: string) => { textContent?: string };
            };
          };
          const injectCss = () => {
            const root = g.document?.head || g.document?.documentElement;
            if (!root || !g.document?.createElement) return false;
            const style = g.document.createElement('style');
            style.textContent = cssText;
            root.appendChild?.(style);
            return true;
          };
          if (!injectCss() && g.MutationObserver && g.document) {
            const cssObs = new g.MutationObserver(() => {
              if (injectCss()) cssObs.disconnect?.();
            });
            cssObs.observe(g.document, { childList: true });
          }

          type NodeLike = {
            tagName?: string;
            loading?: string;
            decoding?: string;
            getAttribute?: (k: string) => string | null;
            setAttribute?: (k: string, v: string) => void;
            removeAttribute?: (k: string) => void;
            querySelectorAll?: (sel: string) => Iterable<NodeLike>;
          };
          const eagerizeImg = (img: NodeLike) => {
            const dataSrc = img.getAttribute?.('data-src');
            if (dataSrc && !img.getAttribute?.('src')) {
              img.setAttribute?.('src', dataSrc);
            }
            const dataSrcset = img.getAttribute?.('data-srcset');
            if (dataSrcset && !img.getAttribute?.('srcset')) {
              img.setAttribute?.('srcset', dataSrcset);
            }
            if (img.getAttribute?.('loading') || img.loading === 'lazy') {
              img.loading = 'eager';
              img.removeAttribute?.('loading');
            }
            img.decoding = 'sync';
            img.setAttribute?.('decoding', 'sync');
          };
          const scanNode = (node: NodeLike | null | undefined) => {
            if (!node) return;
            if (node.tagName === 'IMG') eagerizeImg(node);
            if (typeof node.querySelectorAll === 'function') {
              for (const img of node.querySelectorAll('img')) {
                eagerizeImg(img);
              }
            }
          };
          if (g.MutationObserver && g.document) {
            new g.MutationObserver((muts) => {
              for (const m of muts) {
                if (m.target && (m.target as NodeLike).tagName === 'IMG') {
                  eagerizeImg(m.target as NodeLike);
                }
                for (const n of m.addedNodes) {
                  scanNode(n as NodeLike);
                }
              }
            }).observe(g.document, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ['loading', 'data-src', 'data-srcset'],
            });
          }
        }, DETERMINISTIC_CAPTURE_CSS)
        .catch((err) => ignore(err, 'screenshot: addInitScript failed', { url }, 'debug'));
    }

    const res = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });

    if (typeof (page as { addStyleTag?: unknown }).addStyleTag === 'function') {
      await page
        .addStyleTag({ content: DETERMINISTIC_CAPTURE_CSS })
        .catch((err) => ignore(err, 'screenshot: addStyleTag failed', { url }, 'debug'));
      const readiness = await page
        .evaluate(
          async ({ eagerAll, maxY }: { eagerAll: boolean; maxY: number }) => {
            type ImgLike = {
              src?: string;
              currentSrc?: string;
              srcset?: string;
              complete?: boolean;
              naturalWidth?: number;
              loading?: string;
              decoding?: string;
              getAttribute?: (k: string) => string | null;
              setAttribute?: (k: string, v: string) => void;
              removeAttribute?: (k: string) => void;
              getBoundingClientRect?: () => { top: number };
              addEventListener?: (ev: string, cb: () => void, opts?: { once?: boolean }) => void;
              decode?: () => Promise<void>;
            };
            type FontFaceLike = { status?: string; loaded?: Promise<unknown> };
            const g = globalThis as unknown as {
              innerHeight?: number;
              scrollTo?: (x: number, y: number) => void;
              getComputedStyle?: (el: unknown) => { backgroundImage?: string };
              Image?: new () => ImgLike;
              requestAnimationFrame?: (cb: () => void) => number;
              document?: {
                body?: { scrollHeight?: number; offsetHeight?: number };
                documentElement?: { scrollHeight?: number; offsetHeight?: number };
                fonts?: {
                  ready?: Promise<unknown>;
                  [Symbol.iterator]?: () => Iterator<FontFaceLike>;
                };
                images?: Iterable<ImgLike>;
                querySelectorAll?: (sel: string) => Iterable<{
                  loading?: string;
                  removeAttribute?: (k: string) => void;
                  getBoundingClientRect?: () => { top: number };
                }>;
              };
            };
            const doc = g.document;
            // Browser-side failures (font/image decode) are counted and reported back to Node
            const failures = { fonts: 0, images: 0 };
            if (!doc) return failures;

            const nextFrame = () =>
              new Promise<void>((resolve) => {
                let done = false;
                const finish = () => {
                  if (!done) {
                    done = true;
                    resolve();
                  }
                };
                const t = setTimeout(finish, 24);
                if (typeof g.requestAnimationFrame === 'function') {
                  g.requestAnimationFrame(() => {
                    clearTimeout(t);
                    finish();
                  });
                }
              });

            const promoteLazyElements = () => {
              if (doc.images) {
                for (const img of doc.images) {
                  const dataSrc = img.getAttribute?.('data-src');
                  if (dataSrc && !img.getAttribute?.('src')) {
                    img.setAttribute?.('src', dataSrc);
                  }
                  const dataSrcset = img.getAttribute?.('data-srcset');
                  if (dataSrcset && !img.getAttribute?.('srcset')) {
                    img.setAttribute?.('srcset', dataSrcset);
                  }
                  const top =
                    typeof img.getBoundingClientRect === 'function'
                      ? img.getBoundingClientRect().top
                      : 0;
                  if (top > maxY) continue;
                  if (eagerAll && (img.loading === 'lazy' || img.getAttribute?.('loading') === 'lazy')) {
                    img.loading = 'eager';
                    img.decoding = 'sync';
                    img.setAttribute?.('loading', 'eager');
                    img.removeAttribute?.('loading');
                  } else if (eagerAll && img.decoding === 'async') {
                    img.decoding = 'sync';
                  }
                }
              }
              if (eagerAll && typeof doc.querySelectorAll === 'function') {
                for (const frame of doc.querySelectorAll('iframe[loading="lazy"]')) {
                  const top =
                    typeof frame.getBoundingClientRect === 'function'
                      ? frame.getBoundingClientRect().top
                      : 0;
                  if (top > maxY) continue;
                  frame.loading = 'eager';
                  frame.removeAttribute?.('loading');
                }
              }
            };

            // Stage 1: Promote deferred/lazy attributes immediately
            promoteLazyElements();

            // Stage 2: Fast viewport scroll sweep (0 -> maxY -> 0) for full-page captures so
            // IntersectionObservers (Astro client:visible islands, scroll reveals), <picture>/srcset,
            // CSS background-images, and @font-face unicode-range subsets across the full page activate.
            if (eagerAll && typeof g.scrollTo === 'function') {
              const totalH = Math.min(
                Math.max(doc.body?.scrollHeight ?? 0, doc.documentElement?.scrollHeight ?? 0),
                maxY,
              );
              const step = Math.max(400, g.innerHeight || 800);
              if (totalH > step) {
                for (let y = step; y < totalH; y += step) {
                  g.scrollTo(0, y);
                  await nextFrame();
                }
                g.scrollTo(0, Math.max(0, totalH - step));
                await nextFrame();
                g.scrollTo(0, 0);
                void doc.documentElement?.offsetHeight;
                await nextFrame();
                // Promote any newly mounted <img> elements from hydrated Astro client:visible islands
                promoteLazyElements();
              }
            }

            // Stage 3: Force layout so all @font-face subsets transition from 'unloaded' -> 'loading',
            // then await fonts + all in-range <img> elements (load + decode) + CSS background-images.
            void doc.body?.offsetHeight;

            const waitFonts = async () => {
              if (!doc.fonts) return;
              if (doc.fonts.ready) {
                await doc.fonts.ready.catch(() => {
                  failures.fonts += 1;
                });
              }
              if (typeof doc.fonts[Symbol.iterator] === 'function') {
                const activeFontLoads: Array<Promise<unknown>> = [];
                for (const face of doc.fonts as Iterable<FontFaceLike>) {
                  if (face.status === 'loading' && face.loaded) {
                    activeFontLoads.push(
                      face.loaded.catch(() => {
                        failures.fonts += 1;
                      }),
                    );
                  }
                }
                if (activeFontLoads.length > 0) {
                  await Promise.allSettled(activeFontLoads);
                }
              }
            };

            const imgPromises: Array<Promise<unknown>> = [];
            if (doc.images) {
              for (const img of doc.images) {
                if (!img.currentSrc && !img.src && !img.srcset) continue;
                const rectTop =
                  typeof img.getBoundingClientRect === 'function'
                    ? img.getBoundingClientRect().top
                    : 0;
                if (rectTop > maxY) continue;
                if (!eagerAll && img.loading === 'lazy') continue;

                const waitImg = async () => {
                  if (!img.complete) {
                    await new Promise<void>((resolve) => {
                      if (typeof img.addEventListener !== 'function') {
                        resolve();
                        return;
                      }
                      let settled = false;
                      const done = () => {
                        if (!settled) {
                          settled = true;
                          resolve();
                        }
                      };
                      img.addEventListener('load', done, { once: true });
                      img.addEventListener('error', done, { once: true });
                      // Guard against race if img.complete flipped synchronously before listener registration
                      if (img.complete) done();
                    });
                  }
                  if (typeof img.decode === 'function' && (img.naturalWidth ?? 0) > 0) {
                    await img.decode().catch(() => {
                      failures.images += 1;
                    });
                  }
                };
                imgPromises.push(waitImg());
              }
            }

            // Preload & decode CSS background-image URLs on visible/in-range elements
            if (
              eagerAll &&
              typeof doc.querySelectorAll === 'function' &&
              typeof g.getComputedStyle === 'function' &&
              typeof g.Image === 'function'
            ) {
              const bgUrls = new Set<string>();
              let scanned = 0;
              for (const el of doc.querySelectorAll('*')) {
                if (++scanned > 1500 || bgUrls.size >= 24) break;
                const top =
                  typeof el.getBoundingClientRect === 'function'
                    ? el.getBoundingClientRect().top
                    : 0;
                if (top > maxY) continue;
                const bg = g.getComputedStyle(el).backgroundImage || '';
                if (!bg || bg === 'none' || !bg.includes('url(')) continue;
                const matches = bg.matchAll(/url\((['"]?)(.*?)\1\)/g);
                for (const m of matches) {
                  const u = m[2]?.trim();
                  if (u && !u.startsWith('data:')) {
                    bgUrls.add(u);
                  }
                }
              }
              const ImageCtor = g.Image;
              for (const u of bgUrls) {
                imgPromises.push(
                  (async () => {
                    const bgImg = new ImageCtor();
                    bgImg.decoding = 'sync';
                    bgImg.src = u;
                    if (!bgImg.complete) {
                      await new Promise<void>((resolve) => {
                        let settled = false;
                        const done = () => {
                          if (!settled) {
                            settled = true;
                            resolve();
                          }
                        };
                        bgImg.addEventListener?.('load', done, { once: true });
                        bgImg.addEventListener?.('error', done, { once: true });
                        if (bgImg.complete) done();
                      });
                    }
                    if (typeof bgImg.decode === 'function' && (bgImg.naturalWidth ?? 0) > 0) {
                      await bgImg.decode().catch(() => {
                        failures.images += 1;
                      });
                    }
                  })(),
                );
              }
            }

            const readinessCeilingMs = eagerAll ? 8000 : 2500;
            await Promise.race([
              Promise.all([waitFonts(), Promise.allSettled(imgPromises)]),
              new Promise((r) => setTimeout(r, readinessCeilingMs)),
            ]);

            // Ensure scroll is pinned at top and wait two frames for compositor texture upload
            if (eagerAll && typeof g.scrollTo === 'function') {
              g.scrollTo(0, 0);
            }
            await nextFrame();
            await nextFrame();
            return failures;
          },
          { eagerAll: loadAllImages, maxY: maxImageY },
        )
        .catch((err) => {
          ignore(err, 'screenshot: readiness script failed; capturing anyway', { url }, 'debug');
          return null;
        });
      if (readiness && (readiness.fonts > 0 || readiness.images > 0)) {
        logger.debug('screenshot: some fonts/images failed to load before capture', { url, ...readiness });
      }
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
        let cdpTimer: TimerHandle | null = null;
        try {
          const result = (await Promise.race([
            cdp.send('Page.captureScreenshot', {
              format: 'webp',
              quality: REVIEW_IMAGE_QUALITY,
              captureBeyondViewport: true,
              clip: { x: 0, y: 0, width, height: captureHeight, scale: 1 },
            }),
            new Promise<never>((_, reject) => {
              cdpTimer = this.clock.setTimeout(
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
          this.clock.clearTimeout(cdpTimer);
          await cdp.detach().catch((err) => ignore(err, 'screenshot: CDP detach failed', {}, 'debug'));
        }
      } catch (err) {
        // Fall back to Playwright JPEG screenshot below
        ignore(err, 'screenshot: CDP WebP capture failed; falling back to JPEG', {}, 'debug');
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

    return this.withSlot(async (lease) => {
      const size = VIEWPORT_SIZES[req.viewport];
      const context = await this.newLeasedContext(lease, size);
      try {
        const page = await context.newPage();
        await this.gotoAndReady(page, req.url, 25_000, {
          loadAllImages: Boolean(req.fullPage),
          maxImageY: MAX_FULL_PAGE_HEIGHT,
        });
        if (req.fullPage) {
          let captureHeight = size.height;
          if (typeof page.evaluate === 'function') {
            const docHeight = await orDefault(
              page.evaluate<number>(
                'Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement ? document.documentElement.scrollHeight : 0)',
              ),
              size.height,
              'screenshot: measuring document height failed; using viewport height',
              {},
              'debug',
            );
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
        await this.closeContext(lease, context);
      }
    });
  }

  private async captureDraftFull(
    draftUrl: string,
    size: { width: number; height: number },
    _draftFiles: string[],
    _mergedFromLiveFiles: string[],
    fallbackTitle: string,
    signal?: AbortSignal,
  ): Promise<{ title: string; capture: CompressedCapture; highlights: VisualDiffHighlightDto[] } | null> {
    return this.withSlot(async (lease) => {
      const context = await this.newLeasedContext(lease, size);
      try {
        const page = await context.newPage();
        await this.gotoAndReady(page, draftUrl, 20_000, {
          loadAllImages: true,
          maxImageY: MAX_REVIEW_CAPTURE_HEIGHT,
        });
        const title =
          (await orDefault(page.title(), '', 'screenshot: reading page title failed; using fallback', { draftUrl }, 'debug')) ||
          fallbackTitle;

        let captureHeight = size.height;
        if (typeof page.evaluate === 'function') {
          const docHeight = await orDefault(
            page.evaluate<number>(
              'Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement ? document.documentElement.scrollHeight : 0)',
            ),
            size.height,
            'screenshot: measuring document height failed; using viewport height',
            {},
            'debug',
          );
          captureHeight = Math.min(
            Math.max(docHeight || size.height, size.height),
            MAX_REVIEW_CAPTURE_HEIGHT,
          );
        }

        const capture = await this.captureFullPageCompressed(context, page, size.width, captureHeight);
        return { title, capture, highlights: [] };
      } catch (err) {
        // Review pages render a placeholder for a failed draft capture
        ignore(err, 'screenshot: draft capture failed', { url: draftUrl });
        return null;
      } finally {
        await this.closeContext(lease, context);
      }
    }, signal).catch((err) => this.nullOnTimeout(err, draftUrl));
  }

  /** Review captures degrade to "no screenshot" on timeout; busy/abort/closed still propagate. */
  private nullOnTimeout(err: unknown, url: string): null {
    if (err instanceof ScreenshotTimeoutError) {
      ignore(err, 'screenshot: review capture timed out', { url });
      return null;
    }
    throw err;
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

    return this.withSlot(async (lease) => {
      const afterWait = this.liveCache.get(cacheKey);
      if (afterWait) return afterWait;

      const context = await this.newLeasedContext(lease, size);
      try {
        const livePage = await context.newPage();
        const liveRes = await this.gotoAndReady(livePage, liveUrl, 15_000, {
          loadAllImages: true,
          maxImageY: MAX_REVIEW_CAPTURE_HEIGHT,
        });
        if (liveRes && typeof liveRes.status === 'function' && liveRes.status() >= 400) {
          return null;
        }
        let liveHeight = size.height;
        if (typeof livePage.evaluate === 'function') {
          const liveDocHeight = await orDefault(
            livePage.evaluate<number>(
              'Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement ? document.documentElement.scrollHeight : 0)',
            ),
            size.height,
            'screenshot: measuring live document height failed; using viewport height',
            {},
            'debug',
          );
          liveHeight = Math.min(
            Math.max(liveDocHeight || size.height, size.height),
            MAX_REVIEW_CAPTURE_HEIGHT,
          );
        }
        const captured = await this.captureFullPageCompressed(context, livePage, size.width, liveHeight);
        this.liveCache.set(cacheKey, captured, captured.byteLength);
        return captured;
      } catch (err) {
        ignore(err, 'screenshot: live site capture failed', { url: liveUrl }, 'debug');
        return null;
      } finally {
        await this.closeContext(lease, context);
      }
    }, signal).catch((err) => this.nullOnTimeout(err, liveUrl));
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
    // Wake every waiter: each is granted a slot, sees `closed`, throws, and releases it again
    while (this.waitQueue.length > 0) {
      this.activeSlots += 1;
      this.waitQueue.shift()?.();
    }
    if (this.launchPromise) {
      const b = await this.launchPromise.catch((err) => {
        ignore(err, 'screenshot: pending launch failed during close', {}, 'debug');
        return null;
      });
      if (b) await this.closeBrowserBounded(b);
    }
    for (const b of this.retiredBrowsers) void this.closeBrowserBounded(b);
    this.retiredBrowsers.clear();
    await this.closeBrowser();
  }
}
