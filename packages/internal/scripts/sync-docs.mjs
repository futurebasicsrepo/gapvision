/**
 * Copy the reference docs into the Console bundle.
 *
 *   npm run docs:sync
 *
 * The docs live at the repo root and in `docs/`, beside the code they describe,
 * because that is where they get updated — a doc in a different tree than the
 * thing it documents goes stale on the first busy afternoon. But Vercel builds
 * this package from `packages/internal`, so a Vite import reaching outside it
 * is a build that works locally and fails on deploy.
 *
 * So: copy in, with a banner, and never edit the copy. Same pattern the brand
 * tokens already use (`packages/brand/build.mjs`), for the same reason.
 *
 * Runs as part of `npm run build` in this package, so a deploy cannot ship a
 * stale copy even if somebody forgets.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const ROOT = join(PKG, "..", "..");
const OUT = join(PKG, "src", "docs");

const DOCS = [
  { from: join(ROOT, "FEATURES.md"), to: "features.md" },
  { from: join(ROOT, "docs", "onboarding.md"), to: "onboarding.md" },
];

const BANNER = (src) =>
  `<!-- GENERATED — do not edit. Source: ${src}. Run \`npm run docs:sync\`. -->\n\n`;

mkdirSync(OUT, { recursive: true });
for (const d of DOCS) {
  const body = readFileSync(d.from, "utf8");
  writeFileSync(join(OUT, d.to), BANNER(d.from.replace(ROOT + "/", "")) + body);
  console.log(`docs:sync  ${d.from.replace(ROOT + "/", "")} -> src/docs/${d.to}`);
}
