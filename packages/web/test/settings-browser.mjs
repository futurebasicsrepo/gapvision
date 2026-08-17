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
async function boot(role, { widgets } = {}) {
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
  // it — every field, not a plausible subset. The dashboard reads
  // `summary.voice.total` and `summary.voice.stt_seconds` with no guard, so a
  // payload missing either one throws inside render and blanks the whole app,
  // nav included. That is worth knowing about the dashboard and is not this
  // test's to fix; it is why these stubs are exhaustive rather than minimal.
  const FLOOR_STUBS = [
    ["**/api/analytics/summary**", {
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

await browser.close();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
