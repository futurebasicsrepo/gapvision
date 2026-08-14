/**
 * Attribution, end to end: a serial the glasses announce becomes a name on
 * the leaderboard.
 *
 *   node packages/internal/test/attribution-e2e.mjs
 *
 * Expects the plugin previewing on :5180 plus the realtime and AI services.
 * Drives the real plugin in a real browser rather than posting to the ingest
 * API directly, because the bug this replaced lived in the gap between them:
 * the server was ready to attribute and the plugin never sent anything to
 * attribute with.
 */
import { chromium } from "playwright";

const SERVER = process.env.SERVER_URL || "http://127.0.0.1:4000";
const PLUGIN = process.env.PLUGIN_URL || "http://127.0.0.1:5180/?tenant=gap";
const EMAIL = process.env.CONSOLE_STAFF_EMAIL;
const PASSWORD = process.env.CONSOLE_STAFF_PASSWORD;
if (!EMAIL) { console.error("Set CONSOLE_STAFF_EMAIL / CONSOLE_STAFF_PASSWORD."); process.exit(2); }
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok?"PASS":"FAIL"}  ${n}${d?` — ${d}`:""}`); };

const login = async () => (await (await fetch(`${SERVER}/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
})).json()).token;

const tok = await login();
const H = { authorization: `Bearer ${tok}`, "content-type": "application/json" };

// This script is re-run against a live local stack, so start from a known
// state: forget the mock device entirely and let it re-announce itself.
{
  const existing = (await (await fetch(`${SERVER}/api/admin/devices?tenant=gap`, { headers: H })).json()).devices;
  const prior = existing.find((d) => d.serial === "MOCK-G2-0001");
  if (prior) await fetch(`${SERVER}/api/admin/devices/${prior.id}`, {
    method: "PATCH", headers: H, body: JSON.stringify({ user_id: "" }),
  });
}

// Drive the plugin once so the mock serial announces itself.
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await b.newPage();
await p.goto(PLUGIN, { waitUntil: "networkidle" });
await p.waitForSelector("#beacon-roster button");
await p.click("#beacon-roster button");
await p.waitForFunction(() => document.querySelector("#session-info")?.textContent?.startsWith("Engaged"), { timeout: 8000 });
await p.waitForTimeout(1500);

let devices = (await (await fetch(`${SERVER}/api/admin/devices?tenant=gap`, { headers: H })).json()).devices;
const mock = devices.find((d) => d.serial === "MOCK-G2-0001");
check("unknown device registered itself", Boolean(mock), JSON.stringify(devices.map(d=>d.serial)));
check("registered unassigned", mock && mock.user_id === null);
check("last_seen stamped", Boolean(mock?.last_seen_at));

// Assign it, the way the console does.
const users = (await (await fetch(`${SERVER}/api/admin/users?tenant=gap`, { headers: H })).json()).users;
// Must be an associate: the leaderboard ranks the sales floor, and managers
// are deliberately excluded from it. Create one if this tenant has none.
let target = users.find((u) => u.role === "associate" && u.status === "active");
if (!target) {
  target = (await (await fetch(`${SERVER}/api/admin/users`, {
    method: "POST", headers: H,
    body: JSON.stringify({ email: "floor@gapdemo.example.com", name: "Floor Associate",
                           role: "associate", tenant: "gap",
                           password: PASSWORD }),
  })).json()).user;
}
const res = await fetch(`${SERVER}/api/admin/devices/${mock.id}`, {
  method: "PATCH", headers: H, body: JSON.stringify({ user_id: target.id }),
});
check("assigning the device succeeds", res.ok, `${res.status}`);

// Engage again — this one should carry a name.
await p.click('[data-event="click"][data-source="ring"]');
await p.waitForTimeout(400);
await p.click("#beacon-roster button");
await p.waitForTimeout(1800);

const eng = (await (await fetch(`${SERVER}/api/analytics/engagements?limit=5&tenant=gap`, { headers: H })).json()).engagements;
check("newest engagement is attributed", eng[0]?.associate === target.name,
  `${eng[0]?.associate} (wanted ${target.name})`);

const lb = (await (await fetch(`${SERVER}/api/analytics/leaderboard?days=1&tenant=gap`, { headers: H })).json()).rows;
check("it reaches the leaderboard", lb.some((r) => r.name === target.name),
  JSON.stringify(lb.map((r) => r.name)));

const plat = await (await fetch(`${SERVER}/api/admin/platform`, { headers: H })).json();
const dcheck = plat.checks.find((c) => c.key === "devices");
check("platform panel reports device state", Boolean(dcheck), JSON.stringify(dcheck));

await b.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
