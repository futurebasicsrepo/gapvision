/**
 * Realtime tenant isolation.
 *
 * Every assertion here is a negative one, because the failure this guards
 * against is not "the feature doesn't work" — floor radio worked fine — but
 * "the feature works for the wrong audience". Two retailers on one deployment
 * must not hear each other's floor, see each other's roster, or be able to
 * write into each other's world by putting a different slug in a payload.
 *
 *   node packages/server/test/tenant-isolation.mjs
 *
 * Starts its own server on an unused port. No AI service required: nothing
 * here touches the guest-context or voice paths.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { io } from "socket.io-client";

const PORT = process.env.TEST_PORT || 4123;
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
  // Wait for listen()
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${URL}/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await sleep(250);
  }

  // Two retailers, an associate and a manager each.
  const alphaAssoc = await connect();
  const alphaMgr = await connect();
  const betaAssoc = await connect();
  const betaMgr = await connect();

  const heard = { alpha: [], beta: [] };
  const snaps = { alpha: [], beta: [] };
  alphaAssoc.on("radio:message", (m) => heard.alpha.push(m));
  betaAssoc.on("radio:message", (m) => heard.beta.push(m));
  alphaMgr.on("dashboard:update", (s) => snaps.alpha.push(s));
  betaMgr.on("dashboard:update", (s) => snaps.beta.push(s));

  alphaAssoc.emit("register", { role: "associate", name: "Alpha Ann", tenant: "t_alpha" });
  betaAssoc.emit("register", { role: "associate", name: "Beta Ben", tenant: "t_beta" });
  alphaMgr.emit("register", { role: "dashboard", tenant: "t_alpha" });
  betaMgr.emit("register", { role: "dashboard", tenant: "t_beta" });
  await sleep(300);

  // --- radio ----------------------------------------------------------------
  alphaAssoc.emit("radio:send", { message: "need backup in fitting rooms" });
  await sleep(300);

  check("the sending store hears its own radio", heard.alpha.length === 1,
    JSON.stringify(heard.alpha.map((m) => m.message)));
  check("the other store hears nothing", heard.beta.length === 0,
    heard.beta.length ? `LEAKED: ${JSON.stringify(heard.beta)}` : "");

  // --- roster ---------------------------------------------------------------
  const lastAlpha = snaps.alpha.at(-1);
  const lastBeta = snaps.beta.at(-1);
  const names = (s) => (s?.associates || []).map((a) => a.name);

  check("a manager sees their own associates", names(lastAlpha).includes("Alpha Ann"));
  check("a manager does not see the other store's associates",
    !names(lastAlpha).includes("Beta Ben") && !names(lastBeta).includes("Alpha Ann"),
    `alpha=${JSON.stringify(names(lastAlpha))} beta=${JSON.stringify(names(lastBeta))}`);
  check("radio traffic is not mirrored to the other store's dashboard",
    (lastBeta?.radioLog || []).length === 0,
    JSON.stringify(lastBeta?.radioLog || []));

  // --- demo furniture stays in the demo world -------------------------------
  check("a real retailer does not inherit the simulator's leaderboard",
    (lastAlpha?.leaderboard || []).length === 0,
    JSON.stringify((lastAlpha?.leaderboard || []).map((r) => r.name)));

  const demo = await connect();
  const demoSnaps = [];
  demo.on("dashboard:update", (s) => demoSnaps.push(s));
  demo.emit("register", { role: "dashboard", tenant: "gap" });
  await sleep(300);
  check("the demo tenant still has its sample leaderboard",
    (demoSnaps.at(-1)?.leaderboard || []).length === 3);

  // --- a socket cannot change tenant mid-flight -----------------------------
  // The move an attacker (or a buggy client) makes: register as your own
  // tenant, then put someone else's slug in a later payload.
  betaAssoc.emit("radio:send", { message: "beta internal" });
  await sleep(200);
  const before = heard.alpha.length;
  betaAssoc.emit("beacon:guest-enter", { guestId: "x", zone: "z", tenant: "t_alpha" });
  await sleep(400);
  betaAssoc.emit("radio:send", { message: "still beta?" });
  await sleep(300);

  check("a rebound attempt does not move the socket to another tenant",
    heard.alpha.length === before,
    heard.alpha.length !== before ? `LEAKED: ${JSON.stringify(heard.alpha.at(-1))}` : "");
  check("the rebind attempt is logged, not silent",
    serverLog.join("").includes("ignored tenant 't_alpha'"));

  // --- the open health route names no customers -----------------------------
  const health = await (await fetch(`${URL}/health`)).json();
  check("/health reports counts, not tenant slugs",
    typeof health.tenants_live === "number"
      && !JSON.stringify(health).includes("t_alpha"),
    JSON.stringify(health));

  for (const s of [alphaAssoc, alphaMgr, betaAssoc, betaMgr, demo]) s.close();
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
