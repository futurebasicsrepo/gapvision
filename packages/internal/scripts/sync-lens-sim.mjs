/**
 * Build the Lens Sim into Console's own origin.
 *
 *   npm run lens-sim:sync
 *
 * The sim is not a mock of the Meta lens — it is the identical bundle the
 * glasses run, drawn in an iframe at 600×600 with a driver panel around it. So
 * it cannot be reimplemented here; it has to be *the* build, copied in.
 *
 * **Same-origin is the whole design.** `sim.html` drives the lens over
 * postMessage, and the bridge accepts messages from its own origin only —
 * deliberately, because a page that could iframe the lens cross-origin could
 * drive somebody's glasses. Serving it from Console's own origin under
 * `/lens-sim/` is what keeps that restriction intact while still letting
 * Console embed it. Do not loosen the bridge to embed it from anywhere else.
 *
 * Same shape as `sync-docs.mjs` and for the same reason: Vercel builds this
 * package from `packages/internal`, so nothing here may reach outside that
 * directory at *bundle* time. This runs before Vite and leaves a plain static
 * directory behind.
 *
 * **This never fails the Console build.** If the sim cannot be built — a
 * workspace that was not installed, a Vercel image that only installed this
 * package — the panel gets a page saying so and the deploy continues. A
 * console that will not deploy because a demo harness would not compile is a
 * worse outcome than a console with one panel that explains itself.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const META = join(PKG, "..", "meta-lens");
const DIST = join(META, "dist");
const OUT = join(PKG, "public", "lens-sim");

/** A page that says what happened, rather than a 404 that says nothing. */
const PLACEHOLDER = (why) => `<!doctype html>
<meta charset="utf-8">
<title>Lens Sim unavailable</title>
<style>
  body { margin: 0; display: grid; place-items: center; min-height: 100vh;
         background: #0F1419; color: #C7CFD8;
         font: 14px/1.6 ui-sans-serif, system-ui, sans-serif; }
  div { max-width: 34rem; padding: 2rem; text-align: center; }
  code { font-family: ui-monospace, monospace; color: #8FB8CC; }
</style>
<div>
  <p><strong>The Lens Sim was not built into this deployment.</strong></p>
  <p>${why}</p>
  <p>Run <code>npm run lens-sim:sync</code> in <code>packages/internal</code>,
     or <code>npm run dev:meta</code> and open <code>/sim.html</code> directly.</p>
</div>
`;

function fallback(why) {
  console.warn(`lens-sim  SKIPPED — ${why}`);
  mkdirSync(OUT, { recursive: true });
  for (const page of ["sim.html", "index.html"]) {
    writeFileSync(join(OUT, page), PLACEHOLDER(why));
  }
}

try {
  if (!existsSync(META)) {
    fallback("packages/meta-lens is not present in this checkout.");
  } else {
    execFileSync("npm", ["run", "build"], { cwd: META, stdio: "inherit" });
    if (!existsSync(join(DIST, "sim.html"))) {
      throw new Error("the build produced no sim.html");
    }
    // Replaced wholesale rather than merged: a stale asset left behind from a
    // previous build is a file nobody can explain the provenance of.
    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(OUT, { recursive: true });
    cpSync(DIST, OUT, { recursive: true });
    console.log("lens-sim  packages/meta-lens/dist -> public/lens-sim/");
  }
} catch (err) {
  fallback(`The build failed: ${err.message}`);
}
