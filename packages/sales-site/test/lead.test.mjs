/**
 * The gated-open endpoint — the only write the public decks make.
 *
 *   npm run test:lead
 *
 * This file exists because both of the bugs that lost real leads on 18 Aug
 * lived in one small function that nothing tested:
 *
 *   1. `deliver()` returned in silence when unconfigured, so a misconfigured
 *      deployment dropped every lead and said nothing. A gated open at 02:14
 *      reached the log and nowhere else.
 *   2. The env vars were then set with a trailing newline on the paste, which
 *      travels inside the header and comes back as a flat 401 — a status that
 *      reads as "wrong key" and sends somebody hunting the wrong secret.
 *
 * The property that governs the whole module and must never regress: **the
 * reader is never made to pay for our plumbing.** Every path answers 204 and
 * the deck opens, whatever happened behind it. That is exactly what makes the
 * *logging* load-bearing rather than cosmetic — it is the only channel a
 * failure has, so a failure that logs nothing is a failure nobody can act on.
 */
import test from "node:test";
import assert from "node:assert/strict";

const MOD = "../api/lead.js";

/** A fresh module per case: `deliver` reads env at call time, but the rate
 *  limiter is module state and would otherwise leak between tests. */
async function load() {
  return (await import(`${MOD}?t=${Math.random()}`)).default;
}

function res() {
  const r = {
    statusCode: null, headers: {}, body: undefined,
    setHeader(k, v) { r.headers[k] = v; },
    status(c) { r.statusCode = c; return r; },
    end(b) { r.body = b; return r; },
    json(b) { r.body = b; return r; },
  };
  return r;
}

const req = (body) => ({ method: "POST", headers: { "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250)}` }, body });

const LEAD = { deck: "floor", name: "Dana", email: "dana@merchant.example.com" };

/** Run the handler with a stubbed fetch and captured console output. */
async function run(body, env, fetchImpl) {
  const handler = await load();
  const before = { ...process.env };
  Object.assign(process.env, env);
  const calls = [];
  const logs = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return fetchImpl ? fetchImpl(url, opts) : { ok: true, status: 204 };
  };
  const warn = console.warn, error = console.error, log = console.log;
  console.warn = console.error = console.log = (...a) => logs.push(a.join(" "));
  try {
    const r = res();
    await handler(req(body), r);
    return { r, calls, logs: logs.join("\n") };
  } finally {
    console.warn = warn; console.error = error; console.log = log;
    for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
    Object.assign(process.env, before);
  }
}

const CONFIG = {
  CUE_AI_URL: "https://ai.example.com",
  CUE_API_KEY: "sk-live-abc123",
};

// --- the reader always gets their deck ---------------------------------------

test("a well-formed open answers 204", async () => {
  const { r } = await run(LEAD, CONFIG);
  assert.equal(r.statusCode, 204);
});

test("and still answers 204 when the control plane refuses", async () => {
  const { r } = await run(LEAD, CONFIG, async () => ({ ok: false, status: 500 }));
  assert.equal(r.statusCode, 204);
});

test("and still answers 204 when the control plane is unreachable", async () => {
  const { r } = await run(LEAD, CONFIG, async () => { throw new Error("ECONNREFUSED"); });
  assert.equal(r.statusCode, 204);
});

// --- the whitespace that cost a lead -----------------------------------------

test("a key pasted with a trailing newline still authenticates", async () => {
  // The 18 Aug 401. A dashboard copy takes the newline with it, every UI hides
  // it, and untrimmed it travels inside the header.
  const { calls } = await run(LEAD, { ...CONFIG, CUE_API_KEY: "sk-live-abc123\n" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.headers["x-gapvision-key"], "sk-live-abc123");
});

test("a url pasted with surrounding whitespace still resolves", async () => {
  const { calls } = await run(LEAD, { ...CONFIG, CUE_AI_URL: "  https://ai.example.com \n" });
  assert.equal(calls[0].url, "https://ai.example.com/api/ingest/deck-lead");
});

test("a trailing slash on the url does not double up", async () => {
  const { calls } = await run(LEAD, { ...CONFIG, CUE_AI_URL: "https://ai.example.com/" });
  assert.equal(calls[0].url, "https://ai.example.com/api/ingest/deck-lead");
});

// --- a drop must never be silent ---------------------------------------------

test("an unconfigured deployment says so, and names the missing variable", async () => {
  const { r, calls, logs } = await run(LEAD, { CUE_AI_URL: "", CUE_API_KEY: "" });
  assert.equal(r.statusCode, 204);            // the reader is unaffected
  assert.equal(calls.length, 0);              // nothing was sent
  assert.match(logs, /DROPPED/);
  assert.match(logs, /CUE_AI_URL/);
  assert.match(logs, /CUE_API_KEY/);
});

test("a missing key alone names the key, not the url", async () => {
  const { logs } = await run(LEAD, { ...CONFIG, CUE_API_KEY: "" });
  assert.match(logs, /CUE_API_KEY/);
  assert.ok(!/Missing CUE_AI_URL/.test(logs), logs);
});

test("a rejected key says what a 401 means here", async () => {
  // The number alone sent somebody hunting the wrong secret for an hour.
  const { logs } = await run(LEAD, CONFIG, async () => ({ ok: false, status: 401 }));
  assert.match(logs, /DROPPED/);
  assert.match(logs, /GAPVISION_API_KEY/);
});

test("the lead itself is always logged, so a drop stays recoverable", async () => {
  const { logs } = await run(LEAD, { CUE_AI_URL: "", CUE_API_KEY: "" });
  assert.match(logs, /dana@merchant\.example\.com/);
});

// --- the body boundary --------------------------------------------------------

test("only declared fields are forwarded", async () => {
  const { calls } = await run(
    { ...LEAD, evil: "<script>", token: "t1" }, CONFIG);
  const sent = JSON.parse(calls[0].opts.body);
  assert.equal(sent.evil, undefined);
  assert.equal(sent.token, "t1");
});

test("a non-POST is refused without touching the control plane", async () => {
  const handler = await load();
  const r = res();
  await handler({ method: "GET", headers: {} }, r);
  assert.equal(r.statusCode, 405);
});
