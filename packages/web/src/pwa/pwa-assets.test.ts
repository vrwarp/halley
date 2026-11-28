import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, '../..');
const publicDir = path.join(webDir, 'public');
const previewProxyPath = path.resolve(webDir, '../control-plane/src/proxy/preview-proxy.ts');

describe('PWA manifest, icons, and unified service worker', () => {
  it('ships a valid web app manifest with all referenced icons present on disk', () => {
    const raw = fs.readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8');
    const manifest = JSON.parse(raw) as {
      id: string;
      name: string;
      short_name: string;
      start_url: string;
      scope: string;
      display: string;
      background_color: string;
      theme_color: string;
      icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
    };

    expect(manifest.id).toBe('/');
    expect(manifest.short_name).toBe('Halley');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toBe('#FAF9F7');
    expect(manifest.background_color).toBe('#FAF9F7');

    const purposes = manifest.icons.map((i) => `${i.sizes}:${i.purpose}`);
    expect(purposes).toContain('192x192:any');
    expect(purposes).toContain('512x512:any');
    expect(purposes).toContain('512x512:maskable');

    for (const icon of manifest.icons) {
      const iconPath = path.join(publicDir, icon.src.replace(/^\//, ''));
      expect(fs.existsSync(iconPath), `Missing icon file: ${icon.src}`).toBe(true);
      expect(fs.statSync(iconPath).size).toBeGreaterThan(500);
    }
  });

  it('ships favicons, apple-touch-icon, offline fallback, and links them from index.html', () => {
    for (const rel of ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'offline.html']) {
      const p = path.join(publicDir, rel);
      expect(fs.existsSync(p), `Missing public/${rel}`).toBe(true);
      expect(fs.statSync(p).size).toBeGreaterThan(100);
    }

    const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).toContain('<link rel="icon" href="/favicon.ico"');
    expect(html).toContain('<link rel="icon" href="/favicon.svg"');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(html).toContain('<meta name="theme-color" content="#FAF9F7" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
  });

  it('unifies preview isolation and PWA offline/update behavior in HALLEY_PREVIEW_SW_JS', () => {
    const swSource = fs.readFileSync(previewProxyPath, 'utf8');
    for (const prefix of ['/api/', '/p/', '/__halley_p/', '/ws/', '/internal/', '/__editor/']) {
      expect(swSource).toContain(`'${prefix}'`);
    }
    expect(swSource).toContain('SKIP_WAITING');
    expect(swSource).toContain('/offline.html');
    expect(swSource).toContain('__HALLEY_SW_VERSION__');
  });
});
