/**
 * Arranging the deck, as an associate meets it.
 *
 *   node packages/glasses-plugin/test/widgets-browser.mjs
 *
 * Expects a dev server on :5180 and needs **no live services** — capabilities
 * and the socket are intercepted, the same way `prefs-browser.mjs` does it.
 *
 * `widgets.test.mjs` proves the pure layer. This proves the parts that only
 * exist once a person and a phone are involved:
 *
 *   1. Moving a widget changes what is on the glass. An arrangement an
 *      associate cannot see take effect is one they cannot trust.
 *   2. It survives a reload. A layout that does not is not a layout — this
 *      page's WebView is torn down every time the phone is pocketed.
 *   3. Removing a widget takes it off the glass and offers it back.
 *   4. A store with the deck switched off has no arranging controls in the
 *      document at all, and the glass keeps the cue.
 *
 * Runs at 390 x 844 — a phone.
 */
import { chromium } from "playwright";

const BASE = process.env.PLUGIN_URL || "http://localhost:5180/?tenant=gap";
const SEP = String.fromCharCode(30);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/** Engine.IO v4 long polling, enough of it — see prefs-browser.mjs. */
function stubSocket(ctx) {
  const state = { sent: [], onEmit: null };
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
        } catch { /* a packet we don't parse is one this stub ignores */ }
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
    if (!s.opened) { s.opened = true; return route.fulfill({ status: 200, ...body, body: '40{"sid":"stub-ns"}' }); }
    for (let i = 0; i < 20 && !s.queue.length; i++) await new Promise((r) => setTimeout(r, 50));
    const out = s.queue.splice(0, s.queue.length);
    return route.fulfill({ status: 200, ...body, body: out.length ? out.join(SEP) : "2" });
  });
  state.emit = (event, payload) => {
    const packet = `42${JSON.stringify([event, payload])}`;
    sessions.forEach((s) => s.queue.push(packet));
  };
  return state;
}

const GUEST = {
  lines: ["SARAH CHEN", "IN CART CASHSOFT CREW", "OFFER IT IN SIZE M"],
  cue: { lines: ["SARAH CHEN", "IN CART CASHSOFT CREW", "OFFER IT IN SIZE M"], meta: ["DENIM WALL"] },
  guest: { guest_id: "g1", name: "Sarah Chen", tier: "ICON", points: 4200,
           sizes: { tops: "M", bottoms: "28X30" } },
  recommendations: [{ sku: "41221", name: "High Rise Barrel Jeans", price: 90, stock: 9 }],
};

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });

let caps = { camera_capture: false, voice: true, floor_comms: true, widgets: true };
await ctx.route("**/api/tenant/capabilities**", (r) =>
  r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(caps) }));
await ctx.route("**/api/guests**", (r) =>
  r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
const wire = stubSocket(ctx);
wire.onEmit = (event) => { if (event === "beacon:guest-enter") wire.emit("glasses:display", GUEST); };

const pageErrors = [];

async function open({ fresh = true } = {}) {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(String(e)));
  await p.goto(BASE, { waitUntil: "domcontentloaded" });
  if (fresh) {
    await p.evaluate(() => localStorage.clear());
    await p.reload({ waitUntil: "domcontentloaded" });
  }
  await p.evaluate(() => { const d = document.getElementById("diagnostics"); if (d) d.open = true; });
  return p;
}

/** Put a guest on the glass, the way the beacon does on a real floor. */
async function engage(p) {
  wire.emit("glasses:display", GUEST);
  await p.waitForTimeout(700);
}

const rowOrder = (p) =>
  p.$$eval("#widget-list .widget-row", (els) => els.map((e) => e.dataset.widget));
const cardTitle = (p) => p.$eval("#virtual-lens", (e) => e.textContent);
/** Scroll the deck one card and read what the glass calls it. */
async function nextCard(p) {
  await p.click('[data-event="scroll-down"][data-source="ring"]');
  await p.waitForTimeout(250);
  return cardTitle(p);
}

// --- 1. the default, and moving one -----------------------------------------

{
  const p = await open();
  await p.waitForSelector("#widgets-mount .widgets", { timeout: 8_000 });

  check("the deck starts in today's order",
    (await rowOrder(p)).join(",") === "customer,inventory,messaging",
    (await rowOrder(p)).join(","));

  await engage(p);
  const firstDefault = await nextCard(p);
  check("the first card after the cue is the customer, as it always was",
    /SIZES/.test(firstDefault), firstDefault.replace(/\s+/g, " ").slice(0, 90));

  // Move messaging to the top. Two presses of its up button.
  const messagingUp = '#widget-list .widget-row[data-widget="messaging"] .widget-move';
  await p.click(messagingUp);
  await p.waitForTimeout(250);
  await p.click(messagingUp);
  await p.waitForTimeout(400);
  check("moving a widget up reorders the list",
    (await rowOrder(p)).join(",") === "messaging,customer,inventory",
    (await rowOrder(p)).join(","));

  const firstMoved = await nextCard(p);
  check("and the glass follows immediately, with no new guest needed",
    /FLOOR/.test(firstMoved), firstMoved.replace(/\s+/g, " ").slice(0, 90));

  await p.close();
}

// --- 2. it survives the phone going in a pocket ------------------------------

{
  const p = await open({ fresh: false });
  await p.waitForSelector("#widgets-mount .widgets", { timeout: 8_000 });
  check("the arrangement survives a reload",
    (await rowOrder(p)).join(",") === "messaging,customer,inventory",
    (await rowOrder(p)).join(","));
  await p.close();
}

// --- 3. removing, and getting it back ----------------------------------------

{
  const p = await open({ fresh: false });
  await p.waitForSelector("#widgets-mount .widgets", { timeout: 8_000 });
  await p.click('#widget-list .widget-row[data-widget="customer"] .widget-off');
  await p.waitForTimeout(400);
  check("a removed widget leaves the list",
    !(await rowOrder(p)).includes("customer"), (await rowOrder(p)).join(","));
  check("and is offered back rather than lost",
    (await p.$$eval("#widget-list .widget-add", (e) => e.map((x) => x.textContent)))
      .some((t) => /Customer/.test(t)));

  await engage(p);
  const after = await nextCard(p);
  check("the removed widget is off the glass too",
    !/SIZES/.test(after), after.replace(/\s+/g, " ").slice(0, 90));

  await p.click('#widget-list .widget-add');
  await p.waitForTimeout(400);
  check("adding it back puts it at the end, where it was asked for",
    (await rowOrder(p)).at(-1) === "customer", (await rowOrder(p)).join(","));
  await p.close();
}

// --- 4. a store that switched the deck off ------------------------------------

{
  caps = { camera_capture: false, voice: true, floor_comms: true, widgets: false };
  const p = await open();
  await p.waitForSelector("#whoami", { timeout: 8_000 });
  await p.waitForTimeout(900);
  check("a store with widgets off has no arranging controls on the page at all",
    (await p.$$("#widgets-mount .widgets")).length === 0);

  await engage(p);
  const only = await nextCard(p);
  check("and the glass keeps the cue, which is a complete product",
    /SARAH CHEN/.test(only) && !/SIZES/.test(only),
    only.replace(/\s+/g, " ").slice(0, 90));
  await p.close();
  caps = { camera_capture: false, voice: true, floor_comms: true, widgets: true };
}

check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
