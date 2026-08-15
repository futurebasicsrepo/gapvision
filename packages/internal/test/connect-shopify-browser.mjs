/**
 * Connect Shopify, headless.
 *
 * The assertions that matter are about what the browser is *never* given. The
 * panel can render a connected store, a missing scope, and a rejected token —
 * and in none of those states does the merchant's Admin API token reach the
 * page, the network responses, or storage.
 *
 *   node packages/internal/test/connect-shopify-browser.mjs
 *
 * Expects `vite preview` on :5176 built against a reachable API, plus:
 *
 *   CONSOLE_STAFF_EMAIL / CONSOLE_STAFF_PASSWORD   a cue_admin
 *   CONNECTED_TENANT_SLUG                          a tenant with a store already
 *                                                  connected and a passing test
 *   CONNECTED_TOKEN                                 that tenant's token, so the
 *                                                  test can hunt for it
 */
import { chromium } from "playwright";

const CONSOLE = process.env.CONSOLE_URL || "http://localhost:5176";
const STAFF = {
  email: process.env.CONSOLE_STAFF_EMAIL,
  password: process.env.CONSOLE_STAFF_PASSWORD,
};
const SLUG = process.env.CONNECTED_TENANT_SLUG;
const SECRET = process.env.CONNECTED_TOKEN;

if (!STAFF.email || !SLUG || !SECRET) {
  console.error("Set CONSOLE_STAFF_*, CONNECTED_TENANT_SLUG and CONNECTED_TOKEN.");
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
const page = await browser.newPage();

// Watch every response body for the token. This is the assertion the whole
// design exists to satisfy, so it is checked continuously rather than once.
const leaks = [];
page.on("response", async (res) => {
  if (!res.url().includes("/api/") && !res.url().includes("/auth")) return;
  try {
    const body = await res.text();
    if (body.includes(SECRET)) leaks.push(res.url());
  } catch { /* opaque or already consumed */ }
});

await page.goto(CONSOLE, { waitUntil: "networkidle" });
await page.fill('input[type="email"]', STAFF.email);
await page.fill('input[type="password"]', STAFF.password);
await page.click('button[type="submit"]');
await page.waitForSelector(".rail-item", { timeout: 10_000 });

// The console opens on the platform view; Tenants is a rail item.
await page.click('.rail-item:has-text("Tenants")');

// --- the connected state -----------------------------------------------------
await page.waitForSelector(`td.ident:text-is("${SLUG}")`, { timeout: 10_000 });
await page.click(`td.ident:text-is("${SLUG}")`);
await page.waitForSelector("text=Shopify", { timeout: 10_000 });
await page.waitForSelector(".check-label", { timeout: 10_000 });

const body = () => page.textContent("body");
let text = await body();

check("panel renders for the selected tenant", text.includes("· Shopify"));
check("store domain is shown", /myshopify\.com/.test(text));
check("token is fingerprinted, not printed", text.includes("…") && !text.includes(SECRET));
check("sealing key id is shown", /sealed with key/.test(text));
check("granted scopes are listed", text.includes("read_customers") && text.includes("granted"));

// read_inventory was deliberately not granted on the seeded credential.
check(
  "an absent optional scope is named, not hidden",
  text.includes("read_inventory") && /absent/.test(text),
);

const controls = await page.$$eval("button", (bs) => bs.map((b) => b.textContent.trim()));
check("test / replace / disconnect offered", ["Test connection", "Replace credentials", "Disconnect"]
  .every((c) => controls.includes(c)));

// --- the form never remembers a secret --------------------------------------
await page.click('button:text-is("Replace credentials")');
await page.waitForSelector('input[placeholder="shpat_…"]');
const prefilled = await page.inputValue('input[placeholder="shpat_…"]');
check("replace form does not prefill the existing token", prefilled === "");

const inputType = await page.getAttribute('input[placeholder="shpat_…"]', "type");
check("token field is a password field", inputType === "password");

// --- a bad domain is refused client-side by the API, legibly ----------------
await page.fill('input[placeholder="future-basics.myshopify.com"]', "https://evil.com");
await page.fill('input[placeholder="shpat_…"]', "shpat_" + "q".repeat(32));
await page.click('button:text-is("Replace and test")');
await page.waitForSelector(".notice.error", { timeout: 10_000 });
text = await body();
check("a non-Shopify domain is rejected with a usable message",
  /myshopify\.com/.test(text) && /Settings → Domains|not a Shopify store domain/.test(text));

// --- storage holds no secret -------------------------------------------------
const stored = await page.evaluate(() =>
  JSON.stringify({ s: { ...sessionStorage }, l: { ...localStorage } }));
check("no credential in browser storage", !stored.includes(SECRET));

check("no response body ever contained the token", leaks.length === 0, leaks.join(", "));

await browser.close();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
