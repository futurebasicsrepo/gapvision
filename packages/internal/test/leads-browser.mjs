/**
 * The Leads panel — the pipeline, and what to do about it this morning.
 *
 *   npm run test:leads
 *
 * Expects `vite preview` on :5176. Every endpoint is stubbed, including the
 * cases where one is missing, because those are real states rather than
 * hypotheticals: Console and the AI service deploy on separate pushes.
 *
 * What this holds down, hardest first:
 *
 *   1. **Absent never renders as empty.** "Nothing is waiting on you" and "we
 *      could not ask" look identical to somebody closing the tab for the day,
 *      and only one of them is safe to act on. This is the same rule the
 *      Health and Sales panels keep, and the rule the Sales panel broke for
 *      its whole life by rendering a failed request as "no link store".
 *   2. **The order is the product.** A queue that puts a stalled demo above an
 *      unanswered reply is a queue that costs a merchant. The service ranks;
 *      the panel must not re-sort.
 *   3. **Flame stays scarce.** One reason is flame — a person waiting on us in
 *      an inbox. Spend the colour on all four and it stops meaning anything.
 */
import { chromium } from "playwright";

const URL = process.env.CONSOLE_URL || "http://localhost:5176";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch();

const USER = {
  id: "u1", name: "Cue Staff", email: "staff@cuesea.ai",
  role: "cue_admin", tenant_slug: null,
};

/** @param queue  null to make the endpoint fail (absent), or a payload. */
async function boot({ queue = { queue: [], quiet_days: 5, stall_days: 10 } } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1400 } });
  const json = (r, body, status = 200) =>
    r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  await ctx.route("**/api/**", (r) => json(r, {}));
  await ctx.route("**/auth/me", (r) => json(r, { user: USER }));
  await ctx.route("**/api/analytics/growth/leads**", (r) =>
    json(r, { leads: [], stages: ["new", "contacted", "replied", "demo"] }));
  await ctx.route("**/api/analytics/growth/sources**", (r) =>
    json(r, { by_source: [], days: 90 }));
  await ctx.route("**/api/analytics/growth/work-queue**", (r) =>
    (queue === null ? r.fulfill({ status: 500, body: "" }) : json(r, queue)));

  const p = await ctx.newPage();
  await p.addInitScript(([u]) => {
    sessionStorage.setItem("cue.console.token", "stub");
    sessionStorage.setItem("cue.console.user", JSON.stringify(u));
  }, [USER]);
  await p.goto(URL, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(700);
  await p.locator(".rail-item")
    .filter({ has: p.locator(".rail-item-name").filter({ hasText: /^\s*Leads\s*$/ }) })
    .first().click();
  await p.waitForTimeout(900);
  return { p, ctx };
}

/** The "Needs you" card, by its heading rather than its position. */
const queueCard = (p) =>
  p.locator(".card").filter({ has: p.locator("h2", { hasText: "Needs you" }) });

// --- 1. an endpoint that did not answer --------------------------------------

{
  const { p, ctx } = await boot({ queue: null });
  const text = await queueCard(p).innerText();
  check("a work queue that did not answer says so", /didn't answer/i.test(text), text.slice(0, 120));
  check("and does not claim there is nothing to chase",
    !/Nothing is waiting on you/i.test(text),
    "an unreachable queue rendering as 'all clear' is the one failure that ends a day early");
  await ctx.close();
}

// --- 2. a genuinely empty queue ----------------------------------------------

{
  const { p, ctx } = await boot({ queue: { queue: [], quiet_days: 5, stall_days: 10 } });
  const text = await queueCard(p).innerText();
  check("an empty queue says nothing is waiting", /Nothing is waiting on you/i.test(text));
  check("and quotes the threshold the service actually used",
    /5 days/.test(text), text.slice(0, 200));
  await ctx.close();
}

// --- 3. the order, and the colour --------------------------------------------

const QUEUE = {
  quiet_days: 5,
  stall_days: 10,
  queue: [
    { id: "1", reason: "awaiting_reply", email: "ada@reformation.example.com",
      name: "Ada", company: "Reformation", stage: "contacted", waiting_days: 39 },
    { id: "2", reason: "opened_untouched", email: "bo@studs.example.com",
      name: "Bo", company: "Studs", stage: "new", waiting_days: 0 },
    { id: "3", reason: "gone_quiet", email: "cy@tecovas.example.com",
      name: "Cy", company: "Tecovas", stage: "contacted", waiting_days: 9 },
    { id: "4", reason: "stalled", email: "di@gorjana.example.com",
      name: "Di", company: "Gorjana", stage: "demo", waiting_days: 14 },
  ],
};

{
  const { p, ctx } = await boot({ queue: QUEUE });
  const rows = queueCard(p).locator("tbody tr");
  check("every waiting lead is listed", (await rows.count()) === 4);

  const firstCells = await rows.nth(0).locator("td").allInnerTexts();
  check("the unanswered reply is first, ahead of a deal further along",
    /Reply/.test(firstCells[0]),
    "39 days old and still outranks a 14-day stalled demo — a person waiting beats a stage waiting");

  const order = await rows.evaluateAll((trs) =>
    trs.map((tr) => tr.querySelector("td")?.textContent || ""));
  check("the panel preserves the service's ranking rather than re-sorting",
    /Reply/.test(order[0]) && /read the deck/.test(order[1])
      && /Nudge/.test(order[2]) && /Move it on/.test(order[3]),
    JSON.stringify(order));

  // Flame is scarce on purpose.
  const flames = await queueCard(p).locator("tbody .tag.on").count();
  check("exactly one reason is flame", flames === 1,
    `${flames} — the colour is reserved for a person waiting on us in an inbox`);

  const text = await queueCard(p).innerText();
  check("each row says what to do, not what it is",
    /Reply —/.test(text) && /Nudge —/.test(text),
    "\"awaiting_reply\" is a status somebody has to decode first");
  check("waiting time reads in days, not as a timestamp",
    /39d/.test(text) && !/GMT|:\d\d:/.test(text));

  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
