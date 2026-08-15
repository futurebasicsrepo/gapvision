/**
 * Emit `dist/here.html` — the guest page as a real file.
 *
 * The bundle has no router: `/here` is a path check in main.jsx, so the host
 * has to serve index.html at that path. The obvious way is a rewrite in
 * `vercel.json`, and that is still there — but a rewrite only works if the
 * host reads that file from the directory it was written in, and when it does
 * not, the failure is a 404 on the one route a customer's phone opens.
 *
 * A physical file cannot be misconfigured. Vercel serves `/here` from
 * `here.html` with no rules at all, and so does every other static host,
 * including `python -m http.server`.
 */
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
copyFileSync(path.join(dist, "index.html"), path.join(dist, "here.html"));
console.log("emitted dist/here.html");
