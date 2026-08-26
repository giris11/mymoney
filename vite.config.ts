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
  },
});
