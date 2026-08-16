/**
 * What the associate sees, and what the phone sends, when a store is measuring
 * its staff.
 *
 *   npm run dev &
 *   CHROMIUM_PATH=… node packages/glasses-plugin/test/telemetry-browser.mjs
 *
 * `shift.test.mjs` covers the buffer as data. This covers the same switch as
 * **rendered DOM and emitted socket traffic**, which is the split the capture
 * gate already has: "off in the list" and "not on the page" are different
 * claims, and only the second is what an associate actually meets.
 *
 * The two rules held down here are the ones with a person on the other end:
 *
 *   1. **A store with this off sends nothing.** No shift, no battery. Not
 *      throttled, not queued for later — nothing, including when the
 *      capabilities fetch fails and the plugin has been told nothing at all.
 *   2. **A store with this on says so, on the associate's own identity line.**
 *      Beside their name, not in the diagnostics drawer they have never
 *      opened. Somebody being measured should not have to read a schema to
 *      find out.
 *
 * Needs a dev server and no live services: capabilities and the roster are
 * intercepted and the socket is stubbed well enough to record what the plugin
 * emits.
 */
import { chromium } from "playwright";

const BASE = process.env.PLUGIN_URL || "http://localhost:5180/?tenant=gap";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/**
 * Engine.IO v4 long polling, enough of it to see what the plugin sends.
 *
 * Lifted in shape from `prefs-browser.mjs` — a real socket.io server is not
 * needed and would be a live dependency this suite is deliberately without.
 */
function stubSocket(ctx) {
  const state = { sent: [] };
  const SEP = "";
  const sessions = new Map();

  ctx.route("**/socket.io/**", async (route) => {
    const url = new URL(route.request().url());
    const sid = url.searchParams.get("sid");
    const method = route.request().method();

    if (!sid) {
      const id = `sid-${sessions.size + 1}`;
      sessions.set(id, []);
      const open = JSON.stringify({
        sid: id, upgrades: [], pingInterval: 25000, pingTimeout: 20000,
      });
      return route.fulfill({
        status: 200, contentType: "text/plain; charset=UTF-8",
        body: `0${open}${SEP}40{"sid":"${id}"}`,
      });
    }

    if (method === "POST") {
      const body = route.request().postData() || "";
      for (const packet of body.split(SEP)) {
        if (!packet.startsWith("42")) continue;
        try {
          const [event, payload] = JSON.parse(packet.slice(2));
          state.sent.push({ event, payload });
        } catch { /* a packet we do not model */ }
      }
      return route.fulfill({ status: 200, contentType: "text/plain", body: "ok" });
    }

    // A GET with a sid is the client waiting. Hold it briefly, then answer
    // with a ping so the transport stays alive without a busy loop.
    await new Promise((r) => setTimeout(r, 300));
    return route.fulfill({ status: 200, contentType: "text/plain", body: "2" });
  });

  return state;
}

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });

let caps = { known: true, camera_capture: false, shift_telemetry: false,
             voice: true, floor_comms: true };
let capsStatus = 200;
await ctx.route("**/api/tenant/capabilities**", (r) =>
  r.fulfill({
    status: capsStatus, contentType: "application/json",
    body: JSON.stringify(capsStatus === 200 ? caps : { detail: "nope" }),
  }));
await ctx.route("**/api/guests**", (r) =>
  r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));

const wire = stubSocket(ctx);
const pageErrors = [];

async function open() {
  wire.sent.length = 0;
  const p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(String(e)));
  await p.goto(BASE, { waitUntil: "domcontentloaded" });
  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: "domcontentloaded" });
  // The notice and the controller are both wired once the capability answer is
  // in, exactly like the capture card — the HUD never waits on a store's
  // network, so there is nothing to assert before this point.
  await p.waitForFunction(
    () => /capabilities:/.test(document.getElementById("event-log")?.textContent || ""),
    { timeout: 10_000 });
  return p;
}

const notice = (p) =>
  p.$eval("#whoami-telemetry", (e) => e.textContent.trim()).catch(() => "");

// --- 1. a store that has not turned this on --------------------------------

{
  caps = { known: true, camera_capture: false, shift_telemetry: false,
           voice: true, floor_comms: true };
  const p = await open();
  await p.waitForTimeout(1200);

  check("with shift timing off, the identity line says nothing about it",
    (await notice(p)) === "", await notice(p));
  check("and no shift is opened", !wire.sent.some((s) => s.event === "shift:start"),
    JSON.stringify(wire.sent.map((s) => s.event)));
  check("and no battery is reported",
    !wire.sent.some((s) => s.event === "device:health"),
    JSON.stringify(wire.sent.map((s) => s.event)));

  // Not merely unsent — unqueued. A store that declined this must not have a
  // shift's worth of telemetry sitting on a phone waiting for the flag to
  // change.
  const buffered = await p.evaluate(() => localStorage.getItem("cue.shift.queue"));
  check("and nothing is buffered on the phone against the day it is switched on",
    buffered === null || buffered === "[]", String(buffered));
  await p.close();
}

// --- 2. the capabilities fetch fails ---------------------------------------

{
  capsStatus = 500;
  const p = await open();
  await p.waitForTimeout(1200);
  check("a failed capability fetch measures nobody",
    (await notice(p)) === "" && !wire.sent.some((s) => s.event === "shift:start"),
    JSON.stringify({ notice: await notice(p), sent: wire.sent.map((s) => s.event) }));
  capsStatus = 200;
  await p.close();
}

// --- 3. a store that has turned it on --------------------------------------

{
  caps = { known: true, camera_capture: false, shift_telemetry: true,
           voice: true, floor_comms: true };
  const p = await open();
  await p.waitForTimeout(1500);

  const said = await notice(p);
  check("with shift timing on, the identity line says so plainly",
    /SHIFT TIMING ON/.test(said), said);
  check("and it names what is recorded, not just that something is",
    /START AND STOP/.test(said) && /BATTERY/.test(said), said);

  // On the identity line, beside the name and the serial — not in the
  // collapsed diagnostics drawer, which is the one part of this page an
  // associate has no reason to ever open.
  const placement = await p.evaluate(() => {
    const el = document.getElementById("whoami-telemetry");
    return {
      insideWhoami: el?.closest("#whoami") !== null,
      insideDiagnostics: el?.closest("#diagnostics") !== null,
      visible: !!(el && el.offsetParent !== null),
    };
  });
  check("the notice sits on the identity line, visible, and not in diagnostics",
    placement.insideWhoami && placement.visible && !placement.insideDiagnostics,
    JSON.stringify(placement));

  const start = wire.sent.find((s) => s.event === "shift:start");
  check("a shift is opened", !!start, JSON.stringify(wire.sent.map((s) => s.event)));
  check("and it carries the time it happened, not just the fact that it did",
    !!start && !Number.isNaN(Date.parse(start.payload?.occurredAt || "")),
    JSON.stringify(start?.payload));

  // `DeviceStatus` reaches the wire. The MockBridge pushes one on subscribe,
  // which is the only way this path is reachable without a phone — and a path
  // that can only be exercised on hardware is a path that rots.
  const health = wire.sent.find((s) => s.event === "device:health");
  check("the glasses' own status reaches the server", !!health,
    JSON.stringify(wire.sent.map((s) => s.event)));
  check("with a battery level and a serial on it",
    typeof health?.payload?.batteryPercent === "number" && !!health?.payload?.serial,
    JSON.stringify(health?.payload));

  // A battery drop, pushed the way the host pushes one.
  await p.evaluate(() => (window).__cueEmitDeviceStatus({
    connectType: "disconnected", batteryLevel: 4, isCharging: false,
  }));
  await p.waitForTimeout(400);
  const drop = wire.sent.filter((s) => s.event === "device:health").pop();
  check("a pair that drops off at 4% is reported as exactly that",
    drop?.payload?.batteryPercent === 4 && drop?.payload?.connection === "disconnected",
    JSON.stringify(drop?.payload));
  await p.close();
}

check("no page errors", pageErrors.length === 0, pageErrors.join(" | ") || "clean");

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
