/**
 * The preferences card, as an associate meets it.
 *
 *   node packages/glasses-plugin/test/prefs-browser.mjs
 *
 * Expects a dev server on :5180 and needs **no live services**. The
 * capabilities endpoint and the roster are intercepted, and so is the realtime
 * socket — `stubSocket` below answers Engine.IO's long poll well enough to
 * connect, record what the plugin emits and push a guest back. That matters
 * here more than it would elsewhere: two of the four preferences are only
 * observable once something is on the glass, and a test that needed a live
 * server to see them is a test that stops being run.
 *
 * Storage is the MockBridge's `window.localStorage` fallback, which is why the
 * whole flow is reachable with no phone and no glasses — including the branch
 * where the host refuses the write.
 *
 * What it holds down, in order of how badly it would hurt to get wrong:
 *
 *   1. An empty store shows the defaults, and the defaults are today's
 *      behaviour. Nobody's first shift changes because this shipped.
 *   2. A change survives a reload. A setting that does not is not a setting,
 *      and this page's WebView is torn down every time the phone is pocketed.
 *   3. A preference whose capability is false is not on the page at all.
 *   4. A write the phone refuses says so and puts the control back. A toggle
 *      that stays flipped after a failed write is a setting somebody believes
 *      they have.
 *   5. Each preference reaches the thing it governs: the zone goes back to the
 *      server, the points row leaves the rail, voice stops opening the mic.
 *
 * It runs at 390 x 844 — a phone. No mobile breakpoint in this package had
 * ever been exercised by a test, and the automation viewport is 1386px wide.
 */
import { chromium } from "playwright";

const BASE = process.env.PLUGIN_URL || "http://localhost:5180/?tenant=gap";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/**
 * Engine.IO v4 long polling, enough of it.
 *
 * Open packet, namespace connect, then a queue the test pushes events onto and
 * a record of everything the plugin sent. Not a socket.io server — it never
 * upgrades and never acknowledges — but it is the whole surface this plugin
 * uses, and it makes the engaged half of these preferences testable with no
 * services running at all.
 */
function stubSocket(ctx) {
  const state = { sent: [], onEmit: null };
  /** Engine.IO v4 separates packets inside one payload with a record separator. */
  const SEP = "\u001e";
  /**
   * One session per page, keyed by the sid we hand out.
   *
   * Not one shared session: every reload and every new page is a new client,
   * and a stub that answered a second client's poll without ever sending it the
   * namespace-connect packet leaves that page permanently unconnected — which
   * looks exactly like the plugin failing to register, and cost a debugging
   * round the first time this ran.
   */
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
      // No upgrades offered: a websocket upgrade would leave this stub behind.
      return route.fulfill({ status: 200, ...body, body:
        `0{"sid":"${fresh}","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}` });
    }
    const s = sessions.get(sid) || { opened: false, queue: [] };
    sessions.set(sid, s);
    if (!s.opened) {
      s.opened = true;
      return route.fulfill({ status: 200, ...body, body: '40{"sid":"stub-ns"}' });
    }
    // Hold the poll briefly so this doesn't spin, then answer with whatever the
    // test has queued, or a ping.
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

const GUEST = {
  lines: ["SARAH CHEN", "IN CART CASHSOFT CREW", "OFFER IT IN SIZE M"],
  cue: {
    lines: ["SARAH CHEN", "IN CART CASHSOFT CREW", "OFFER IT IN SIZE M"],
    meta: ["DENIM WALL"],
  },
  guest: {
    guest_id: "g1", name: "Sarah Chen", tier: "ICON", points: 4200,
    sizes: { tops: "M", bottoms: "28X30" },
  },
  recommendations: [{ sku: "41221", name: "High Rise Barrel Jeans", price: 90, stock: 9 }],
};

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });

let caps = { camera_capture: false, voice: true, floor_comms: true };
await ctx.route("**/api/tenant/capabilities**", (r) =>
  r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(caps) }));
await ctx.route("**/api/guests**", (r) =>
  r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify([{ guest_id: "g1", name: "Sarah Chen", loyalty_tier: "ICON" }]),
  }));
const wire = stubSocket(ctx);
// A guest arrives when the page asks for one, which is what the roster button
// does on a real floor via the beacon.
wire.onEmit = (event) => {
  if (event === "beacon:guest-enter") wire.emit("glasses:display", GUEST);
};

const pageErrors = [];

async function open({ fresh = true } = {}) {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(String(e)));
  await p.goto(BASE, { waitUntil: "domcontentloaded" });
  // Each block starts from an associate who has never opened this page. The
  // context's storage is shared, and a preference left over from the previous
  // block would make every default in the next one a coincidence.
  if (fresh) {
    await p.evaluate(() => localStorage.clear());
    await p.reload({ waitUntil: "domcontentloaded" });
  }
  // The card is mounted once the capability answer is in, like the capture
  // card — the HUD never waits on a store's network.
  await p.waitForSelector("#prefs-mount .prefs", { timeout: 8_000 });
  return p;
}

const labels = (p) => p.$$eval("#prefs-mount .pref-label", (e) => e.map((x) => x.textContent));
const zoneValue = (p) => p.$eval("#pref-zone", (e) => e.value);
const stateLine = (p) => p.$eval("#prefs-state", (e) => e.textContent.trim());
const lensText = (p) => p.$eval("#virtual-lens", (e) => e.textContent);
const railRows = (p) => p.$$eval("#virtual-lens .lens-item", (e) => e.map((x) => x.textContent));
/** The switch inside the row whose label reads `title`. */
const switchIn = (p, title) =>
  p.locator("#prefs-mount .pref", { has: p.locator(`.pref-label:text-is("${title}")`) })
    .locator(".pref-switch");
const saved = (p) => p.waitForFunction(
  () => /^SAVED/.test(document.getElementById("prefs-state")?.textContent || ""),
  { timeout: 5_000 });

// --- 1. an empty store shows the defaults ----------------------------------

{
  const p = await open();
  check("an empty store shows every preference at its default",
    (await zoneValue(p)) === "Denim Wall" &&
    (await switchIn(p, "Voice").getAttribute("aria-checked")) === "true" &&
    (await switchIn(p, "Points on the rail").getAttribute("aria-checked")) === "true" &&
    (await p.$eval('#prefs-mount .pref-seg-item[data-value="everything"]',
      (e) => e.dataset.on)) === "1",
    await zoneValue(p));

  check("the default zone still reaches the server, so nothing regressed for an associate who never opens this",
    wire.sent.some((s) => s.event === "register" && s.payload.zone === "Denim Wall"),
    JSON.stringify(wire.sent.find((s) => s.event === "register")?.payload?.zone));

  check("the settings come before the diagnostics, which are collapsed",
    await p.evaluate(() => {
      const prefs = document.getElementById("prefs-mount");
      const diag = document.getElementById("diagnostics");
      return !!prefs && !!diag && !diag.open &&
        (prefs.compareDocumentPosition(diag) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    }));

  // Everything a developer needs is still in the document — collapsed, not
  // deleted. The handoff refers to it, and it is how this gets debugged on a
  // phone with no laptop attached.
  check("the console survives the disclosure",
    await p.evaluate(() => ["virtual-lens", "beacon-roster", "event-inspector",
      "event-log", "session-info"].every((id) => !!document.getElementById(id))));

  // Nothing an associate touches may need pinch-zoom.
  const overflow = await p.evaluate(() =>
    [...document.querySelectorAll("#prefs-mount *, #capture-mount *")]
      .filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5)
      .map((e) => `${e.className}@${Math.round(e.getBoundingClientRect().right)}`));
  check("nothing on the settings card runs off a 390px phone",
    overflow.length === 0, overflow.join(", ") || "clean");

  const sizes = await p.evaluate(() =>
    [...document.querySelectorAll(
      "#prefs-mount input, #prefs-mount button, #diagnostics > summary")].map((el) => ({
      tag: el.tagName + (el.className ? `.${String(el.className).split(" ")[0]}` : ""),
      h: Math.round(el.getBoundingClientRect().height),
      font: parseFloat(getComputedStyle(el).fontSize),
    })));
  check("every control clears a 44px touch target",
    sizes.every((s) => s.h >= 44),
    sizes.filter((s) => s.h < 44).map((s) => `${s.tag}=${s.h}`).join(", ") || "all clear");
  check("text inputs are 16px, so the phone does not zoom on focus",
    sizes.filter((s) => s.tag.startsWith("INPUT")).every((s) => s.font >= 16),
    JSON.stringify(sizes.filter((s) => s.tag.startsWith("INPUT"))));

  // Green is the product's own voice and lives in the lens. A settings control
  // in hud green would be the product speaking where a person is choosing.
  const green = await p.evaluate(() =>
    [...document.querySelectorAll("#prefs-mount *, #capture-mount *")]
      .map((e) => `${getComputedStyle(e).color} ${getComputedStyle(e).backgroundColor} ${getComputedStyle(e).borderTopColor}`)
      .filter((s) => /75, 255, 154|53, 229, 133|34, 184, 105/.test(s)));
  check("no hud green outside the lens", green.length === 0, green.join(" | ") || "clean");

  await p.close();
}

// --- 2. a change survives a reload -----------------------------------------

{
  const p = await open();
  await switchIn(p, "Points on the rail").click();
  await saved(p);
  check("saving says so, with no Save button anywhere on the card",
    /^SAVED/.test(await stateLine(p)) &&
    (await p.$$eval("#prefs-mount button", (b) => b.map((x) => x.textContent)))
      .every((t) => !/save/i.test(t)),
    await stateLine(p));

  await p.fill("#pref-zone", "Fitting Rooms");
  await p.locator("#pref-zone").blur();
  await saved(p);

  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForSelector("#prefs-mount .prefs");
  check("a preference survives a reload",
    (await zoneValue(p)) === "Fitting Rooms" &&
    (await switchIn(p, "Points on the rail").getAttribute("aria-checked")) === "false",
    `${await zoneValue(p)} / points=${await switchIn(p, "Points on the rail").getAttribute("aria-checked")}`);

  check("what was stored is what the associate typed, not the tenant's default",
    await p.evaluate(() => localStorage.getItem("cue.pref.zone")) === "Fitting Rooms");

  // The foreground transition this page actually suffers: the WebView is torn
  // down and the module state goes with it. sessionStorage survives it and so
  // must the preferences, which is what a reload models.
  check("the reloaded page registers with the stored zone, not the default",
    wire.sent.filter((s) => s.event === "register").slice(-1)[0]?.payload?.zone
      === "Fitting Rooms",
    JSON.stringify(wire.sent.filter((s) => s.event === "register").map((s) => s.payload.zone)));

  await p.close();
}

// --- 3. a preference whose capability is false is not on the page ----------

{
  caps = { camera_capture: false, voice: true, floor_comms: false };
  const p = await open();
  const shown = await labels(p);
  check("floor comms off in the store: the preference is absent, not disabled",
    !shown.includes("Floor messages") && (await p.$$("#prefs-mount .pref-seg")).length === 0,
    JSON.stringify(shown));
  check("the preferences the store has nothing to say about are still there",
    shown.includes("Zone") && shown.includes("Points on the rail") && shown.includes("Voice"),
    JSON.stringify(shown));
  await p.close();

  caps = { camera_capture: false, voice: false, floor_comms: false };
  const q = await open();
  const bare = await labels(q);
  check("voice off in the store: that preference is absent too",
    !bare.includes("Voice") && bare.join(",") === "Zone,Points on the rail",
    JSON.stringify(bare));
  // The unenforced capabilities keep their shipped behaviour. Hiding the
  // control must not become a back door to switching voice off for every
  // tenant, which is what gating on a flag nobody has set would do.
  check("hiding the voice control does not switch voice off",
    /voice ready/.test(await q.$eval("#voice-status", (e) => e.textContent)),
    await q.$eval("#voice-status", (e) => e.textContent));
  await q.close();

  caps = { camera_capture: false, voice: true, floor_comms: true };
}

// --- 4. a refused write surfaces -------------------------------------------

{
  const p = await open();
  const sw = switchIn(p, "Voice");
  await p.evaluate(() => { window.__cueMockStorage = "fail"; });
  await sw.click();
  await p.waitForFunction(() => /NOT SAVED/.test(
    document.getElementById("prefs-state")?.textContent || ""), { timeout: 5_000 });
  check("a refused write says so rather than looking saved",
    /NOT SAVED/.test(await stateLine(p)), await stateLine(p));
  check("and the control goes back to what is actually stored",
    (await sw.getAttribute("aria-checked")) === "true" &&
    (await sw.textContent()).trim() === "ON");
  check("a refused preference does not take effect either",
    /voice ready/.test(await p.$eval("#voice-status", (e) => e.textContent)),
    await p.$eval("#voice-status", (e) => e.textContent));

  await p.fill("#pref-zone", "Stockroom");
  await p.locator("#pref-zone").blur();
  await p.waitForFunction(() => /NOT SAVED/.test(
    document.getElementById("prefs-state")?.textContent || ""), { timeout: 5_000 });
  check("a refused zone is put back, not left on the page as if it took",
    (await zoneValue(p)) === "Denim Wall" &&
    (await p.evaluate(() => localStorage.getItem("cue.pref.zone"))) === null,
    await zoneValue(p));
  check("and a refused zone never reached the server",
    !wire.sent.some((s) => s.payload?.zone === "Stockroom"));

  // With storage working again the same change goes through, so the failure
  // branch is a refusal and not a dead control.
  await p.evaluate(() => { delete window.__cueMockStorage; });
  await sw.click();
  await saved(p);
  check("the same change lands once the phone accepts writes",
    (await sw.getAttribute("aria-checked")) === "false" &&
    (await p.evaluate(() => localStorage.getItem("cue.pref.voice"))) === "off");
  await p.close();
}

// --- 5. each preference reaches the thing it governs ------------------------

{
  const p = await open();
  await p.click("#diagnostics > summary");

  // Zone: it travels on `register` — the only message that carries it to the
  // roster — and on every beacon.
  const before = wire.sent.filter((s) => s.event === "register").length;
  await p.fill("#pref-zone", "Fitting Rooms");
  await p.locator("#pref-zone").blur();
  await saved(p);
  await p.waitForTimeout(300);
  const regs = wire.sent.filter((s) => s.event === "register");
  check("changing the zone re-registers on the same socket, rather than only changing the box",
    regs.length === before + 1 && regs.slice(-1)[0].payload.zone === "Fitting Rooms",
    JSON.stringify(regs.map((r) => r.payload.zone)));

  await p.click("#beacon-roster button");
  await p.waitForFunction(
    () => /SARAH CHEN/i.test(document.getElementById("virtual-lens")?.textContent || ""),
    { timeout: 8_000 });
  check("the beacon carries the new zone too",
    wire.sent.filter((s) => s.event === "beacon:guest-enter").slice(-1)[0]?.payload?.zone
      === "Fitting Rooms",
    JSON.stringify(wire.sent.filter((s) => s.event === "beacon:guest-enter").slice(-1)[0]?.payload));

  // A zone changed mid-engagement waits for the engagement to end before it
  // re-registers: rebuilding the associate record would report a busy
  // associate as available on the manager dashboard.
  const during = wire.sent.filter((s) => s.event === "register").length;
  await p.fill("#pref-zone", "Stockroom");
  await p.locator("#pref-zone").blur();
  await saved(p);
  await p.waitForTimeout(300);
  check("a zone changed mid-engagement does not re-register underneath the engagement",
    wire.sent.filter((s) => s.event === "register").length === during,
    `${wire.sent.filter((s) => s.event === "register").length} vs ${during}`);

  // Points: the row is on the rail, and turning it off takes it off the glass
  // without waiting for the next guest.
  check("the rail spends a row on points while they are on",
    (await railRows(p)).some((r) => /4200 PTS/.test(r)), JSON.stringify(await railRows(p)));
  await switchIn(p, "Points on the rail").click();
  await saved(p);
  await p.waitForTimeout(300);
  check("turning points off takes the row off the glass mid-engagement",
    !(await railRows(p)).some((r) => /PTS/.test(r)), JSON.stringify(await railRows(p)));
  check("and the rest of the rail is untouched",
    (await railRows(p)).some((r) => /SARAH CHEN/.test(r)) &&
    (await railRows(p)).some((r) => /BTM 28X30/.test(r)), JSON.stringify(await railRows(p)));

  // Ending the engagement is when the deferred zone registration goes.
  await p.click('[data-event="click"][data-source="ring"]');
  await p.waitForTimeout(400);
  check("the deferred zone registers the moment the engagement ends",
    wire.sent.filter((s) => s.event === "register").slice(-1)[0]?.payload?.zone === "Stockroom",
    JSON.stringify(wire.sent.filter((s) => s.event === "register").map((r) => r.payload.zone)));

  // Floor comms: urgent takes the frame at "everything", and at "off" it
  // queues instead — but it is never dropped, which is the whole point.
  wire.emit("radio:message", { from: "MAYA", message: "NEED BACKUP", priority: "urgent" });
  await p.waitForFunction(
    () => /NEED BACKUP/.test(document.getElementById("virtual-lens")?.textContent || ""),
    { timeout: 5_000 });
  check("at 'everything', an urgent message takes the frame", true);
  await p.click('[data-event="click"][data-source="ring"]');
  await p.waitForTimeout(300);

  await p.click('#prefs-mount .pref-seg-item[data-value="off"]');
  await saved(p);
  wire.emit("radio:message", { from: "MAYA", message: "NEED BACKUP", priority: "urgent" });
  await p.waitForTimeout(700);
  check("at 'off', nothing takes the frame",
    !/NEED BACKUP/.test(await lensText(p)), await lensText(p));
  await p.click('[data-event="scroll-down"][data-source="ring"]');
  await p.waitForTimeout(400);
  check("but the message is queued, not lost — it is waiting in the floor menu",
    /NEED BACKUP/.test(await lensText(p)) && /WAITING/.test(await lensText(p)),
    await lensText(p));

  // Voice: off means the idle strip stops offering the gesture, and the
  // gesture stops opening the mic.
  await p.click('[data-event="double-click"][data-source="ring"]');   // out of the menu
  await p.waitForTimeout(300);
  await switchIn(p, "Voice").click();
  await saved(p);
  await p.waitForTimeout(300);
  check("with voice off the idle strip stops offering the mic",
    !/PRESS TO ASK/.test(await lensText(p)), await lensText(p));
  await p.click('[data-event="click"][data-source="ring"]');
  await p.waitForTimeout(500);
  check("and a press at idle no longer opens it",
    !/LISTENING/.test(await lensText(p)), await lensText(p));
  await switchIn(p, "Voice").click();
  await saved(p);
  await p.waitForTimeout(300);
  check("turning voice back on restores the offer",
    /PRESS TO ASK/.test(await lensText(p)), await lensText(p));

  await p.close();
}

check("no page errors", pageErrors.length === 0, pageErrors.join(" | ") || "clean");

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
