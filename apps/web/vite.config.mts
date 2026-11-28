/// <reference types='vitest' />
import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig, type Plugin } from 'vite';

import { THEME_INIT_SCRIPT } from './src/components/shell/theme-presets';
import { READING_PREFS_INIT_SCRIPT } from './src/lib/reading-prefs-init';

/** The agent host the dev server proxies to (`agent serve`, default port). */
const API_TARGET = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3333';

/**
 * FOUC guards: set html.dark/.light and the reader's text size before first
 * paint. The scripts stay defined once, in the modules the app also uses.
 */
function initScripts(): Plugin {
  return {
    name: 'agent-init-scripts',
    transformIndexHtml: () => [
      { tag: 'script', children: THEME_INIT_SCRIPT, injectTo: 'head-prepend' },
      { tag: 'script', children: READING_PREFS_INIT_SCRIPT, injectTo: 'head-prepend' },
    ],
  };
}

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/web',
  plugins: [react(), tailwindcss(), initScripts()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
    // Workspace packages (@agent/*) from their TypeScript source, as Next's
    // transpilePackages did; their CommonJS dist is not served as ESM in dev.
    conditions: ['@agent/source', ...defaultClientConditions],
  },
  // Voice: onnxruntime-web and vad-web load their own wasm/worker files at
  // runtime (from the CDN or VITE_* bases); pre-bundling would break that.
  optimizeDeps: { exclude: ['onnxruntime-web', '@ricky0123/vad-web'] },
  server: {
    port: 4200,
    host: 'localhost',
    proxy: {
      // Dev only: the page is on :4200, the host on :3333. The host admits a
      // browser only from its own exact origin (ADR-0003 §4.6), so the proxy
      // presents the request as coming from the target's origin.
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            if (proxyReq.getHeader('origin')) proxyReq.setHeader('origin', new URL(API_TARGET).origin);
          });
        },
      },
    },
  },
  preview: { port: 4300, host: 'localhost' },
  build: {
    outDir: './dist',
    emptyOutDir: true,
    reportCompressedSize: false,
  },
});
