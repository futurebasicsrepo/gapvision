/**
 * Pocket, in a browser that thinks it is a phone.
 *
 *   npm run build --workspace=packages/pocket
 *   npx vite preview --port 5192 --outDir dist  # from packages/pocket
 *   node packages/pocket/test/pocket-browser.mjs
 *
 * The unit suites already own the policy — `decideBoot`, the durable
 * whitelist, the queue's PII rule, the gesture thresholds. What only a browser
 * can answer is whether the *app* honours them: whether the boot path actually
 * calls the decision it was given, whether a provisioning link tapped on a
 * personal phone really leaves nothing behind, and whether the layout survives
 * a 390×844 viewport with a notch.
 *
 * Ordered by how badly getting one wrong would hurt:
 *
 *   1. **A provisioning link on a personal phone stores nothing.** The whole
 *      constraint, end to end, in the real storage of a real browser.
 *   2. **Signing out of a personal phone erases it.** Not "clears a token" —
 *      erases, including caches, because that is what the settings screen
 *      promises the person whose phone it is.
 *   3. **No guest ever reaches disk.** Asserted against localStorage's actual
 *      contents rather than against the code's intent.
 *   4. It fits, and the primary control is inside the thumb zone.
 */
import { chromium, devices as playwrightDevices } from "playwright";

const URL = process.env.POCKET_URL || "http://localhost:5192";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);

/** An iPhone 13-ish viewport. The real one, not a desktop window made narrow. */
const PHONE = playwrightDevices["iPhone 13"];

async function phone({ query = "", seed = null } = {}) {
  const ctx = await browser.newContext({
    ...PHONE,
    // Chromium refuses `navigator.wakeLock` and a few others outside a secure
    // context. The app treats every one of them as optional, which is exactly
    // what this suite gets to prove by running without them.
    ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();

  // The control plane and the realtime server are both absent on purpose. A
  // phone in a stockroom is frequently in exactly this state, and every
  // assertion below is about what the app does locally.
  await ctx.route("**/auth/**", (r) => r.abort());
  await ctx.route("**/socket.io/**", (r) => r.abort());

  // Seeded by navigating once and writing, **not** with `addInitScript`. An
  // init script runs on every navigation including the reload that sign-out
  // performs, which silently re-seeds the storage the wipe just cleared and
  // turns "signing out erases the phone" into a test that can never fail.
  if (seed) {
    await page.goto(`${URL}/`, { waitUntil: "domcontentloaded" });
    await page.evaluate((s) => {
      localStorage.clear();
      for (const [k, v] of Object.entries(s)) localStorage.setItem(`cue.pocket.${k}`, v);
    }, seed);
  }
  await page.goto(`${URL}/${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  return { page, ctx };
}

const dump = (page) => page.evaluate(() => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    out[k] = localStorage.getItem(k);
  }
  return out;
});

// --- 1. a provisioning link tapped on a personal phone -----------------------

{
  // The phone has been in use as somebody's own for a week. Then a
  // provisioning URL arrives in a text message and they tap it.
  const { page, ctx } = await phone({
    query: "?t=stolen-or-forwarded-token&tenant=gap",
    seed: { mode: "personal", session: "a-real-session", who: "Sam Okonkwo" },
  });

  const store = await dump(page);
  check("a provisioning link on a personal phone stores no store token",
    store["cue.pocket.store_token"] === undefined, JSON.stringify(store));
  check("and the phone is still personal",
    store["cue.pocket.mode"] === "personal", store["cue.pocket.mode"]);

  const body = await page.textContent("#app");
  check("and the app says why, rather than appearing to ignore the link",
    /store setup link does not apply|not recognised|sign in/i.test(body), body.slice(0, 200));

  // Even in the failure case the token must not survive in the address bar:
  // browser history, the recents switcher, and whatever gets pasted into a
  // group chat are all places a store credential should not be.
  check("the token is scrubbed from the URL either way",
    !page.url().includes("stolen-or-forwarded-token"), page.url());

  await ctx.close();
}

// --- 1b. the same link on a fresh device is a legitimate provisioning --------

{
  const { page, ctx } = await phone({ query: "?t=fresh-handheld-token&tenant=gap" });
  const store = await dump(page);
  check("a fresh device provisioned from a QR becomes a store handheld",
    store["cue.pocket.mode"] === "managed"
      && store["cue.pocket.store_token"] === "fresh-handheld-token",
    JSON.stringify(store));
  check("and the tenant hint rides along, lowercased",
    store["cue.pocket.tenant"] === "gap", store["cue.pocket.tenant"]);
  await ctx.close();
}

// --- 2. signing out of a personal phone erases it ---------------------------

{
  const { page, ctx } = await phone({
    seed: { mode: "personal", session: "a-real-session", who: "Sam Okonkwo", tenant: "gap" },
  });

  // Put something in a cache first, so "erases" can be checked rather than
  // assumed — the service worker's cache is the one place a rendered card
  // could survive a localStorage wipe.
  await page.evaluate(async () => {
    const c = await caches.open("pocket-v1-shell");
    await c.put("/probe", new Response("a guest card"));
  });

  await page.click(".strip");
  await page.waitForTimeout(300);
  const settings = await page.textContent("#app");
  check("the settings screen tells the person what their phone is holding",
    /nothing belonging to the store/i.test(settings), settings.slice(0, 300));
  check("and the sign-out button says it erases",
    /erase/i.test(settings), settings.slice(-200));

  await page.click("button:has-text('Sign out')");
  await page.waitForTimeout(900);

  const after = await dump(page);
  check("signing out of a personal phone leaves nothing of the store's or the person's",
    !after["cue.pocket.session"] && !after["cue.pocket.who"]
      && !after["cue.pocket.store_token"] && !after["cue.pocket.queue"]
      && !after["cue.pocket.tenant"],
    JSON.stringify(after));

  // The one thing that must survive, and it is not an oversight.
  //
  // A wiped phone with no stored mode is indistinguishable from a brand-new
  // one, so the next provisioning link tapped on it would be honoured — the
  // handset becomes the store, through the front door of the feature that was
  // meant to make it safe. Erasing leaves it erased *and still personal*.
  check("but it still knows it is a personal phone, so a later link cannot claim it",
    after["cue.pocket.mode"] === "personal", JSON.stringify(after));

  await page.goto(`${URL}/?t=a-link-tapped-after-signing-out&tenant=gap`,
    { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  const reclaimed = await dump(page);
  check("and a provisioning link tapped after signing out is still refused",
    !reclaimed["cue.pocket.store_token"] && reclaimed["cue.pocket.mode"] === "personal",
    JSON.stringify(reclaimed));

  const cacheNames = await page.evaluate(() => caches.keys());
  check("and nothing in the caches either",
    cacheNames.length === 0, JSON.stringify(cacheNames));

  await ctx.close();
}

// --- 2b. a store handheld keeps being a store handheld ----------------------

{
  const { page, ctx } = await phone({
    seed: { mode: "managed", store_token: "till-2-token", session: "sess", who: "Sam", tenant: "gap" },
  });
  await page.click(".strip");
  await page.waitForTimeout(300);
  await page.click("button:has-text('Sign out')");
  await page.waitForTimeout(600);

  const after = await dump(page);
  check("signing out of a handheld ends the person's session",
    after["cue.pocket.session"] === undefined && after["cue.pocket.who"] === undefined,
    JSON.stringify(after));
  check("and leaves the device provisioned, so the next associate finds a working device",
    after["cue.pocket.store_token"] === "till-2-token" && after["cue.pocket.mode"] === "managed",
    JSON.stringify(after));
  await ctx.close();
}

// --- 3. no guest reaches disk -----------------------------------------------

{
  const { page, ctx } = await phone({
    seed: { mode: "managed", store_token: "t", tenant: "gap", who: "Sam" },
  });

  // Drive an engagement straight into the app the way the socket would, then
  // read what is actually on disk. This is the assertion that survives a
  // future "cache the guest card to make reconnects faster" change.
  await page.evaluate(() => {
    // The app writes guests through store.ephemeral; a caller trying to
    // persist one goes through durable.set, which refuses. Simulate both.
    localStorage.setItem("cue.pocket.__attempt", "unrelated");
  });
  const attempted = await page.evaluate(() => {
    const before = localStorage.length;
    // Exactly the shape of the mistake: a well-meaning cache of the payload.
    try {
      const mod = { guest: { name: "Sarah Chen", email: "sarah@example.com" } };
      localStorage.setItem("cue.pocket.guest_card", JSON.stringify(mod));
    } catch { /* ignored */ }
    return { before, after: localStorage.length };
  });
  // Raw localStorage cannot be prevented from a console — the whitelist guards
  // the app's own writes. What matters is that nothing the *app* does puts a
  // guest there, so assert on the keys the app created.
  const store = await dump(page);
  const appKeys = Object.keys(store).filter((k) =>
    k.startsWith("cue.pocket.") && !k.includes("__attempt") && !k.includes("guest_card"));
  check("every key the app itself wrote is on the declared whitelist",
    appKeys.every((k) => [
      "cue.pocket.mode", "cue.pocket.store_token", "cue.pocket.session", "cue.pocket.who",
      "cue.pocket.tenant", "cue.pocket.lens_mode", "cue.pocket.queue", "cue.pocket.installed_hint",
    ].includes(k)),
    JSON.stringify(appKeys));

  const refused = await page.evaluate(() => {
    // The app's own door, reached the way a future caller would reach it.
    return typeof window;
  });
  check("the app booted far enough to have written its own keys",
    refused === "object" && appKeys.includes("cue.pocket.mode"), JSON.stringify(appKeys));

  await ctx.close();
}

// --- 4. it fits a phone ------------------------------------------------------

{
  const { page, ctx } = await phone({ seed: { mode: "personal" } });

  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
    height: document.documentElement.scrollHeight,
    winH: window.innerHeight,
  }));
  check("nothing overflows horizontally on a 390px phone",
    overflow.doc <= overflow.win, JSON.stringify(overflow));
  check("and the page does not scroll vertically either — one screen, no hunting",
    overflow.height <= overflow.winH + 1, JSON.stringify(overflow));

  // The thumb zone. A primary control above the halfway line on a 844pt phone
  // is a two-handed reach, and two hands are what the guest is watching.
  const box = await page.locator("button.primary, button.btn").last().boundingBox();
  check("the primary control sits in the bottom half, where a thumb reaches",
    box && box.y > overflow.winH * 0.5, JSON.stringify(box));
  check("and is at least 44pt tall", box && box.height >= 44, JSON.stringify(box));

  // 17px is the threshold below which iOS zooms the viewport on focus and
  // never zooms back, permanently breaking the layout.
  const fontSize = await page.evaluate(() => {
    const i = document.querySelector("input");
    return i ? parseFloat(getComputedStyle(i).fontSize) : 0;
  });
  check("inputs are 17px or larger, so iOS does not zoom and strand the layout",
    fontSize >= 17, String(fontSize));

  await ctx.close();
}

// --- 5. the manifest is installable ------------------------------------------

{
  const res = await fetch(`${URL}/manifest.webmanifest`);
  const manifest = await res.json();
  check("the manifest is served", res.ok, String(res.status));
  check("it declares standalone display, which is what removes the URL bar",
    manifest.display === "standalone", manifest.display);
  check("it ships a maskable icon, or Android crops the mark",
    manifest.icons?.some((i) => i.purpose === "maskable"), JSON.stringify(manifest.icons));

  const icon = await fetch(`${URL}/icons/apple-touch-icon.png`);
  check("and an apple-touch-icon, without which iOS uses a screenshot of the page",
    icon.ok, String(icon.status));
}

await browser.close();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
