import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Workspace packages (@agent/*) resolve to their TypeScript source here, not
// their compiled CommonJS dist: a dist `require()` would bypass vi.mock, so the
// golden run's scripted model would not reach code inside agent-service.
const conditions = ['@agent/source', ...defaultServerConditions];

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/agent-http',
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    name: '@agent/agent-http',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});
