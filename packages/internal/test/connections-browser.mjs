/**
 * The Connections panel — what a store is plugged into, honestly.
 *
 *   node packages/internal/test/connections-browser.mjs
 *
 * Expects `vite preview` on :5176. The endpoint is stubbed, including the case
 * where it is missing entirely — Console and the AI service deploy on separate
 * pushes, so either can be ahead of the other for as long as a merge takes.
 *
 * What it holds down, in order of how badly getting it wrong would hurt:
 *
 *   1. **A connector that is not built says so, and has no button.** The
 *      ordinary integrations page is a wall of logos over forms that file
 *      feature requests. That is a lie told at the exact moment a buyer is
 *      deciding whether to trust the product. This panel is allowed to list
 *      unbuilt things — it is not allowed to imply they work.
 *   2. **"Set up and silent" is not "none set up".** Only one of those is a
 *      fault, and a fleet panel that flattens them tells a manager their floor
 *      is fine when nobody on it is answering. Same distinction the answer
 *      engine keeps between empty and unreachable.
 *   3. **An absent endpoint reads as absent, never as "nothing connected".**
 *   4. No secret is ever rendered, whatever the server sends.
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

const MINUTES = (n) => new Date(Date.now() - n * 60_000).toISOString();

const PAYLOAD = {
  tenant: "gap",
  summary: { systems_connected: 1, systems_available: 1, devices: 7, answering: 3 },
  systems: [
    {
      id: "shopify", name: "Shopify", kind: "commerce", state: "connected",
      detail: "gap-demo.myshopify.com", last_tested_at: MINUTES(12), last_test_ok: true,
      missing_required_scopes: [], degraded_without: { read_inventory: "live floor stock counts" },
      gives: ["Guest records and loyalty", "Order history"],
      note: "The full adapter.",
    },
    {
      id: "salesforce", name: "Salesforce", kind: "crm", state: "exploring",
      gives: ["Guest records and history"],
      note: "Same three-method adapter. The work is the auth and the object mapping.",
    },
    {
      id: "feed", name: "Your own feed (CSV or SFTP)", kind: "feed", state: "planned",
      gives: ["Inventory from a nightly export"],
      note: "The widest item on the roadmap and the cheapest.",
    },
  ],
  peripherals: [
    { id: "even-g2", name: "Even G2 glasses", kind: "glasses",
      devices: 4, revoked: 1, active: 3, last_seen: MINUTES(2), state: "connected",
      note: "Sideloaded plugin, paired by QR." },
    { id: "phone", name: "Store phone or handheld", kind: "mobile",
      devices: 3, revoked: 0, active: 0, last_seen: MINUTES(400), state: "connected",
      note: "A device the store owns. An associate's own phone is not one of these." },
    { id: "mrbd", name: "Meta Ray-Ban Display", kind: "glasses",
      devices: 0, revoked: 0, active: 0, last_seen: null, state: "available",
      note: "A web app on the glasses themselves." },
  ],
};

async function boot({ connections = PAYLOAD } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1200 } });
  const user = {
    id: "u1", name: "Cue Staff", email: "staff@cuesea.ai",
    role: "cue_admin", tenant_slug: null,
  };
  const json = (r, body, status = 200) =>
    r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  await ctx.route("**/api/**", (r) => json(r, {}));
  await ctx.route("**/auth/me", (r) => json(r, { user }));
  await ctx.route("**/api/admin/tenants?**", (r) =>
    json(r, { tenants: [{ slug: "gap", name: "Gap" }, { slug: "reformation", name: "Reformation" }] }));
  await ctx.route("**/connections**", (r) =>
    (connections === null ? r.fulfill({ status: 404, body: "" }) : json(r, connections)));

  const p = await ctx.newPage();
  await p.addInitScript(([u]) => {
    sessionStorage.setItem("cue.console.token", "stub");
    sessionStorage.setItem("cue.console.user", JSON.stringify(u));
  }, [user]);
  await p.goto(URL, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(800);
  await p.locator(".rail-item").filter({ hasText: "Connections" }).first().click();
  await p.waitForSelector(".connections", { timeout: 8_000 });
  await p.waitForTimeout(500);
  return { p, ctx };
}

// --- 1. the panel does not pretend ------------------------------------------

{
  const { p, ctx } = await boot();
  const body = await p.textContent(".connections");

  check("an unbuilt connector is listed and named as unbuilt",
    /Salesforce/.test(body) && /researched, not decided/i.test(body),
    body.slice(0, 200));
  check("and a planned one is distinguished from a researched one",
    /not built yet/i.test(body),
    "planned and exploring send a merchant to different next actions");

  // The whole rule, mechanically: no control anywhere in the list offers to
  // connect something that does not exist.
  const buttons = await p.locator(".conn button, .conn a").count();
  check("no unbuilt row carries a button that would file a feature request",
    buttons === 0, `${buttons} controls found inside connector rows`);

  check("what a connector would give you is stated, not just its name",
    /Inventory from a nightly export/.test(body), body.slice(0, 300));

  // --- 2. silent is not absent ---------------------------------------------

  const phoneRow = p.locator(".conn").filter({ hasText: "Store phone or handheld" });
  const phoneText = await phoneRow.textContent();
  check("a surface that is set up but silent says so",
    /none answering/i.test(phoneText), phoneText);
  check("and a surface that was never set up says something different",
    /none set up/i.test(await p.locator(".conn").filter({ hasText: "Meta Ray-Ban" }).textContent()),
    "a fleet panel that flattens these tells a manager the floor is fine when it is not");
  check("a surface with devices on the floor reports how many",
    /3 on the floor/.test(await p.locator(".conn").filter({ hasText: "Even G2" }).textContent()));
  check("revoked devices are counted separately from live ones",
    /4 set up · 1 revoked/.test(await p.locator(".conn").filter({ hasText: "Even G2" }).textContent()),
    await p.locator(".conn").filter({ hasText: "Even G2" }).textContent());

  // --- 3. the summary leads with the number that matters -------------------

  const firstStat = await p.locator(".conn-summary .stat").first().textContent();
  check("the summary leads with how many devices are answering right now",
    /answering right now/i.test(firstStat), firstStat);

  // --- 4. a live connection is honest about its own health -----------------

  const shopify = await p.locator(".conn").filter({ hasText: "Shopify" }).first().textContent();
  check("a connected system shows what it is connected to",
    /gap-demo\.myshopify\.com/.test(shopify), shopify);
  check("and when it was last actually checked",
    /last check passed/.test(shopify) && /min ago/.test(shopify), shopify);
  check("a partially-granted connection says what it cannot do",
    /Working, with less/i.test(shopify) && /live floor stock counts/.test(shopify), shopify);

  // --- the BYOD sentence survives into this panel too ----------------------
  check("the phone row repeats that an associate's own phone is not a store device",
    /own phone is not one of these/i.test(phoneText), phoneText);

  await ctx.close();
}

// --- 5. a missing endpoint --------------------------------------------------

{
  const { p, ctx } = await boot({ connections: null });
  const body = await p.textContent(".connections");
  check("an absent endpoint reads as absent, not as 'nothing connected'",
    /No connections endpoint on this deployment/i.test(body), body.slice(0, 200));
  check("and no summary numbers are invented to fill the space",
    (await p.locator(".conn-summary").count()) === 0);
  await ctx.close();
}

// --- 6. nothing secret is rendered, whatever arrives ------------------------

{
  // The server's `describe()` never emits a secret; this asserts the panel
  // would not render one even if a future change let one through.
  const leaky = JSON.parse(JSON.stringify(PAYLOAD));
  leaky.systems[0].admin_token = "shpat_deadbeefdeadbeefdeadbeef";
  leaky.systems[0].client_secret = "sec_should_never_render";
  const { p, ctx } = await boot({ connections: leaky });
  const html = await p.innerHTML(".connections");
  check("a credential that reached the client is still never drawn",
    !/shpat_|sec_should_never_render/.test(html));
  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
