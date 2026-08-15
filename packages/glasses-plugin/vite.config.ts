import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// The version an operator can read off the glass. Three uploads tonight could
// not be told apart from outside the device, which turned "did the fix work"
// into a guess every time. Now the idle screen says which build is running.
const APP_MANIFEST = JSON.parse(readFileSync("./app.json", "utf8"));
const APP_VERSION = APP_MANIFEST.version;

/**
 * The realtime server, taken from the manifest's own network whitelist.
 *
 * This used to be `import.meta.env.VITE_SERVER_URL || "http://localhost:4000"`,
 * and `.env` is gitignored — so every `.ehpk` packed anywhere but on a machine
 * that happened to have that file shipped a plugin dialling localhost from a
 * phone. It installs, it renders, the HUD looks right, and nothing works:
 * no socket, so no guest ever arrives and a press to ask reaches nothing.
 * Three uploads went out like that.
 *
 * Reading it from `app.json` instead makes two things true by construction:
 * the URL exists without any environment, and it is the *same* URL the host
 * will permit — a plugin dialling a host outside its own whitelist is blocked
 * by the WebView, which is the identical silent failure one layer down.
 */
const WHITELIST: string[] =
  APP_MANIFEST.permissions?.find((p: any) => p.name === "network")?.whitelist ?? [];
if (WHITELIST.length === 0) {
  throw new Error(
    "app.json has no network whitelist — the plugin would have nowhere to dial.",
  );
}
const REALTIME_URL = WHITELIST[0];

// Even Hub plugins are plain web apps loaded by the Even App WebView.
// Build to a single small bundle; no framework needed for the phone page.
//
// `public/` holds `dev-utterance.pcm` — recorded speech the MockBridge streams
// so the voice path is demoable in a browser with no glasses in the room. It is
// 93 KB and it is dead weight inside an `.ehpk`: MockBridge only ever runs when
// there is no native bridge, which on a G2 is never. Set CUE_PACK=1 for the
// build you are going to package, and the asset stays out.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __REALTIME_URL__: JSON.stringify(REALTIME_URL),
  },
  base: "./",
  publicDir: process.env.CUE_PACK === "1" ? false : "public",
  build: { target: "es2020" },
  server: { port: 5180 },
});
