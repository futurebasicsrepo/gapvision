/**
 * Tap to glass, in a real browser.
 *
 *   node packages/web/test/checkin-browser.mjs
 *
 * Expects vite preview on :5173, realtime on :4000, AI service on :8000.
 *
 * This is the only test in the repo that exercises the whole product in one
 * pass: a guest's phone loads the URL printed on a plate, checks in, asks for
 * a size, and an associate's glasses receive something they can act on. Every
 * layer in between is real — the page, the open door, the service key, the
 * control plane, the socket.
 *
 * The assertion that matters is the last one. Everything before it can pass
 * while nothing arrives on the glass, which was the failure mode that shipped
 * three broken packages: an event name that looked right, sent to a client
 * that never listened for it.
 */
import { chromium } from "playwright";
import { io } from "socket.io-client";

const URL = process.env.WEB_URL || "http://localhost:5173";
const SERVER = process.env.SERVER_URL || "http://localhost:4000";
const ZONE = "fitting-room-3";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// An associate on the floor, wearing glasses, covering that fitting room.
const glasses = io(SERVER, { transports: ["websocket"], reconnection: false });
await new Promise((res, rej) => {
  glasses.on("connect", res);
  glasses.on("connect_error", rej);
});
const seen = [];
const taken = [];
const cleared = [];
glasses.on("request:new", (r) => seen.push(r));
glasses.on("request:taken", (r) => taken.push(r));
glasses.on("request:cleared", () => cleared.push(true));
glasses.emit("register", {
  role: "associate", name: "Test Associate", zone: ZONE, tenant: "gap",
  email: "associate@example.com",
});
await sleep(300);

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
// A phone, because that is the only device this page is ever opened on.
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

try {
  // --- the guest taps the plate ---------------------------------------------
  await page.goto(`${URL}/here?t=gap&z=${ZONE}&src=nfc-plate`,
                  { waitUntil: "networkidle" });
  await page.waitForSelector(".here-h1", { timeout: 15000 });

  check("the plate lands on the guest page, not on Cue Studio",
    !(await page.isVisible(".signin")) && await page.isVisible(".here-card"));

  const lead = (await page.textContent(".here-lead")) || "";
  // A guest reading the wrong room here is the only way a swapped plate ever
  // gets caught, which is why the zone is on the screen at all.
  check("the page names the room the plate is in", /Fitting room 3/i.test(lead),
    lead.trim());

  const h1 = await page.textContent(".here-h1");
  check("checked in without being asked who they are", /you're here/i.test(h1),
    h1.trim());

  // --- they say what they need ----------------------------------------------
  const chips = await page.locator(".here-chip").allTextContents();
  check("the needs are offered as chips", chips.length >= 4, chips.join(" | "));

  await page.locator(".here-chip", { hasText: "A different size" }).first().click();
  await page.selectOption("#here-product", { label: "High Rise Barrel Jeans" });
  await page.waitForSelector(".here-chip:has-text('32x30')", { timeout: 8000 });

  const sizeChips = await page.locator(".here-chip").allTextContents();
  // 34x32 is out of stock in the mock floor. It must still be offerable: the
  // floor holds stock the system has not caught up with, and hiding a size
  // reads to a guest as "that size does not exist".
  check("an out-of-stock size is shown, not hidden",
    sizeChips.some((c) => c.includes("34x32")), sizeChips.join(" | "));
  check("no unit counts reach the guest's phone",
    !/\b\d+ (left|in stock|units)\b/i.test(await page.content()));

  await page.locator(".here-chip", { hasText: "32x30" }).first().click();
  await page.fill("#here-note", "dark wash if you have it");
  await page.click(".here-btn");

  await page.waitForSelector(".here-h1:has-text('On its way')", { timeout: 15000 });
  check("the guest is told it landed", true);

  // --- and it reaches the glass ---------------------------------------------
  await sleep(500);
  check("the request reached the glasses", seen.length === 1,
    JSON.stringify(seen));

  const got = seen[0] || {};
  check("it arrives with the zone to walk to", got.zone === ZONE, got.zone);
  // Size first is not a style choice. The row truncates, and a clipped product
  // name still names the jean while a clipped size is a wrong answer read out
  // loud to a customer.
  check("the size leads the line", /^32x30/.test(got.line || ""), got.line);
  check("the guest's own words ride behind it",
    /dark wash/.test(got.line || ""), got.line);

  // --- an associate takes it -------------------------------------------------
  glasses.emit("request:claim", { requestId: got.request_id });
  await sleep(600);
  check("claiming it tells the floor", taken.length === 1, JSON.stringify(taken));
  check("the claim names who took it", Boolean(taken[0]?.by), JSON.stringify(taken[0]));

  // --- the guest gives up and leaves ----------------------------------------
  await page.click(".here-linkish:has-text('Stop')");
  await page.waitForSelector(".here-h1:has-text(\"checked out\")", { timeout: 10000 });
  await sleep(600);
  // Not cosmetic: a claimed request that survives the guest leaving sends an
  // associate to an empty fitting room holding a jean.
  check("stopping takes it off the floor", cleared.length === 1,
    `cleared ${cleared.length}`);

  const after = await (await fetch(`${SERVER}/api/checkin/config?t=gap`)).json();
  check("the config route stays open to a browser", Boolean(after.mode), after.mode);

  check("no page errors", pageErrors.length === 0, pageErrors.join("; "));
} catch (e) {
  check("suite ran", false, String(e.message || e));
} finally {
  await browser.close();
  glasses.close();
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
