import { useCallback, useEffect, useRef, useState } from "react";
import { socket, currentTenant } from "../socket.js";
import { api, clock, compact, duration, money } from "../api.js";
import Waiting from "./Waiting.jsx";
import { Empty, Legend, ScoreBar, SERIES, StatTile } from "./Charts.jsx";

/** Outcome → pill tone. Green is reserved for a genuinely good end state;
 *  an abandoned engagement reading as success is worse than no colour. */
const OUTCOME_TONE = {
  sale: "available",
  no_sale: "neutral",
  handoff: "neutral",
  abandoned: "neutral",
};

const RANGES = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
];

/**
 * The store floor, live.
 *
 * Two data sources with different jobs: the socket carries presence (who is
 * on the floor right now, who is mid-engagement), and the API carries
 * everything that must survive a redeploy. Presence is genuinely ephemeral —
 * if the server restarts, nobody is registered, and that is the truth.
 */
export default function ManagerDashboard({ user }) {
  const [days, setDays] = useState(1);
  const [data, setData] = useState({ summary: null, board: null, engagements: [], voice: null, requests: null });
  const [roster, setRoster] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const registered = useRef(false);

  /**
   * Which retailer's floor we're looking at.
   *
   * A manager or client admin is pinned to their own tenant and this is just
   * their slug. CueSea staff belong to no tenant, so they have to pick one — the
   * API refuses an unscoped request rather than guessing, which is correct,
   * and the UI has to offer the choice rather than firing requests that
   * cannot succeed.
   */
  const isCueStaff = user.role === "cue_admin";
  const [tenant, setTenant] = useState(user.tenant_slug || null);
  const [tenantOptions, setTenantOptions] = useState([]);

  useEffect(() => {
    if (!isCueStaff) return;
    api.tenants()
      .then(({ tenants }) => {
        setTenantOptions(tenants);
        // One tenant is not a choice; don't make them click it.
        if (tenants.length === 1) setTenant(tenants[0].slug);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [isCueStaff]);

  const load = useCallback(async () => {
    if (isCueStaff && !tenant) return;   // nothing to ask for yet
    try {
      const [summary, board, engagements, voice, requests] = await Promise.all([
        api.summary(days, tenant), api.leaderboard(days, tenant),
        api.engagements(15, tenant), api.voice(15, tenant), api.requests(days, tenant),
      ]);
      setData({ summary, board, engagements: engagements.engagements, voice, requests });
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [days, tenant, isCueStaff]);

  useEffect(() => { void load(); }, [load]);

  // Refresh when the floor does something, rather than polling on a timer —
  // a quiet store shouldn't generate traffic, and a busy one updates at once.
  useEffect(() => {
    if (!registered.current) {
      socket.emit("register", { role: "dashboard", tenant: currentTenant() });
      registered.current = true;
    }
    const onUpdate = (snap) => {
      setRoster(snap.associates || []);
      void load();
    };
    socket.on("dashboard:update", onUpdate);
    return () => socket.off("dashboard:update", onUpdate);
  }, [load]);

  const s = data.summary;
  const rows = data.board?.rows || [];
  const maxScore = Math.max(1, ...rows.map((r) => r.score));
  const weights = data.board?.weights || {};

  const parts = (r) => ({
    sales: (r.sale_cents / 100) * (weights.sale_dollars ?? 1),
    engagements: r.engagements * (weights.engagement ?? 10),
    assists: r.assists * (weights.assist ?? 25),
  });

  if (loading) return <div className="empty">Loading the floor…</div>;

  // CueSea staff with no tenant chosen yet. Ask, rather than render nothing.
  if (isCueStaff && !tenant) {
    return (
      <div className="grid grid-dashboard">
        <div className="card span-12">
          <h3>Choose a store</h3>
          <p className="card-note">
            You're signed in as CueSea staff, so you aren't scoped to one retailer.
            Pick whose floor to look at.
          </p>
          {error && <div className="signin-error" role="alert">{error}</div>}
          <div className="btn-row">
            {tenantOptions.length === 0 && !error && (
              <Empty>No tenants exist yet.</Empty>
            )}
            {tenantOptions.map((t) => (
              <button key={t.slug} className="tenant-pick" onClick={() => {
                setLoading(true);
                setTenant(t.slug);
              }}>
                {t.name}
                <span className="meta"> · {t.slug}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // An API error must not blank the page. Before this guard, a failed summary
  // left `s` null and the first stat tile threw — which is exactly what a
  // signed-in cue_admin hit, because their unscoped request is refused.
  if (!s) {
    return (
      <div className="grid grid-dashboard">
        <div className="card span-12">
          <h3>Floor unavailable</h3>
          <div className="signin-error" role="alert">
            {error || "The dashboard couldn't load. Try again in a moment."}
          </div>
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button className="tenant-pick" onClick={() => { setLoading(true); void load(); }}>
              Retry
            </button>
            {isCueStaff && (
              <button className="tenant-pick" onClick={() => setTenant(null)}>
                Choose another store
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-dashboard">
      <div className="range-row span-12">
        <div className="view-switch">
          {RANGES.map((r) => (
            <button key={r.days} className={days === r.days ? "active" : ""}
                    onClick={() => setDays(r.days)}>
              {r.label}
            </button>
          ))}
        </div>
        <span className="meta">
          {tenant || "—"} · signed in as {user.name}
          {isCueStaff && (
            <button className="linkish" style={{ marginLeft: 10 }}
                    onClick={() => setTenant(null)}>switch store</button>
          )}
        </span>
      </div>

      {error && (
        <div className="card span-12 signin-error" role="alert">
          {error}
        </div>
      )}

      {/* Stat tiles. Value in text tokens, no colour encoding — there is no
          series here to identify. */}
      <StatTile label="Guests helped" value={compact(s.engagements)}
                sub={`${s.associates_active} associate${s.associates_active === 1 ? "" : "s"} active`} />
      <StatTile label="Attributed sales" value={money(s.sale_cents)}
                sub={`${s.sales} closed`} />
      <StatTile label="Assists" value={compact(s.assists)}
                sub="helping someone else's guest" />
      <StatTile label="Questions asked" value={compact(s.voice.total)}
                sub={s.voice.total
                  ? `${Math.round((s.voice.ok / s.voice.total) * 100)}% answered · ${s.voice.avg_latency_ms}ms`
                  : "no voice queries yet"} />

      {/* --- what is waiting, before anything measured ---------------------
           Above the roster on purpose: who is on the floor is context, what a
           guest is standing in a fitting room waiting for is the job. */}
      <Waiting rows={data.requests?.waiting || []} demand={data.requests?.demand || []} />

      {/* --- floor roster: socket, live ---------------------------------- */}
      <div className="card span-4">
        <h3>On the floor now</h3>
        <div className="row-list">
          {roster.length === 0 && (
            <Empty>Nobody is connected. Associates appear here when the plugin is running.</Empty>
          )}
          {roster.map((a) => (
            <div className="row" key={a.id}>
              <div>{a.name} <span className="meta">· {a.zone}</span></div>
              <span className={`pill ${a.status}`}>{a.status}</span>
            </div>
          ))}
        </div>
      </div>

      {/* --- leaderboard --------------------------------------------------- */}
      <div className="card span-8">
        <div className="card-head">
          <h3>Leaderboard</h3>
          <Legend keys={["sales", "engagements", "assists"]} />
        </div>
        <p className="card-note">
          Score combines sales, guests helped, and assists — assists count for
          {" "}{weights.assist ?? 25} points each, so covering someone else's guest is worth doing.
        </p>
        <div className="row-list">
          {rows.length === 0 && <Empty>No activity in this period yet.</Empty>}
          {rows.map((r) => (
            <div className="lb-row" key={r.user_id}>
              <div className="lb-name">
                <span className="lb-rank">{r.rank}</span>
                {r.name}
              </div>
              <ScoreBar parts={parts(r)} max={maxScore} total={r.score} />
              <div className="lb-detail meta">
                {r.engagements} guests · {money(r.sale_cents)} · {r.assists} assists
                {r.voice_queries > 0 && ` · ${r.voice_queries} questions`}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* --- recent engagements ------------------------------------------- */}
      <div className="card span-6">
        <h3>Recent guests</h3>
        <div className="row-list">
          {data.engagements.length === 0 && <Empty>No engagements recorded yet.</Empty>}
          {data.engagements.map((e) => (
            <div className="engagement" key={e.id}>
            <div className="row">
              <div>
                {e.associate || (
                  /* Say why, not just that. "Unattributed" reads as a bug;
                     the actual cause is a pair of glasses nobody has been
                     assigned to, and that is fixable in a few seconds. */
                  <span className="meta" title="The glasses that recorded this aren't assigned to anyone">
                    unassigned device
                  </span>
                )}
                <span className="meta"> · {e.zone || "floor"}</span>
              </div>
              <div className="row-right">
                {e.sale_cents > 0 && <span className="amount">{money(e.sale_cents)}</span>}
                <span className={`pill ${e.ended_at ? (OUTCOME_TONE[e.outcome] || "neutral") : "engaged"}`}>
                  {e.ended_at ? (e.outcome || "closed").replace("_", " ") : "live"}
                </span>
                <span className="meta">{clock(e.started_at)}</span>
              </div>
            </div>
            {/* What the glasses actually said, and what they offered. Without
                this the row records that an engagement happened and nothing
                about whether the cue was any good — which is the only
                question a pilot has to answer. */}
            {(e.cue_lines || []).filter(Boolean).length > 0 && (
              <div className="cue-said">
                {e.cue_lines.filter(Boolean).map((line, i) => (
                  <div key={i} className={i === 0 ? "cue-said-lead" : ""}>{line}</div>
                ))}
              </div>
            )}
            {(e.recommendations || []).length > 0 && (
              <div className="recs">
                {e.recommendations.slice(0, 3).map((r) => (
                  <span className="rec" key={r.sku || r.name}>
                    {r.name}
                    {typeof r.price === "number" && <em> {money(Math.round(r.price * 100))}</em>}
                    {r.location && <em> · {r.location}</em>}
                  </span>
                ))}
                {e.recommendations.length > 3 && (
                  <span className="meta">+{e.recommendations.length - 3} more</span>
                )}
              </div>
            )}
          </div>
          ))}
        </div>
      </div>

      {/* --- voice log ----------------------------------------------------- */}
      <div className="card span-6">
        <div className="card-head">
          <h3>Questions from the floor</h3>
          {data.voice && !data.voice.transcripts_stored && (
            <span className="meta" title="tenant privacy setting">transcripts off</span>
          )}
        </div>
        <div className="row-list">
          {(data.voice?.voice || []).length === 0 && <Empty>No voice queries yet.</Empty>}
          {(data.voice?.voice || []).map((v) => (
            <div className="qa" key={v.id}>
              <div className="row">
                <div>
                  {/* Withheld by default — say so rather than showing a blank. */}
                  {v.transcript
                    ? <span className="quote">“{v.transcript}”</span>
                    : <span className="meta">
                        {v.ok ? (v.intent || "question") : "not understood"} · transcript not stored
                      </span>}
                  {v.associate && <span className="meta"> · {v.associate}</span>}
                </div>
                <div className="row-right">
                  <span className={`pill ${v.ok ? "neutral" : "warnpill"}`}>
                    {v.ok ? v.intent || "answered" : "missed"}
                  </span>
                  <span className="meta">{v.latency_ms ? `${v.latency_ms}ms` : ""}</span>
                </div>
              </div>
              {/* The answer is the half that says whether CueSea was any good.
                  A question with no answer beside it cannot be judged — you
                  can see the floor asked about stock, but not whether we told
                  them something true. */}
              {v.answer && <div className="qa-answer">{v.answer}</div>}
            </div>
          ))}
        </div>
      </div>

      <div className="card span-12 footnote meta">
        Average engagement {duration(s.avg_engagement_seconds)} ·
        {" "}{s.voice.stt_seconds.toFixed(1)}s of audio transcribed in this period
      </div>
    </div>
  );
}
