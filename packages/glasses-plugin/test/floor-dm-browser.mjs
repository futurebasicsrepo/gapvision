/**
 * Addressed floor messages, as the two people involved meet them.
 *
 *   node packages/glasses-plugin/test/floor-dm-browser.mjs
 *
 * Expects a dev server on :5180 and needs **no live services** — the
 * capabilities endpoint and the realtime socket are both intercepted, the
 * same way `prefs-browser.mjs` does it.
 *
 * What it holds down, in order of how badly it would hurt to get wrong:
 *
 *   1. A message addressed to this associate is marked `→ YOU` on the glass.
 *      Without that the feature does not exist: an addressed message and a
 *      broadcast arrive on the same event and would otherwise read the same,
 *      so somebody asked directly for help would have no way to know.
 *   2. A message addressed to *somebody else* is not marked. A mark that is
 *      sometimes wrong is worse than no mark, because the floor stops reading
 *      it within a shift.
 *   3. The composer sends `to` when a person is picked and omits it when they
 *      are not, and never claims the urgent tier — that tier belongs to the
 *      canned backup call on the ring.
 *   4. A send that reached nobody says so. This is the failure the design
 *      exists to make visible: roster ids churn on reconnect, so "they left"
 *      is ordinary, and an associate who believes a message landed when it
 *      did not is the whole risk of building this at all.
 *   5. The card is not on the page at all for a store with floor comms off.
 *
 * Runs at 390 x 844 — a phone.
 */
import { chromium } from "playwright";

const BASE = process.env.PLUGIN_URL || "http://localhost:5180/?tenant=gap";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/** Engine.IO v4 long polling, enough of it — see prefs-browser.mjs. */
function stubSocket(ctx) {
  const state = { sent: [], onEmit: null };
  const SEP = "";
  const sessions = new Map();
  let sids = 0;
  ctx.route("**/socket.io/**", async (route) => {
    const req = route.request();
    const body = { contentType: "text/plain; charset=UTF-8" };
    if (req.method() === "POST") {
      for (const packet of (req.postData() || "").split(SEP)) {
        if (!packet.startsWith("42")) continue;
        try {
          const [event, payload] = JSON.parse(packet.slice(2));
          state.sent.push({ event, payload });
          state.onEmit?.(event, payload);
        } catch { /* a packet we don't parse is a packet this stub ignores */ }
      }
      return route.fulfill({ status: 200, ...body, body: "ok" });
    }
    const sid = new URL(req.url()).searchParams.get("sid");
    if (!sid) {
      const fresh = `stub${++sids}`;
      sessions.set(fresh, { opened: false, queue: [] });
      return route.fulfill({ status: 200, ...body, body:
        `0{"sid":"${fresh}","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}` });
    }
    const s = sessions.get(sid) || { opened: false, queue: [] };
    sessions.set(sid, s);
    if (!s.opened) {
      s.opened = true;
      return route.fulfill({ status: 200, ...body, body: '40{"sid":"stub-ns"}' });
    }
    for (let i = 0; i < 20 && !s.queue.length; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const out = s.queue.splice(0, s.queue.length);
    return route.fulfill({ status: 200, ...body,
      body: out.length ? out.join(SEP) : "2" });
  });
  state.emit = (event, payload) => {
    const packet = `42${JSON.stringify([event, payload])}`;
    sessions.forEach((s) => s.queue.push(packet));
  };
  return state;
}

/**
 * This lens's own roster id.
 *
 * The same string the stub hands out as the namespace sid, because on a real
 * server the roster is keyed by socket id — so "who am I in the roster" and
 * "what is my socket id" are one fact, and a test that used two different
 * strings for it would be testing a system that does not exist.
 */
const ME = "stub-ns";
const ROSTER = [
  { id: ME, name: "You", zone: "Denim" },
  { id: "sock-ben", name: "Ben", zone: "Fitting" },
  { id: "sock-cass", name: "Cass", zone: "Till" },
];

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });

let caps = { camera_capture: false, voice: true, floor_comms: true };
await ctx.route("**/api/tenant/capabilities**", (r) =>
  r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(caps) }));
await ctx.route("**/api/guests**", (r) =>
  r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));

const wire = stubSocket(ctx);
// The server answers a registration with the associate's own id and the
// roster; the stub does the same so the page is in the state a real floor
// would put it in.
wire.onEmit = (event) => {
  if (event === "register") {
    wire.emit("roster:you", { id: ME, name: "You" });
    wire.emit("roster:update", { roster: ROSTER });
  }
  if (event === "roster:list") wire.emit("roster:update", { roster: ROSTER });
};

const pageErrors = [];

async function open() {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(String(e)));
  await p.goto(BASE, { waitUntil: "domcontentloaded" });
  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: "domcontentloaded" });
  // The gesture simulators live in the collapsed diagnostics drawer. On real
  // hardware these events come off a ring; here they are the only way to drive
  // the glass, so the drawer is opened rather than the buttons moved.
  await p.evaluate(() => {
    const d = document.getElementById("diagnostics");
    if (d) d.open = true;
  });
  return p;
}

const lensText = (p) => p.$eval("#virtual-lens", (e) => e.textContent);
const picks = (p) => p.$$eval("#floor-roster .floor-pick", (e) => e.map((x) => x.textContent));
const statusText = (p) => p.$eval("#floor-status", (e) => e.textContent.trim());
const sentRadio = () => wire.sent.filter((s) => s.event === "radio:send").map((s) => s.payload);

// --- 1. the card, and who it offers ----------------------------------------

{
  const p = await open();
  await p.waitForSelector("#floor-mount .floor", { timeout: 8_000 });
  // The card mounts as soon as the store's capabilities answer and fills in
  // its people when the roster arrives — two different round trips, and the
  // card is deliberately usable between them (a message to the whole floor
  // needs no roster at all). So the roster is waited for explicitly rather
  // than assumed to be there the instant the card is.
  await p.waitForFunction(
    () => document.querySelectorAll("#floor-roster .floor-pick").length > 1,
    { timeout: 8_000 });

  const names = await picks(p);
  check("the composer offers everyone, and the people on the floor",
    names[0] === "Everyone" && names.some((n) => n.startsWith("Ben")),
    JSON.stringify(names));
  check("the composer does not offer you yourself",
    !names.some((n) => n.startsWith("You")),
    JSON.stringify(names));
  check("a person's zone is on their button, so two Bens are tellable apart",
    names.some((n) => n.includes("Fitting")), JSON.stringify(names));

  // --- 2. sending to the room vs sending to one person ---------------------
  await p.fill("#floor-input", "size check on the barrel jeans");
  await p.click("#floor-mount .btn-primary");
  await p.waitForTimeout(200);
  const broadcast = sentRadio().at(-1);
  check("with nobody picked the message goes to the whole floor",
    broadcast?.message === "size check on the barrel jeans" && broadcast?.to === undefined,
    JSON.stringify(broadcast));

  await p.click('#floor-roster .floor-pick:has-text("Ben")');
  await p.fill("#floor-input", "can you take fitting room 3");
  await p.click("#floor-mount .btn-primary");
  await p.waitForTimeout(200);
  const dm = sentRadio().at(-1);
  check("picking a person addresses the message to them",
    dm?.to === "sock-ben" && dm?.message === "can you take fitting room 3",
    JSON.stringify(dm));
  check("the composer never claims the urgent tier",
    sentRadio().every((m) => m.priority !== "urgent"),
    JSON.stringify(sentRadio().map((m) => m.priority)));
  check("the composer clears after a send, so the next message starts empty",
    (await p.$eval("#floor-input", (e) => e.value)) === "");

  // --- 3. receipts ---------------------------------------------------------
  wire.emit("radio:delivered", { id: "m1", to: "sock-ben", toName: "Ben" });
  await p.waitForTimeout(250);
  check("a delivered message says so", (await statusText(p)).includes("Delivered to Ben"),
    await statusText(p));

  wire.emit("radio:undelivered", { to: "sock-ben", reason: "not_on_floor", message: "hello" });
  await p.waitForTimeout(250);
  check("a message that reached nobody says so, in the failure colour",
    (await statusText(p)).toLowerCase().includes("no longer on the floor")
      && (await p.$eval("#floor-status", (e) => e.className)).includes("warn"),
    await statusText(p));

  // --- 4. the mark on the glass -------------------------------------------
  wire.emit("radio:message", {
    id: "r1", fromId: "sock-cass", from: "Cass",
    message: "have you got a 32 back there", to: ME, toName: "You",
  });
  await p.waitForTimeout(300);
  // Scroll down at idle opens the floor menu, which is where a queued message
  // is read. `→ YOU` has to survive onto the glass through `toDisplayText`,
  // which replaces anything the firmware font cannot draw with a space — so
  // this assertion is also the one that proves the arrow is a real glyph.
  await p.click('[data-event="scroll-down"][data-source="ring"]');
  await p.waitForTimeout(250);

  const glass = await lensText(p);
  check("an addressed message is marked on the glass",
    glass.includes("→ YOU"),
    glass.replace(/\s+/g, " ").slice(0, 220));
  check("the sender and their words are still what leads",
    glass.includes("CASS") && glass.includes("32"),
    glass.replace(/\s+/g, " ").slice(0, 220));

  // A message to the room must not be marked. Sent second so it is newest.
  wire.emit("radio:message", {
    id: "r2", fromId: "sock-ben", from: "Ben", message: "till queue building",
  });
  await p.waitForTimeout(300);
  await p.click('[data-event="scroll-down"][data-source="ring"]');
  await p.waitForTimeout(250);
  const roomGlass = await lensText(p);
  // Two messages are now waiting and only one of them was addressed here, so
  // the mark must appear exactly once. Counting rather than reading a line:
  // the menu renders its rows into one text node, so "the line with BEN in it"
  // is not a thing that can be isolated from the outside.
  const marks = (roomGlass.match(/→ YOU/g) || []).length;
  check("a message to the room is not marked as yours",
    roomGlass.includes("2 WAITING") && marks === 1,
    `${marks} marks in: ${roomGlass.replace(/\s+/g, " ").slice(0, 200)}`);

  await p.close();
}

// --- 5. a store with floor comms off ---------------------------------------

{
  caps = { camera_capture: false, voice: true, floor_comms: false };
  const p = await open();
  await p.waitForSelector("#whoami", { timeout: 8_000 });
  await p.waitForTimeout(600);
  check("a store with floor comms off has no composer on the page at all",
    (await p.$$("#floor-mount .floor")).length === 0);
  await p.close();
  caps = { camera_capture: false, voice: true, floor_comms: true };
}

// --- 6. a store we could not ask -------------------------------------------
//
// The opposite of the camera's rule, deliberately. `floor_comms` is unenforced
// because switching it off on a failed fetch would break every tenant to
// protect a permission none of them have set — and a 2.5s timeout on shop wifi
// must not cost an associate their keyboard for the rest of the shift.

{
  await ctx.unroute("**/api/tenant/capabilities**");
  await ctx.route("**/api/tenant/capabilities**", (r) => r.abort());
  const p = await open();
  await p.waitForSelector("#whoami", { timeout: 8_000 });
  await p.waitForTimeout(1_200);
  check("a capabilities fetch that failed still leaves the composer on the page",
    (await p.$$("#floor-mount .floor")).length === 1);
  await p.close();
  await ctx.unroute("**/api/tenant/capabilities**");
  await ctx.route("**/api/tenant/capabilities**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(caps) }));
}

check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
