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
        .catch(() => {});
    }

    const res = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });

    if (typeof (page as { addStyleTag?: unknown }).addStyleTag === 'function') {
      await page.addStyleTag({ content: DETERMINISTIC_CAPTURE_CSS }).catch(() => {});
      await page
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
            if (!doc) return;

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
                await doc.fonts.ready.catch(() => {});
              }
              if (typeof doc.fonts[Symbol.iterator] === 'function') {
                const activeFontLoads: Array<Promise<unknown>> = [];
                for (const face of doc.fonts as Iterable<FontFaceLike>) {
                  if (face.status === 'loading' && face.loaded) {
                    activeFontLoads.push(face.loaded.catch(() => {}));
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
                    await img.decode().catch(() => {});
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
                      await bgImg.decode().catch(() => {});
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
          },
          { eagerAll: loadAllImages, maxY: maxImageY },
        )
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
        await this.gotoAndReady(page, req.url, 25_000, {
          loadAllImages: Boolean(req.fullPage),
          maxImageY: MAX_FULL_PAGE_HEIGHT,
        });
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
    _draftFiles: string[],
    _mergedFromLiveFiles: string[],
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
        await this.gotoAndReady(page, draftUrl, 20_000, {
          loadAllImages: true,
          maxImageY: MAX_REVIEW_CAPTURE_HEIGHT,
        });
        const title = (await page.title().catch(() => '')) || fallbackTitle;

        let captureHeight = size.height;
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
        }

        const capture = await this.captureFullPageCompressed(context, page, size.width, captureHeight);
        return { title, capture, highlights: [] };
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
        const liveRes = await this.gotoAndReady(livePage, liveUrl, 15_000, {
          loadAllImages: true,
          maxImageY: MAX_REVIEW_CAPTURE_HEIGHT,
        });
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
