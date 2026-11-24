import type { VisualDiffHighlightDto, VisualDiffPageDto } from '@halley/shared';
import { chromium, type Browser } from 'playwright';

export type ScreenshotViewport = 'desktop' | 'mobile';

export const VIEWPORT_SIZES: Record<ScreenshotViewport, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

export interface ScreenshotRequest {
  url: string;
  viewport: ScreenshotViewport;
  fullPage?: boolean;
}

const MAX_FULL_PAGE_HEIGHT = 3600;

export interface ScreenshotResult {
  png: Buffer;
  width: number;
  height: number;
}

export interface ScreenshotServiceOptions {
  /** Idle duration before closing the warm Chromium browser (default: 1 hour). */
  idleTimeoutMs?: number;
  /** Optional custom browser launcher for tests. */
  launchBrowser?: () => Promise<Browser>;
  /** Extra settle wait after networkidle (ms, default: 400). */
  settleWaitMs?: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60_000; // 1 hour

export class ScreenshotService {
  private readonly idleTimeoutMs: number;
  private readonly launchBrowser: () => Promise<Browser>;
  private readonly settleWaitMs: number;

  private browser: Browser | null = null;
  private launchPromise: Promise<Browser> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private inFlight = 0;
  private closed = false;

  constructor(opts: ScreenshotServiceOptions = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.settleWaitMs = opts.settleWaitMs ?? 400;
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
    if (this.closed || !this.browser || this.inFlight > 0 || this.idleTimeoutMs <= 0) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.inFlight === 0 && this.browser) {
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

  /**
   * Capture a screenshot using the shared warm Chromium browser.
   * Calls are serialized so only one page renders at a time across all workspaces,
   * each in an isolated BrowserContext that is closed immediately afterward.
   */
  capture(req: ScreenshotRequest): Promise<ScreenshotResult> {
    if (this.closed) {
      return Promise.reject(new Error('ScreenshotService has been closed'));
    }

    const run = async (): Promise<ScreenshotResult> => {
      if (this.closed) {
        throw new Error('ScreenshotService has been closed');
      }
      this.inFlight += 1;
      this.clearIdleTimer();

      const size = VIEWPORT_SIZES[req.viewport];
      try {
        const browser = await this.ensureBrowser();
        const context = await browser.newContext({ viewport: size });
        try {
          const page = await context.newPage();
          await page.goto(req.url, { waitUntil: 'networkidle', timeout: 25_000 });
          if (this.settleWaitMs > 0) {
            await page.waitForTimeout(this.settleWaitMs);
          }
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
            const png = await page.screenshot({
              type: 'png',
              fullPage: true,
              clip: { x: 0, y: 0, width: size.width, height: captureHeight },
            });
            return { png, width: size.width, height: captureHeight };
          }
          const png = await page.screenshot({ type: 'png', fullPage: false });
          return { png, width: size.width, height: size.height };
        } finally {
          await context.close().catch(() => {});
        }
      } finally {
        this.inFlight -= 1;
        if (this.inFlight === 0) {
          this.scheduleIdleClose();
        }
      }
    };

    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Captures Live vs Draft review screenshots with dual-color DOM highlights
   * (amber = Draft, teal = recently merged from Live) using the shared warm Chromium browser.
   */
  captureLiveVsDraftPages(opts: {
    routes: string[];
    draftFiles: string[];
    mergedFromLiveFiles: string[];
    draftBaseUrl: string;
    liveBaseUrl?: string | null;
    liveTimestamp: string;
  }): Promise<VisualDiffPageDto[]> {
    if (this.closed) {
      return Promise.reject(new Error('ScreenshotService has been closed'));
    }

    const run = async (): Promise<VisualDiffPageDto[]> => {
      const uniqueRoutes = [
        ...new Set(opts.routes.map((r) => (r.startsWith('/') ? r : `/${r}`))),
      ].slice(0, 4);
      if (uniqueRoutes.length === 0) return [];

      this.inFlight += 1;
      this.clearIdleTimer();

      const draftSet = new Set(opts.draftFiles);
      const mergedSet = new Set(opts.mergedFromLiveFiles);
      const pages: VisualDiffPageDto[] = [];

      try {
        const browser = await this.ensureBrowser();
        for (const route of uniqueRoutes) {
          const draftUrl = `${opts.draftBaseUrl.replace(/\/$/, '')}${route === '/' ? '/' : route}`;
          const liveUrl = opts.liveBaseUrl
            ? `${opts.liveBaseUrl.replace(/\/$/, '')}${route === '/' ? '/' : route}`
            : null;

          let draftScreenshotDataUrl: string | undefined;
          let liveScreenshotDataUrl: string | undefined;
          let highlights: VisualDiffHighlightDto[] = [];
          let title = route === '/' ? 'Homepage' : route;

          const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
          try {
            const page = await context.newPage();
            await page.goto(draftUrl, { waitUntil: 'networkidle', timeout: 20_000 });
            if (this.settleWaitMs > 0) await page.waitForTimeout(this.settleWaitMs);
            title = (await page.title()) || title;

            highlights = await page.evaluate(
              ({ dFiles, mFiles }: { dFiles: string[]; mFiles: string[] }) => {
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
                  if (rect.width < 8 || rect.height < 8 || rect.top > 860 || rect.bottom < 0) continue;
                  out.push({
                    x: Math.round((rect.left / 1280) * 1000) / 10,
                    y: Math.round((rect.top / 860) * 1000) / 10,
                    width: Math.round((rect.width / 1280) * 1000) / 10,
                    height: Math.round((rect.height / 860) * 1000) / 10,
                    kind: isDraft ? 'draft' : 'merged_from_live',
                    file: src,
                  });
                  if (out.length >= 16) break;
                }
                return out;
              },
              { dFiles: [...draftSet], mFiles: [...mergedSet] },
            );

            const jpg = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: false });
            draftScreenshotDataUrl = `data:image/jpeg;base64,${jpg.toString('base64')}`;

            if (liveUrl) {
              const livePage = await context.newPage();
              await livePage.goto(liveUrl, { waitUntil: 'networkidle', timeout: 20_000 });
              if (this.settleWaitMs > 0) await livePage.waitForTimeout(this.settleWaitMs);
              const liveJpg = await livePage.screenshot({ type: 'jpeg', quality: 80, fullPage: false });
              liveScreenshotDataUrl = `data:image/jpeg;base64,${liveJpg.toString('base64')}`;
            }
          } catch {
            // best-effort screenshot
          } finally {
            await context.close().catch(() => {});
          }

          pages.push({
            route,
            title,
            liveScreenshotDataUrl,
            draftScreenshotDataUrl,
            highlights,
            liveTimestamp: opts.liveTimestamp,
          });
        }
        return pages;
      } finally {
        this.inFlight -= 1;
        if (this.inFlight === 0) {
          this.scheduleIdleClose();
        }
      }
    };

    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  isBrowserRunning(): boolean {
    return Boolean(this.browser?.isConnected());
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearIdleTimer();
    if (this.launchPromise) {
      const b = await this.launchPromise.catch(() => null);
      if (b) await b.close().catch(() => {});
    }
    await this.closeBrowser();
  }
}
