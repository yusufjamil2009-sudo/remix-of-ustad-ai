// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    server: {
      // Allow the sandbox live-preview host (and any *.e2b.app preview) to reach
      // the dev server. Production builds are unaffected.
      host: "0.0.0.0",
      allowedHosts: [".e2b.app"],
    },
    plugins: [
      VitePWA({
        strategies: "generateSW",
        // TanStack Start emits the browser bundle to dist/client; the SW must
        // sit next to it so it is served from the site root.
        outDir: "dist/client",
        registerType: "autoUpdate",
        // The guarded wrapper in src/lib/pwa.ts is the ONLY registrar.
        injectRegister: null,
        devOptions: { enabled: false },
        filename: "sw.js",
        manifestFilename: "manifest.webmanifest",
        includeAssets: ["favicon.png", "apple-touch-icon.png", "robots.txt"],
        manifest: {
          id: "/",
          name: "USTAD AI",
          short_name: "USTAD AI",
          description:
            "USTAD AI — your personal ustad for study, chat, exams, notes and the 3D classroom.",
          start_url: "/",
          scope: "/",
          display: "standalone",
          orientation: "portrait-primary",
          theme_color: "#b37900",
          background_color: "#f9f9f3",
          lang: "en",
          categories: ["education", "productivity"],
          icons: [
            { src: "/icons/ustad-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
            { src: "/icons/ustad-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
            {
              src: "/icons/ustad-maskable-192.png",
              sizes: "192x192",
              type: "image/png",
              purpose: "maskable",
            },
            {
              src: "/icons/ustad-maskable-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
        workbox: {
          // Real system-notification click handling lives in /notify-sw.js and
          // is folded into this ONE generated service worker.
          importScripts: ["/notify-sw.js"],
          globPatterns: ["**/*.{js,css,html,png,svg,webmanifest,woff2}"],
          maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          skipWaiting: true,
          navigateFallback: "/",
          // Never let the SW answer server functions, API routes or OAuth.
          navigateFallbackDenylist: [/^\/api\//, /^\/_serverFn\//, /^\/~oauth/],
          // Only same-origin, non-private traffic is cached. No API/AI responses,
          // no auth tokens, no user data ever enters Cache Storage.
          runtimeCaching: [
            {
              urlPattern: ({ request, sameOrigin }) => sameOrigin && request.mode === "navigate",
              handler: "NetworkFirst",
              options: {
                cacheName: "ustad-shell",
                networkTimeoutSeconds: 5,
                expiration: { maxEntries: 12, maxAgeSeconds: 60 * 60 * 24 * 7 },
              },
            },
            {
              urlPattern: ({ url, sameOrigin, request }) =>
                sameOrigin &&
                !url.pathname.startsWith("/api/") &&
                !url.pathname.startsWith("/_serverFn") &&
                ["style", "script", "worker", "font", "image"].includes(request.destination),
              handler: "CacheFirst",
              options: {
                cacheName: "ustad-static",
                expiration: { maxEntries: 220, maxAgeSeconds: 60 * 60 * 24 * 30 },
              },
            },
          ],
        },
      }),
    ],
  },
});
