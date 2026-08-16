/**
 * Emit the routes this bundle answers on as real files.
 *
 * The bundle has no router: `/here` and `/set-password` are path checks in
 * App.jsx and main.jsx, so the host has to serve index.html at those paths.
 * The obvious way is a rewrite in `vercel.json`, and those are still there —
 * but a rewrite only works if the host reads that file from the directory it
 * was written in, and when it does not, the failure is a 404 on the one route
 * a customer's phone opens.
 *
 * That already happened once, to `/here`, and the note about it went into the
 * handoff: *"the rewrite deployed and still 404'd; a file cannot be
 * misconfigured."* Then `/set-password` was added as a rewrite anyway and
 * 404'd in production in front of the first colleague we ever invited. Twice
 * is a pattern, so this file now owns every path the app answers on.
 *
 * A physical file cannot be misconfigured. Vercel serves `/here` from
 * `here.html` with no rules at all, and so does every other static host,
 * including `python -m http.server`.
 */
import { copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Every path this bundle renders something at, other than `/`. */
const ROUTES = ["here", "set-password"];

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const index = path.join(dist, "index.html");

if (!existsSync(index)) {
  // Worth failing loudly. Silently emitting nothing would ship a build whose
  // deep links 404, which is the exact failure this script exists to prevent.
  console.error("emit-routes: dist/index.html is missing — did vite build run?");
  process.exit(1);
}

for (const route of ROUTES) {
  copyFileSync(index, path.join(dist, `${route}.html`));
  console.log(`emitted dist/${route}.html`);
}
