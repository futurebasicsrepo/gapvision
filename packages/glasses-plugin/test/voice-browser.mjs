/**
 * Browser-path check: drives the built plugin in headless Chromium against a
 * live realtime server + AI service, using the MockBridge's synthetic mic.
 *
 * This is the no-hardware proof of the whole voice loop — double-press,
 * chunked PCM, on-device endpointing, server round trip, answer painted into
 * the virtual lens — and it is what the demo does when there are no glasses
 * in the room.
 *
 *   node packages/glasses-plugin/test/voice-browser.mjs
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
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForSelector("#virtual-lens .lens-text");

const lens = () => page.$$eval("#virtual-lens .lens-text", (els) => els.map((e) => e.textContent));
const log = () => page.$eval("#event-log", (e) => e.textContent);

check("boots to idle", (await lens())[0]?.includes("CUE READY"), (await lens())[0]);
check("realtime linked",
  (await page.textContent("#server-status")) === "Realtime linked",
  await page.textContent("#server-status"));

// Engage a guest first so the voice query has context.
await page.waitForSelector("#beacon-roster button");
await page.click("#beacon-roster button");
await page.waitForFunction(
  () => document.querySelector("#session-info")?.textContent?.startsWith("Engaged"),
  { timeout: 5000 },
);
check("beacon engages a guest", (await page.textContent("#session-info")).includes("Sarah Chen"),
  await page.textContent("#session-info"));

// Double-press -> mic opens -> mock PCM streams -> level meter paints.
await page.click('[data-gesture="double-press"]');
await page.waitForFunction(
  () => [...document.querySelectorAll("#virtual-lens .lens-text")]
    .some((e) => e.textContent?.includes("LISTENING")),
  { timeout: 5000 },
);
check("mic opens and lens shows LISTENING", true);
check("voice pill goes live", (await page.getAttribute("#voice-status", "class")).includes("live"),
  await page.textContent("#voice-status"));

await page.waitForTimeout(900);
const metered = await lens();
check("level meter is animating", metered.some((l) => /█/.test(l || "")), metered[1]);

// The mock mic goes quiet at ~2.2s; on-device endpointing should close it.
await page.waitForFunction(
  () => [...document.querySelectorAll("#virtual-lens .lens-text")]
    .some((e) => e.textContent?.includes("thinking")),
  { timeout: 8000 },
);
check("silence endpointing closes the mic without a second press", true);

// Answer comes back and paints. The answer header is the quoted transcript,
// which is what distinguishes it from the "…thinking" placeholder.
await page.waitForFunction(
  () => [...document.querySelectorAll("#virtual-lens .lens-text")]
    .some((e) => /◍\s+".+"/.test(e.textContent || "")),
  { timeout: 10000 },
);
const answered = await lens();
check("answer painted to the lens", answered.filter(Boolean).length > 1,
  JSON.stringify(answered.slice(0, 3)));
check("transcript echoed in the log", /voice: ".+" →/.test(await log()),
  (await log()).split("\n")[0]?.slice(0, 80));

// A press dismisses the answer and restores the engaged view.
await page.click('[data-gesture="press"]');
await page.waitForTimeout(500);
const restored = await lens();
check("press restores the guest card",
  restored.some((l) => l?.includes("Sarah Chen")), JSON.stringify(restored.slice(0, 2)));
check("session survived the voice detour",
  (await page.textContent("#session-info")).includes("Engaged"),
  await page.textContent("#session-info"));

check("no uncaught page errors", consoleErrors.length === 0, consoleErrors.join(" | "));

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
