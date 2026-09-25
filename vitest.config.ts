import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Test against sources, so `npm test` does not depend on a prior build.
    alias: {
      '@yatris/astro/platform': fileURLToPath(new URL('./packages/astro/src/platform.ts', import.meta.url)),
      '@yatris/astro/mcp': fileURLToPath(new URL('./packages/astro/src/mcp.ts', import.meta.url)),
      '@yatris/astro/schema': fileURLToPath(new URL('./packages/astro/src/schema.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
  },
});
