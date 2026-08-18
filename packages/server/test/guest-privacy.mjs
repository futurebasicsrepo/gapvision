/**
 * What the realtime server will hand a stranger.
 *
 *   node packages/server/test/guest-privacy.mjs
 *
 * The realtime server is a public origin. Its URL is compiled into the glasses
 * bundle — `packaged-bundle.test.mjs` asserts that it is there — so every
 * route it mounts is reachable by anyone who has ever opened the plugin, and
 * "keep the URL off public pages" was never an available mitigation.
 *
 * Two routes used to take that badly.
 *
 *   1. `POST /api/guest-context` was proxied straight through with the service
 *      key attached and no authorization of the caller. Give it a guest id and
 *      it returned the whole clienteling package: name, address, contact,
 *      purchase history, sizes, tier, open cart. Nothing in the repository
 *      called it — the real path is `enterGuest()` server-side, after an
 *      actual arrival — so the fix is its absence, and this file is what keeps
 *      it absent. A convenience passthrough is exactly how it comes back.
 *
 *   2. `GET /api/guests` decided who could have a roster with `tenant !==
 *      "gap"`, which made the rule a claim about a *slug*. This checks the
 *      proxy no longer rules on it at all: it forwards, and the control plane
 *      — the only party that knows which adapter is behind the tenant —
 *      answers. `tests/test_guest_roster.py` covers the answering.
 *
 * The stub control plane below answers *everything* permissively, deliberately.
 * If a request reaches it, this test fails. That is the point: the assertion is
 * about what the realtime server forwards, and a stub that refused would let a
 * reinstated route pass by being blocked one layer further in.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const SERVER = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js",
);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** A control plane that would hand over anything. Reaching it is the failure. */
async function stubPlane() {
  const reached = [];
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    reached.push(req.url || "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      guest: {
        name: "Sarah Chen", loyalty_tier: "Icon",
        address: { city: "Austin" }, contact: { email: "sarah@example.com" },
        purchase_history: [{ sku: "GAP-DNM-0498" }],
      },
      recommendations: [], script: {},
    }));
  });
  await new Promise((r) => srv.listen(port, r));
  return { port, reached, close: () => srv.close() };
}

async function realtime(aiUrl) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), AI_SERVICE_URL: aiUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  child.stdout.on("data", (b) => log.push(String(b)));
  child.stderr.on("data", (b) => log.push(String(b)));
  let dead = false;
  child.on("exit", () => { dead = true; });
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`http://localhost:${port}/health`)).ok) break; } catch { /* not up */ }
    await sleep(250);
  }
  return { port, log, alive: () => !dead, url: `http://localhost:${port}`, close: () => child.kill() };
}

async function main() {
  const plane = await stubPlane();
  const rt = await realtime(`http://localhost:${plane.port}`);
  check("the realtime server started", rt.alive(), rt.alive() ? "" : rt.log.join("").slice(0, 300));

  // --- 1. the clienteling package is not on the public origin ---------------

  const ctx = await fetch(`${rt.url}/api/guest-context`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant: "gap", guest_id: "guest-001" }),
  });
  const body = await ctx.text();

  check("an unauthenticated guest-context call is not answered",
    ctx.status === 404,
    `HTTP ${ctx.status} — anything but 404 means the route is mounted again`);
  check("and no guest data comes back through it",
    !/Sarah Chen|sarah@example\.com|purchase_history/.test(body),
    body.replace(/\s+/g, " ").slice(0, 80));
  check("the request never reached the control plane",
    !plane.reached.some((u) => u.startsWith("/api/guest-context")),
    plane.reached.join(" ") || "(nothing forwarded)");

  // --- 2. the roster rule is not the proxy's to make ------------------------

  plane.reached.length = 0;
  await fetch(`${rt.url}/api/guests?tenant=some-real-store`);
  check("a roster request is forwarded rather than judged on its slug",
    plane.reached.some((u) => u.startsWith("/api/guests")),
    "the control plane knows which adapter is behind the tenant; the proxy does not");

  plane.reached.length = 0;
  await fetch(`${rt.url}/api/guests?tenant=gap`);
  check("and no tenant name is special-cased on the way through",
    plane.reached.some((u) => u.includes("tenant=gap")),
    "\"gap\" used to be the one slug that bypassed the check");

  rt.close();
  plane.close();

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main();
