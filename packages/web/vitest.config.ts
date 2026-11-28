import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

const src = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

// Resolve workspace packages to their TypeScript sources so `vitest run` works on a clean tree
// (no prior `pnpm build`). Package exports still point at dist for real consumers.
export default mergeConfig(
  viteConfig,
  defineConfig({
    resolve: {
      alias: [
        { find: /^@halley\/shared\/auth$/, replacement: src('shared/src/auth.ts') },
        { find: /^@halley\/shared$/, replacement: src('shared/src/index.ts') },
      ],
    },
  }),
);
