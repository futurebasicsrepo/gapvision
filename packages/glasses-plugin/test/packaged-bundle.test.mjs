/**
 * What is actually inside the thing we hand Kyle.
 *
 *   node packages/glasses-plugin/test/packaged-bundle.test.mjs
 *
 * This file exists because of the worst bug of the project so far, and the
 * cheapest one to have caught. `SERVER_URL` fell back to `http://localhost:4000`
 * when `VITE_SERVER_URL` was unset, and `.env` is gitignored — so every `.ehpk`
 * packed in a sandbox told the glasses to dial localhost from a phone.
 *
 * The failure was invisible in every way that matters. The package installs.
 * The HUD renders. The version reads correctly off the glass. The layout
 * changes you shipped are all visibly there. There is simply no socket, so no
 * guest ever arrives and a press to ask reaches nothing — which reads as "the
 * demo has no guests" and "voice is broken", not as "the URL is wrong".
 *
 * Three uploads went out that way. So: before anything is packed, assert
 * against the built bundle rather than against intent.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, "..");
const DIST = path.join(PKG, "dist", "assets");
const manifest = JSON.parse(readFileSync(path.join(PKG, "app.json"), "utf8"));

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

let bundle = "";
try {
  const js = readdirSync(DIST).filter((f) => f.endsWith(".js"));
  bundle = js.map((f) => readFileSync(path.join(DIST, f), "utf8")).join("\n");
  check("a built bundle exists", js.length > 0, js.join(", "));
} catch {
  check("a built bundle exists", false, "run `npm run build` or `npm run pack` first");
  console.log("\n0/1 passed");
  process.exit(1);
}

const whitelist =
  manifest.permissions?.find((p) => p.name === "network")?.whitelist ?? [];

check("app.json declares a network whitelist", whitelist.length > 0,
  JSON.stringify(whitelist));

// The one that would have saved three uploads.
const localhost = bundle.match(/https?:\/\/(localhost|127\.0\.0\.1)[:\d]*/g) || [];
check("the bundle does not dial localhost", localhost.length === 0,
  [...new Set(localhost)].join(", ") || "clean");

check("the bundle contains the whitelisted realtime host",
  whitelist.some((w) => bundle.includes(w)),
  whitelist.join(", "));

// A host the manifest does not permit is blocked by the WebView — the same
// silent failure one layer down, and just as invisible from outside the device.
const dialled = [...new Set(bundle.match(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/gi) || [])]
  // Source-map and schema URLs are strings in the bundle, not requests.
  .filter((u) => !/\.(map|json|xsd|dtd)$/.test(u))
  // Documentation links inside error strings, not requests. `socket.io` in
  // particular appears in the client's own protocol-mismatch message; it is
  // text the library prints, and verified as such rather than assumed.
  .filter((u) => !/(w3\.org|schema\.org|json-schema\.org|github\.com|npmjs|socket\.io\/docs|^https:\/\/socket\.io$)/i.test(u));
const offWhitelist = dialled.filter(
  (u) => !whitelist.some((w) => u.startsWith(w)),
);
check("every absolute host in the bundle is whitelisted",
  offWhitelist.length === 0, offWhitelist.join(", ") || "clean");

// Never in a package anyone can unzip.
const secrets = [
  [/xai-[A-Za-z0-9]{16,}/, "xAI key"],
  [/sk-[A-Za-z0-9]{20,}/, "OpenAI-style key"],
  [/shpat_[a-f0-9]{32}/, "Shopify admin token"],
  [/\bAIza[0-9A-Za-z_-]{20,}/, "Google API key"],
].filter(([re]) => re.test(bundle));
check("no API key is baked into the bundle", secrets.length === 0,
  secrets.map(([, n]) => n).join(", ") || "clean");

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
