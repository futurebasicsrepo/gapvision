/**
 * The deck follows the person, not the handset.
 *
 *   node packages/server/test/widget-prefs.mjs
 *
 * A real realtime server against a stub control plane, same shape as
 * `device-register.mjs` and `phone-byod.mjs`.
 *
 * Three properties, in order of how badly getting one wrong would hurt:
 *
 *   1. **A save is attributed from the device's own token, never from the
 *      payload.** The phone holds no session — it cannot prove who it is — so
 *      a client naming its own user id would be a client that can rewrite a
 *      colleague's layout.
 *   2. **A device assigned to nobody writes nothing.** There is no person
 *      whose preference it would be, and inventing one attaches a deck to a
 *      handset, which is the thing this change moved away from.
 *   3. **Silence is not an empty deck.** A server that sent no prefs must
 *      leave the phone's local copy alone; emitting an empty one would wipe a
 *      good layout on a device whose person is simply unassigned.
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

const DEVICES = {
  "tok-sam": {
    device_id: "d-sam", user_id: "u-sam", surface: "even-g2", tenant: "t_alpha",
    widget_prefs: { order: ["messaging", "customer"] },
  },
  // Assigned to nobody: a shared pair off the charger.
  "tok-shared": { device_id: "d-shared", user_id: null, surface: "even-g2", tenant: "t_alpha" },
};

async function stubPlane() {
  const seen = { prefsWrites: [] };
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
      if (url.startsWith("/api/auth/device")) {
        const d = DEVICES[json.token];
        return d ? reply(200, d) : reply(401, { detail: "Unknown device" });
      }
      if (url.startsWith("/api/tenant/widget-prefs")) {
        seen.prefsWrites.push(json);
        return reply(200, { prefs: json.prefs });
      }
      if (url.startsWith("/api/tenant/capabilities")) {
        return reply(200, { floor_comms: true, voice: true, widgets: true, known: true });
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

  // --- 1. the deck arrives with the identity that determines it -------------

  const sam = await connect(rt.url, { token: "tok-sam", tenant: "t_alpha" });
  const got = [];
  sam.on("widgets:prefs", (m) => got.push(m));
  sam.emit("register", { role: "associate", name: "Sam", tenant: "t_alpha" });
  await sleep(400);

  check("an assigned device is sent the person's deck",
    got.length === 1 && got[0]?.prefs?.order?.join(",") === "messaging,customer",
    JSON.stringify(got));

  // --- 2. a save is attributed from the token, not the payload --------------

  sam.emit("widgets:save", {
    prefs: { order: ["customer"] },
    // What a compromised or simply confused client would send. It must have
    // no effect whatsoever on who the write lands against.
    user_id: "u-somebody-else",
  });
  await sleep(400);

  const write = plane.seen.prefsWrites.at(-1);
  check("a save reaches the control plane", !!write, JSON.stringify(plane.seen.prefsWrites));
  check("attributed to the device's own person, never to the payload's",
    write?.user_id === "u-sam", JSON.stringify(write));
  check("and carries the order that was sent",
    write?.prefs?.order?.join(",") === "customer", JSON.stringify(write));

  // --- 3. a device assigned to nobody ---------------------------------------

  const sharedGot = [];
  const shared = await connect(rt.url, { token: "tok-shared", tenant: "t_alpha" });
  shared.on("widgets:prefs", (m) => sharedGot.push(m));
  shared.emit("register", { role: "associate", name: "Shared", tenant: "t_alpha" });
  await sleep(400);

  check("an unassigned device is sent no deck, so its local copy stands",
    sharedGot.length === 0, JSON.stringify(sharedGot));

  const before = plane.seen.prefsWrites.length;
  shared.emit("widgets:save", { prefs: { order: ["inventory"] } });
  await sleep(400);
  check("and a save from it writes nothing, rather than inventing a person",
    plane.seen.prefsWrites.length === before,
    JSON.stringify(plane.seen.prefsWrites.slice(before)));

  // --- 4. a client with no device identity at all ---------------------------

  const anon = await connect(rt.url);
  anon.emit("register", { role: "associate", name: "Legacy", tenant: "t_alpha" });
  await sleep(200);
  const beforeAnon = plane.seen.prefsWrites.length;
  anon.emit("widgets:save", { prefs: { order: ["customer"] } });
  await sleep(300);
  check("a client with no device identity cannot write a deck either",
    plane.seen.prefsWrites.length === beforeAnon);

  for (const s of [sam, shared, anon]) s.close();
  rt.close();
  plane.close();

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
