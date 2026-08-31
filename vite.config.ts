import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { APP_NAME } from './src/config';

// base './' keeps the same build working on localhost, any static host, and any
// GitHub Pages subpath. (It does NOT make file:// work — ES modules and service
// workers both need a real origin; see the D7 correction in DECISIONS.md.)
export default defineConfig({
  base: './',
  // Listen on every interface so the phone on the same wifi can reach the dev
  // server (SPEC §11.6). Vite binds to localhost by default, which is why the
  // iPhone route could not work at all before this. `host: true` also makes
  // Vite print the LAN URL to paste into Safari.
  //
  // NOTE the limit of that route: a LAN address is http://, which is NOT a
  // secure context, so the service worker will not register and
  // navigator.storage is unavailable. The app RUNS there (ids no longer depend
  // on a secure context — see uid() in src/lib/util.ts), but it is not offline
  // capable and not a real installable PWA. For that — and for SPEC §12's
  // airplane-mode test — serve it over https (GitHub Pages) or use localhost.
  server: { host: true },
  preview: { host: true },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: APP_NAME,
        short_name: APP_NAME,
        description: 'Personal finance. Your data, your device, no servers.',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f6f7f9',
        theme_color: '#0d1117',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallback: 'index.html',
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // NO TEST IN THIS SUITE ASSERTS A SPEED — and vitest's default 5s per-test
    // timeout was the last place one was hiding.
    //
    // The heavy files (scale, sync-engine, backup, import-sample) drive
    // thousands of rows through fake-indexeddb, a pure-JS IndexedDB that
    // structured-clones every row, while 39 files share 8 cores. The same test
    // on the same code therefore swings by most of an order of magnitude
    // depending on what else is running. Measured on `several accounts still
    // use anyOf, with identical results`, every sample GREEN:
    //
    //   scale.test.ts run alone            1.4s / 1.4s / 1.9s
    //   inside the full suite (11 runs)    4.0s … 8.5s … 13.8s
    //
    // Eight of those eleven full-suite samples are over 5s. At the default
    // bound that is a coin flip reported as a broken index — which is how it
    // was first seen, when adding one more test file anywhere under tests/
    // turned scale.test.ts red.
    //
    // NOT DONE, though it does help — capping the worker pool
    // (poolOptions.forks.maxForks). Two runs at maxForks=4 put the slowest
    // single test at 2.4s and 2.8s, against 6.3s and 7.2s at the default, for
    // no measured cost in total duration (9-10s either way). It is left off
    // because it is tuning against THIS machine's core count rather than a
    // fix: it widens the margin around a wall-clock bound instead of removing
    // the clock, and on a smaller box `4` is no cap at all. Worth reaching for
    // if this suite ever has to run somewhere tighter; not worth relying on.
    //
    // REJECTED — per-file vi.setConfig(). It only moves the trap: the next file
    // to grow heavy flakes before anyone remembers to add the line.
    //
    // These bounds are not a performance budget; they are the absence of one.
    // They still catch a genuine hang. They no longer catch the scheduler.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
