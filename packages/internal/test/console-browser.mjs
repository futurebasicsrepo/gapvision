/**
 * CueSea Console, headless.
 *
 * The checks that matter here are the negative ones. A console that shows
 * cuesea staff the right numbers is table stakes; a console that shows a
 * retailer's admin anything at all is the thing that ends a pilot.
 *
 *   npm run stack:console
 *
 * That script seeds both accounts and stands the stack up. Running the file
 * directly still works, but needs `vite preview` on :5176, the realtime + AI
 * services, and two accounts passed in:
 *
 *   CONSOLE_STAFF_EMAIL / CONSOLE_STAFF_PASSWORD    a cue_admin
 *   CONSOLE_TENANT_EMAIL / CONSOLE_TENANT_PASSWORD  a client_admin
 *
 * `db:seed --demo` makes both, but pin CUE_ADMIN_PASSWORD and
 * CUE_DEMO_PASSWORD or it generates one per run and only prints it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const CONSOLE = process.env.CONSOLE_URL || "http://localhost:5176";
const STAFF = {
  email: process.env.CONSOLE_STAFF_EMAIL,
  password: process.env.CONSOLE_STAFF_PASSWORD,
};
const TENANT = {
  email: process.env.CONSOLE_TENANT_EMAIL,
  password: process.env.CONSOLE_TENANT_PASSWORD,
};

if (!STAFF.email || !TENANT.email) {
  console.error("Set CONSOLE_STAFF_* and CONSOLE_TENANT_* before running.");
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);

async function signIn(page, who) {
  await page.goto(CONSOLE, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', who.email);
  await page.fill('input[type="password"]', who.password);
  await page.click('button[type="submit"]');
}

// --- 1. the sign-in screen gives nothing away --------------------------------
{
  const page = await browser.newPage();
  await page.goto(CONSOLE, { waitUntil: "networkidle" });
  const text = (await page.textContent("body")).toLowerCase();
  check("sign-in renders", text.includes("sign in"));
  for (const leak of ["tenant", "billing", "platform", "architecture", "health"]) {
    check(`sign-in doesn't name "${leak}"`, !text.includes(leak),
      text.includes(leak) ? text.slice(0, 120) : "");
  }
  await page.close();
}

// --- 2. a retailer's admin is turned away ------------------------------------
{
  const page = await browser.newPage();
  const apiCalls = [];
  page.on("response", (r) => {
    if (r.url().includes("/api/admin/")) apiCalls.push(`${r.status()} ${r.url()}`);
  });

  await signIn(page, TENANT);
  await page.waitForSelector(".notice.error, .console", { timeout: 8000 });

  const body = await page.textContent("body");
  // Guard against a false pass: a failed sign-in also renders .notice.error
  // and no rail, so without this the three checks below would "pass" simply
  // because the credentials were wrong.
  check("client_admin actually signed in",
    !/don't match|incorrect/i.test(body), body.slice(0, 120));
  check("client_admin sees the staff-only notice",
    /console is for cuesea staff/i.test(body), body.slice(0, 140));
  check("client_admin gets no navigation",
    (await page.$$(".rail-item")).length === 0);
  check("client_admin sees no tenant table", (await page.$$(".table")).length === 0);

  // Even if the shell had rendered, the API is the real boundary — nothing
  // it returned to this session may have been a success.
  const allowed = apiCalls.filter((c) => c.startsWith("2"));
  check("no admin endpoint answered 2xx for a client_admin",
    allowed.length === 0, allowed.join(" | "));

  await page.close();
}

// --- 3. staff get the console ------------------------------------------------
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

/** Navigate by the rail item's visible label, so the test breaks when a
 *  destination is renamed rather than when the list is reordered.
 *
 *  Matched with a `hasText` regex rather than `:text-is`. The rail renders its
 *  labels through `Decode`, which wraps every character in its own span for
 *  the type-on animation — so the label's *text* is "Tenants" while no single
 *  node holds that string, and `:text-is` matched nothing. It failed as a
 *  thirty-second timeout on a rail that was on screen and correct.
 */
const go = (name) =>
  page.locator(".rail-item")
    .filter({ has: page.locator(".rail-item-name")
      .filter({ hasText: new RegExp(`^\\s*${name}\\s*$`) }) })
    .first()
    .click();

await signIn(page, STAFF);
await page.waitForSelector(".rail-item", { timeout: 10_000 });
check("cue_admin reaches the console", true);

// --- Health ---
await page.waitForSelector(".check", { timeout: 10_000 });
const checkRows = await page.$$eval(".check", (els) =>
  els.map((e) => ({
    cls: e.className,
    label: e.querySelector(".check-label")?.textContent,
    detail: e.querySelector(".check-detail")?.textContent,
  })),
);
check("health checks render", checkRows.length >= 5, `${checkRows.length} rows`);
check("every check carries a known status",
  checkRows.every((r) => /\b(ok|warn|fail|unknown)\b/.test(r.cls)),
  checkRows.map((r) => r.cls).join(" | "));
check("schema check is present and passing",
  checkRows.some((r) => /schema/i.test(r.label || "") && /\bok\b/.test(r.cls)));
// The bug this console exists to catch: nothing may render as a pass without a
// detail line explaining what was actually asserted.
check("passing checks say what they proved",
  checkRows.filter((r) => /\bok\b/.test(r.cls)).every((r) => (r.detail || "").trim().length > 0));
// Retention is reported honestly, which is not the same as reported `warn`.
// All three of ok / warn / unknown are truthful answers depending on whether
// the sweep has run, is behind, or cannot be determined — so this used to
// pass only on a deployment whose sweep happened to be stale, and failed on a
// healthy one. What must never happen is `ok` with nothing behind it: that is
// the shape of a check that reports success for a sweep that silently stopped.
const retention = checkRows.find((r) => /retention/i.test(r.label || ""));
check("retention is reported at all", !!retention, JSON.stringify(checkRows.map((r) => r.label)));
check("retention carries a truthful status",
  /\b(ok|warn|unknown)\b/.test(retention?.cls || ""), retention?.cls);
check("retention never claims ok without saying when it swept",
  !/\bok\b/.test(retention?.cls || "") || /swept/i.test(retention?.detail || ""),
  `${retention?.cls} — ${retention?.detail}`);

const statValues = await page.$$eval(".stat-value", (els) => els.map((e) => e.textContent));
check("fleet counts render", statValues.length === 4 && statValues.every((v) => v !== "—"),
  statValues.join(", "));

// --- Tenants ---
await go("Tenants");
await page.waitForSelector(".table tbody tr", { timeout: 8000 });
const rows = await page.$$(".table tbody tr");
check("tenant table lists tenants", rows.length >= 1, `${rows.length} rows`);

await rows[0].click();
await page.waitForFunction(() => document.querySelectorAll(".card").length > 2, { timeout: 8000 });
const detail = await page.textContent("body");
check("clicking a tenant opens its people and hardware",
  /people/i.test(detail) && /hardware/i.test(detail));

// --- Architecture ---
await go("Architecture");
await page.waitForSelector(".flow-node", { timeout: 8000 });
const nodes = await page.$$eval(".flow-node .n-name", (els) => els.map((e) => e.textContent));
check("architecture renders the pipeline", nodes.length === 6, nodes.join(" → "));
check("known gaps are stated, not hidden",
  /retention isn't enforced/i.test(await page.textContent("body")));

// --- Brand ---
await go("Brand");
await page.waitForSelector(".swatch", { timeout: 8000 });
const swatches = await page.$$eval(".swatch-hex", (els) => els.map((e) => e.textContent.trim()));
const tokens = JSON.parse(
  readFileSync(new URL("../src/brand-tokens.json", import.meta.url), "utf8"),
);
const expected = tokens.ramps.flatMap((r) => r.steps.map((s) => s.hex.toUpperCase()));
check("every token has a swatch", swatches.length === expected.length,
  `${swatches.length} of ${expected.length}`);
check("swatches match the canonical tokens",
  expected.every((hex) => swatches.includes(hex)),
  expected.filter((h) => !swatches.includes(h)).join(", "));
check("the mark renders at all three compensation sizes",
  (await page.$$(".mark-spec svg")).length === 3);

check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

// --- 4. isolation: the console never ships inside CueSea Studio -------------
{
  const dir = fileURLToPath(new URL("../../web/dist/assets/", import.meta.url));
  let studio = null;
  try {
    studio = readdirSync(dir)
      .filter((f) => f.endsWith(".js"))
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");
  } catch { /* not built — reported below */ }

  if (studio === null) {
    console.log("SKIP  CueSea Studio not built — run `npm run build:web` to include this check");
  } else {
    // Separate origins are only worth the extra Vercel project if the code
    // really is separate. If this ever fails, someone has imported a console
    // component into Studio and a customer is downloading it.
    const leaked = ["Console · staff", "api/admin/platform", "cue.console.token"]
      .filter((s) => studio.includes(s));
    check("CueSea Studio's bundle contains nothing from the console",
      leaked.length === 0, leaked.join(", "));
  }
}

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
