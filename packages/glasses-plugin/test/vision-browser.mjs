/**
 * Browser-path check: the whole camera flow, with no phone and no glasses.
 *
 *   node packages/glasses-plugin/test/vision-browser.mjs
 *
 * Expects `vite preview` on :5180. Unlike the voice and gesture browser tests
 * this one needs **no live services**: the capabilities endpoint and the vision
 * endpoint are both intercepted, which is the only way to drive a tenant whose
 * camera is off and a tenant whose camera is on from the same build.
 *
 * What it is here to prove, in order of how badly it would hurt to get wrong:
 *
 *   1. With the camera off, there is no camera control on the phone page. Not
 *      greyed out — absent. Everything else on the page still works.
 *   2. A capabilities fetch that never lands is the same as a store that said
 *      no. This is the state a fail-open bug would hide in, because in dev the
 *      fetch always succeeds.
 *   3. With it on, the card is on the page and the capture runs through the
 *      MockBridge's canned photo.
 *   4. The glass shows a stage and a running count while the round trip is in
 *      flight, rather than freezing on the last frame.
 *   5. The answer comes back through the ordinary cue path — three lines and a
 *      meta strip, like every other cue — and lands on the *glass*. A phone
 *      showing a result the glasses do not is the failure this product exists
 *      to avoid, so the card is asserted not to carry the answer.
 *   6. The glasses offer no scan of their own. The trigger moved to the page;
 *      the floor menu is phrases and waiting messages again.
 *   7. Each failure says which failure.
 *   8. The base64 never reaches the log.
 */
import { chromium } from "playwright";

const URL = process.env.PLUGIN_URL || "http://localhost:5180/?tenant=gap";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const ctx = await browser.newContext();

/** "on" | "off" | "unreachable" — the three states the gate has to hold in. */
let caps = "off";
let posted = null;

await ctx.route("**/api/tenant/capabilities**", (r) => {
  if (caps === "unreachable") return r.abort("connectionrefused");
  return r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ camera_capture: caps === "on", voice: true, floor_comms: true }),
  });
});
await ctx.route("**/api/vision/analyze", async (r) => {
  posted = JSON.parse(r.request().postData() || "{}");
  // Deliberately slow. The point of the progress screen is the seconds where
  // nothing has come back yet, and a fetch that resolves instantly never
  // renders the state this feature exists to handle.
  await new Promise((res) => setTimeout(res, 1_200));
  r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      lines: ["BARREL JEAN 28X30", "DENIM WALL BAY 3", "9 ON HAND"],
      meta: ["SKU 41221"],
    }),
  });
});
// No roster server needed; the flow under test never touches a guest.
await ctx.route("**/api/guests**", (r) =>
  r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));

const pageErrors = [];
/** Everything drawn on the virtual lens: text containers and list rows both.
 *  The camera affordance is a list row, so a selector that only reads
 *  `.lens-text` would report it missing whether it was there or not. */
const lensOf = (p) => () =>
  p.$$eval("#virtual-lens .lens-text, #virtual-lens .lens-item",
    (els) => els.map((e) => e.textContent).join(" | "));
/** The capture card, or the empty string when there is no card at all. The
 *  mount is always in the document; what matters is whether anything is in it. */
const cardOf = (p) => () =>
  p.$eval("#capture-mount", (el) => el.textContent.trim());
const cardButtons = (p) => () =>
  p.$$eval("#capture-mount button", (els) => els.map((e) => e.textContent));

async function open() {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(String(e)));
  await p.goto(URL, { waitUntil: "domcontentloaded" });
  await p.waitForSelector("#virtual-lens .lens-text");
  // The capability fetch is awaited after the first frame, on purpose — the
  // HUD does not wait on a store's network. Give it a moment to land.
  await p.waitForFunction(
    () => /capabilities:/.test(document.getElementById("event-log")?.textContent || ""),
    { timeout: 5_000 },
  );
  return p;
}

// --- 1. the camera is off --------------------------------------------------

{
  const p = await open();
  const lens = lensOf(p);
  check("camera off: there is no capture card on the page",
    (await cardOf(p)()) === "" && (await cardButtons(p)()).length === 0,
    JSON.stringify(await cardOf(p)()));
  await p.click('[data-event="scroll-down"][data-source="ring"]');
  await p.waitForTimeout(300);
  const text = await lens();
  check("camera off: nothing on the glass offers a scan", !/SCAN/i.test(text), text);
  check("camera off: the floor menu is otherwise intact", /NEED BACKUP/.test(text));
  await p.close();
}

// --- 2. the capabilities fetch never landed --------------------------------
// The state a fail-open bug hides in: in dev this fetch always succeeds, so
// nothing else in the suite would ever exercise it.

{
  caps = "unreachable";
  const p = await open();
  check("fetch failed: there is no capture card on the page",
    (await cardOf(p)()) === "" && (await cardButtons(p)()).length === 0,
    JSON.stringify(await cardOf(p)()));
  const logged = await p.$eval("#event-log", (e) => e.textContent);
  check("fetch failed: the log says which way the gate fell",
    /capabilities: camera=off/.test(logged));
  await p.close();
}

// --- 3..5. the camera is on ------------------------------------------------

caps = "on";
const p = await open();
const lens = lensOf(p);
const ring = (a) => p.click(`[data-event="${a}"][data-source="ring"]`);

check("camera on: the card offers a tag and a part",
  (await cardButtons(p)()).join(" | ") === "Scan a tag | Scan a part",
  JSON.stringify(await cardButtons(p)()));

// --- 6. and the glasses stay a display -------------------------------------
await ring("scroll-down");
await p.waitForTimeout(300);
let text = await lens();
check("camera on: the glasses still offer no scan of their own",
  !/SCAN/i.test(text), text);
check("camera on: the floor menu is phrases and messages again",
  /NEED BACKUP/.test(text) && /PRESS TO SEND/.test(text), text);
await ring("double-click");   // back out of the menu before shooting
await p.waitForTimeout(200);

await p.click("#capture-mount .btn-primary");
await p.waitForTimeout(600);
text = await lens();
check("the glass says it is working, and for how long",
  /READING THE TAG/.test(text) && /\dS/.test(text), text);
check("the phone says the same thing in its own words",
  /WATCH THE GLASSES/i.test(await cardOf(p)()), await cardOf(p)());

await p.waitForFunction(
  () => /BARREL JEAN/.test(document.getElementById("virtual-lens")?.textContent || ""),
  { timeout: 10_000 },
);
text = await lens();
check("the answer renders as an ordinary cue",
  /BARREL JEAN 28X30/.test(text) && /DENIM WALL BAY 3/.test(text) && /SKU 41221/.test(text),
  text);
// The whole point of moving the trigger and not the readout. A phone that
// answers is a phone an associate reads instead of looking up.
check("the answer is on the glass and not on the card",
  !/BARREL JEAN/.test(await cardOf(p)()), await cardOf(p)());
check("the POST carried the tenant, the kind, the mime and an image",
  !!posted && posted.tenant === "gap" && posted.kind === "sku" &&
  posted.mime === "image/png" &&
  typeof posted.image_base64 === "string" && posted.image_base64.length > 50,
  JSON.stringify({ ...posted, image_base64: `<${posted?.image_base64?.length} chars>` }));

// --- 7. which failure ------------------------------------------------------

/** Force one of the MockBridge's capture outcomes, then run a scan from the
 *  page — the trigger an associate actually has. */
async function scanWith(forced) {
  await p.evaluate((f) => { window.__cueMockCapture = f; }, forced);
  await p.click("#capture-mount .btn-primary");
  await p.waitForTimeout(600);
  return lens();
}

check("backing out of the camera says so",
  /NO PHOTO TAKEN/.test(await scanWith("cancel")));
// Waits out the cancelled sentence's dwell so the next one is unambiguous.
await p.waitForTimeout(2_600);
check("an Even App with no camera API says something else entirely",
  /CAMERA UNAVAILABLE/.test(await scanWith("unsupported")));
await p.waitForTimeout(5_100);
check("a host that tried and failed says a third thing",
  /CAMERA DIDNT OPEN/.test(await scanWith("failed")));

// The second control is not a copy of the first — the service is told which
// question it is being asked, which is the only reason there are two.
await p.evaluate(() => { delete window.__cueMockCapture; });
posted = null;
await p.click("#capture-mount .btn-ghost");
await p.waitForTimeout(2_200);
check("scanning a part asks the service about a part",
  posted?.kind === "part", JSON.stringify(posted?.kind));

// --- 8. the image never lands anywhere it shouldn't ------------------------

const log = await p.$eval("#event-log", (e) => e.textContent);
check("no base64 in the event log", !/[A-Za-z0-9+/]{60,}/.test(log));
const stored = await p.evaluate(() =>
  JSON.stringify([...Object.values(localStorage), ...Object.values(sessionStorage)]));
check("no image in local or session storage", !/[A-Za-z0-9+/]{60,}/.test(stored), stored);

check("no page errors", pageErrors.length === 0, pageErrors.join(" | ") || "clean");

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
