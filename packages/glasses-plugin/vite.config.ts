import { defineConfig } from "vite";

// Even Hub plugins are plain web apps loaded by the Even App WebView.
// Build to a single small bundle; no framework needed for the phone page.
export default defineConfig({
  base: "./",
  build: { target: "es2020" },
  server: { port: 5180 },
});
