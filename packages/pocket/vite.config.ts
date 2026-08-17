import { defineConfig } from "vite";

/**
 * Pocket is a static PWA: one document, one bundle, a manifest and a service
 * worker. No SSR, no framework, nothing to boot on the server.
 *
 * `base: "./"` matters more here than in the other packages. Pocket is served
 * from its own host in production and from a subpath in review deployments,
 * and a manifest with absolute paths silently fails to install from the second
 * — which is the deployment somebody demos from.
 */
export default defineConfig({
  base: "./",
  // Source-only workspace package; excluded so Vite transforms it rather than
  // handing it to the dependency pre-bundler as if it were built.
  optimizeDeps: { exclude: ["@cue/lens-core"] },
  build: {
    target: "es2020",
    // The service worker in `public/` is copied verbatim, never hashed: its URL
    // is its identity, and a hashed sw.js is a worker the browser treats as a
    // new one on every deploy while the old one keeps controlling the page.
    assetsInlineLimit: 0,
  },
  server: { port: 5192, host: true },   // host: true so a phone on the same wifi can reach it
  preview: { port: 5192, host: true },
});
