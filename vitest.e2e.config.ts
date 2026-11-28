import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // a worker that does not exit after its tests is a leak, not a slow test: fail fast with diagnostics
    teardownTimeout: 30_000,
    globalSetup: ['tests/e2e-watchdog.ts'],
  },
});
