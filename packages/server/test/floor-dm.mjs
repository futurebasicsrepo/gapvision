/**
 * Addressed messages on the floor channel.
 *
 * The floor is one stream and a message may carry a `to`. Everything here
 * guards the difference between the two shapes, because the failure modes are
 * not "the message didn't arrive" — they are "it arrived at the wrong people",
 * "it arrived silently at nobody", and "a keyboard took over somebody's
 * display". A DM that leaks is worse than a DM that fails.
 *
 *   node packages/server/test/floor-dm.mjs
 *
 * Starts its own server on an unused port. No AI service required.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { io } from "socket.io-client";

const PORT = process.env.TEST_PORT || 4124;
const URL = `http://localhost:${PORT}`;
const SERVER = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js"
);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
const serverLog = [];
child.stdout.on("data", (b) => serverLog.push(String(b)));
child.stderr.on("data", (b) => serverLog.push(String(b)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = () => new Promise((resolve, reject) => {
  const s = io(URL, { transports: ["websocket"], reconnection: false });
  s.on("connect", () => resolve(s));
  s.on("connect_error", reject);
});

async function main() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${URL}/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await sleep(250);
  }

  // One store with three associates and a manager, and a second store whose
  // only job is to not hear any of it.
  const ann = await connect();
  const ben = await connect();
  const cass = await connect();
  const mgr = await connect();
  const otherAssoc = await connect();

  const heard = { ann: [], ben: [], cass: [], other: [] };
  const snaps = { alpha: [] };
  const rosters = { ann: [] };
  const receipts = { delivered: [], undelivered: [] };
  let annId = null;

  ann.on("radio:message", (m) => heard.ann.push(m));
  ben.on("radio:message", (m) => heard.ben.push(m));
  cass.on("radio:message", (m) => heard.cass.push(m));
  otherAssoc.on("radio:message", (m) => heard.other.push(m));
  mgr.on("dashboard:update", (s) => snaps.alpha.push(s));
  ann.on("roster:update", (r) => rosters.ann.push(r.roster));
  ann.on("roster:you", (y) => { annId = y.id; });
  ann.on("radio:delivered", (r) => receipts.delivered.push(r));
  ann.on("radio:undelivered", (r) => receipts.undelivered.push(r));

  ann.emit("register", { role: "associate", name: "Ann", zone: "Denim", tenant: "t_alpha" });
  ben.emit("register", { role: "associate", name: "Ben", zone: "Fitting", tenant: "t_alpha" });
  cass.emit("register", { role: "associate", name: "Cass", zone: "Till", tenant: "t_alpha" });
  mgr.emit("register", { role: "dashboard", name: "Mia Manager", tenant: "t_alpha" });
  otherAssoc.emit("register", { role: "associate", name: "Other Olly", tenant: "t_beta" });
  await sleep(400);

  // --- the roster reaches the phone -----------------------------------------
  const lastRoster = rosters.ann.at(-1) || [];
  check("an associate is pushed the roster", lastRoster.length === 3,
    JSON.stringify(lastRoster.map((r) => r.name)));
  check("the roster carries name, zone and id, and nothing else",
    lastRoster.every((r) => Object.keys(r).sort().join(",") === "id,name,zone"),
    JSON.stringify(lastRoster[0]));
  check("the roster does not carry the other store's people",
    !lastRoster.some((r) => r.name === "Other Olly"));

  const benId = lastRoster.find((r) => r.name === "Ben")?.id;
  const cassId = lastRoster.find((r) => r.name === "Cass")?.id;
  check("register hands an associate their own id back", typeof annId === "string" && annId.length > 0);

  // --- an addressed message reaches one person ------------------------------
  const before = { ben: heard.ben.length, cass: heard.cass.length };
  ann.emit("radio:send", { to: benId, message: "can you take fitting room 3" });
  await sleep(300);

  check("an addressed message reaches its target",
    heard.ben.length === before.ben + 1,
    JSON.stringify(heard.ben.map((m) => m.message)));
  check("an addressed message reaches nobody else on the floor",
    heard.cass.length === before.cass,
    heard.cass.length !== before.cass ? `LEAKED: ${JSON.stringify(heard.cass.at(-1))}` : "");
  check("an addressed message cannot cross stores",
    heard.other.length === 0,
    heard.other.length ? `LEAKED: ${JSON.stringify(heard.other)}` : "");
  check("the sender gets their own echo",
    heard.ann.some((m) => m.message === "can you take fitting room 3"));
  check("the message carries the address, so the lens can mark it",
    heard.ben.at(-1)?.to === benId && heard.ben.at(-1)?.toName === "Ben",
    JSON.stringify(heard.ben.at(-1)));
  check("the sender's name comes off the roster, not the payload",
    heard.ben.at(-1)?.from === "Ann");

  // --- receipts -------------------------------------------------------------
  check("the sender is told it was delivered",
    receipts.delivered.at(-1)?.toName === "Ben",
    JSON.stringify(receipts.delivered.at(-1)));

  ann.emit("radio:send", { to: "a-socket-that-left", message: "still there?" });
  await sleep(250);
  check("a send to somebody who left fails visibly rather than silently",
    receipts.undelivered.at(-1)?.reason === "not_on_floor",
    JSON.stringify(receipts.undelivered.at(-1)));
  check("a failed send reaches nobody",
    !heard.ben.some((m) => m.message === "still there?")
      && !heard.cass.some((m) => m.message === "still there?"));

  // --- the manager's mirror -------------------------------------------------
  // A broadcast is openly shared and belongs in the mirror. A DM does not.
  const snapAfterDm = snaps.alpha.at(-1);
  check("a DM body is not mirrored to the dashboard",
    !JSON.stringify(snapAfterDm?.radioLog || []).includes("fitting room 3"),
    JSON.stringify(snapAfterDm?.radioLog || []));
  check("a DM is still counted, so the floor's volume stays honest",
    (snapAfterDm?.stats?.radioMessages || 0) >= 1,
    String(snapAfterDm?.stats?.radioMessages));

  ann.emit("radio:send", { message: "anyone free for a size check" });
  await sleep(300);
  check("a broadcast still reaches the whole floor",
    heard.ben.some((m) => m.message === "anyone free for a size check")
      && heard.cass.some((m) => m.message === "anyone free for a size check"));
  check("a broadcast is still mirrored to the dashboard",
    JSON.stringify(snaps.alpha.at(-1)?.radioLog || []).includes("size check"));

  // --- the urgent tier is not the client's to claim -------------------------
  ann.emit("radio:send", { to: cassId, message: "please come here now", priority: "urgent" });
  await sleep(250);
  check("typed prose cannot claim the urgent tier",
    heard.cass.at(-1)?.priority === "normal",
    JSON.stringify(heard.cass.at(-1)));

  ann.emit("radio:send", { message: "NEED BACKUP", priority: "urgent" });
  await sleep(250);
  check("the canned backup call still is urgent",
    heard.ben.at(-1)?.priority === "urgent",
    JSON.stringify(heard.ben.at(-1)));

  ann.emit("radio:send", { to: cassId, message: "NEED BACKUP", priority: "urgent" });
  await sleep(250);
  check("the canned backup call is urgent when addressed too",
    heard.cass.at(-1)?.priority === "urgent" && heard.cass.at(-1)?.to === cassId,
    JSON.stringify(heard.cass.at(-1)));

  // --- a manager sends from Studio ------------------------------------------
  const mgrBefore = heard.ben.length;
  mgr.emit("radio:send", { to: benId, message: "take the queue when you can", from: "Someone Else" });
  await sleep(300);
  check("a manager can address one associate from Studio",
    heard.ben.length === mgrBefore + 1,
    JSON.stringify(heard.ben.at(-1)));
  check("the manager's name is the one pinned at register, not the payload",
    heard.ben.at(-1)?.from === "Mia Manager",
    JSON.stringify(heard.ben.at(-1)?.from));

  mgr.emit("radio:send", { to: benId, message: "NEED BACKUP", priority: "urgent" });
  await sleep(250);
  check("a manager cannot take over a display, even with the canned phrase",
    heard.ben.at(-1)?.priority === "normal",
    JSON.stringify(heard.ben.at(-1)));

  // A manager who can send but cannot be answered is a broadcast with extra
  // steps — and worse than that, the plugin clears a message from the inbox
  // when it replies, so a dropped reply loses the question too.
  const mgrHeard = [];
  mgr.on("radio:message", (m) => mgrHeard.push(m));
  const mgrId = heard.ben.at(-1)?.fromId;
  ben.emit("radio:send", { to: mgrId, message: "on it" });
  await sleep(300);
  check("an associate can reply to a manager's message",
    mgrHeard.some((m) => m.message === "on it"),
    JSON.stringify(mgrHeard.map((m) => m.message)));
  check("a reply to a manager reaches nobody else",
    !heard.cass.some((m) => m.message === "on it"));

  // --- an unregistered socket is not handed a roster ------------------------
  // The plugin's own `roster:list` is buffered and flushed before register, so
  // an unguarded handler would answer it with the demo tenant's people.
  const stranger = await connect();
  const strangerRosters = [];
  stranger.on("roster:update", (r) => strangerRosters.push(r.roster));
  stranger.emit("roster:list");
  await sleep(300);
  check("a socket that has not registered gets no roster at all",
    strangerRosters.length === 0,
    JSON.stringify(strangerRosters));
  stranger.close();

  // --- an address in another store resolves to nobody -----------------------
  const otherId = "definitely-not-in-this-tenant";
  otherAssoc.emit("radio:send", { to: benId, message: "cross-store attempt" });
  await sleep(300);
  check("an id from another store cannot be addressed",
    !heard.ben.some((m) => m.message === "cross-store attempt"),
    JSON.stringify(heard.ben.at(-1)));
  void otherId;

  // --- the roster tracks who actually left ----------------------------------
  cass.close();
  await sleep(400);
  check("leaving the floor updates everyone's roster",
    !(rosters.ann.at(-1) || []).some((r) => r.name === "Cass"),
    JSON.stringify((rosters.ann.at(-1) || []).map((r) => r.name)));

  for (const s of [ann, ben, mgr, otherAssoc]) s.close();
}

try {
  await main();
} catch (e) {
  check("suite ran", false, String(e.message || e));
  console.error(serverLog.join(""));
} finally {
  child.kill("SIGTERM");
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
