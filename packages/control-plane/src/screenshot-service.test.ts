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

  const browser = Object.assign(emitter, {
    isConnected: () => connected,
    newContext: async () => {
      contextsCreated += 1;
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
          screenshot: async () => Buffer.from('fake-png'),
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
    }),
    simulateCrash: () => {
      connected = false;
      emitter.emit('disconnected');
    },
  };
}

describe('ScreenshotService', () => {
  it('reuses a single warm browser across calls with fresh BrowserContexts and serializes concurrent captures', async () => {
    let launchCount = 0;
    let active = 0;
    let maxActive = 0;
    let fakeRef: ReturnType<typeof createFakeBrowser> | null = null;

    const svc = new ScreenshotService({
      idleTimeoutMs: 60_000,
      settleWaitMs: 0,
      launchBrowser: async () => {
        launchCount += 1;
        fakeRef = createFakeBrowser({
          gotoDelayMs: 25,
          onActiveChange: (d) => {
            active += d;
            if (active > maxActive) maxActive = active;
          },
        });
        return fakeRef.browser;
      },
    });

    try {
      const [r1, r2] = await Promise.all([
        svc.capture({ url: 'http://ws-1:4321/p/s1/', viewport: 'desktop' }),
        svc.capture({ url: 'http://ws-2:4321/p/s2/about', viewport: 'mobile' }),
      ]);

      expect(r1.width).toBe(1440);
      expect(r1.height).toBe(900);
      expect(r2.width).toBe(390);
      expect(r2.height).toBe(844);
      expect(r1.png.toString()).toBe('fake-png');
      expect(launchCount).toBe(1);
      expect(maxActive).toBe(1);
      expect(svc.isBrowserRunning()).toBe(true);
      expect(fakeRef!.stats().contextsCreated).toBe(2);
      expect(fakeRef!.stats().contextsClosed).toBe(2);
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
      expect(res.width).toBe(1440);
      expect(res.height).toBe(3600);
      expect(capturedOpts).toEqual({
        type: 'png',
        fullPage: true,
        clip: { x: 0, y: 0, width: 1440, height: 3600 },
      });
    } finally {
      await svc.close();
    }
  });
});
