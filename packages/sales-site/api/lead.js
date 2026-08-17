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
 *  · **Log it, and forward it if somewhere is configured.** Without
 *    `LEAD_WEBHOOK_URL` a lead lands in the runtime log, which is recoverable
 *    but not a system. `claude/sales-deck.md` has the contract for
 *    `POST /api/ingest/deck-lead`, which is where these should end up: leads
 *    are personal data and belong in the retention sweep like everything else.
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
    console.log(`[cuesea-lead] ${JSON.stringify(record)}`);

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
