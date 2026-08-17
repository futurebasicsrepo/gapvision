import { useEffect, useState } from "react";
import Doc from "./Doc.jsx";
import learningsMd from "../docs/marketing-learnings.md?raw";

/**
 * Cue Console — Marketing.
 *
 * The assets, where outreach can happen, what I can run, and what we have
 * actually learned. Design and reasoning in `claude/marketing.md`.
 *
 * One rule runs through every card, and it is the rule marketing is most
 * willing to break: **unknown never renders as a pass.** An asset that might
 * not be deployed is checked rather than assumed. A channel nobody has
 * connected reads as *not connected*, not as zero — a zero claims we measured
 * none, and we measured nothing. The moment this panel shows a plausible
 * figure nobody can source, it becomes the place that figure gets quoted from.
 */

const ORIGIN = (import.meta.env?.VITE_SALES_URL || "https://sales.cuesea.ai").replace(/\/$/, "");

/**
 * Everything sendable.
 *
 * `url` items are checked live, because an asset that 404s is worse than one
 * that is missing: the missing one does not get sent to a merchant. `repo`
 * items are generated on demand and have no URL to check — they are listed as
 * what they are rather than dressed up as links.
 */
const ASSETS = [
  { id: "floor", kind: "url", name: "Deck — for the floor", who: "Merchants and operators",
    path: "/customers", note: "Eleven sections. The one a salesperson lives in." },
  { id: "fundraise", kind: "url", name: "Deck — pre-seed", who: "Investors",
    path: "/fundraise", note: "Thirteen sections, including the bear case in our own words." },
  { id: "pdf", kind: "url", name: "Leave-behind PDF", who: "Anyone, after the meeting",
    path: "/cuesea-for-the-floor.pdf", note: "Printed from the customer deck, so the two cannot drift." },
  { id: "onepager", kind: "repo", name: "Employee one-pager", who: "The stock room wall",
    note: "Generated from the same gesture table the plugin runs — npm run docs:onepager." },
  { id: "plates", kind: "repo", name: "Check-in plates", who: "The floor, printed",
    note: "QR and NFC artwork at a known physical size — npm run brand:assets." },
  { id: "brand", kind: "repo", name: "Brand kit", who: "Anything we make",
    note: "Tokens, mark and voice, in the Brand panel — the same source the products build from." },
];

/**
 * Where outreach can happen.
 *
 * `wired` is the only honest column here. Everything is false today, and the
 * card says that rather than drawing an empty chart that implies measurement.
 */
const CHANNELS = [
  { name: "Outbound email", wired: false,
    note: "I can draft and send from your account — the connector is live. Nothing has been sent, and nothing will be without you saying so per campaign." },
  { name: "Website", wired: false,
    note: "cuesea.ai is outside this repo. I can write copy for it; I cannot see or change it." },
  { name: "Ads", wired: false,
    note: "No account connected. Supermetrics reaches 150+ sources once you authorise one." },
  { name: "Product analytics", wired: false,
    note: "Google Analytics is not connected. Vercel's own web analytics is available on the deck site." },
  { name: "Deck opens", wired: false,
    note: "Captured at the deck host and written to its runtime log. They reach Console when /api/analytics/deck-leads exists — contract in claude/sales-deck.md." },
];

/** Grouped by what it costs to say yes, which is the only grouping that helps
 *  somebody deciding. See `claude/marketing.md` for the long form. */
const RUNNABLE = [
  { group: "Now, no setup", items: [
    ["Research", "Prospects, competitors, pricing teardowns — reading a merchant's own site before you write to them."],
    ["Writing in the brand's voice", "Sequences, landing copy, the follow-up after a deck is opened."],
    ["Asset generation", "Plates and the one-pager are scripts here. A new vertical's variant is a command, not a design cycle."],
    ["A third deck", "The decks are plain HTML. Hospitality or field service is a third folder — which is why it was built that way."],
    ["Scheduled work", "A Monday digest of deck opens; a nudge on a gated link open three days with no reply; a weekly check the site is still up."],
    ["Deploy and watch", "Vercel deploys, build logs, runtime logs. This is how a green-but-broken deploy got caught today."],
  ] },
  { group: "One decision away", items: [
    ["Sending email", "The Gmail connector is live. My recommendation: I draft, you read the first ten, then you decide whether to widen it."],
    ["Booking demos", "Straight into your calendar once a lead replies."],
    ["Real merchant proof", "A seeded Shopify store makes every deck screenshot true rather than mocked."],
    ["Channel reporting", "Connect an ad account or Analytics and the Channels card stops being blank."],
  ] },
  { group: "Wanted, honestly not built", items: [
    ["A CRM", "Links live in a browser, leads in a log. \"Who did we talk to in July\" has no answer."],
    ["Open-to-pilot attribution", "Gated opens on one side, tenants on the other, nothing joining them."],
  ] },
];

/**
 * Is this actually reachable?
 *
 * `no-cors` because the deck site is another origin and this is a liveness
 * question, not a data one — an opaque response that came back at all means
 * something answered. It cannot distinguish a 404 from a 200, which is worth
 * being straight about: this catches "the site is not deployed", not "that one
 * file is missing".
 */
function useReachable(paths) {
  const [state, setState] = useState("checking");
  useEffect(() => {
    let live = true;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5_000);
    fetch(ORIGIN + paths, { method: "HEAD", mode: "no-cors", signal: ctl.signal })
      .then(() => live && setState("up"))
      .catch(() => live && setState("down"))
      .finally(() => clearTimeout(timer));
    return () => { live = false; ctl.abort(); };
  }, [paths]);
  return state;
}

export default function Marketing() {
  // One check for the origin rather than one per asset: the failure this
  // guards against is "the site was never deployed", and five requests would
  // ask that same question five times.
  const site = useReachable("/customers");

  return (
    <div className="marketing">
      <div className="card span-12">
        <div className="card-head">
          <h3>Assets</h3>
          <span className={`pill ${site === "up" ? "" : site === "down" ? "flame" : "muted"}`}>
            {site === "checking" ? "checking the site" :
             site === "up" ? "sales site reachable" : "sales site not reachable"}
          </span>
        </div>
        <p className="card-note">
          Everything sendable. The hosted ones are checked rather than assumed —
          an asset that 404s is worse than one that is missing, because the
          missing one never gets sent to a merchant.
          {site === "down" && (
            <> <strong>Nothing at <span className="ident">{ORIGIN}</span> answered.</strong>{" "}
              Deploy <span className="ident">packages/sales-site</span> before sending any
              link from the Sales panel — see its README.</>
          )}
        </p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Asset</th><th>For</th><th>Where</th><th /></tr>
            </thead>
            <tbody>
              {ASSETS.map((a) => (
                <tr key={a.id}>
                  <td className="ident">{a.name}<div className="meta">{a.note}</div></td>
                  <td data-label="For">{a.who}</td>
                  <td data-label="Where">
                    {a.kind === "url"
                      ? <span className="machine">{ORIGIN}{a.path}</span>
                      : <span className="pill muted">in the repo</span>}
                  </td>
                  <td>
                    {a.kind === "url" && (
                      <a className="btn small ghost" href={ORIGIN + a.path}
                         target="_blank" rel="noreferrer">Open</a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card span-6">
        <h3>Channels</h3>
        <p className="card-note">
          Where outreach can happen, and whether it is wired. Nothing is, and
          this says so rather than drawing zeroes — a zero claims we measured
          none, and we have measured nothing.
        </p>
        <div className="channel-list">
          {CHANNELS.map((c) => (
            <div className="channel" key={c.name}>
              <div className="channel-head">
                <span className="ident">{c.name}</span>
                <span className={`pill ${c.wired ? "" : "muted"}`}>
                  {c.wired ? "wired" : "not connected"}
                </span>
              </div>
              <p className="meta channel-note">{c.note}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="card span-6">
        <h3>What I can run</h3>
        <p className="card-note">
          Grouped by what it costs you to say yes. The long form, including the
          three things worth knowing that nobody asked for, is in{" "}
          <span className="ident">claude/marketing.md</span>.
        </p>
        {RUNNABLE.map((g) => (
          <div className="runnable" key={g.group}>
            <div className="rail-section-label">{g.group}</div>
            {g.items.map(([name, note]) => (
              <div className="channel" key={name}>
                <div className="channel-head"><span className="ident">{name}</span></div>
                <p className="meta channel-note">{note}</p>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="card span-12">
        {/* From the repo, not from a database and not from this browser: a
            learning is worth what it is durable for, and the two ways to lose
            one are a cleared browser profile and a note nobody can review.
            Git answers both, and a wrong entry gets corrected in the open. */}
        <Doc source={learningsMd} />
      </div>
    </div>
  );
}
