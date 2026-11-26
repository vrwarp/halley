import { EventEmitter } from 'node:events';
import type { Browser } from 'playwright';
import { describe, expect, it } from 'vitest';
import { ScreenshotService } from './screenshot-service.js';

function createFakeBrowser(opts?: { gotoDelayMs?: number; onActiveChange?: (delta: number) => void }) {
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
            if (opts?.gotoDelayMs) {
              await new Promise((r) => setTimeout(r, opts.gotoDelayMs));
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

    const svc = new ScreenshotService({
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
      await new Promise((r) => setTimeout(r, 15));
      expect(launchCount).toBe(1);
      expect(svc.isBrowserRunning()).toBe(true);

      await new Promise((r) => setTimeout(r, 90));
      expect(svc.isBrowserRunning()).toBe(false);
      expect(fakes[0]!.stats().closeCalls).toBe(1);
    } finally {
      await svc.close();
    }
  });

  it('auto-closes the warm browser after idleTimeoutMs and relaunches on the next request', async () => {
    let launchCount = 0;
    const fakes: Array<ReturnType<typeof createFakeBrowser>> = [];

    const svc = new ScreenshotService({
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

      await new Promise((r) => setTimeout(r, 90));
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

  it('captures mobile and desktop Live vs Draft review screenshots up to 10000px and caches Live captures per baseSha', async () => {
    const visitedUrls: string[] = [];
    const contextViewports: Array<{ width: number; height: number }> = [];
    const screenshotCalls: Array<Record<string, unknown>> = [];

    const svc = new ScreenshotService({
      idleTimeoutMs: 60_000,
      settleWaitMs: 0,
      launchBrowser: async () =>
        Object.assign(new EventEmitter(), {
          isConnected: () => true,
          newContext: async (opts: { viewport: { width: number; height: number } }) => {
            contextViewports.push(opts.viewport);
            return {
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
                  return Buffer.from('review-mock-bytes');
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
      expect(screenshotCalls[0]).toEqual({
        type: 'png',
        fullPage: true,
        clip: { x: 0, y: 0, width: 390, height: 10_000 },
      });
      expect(mobilePages[0]!.viewport).toBe('mobile');
      expect(mobilePages[0]!.shots?.mobile?.width).toBe(390);
      expect(mobilePages[0]!.shots?.mobile?.height).toBe(10_000);
      expect(mobilePages[0]!.shots?.mobile?.highlights).toHaveLength(1);

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
      expect(desktopPages[0]!.shots?.desktop?.liveScreenshotDataUrl).toBeUndefined();
    } finally {
      await svc.close();
    }
  });
});
