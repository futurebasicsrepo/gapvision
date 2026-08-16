/**
 * Emit the routes this bundle answers on as real files.
 *
 * The console has no router: `/set-password` is a path check in App.jsx, so
 * the host has to serve index.html there. The obvious way is a rewrite in
 * `vercel.json`, and it is still there — but a rewrite only works if the host
 * reads that file from the directory it was written in, and this repo already
 * learned that it does not. Studio's `/here` route failed the same way, the
 * note went into the handoff — *"the rewrite deployed and still 404'd; a file
 * cannot be misconfigured"* — and then `/set-password` was shipped as a
 * rewrite anyway and 404'd in production, in front of the first colleague we
 * ever invited.
 *
 * A physical file cannot be misconfigured.
 */
import { copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Every path this bundle renders something at, other than `/`. */
const ROUTES = ["set-password"];

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const index = path.join(dist, "index.html");

if (!existsSync(index)) {
  console.error("emit-routes: dist/index.html is missing — did vite build run?");
  process.exit(1);
}

for (const route of ROUTES) {
  copyFileSync(index, path.join(dist, `${route}.html`));
  console.log(`emitted dist/${route}.html`);
}
