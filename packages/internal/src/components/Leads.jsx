import { useEffect, useMemo, useState } from "react";
import { api, ApiError, when } from "../api.js";

/**
 * Cue Console — Leads. The pipeline, as a thing you can read at a glance.
 *
 * Three jobs, one screen: every lead and its stage, the touch log behind each
 * one, and which door produced them (the Sources card — the marketing mirror
 * of the doors analytics).
 *
 * Colour law, same as everywhere: stages are sea because a stage is a
 * measurement. Flame is reserved for the one condition that wants attention —
 * **a reply we have not answered** — because at founder-led volume the only
 * unforgivable pipeline failure is a warm merchant going cold in the inbox.
 * A lead that has merely gone quiet is muted, not flame; silence is the
 * prospect's right.
 *
 * Deliberately absent: automation. No sequences fire from here. The log
 * records what Kyle sent and what came back; a sequencer can be built on a
 * log, a log cannot be recovered from a sequencer.
 */

const STAGE_LABELS = {
  new: "New", contacted: "Contacted", replied: "Replied", demo: "Demo",
  pilot_scoped: "Pilot scoped", pilot_live: "Pilot live",
  won: "Won", lost: "Lost", nurture: "Nurture",
};

const KINDS = [
  ["email", "Email"], ["linkedin", "LinkedIn"], ["video", "Video"],
  ["call", "Call"], ["meeting", "Meeting"], ["note", "Note"],
];

/** A reply newer than our last outbound touch is the flame condition. */
const awaitingUs = (l) =>
  l.last_reply && (!l.last_touch || l.last_reply >= l.last_touch) &&
  !["won", "lost"].includes(l.stage);

export default function Leads() {
  const [data, setData] = useState(null);
  const [sources, setSources] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(null);        // lead id with the log open
  const [log, setLog] = useState({});            // id -> activities
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({});
  const [touch, setTouch] = useState({ kind: "email", direction: "out", body: "" });

  function load() {
    setError(null);
    api.growthLeads(filter || undefined)
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
    api.growthSources().then(setSources).catch(() => setSources(null));
  }
  useEffect(load, [filter]);

  function openLog(id) {
    setOpen(open === id ? null : id);
    if (open !== id) {
      api.growthActivities(id)
        .then((r) => setLog((m) => ({ ...m, [id]: r.activities || [] })))
        .catch(() => {});
    }
  }

  async function setStage(id, stage) {
    try { await api.updateGrowthLead(id, { stage }); load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  }

  async function addLead(e) {
    e.preventDefault();
    try {
      await api.createGrowthLead(draft);
      setDraft({}); setAdding(false); load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function logTouch(e, id) {
    e.preventDefault();
    try {
      await api.addGrowthActivity(id, touch);
      setTouch({ kind: "email", direction: "out", body: "" });
      const r = await api.growthActivities(id);
      setLog((m) => ({ ...m, [id]: r.activities || [] }));
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  const stages = data?.stages || Object.keys(STAGE_LABELS);
  const leads = data?.leads || [];
  const byStage = sources?.by_stage || {};
  const hot = useMemo(() => leads.filter(awaitingUs).length, [leads]);

  if (error && !data) return <div className="card span-12"><p className="empty">{error}</p></div>;
  if (!data) return <div className="card span-12"><p className="empty">Loading the pipeline…</p></div>;

  return (
    <>
      <div className="card span-12">
        <div className="card-head">
          <h2>Pipeline</h2>
          <button className="btn" onClick={() => setAdding(!adding)}>
            {adding ? "Cancel" : "Add lead"}
          </button>
        </div>
        <p className="card-note">
          {leads.length} {leads.length === 1 ? "lead" : "leads"}
          {filter ? ` in ${STAGE_LABELS[filter] || filter}` : ""}.
          {hot > 0 && ` ${hot} waiting on a reply from us.`}{" "}
          Site form fills land here automatically; outbound targets are added by hand.
        </p>

        <div className="stage-row">
          <button className={`pill${filter === "" ? "" : " muted"}`}
                  onClick={() => setFilter("")}>All</button>
          {stages.map((s) => (
            <button key={s} className={`pill${filter === s ? "" : " muted"}`}
                    onClick={() => setFilter(filter === s ? "" : s)}>
              {STAGE_LABELS[s] || s}{byStage[s] ? ` · ${byStage[s]}` : ""}
            </button>
          ))}
        </div>

        {adding && (
          <form className="lead-add" onSubmit={addLead}>
            {[["email", "Email *"], ["name", "Name"], ["company", "Company"],
              ["title", "Title"], ["pos", "POS"]].map(([k, label]) => (
              <label className="field" key={k}>
                <span>{label}</span>
                <input value={draft[k] || ""} required={k === "email"}
                       onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
              </label>
            ))}
            <label className="field">
              <span>Source</span>
              <select value={draft.source || "outbound"}
                      onChange={(e) => setDraft({ ...draft, source: e.target.value })}>
                {["outbound", "referral", "event", "deck", "other"].map((s) =>
                  <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <button className="btn" type="submit">Save</button>
          </form>
        )}

        {error && <p className="empty">{error}</p>}

        {leads.length === 0 ? (
          <p className="empty">
            Nothing in this view yet. The site form posts to /api/growth/lead on
            the realtime server; until the form ships, add outbound targets here.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Who</th><th>Company</th><th>Source</th><th>Stage</th>
                <th className="num">Touches</th><th>Last touch</th><th></th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <FragmentRow key={l.id} l={l} open={open === l.id}
                             onOpen={() => openLog(l.id)}
                             onStage={(s) => setStage(l.id, s)}
                             activities={log[l.id]}
                             touch={touch} setTouch={setTouch}
                             onTouch={(e) => logTouch(e, l.id)}
                             stages={stages} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card span-12">
        <div className="card-head"><h2>Sources</h2></div>
        <p className="card-note">
          Which door produced the pipeline — the marketing mirror of the doors
          analytics. Counts only: spend lives with the ad accounts, and a panel
          that invents a cost-per-lead is the panel that gets quoted.
        </p>
        {!sources ? (
          <p className="empty">Not available — the sources endpoint didn't answer.</p>
        ) : (sources.by_source || []).length === 0 ? (
          <p className="empty">No leads in the last {sources.days} days.</p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Source</th><th className="num">Leads</th>
                  <th className="num">Still live</th><th className="num">Reached demo+</th></tr>
            </thead>
            <tbody>
              {sources.by_source.map((r) => (
                <tr key={r.source}>
                  <td>{r.source}</td>
                  <td className="num">{r.leads}</td>
                  <td className="num">{r.live}</td>
                  <td className="num">{r.advanced}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {(sources?.by_campaign || []).length > 0 && (
          <>
            <p className="card-note">By campaign (UTM), last {sources.days} days.</p>
            <table className="table">
              <thead><tr><th>utm_source</th><th>utm_campaign</th><th className="num">Leads</th></tr></thead>
              <tbody>
                {sources.by_campaign.map((r, i) => (
                  <tr key={i}>
                    <td>{r.utm_source || "—"}</td>
                    <td>{r.utm_campaign || "—"}</td>
                    <td className="num">{r.leads}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </>
  );
}

function FragmentRow({ l, open, onOpen, onStage, activities, touch, setTouch, onTouch, stages }) {
  const hot = awaitingUs(l);
  return (
    <>
      <tr className={hot ? "lead-hot" : undefined} onClick={onOpen} style={{ cursor: "pointer" }}>
        <td>
          {l.name || l.email}
          {l.redacted_at && <span className="pill muted" style={{ marginLeft: 8 }}>redacted</span>}
          {hot && <span className="pill flame" style={{ marginLeft: 8 }}>reply waiting</span>}
        </td>
        <td>{l.company || "—"}</td>
        <td>{l.source}</td>
        <td onClick={(e) => e.stopPropagation()}>
          <select className="input-inline" value={l.stage}
                  onChange={(e) => onStage(e.target.value)}>
            {stages.map((s) => <option key={s} value={s}>{STAGE_LABELS[s] || s}</option>)}
          </select>
        </td>
        <td className="num">{l.touches ?? 0}</td>
        <td>{l.last_touch ? when(l.last_touch) : "never"}</td>
        <td>{open ? "▾" : "▸"}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7}>
            <form className="lead-touch" onSubmit={onTouch}
                  onClick={(e) => e.stopPropagation()}>
              <select className="input-inline" value={touch.kind}
                      onChange={(e) => setTouch({ ...touch, kind: e.target.value })}>
                {KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <select className="input-inline" value={touch.direction || ""}
                      onChange={(e) => setTouch({ ...touch, direction: e.target.value || null })}>
                <option value="out">out — us to them</option>
                <option value="in">in — they answered</option>
                <option value="">—</option>
              </select>
              <input placeholder="What happened, in a sentence"
                     value={touch.body}
                     onChange={(e) => setTouch({ ...touch, body: e.target.value })} />
              <button className="btn" type="submit">Log it</button>
            </form>
            {!activities ? (
              <p className="empty">Loading the log…</p>
            ) : activities.length === 0 ? (
              <p className="empty">No touches yet. The first email is the first row.</p>
            ) : (
              <ul className="lead-log">
                {activities.map((a) => (
                  <li key={a.id}>
                    <span className="pill muted">{a.kind}{a.direction ? ` · ${a.direction}` : ""}</span>
                    {" "}{a.body || "—"}{" "}
                    <span className="meta">{when(a.at)}{a.created_by ? ` · ${a.created_by}` : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
