/**
 * Ring gesture behaviour in the built plugin, headless.
 *
 * The simulator buttons emit the same protobuf-shaped payloads the Even App
 * sends, so this exercises the real decoder — not a dev shortcut around it.
 *
 *   node packages/glasses-plugin/test/gestures-browser.mjs
 *
 * Expects `vite preview` on :5180 plus the realtime + AI services running.
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
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

await page.goto(URL, { waitUntil: "networkidle" });
// The developer console is behind a disclosure now — the associate's capture
// and settings cards are the page. Everything this suite drives lives in it,
// and a collapsed element is not a visible one, so open it first.
await page.evaluate(() => document.getElementById("diagnostics")?.setAttribute("open", ""));
await page.waitForSelector("#virtual-lens .lens-text");

const lens = () => page.$$eval("#virtual-lens .lens-text:not(.meta)",
  (els) => els.map((e) => e.textContent));
const lensMeta = () => page.$$eval("#virtual-lens .lens-text.meta",
  (els) => els.map((e) => e.textContent));
const logText = () => page.$eval("#event-log", (e) => e.textContent);
const inspector = () => page.$eval("#event-inspector", (e) => e.textContent);
const ring = (action) => page.click(`[data-event="${action}"][data-source="ring"]`);
const settle = () => page.waitForTimeout(350);

// Engage a guest so there are recommendations to scroll through.
await page.waitForSelector("#beacon-roster button");
await page.click("#beacon-roster button");
await page.waitForFunction(
  () => document.querySelector("#session-info")?.textContent?.startsWith("Engaged"),
  { timeout: 5000 },
);
check("engaged with a guest", true);

// --- decoding ---------------------------------------------------------------
await ring("click");
await settle();
check("ring click decoded with source", /click \(ring\)/.test(await logText()),
  (await logText()).split("\n")[0]?.slice(0, 60));
check("ring pill goes live", (await page.getAttribute("#ring-status", "class")).includes("live"),
  await page.textContent("#ring-status"));

// Re-engage: that click backed out of the guest card.
await page.click("#beacon-roster button");
await settle();

// --- carousel ---------------------------------------------------------------
await ring("scroll-down");
await settle();
let view = await lens();
let meta = await lensMeta();
// The position indicator is a supporting fact, not one of the three lines.
check("scroll enters the recommendation carousel",
  meta.some((l) => /1 OF \d/.test(l || "")), JSON.stringify(view.slice(0, 2)));
const firstItem = view[0];

await ring("scroll-down");
await settle();
view = await lens();
meta = await lensMeta();
check("scroll advances to the next item",
  meta.some((l) => /2 OF \d/.test(l || "")) && view[0] !== firstItem,
  JSON.stringify(view.slice(0, 1)));

await ring("scroll-up");
await settle();
meta = await lensMeta();
check("scroll back returns to the first item",
  meta.some((l) => /1 OF \d/.test(l || "")), JSON.stringify(meta));

await ring("scroll-up");
await settle();
view = await lens();
check("scrolling off the top returns to the guest card",
  view.some((l) => (l || "").toUpperCase().includes("SARAH CHEN")),
  JSON.stringify(view.slice(0, 1)));

// --- carousel sets voice context -------------------------------------------
await ring("scroll-down");
await ring("scroll-down");
await settle();
const shown = (await lens())[0] || "";
await ring("double-click");
await page.waitForFunction(
  () => [...document.querySelectorAll("#virtual-lens .lens-text:not(.meta)")]
    .filter((e) => (e.textContent || "").trim()).length >= 2,
  { timeout: 18000 },
);
check("voice answer arrived after scrolling to an item", true);
check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

// --- inspector --------------------------------------------------------------
const insp = await inspector();
check("inspector records decoded events", /click · ring · sys/.test(insp),
  insp.split("\n")[0]?.slice(0, 60));
check("inspector shows raw payloads", /"sysEvent"/.test(insp));
check("nothing landed as UNDECODED", !/UNDECODED/.test(insp),
  /UNDECODED/.test(insp) ? insp.slice(0, 200) : "");

// --- root-page exit ---------------------------------------------------------
//
// Even Hub rejects apps whose root-page double-tap doesn't raise the system
// exit dialog. This is the check that keeps that from regressing.

// Get back to the root page. It takes three: the first click dismisses the
// voice answer, the second backs out of the carousel, the third ends the
// engagement. That layering is deliberate — a press should never end a guest
// session while something else is still on the glass.
await ring("click");
await settle();
await ring("click");
await settle();
await ring("click");
await settle();
check("back on the idle root page",
  (await lens()).some((l) => (l || "").includes("CUESEA READY")),
  JSON.stringify((await lens()).slice(0, 2)));
check("idle names its controls",
  (await lensMeta()).some((l) => /PRESS TO ASK/.test(l || "")),
  JSON.stringify(await lensMeta()));

await ring("double-click");
await settle();
const exitMode = await page.evaluate(() => window.__cueExitMode);
check("root double-press raises the system exit dialog", exitMode === 1,
  `shutDownPageContainer(${exitMode})`);
check("the glass shows the system dialog, not a blank screen",
  (await lens()).some((l) => /SYSTEM EXIT/.test(l || "")),
  JSON.stringify(await lens()));

// --- temple mirrors the ring ------------------------------------------------
await page.click('[data-event="click"][data-source="glasses-right"]');
await settle();
check("temple click decoded as glasses-right",
  /click \(glasses-right\)/.test(await logText()),
  (await logText()).split("\n")[0]?.slice(0, 60));

await page.click('[data-event="click"][data-source="container"]');
await settle();
check("container tap decodes without an event source",
  /click \(text\)/.test(await logText()),
  (await logText()).split("\n")[0]?.slice(0, 60));

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
