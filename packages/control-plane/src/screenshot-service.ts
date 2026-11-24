import { chromium, type Browser } from 'playwright';

export type ScreenshotViewport = 'desktop' | 'mobile';

export const VIEWPORT_SIZES: Record<ScreenshotViewport, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

export interface ScreenshotRequest {
  url: string;
  viewport: ScreenshotViewport;
}

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
