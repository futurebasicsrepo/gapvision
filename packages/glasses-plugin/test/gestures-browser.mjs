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
await page.waitForSelector("#virtual-lens .lens-text");

const lens = () => page.$$eval("#virtual-lens .lens-text", (els) => els.map((e) => e.textContent));
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
check("scroll enters the recommendation carousel",
  view.some((l) => /1 of \d/.test(l || "")), JSON.stringify(view.slice(0, 2)));
const firstItem = view[0];

await ring("scroll-down");
await settle();
view = await lens();
check("scroll advances to the next item",
  view.some((l) => /2 of \d/.test(l || "")) && view[0] !== firstItem,
  JSON.stringify(view.slice(0, 1)));

await ring("scroll-up");
await settle();
view = await lens();
check("scroll back returns to the first item",
  view.some((l) => /1 of \d/.test(l || "")), JSON.stringify(view.slice(0, 1)));

await ring("scroll-up");
await settle();
view = await lens();
check("scrolling off the top returns to the guest card",
  view.some((l) => l?.includes("Sarah Chen")), JSON.stringify(view.slice(0, 1)));

// --- carousel sets voice context -------------------------------------------
await ring("scroll-down");
await ring("scroll-down");
await settle();
const shown = (await lens())[0] || "";
await ring("double-click");
await page.waitForFunction(
  () => [...document.querySelectorAll("#virtual-lens .lens-text")]
    .some((e) => /◍\s+".+"/.test(e.textContent || "")),
  { timeout: 15000 },
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
