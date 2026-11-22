import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath } from 'node:url'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // V3.61 — PWA OFFLINE-READY: manifest + service worker precache the app
    // shell at build time, so once a client opens the hosted URL (online) and
    // installs the app, it launches from the home screen fully offline.
    // registerType 'autoUpdate' keeps every new build in sync automatically.
    // V3.66 — PWA identity is PER CLIENT: `manifest: false` lets the factory
    // write public/manifest.webmanifest (name/icons from the client) and the
    // static file passes through to dist untouched. No more hardcoded
    // "Trendawy" branding in every new system.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['2.png', 'pwa-192x192.png', 'pwa-512x512.png', 'manifest.webmanifest'],
      manifest: false,
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'google-fonts-css',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-woff2',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 60 },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  // مسار نشر GitHub Pages للمستودع الجديد Test1
  base: '/alaaddin/',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    cssMinify: false,
    rollupOptions: {
      output: {
        // V3.47 — vendor chunks: firebase/React تُنفصل عن كود التطبيق حتى تُخزَّن
        // منفصلة في ذاكرة المتصفح (لا تُعاد إعادة تنزيلها عند كل إصدار) وتفصل
        // تحذير «chunk > 500KB» إلى أجزاء قابلة للرصد بدل ملف واحد ضخم.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('firebase')) return 'firebase'
          if (id.includes('/react/') || id.includes('/scheduler/') || id.includes('/zustand/')) return undefined
          return 'vendor'
        },
      },
    },
  },
})