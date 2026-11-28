import { EventEmitter } from 'node:events';
import type { Browser } from 'playwright';
import { describe, expect, it } from 'vitest';
import type { Clock } from '../src/clock.js';
import { ScreenshotBusyError, ScreenshotService, ScreenshotTimeoutError } from '../src/screenshot-service.js';
import { FakeClock } from './helpers/fake-clock.js';

/** Lets pending promise continuations (and setImmediate-based fake-clock steps) run. */
const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

function createFakeBrowser(opts?: {
  gotoDelayMs?: number;
  onActiveChange?: (delta: number) => void;
  /** goto never settles while the browser stays "connected" (a wedged Chromium). */
  hangGoto?: () => boolean;
  /** Clock for gotoDelayMs (default: real timers). */
  clock?: Clock;
}) {
  const emitter = new EventEmitter();
  let connected = true;
  let contextsCreated = 0;
  let contextsClosed = 0;
  let closeCalls = 0;
  const visitedUrls: string[] = [];
  const screenshotCalls: Array<Record<string, unknown>> = [];
  const contextOptions: Array<Record<string, unknown>> = [];

  const browser = Object.assign(emitter, {
    isConnected: () => connected,
    newContext: async (ctxOpts?: Record<string, unknown>) => {
      contextsCreated += 1;
      if (ctxOpts) contextOptions.push(ctxOpts);
      return {
        newPage: async () => ({
          goto: async (url: string) => {
            opts?.onActiveChange?.(1);
            visitedUrls.push(url);
            if (opts?.hangGoto?.()) {
              await new Promise(() => {});
            }
            if (opts?.gotoDelayMs) {
              if (opts.clock) await opts.clock.sleep(opts.gotoDelayMs);
              else await new Promise((r) => setTimeout(r, opts.gotoDelayMs));
            }
          },
          waitForTimeout: async () => {},
          screenshot: async (shotOpts?: Record<string, unknown>) => {
            if (shotOpts) screenshotCalls.push(shotOpts);
            return Buffer.from('fake-jpeg');
          },
        }),
        close: async () => {
          contextsClosed += 1;
          opts?.onActiveChange?.(-1);
        },
      };
    },
    close: async () => {
      closeCalls += 1;
      if (connected) {
        connected = false;
        emitter.emit('disconnected');
      }
    },
  });

  return {
    browser: browser as unknown as Browser,
    stats: () => ({
      connected,
      contextsCreated,
      contextsClosed,
      closeCalls,
      visitedUrls,
      screenshotCalls,
      contextOptions,
    }),
    simulateCrash: () => {
      connected = false;
      emitter.emit('disconnected');
    },
  };
}

describe('ScreenshotService', () => {
  it('reuses a single warm browser across calls with fresh BrowserContexts and respects maxConcurrency', async () => {
    let launchCount = 0;
    let active = 0;
    let maxActive = 0;
    let fakeRef: ReturnType<typeof createFakeBrowser> | null = null;

    const svc = new ScreenshotService({
      idleTimeoutMs: 60_000,
      settleWaitMs: 0,
      maxConcurrency: 2,
      launchBrowser: async () => {
        launchCount += 1;
        fakeRef = createFakeBrowser({
          gotoDelayMs: 30,
          onActiveChange: (d) => {
            active += d;
            if (active > maxActive) maxActive = active;
          },
        });
        return fakeRef.browser;
      },
    });

    try {
      const [r1, r2, r3] = await Promise.all([
        svc.capture({ url: 'http://ws-1:4321/p/s1/', viewport: 'desktop' }),
        svc.capture({ url: 'http://ws-2:4321/p/s2/about', viewport: 'mobile' }),
        svc.capture({ url: 'http://ws-3:4321/p/s3/contact', viewport: 'desktop' }),
      ]);

      expect(r1.width).toBe(1280);
      expect(r1.height).toBe(800);
      expect(r1.mimeType).toBe('image/jpeg');
      expect(r2.width).toBe(390);
      expect(r2.height).toBe(844);
      expect(r3.width).toBe(1280);
      expect(r1.data.toString()).toBe('fake-jpeg');
      expect(fakeRef!.stats().contextOptions[0]).toEqual({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
      });
      expect(launchCount).toBe(1);
      expect(maxActive).toBe(2);
      expect(svc.isBrowserRunning()).toBe(true);
      expect(fakeRef!.stats().contextsCreated).toBe(3);
      expect(fakeRef!.stats().contextsClosed).toBe(3);
    } finally {
      await svc.close();
    }
  });

  it('prewarms Chromium non-blockingly and auto-closes after idleTimeoutMs', async () => {
    let launchCount = 0;
    const fakes: Array<ReturnType<typeof createFakeBrowser>> = [];

    const clock = new FakeClock();
    const svc = new ScreenshotService({
      clock,
      idleTimeoutMs: 50,
      settleWaitMs: 0,
      launchBrowser: async () => {
        launchCount += 1;
        const fake = createFakeBrowser();
        fakes.push(fake);
        return fake.browser;
      },
    });

    try {
      svc.prewarm();
      await flush();
      expect(launchCount).toBe(1);
      expect(svc.isBrowserRunning()).toBe(true);

      await clock.advance(49);
      expect(svc.isBrowserRunning()).toBe(true);
      await clock.advance(1);
      expect(svc.isBrowserRunning()).toBe(false);
      expect(fakes[0]!.stats().closeCalls).toBe(1);
    } finally {
      await svc.close();
    }
  });

  it('auto-closes the warm browser after idleTimeoutMs and relaunches on the next request', async () => {
    let launchCount = 0;
    const fakes: Array<ReturnType<typeof createFakeBrowser>> = [];

    const clock = new FakeClock();
    const svc = new ScreenshotService({
      clock,
      idleTimeoutMs: 40,
      settleWaitMs: 0,
      launchBrowser: async () => {
        launchCount += 1;
        const fake = createFakeBrowser();
        fakes.push(fake);
        return fake.browser;
      },
    });

    try {
      await svc.capture({ url: 'http://ws-1:4321/p/s1/', viewport: 'desktop' });
      expect(launchCount).toBe(1);
      expect(svc.isBrowserRunning()).toBe(true);

      await clock.advance(39);
      expect(svc.isBrowserRunning()).toBe(true);
      await clock.advance(1);
      expect(svc.isBrowserRunning()).toBe(false);
      expect(fakes[0]!.stats().closeCalls).toBe(1);

      await svc.capture({ url: 'http://ws-1:4321/p/s1/about', viewport: 'mobile' });
      expect(launchCount).toBe(2);
      expect(svc.isBrowserRunning()).toBe(true);
    } finally {
      await svc.close();
    }
  });

  it('transparently relaunches if the warm browser crashes/disconnects', async () => {
    let launchCount = 0;
    const fakes: Array<ReturnType<typeof createFakeBrowser>> = [];

    const svc = new ScreenshotService({
      idleTimeoutMs: 60_000,
      settleWaitMs: 0,
      launchBrowser: async () => {
        launchCount += 1;
        const fake = createFakeBrowser();
        fakes.push(fake);
        return fake.browser;
      },
    });

    try {
      await svc.capture({ url: 'http://ws-1:4321/p/s1/', viewport: 'desktop' });
      expect(launchCount).toBe(1);

      fakes[0]!.simulateCrash();
      expect(svc.isBrowserRunning()).toBe(false);

      await svc.capture({ url: 'http://ws-1:4321/p/s1/', viewport: 'desktop' });
      expect(launchCount).toBe(2);
      expect(svc.isBrowserRunning()).toBe(true);
    } finally {
      await svc.close();
    }
  });

  it('supports fullPage screenshots clipped to a safe max height (3600px)', async () => {
    let capturedOpts: Record<string, unknown> | undefined;
    const svc = new ScreenshotService({
      idleTimeoutMs: 60_000,
      settleWaitMs: 0,
      launchBrowser: async () =>
        Object.assign(new EventEmitter(), {
          isConnected: () => true,
          newContext: async () => ({
            newPage: async () => ({
              goto: async () => {},
              waitForTimeout: async () => {},
              evaluate: async () => 5200,
              screenshot: async (opts: Record<string, unknown>) => {
                capturedOpts = opts;
                return Buffer.from('full-png');
              },
            }),
            close: async () => {},
          }),
          close: async () => {},
        }) as unknown as Browser,
    });

    try {
      const res = await svc.capture({
        url: 'http://ws-1:4321/p/s1/poetry',
        viewport: 'desktop',
        fullPage: true,
      });
      expect(res.width).toBe(1280);
      expect(res.height).toBe(3600);
      expect(res.mimeType).toBe('image/jpeg');
      expect(capturedOpts).toEqual({
        type: 'jpeg',
        quality: 80,
        fullPage: true,
        clip: { x: 0, y: 0, width: 1280, height: 3600 },
      });
    } finally {
      await svc.close();
    }
  });

  it('captures mobile and desktop Live vs Draft review screenshots up to 10000px via CDP WebP (with JPEG fallback) and caches Live captures per baseSha', async () => {
    const visitedUrls: string[] = [];
    const contextViewports: Array<{ width: number; height: number }> = [];
    const cdpCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const screenshotCalls: Array<Record<string, unknown>> = [];
    let enableCdp = true;

    const svc = new ScreenshotService({
      idleTimeoutMs: 60_000,
      settleWaitMs: 0,
      launchBrowser: async () =>
        Object.assign(new EventEmitter(), {
          isConnected: () => true,
          newContext: async (opts: { viewport: { width: number; height: number } }) => {
            contextViewports.push(opts.viewport);
            return {
              ...(enableCdp
                ? {
                    newCDPSession: async () => ({
                      send: async (method: string, params: Record<string, unknown>) => {
                        cdpCalls.push({ method, params });
                        return { data: Buffer.from('fake-webp').toString('base64') };
                      },
                      detach: async () => {},
                    }),
                  }
                : {}),
              newPage: async () => ({
                goto: async (url: string) => {
                  visitedUrls.push(url);
                  return { status: () => 200 };
                },
                waitForTimeout: async () => {},
                title: async () => 'Events',
                evaluate: async (fnOrExpr: unknown) => {
                  if (typeof fnOrExpr === 'string') return 12_500; // exceeds 10_000px clip cap
                  return [
                    {
                      x: 10,
                      y: 50,
                      width: 80,
                      height: 10,
                      kind: 'draft',
                      file: 'src/pages/events.astro',
                    },
                  ];
                },
                screenshot: async (opts: Record<string, unknown>) => {
                  screenshotCalls.push(opts);
                  return Buffer.from('review-jpg-fallback');
                },
              }),
              close: async () => {},
            };
          },
          close: async () => {},
        }) as unknown as Browser,
    });

    try {
      const mobilePages = await svc.captureLiveVsDraftPages({
        routes: ['/events'],
        draftFiles: ['src/pages/events.astro'],
        mergedFromLiveFiles: [],
        draftBaseUrl: 'http://ws-1:4321/p/s1',
        liveBaseUrl: 'https://example.org',
        baseSha: 'abc1234',
        liveTimestamp: '11:30 AM',
        viewport: 'mobile',
      });

      expect(mobilePages).toHaveLength(1);
      expect(contextViewports[0]).toEqual({ width: 390, height: 844 });
      expect(visitedUrls).toContain('http://ws-1:4321/p/s1/events');
      expect(visitedUrls).toContain('https://example.org/events');
      expect(cdpCalls[0]).toEqual({
        method: 'Page.captureScreenshot',
        params: {
          format: 'webp',
          quality: 88,
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: 390, height: 10_000, scale: 1 },
        },
      });
      expect(mobilePages[0]!.viewport).toBe('mobile');
      expect(mobilePages[0]!.shots?.mobile?.width).toBe(390);
      expect(mobilePages[0]!.shots?.mobile?.height).toBe(10_000);
      expect(mobilePages[0]!.shots?.mobile?.draftScreenshotDataUrl).toContain('data:image/webp;base64,');
      expect(mobilePages[0]!.shots?.mobile?.liveScreenshotDataUrl).toContain('data:image/webp;base64,');
      expect(mobilePages[0]!.shots?.mobile?.highlights).toEqual([]);

      // Second review with same baseSha should hit the Live LRU cache (no second visit to example.org)
      visitedUrls.length = 0;
      await svc.captureRouteReview({
        route: '/events',
        draftFiles: ['src/pages/events.astro'],
        mergedFromLiveFiles: [],
        draftBaseUrl: 'http://ws-1:4321/p/s1',
        liveBaseUrl: 'https://example.org',
        baseSha: 'abc1234',
        liveTimestamp: '11:31 AM',
        viewport: 'mobile',
      });
      expect(visitedUrls).toEqual(['http://ws-1:4321/p/s1/events']);

      // When CDP is unavailable, falls back to JPEG (q=88)
      enableCdp = false;
      const desktopPages = await svc.captureLiveVsDraftPages({
        routes: ['/events'],
        draftFiles: ['src/pages/events.astro'],
        mergedFromLiveFiles: [],
        draftBaseUrl: 'http://ws-1:4321/p/s1',
        liveBaseUrl: null,
        liveTimestamp: '11:30 AM',
        viewport: 'desktop',
      });

      expect(desktopPages).toHaveLength(1);
      expect(desktopPages[0]!.shots?.desktop?.draftScreenshotDataUrl).toContain('data:image/jpeg;base64,');
      expect(desktopPages[0]!.shots?.desktop?.liveScreenshotDataUrl).toBeUndefined();
      expect(screenshotCalls[0]).toEqual({
        type: 'jpeg',
        quality: 88,
        fullPage: true,
        clip: { x: 0, y: 0, width: 1280, height: 10_000 },
      });
    } finally {
      await svc.close();
    }
  });

  it('runs scroll sweep, promotes lazy images/iframes, decodes complete async images, and awaits loading FontFaces before capture', async () => {
    const events: string[] = [];
    const scrollPositions: number[] = [];
    let removedLazyAttr = false;

    const fakeLazyImg = {
      src: '/images/community/cross-gen-redwoods.webp',
      currentSrc: '/images/community/cross-gen-redwoods.webp',
      complete: false,
      naturalWidth: 0,
      loading: 'lazy',
      decoding: 'async',
      getAttribute(k: string) {
        return k === 'loading' ? this.loading : null;
      },
      setAttribute(k: string, v: string) {
        if (k === 'loading') this.loading = v;
      },
      removeAttribute(k: string) {
        if (k === 'loading') removedLazyAttr = true;
      },
      getBoundingClientRect: () => ({ top: 1400 }),
      addEventListener(ev: string, cb: () => void) {
        if (ev === 'load') {
          setTimeout(() => {
            this.complete = true;
            this.naturalWidth = 1200;
            events.push('lazy-img-loaded');
            cb();
          }, 20);
        }
      },
      decode: async () => {
        events.push('lazy-img-decoded');
      },
    };

    const fakeAlreadyCompleteAsyncImg = {
      src: '/images/community/growth-group-home.webp',
      currentSrc: '/images/community/growth-group-home.webp',
      complete: true,
      naturalWidth: 800,
      loading: 'eager',
      decoding: 'async',
      getBoundingClientRect: () => ({ top: 1500 }),
      decode: async () => {
        events.push('complete-async-img-decoded');
      },
    };

    const fakeLoadingFont = {
      status: 'loading',
      loaded: new Promise<void>((resolve) => {
        setTimeout(() => {
          fakeLoadingFont.status = 'loaded';
          events.push('font-loaded');
          resolve();
        }, 25);
      }),
    };

    const svc = new ScreenshotService({
      idleTimeoutMs: 60_000,
      settleWaitMs: 0,
      launchBrowser: async () =>
        Object.assign(new EventEmitter(), {
          isConnected: () => true,
          newContext: async () => ({
            newPage: async () => ({
              goto: async () => ({ status: () => 200 }),
              addStyleTag: async () => {},
              waitForTimeout: async () => {},
              title: async () => 'Home',
              evaluate: async (fnOrExpr: unknown, arg?: unknown) => {
                if (typeof fnOrExpr === 'string') return 2400;
                if (typeof fnOrExpr === 'function' && arg && typeof arg === 'object' && 'eagerAll' in arg) {
                  const g = globalThis as Record<string, unknown>;
                  const prevDoc = g.document;
                  const prevScrollTo = g.scrollTo;
                  const prevInnerH = g.innerHeight;
                  g.innerHeight = 800;
                  g.scrollTo = (_x: number, y: number) => {
                    scrollPositions.push(y);
                  };
                  const fontSet = [fakeLoadingFont];
                  g.document = {
                    body: { scrollHeight: 2400, offsetHeight: 2400 },
                    documentElement: { scrollHeight: 2400, offsetHeight: 2400 },
                    fonts: {
                      ready: Promise.resolve(),
                      [Symbol.iterator]: () => fontSet[Symbol.iterator](),
                    },
                    images: [fakeLazyImg, fakeAlreadyCompleteAsyncImg],
                    querySelectorAll: () => [],
                  };
                  try {
                    return await (fnOrExpr as (a: unknown) => Promise<unknown>)(arg);
                  } finally {
                    g.document = prevDoc;
                    g.scrollTo = prevScrollTo;
                    g.innerHeight = prevInnerH;
                  }
                }
                return [];
              },
              screenshot: async () => {
                events.push('screenshot');
                return Buffer.from('jpg');
              },
            }),
            close: async () => {},
          }),
          close: async () => {},
        }) as unknown as Browser,
    });

    try {
      await svc.captureRouteReview({
        route: '/',
        draftFiles: ['src/pages/index.astro'],
        mergedFromLiveFiles: [],
        draftBaseUrl: 'http://ws-1:4321/p/s1',
        liveBaseUrl: null,
        liveTimestamp: '12:55 PM',
        viewport: 'desktop',
      });

      expect(fakeLazyImg.loading).toBe('eager');
      expect(fakeLazyImg.decoding).toBe('sync');
      expect(removedLazyAttr).toBe(true);
      // Scroll sweep visited below-the-fold offsets and returned cleanly to y=0
      expect(scrollPositions).toContain(800);
      expect(scrollPositions).toContain(1600);
      expect(scrollPositions[scrollPositions.length - 1]).toBe(0);
      // All images decoded and loading FontFace awaited BEFORE screenshot fired
      expect(events.indexOf('lazy-img-loaded')).toBeGreaterThanOrEqual(0);
      expect(events.indexOf('lazy-img-decoded')).toBeGreaterThan(events.indexOf('lazy-img-loaded'));
      expect(events).toContain('complete-async-img-decoded');
      expect(events).toContain('font-loaded');
      expect(events[events.length - 1]).toBe('screenshot');
    } finally {
      await svc.close();
    }
  });

  it('rejects with ScreenshotBusyError (503) once more than maxQueue captures are waiting', async () => {
    const clock = new FakeClock({ autoAdvance: true });
    const svc = new ScreenshotService({
      clock,
      idleTimeoutMs: 60_000,
      settleWaitMs: 0,
      maxConcurrency: 1,
      maxQueue: 2,
      launchBrowser: async () => createFakeBrowser({ gotoDelayMs: 40, clock }).browser,
    });
    try {
      const ok = [1, 2, 3].map((i) => svc.capture({ url: `http://ws/p/s/${i}`, viewport: 'desktop' }));
      const rejected = svc.capture({ url: 'http://ws/p/s/4', viewport: 'desktop' });
      await expect(rejected).rejects.toBeInstanceOf(ScreenshotBusyError);
      await expect(rejected).rejects.toMatchObject({ status: 503 });
      const results = await Promise.all(ok);
      expect(results).toHaveLength(3);
      expect(svc.stats.rejectedBusy).toBe(1);
    } finally {
      await svc.close();
    }
  });

  it('enforces a per-capture deadline (queue wait included), closes the context and recycles a hung browser', async () => {
    let launches = 0;
    let hang = true;
    const fakes: Array<ReturnType<typeof createFakeBrowser>> = [];
    const clock = new FakeClock();
    const svc = new ScreenshotService({
      clock,
      idleTimeoutMs: 60_000,
      settleWaitMs: 0,
      maxConcurrency: 1,
      captureDeadlineMs: 120,
      launchBrowser: async () => {
        launches += 1;
        const fake = createFakeBrowser({ hangGoto: () => hang });
        fakes.push(fake);
        return fake.browser;
      },
    });
    try {
      const started = clock.now();
      const hung = svc.capture({ url: 'http://ws/p/s/hung', viewport: 'desktop' });
      // Queued behind the hung capture: its own deadline covers the time spent waiting
      const queued = svc.capture({ url: 'http://ws/p/s/queued', viewport: 'desktop' });
      const hungResult = expect(hung).rejects.toBeInstanceOf(ScreenshotTimeoutError);
      const queuedResult = expect(queued).rejects.toBeInstanceOf(ScreenshotTimeoutError);
      await flush();
      await clock.advance(119);
      expect(svc.stats.timeouts).toBe(0);
      await clock.advance(1);
      await hungResult;
      await queuedResult;
      const elapsed = clock.now() - started;
      expect(elapsed).toBe(120);
      // The hung capture's context was closed and the (still "connected") browser recycled
      expect(fakes[0]!.stats().contextsClosed).toBe(fakes[0]!.stats().contextsCreated);
      expect(fakes[0]!.stats().closeCalls).toBe(1);
      expect(svc.stats.timeouts).toBe(2);

      // Slots are free again and a fresh browser serves the next capture
      hang = false;
      const ok = await svc.capture({ url: 'http://ws/p/s/after', viewport: 'desktop' });
      expect(ok.data.toString()).toBe('fake-jpeg');
      // The queued capture may be granted the slot just before its own deadline and get a fresh
      // (equally wedged) browser, which is recycled too; the last browser is the healthy one.
      expect(launches).toBeGreaterThanOrEqual(2);
      for (const fake of fakes.slice(0, -1)) expect(fake.stats().closeCalls).toBe(1);
      expect(fakes.at(-1)!.stats().connected).toBe(true);
    } finally {
      await svc.close();
    }
  });

  it('recycles Chromium after recycleAfterCaptures captures without disturbing in-flight work', async () => {
    let launches = 0;
    const fakes: Array<ReturnType<typeof createFakeBrowser>> = [];
    // Manual clock: auto-advance would also fire the 60s idle-close timer between captures.
    const clock = new FakeClock();
    const svc = new ScreenshotService({
      clock,
      idleTimeoutMs: 60_000,
      settleWaitMs: 0,
      maxConcurrency: 2,
      recycleAfterCaptures: 2,
      launchBrowser: async () => {
        launches += 1;
        const fake = createFakeBrowser({ gotoDelayMs: 5, clock });
        fakes.push(fake);
        return fake.browser;
      },
    });
    try {
      for (let i = 0; i < 5; i++) {
        const shot = svc.capture({ url: `http://ws/p/s/${i}`, viewport: 'desktop' });
        await flush();
        await clock.advance(5); // the fake goto delay
        await shot;
      }
      expect(launches).toBe(3); // 2 + 2 + 1 captures
      await flush();
      expect(fakes[0]!.stats().closeCalls).toBe(1);
      expect(fakes[1]!.stats().closeCalls).toBe(1);
      expect(fakes[2]!.stats().connected).toBe(true);
      expect(svc.stats.recycles).toBe(2);
    } finally {
      await svc.close();
    }
  });
});
