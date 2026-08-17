/**
 * The BYOD handshake — an associate's own phone, and the store staying off it.
 *
 *   node packages/server/test/phone-byod.mjs
 *
 * Same shape as `device-register.mjs`: a real realtime server against a stub
 * control plane, because what is under test is the server's *posture* toward
 * the answers rather than the answers themselves.
 *
 * Four properties, in order of how badly getting one wrong would hurt:
 *
 *   1. **A socket offering both a provision token and a personal session is
 *      refused.** That combination is the exact state the phone surface was
 *      designed to make unreachable — a credential that authenticates as the
 *      store, living on a handset that walks out of the building. The client
 *      will not send it; that is not a reason for the server to accept it.
 *   2. **A personal session gets no device identity.** Activity from somebody's
 *      own phone is attributed to a human and to no hardware. A synthetic
 *      device row would put the thing we refused to create back in the fleet
 *      list under a name nobody can revoke.
 *   3. **The resolved person outranks the register payload.** `email` and
 *      `name` on a register frame are strings a client chose. When the control
 *      plane has vouched for who this is, attribution must not rest on the
 *      weaker of the two — attributed sales are the number the product is sold
 *      on.
 *   4. **A revoked or expired session joins nothing.** Same posture as a
 *      refused device: not the room, not the roster, not the floor.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { io } from "socket.io-client";

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

/** One live session and one device token, so both doors can be exercised. */
const SESSIONS = {
  "sess-good": { user_id: "u-sam", name: "Sam Okonkwo", email: "sam@shop.example",
                 role: "associate", tenant: "t_alpha" },
};
const DEVICES = {
  "tok-handheld": { device_id: "d-till2", user_id: null, surface: "phone", tenant: "t_alpha" },
};

async function stubPlane() {
  const seen = { device: [], associate: [], engagements: [] };
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
      const url = req.url || "";
      if (url.startsWith("/api/auth/associate")) {
        seen.associate.push(json);
        const person = SESSIONS[json.session];
        // The real route refuses a session pointed at another shop rather than
        // silently correcting it; the stub mirrors that so the suite is not
        // testing a friendlier server than the one that ships.
        if (!person) return reply(401, { detail: "Not authenticated" });
        if (json.tenant && json.tenant !== person.tenant) {
          return reply(401, { detail: "Not authenticated" });
        }
        return reply(200, person);
      }
      if (url.startsWith("/api/auth/device")) {
        seen.device.push(json);
        const d = DEVICES[json.token];
        return d ? reply(200, d) : reply(401, { detail: "Unknown device" });
      }
      if (url.startsWith("/api/ingest/engagement/start")) {
        seen.engagements.push(json);
        return reply(201, { engagement_id: "e-1", started_at: new Date().toISOString() });
      }
      if (url.startsWith("/api/tenant/capabilities")) {
        return reply(200, { floor_comms: true, voice: true, known: true });
      }
      if (url.startsWith("/api/guest-context")) {
        return reply(200, { guest: { name: "Guest" }, recommendations: [], script: {} });
      }
      return reply(200, {});
    });
  });
  await new Promise((r) => srv.listen(port, r));
  return { port, seen, close: () => srv.close() };
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
  check("the realtime server started", rt.alive(), rt.alive() ? "" : rt.log.join("").slice(0, 300));

  const dash = await connect(rt.url);
  const snaps = [];
  dash.on("dashboard:update", (s) => snaps.push(s));
  dash.emit("register", { role: "dashboard", tenant: "t_alpha" });
  await sleep(200);
  const floor = () => snaps.at(-1)?.associates || [];

  // --- 1. the forbidden combination ----------------------------------------

  const bothRefusals = [];
  const both = await connect(rt.url, {
    session: "sess-good", token: "tok-handheld", tenant: "t_alpha", surface: "phone",
  });
  both.on("register:refused", (r) => bothRefusals.push(r));
  both.emit("register", { role: "associate", name: "Both", tenant: "t_alpha", surface: "phone" });
  await sleep(400);

  check("a socket presenting BOTH a device token and a personal session is refused",
    bothRefusals.length === 1, JSON.stringify(bothRefusals));
  // "we do not know this device" and "that combination is not allowed" send an
  // associate to two different next actions, so they must not arrive as the
  // same word.
  check("and the refusal says which rule it broke",
    bothRefusals[0]?.reason === "conflicting_identity", JSON.stringify(bothRefusals));
  // Asserted as "the floor is empty", not "the floor lacks a socket called
  // Both". Nothing else has registered as an associate yet, and the weaker
  // form passes even when the guard is deleted — the refused socket simply
  // joins under the *resolved* name rather than the one it asked for, which
  // is the failure wearing a different label.
  check("and joins nothing — not the room, not the roster, not the floor",
    floor().length === 0, JSON.stringify(floor()));
  check("neither credential is even sent upstream for that socket",
    !plane.seen.associate.some((c) => c.session === "sess-good" && c.tenant === "t_alpha"
      && plane.seen.device.some((d) => d.token === "tok-handheld")),
    "the refusal is local and total");

  // --- 2. a personal phone, signed in --------------------------------------

  const phone = await connect(rt.url, {
    session: "sess-good", tenant: "t_alpha", surface: "phone", app_version: "0.1.0",
  });
  // The register frame deliberately carries a *different* name and email from
  // the session, which is what a compromised or simply stale client would send.
  phone.emit("register", {
    role: "associate", name: "Not Sam", email: "someone.else@shop.example",
    zone: "Denim", tenant: "t_alpha", surface: "phone", appVersion: "0.1.0",
  });
  await sleep(400);

  check("a personal session is resolved against the control plane, not trusted locally",
    plane.seen.associate.some((c) => c.session === "sess-good"),
    JSON.stringify(plane.seen.associate));
  check("no device token is minted or presented for a personal phone",
    !plane.seen.device.some((d) => d.token === "sess-good"),
    JSON.stringify(plane.seen.device));

  check("the phone is on the floor under the name the CONTROL PLANE gave, not the payload's",
    floor().some((a) => a.name === "Sam Okonkwo"), JSON.stringify(floor()));
  check("and the name the client asked for is nowhere on the roster",
    !floor().some((a) => a.name === "Not Sam"), JSON.stringify(floor()));

  // --- 3. attribution rides the session, not the register frame ------------

  const guest = await connect(rt.url, { session: "sess-good", tenant: "t_alpha", surface: "phone" });
  guest.emit("register", {
    role: "associate", name: "Whoever", email: "spoofed@shop.example", tenant: "t_alpha",
  });
  await sleep(200);
  guest.emit("beacon:guest-enter", { guestId: "g-1", tenant: "t_alpha", zone: "Denim" });
  await sleep(600);

  const started = plane.seen.engagements.at(-1);
  check("an engagement is attributed to the signed-in associate",
    started?.associate_email === "sam@shop.example", JSON.stringify(started));
  check("and never to the email the client put in its own register frame",
    started?.associate_email !== "spoofed@shop.example", JSON.stringify(started));

  // --- 4. a session that is no longer good ---------------------------------

  const staleRefusals = [];
  const stale = await connect(rt.url, { session: "sess-revoked", tenant: "t_alpha", surface: "phone" });
  stale.on("register:refused", (r) => staleRefusals.push(r));
  stale.emit("register", { role: "associate", name: "Stale", tenant: "t_alpha" });
  await sleep(400);

  check("a revoked or expired session is refused", staleRefusals.length === 1,
    JSON.stringify(staleRefusals));
  check("and is named as a session problem, not a device one",
    staleRefusals[0]?.reason === "session_invalid", JSON.stringify(staleRefusals));
  check("and joins nothing", !floor().some((a) => a.name === "Stale"), JSON.stringify(floor()));

  // --- 5. a session pointed at the wrong shop ------------------------------

  const wrongRefusals = [];
  const wrong = await connect(rt.url, { session: "sess-good", tenant: "t_beta", surface: "phone" });
  wrong.on("register:refused", (r) => wrongRefusals.push(r));
  wrong.emit("register", { role: "associate", name: "Wrong Shop", tenant: "t_beta" });
  await sleep(400);
  check("a session pointed at another retailer is refused rather than quietly corrected",
    wrongRefusals.length === 1, JSON.stringify(wrongRefusals));

  // --- 6. a store handheld still works, and still has a device -------------

  const handheld = await connect(rt.url, {
    token: "tok-handheld", tenant: "t_alpha", surface: "phone",
  });
  handheld.emit("register", { role: "associate", name: "Till 2", tenant: "t_alpha", surface: "phone" });
  await sleep(400);
  check("a store-owned handheld provisions the ordinary way and lands on the floor",
    floor().some((a) => a.name === "Till 2"), JSON.stringify(floor()));
  check("`phone` is a surface the server accepts rather than discards",
    plane.seen.device.some((d) => d.token === "tok-handheld" && d.meta?.surface === "phone"),
    JSON.stringify(plane.seen.device.at(-1)?.meta));

  for (const s of [dash, both, phone, guest, stale, wrong, handheld]) s.close();
  rt.close();
  plane.close();

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
