/**
 * Console on a phone.
 *
 *   node packages/internal/test/mobile-browser.mjs
 *
 * Expects `vite preview` on :5176. No services — every panel is stubbed, since
 * what is under test is layout, and layout does not care whether the numbers
 * are real.
 *
 * **The assertion that matters is horizontal scroll**, and it is worth saying
 * why it is the whole test rather than one of many. A page that scrolls
 * sideways on a phone does not look slightly wrong; it hides its own right-hand
 * edge, which is where every value, status and action in this app lives. And it
 * arrives silently — nothing throws, nothing looks broken in a desktop browser,
 * and the panel that does it can be one nobody opened on a phone that week.
 *
 * It had arrived, exactly like that: `.span-12` was `grid-column: span 12`,
 * which is correct on the twelve-track grid and meaningless below it. The
 * narrow breakpoints re-track to six columns and then two, and a `span 12` item
 * on a two-column grid does not clamp — it opens ten implicit tracks and drags
 * the panel to ~1018px inside a 390px viewport. Every panel with a full-width
 * card did it, which is most of them.
 *
 * So: open each panel at 390 × 844 and assert the document is no wider than the
 * window. A table wider than the screen inside its own scroller is fine and
 * deliberate; the *document* overflowing is not.
 */
import { chromium } from "playwright";

const URL = process.env.CONSOLE_URL || "http://localhost:5176";
const PHONE = { width: 390, height: 844 };

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const ctx = await browser.newContext({
  viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
});

const user = {
  id: "u1", name: "Cue Staff", email: "staff@cuesea.ai", role: "cue_admin", tenant_slug: null,
};
const json = (r, body, status = 200) =>
  r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

await ctx.route("**/api/**", (r) => json(r, {}));
await ctx.route("**/auth/me", (r) => json(r, { user }));
// Enough shape for the panels that read one, so this measures a populated
// layout rather than a page full of empty states — an empty table cannot
// overflow, and an empty table is not what ships.
await ctx.route("**/api/admin/tenants?**", (r) => json(r, { tenants: [{
  id: "t1", slug: "gap", name: "Gap", billing_plan: "pilot", status: "active",
  crm_provider: "mock", config: {}, privacy: {}, users: 2, devices: 5,
  engagements: 12, voice: 4, stt_minutes: 3,
}] }));
await ctx.route("**/api/admin/users**", (r) => json(r, { users: [
  { id: "u9", name: "Ada Associate", role: "associate", status: "active",
    email: "ada@gap.example.com", last_login_at: new Date().toISOString() },
] }));
await ctx.route("**/api/admin/staff**", (r) => json(r, { users: [
  { id: "s1", name: "Cue Staff", role: "cue_admin", status: "active",
    email: "staff@cuesea.ai", last_login_at: new Date().toISOString() },
] }));
await ctx.route("**/api/admin/tenants/*/devices", (r) => json(r, { devices: [
  { id: "d1", label: "Denim wall, pair 1", serial: "G2-0001", surface: "even-g2",
    presence: "active", provisioned: true, last_seen_at: new Date().toISOString(),
    user_id: "u9", model: "g2" },
  { id: "d2", label: "Training tab", serial: null, surface: "sim",
    presence: "provisioned", provisioned: true, last_seen_at: null, user_id: null },
] }));

const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
await page.addInitScript(([u]) => {
  sessionStorage.setItem("cue.console.token", "stub");
  sessionStorage.setItem("cue.console.user", JSON.stringify(u));
}, [user]);
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1_200);

/** The document, not an element: an element that scrolls inside its own
 *  `overflow-x: auto` container is a deliberate design, and the page carrying
 *  it sideways is not. */
const overflow = () => page.evaluate(() => ({
  doc: document.documentElement.scrollWidth,
  win: window.innerWidth,
}));

// **Measured on landing, before any navigation, and this ordering is the test.**
// The overflow is self-sustaining: twelve tracks force the page to ~1018px, the
// overflow widens the layout viewport to match, and the `max-width: 620px`
// query then never matches — so the grid never collapses and the page never
// recovers. Navigate first and you measure a layout that has already been
// pushed around; the landing view is where it is honest.
{
  const { doc, win } = await overflow();
  check("the page it lands on fits the phone it landed on", doc <= win + 1,
    `document ${doc}px in a ${win}px window`);
  check("and the window is the phone's width, not a widened layout viewport",
    win <= PHONE.width + 1, `${win}px for a ${PHONE.width}px device`);
}

// The rail is an overlay at this width, so every navigation goes through it —
// which also means the menu button working is load-bearing, not cosmetic.
const toggle = page.locator(".nav-toggle");
check("the rail collapses to a menu button", await toggle.count() === 1);

async function open(label) {
  if (await toggle.count()) {
    await toggle.click();
    await page.waitForTimeout(350);
  }
  const item = page.locator(".rail-item").filter({ hasText: label }).first();
  if (await item.count() === 0) return false;
  await item.click();
  await page.waitForTimeout(650);
  return true;
}

const PANELS = ["Health", "Tenants", "CueSea staff", "Plates", "Retention",
                "Sales", "Marketing", "Architecture", "Brand"];

for (const label of PANELS) {
  const opened = await open(label);
  if (!opened) {
    check(`${label} is in the rail`, false, "not found");
    continue;
  }
  const { doc, win } = await overflow();
  // One pixel of slack: sub-pixel layout rounding is not a bug.
  check(`${label} does not scroll sideways on a phone`, doc <= win + 1,
    `document ${doc}px in a ${win}px window`);
}

// A stacked table is only an improvement if the headings came with it — a
// block of bare values is worse than a table you have to scroll.
await open("Tenants");
await page.locator("tr", { hasText: "Gap" }).first().click();
await page.waitForTimeout(700);
const labelled = await page.evaluate(() => {
  const td = [...document.querySelectorAll(".table td[data-label]")][0];
  if (!td) return null;
  return getComputedStyle(td, "::before").content;
});
check("stacked rows carry their column headings", Boolean(labelled) && labelled !== "none",
  String(labelled));

check("no page errors on any panel", errors.length === 0, errors.join(" | "));

await browser.close();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
