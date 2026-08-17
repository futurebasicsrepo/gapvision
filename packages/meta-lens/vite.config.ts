import { resolve } from "node:path";
import { defineConfig } from "vite";

// A Meta Ray-Ban Display Web App is a plain static site served over HTTPS
// and launched on the glasses by URL. Build small; no framework.
// sim.html is the hardware-free harness (and Console's Lens Sim embed) —
// it ships in the same bundle so both stay same-origin.
export default defineConfig({
  base: "./",
  // @cue/lens-core ships TypeScript source, not a build — a shared package with
  // a build step is one somebody forgets to rebuild. Excluding it from dep
  // pre-bundling is what makes Vite transform it as source rather than hand it
  // to esbuild as a dependency.
  optimizeDeps: { exclude: ["@cue/lens-core"] },
  build: {
    target: "es2020",
    rollupOptions: {
      input: {
        lens: resolve(__dirname, "index.html"),
        sim: resolve(__dirname, "sim.html"),
      },
    },
  },
  server: { port: 5190 },
});
