/**
 * Manager dashboard, headless, against the live stack.
 *
 * Signs in as a real manager, checks the rendered numbers match what the API
 * returns, and — the part that matters — checks the things that must NOT
 * render: another tenant's data, admin controls for a manager, a transcript
 * the tenant didn't opt into storing.
 *
 *   node packages/web/test/dashboard-browser.mjs
 *
 * Expects vite preview on :5173, realtime on :4000, AI service on :8000,
 * with a seeded database.
 */
import { chromium } from "playwright";

const URL = process.env.WEB_URL || "http://localhost:5173";
const SERVER = process.env.SERVER_URL || "http://localhost:4000";
const MANAGER = process.env.CUE_MANAGER_EMAIL || "manager@example.com";
const PW = process.env.CUE_MANAGER_PASSWORD || "demo-password-1234";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// Ground truth straight from the API, to compare the DOM against.
const login = await (await fetch(`${SERVER}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: MANAGER, password: PW }),
})).json();
const authed = { Authorization: `Bearer ${login.token}` };
const summary = await (await fetch(`${SERVER}/api/analytics/summary?days=1`, { headers: authed })).json();
const board = await (await fetch(`${SERVER}/api/analytics/leaderboard?days=1`, { headers: authed })).json();

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

await page.goto(URL, { waitUntil: "networkidle" });

// --- sign in ----------------------------------------------------------------
check("sign-in screen is the front door", await page.isVisible(".signin"));
check("no dashboard leaks before sign-in", !(await page.isVisible(".grid-dashboard")));

await page.fill('input[type="email"]', MANAGER);
await page.fill('input[type="password"]', "wrong-password");
await page.click('button[type="submit"]');
await page.waitForSelector(".signin-error", { timeout: 8000 });
const errText = await page.textContent(".signin-error");
check("wrong password is refused", /incorrect/i.test(errText), errText.trim());

await page.fill('input[type="password"]', PW);
await page.click('button[type="submit"]');
await page.waitForSelector(".grid-dashboard", { timeout: 15000 });
check("signs in to the floor view", true);

// --- numbers match the API --------------------------------------------------
const tiles = await page.$$eval(".stat", (els) =>
  els.map((e) => ({
    label: e.querySelector(".stat-label")?.textContent?.trim(),
    value: e.querySelector(".stat-value")?.textContent?.trim(),
  })));
const tile = (label) => tiles.find((t) => t.label === label)?.value;

check("guests-helped tile matches the API",
  tile("Guests helped") === summary.engagements.toLocaleString(),
  `${tile("Guests helped")} vs ${summary.engagements}`);
check("sales tile matches the API",
  tile("Attributed sales")?.replace(/[^0-9.]/g, "") ===
    (summary.sale_cents / 100).toFixed(2),
  `${tile("Attributed sales")} vs ${summary.sale_cents}`);
check("assists tile matches the API",
  tile("Assists") === summary.assists.toLocaleString(),
  `${tile("Assists")} vs ${summary.assists}`);
check("questions tile matches the API",
  tile("Questions asked") === summary.voice.total.toLocaleString(),
  `${tile("Questions asked")} vs ${summary.voice.total}`);

// --- leaderboard ------------------------------------------------------------
const lbNames = await page.$$eval(".lb-name", (els) =>
  els.map((e) => e.textContent.replace(/^\s*\d+\s*/, "").trim()));
check("leaderboard lists the tenant's associates",
  lbNames.length === board.rows.length && lbNames[0] === board.rows[0]?.name,
  `${lbNames.length} rows, top: ${lbNames[0]}`);

const segs = await page.$$eval(".scoreseg", (els) =>
  els.map((e) => getComputedStyle(e).backgroundColor));
check("score is broken into its components", segs.length >= 2, `${segs.length} segments`);
check("legend names every series", (await page.$$(".legend-item")).length === 3);
check("assist weighting is explained, not just applied",
  /assists count for \d+ points/i.test(await page.textContent(".card-note")));

// --- privacy ----------------------------------------------------------------
const voiceCard = await page.textContent(".card:has(h3:text('Questions from the floor'))")
  .catch(() => "");
check("transcripts-off state is stated, not silently blank",
  /transcripts off/i.test(voiceCard) || /transcript not stored/i.test(voiceCard),
  voiceCard.slice(0, 60).replace(/\s+/g, " "));

// --- what must not be there -------------------------------------------------
const bodyText = await page.textContent("body");
check("no other tenant's data on the page",
  !/beta|t_beta|Alpha Retail/i.test(bodyText));
check("manager sees no tenant-provisioning controls",
  !/add tenant|billing plan/i.test(bodyText));

// --- session ----------------------------------------------------------------
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".grid-dashboard", { timeout: 10000 });
check("session survives a reload", true);

await page.click(".linkish");
await page.waitForSelector(".signin", { timeout: 8000 });
check("sign-out returns to the front door", true);
const leftover = await page.evaluate(() => sessionStorage.getItem("cue.token"));
check("sign-out clears the stored token", leftover === null);

check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

await page.screenshot({ path: "/tmp/cue-dashboard.png", fullPage: true }).catch(() => {});
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
