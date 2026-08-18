/**
 * Gated-open capture — the only write the public decks make.
 *
 * Somebody typed a name and an email to read a deck. That is a person handing
 * over contact details, so the rules here are the rules the rest of the product
 * already keeps for personal data, restated because this endpoint sits outside
 * the control plane and nothing else would enforce them:
 *
 *  · **Never block the deck.** Every failure path returns 204. A gate that
 *    traps a real investor behind a 500 costs more than a missed lead, and the
 *    client treats this call as fire-and-forget for the same reason.
 *  · **Take only the declared fields, bounded.** This is an unauthenticated
 *    endpoint on the public internet; an unbounded body is a place to park a
 *    megabyte, and a field nobody declared is a field nobody reviewed.
 *  · **Rate limit by IP.** In-memory and per-instance, so it is a speed bump
 *    against a script rather than a defence against a botnet — the same honest
 *    framing `app/auth.py` uses about its own limiter.
 *  · **Forward it to the control plane, and log it either way.** The log line
 *    is the fallback, not the system — it is recoverable by a human reading
 *    Vercel and by nothing else. `CUE_AI_URL` + `CUE_API_KEY` send it to
 *    `POST /api/ingest/deck-lead`, where it becomes a row the Console panel
 *    can read and the retention sweep can age out. `LEAD_WEBHOOK_URL` stays
 *    as a second, independent destination for anyone who wants one.
 */

const MAX_BODY = 4_000;
const FIELDS = ["deck", "name", "email", "firm", "preparedFor", "to", "token", "ref"];
const MAX_FIELD = 200;

const WINDOW_MS = 60_000;
const PER_WINDOW = 10;
const hits = new Map();

function throttled(ip) {
  const now = Date.now();
  const seen = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  seen.push(now);
  hits.set(ip, seen);
  // Bound the map: a serverless instance is long-lived enough for this to grow.
  if (hits.size > 5_000) {
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > WINDOW_MS * 5) hits.delete(k);
  }
  return seen.length > PER_WINDOW;
}

/** Whitelisted, trimmed, truncated. Anything not declared above is dropped. */
function clean(body) {
  const out = {};
  for (const k of FIELDS) {
    const v = body?.[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, MAX_FIELD);
  }
  return out;
}

/**
 * Send the lead to the control plane, where it becomes a row rather than a log
 * line — readable in Console, countable against the link that produced it, and
 * inside the retention sweep like every other piece of personal data we hold.
 *
 * Silent when unconfigured. This site is deployable on its own and a deck that
 * refused to open because an internal service was not wired would be the tail
 * wagging the dog; the log line still catches the lead either way.
 */
async function deliver(record) {
  const base = (process.env.CUE_AI_URL || "").replace(/\/$/, "");
  const key = process.env.CUE_API_KEY;
  if (!base || !key) {
    // Loudly, and naming which half is missing.
    //
    // This used to `return` in silence, and it cost a real lead: a gated open
    // on 18 Aug was logged here and delivered nowhere, and because the drop
    // said nothing, the deck looked fine, the function returned 204, and the
    // only evidence was this log line sitting under a panel that showed an
    // empty list. Staying quiet about an unconfigured deployment is only
    // defensible for the *reader* — the deck must still open — and never for
    // us, because we are the ones who can fix it.
    console.error(
      `[cuesea-lead] DROPPED — not forwarded to the control plane. Missing ` +
      `${!base ? "CUE_AI_URL" : ""}${!base && !key ? " and " : ""}${!key ? "CUE_API_KEY" : ""} ` +
      `on this deployment. The lead is in the line above and nowhere else.`,
    );
    return;
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 3_000);
  try {
    const res = await fetch(`${base}/api/ingest/deck-lead`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gapvision-key": key },
      body: JSON.stringify(record),
      signal: ctl.signal,
    });
    if (!res.ok) console.warn(`[cuesea-lead] control plane → ${res.status}`);
  } catch (err) {
    console.warn(`[cuesea-lead] control plane unreachable: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).end();
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  // Still 204. A throttled caller learning it was throttled is a caller that
  // knows to slow down and retry; a reader who typed their name learns nothing
  // either way, which is correct — the deck opens regardless.
  if (throttled(ip)) return res.status(204).end();

  try {
    const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
    if (raw.length > MAX_BODY) return res.status(204).end();
    const lead = clean(typeof req.body === "string" ? JSON.parse(req.body) : req.body);

    // An email is the only field that makes a lead a lead.
    if (!lead.email) return res.status(204).end();

    const record = { ...lead, at: lead.at || new Date().toISOString() };
    // Logged unconditionally and *first*. Every destination below can fail, and
    // when they all do this line is the only remaining copy of somebody who
    // asked to hear from us.
    console.log(`[cuesea-lead] ${JSON.stringify(record)}`);

    await deliver(record);

    const hook = process.env.LEAD_WEBHOOK_URL;
    if (hook) {
      // Awaited, not fired and forgotten: a serverless function that returns
      // before its own fetch resolves is a function whose fetch may never
      // happen. Bounded so a slow webhook cannot hold the response open.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 3_000);
      try {
        await fetch(hook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(record),
          signal: ctl.signal,
        });
      } catch (err) {
        console.warn(`[cuesea-lead] webhook failed: ${err.message}`);
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (err) {
    console.warn(`[cuesea-lead] dropped: ${err.message}`);
  }

  return res.status(204).end();
}
