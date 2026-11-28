import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Stamps a deterministic per-build version hash into dist/sw.js so every
 * deployment triggers the Service Worker update lifecycle and purges stale caches.
 */
function stampSwVersion(): Plugin {
  let outDir = 'dist';
  return {
    name: 'halley-stamp-sw-version',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    async closeBundle() {
      const swPath = path.resolve(outDir, 'sw.js');
      try {
        const raw = await fs.readFile(swPath, 'utf8');
        if (!raw.includes('__HALLEY_SW_VERSION__')) return;
        const hash = crypto
          .createHash('sha256')
          .update(`${Date.now()}-${Math.random()}`)
          .digest('hex')
          .slice(0, 12);
        await fs.writeFile(swPath, raw.replace(/__HALLEY_SW_VERSION__/g, hash), 'utf8');
      } catch {
        // sw.js not present
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), stampSwVersion()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/p': {
        target: 'http://127.0.0.1:3000',
        ws: true,
      },
      '/ws': {
        target: 'http://127.0.0.1:3000',
        ws: true,
      },
    },
  },
});
