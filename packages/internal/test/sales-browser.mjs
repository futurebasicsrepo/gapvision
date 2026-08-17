/**
 * The Sales panel — the decks, as things you send.
 *
 *   node packages/internal/test/sales-browser.mjs
 *
 * Expects `vite preview` on :5176. No services: the panel is a link builder
 * plus one read, and the read is *supposed* to work when that read fails.
 *
 * What it holds down, in order of how badly it would hurt to get wrong:
 *
 *   1. **An absent lead endpoint reads as absent, never as zero.** "No leads"
 *      and "we cannot tell" are different sentences, and only one of them is
 *      true today. An internal tool that invents a zero gets it quoted.
 *   2. **The gate is never described as protection.** Anyone can strip `gate=1`
 *      and read the deck. The moment the panel implies otherwise, somebody
 *      sends a deck they believed was safe into a room it should not reach.
 *   3. A built link carries what was asked for, and switching decks switches
 *      the links with it — two decks in one panel is the whole design, and
 *      showing the investor deck's links under the customer deck would be the
 *      way that design fails.
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

/**
 * @param leads  `null` to refuse `/api/analytics/deck-leads` the way a
 *               deployment without the endpoint does; an array to serve it.
 */
async function boot({ leads = null } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1500, height: 1200 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const user = {
    id: "u1", name: "Cue Staff", email: "staff@cuesea.ai",
    role: "cue_admin", tenant_slug: null,
  };
  const json = (r, body, status = 200) =>
    r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  await ctx.route("**/api/**", (r) => json(r, {}));
  await ctx.route("**/auth/me", (r) => json(r, { user }));
  await ctx.route("**/api/analytics/deck-leads**", (r) =>
    (leads === null ? r.fulfill({ status: 404, body: "" }) : json(r, { leads })));

  const p = await ctx.newPage();
  await p.addInitScript(([u]) => {
    sessionStorage.setItem("cue.console.token", "stub");
    sessionStorage.setItem("cue.console.user", JSON.stringify(u));
    // The panel keeps its links here until the control plane stores them; a
    // suite that inherited a previous run's rows would assert on those.
    //
    // Once per context, not once per navigation — this script runs on every
    // load, so clearing unconditionally would wipe the links immediately
    // before the reload that is meant to prove they survive one. (It did, and
    // the panel was blamed for it.)
    if (!sessionStorage.getItem("suite.linksCleared")) {
      localStorage.removeItem("cuesea.console.sales.links");
      sessionStorage.setItem("suite.linksCleared", "1");
    }
  }, [user]);
  await p.goto(URL, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(800);
  await p.locator(".rail-item").filter({ hasText: "Sales" }).first().click();
  await p.waitForSelector(".sales", { timeout: 8_000 });
  return { p, ctx };
}

// --- 1. an absent lead endpoint ----------------------------------------------

{
  const { p, ctx } = await boot({ leads: null });
  await p.waitForTimeout(700);
  const body = await p.textContent(".sales");

  check("an absent lead endpoint says so, rather than reporting zero",
    /No lead endpoint on this deployment/i.test(body)
      && !/No gated opens on this deck/i.test(body),
    body.slice(body.indexOf("WHO OPENED") < 0 ? 0 : body.indexOf("WHO OPENED"), 260));

  // --- 2. the sentence that must not be softened ---------------------------
  check("the gate is described as a lead gate, not as access control",
    /not access control/i.test(body) && /anyone with the url/i.test(body));

  // --- 3. building a link --------------------------------------------------
  await p.fill(".sales-compose input", "Reformation");
  await p.click('.sales-compose .btn.primary');
  await p.waitForTimeout(400);

  const row = p.locator(".sales-table tbody tr").first();
  check("the link records who it was prepared for",
    (await row.textContent()).includes("Reformation"));
  check("and that it was gated", (await row.locator(".tag.on").count()) === 1);

  const link = await p.evaluate(() => navigator.clipboard.readText());
  check("the built link carries the recipient, the gate and a token",
    /[?&]to=Reformation/.test(link) && /[?&]gate=1/.test(link) && /[?&]t=[0-9a-f]{12}/.test(link),
    link);
  check("and points at the customer deck", /\/customers\//.test(link), link);

  // --- 3b. the two decks do not share a link list --------------------------
  await p.click('.sales-tab:has-text("Fundraise")');
  await p.waitForTimeout(300);
  check("switching deck switches the links with it",
    (await p.locator(".sales-table tbody tr").count()) === 0
      && /No links for this deck yet/i.test(await p.textContent(".sales")));

  await p.fill(".sales-compose input", "Acme Ventures");
  await p.click('.sales-compose .btn.primary');
  await p.waitForTimeout(400);
  const investorLink = await p.evaluate(() => navigator.clipboard.readText());
  check("and an investor link points at the investor deck",
    /\/fundraise\//.test(investorLink), investorLink);

  await p.click('.sales-tab:has-text("For the floor")');
  await p.waitForTimeout(300);
  check("the customer deck's own link is still there, and only its own",
    (await p.locator(".sales-table tbody tr").count()) === 1
      && (await p.textContent(".sales-table")).includes("Reformation"));

  // Links survive a reload — they are what the panel is for, and losing them
  // on a refresh would make the whole list untrustworthy.
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForTimeout(800);
  await p.locator(".rail-item").filter({ hasText: "Sales" }).first().click();
  await p.waitForSelector(".sales", { timeout: 8_000 });
  check("and they survive a reload",
    (await p.textContent(".sales")).includes("Reformation"));

  await ctx.close();
}

// --- 1b. a lead endpoint that answers ----------------------------------------

{
  const { p, ctx } = await boot({ leads: [
    { id: "l1", deck: "floor", name: "Dana Ops", email: "dana@reformation.com",
      firm: "Reformation", preparedFor: "Reformation", at: new Date().toISOString() },
    { id: "l2", deck: "fundraise", name: "Sam VC", email: "sam@acme.vc",
      firm: "Acme Ventures", preparedFor: "Acme Ventures", at: new Date().toISOString() },
  ] });
  await p.waitForTimeout(700);

  const body = await p.textContent(".sales");
  check("a lead on this deck is shown", body.includes("dana@reformation.com"));
  check("and a lead on the other deck is not",
    !body.includes("sam@acme.vc"), "investor lead leaked into the customer deck");

  await p.click('.sales-tab:has-text("Fundraise")');
  await p.waitForTimeout(300);
  const investorBody = await p.textContent(".sales");
  check("switching deck switches the leads too",
    investorBody.includes("sam@acme.vc") && !investorBody.includes("dana@reformation.com"));

  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
