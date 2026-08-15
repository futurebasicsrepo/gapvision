import { defineConfig } from "vite";

// Even Hub plugins are plain web apps loaded by the Even App WebView.
// Build to a single small bundle; no framework needed for the phone page.
//
// `public/` holds `dev-utterance.pcm` — recorded speech the MockBridge streams
// so the voice path is demoable in a browser with no glasses in the room. It is
// 93 KB and it is dead weight inside an `.ehpk`: MockBridge only ever runs when
// there is no native bridge, which on a G2 is never. Set CUE_PACK=1 for the
// build you are going to package, and the asset stays out.
export default defineConfig({
  base: "./",
  publicDir: process.env.CUE_PACK === "1" ? false : "public",
  build: { target: "es2020" },
  server: { port: 5180 },
});
