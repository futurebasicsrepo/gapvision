/**
 * Cue Console — Sales.
 *
 * Two decks live under this tab and they are not the same job:
 *
 *   floor      — the customer deck. Merchants. Sent constantly, and the one a
 *                future salesperson will live in. Default.
 *   fundraise  — the pre-seed deck. Investors. Rarely sent, carefully tracked.
 *
 * They share everything else: the same share parameters (`to`, `gate`, `t`),
 * the same lead shape, the same PDF affordance. So this is a registry plus one
 * set of controls, and adding a third deck is a row in DECKS rather than a
 * second panel.
 *
 * Two honesty notes that belong in the code as much as in the UI:
 *
 * 1. The gate is a LEAD gate, not authentication. Anyone can strip `gate=1`
 *    from the URL. The panel says so, and it must keep saying so — the moment
 *    it reads as protection, someone sends the wrong deck to the wrong room
 *    and believes it was safe.
 *
 * 2. Links and leads both live in the control plane now. Either endpoint being
 *    absent is reported as *absent* rather than as zero — an internal tool
 *    that invents a number is an internal tool whose number gets quoted.
 *
 * The localStorage that used to hold links is gone. It meant a link made on a
 * laptop was invisible from a phone and "Forget" removed the row rather than
 * the link, which made the whole list untrustworthy in the one way a record of
 * what you sent must not be.
 *
 * Console and the AI service deploy on separate pushes, so this surface has to
 * survive the window where one has the endpoint and the other does not — hence
 * `absent` as a first-class state rather than an error nobody can act on.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

/** One origin serves both decks. Set VITE_SALES_URL per environment. */
const ORIGIN = (import.meta.env?.VITE_SALES_URL || "https://sales.cuesea.ai").replace(/\/$/, "");

const DECKS = [
  {
    id: "floor",
    tab: "For the floor",
    path: "/customers",
    pdf: "/cuesea-for-the-floor.pdf",
    title: "cuesea — for the floor",
    subtitle: "What it does, where it fits, what it connects to, and what it costs",
    audience: "Merchants and operators",
    version: "v1 · August 2026 · 11 sections",
    placeholder: "Reformation",
    covers: [
      "Four capabilities, each on a real lens: ask, requests, presence, floor comms",
      "Verticals — specialty retail live, hospitality and field service seeking design partners",
      "Integration: Shopify today, how a merchant connects in twenty minutes, what comes next",
      "Privacy and security, written for their legal review",
      "Known edges — the honest limits, said before they find them",
      "Twelve-week rollout with a holdout, and pricing",
    ],
  },
  {
    id: "fundraise",
    tab: "Fundraise",
    path: "/fundraise",
    pdf: "/cuesea-preseed.pdf",
    title: "cuesea — pre-seed",
    subtitle: "The floor's request-and-answer loop",
    audience: "Investors",
    version: "v1 · August 2026 · 13 sections",
    placeholder: "Acme Ventures",
    covers: [
      "Problem, insight, product, and what is already built",
      "Market sized three ways, competition, and the model",
      "The bear case in our own words",
      "The plan, and the $1.5M ask",
    ],
  },
];

function token() {
  const a = new Uint8Array(6);
  (globalThis.crypto || {}).getRandomValues?.(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}
function linkFor(deck, row) {
  const u = new URL(ORIGIN + deck.path + "/");
  if (row.to) u.searchParams.set("to", row.to);
  if (row.gate) u.searchParams.set("gate", "1");
  u.searchParams.set("t", row.token);
  return u.toString();
}

export default function Sales() {
  const [deckId, setDeckId] = useState(DECKS[0].id);
  const [links, setLinks] = useState({ state: "loading", items: [] });
  const [to, setTo] = useState("");
  const [gate, setGate] = useState(true);
  const [copied, setCopied] = useState("");
  const [leads, setLeads] = useState({ state: "loading", items: [] });

  const deck = DECKS.find((d) => d.id === deckId);
  const deckUrl = ORIGIN + deck.path;

  /* Links. Same three states as leads below, and for the same reason: Console
     and the AI service deploy on separate pushes, so "the endpoint is not there
     yet" is a real condition rather than a bug, and it has to read differently
     from "no links yet". */
  const loadLinks = useCallback(() => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    fetch("/api/analytics/deck-links?days=365", { signal: ctl.signal, credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => setLinks({ state: "ok", items: (d.links || []).map((l) => ({
        ...l, to: l.prepared_for || "", gate: l.gated, at: l.at,
      })) }))
      .catch(() => setLinks({ state: "absent", items: [] }))
      .finally(() => clearTimeout(t));
    return () => ctl.abort();
  }, []);

  useEffect(() => loadLinks(), [loadLinks]);

  /* Leads. An absent endpoint is reported as absent, never as zero — unknown
     never renders as a pass, the same rule the Health panel keeps. */
  useEffect(() => {
    let live = true;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    fetch("/api/analytics/deck-leads?days=90", { signal: ctl.signal, credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => live && setLeads({ state: "ok", items: d.leads || [] }))
      .catch(() => live && setLeads({ state: "absent", items: [] }))
      .finally(() => clearTimeout(t));
    return () => {
      live = false;
      ctl.abort();
    };
  }, []);

  const copy = (text, id) => {
    const done = () => {
      setCopied(id);
      setTimeout(() => setCopied(""), 1800);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, done);
    else {
      const el = document.createElement("textarea");
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      el.remove();
      done();
    }
  };

  /* The link is built and copied first, and recorded second.
     Deliberate ordering: the URL is valid the moment it exists — nothing about
     it depends on our database — so a failure to record must never cost
     somebody the link they just asked for. It costs them the row, and the card
     says so. */
  const create = async () => {
    const row = { token: token(), deck: deck.id, to: to.trim(), gate,
                  at: new Date().toISOString() };
    setTo("");
    copy(linkFor(deck, row), row.token);

    try {
      const res = await fetch("/api/analytics/deck-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ deck: row.deck, token: row.token,
                               preparedFor: row.to || null, gated: row.gate }),
      });
      if (!res.ok) throw new Error(String(res.status));
      loadLinks();
    } catch {
      /* Show it anyway, marked, rather than dropping it out of a list the
         person watched themselves create. */
      setLinks((l) => ({ state: l.state === "ok" ? "ok" : "absent",
                         items: [{ ...row, prepared_for: row.to, unsaved: true },
                                 ...l.items] }));
    }
  };

  const mine = useMemo(() => links.items.filter((r) => r.deck === deck.id),
                       [links.items, deck.id]);
  const deckLeads = useMemo(
    () => leads.items.filter((l) => !l.deck || l.deck === deck.id),
    [leads.items, deck.id]
  );

  return (
    <div className="sales">
      {/* No <h1> here: Console's shell draws the panel title and its sentence
          from App.jsx, and a panel that prints its own heading prints it
          twice. Everything below is this panel's own. */}

      {/* ── which deck ───────────────────────────────────────── */}
      <nav className="sales-tabs" aria-label="Decks">
        {DECKS.map((d) => (
          <button
            key={d.id}
            type="button"
            className={"sales-tab" + (d.id === deckId ? " on" : "")}
            aria-current={d.id === deckId ? "page" : undefined}
            onClick={() => setDeckId(d.id)}
          >
            <span className="t">{d.tab}</span>
            <span className="a">{d.audience}</span>
          </button>
        ))}
      </nav>

      {/* ── the deck ─────────────────────────────────────────── */}
      <section className="card sales-deck">
        <div className="sales-deck-main">
          <p className="k">Current deck</p>
          <h2>{deck.title}</h2>
          <p className="sales-sub">{deck.subtitle}</p>
          <p className="meta">{deck.version}</p>
          <ul className="sales-covers">
            {deck.covers.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
        <div className="sales-actions">
          <a className="btn primary" href={deckUrl} target="_blank" rel="noreferrer">
            Open
          </a>
          <button className="btn" onClick={() => copy(deckUrl, "deck")}>
            {copied === "deck" ? "Copied" : "Copy link"}
          </button>
          <a className="btn" href={ORIGIN + deck.pdf} download>
            Download PDF
          </a>
        </div>
      </section>

      {/* ── compose ──────────────────────────────────────────── */}
      <section className="card">
        <p className="k">Send this deck to someone</p>
        <div className="sales-compose">
          <label className="field">
            <span>Prepared for</span>
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder={deck.placeholder}
              onKeyDown={(e) => e.key === "Enter" && create()}
            />
          </label>
          <label className="sales-check">
            <input type="checkbox" checked={gate} onChange={(e) => setGate(e.target.checked)} />
            <span>Ask for an email before the deck opens</span>
          </label>
          <button className="btn primary" onClick={create}>
            Create link
          </button>
        </div>
        <p className="warn-note">
          The gate captures a name and an email — it is not access control. Anyone with the URL can
          remove the parameter and read the deck. Send accordingly.
        </p>
      </section>

      {/* ── links ────────────────────────────────────────────── */}
      <section className="card">
        <div className="sales-rowhead">
          <p className="k">Links · {deck.tab}</p>
          <p className="meta">
            {mine.length} total · {mine.filter((r) => r.gate).length} gated
          </p>
        </div>
        {mine.length === 0 ? (
          <p className="empty">
            {links.state === "loading" ? "Checking…"
              : "No links for this deck yet. Create one above and it is on your clipboard."}
          </p>
        ) : (
          <table className="sales-table">
            <thead>
              <tr>
                <th>Prepared for</th>
                <th>Gate</th>
                <th>Created</th>
                <th>Token</th>
                <th>Opens</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {mine.map((r) => (
                <tr key={r.token}>
                  <td data-label="Prepared for">{r.to || <span className="muted">— no recipient —</span>}</td>
                  <td data-label="Gate">
                    {r.gate ? <span className="tag on">email</span> : <span className="tag">open</span>}
                  </td>
                  <td data-label="Created" className="mono">{new Date(r.at).toLocaleDateString()}</td>
                  <td data-label="Token" className="mono muted">{r.token}</td>
                  <td data-label="Opens" className="mono">
                    {r.unsaved ? <span className="muted">not recorded</span>
                      : r.opens > 0 ? r.opens : <span className="muted">—</span>}
                  </td>
                  <td className="right">
                    <button className="btn small" onClick={() => copy(linkFor(deck, r), r.token)}>
                      {copied === r.token ? "Copied" : "Copy"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {links.state === "absent" && (
          <p className="warn-note">
            No link store on this deployment, so nothing here is being recorded — the
            links still work, because a link is just a URL, but this list will be
            empty on your next visit. Wire <code>/api/analytics/deck-links</code>
            (contract in <code>claude/sales-deck.md</code>) and it persists.
          </p>
        )}
        {mine.some((r) => r.unsaved) && (
          <p className="warn-note">
            One or more links above could not be recorded. They are valid and copied —
            they just will not be here tomorrow.
          </p>
        )}
      </section>

      {/* ── leads ────────────────────────────────────────────── */}
      <section className="card">
        <p className="k">Who opened a gated link</p>
        {leads.state === "loading" && <p className="empty">Checking…</p>}
        {leads.state === "absent" && (
          <p className="empty">
            No lead endpoint on this deployment. Gated opens are written to the deck host's runtime
            log. Wire <code>GET /api/analytics/deck-leads</code> and they appear here — see
            <code> claude/sales-deck.md</code> for the contract.
          </p>
        )}
        {leads.state === "ok" && deckLeads.length === 0 && (
          <p className="empty">No gated opens on this deck in the last 90 days.</p>
        )}
        {leads.state === "ok" && deckLeads.length > 0 && (
          <table className="sales-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Company</th>
                <th>Prepared for</th>
                <th>Opened</th>
              </tr>
            </thead>
            <tbody>
              {deckLeads.map((l, i) => (
                <tr key={l.id || i}>
                  <td data-label="Name">{l.name}</td>
                  <td data-label="Email" className="mono">{l.email}</td>
                  <td data-label="Company">{l.firm || <span className="muted">—</span>}</td>
                  <td data-label="Prepared for">{l.preparedFor || <span className="muted">—</span>}</td>
                  <td data-label="Opened" className="mono">{new Date(l.at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
