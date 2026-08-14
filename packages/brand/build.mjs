/**
 * Generate each app's brand assets from the canonical tokens.
 *
 *   node packages/brand/build.mjs      (or: npm run brand:sync)
 *
 * Why generate rather than share an import: every frontend is its own Vercel
 * project with its own root directory, so anything a build needs has to live
 * inside that package. Generated files are committed for exactly that reason.
 *
 * The trade this makes is that `packages/brand/tokens.json` is the only place
 * a hex value may be edited. If you change a generated brand.css by hand, the
 * next sync silently reverts it — hence the header on every output.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const tokens = JSON.parse(readFileSync(join(here, "tokens.json"), "utf8"));

/** Apps that need the tokens. `data: true` also gets tokens.json, for the
 *  console's Brand panel — it renders the system rather than restating it. */
const TARGETS = [
  { dir: "packages/web/src", data: false },
  { dir: "packages/internal/src", data: true },
];

const BANNER = `/**
 * cuesea — brand tokens.  GENERATED — DO NOT EDIT.
 *
 * Source: packages/brand/tokens.json (v${tokens.version}, ${tokens.updated})
 * Regenerate: npm run brand:sync
 *
 * The rules that are not negotiable, kept here so they're visible at the
 * point of use rather than in a PDF nobody opens:
 *
${tokens.ramps.map((r) => ` *   · ${r.rule}`).join("\n")}
 */
`;

function css() {
  const out = [BANNER, "\n:root {"];
  for (const ramp of tokens.ramps) {
    out.push(`\n  /* --- ${ramp.key}: ${ramp.role} */`);
    const width = Math.max(...ramp.steps.map((s) => s.token.length));
    for (const s of ramp.steps) {
      const decl = `  ${s.token.padEnd(width)}: ${s.hex};`;
      out.push(s.note ? `${decl.padEnd(38)} /* ${s.note} */` : decl);
    }
  }

  out.push("\n  /* --- type --- */");
  for (const f of tokens.type.faces) {
    out.push(`  ${f.token}: ${f.stack};`);
  }

  out.push("\n  --radius: 10px;\n}");

  for (const [key, surface] of Object.entries(tokens.surfaces)) {
    out.push(`\n/**\n * ${surface.label}\n * ${surface.note}\n */`);
    // Studio and the Console share one surface definition — they are the same
    // dense sea-toned UI, and the day they drift is the day someone has to
    // learn two systems to work in both.
    out.push(`${(surface.selectors || [`.${key}`]).join(", ")} {`);
    for (const [k, v] of Object.entries(surface.vars)) out.push(`  ${k}: ${v};`);
    out.push("}");
  }
  return out.join("\n") + "\n";
}

const sheet = css();
let wrote = 0;

for (const target of TARGETS) {
  const dir = join(root, target.dir);
  if (!existsSync(dir)) {
    console.log(`skip  ${target.dir} (not present)`);
    continue;
  }
  writeFileSync(join(dir, "brand.css"), sheet);
  wrote++;

  mkdirSync(join(dir, "components"), { recursive: true });
  copyFileSync(join(here, "Mark.jsx"), join(dir, "components", "Mark.jsx"));
  wrote++;

  if (target.data) {
    writeFileSync(join(dir, "brand-tokens.json"), JSON.stringify(tokens, null, 2) + "\n");
    wrote++;
  }
  console.log(`wrote ${target.dir}`);
}

console.log(`\n${wrote} file(s) from tokens.json v${tokens.version}`);
