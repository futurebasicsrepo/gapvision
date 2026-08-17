/**
 * The Lens Sim, inside Console.
 *
 *   node packages/internal/test/lens-sim-browser.mjs
 *
 * Expects `vite preview` on :5176 and needs no services — the whole point of
 * the demo drive is that it runs from nothing.
 *
 * What this holds down is not "the panel renders". It is the two properties
 * that make the panel worth having, and one that would make it dangerous:
 *
 *   1. **The lens in the frame is the real bundle**, served from Console's own
 *      origin. If the build ever ships the placeholder instead — a workspace
 *      that was not installed, a Vercel image that only installed this package
 *      — the panel still loads, and this test is what notices.
 *   2. **The bridge works.** A guest signal fired from the driver panel reaches
 *      the lens and changes what is on the glass. That is the whole feature:
 *      an embed that renders but cannot be driven is a screenshot.
 *   3. **The iframe is not sandboxed.** A `sandbox` attribute puts the frame in
 *      an opaque origin, and the bridge answers same-origin only — it would
 *      break the feature silently, and look like a hardening improvement while
 *      doing it.
 */
import { chromium } from "playwright";

const URL = process.env.CONSOLE_URL || "http://localhost:5176";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });

const user = {
  id: "u1", name: "Cue Staff", email: "staff@cuesea.ai", role: "cue_admin", tenant_slug: null,
};
await ctx.route("**/auth/me", (r) =>
  r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user }) }));

const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript(([u]) => {
  sessionStorage.setItem("cue.console.token", "stub-token");
  sessionStorage.setItem("cue.console.user", JSON.stringify(u));
}, [user]);
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(900);

// --- the rail ----------------------------------------------------------------

const rail = page.locator(".rail-item").filter({ hasText: "Lens Sim" });
check("the rail offers Lens Sim", await rail.count() === 1);
await rail.first().click();
await page.waitForSelector("iframe.lens-sim", { timeout: 8_000 });

// --- 3. the sandbox that must not be there -----------------------------------

check("the iframe is not sandboxed into an opaque origin",
  (await page.getAttribute("iframe.lens-sim", "sandbox")) === null);

// --- 1. the real bundle, same origin -----------------------------------------

const sim = page.frameLocator("iframe.lens-sim");
await sim.locator("body").waitFor({ timeout: 10_000 });
const simText = await sim.locator("body").innerText();
const real = !/was not built into this deployment/i.test(simText);
check("the sim built into this deployment, rather than the placeholder",
  real, simText.slice(0, 100));

// Everything below drives the lens. Against the placeholder there is no lens
// to drive, so say that once rather than throwing five frame lookups deep —
// the interesting fact is already recorded above.
if (!real) {
  console.log("\nThe placeholder is being served, so there is nothing to drive.");
  console.log(`${results.filter(Boolean).length}/${results.length} passed`);
  await browser.close();
  process.exit(1);
}

// Same origin is what the bridge depends on; if it were cross-origin, reading
// the nested document from here would throw rather than return a string.
const lensText = await sim.frameLocator("#lens").locator("body").innerText();
check("and the lens inside it is reachable, which is what same-origin means",
  typeof lensText === "string" && lensText.length > 0, lensText.slice(0, 80));
check("the lens comes up idle, waiting for a guest",
  /AWAITING GUEST SIGNAL|NOT PROVISIONED/i.test(lensText), lensText.slice(0, 120));

// --- 2. the bridge ------------------------------------------------------------

const before = lensText;
// Whatever the driver panel calls its guest buttons, one of them fires a
// signal. Click the first and watch the glass, rather than asserting on a
// label this test does not own.
const drivers = sim.locator("button");
const count = await drivers.count();
check("the driver panel offers controls", count > 0, `${count} buttons`);

let changed = false;
for (let i = 0; i < Math.min(count, 6) && !changed; i++) {
  await drivers.nth(i).click();
  await page.waitForTimeout(500);
  const now = await sim.frameLocator("#lens").locator("body").innerText();
  if (now !== before) changed = true;
}
check("driving the panel changes what is on the glass — the bridge is live",
  changed, changed ? "" : "nothing the driver did reached the lens");

check("no page errors while driving it", errors.length === 0, errors.join(" | ").slice(0, 200));

await browser.close();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
