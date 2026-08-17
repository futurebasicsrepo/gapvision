import { defineConfig } from "vite";

// A Meta Ray-Ban Display Web App is a plain static site served over HTTPS
// and launched on the glasses by URL. Build small; no framework.
export default defineConfig({
  base: "./",
  build: { target: "es2020" },
  server: { port: 5190 },
});
