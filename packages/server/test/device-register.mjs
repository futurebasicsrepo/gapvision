/**
 * The register handshake — a lens proving which pair of glasses it is.
 *
 *   node packages/server/test/device-register.mjs
 *
 * Runs a real realtime server against a **stub control plane**, because what
 * is being tested is the realtime server's posture toward the answers, not the
 * answers themselves (`tests/test_devices.py` covers those against Postgres).
 *
 * The four postures, in order of how badly getting them wrong would hurt:
 *
 *   1. **A refused token joins nothing.** Not the room, not the roster, not
 *      the floor. A lens that half-registers is a lens that hears other
 *      people's messages while its own store believes it was turned off.
 *   2. **The token outranks the payload.** A device minted for one retailer
 *      that names another in its register lands in the retailer the *row*
 *      says, or the whole provisioning story is decorative.
 *   3. **An unreachable control plane does not take the floor down.** That
 *      check did not exist last week; a lens must not stop working because
 *      an analytics service blinked.
 *   4. **A client with no token is unchanged.** Every G2 in the field is one.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { io } from "socket.io-client";

const SERVER = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js"
);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A port the OS just told us is free, rather than a number somebody liked.
 *  A stale server left on a fixed port answers sockets silently and the suite
 *  then reports on a stranger — an hour of a previous session went to exactly
 *  that. */
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

/**
 * The control plane, as far as the realtime server can tell.
 *
 * Two known tokens and a record of every device-auth body it was sent, so the
 * *contents* of the handshake can be asserted rather than assumed.
 */
const DEVICES = {
  "tok-alpha": { device_id: "d-alpha", user_id: "u-ann", surface: "mrbd", tenant: "t_alpha" },
  "tok-beta": { device_id: "d-beta", user_id: null, surface: "sim", tenant: "t_beta" },
};

async function stubPlane() {
  const seen = { auth: [], engagements: [] };
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const json = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const reply = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if ((req.url || "").startsWith("/api/auth/device")) {
        seen.auth.push(json);
        const device = DEVICES[json.token];
        return device ? reply(200, device) : reply(401, { detail: "Unknown device" });
      }
      if ((req.url || "").startsWith("/api/ingest/engagement/start")) {
        seen.engagements.push(json);
        return reply(201, { engagement_id: "e-1", started_at: new Date().toISOString() });
      }
      if ((req.url || "").startsWith("/api/tenant/capabilities")) {
        return reply(200, { floor_comms: true, voice: true, known: true });
      }
      if ((req.url || "").startsWith("/api/guest-context")) {
        return reply(200, { guest: { name: "Guest" }, recommendations: [], script: {} });
      }
      return reply(200, {});
    });
  });
  await new Promise((r) => srv.listen(port, r));
  return { port, seen, close: () => srv.close() };
}

/** A realtime server pointed at a given control plane (or at nothing). */
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
  return {
    port, log, child,
    // Asserted before anything else runs: sockets against a dead server
    // connect to whatever else is on that port, and the suite then passes or
    // fails on a stranger.
    alive: () => !dead,
    url: `http://localhost:${port}`,
    close: () => child.kill(),
  };
}

function connect(url, auth) {
  return new Promise((resolve, reject) => {
    const s = io(url, { transports: ["websocket"], reconnection: false, auth });
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
  });
}

async function main() {
  const plane = await stubPlane();
  const rt = await realtime(`http://localhost:${plane.port}`);
  check("the realtime server started", rt.alive(),
    rt.alive() ? "" : rt.log.join("").slice(0, 300));

  // --- 1. a good token, and the tenant it really belongs to -----------------

  const lens = await connect(rt.url, {
    token: "tok-alpha", tenant: "t_alpha",
    surface: "mrbd-webapp", app_version: "0.2.0", mode: "meta",
  });
  const dash = await connect(rt.url);
  const snaps = [];
  dash.on("dashboard:update", (s) => snaps.push(s));
  dash.emit("register", { role: "dashboard", tenant: "t_alpha" });
  await sleep(200);

  lens.emit("register", {
    role: "associate", name: "Ann", zone: "Denim", tenant: "t_alpha",
    surface: "mrbd-webapp", appVersion: "0.2.0",
  });
  await sleep(400);

  // The handshake is resolved before the first event is delivered, so by the
  // time `register` has been handled the token has already been checked. No
  // sleep in this suite is load-bearing for that — it is a property of where
  // the resolution happens.
  check("the token is checked at handshake, before any event is delivered",
    plane.seen.auth.length >= 1 && plane.seen.auth[0]?.token === "tok-alpha",
    JSON.stringify(plane.seen.auth[0]));

  check("a provisioned lens is on the floor",
    snaps.at(-1)?.associates?.some((a) => a.name === "Ann"),
    JSON.stringify(snaps.at(-1)?.associates || []));

  const authCall = plane.seen.auth.at(-1);
  check("the token is presented to the control plane, not trusted locally",
    authCall?.token === "tok-alpha", JSON.stringify(authCall));
  check("`mrbd-webapp` is normalised to the value the database accepts",
    authCall?.meta?.surface === "mrbd", JSON.stringify(authCall?.meta));
  check("the build and mode ride along as diagnostics",
    authCall?.meta?.app_version === "0.2.0" && authCall?.meta?.mode === "meta",
    JSON.stringify(authCall?.meta));

  // --- 2. the token outranks the payload ------------------------------------

  const liar = await connect(rt.url, { token: "tok-beta", tenant: "t_alpha" });
  const betaDash = await connect(rt.url);
  const betaSnaps = [];
  betaDash.on("dashboard:update", (s) => betaSnaps.push(s));
  betaDash.emit("register", { role: "dashboard", tenant: "t_beta" });
  await sleep(200);
  liar.emit("register", { role: "associate", name: "Ben", tenant: "t_alpha" });
  await sleep(400);

  check("a device minted for one retailer lands in that retailer, not the one it named",
    betaSnaps.at(-1)?.associates?.some((a) => a.name === "Ben"),
    JSON.stringify(betaSnaps.at(-1)?.associates || []));
  check("and does not appear on the floor it claimed",
    !snaps.at(-1)?.associates?.some((a) => a.name === "Ben"),
    JSON.stringify(snaps.at(-1)?.associates || []));

  // --- 3. a refused token joins nothing -------------------------------------

  const stranger = await connect(rt.url, { token: "tok-nonsense", tenant: "t_alpha" });
  let refused = null;
  const overheard = [];
  stranger.on("register:refused", (m) => { refused = m; });
  stranger.on("radio:message", (m) => overheard.push(m));
  stranger.emit("register", { role: "associate", name: "Mallory", tenant: "t_alpha" });
  await sleep(400);

  check("a refused lens is told why", refused?.reason === "not_provisioned",
    JSON.stringify(refused));
  check("a refused lens is not on the roster",
    !snaps.at(-1)?.associates?.some((a) => a.name === "Mallory"),
    JSON.stringify(snaps.at(-1)?.associates || []));

  lens.emit("radio:send", { message: "fitting room two please" });
  await sleep(400);
  check("a refused lens does not hear the floor it was refused from",
    overheard.length === 0, JSON.stringify(overheard));

  // --- 4. attribution -------------------------------------------------------

  lens.emit("beacon:guest-enter", { guestId: "g-1", zone: "Denim", tenant: "t_alpha" });
  await sleep(600);
  const engagement = plane.seen.engagements.at(-1);
  check("the engagement carries the device it came through",
    engagement?.device_id === "d-alpha", JSON.stringify(engagement || {}));

  for (const s of [lens, dash, liar, betaDash, stranger]) s.close();
  rt.close();
  plane.close();
  await sleep(200);

  // --- 5. a client with no token, and a control plane that is not there -----
  //
  // Both are the *same* posture — register as before — and both matter: one is
  // every G2 in the field today, the other is an outage. A check that did not
  // exist last week must not be able to take a shop floor offline.

  const dark = await realtime("http://127.0.0.1:9");   // discard port: nothing listens
  check("the offline-control-plane server started", dark.alive(),
    dark.alive() ? "" : dark.log.join("").slice(0, 300));

  const noToken = await connect(dark.url);
  const darkDash = await connect(dark.url);
  const darkSnaps = [];
  darkDash.on("dashboard:update", (s) => darkSnaps.push(s));
  darkDash.emit("register", { role: "dashboard", tenant: "t_alpha" });
  await sleep(200);
  noToken.emit("register", { role: "associate", name: "Legacy G2", tenant: "t_alpha" });
  await sleep(300);
  check("a client that sends no token registers exactly as before",
    darkSnaps.at(-1)?.associates?.some((a) => a.name === "Legacy G2"),
    JSON.stringify(darkSnaps.at(-1)?.associates || []));

  const unverifiable = await connect(dark.url, { token: "tok-alpha" });
  unverifiable.emit("register", { role: "associate", name: "Unverifiable", tenant: "t_alpha" });
  await sleep(1500);   // the fetch has to fail first
  check("a lens whose token cannot be checked still works, unattributed",
    darkSnaps.at(-1)?.associates?.some((a) => a.name === "Unverifiable"),
    JSON.stringify(darkSnaps.at(-1)?.associates || []));

  for (const s of [noToken, darkDash, unverifiable]) s.close();
  dark.close();

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
