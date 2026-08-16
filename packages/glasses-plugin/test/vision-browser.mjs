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
 *   1. With the camera off, there is no camera control on the glass. Not
 *      greyed out — absent. Everything else on that screen still works.
 *   2. With it on, the control is reachable by gestures that already exist,
 *      and the capture runs through the MockBridge's canned photo.
 *   3. The glass shows a stage and a running count while the round trip is in
 *      flight, rather than freezing on the last frame.
 *   4. The answer comes back through the ordinary cue path — three lines and a
 *      meta strip, like every other cue.
 *   5. Each failure says which failure.
 *   6. The base64 never reaches the log.
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

let cameraOn = false;
let posted = null;

await ctx.route("**/api/tenant/capabilities**", (r) =>
  r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ camera_capture: cameraOn, voice: true, floor_comms: true }),
  }));
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
  await p.click('[data-event="scroll-down"][data-source="ring"]');
  await p.waitForTimeout(300);
  const text = await lens();
  check("camera off: nothing on the glass offers a scan", !/SCAN/.test(text), text);
  check("camera off: the floor menu is otherwise intact", /NEED BACKUP/.test(text));
  await p.close();
}

// --- 2..4. the camera is on ------------------------------------------------

cameraOn = true;
const p = await open();
const lens = lensOf(p);
const ring = (a) => p.click(`[data-event="${a}"][data-source="ring"]`);

await ring("scroll-down");
await p.waitForTimeout(300);
let text = await lens();
check("camera on: both scan rows are on the glass",
  /SCAN A TAG/.test(text) && /SCAN A PART/.test(text), text);
check("the footer says what a press will do now", /PRESS TO SCAN/.test(text), text);

await ring("click");
await p.waitForTimeout(600);
text = await lens();
check("the glass says it is working, and for how long",
  /READING THE TAG/.test(text) && /\dS/.test(text), text);

await p.waitForFunction(
  () => /BARREL JEAN/.test(document.getElementById("virtual-lens")?.textContent || ""),
  { timeout: 10_000 },
);
text = await lens();
check("the answer renders as an ordinary cue",
  /BARREL JEAN 28X30/.test(text) && /DENIM WALL BAY 3/.test(text) && /SKU 41221/.test(text),
  text);
check("the POST carried the tenant, the kind, the mime and an image",
  !!posted && posted.tenant === "gap" && posted.kind === "sku" &&
  posted.mime === "image/png" &&
  typeof posted.image_base64 === "string" && posted.image_base64.length > 50,
  JSON.stringify({ ...posted, image_base64: `<${posted?.image_base64?.length} chars>` }));

// --- 5. which failure ------------------------------------------------------

/** Force one of the MockBridge's capture outcomes, then run a scan. */
async function scanWith(forced) {
  await p.evaluate((f) => { window.__cueMockCapture = f; }, forced);
  await ring("scroll-down");
  await p.waitForTimeout(300);
  await ring("click");
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

// --- 6. the image never lands anywhere it shouldn't ------------------------

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
