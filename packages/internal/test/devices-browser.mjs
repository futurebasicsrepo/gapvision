/**
 * The Devices card, as CueSea staff meet it.
 *
 *   node packages/internal/test/devices-browser.mjs
 *
 * Expects `vite preview` on :5176 and needs **no live services** — auth and the
 * admin API are intercepted, because what is under test is the surface and its
 * discipline around a credential, not the API underneath it
 * (`tests/test_devices.py` covers that against Postgres).
 *
 * What it holds down, in order of how badly it would hurt to get wrong:
 *
 *   1. **The token is shown once and never re-rendered.** It is stored hashed;
 *      if this console ever puts it in a row, a list, or a re-fetch, it has
 *      published a credential that nothing can rotate except a reissue.
 *   2. The panel says so *before* it can be dismissed, because after is too
 *      late — there is no route that could show it again.
 *   3. Minting sends the surface that was picked, and a serial only for the
 *      surface that has one.
 *   4. The QR is drawn from data, not injected as markup.
 *   5. A revoked device that is still being seen is called out — it is the one
 *      row in a fleet worth reading.
 */
import { chromium } from "playwright";

const URL = process.env.CONSOLE_URL || "http://localhost:5176";
const TOKEN = "provision-token-that-must-never-be-re-rendered";

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

/**
 * A signed-in Console with the device API stubbed.
 *
 * `state.devices` is mutated by the stub the way a real database would be, so
 * a reload after a mint or a revoke shows what the write left behind rather
 * than what the client hoped for.
 */
async function boot({ devices = [], ...opts } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const state = { devices: [...devices], mints: [], revoked: [], reissued: [],
                  refuseHost: opts.refuseHost || false, preflight: opts.preflight };
  const user = {
    id: "u1", name: "Cue Staff", email: "staff@cuesea.ai",
    role: "cue_admin", tenant_slug: null,
  };

  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  await ctx.route("**/auth/me", (r) => json(r, { user }));

  // Devices — the routes this card actually drives.
  await ctx.route("**/api/admin/tenants/*/devices", async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      const body = JSON.parse(req.postData() || "{}");
      state.mints.push(body);
      // The preflight refusal, as the server sends it: 409, nothing minted.
      // Cleared once the caller says they know better, which is the only way
      // past it and has to be exercised rather than assumed.
      if (state.refuseHost && !body.despite_wrong_host) {
        return json(route, {
          detail: "https://pocket.cuesea.ai is serving “cue-console”, not “cue-pocket”. "
            + "A token scanned from here would go to the wrong application. Nothing was minted.",
        }, 409);
      }
      const device = {
        id: `d${state.devices.length + 1}`, label: body.label, serial: body.serial,
        surface: body.surface, user_id: body.user_id, assigned_to: null,
        presence: "provisioned", provisioned: true, last_seen_at: null, model: null,
      };
      state.devices.push(device);
      return json(route, {
        device, token: TOKEN,
        launch_url: `https://lens.cuesea.ai/?t=${TOKEN}&tenant=gap`,
        qr: body.surface === "even-g2" ? QR : null,
        preflight: { state: state.preflight || "skipped" },
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
    const d = state.devices.find((x) => x.id === id);
    return json(route, {
      device: d, token: TOKEN,
      launch_url: `https://lens.cuesea.ai/?t=${TOKEN}&tenant=gap`, qr: null,
    });
  });

  // Everything else the Tenants screen asks for on the way in.
  const STUBS = [
    ["**/api/admin/tenants?**", { tenants: [{
      id: "t1", slug: "gap", name: "Gap", billing_plan: "pilot", status: "active",
      crm_provider: "mock", config: {}, privacy: {}, users: 2, devices: 1,
      engagements: 0, voice: 0,
    }] }],
    ["**/api/admin/users**", { users: [
      { id: "u9", name: "Ada Associate", role: "associate", status: "active" },
      { id: "u8", name: "Mo Manager", role: "manager", status: "active" },
    ] }],
    ["**/api/admin/tenants/gap/crm", { crm: null, provider: "mock" }],
    ["**/api/analytics/**", {}],
  ];
  for (const [path, body] of STUBS) await ctx.route(path, (r) => json(r, body));

  const p = await ctx.newPage();
  await p.addInitScript(([u]) => {
    sessionStorage.setItem("cue.console.token", "stub-token");
    sessionStorage.setItem("cue.console.user", JSON.stringify(u));
  }, [user]);
  await p.goto(URL, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(900);
  return { p, ctx, state };
}

/** Open Tenants → the one tenant, so the detail cards mount. */
async function openTenant(p) {
  const nav = p.locator('.rail button, .view-switch button, nav button').filter({ hasText: "Tenants" });
  if (await nav.count()) await nav.first().click();
  await p.waitForTimeout(400);
  const row = p.locator("tr", { hasText: "Gap" }).first();
  if (await row.count()) await row.click();
  await p.waitForTimeout(600);
}

// --- 1. minting a G2 ---------------------------------------------------------

{
  const { p, ctx, state } = await boot();
  await openTenant(p);

  const addBtn = p.locator('button:has-text("Add glasses")');
  check("staff are offered a way to mint", await addBtn.count() === 1);

  await addBtn.first().click();
  await p.waitForSelector(".mint-form", { timeout: 8_000 });
  await p.fill('.mint-form input[placeholder="Denim Wall pair 1"]', "Denim Wall pair 1");
  await p.fill('.mint-form input[placeholder="From the box"]', "G2-0007");
  await p.click('.mint-form button[type="submit"]');
  await p.waitForSelector(".minted", { timeout: 8_000 });

  check("the mint carries the surface and the serial",
    state.mints.at(-1)?.surface === "even-g2" && state.mints.at(-1)?.serial === "G2-0007",
    JSON.stringify(state.mints.at(-1)));

  const panel = await p.textContent(".minted");
  check("the panel says the token cannot be shown again — before it is dismissed",
    /only time|shown again|cannot show it again|nothing.*show it again/i.test(panel),
    panel.slice(0, 120));
  check("the launch URL is on screen to copy",
    (await p.textContent('[data-testid="launch-url"]')).includes(TOKEN));

  // --- 4. the QR is data, not markup ---------------------------------------
  const rects = await p.locator(".qr rect").count();
  check("the QR is drawn as rectangles rather than injected markup",
    rects > 1, `${rects} rects`);
  check("the QR has no foreign markup in it",
    (await p.locator(".qr script, .qr foreignObject").count()) === 0);

  // --- 1 and 2. the token, after the panel is dismissed ---------------------
  await p.click('.minted button:has-text("Done")');
  await p.waitForTimeout(600);
  const body = await p.textContent("body");
  check("the token is gone from the document once dismissed",
    !body.includes(TOKEN), "token still present");
  check("and the device is in the fleet list",
    body.includes("Denim Wall pair 1"));

  // A reload re-fetches the list. The token must not come back with it.
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForTimeout(900);
  await openTenant(p);
  check("a reload does not bring the token back",
    !(await p.textContent("body")).includes(TOKEN));

  await ctx.close();
}

// --- 3. a surface with no serial ---------------------------------------------

{
  const { p, ctx, state } = await boot();
  await openTenant(p);
  await p.click('button:has-text("Add glasses")');
  await p.waitForSelector(".mint-form", { timeout: 8_000 });
  // Type a serial *first*, then switch surface. The field disappears but the
  // form state does not, and a Meta device carrying a stray serial would claim
  // this tenant's (tenant_id, serial) slot and collide with the next G2 that
  // really has it.
  await p.fill('.mint-form input[placeholder="From the box"]', "G2-TYPO");
  await p.selectOption(".mint-form select", "mrbd");
  await p.waitForTimeout(200);

  check("a Meta lens is not asked for a serial it cannot have",
    await p.locator('.mint-form input[placeholder="From the box"]').count() === 0);

  await p.fill('.mint-form input[placeholder="Denim Wall pair 1"]', "Meta pair");
  await p.click('.mint-form button[type="submit"]');
  await p.waitForSelector(".minted", { timeout: 8_000 });

  check("the mint sends no serial for a surface without one",
    state.mints.at(-1)?.surface === "mrbd" && !state.mints.at(-1)?.serial,
    JSON.stringify(state.mints.at(-1)));
  check("and no QR is drawn for a surface nobody scans",
    await p.locator(".qr").count() === 0);

  await ctx.close();
}

// --- 5. the fleet list --------------------------------------------------------

{
  const { p, ctx, state } = await boot({ devices: [
    { id: "d1", label: "Denim Wall pair 1", serial: "G2-0001", surface: "even-g2",
      presence: "active", provisioned: true, last_seen_at: new Date().toISOString(),
      user_id: "u9", assigned_to: "Ada Associate", model: "g2" },
    { id: "d2", label: "Onboarding tab", serial: null, surface: "sim",
      presence: "provisioned", provisioned: true, last_seen_at: null,
      user_id: null, assigned_to: null, model: null },
    { id: "d3", label: "Lost pair", serial: "G2-0009", surface: "even-g2",
      presence: "revoked", provisioned: true, last_seen_at: new Date().toISOString(),
      user_id: null, assigned_to: null, model: "g2" },
  ] });
  await openTenant(p);
  const body = await p.textContent("body");

  check("a sim device is badged as what it is, not as glasses",
    (await p.locator('[data-surface="sim"]').count()) === 1,
    await p.locator('[data-surface="sim"]').innerText().catch(() => ""));
  check("presence is shown, and is not the stored status",
    body.includes("on the floor") && body.includes("never seen"));
  check("a revoked device that is still being seen is called out",
    /revoked device has been seen/i.test(body));

  await p.locator("tr", { hasText: "Lost pair" }).locator('button:has-text("Revoke")')
    .count()
    .then((n) => check("a device already revoked is not offered revoke again", n === 0));

  await p.locator("tr", { hasText: "Denim Wall pair 1" })
    .locator('button:has-text("Revoke")').first().click();
  await p.waitForTimeout(600);
  check("revoking reaches the server", state.revoked.includes("d1"),
    JSON.stringify(state.revoked));

  await p.locator("tr", { hasText: "Lost pair" })
    .locator('button:has-text("Reissue")').first().click();
  await p.waitForSelector(".minted", { timeout: 8_000 });
  check("reissuing a revoked device hands back a fresh token",
    state.reissued.includes("d3") && (await p.textContent(".minted")).length > 0,
    JSON.stringify(state.reissued));

  await ctx.close();
}


// --- the mint preflight ------------------------------------------------------
//
// A provision token *is* the store's identity, and on a phone it rides in a QR.
// Pointed at the wrong application, that scan hands a live store credential to
// whatever is actually there — its logs, its analytics, the phone's history —
// while the pairing merely appears to fail, so nobody revokes it.
//
// `pocket.cuesea.ai` really did serve an old project for its first hours. The
// server refuses this now; what the panel must do is make the refusal
// actionable rather than a red box somebody clicks past.

{
  const { p, ctx, state } = await boot({ refuseHost: true });
  await openTenant(p);
  await p.locator('button:has-text("Add glasses")').first().click();
  await p.waitForSelector(".mint-form", { timeout: 8_000 });
  await p.selectOption(".mint-form select.assign", "phone");
  await p.fill('.mint-form input[placeholder="Denim Wall pair 1"]', "Till 4");
  await p.click('.mint-form button[type="submit"]');
  await p.waitForTimeout(400);

  const body = await p.textContent(".mint-form");
  check("a refused mint says the hostname is serving something else",
    /serving something else/i.test(body), body.slice(0, 200));
  check("and names what it found, rather than a status code",
    /cue-console/.test(body) && /cue-pocket/.test(body), body.slice(0, 300));

  check("no token or QR is shown, because nothing was minted",
    (await p.locator("[data-testid=launch-url]").count()) === 0
      && (await p.locator(".qr").count()) === 0);

  // The override exists because an operator mid-migration may know something
  // the check cannot — and a guard with no way past it is a guard somebody
  // switches off in the environment, permanently.
  await p.click("button:has-text('Mint anyway')");
  await p.waitForTimeout(400);
  check("minting anyway is possible, and says so explicitly on the wire",
    state.mints.some((m) => m.despite_wrong_host === true),
    JSON.stringify(state.mints));
  check("and then the token appears",
    (await p.locator("[data-testid=launch-url]").count()) === 1);

  await ctx.close();
}

{
  // "We could not ask" is not "we checked". An admin about to hold a QR up is
  // the only person who can act on the difference, and silence would read as
  // verified.
  const { p, ctx } = await boot({ preflight: "unreachable" });
  await openTenant(p);
  await p.locator('button:has-text("Add glasses")').first().click();
  await p.waitForSelector(".mint-form", { timeout: 8_000 });
  await p.selectOption(".mint-form select.assign", "phone");
  await p.fill('.mint-form input[placeholder="Denim Wall pair 1"]', "Till 5");
  await p.click('.mint-form button[type="submit"]');
  await p.waitForTimeout(400);

  const body = await p.textContent(".minted");
  check("an unverified mint says the address could not be checked",
    /could not reach that address/i.test(body), body.slice(0, 300));
  await ctx.close();
}

{
  const { p, ctx } = await boot({ preflight: "ok" });
  await openTenant(p);
  await p.locator('button:has-text("Add glasses")').first().click();
  await p.waitForSelector(".mint-form", { timeout: 8_000 });
  await p.selectOption(".mint-form select.assign", "phone");
  await p.fill('.mint-form input[placeholder="Denim Wall pair 1"]', "Till 6");
  await p.click('.mint-form button[type="submit"]');
  await p.waitForTimeout(400);
  check("a verified mint says it was checked",
    /serving the right app/i.test(await p.textContent(".minted")));
  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
