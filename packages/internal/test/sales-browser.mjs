/**
 * The Sales panel — the decks, as things you send.
 *
 *   node packages/internal/test/sales-browser.mjs
 *
 * Expects `vite preview` on :5176. No services — both endpoints are stubbed,
 * including the case where they are missing entirely, which is a real state
 * rather than a hypothetical: Console and the AI service deploy on separate
 * pushes, so either can be ahead of the other for as long as a merge takes.
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
 * @param links  same, for `/api/analytics/deck-links`. Console and the AI
 *               service deploy on separate pushes, so one having an endpoint
 *               the other does not is a real state, not a hypothetical.
 */
async function boot({ leads = null, links = [] } = {}) {
  const posted = [];
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
  await ctx.route("**/api/analytics/deck-links**", (route) => {
    if (links === null) return route.fulfill({ status: 404, body: "" });
    if (route.request().method() === "POST") {
      const body = JSON.parse(route.request().postData() || "{}");
      posted.push(body);
      // The stub stores it the way the server would, so the reload below sees
      // what a real write would have left behind.
      links.unshift({ id: `l${links.length}`, deck: body.deck, token: body.token,
                      prepared_for: body.preparedFor, gated: body.gated,
                      at: new Date().toISOString(), opens: 0, created_by: "Cue Staff" });
      return json(route, { link: links[0] }, 201);
    }
    return json(route, { links });
  });

  const p = await ctx.newPage();
  await p.addInitScript(([u]) => {
    sessionStorage.setItem("cue.console.token", "stub");
    sessionStorage.setItem("cue.console.user", JSON.stringify(u));
  }, [user]);
  await p.goto(URL, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(800);
  await p.locator(".rail-item").filter({ hasText: "Sales" }).first().click();
  await p.waitForSelector(".sales", { timeout: 8_000 });
  return { p, ctx, posted };
}

// --- 1. an absent lead endpoint ----------------------------------------------

{
  const { p, ctx, posted } = await boot({ leads: null });
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

  // Links survive a reload **because the server has them** — which is the whole
  // reason this stopped being localStorage. A link made on a laptop that is
  // invisible from a phone is a record of what you sent that you cannot trust.
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForTimeout(800);
  await p.locator(".rail-item").filter({ hasText: "Sales" }).first().click();
  await p.waitForSelector(".sales", { timeout: 8_000 });
  // The links are fetched on mount, so the panel existing is not the same as
  // the panel having them. Wait for the row rather than for the card.
  await p.waitForSelector(".sales-table tbody tr", { timeout: 8_000 }).catch(() => {});
  check("and they survive a reload, from the server rather than this browser",
    (await p.textContent(".sales")).includes("Reformation"));
  check("the link was recorded with what it was prepared for",
    posted.some((b) => b.preparedFor === "Reformation" && b.deck === "floor" && b.gated === true),
    JSON.stringify(posted));

  await ctx.close();
}

// --- an absent link endpoint ---------------------------------------------------
//
// Console and the AI service deploy separately, so this window is real. The
// link still has to be built and copied — a URL does not need our database to
// work — and the panel has to say the row was not kept rather than quietly
// showing a list that will be empty tomorrow.

{
  const { p, ctx } = await boot({ links: null });
  await p.waitForTimeout(600);

  await p.fill(".sales-compose input", "Ghost Retail");
  await p.click(".sales-compose .btn.primary");
  await p.waitForTimeout(500);

  const link = await p.evaluate(() => navigator.clipboard.readText());
  check("a link is still built and copied when there is nowhere to record it",
    /[?&]to=Ghost\+Retail/.test(link) && /[?&]t=[0-9a-f]{12}/.test(link), link);

  const body = await p.textContent(".sales");
  check("and the panel says it was not recorded, rather than implying it was",
    /not being recorded|could not be recorded/i.test(body),
    body.slice(0, 160));
  check("the row is still shown, marked",
    (await p.locator(".sales-table tbody tr").count()) === 1
      && /not recorded/i.test(await p.textContent(".sales-table")));

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
