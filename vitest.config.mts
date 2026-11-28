import { defineConfig } from 'vitest/config';

// The workspace's own projects only. A `**/` glob also matches the full repo
// checkouts under `.local/eval-home/workdirs/` (eval trials): editor test
// runners then load native modules from those folders, and Windows will not
// let the eval runner delete a folder whose modules are loaded.
export default defineConfig({
  test: {
    projects: [
      'apps/*/vite.config.{mjs,js,ts,mts}',
      'apps/*/vitest.config.{mjs,js,ts,mts}',
      'packages/*/vite.config.{mjs,js,ts,mts}',
      'packages/*/vitest.config.{mjs,js,ts,mts}',
    ],
  },
});
