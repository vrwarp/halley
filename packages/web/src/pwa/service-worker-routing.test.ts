import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// Behavioral test of the unified root-scoped service worker (HALLEY_PREVIEW_SW_JS, served at
// /halley-preview-sw.js). It doubles as preview-tab isolation and the PWA app shell, so the
// PWA caching must never touch API responses, preview routes or escaped preview requests.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, '../..');
const previewProxyPath = path.resolve(webDir, '../control-plane/src/proxy/preview-proxy.ts');
const ORIGIN = 'https://halley.test';

function loadSwSource(): string {
  const src = fs.readFileSync(previewProxyPath, 'utf8');
  const m = src.match(/export const HALLEY_PREVIEW_SW_JS = `([\s\S]*?)`\.trimStart\(\);/);
  if (!m) throw new Error('HALLEY_PREVIEW_SW_JS not found in preview-proxy.ts');
  // Evaluate the template literal body exactly as the TS module would (resolves `\\/` escapes).
  return (new Function(`return \`${m[1]}\`;`) as () => string)().replace(
    '__HALLEY_SW_VERSION__',
    'test',
  );
}

interface FakeFetchEvent {
  request: { url: string; method: string; mode: string; headers: Headers; redirect: string };
  clientId: string;
  resultingClientId?: string;
  respondWith: ReturnType<typeof vi.fn>;
}

function createSw(clientUrls: Record<string, string>) {
  const listeners = new Map<string, (e: unknown) => void>();
  const cachePut = vi.fn();
  const cacheMatch = vi.fn(async () => undefined);
  const cachesOpen = vi.fn(async () => ({ put: cachePut, match: cacheMatch, addAll: vi.fn() }));
  const fetchFn = vi.fn(
    async (input: unknown) =>
      ({ ok: true, type: 'basic', url: String(input), clone: () => ({}) }) as unknown as Response,
  );
  const self = {
    location: new URL(`${ORIGIN}/halley-preview-sw.js`),
    registration: { active: null },
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
    skipWaiting: vi.fn(),
    clients: {
      claim: vi.fn(),
      get: vi.fn(async (id: string) => (clientUrls[id] ? { url: clientUrls[id] } : undefined)),
    },
  };
  const ctx = vm.createContext({
    self,
    caches: { open: cachesOpen, match: cacheMatch, keys: async () => [], delete: vi.fn() },
    fetch: fetchFn,
    URL,
    Map,
    Promise,
    Response,
    console,
    TypeError,
  });
  vm.runInContext(loadSwSource(), ctx);

  const dispatchFetch = async (
    pathname: string,
    opts: { clientId?: string; mode?: string; method?: string; resultingClientId?: string } = {},
  ) => {
    const event: FakeFetchEvent = {
      request: {
        url: `${ORIGIN}${pathname}`,
        method: opts.method ?? 'GET',
        mode: opts.mode ?? 'cors',
        headers: new Headers(),
        redirect: 'follow',
      },
      clientId: opts.clientId ?? '',
      resultingClientId: opts.resultingClientId,
      respondWith: vi.fn(),
    };
    listeners.get('fetch')!(event);
    const responded = event.respondWith.mock.calls.length > 0;
    const response = responded ? await event.respondWith.mock.calls[0]![0] : undefined;
    return { responded, response };
  };

  return { dispatchFetch, cachePut, cachesOpen, fetchFn };
}

describe('unified service worker routing', () => {
  const clients = { shell: `${ORIGIN}/`, preview: `${ORIGIN}/p/sess-1/` };

  it('never intercepts or caches API, preview, escaped-preview, ws or editor requests', async () => {
    const sw = createSw(clients);
    const reserved = [
      '/api/sessions',
      '/api/auth/me',
      '/p/sess-1/',
      '/p/sess-1/assets/app.js',
      '/__halley_p/sess-1/src/main.ts',
      '/ws/sessions/sess-1',
      '/internal/health',
      '/__editor/patch',
      '/halley-preview-sw.js',
    ];
    for (const p of reserved) {
      for (const clientId of ['shell', 'preview']) {
        const { responded } = await sw.dispatchFetch(p, { clientId });
        expect(responded, `${p} from ${clientId}`).toBe(false);
      }
    }
    expect(sw.cachesOpen).not.toHaveBeenCalled();
    expect(sw.cachePut).not.toHaveBeenCalled();
  });

  it('does not take over top-level navigations to API or preview routes', async () => {
    const sw = createSw(clients);
    for (const p of ['/api/auth/google/callback', '/p/sess-1/about', '/__halley_p/sess-1/']) {
      const { responded } = await sw.dispatchFetch(p, { mode: 'navigate', resultingClientId: 'n1' });
      expect(responded, p).toBe(false);
    }
    expect(sw.cachePut).not.toHaveBeenCalled();
  });

  it('ignores non-GET requests entirely', async () => {
    const sw = createSw(clients);
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const { responded } = await sw.dispatchFetch('/assets/index.js', { clientId: 'shell', method });
      expect(responded).toBe(false);
    }
  });

  it('rewrites escaped root-relative preview requests to /__halley_p/<sid>/ without caching them', async () => {
    const sw = createSw(clients);
    const { responded } = await sw.dispatchFetch('/assets/hero.png?v=1', { clientId: 'preview' });
    expect(responded).toBe(true);
    expect(sw.fetchFn).toHaveBeenCalledWith(
      `${ORIGIN}/__halley_p/sess-1/assets/hero.png?v=1`,
      expect.objectContaining({ credentials: 'same-origin' }),
    );
    expect(sw.cachePut).not.toHaveBeenCalled();
  });

  it('caches only the Halley shell hashed bundles', async () => {
    const sw = createSw(clients);
    await sw.dispatchFetch('/assets/index-abc123.js', { clientId: 'shell' });
    expect(sw.cachePut).toHaveBeenCalledTimes(1);
    sw.cachePut.mockClear();
    const { responded } = await sw.dispatchFetch('/some/other/path.json', { clientId: 'shell' });
    expect(responded).toBe(true);
    expect(sw.cachePut).not.toHaveBeenCalled();
  });

  it('is the only service worker the web app registers', () => {
    const srcDir = path.join(webDir, 'src');
    const registrations: string[] = [];
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(abs);
        else if (/\.tsx?$/.test(ent.name) && !/\.test\.tsx?$/.test(ent.name)) {
          for (const m of fs.readFileSync(abs, 'utf8').matchAll(/serviceWorker\s*\.register\(\s*'([^']+)'/g)) {
            registrations.push(m[1]!);
          }
        }
      }
    };
    walk(srcDir);
    expect(registrations).toEqual(['/halley-preview-sw.js']);
  });
});
