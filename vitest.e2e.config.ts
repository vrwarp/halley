import os from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Each E2E test boots control-plane + supervisor + 1-2 Astro dev servers + sandboxed astro builds;
    // cap concurrency to CPU count (2 on 2-vCPU devboxes, 4 on 4-vCPU CI runners) to avoid CPU starvation.
    maxConcurrency: Math.max(2, Math.min(4, os.availableParallelism())),
    // a worker that does not exit after its tests is a leak, not a slow test: fail fast with diagnostics
    teardownTimeout: 30_000,
    globalSetup: ['tests/e2e-watchdog.ts'],
  },
});
