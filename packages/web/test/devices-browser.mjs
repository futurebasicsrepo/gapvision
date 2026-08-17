/**
 * A store's own glasses, as a retailer's admin meets them.
 *
 *   node packages/web/test/devices-browser.mjs
 *
 * Expects vite preview on :5173 and needs **no live services** — auth and the
 * admin API are intercepted, because what is under test is the surface and its
 * discipline around a credential (`tests/test_devices.py` covers the API
 * against Postgres, and the Console suite covers the other mount).
 *
 * What it holds down, in order of how badly it would hurt to get wrong:
 *
 *   1. **A manager cannot reach it, and neither can CueSea staff.** Minting an
 *      identity that registers as this store is a `client_admin` act; the API
 *      says so and this screen must not offer a door the API will slam.
 *   2. **The setup code is shown once and never re-rendered.** It is stored
 *      hashed — if this surface leaks it into a row or a re-fetch, it has
 *      published something nothing can rotate except a reissue.
 *   3. There is no tenant picker. A retailer has one store, and a chooser here
 *      would be a chooser that could only be wrong.
 *   4. A serial typed and then abandoned does not ride along on a lens that
 *      has no serial to give.
 */
import { chromium } from "playwright";

const URL = process.env.WEB_URL || "http://localhost:5173";
const TOKEN = "setup-code-that-must-never-be-re-rendered";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);

/** A 21×21 matrix of '0'/'1' — the shape the server sends, not a picture. */
const QR = Array.from({ length: 21 }, (_, y) =>
  Array.from({ length: 21 }, (_, x) => ((x + y) % 2 ? "1" : "0")).join(""));

async function boot(role, { devices = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const state = { devices: [...devices], mints: [], revoked: [], reissued: [], assigns: [] };
  const user = {
    id: "u1", name: "Ada Admin", email: "ada@example.com", role,
    tenant_slug: role === "cue_admin" ? null : "gap",
  };
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  await ctx.route("**/auth/me", (r) => json(r, { user }));

  await ctx.route("**/api/admin/tenants/*/devices", (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      const body = JSON.parse(req.postData() || "{}");
      state.mints.push(body);
      const device = {
        id: `d${state.devices.length + 1}`, label: body.label, serial: body.serial,
        surface: body.surface, user_id: body.user_id, presence: "provisioned",
        provisioned: true, last_seen_at: null, model: null,
      };
      state.devices.push(device);
      return json(route, {
        device, token: TOKEN,
        launch_url: `https://lens.cuesea.ai/g2/?t=${TOKEN}&tenant=gap`,
        qr: body.surface === "even-g2" ? QR : null,
      }, 201);
    }
    return json(route, { devices: state.devices });
  });
  await ctx.route("**/api/admin/devices/*/revoke", (route) => {
    const id = route.request().url().split("/devices/")[1].split("/")[0];
    state.revoked.push(id);
    const d = state.devices.find((x) => x.id === id);
    if (d) d.presence = "revoked";
    return json(route, { device: d });
  });
  await ctx.route("**/api/admin/devices/*/reissue", (route) => {
    const id = route.request().url().split("/devices/")[1].split("/")[0];
    state.reissued.push(id);
    return json(route, {
      device: state.devices.find((x) => x.id === id), token: TOKEN,
      launch_url: `https://lens.cuesea.ai/g2/?t=${TOKEN}&tenant=gap`, qr: null,
    });
  });
  await ctx.route("**/api/admin/devices/*", (route) => {
    if (route.request().method() === "PATCH") {
      state.assigns.push(JSON.parse(route.request().postData() || "{}"));
    }
    return json(route, { device: {} });
  });

  // Everything the floor view asks for on the way in, shaped the way the real
  // service shapes it — the dashboard reads `summary.voice.*` unguarded, so a
  // thin stub throws inside render and blanks the app, nav included.
  const STUBS = [
    ["**/api/analytics/summary**", {
      engagements: 0, associates_active: 0, sale_cents: 0, sales: 0, assists: 0,
      voice: { total: 0, ok: 0, avg_latency_ms: 0, stt_seconds: 0 },
    }],
    ["**/api/analytics/leaderboard**", { rows: [], weights: {} }],
    ["**/api/analytics/engagements**", { engagements: [] }],
    ["**/api/analytics/voice**", { queries: [], total: 0 }],
    ["**/api/analytics/requests**", { waiting: [], demand: [] }],
    ["**/api/admin/tenants", { tenants: [{ slug: "gap", name: "Gap" }] }],
    ["**/api/admin/tenants/gap", { tenant: { id: "t1", slug: "gap", name: "Gap", config: {} } }],
    ["**/api/admin/users**", { users: [
      { id: "u9", name: "Ada Associate", role: "associate", status: "active" },
      { id: "u8", name: "Mo Manager", role: "manager", status: "active" },
    ] }],
  ];
  for (const [path, body] of STUBS) await ctx.route(path, (r) => json(r, body));

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

// --- 1. who may reach it ------------------------------------------------------

{
  const { p, ctx } = await boot("manager");
  check("a manager is not offered Glasses",
    !(await navLabels(p)).includes("Glasses"), (await navLabels(p)).join(","));
  await ctx.close();
}
{
  const { p, ctx } = await boot("cue_admin");
  // Deliberate: CueSea staff mint devices in Console, where the store is named
  // rather than assumed. A second door from a surface they reached through a
  // switcher is how the wrong shop gets a pair of glasses.
  check("CueSea staff are not offered Glasses either",
    !(await navLabels(p)).includes("Glasses"), (await navLabels(p)).join(","));
  await ctx.close();
}

// --- 2, 3, 4. the retailer's own admin ---------------------------------------

{
  const { p, ctx, state } = await boot("client_admin");
  check("a retailer's admin is offered Glasses", (await navLabels(p)).includes("Glasses"),
    (await navLabels(p)).join(","));

  await p.click('.view-switch button:has-text("Glasses")');
  await p.waitForTimeout(600);

  const body = await p.textContent("body");
  check("and no tenant picker, because they have one store",
    !/all tenants/i.test(body) && (await p.locator("select").count()) === 0,
    `${await p.locator("select").count()} selects on an empty fleet`);

  await p.click('button:has-text("Add a pair")');
  await p.waitForSelector(".add-device", { timeout: 8_000 });

  // --- 4. the serial that must not ride along -------------------------------
  await p.fill('.add-device input[placeholder="From the box"]', "G2-TYPO");
  await p.selectOption(".add-device select", "mrbd");
  await p.waitForTimeout(200);
  check("a Meta lens is not asked for a serial it cannot have",
    (await p.locator('.add-device input[placeholder="From the box"]').count()) === 0);

  await p.selectOption(".add-device select", "even-g2");
  await p.fill('.add-device input[placeholder="Denim wall, pair 1"]', "Denim wall, pair 1");
  await p.fill('.add-device input[placeholder="From the box"]', "G2-0007");
  await p.click('.add-device button[type="submit"]');
  await p.waitForSelector(".minted", { timeout: 8_000 });

  check("the mint carries what was picked",
    state.mints.at(-1)?.surface === "even-g2" && state.mints.at(-1)?.serial === "G2-0007",
    JSON.stringify(state.mints.at(-1)));

  const panel = await p.textContent(".minted");
  check("the panel says the code cannot be shown again — before it is dismissed",
    /only time|cannot|nobody/i.test(panel), panel.slice(0, 110));
  check("the link is on screen to copy",
    (await p.textContent('[data-testid="launch-url"]')).includes(TOKEN));
  check("the code is drawn as rectangles rather than injected markup",
    (await p.locator(".qr rect").count()) > 1);

  // --- 2. the code, after dismissal and after a reload ----------------------
  await p.click('.minted button:has-text("Done")');
  await p.waitForTimeout(600);
  check("the code is gone from the document once dismissed",
    !(await p.textContent("body")).includes(TOKEN));
  check("and the pair is in the list",
    (await p.textContent("body")).includes("Denim wall, pair 1"));

  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForTimeout(900);
  await p.click('.view-switch button:has-text("Glasses")');
  await p.waitForTimeout(600);
  check("a reload does not bring the code back",
    !(await p.textContent("body")).includes(TOKEN));

  await ctx.close();
}

// --- the fleet a store already has -------------------------------------------

{
  const { p, ctx, state } = await boot("client_admin", { devices: [
    { id: "d1", label: "Denim wall, pair 1", serial: "G2-0001", surface: "even-g2",
      presence: "active", provisioned: true, last_seen_at: new Date().toISOString(),
      user_id: "u9", model: "g2" },
    { id: "d2", label: "Training tab", serial: null, surface: "sim",
      presence: "provisioned", provisioned: true, last_seen_at: null, user_id: null },
    { id: "d3", label: "Lost pair", serial: "G2-0009", surface: "even-g2",
      presence: "revoked", provisioned: true, last_seen_at: new Date().toISOString(),
      user_id: null, model: "g2" },
  ] });
  await p.click('.view-switch button:has-text("Glasses")');
  await p.waitForTimeout(600);
  const body = await p.textContent("body");

  check("the fleet reads in the retailer's words, not ours",
    body.includes("Browser tab") && !body.includes("Lens Sim"), "surface labels");
  check("presence is shown", body.includes("on the floor") && body.includes("not used yet"));

  const revoked = p.locator(".row", { hasText: "Lost pair" });
  check("a pair already revoked is not offered revoking again",
    (await revoked.locator('button:has-text("Revoke code")').count()) === 0);

  await p.locator(".row", { hasText: "Denim wall, pair 1" })
    .locator('button:has-text("Revoke code")').first().click();
  await p.waitForTimeout(500);
  check("revoking reaches the server", state.revoked.includes("d1"),
    JSON.stringify(state.revoked));

  await revoked.locator('button:has-text("New code")').first().click();
  await p.waitForSelector(".minted", { timeout: 8_000 });
  check("a new code can be issued for a pair that was revoked",
    state.reissued.includes("d3"), JSON.stringify(state.reissued));

  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
