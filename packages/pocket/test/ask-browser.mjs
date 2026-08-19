/**
 * Asking a question from a phone, all the way to an answer.
 *
 *   scripts/browser-suite.sh pocket-ask
 *
 * The one suite that exercises the whole chain rather than a layer of it: a
 * real microphone (Chromium's fake device), real PCM conversion, a real socket
 * to the realtime server, a real POST to the AI service, and the answer drawn
 * on a real card deck.
 *
 * It exists because Ask on the phone is the claim the customer deck rests on —
 * "run the pilot on phones and treat the glass as the upgrade" is only honest
 * if the phone can do the thing the pitch is about. Every part of that chain
 * has its own test; none of them would notice if the parts stopped meeting.
 *
 * What it holds down, hardest first:
 *
 *   1. **A held button produces an answer.** The whole point. If this fails,
 *      the phone pilot ships without the feature it is sold on.
 *   2. **A store that switched voice off gets no microphone.** The retailer's
 *      setting has to reach the surface, not just the service.
 *   3. **A refused permission says which switch to flip.** The browser will not
 *      ask twice, so a silent failure here is permanent for that associate.
 *   4. **Releasing outside the button still ends the utterance.** A thumb that
 *      slides off is the common case, and the failure is a mic left open.
 *
 * `CUE_STT_MOCK_TRANSCRIPT` pins what the mock transcriber returns, so the
 * assertion is about the chain rather than about speech recognition.
 */
import { chromium, devices as playwrightDevices } from "playwright";

const URL = process.env.POCKET_URL || "http://localhost:5192";
const SERVER = process.env.SERVER_URL || "http://localhost:4000";
const EMAIL = process.env.CUE_ASSOCIATE_EMAIL || "alex@example.com";
const PASSWORD = process.env.CUE_DEMO_PASSWORD || "local-dev-demo-pw";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// A real session, because the socket handshake is checked upstream and a
// stubbed token would test our stub.
const login = await (await fetch(`${SERVER}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
})).json();
if (!login.token) {
  console.log(`FAIL  an associate can sign in — ${JSON.stringify(login).slice(0, 120)}`);
  process.exit(1);
}

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: [
    // A microphone that produces a predictable tone, and a permission prompt
    // that answers itself. Without the first there is no audio and the AI
    // service correctly refuses the clip as silence.
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
});
const PHONE = playwrightDevices["iPhone 13"];

async function phone({ grantMic = true, capabilities = null } = {}) {
  const ctx = await browser.newContext({
    ...PHONE,
    permissions: grantMic ? ["microphone"] : [],
    // The app is served over http in test; Chromium treats localhost as secure.
    ignoreHTTPSErrors: true,
  });
  if (capabilities) {
    await ctx.route("**/api/tenant/capabilities**", (r) =>
      r.fulfill({ status: 200, contentType: "application/json",
                  body: JSON.stringify(capabilities) }));
  }
  const page = await ctx.newPage();
  await page.goto(`${URL}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(([token, who]) => {
    localStorage.clear();
    localStorage.setItem("cue.pocket.mode", "personal");
    localStorage.setItem("cue.pocket.session", token);
    localStorage.setItem("cue.pocket.who", who);
    localStorage.setItem("cue.pocket.tenant", "gap");
  }, [login.token, login.user?.name || "Alex"]);
  await page.goto(`${URL}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  return { page, ctx };
}

// --- 1. a held button produces an answer -------------------------------------

{
  const { page, ctx } = await phone();

  const btn = page.locator(".ask-btn");
  check("the phone offers a way to ask", await btn.count() === 1,
    "Ask on the phone is the claim 'run the pilot on phones' depends on");

  const box = await btn.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(250);

  check("holding it opens the microphone",
    /listening/i.test(await page.locator(".ask").getAttribute("class") || ""),
    await page.locator(".ask-btn").innerText().catch(() => ""));

  const meterBefore = await page.locator(".ask-meter").count();
  check("and shows a level, so an open mic hearing nothing is distinguishable",
    meterBefore === 1);

  // Long enough to clear the AI service's 0.25 s minimum with room to spare.
  await page.waitForTimeout(1100);
  await page.mouse.up();

  await page.waitForSelector(".card .row", { timeout: 20000 }).catch(() => {});
  const rows = await page.locator(".card .row").allInnerTexts();
  check("an answer comes back and is drawn on a card", rows.length > 0,
    JSON.stringify(rows).slice(0, 140));

  // The transcript is pinned, so the answer is the one this store's records
  // support — and it is the sentence the customer deck sells.
  check("the answer is grounded in the store's own stock",
    rows.join(" ").toUpperCase().includes("32"),
    JSON.stringify(rows).slice(0, 140));

  check("the mic closes once the question is asked",
    !/listening/i.test(await page.locator(".ask").getAttribute("class") || ""));

  await ctx.close();
}

// --- 2. the retailer's switch reaches the surface ----------------------------

{
  const { page, ctx } = await phone({
    capabilities: { voice: false, floor_comms: true, widgets: true, known: true },
  });
  check("a store with voice switched off gets no microphone",
    await page.locator(".ask-btn").count() === 0,
    "the service refuses the query too; this is the surface not offering it");
  await ctx.close();
}

// --- 3. a refused permission is actionable -----------------------------------

{
  const ctx = await browser.newContext({ ...PHONE, permissions: [] });
  // Deny explicitly: the fake-UI flag above would otherwise grant it.
  await ctx.grantPermissions([]);
  const page = await ctx.newPage();
  await page.goto(`${URL}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(([token]) => {
    localStorage.clear();
    localStorage.setItem("cue.pocket.mode", "personal");
    localStorage.setItem("cue.pocket.session", token);
    localStorage.setItem("cue.pocket.tenant", "gap");
  }, [login.token]);
  // Make getUserMedia refuse the way a real denial does, since Chromium's
  // fake-UI flag cannot be turned off per context.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => Promise.reject(new DOMException("Denied", "NotAllowedError")) },
    });
  });
  await page.goto(`${URL}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);

  const btn = page.locator(".ask-btn");
  if (await btn.count()) {
    const box = await btn.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(400);
    await page.mouse.up();
  }
  const text = await page.locator(".ask").innerText().catch(() => "");
  check("a blocked microphone says so, and says where to fix it",
    /blocked/i.test(text) && /settings/i.test(text),
    text.replace(/\s+/g, " ").slice(0, 100));
  await ctx.close();
}

// --- 4. a thumb that slides off still ends the question ----------------------

{
  const { page, ctx } = await phone();
  const btn = page.locator(".ask-btn");
  const box = await btn.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(500);
  // Release well away from the control — the common real gesture.
  await page.mouse.move(5, 5);
  await page.mouse.up();
  await page.waitForTimeout(600);

  check("releasing away from the button still closes the mic",
    !/listening/i.test(await page.locator(".ask").getAttribute("class") || ""),
    "pointer capture keeps the release ours; without it the mic runs to the 12 s cap");
  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
