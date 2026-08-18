/**
 * What is actually inside the Pocket build.
 *
 *   npm run build:pocket && npm run test:pocket-bundle
 *
 * The sibling of `glasses-plugin/test/packaged-bundle.test.mjs`, guarding the
 * same failure on the other surface: a bundle whose only server address is a
 * loopback one is a deployed app that talks to a laptop. It installs, it
 * renders, it signs in — and no socket ever connects, which reads to an
 * associate as "the app is broken" and to us as nothing at all.
 *
 * This assertion used to live in `pocket-browser.mjs`, where it could not be
 * true. That suite runs against `scripts/browser-suite.sh`, which deliberately
 * builds against `http://localhost:4000` so the page under test talks to the
 * local stack — so the harness falsified the very thing the check asserted,
 * and `browser-suite.sh pocket` could never pass. The property is real; it is
 * a property of a *release* build, and it belongs where one is made.
 *
 * Reads `dist/` directly. No server, no browser — which is also why it can run
 * in the cheap CI job rather than the slow one.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "dist", "assets");

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
  check("a built bundle exists", false, `no ${DIST} — run npm run build:pocket first`);
}

const loopbacks = [...new Set(bundle.match(/https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/g) || [])];
const others = [...new Set(bundle.match(/https:\/\/[a-z0-9.-]+\.(app|ai|com)/g) || [])];

check("a loopback URL is never the bundle's only server address",
  loopbacks.length === 0 || others.length > 0,
  `loopback: ${JSON.stringify(loopbacks)}, real: ${JSON.stringify(others)}`);

check("no API key is baked into the bundle",
  !/x-gapvision-key|GAPVISION_API_KEY/.test(bundle),
  "a static bundle is published; anything compiled into it is public");

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
