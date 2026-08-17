/**
 * The store's own settings, as a retailer's admin meets them.
 *
 *   node packages/web/test/settings-browser.mjs
 *
 * Expects vite preview on :5173 and needs **no live services** — the auth and
 * admin endpoints are intercepted, because what is being tested is the surface
 * and its gating, not the API underneath it (`test_tenants.py` covers that).
 *
 * What it holds down, in order of how badly it would hurt to get wrong:
 *
 *   1. **The switch shows the state the database holds.** A tenant that has
 *      never touched `config.widgets` has widgets *on*, so a plain truthy read
 *      would draw OFF for almost every store — the exact bug the Console
 *      privacy switches were fixed for, and the reason this test exists at all.
 *   2. Flipping it sends a *merged* config, so a patch naming one key cannot
 *      wipe a sibling.
 *   3. The knob moves when the server has moved, not when the finger lands.
 *   4. A manager cannot reach it, and neither can CueSea staff.
 */
import { chromium } from "playwright";

const URL = process.env.WEB_URL || "http://localhost:5173";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);

/**
 * A signed-in browser for one role, with the admin API stubbed.
 *
 * `patches` records every PATCH body so the merge can be asserted rather than
 * assumed, and `config` is mutated by the stub so a reload reflects the write
 * the way a real database would.
 */
async function boot(role, { widgets, thinSummary = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const state = { patches: [], config: widgets === undefined ? {} : { widgets } };
  const user = {
    id: "u1", name: "Ada Admin", email: "ada@example.com", role,
    tenant_slug: role === "cue_admin" ? null : "gap",
  };

  await ctx.route("**/auth/me", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user }) }));
  await ctx.route("**/api/admin/tenants/**", async (route) => {
    const req = route.request();
    if (req.method() === "PATCH") {
      const body = JSON.parse(req.postData() || "{}");
      state.patches.push(body);
      // The server merges too; the stub does the same so the UI sees what a
      // real write would leave behind.
      state.config = { ...state.config, ...(body.config || {}) };
    }
    return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ tenant: { id: "t1", slug: "gap", name: "Gap", config: state.config } }) });
  });
  // Everything the floor view asks for, shaped the way the real service shapes
  // it — every field, not a plausible subset, because that is what these tests
  // are meant to exercise.
  //
  // The dashboard used to *require* that: it read `summary.voice.total` and
  // `summary.voice.stt_seconds` unguarded, so a payload missing either threw
  // inside render and blanked the whole app, nav included. That is fixed —
  // `ManagerDashboard` fills the shape once before reading it — and the last
  // block in this file holds the fix down. These stubs stay exhaustive anyway:
  // realistic input is the point, and a suite that only ever sends the thin
  // payload would stop noticing if the real one changed.
  const FLOOR_STUBS = [
    ["**/api/analytics/summary**", thinSummary ? { engagements: 0 } : {
      engagements: 0, associates_active: 0, sale_cents: 0, sales: 0, assists: 0,
      voice: { total: 0, ok: 0, avg_latency_ms: 0, stt_seconds: 0 },
    }],
    ["**/api/analytics/leaderboard**", { rows: [], weights: {} }],
    ["**/api/analytics/engagements**", { engagements: [] }],
    ["**/api/analytics/voice**", { queries: [], total: 0 }],
    ["**/api/analytics/requests**", { waiting: [], demand: [] }],
    ["**/api/admin/tenants", { tenants: [{ slug: "gap", name: "Gap" }] }],
    ["**/api/admin/users**", { users: [] }],
    ["**/api/admin/devices**", { devices: [] }],
  ];
  for (const [path, body] of FLOOR_STUBS) {
    await ctx.route(path, (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
  }

  const p = await ctx.newPage();
  await p.addInitScript(([u]) => {
    sessionStorage.setItem("cue.token", "stub-token");
    sessionStorage.setItem("cue.user", JSON.stringify(u));
  }, [user]);
  await p.goto(URL, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(900);
  return { p, ctx, state };
}

const navLabels = (p) => p.$$eval(".view-switch button", (e) => e.map((x) => x.textContent.trim()));

// --- 1. a store that has never touched the switch ---------------------------

{
  const { p, ctx, state } = await boot("client_admin");
  check("a retailer's admin is offered Settings",
    (await navLabels(p)).includes("Settings"), (await navLabels(p)).join(","));

  await p.click('.view-switch button:has-text("Settings")');
  await p.waitForSelector(".set-row", { timeout: 8_000 });

  check("a store that never set the flag reads as ON, because that is the truth",
    (await p.getAttribute(".set-switch", "aria-checked")) === "true",
    `config was ${JSON.stringify(state.config)}`);

  // --- 2 and 3. flipping it -------------------------------------------------
  await p.click(".set-switch");
  await p.waitForTimeout(700);
  check("switching it off sends widgets false",
    state.patches.at(-1)?.config?.widgets === false,
    JSON.stringify(state.patches.at(-1)));
  check("the knob follows the server",
    (await p.getAttribute(".set-switch", "aria-checked")) === "false");

  await p.click(".set-switch");
  await p.waitForTimeout(700);
  check("and back on again",
    state.patches.at(-1)?.config?.widgets === true
      && (await p.getAttribute(".set-switch", "aria-checked")) === "true",
    JSON.stringify(state.patches.at(-1)));

  await ctx.close();
}

// --- 2b. the merge, with a sibling to lose ----------------------------------

{
  const { p, ctx, state } = await boot("client_admin", { widgets: true });
  // A store with another config key already set. The patch must carry it.
  state.config = { widgets: true, voice: false };
  await p.click('.view-switch button:has-text("Settings")');
  await p.waitForSelector(".set-row", { timeout: 8_000 });
  await p.click(".set-switch");
  await p.waitForTimeout(700);
  check("the patch merges rather than replacing, so a sibling key survives",
    state.patches.at(-1)?.config?.voice === false,
    JSON.stringify(state.patches.at(-1)));
  await ctx.close();
}

// --- 4. who cannot reach it -------------------------------------------------

{
  const { p, ctx } = await boot("manager");
  check("a manager is not offered Settings",
    !(await navLabels(p)).includes("Settings"), (await navLabels(p)).join(","));
  await ctx.close();
}

{
  const { p, ctx } = await boot("cue_admin");
  // Deliberate: CueSea staff configure retailers in Console. A second door
  // from a surface where the store came out of a switcher is how the wrong
  // shop gets changed.
  check("CueSea staff are not offered Settings either",
    !(await navLabels(p)).includes("Settings"), (await navLabels(p)).join(","));
  await ctx.close();
}

// --- 5. a summary that arrived incomplete ------------------------------------
//
// The failure this guards against is not a missing panel — it is a **white
// page**. Five reads on the floor view walked into `summary.voice.*`, so a
// payload without `voice` threw inside render and took the whole app down, nav
// included: no error, no way to navigate anywhere else, nothing to do but
// reload into the same thing.
//
// Not hypothetical. Studio deploys on Vercel and the AI service on Railway, on
// separate pushes, so "the server always sends the whole shape" holds only
// while the two are in step.
{
  const { p, ctx } = await boot("client_admin", { thinSummary: true });
  const labels = await navLabels(p);
  check("a summary missing fields does not blank the app",
    labels.length > 0, `nav had ${labels.length} items: ${labels.join(",")}`);
  check("and the rest of the surface is still reachable",
    labels.includes("Settings"), labels.join(","));

  // The floor still draws — degraded to zeroes rather than absent, because a
  // field the server stopped sending is unknown, and unknown is not an outage.
  await p.click('.view-switch button:has-text("Settings")');
  await p.waitForSelector(".set-row", { timeout: 8_000 });
  check("and Settings still works underneath it",
    (await p.getAttribute(".set-switch", "aria-checked")) === "true");
  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
