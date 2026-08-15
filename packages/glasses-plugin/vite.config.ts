import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// The version an operator can read off the glass. Three uploads tonight could
// not be told apart from outside the device, which turned "did the fix work"
// into a guess every time. Now the idle screen says which build is running.
const APP_VERSION = JSON.parse(readFileSync("./app.json", "utf8")).version;

// Even Hub plugins are plain web apps loaded by the Even App WebView.
// Build to a single small bundle; no framework needed for the phone page.
//
// `public/` holds `dev-utterance.pcm` — recorded speech the MockBridge streams
// so the voice path is demoable in a browser with no glasses in the room. It is
// 93 KB and it is dead weight inside an `.ehpk`: MockBridge only ever runs when
// there is no native bridge, which on a G2 is never. Set CUE_PACK=1 for the
// build you are going to package, and the asset stays out.
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  base: "./",
  publicDir: process.env.CUE_PACK === "1" ? false : "public",
  build: { target: "es2020" },
  server: { port: 5180 },
});
