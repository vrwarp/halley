import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

// Resolve workspace packages to their TypeScript sources so `vitest run` works on a clean tree
// (no prior `pnpm build`). Package exports still point at dist for real consumers.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@halley\/shared\/auth$/, replacement: src('shared/src/auth.ts') },
      { find: /^@halley\/shared$/, replacement: src('shared/src/index.ts') },
      { find: /^@halley\/astro-dev-edit$/, replacement: src('astro-dev-edit/src/index.ts') },
    ],
  },
});
