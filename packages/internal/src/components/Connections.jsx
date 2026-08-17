import { useEffect, useState } from "react";
import { api } from "../api.js";

/**
 * Connections — everything a store is plugged into, in one screen.
 *
 * Two halves, because a retailer's IT director asks two questions and they are
 * not the same one:
 *
 *   **Systems** — where the answers come from. Without one of these the
 *   product cannot say anything true, which makes this half the gate on
 *   whether a pilot can start at all.
 *
 *   **Peripherals** — where the answers show up. Glasses, phones, a browser
 *   tab. This half decides who sees it.
 *
 * ── The rule this panel keeps ────────────────────────────────────────────
 *
 * **A connector that is not built says so, in the same list, in the same
 * words.**
 *
 * The ordinary integrations page is a wall of logos with Connect buttons, most
 * of which open a form that files a feature request. That is a lie told at the
 * exact moment a buyer is deciding whether to trust the product — the most
 * expensive possible moment to be caught in one, and the same reasoning behind
 * the customer deck's known-edges section.
 *
 * So `planned` and `exploring` rows are not greyed-out teases. They carry what
 * the thing would give you and what it would take, and they have no button,
 * because a button that does nothing is the lie in miniature. The server
 * decides these states from the adapter registry rather than from a literal
 * (`connections._state_of`), so this panel cannot claim a connector exists by
 * asserting that it does.
 *
 * ── Why the summary leads with "answering" ───────────────────────────────
 *
 * A store with a connected system and nothing live on the floor is a store
 * where nobody is being helped, and that state is invisible on a panel that
 * only counts connections. It is also the most common way a pilot quietly
 * dies. So it is the first number.
 */

const STATE = {
  connected: { label: "connected", cls: "on" },
  available: { label: "ready to connect", cls: "" },
  planned: { label: "not built yet", cls: "muted" },
  exploring: { label: "researched, not decided", cls: "muted" },
};

const KINDS = {
  commerce: "Commerce",
  crm: "CRM",
  feed: "Feed",
  custom: "Custom",
  glasses: "Glasses",
  mobile: "Mobile",
  simulator: "Simulator",
};

const ago = (iso) => {
  if (!iso) return null;
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 90) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
  return `${Math.round(secs / 86400)} d ago`;
};

function System({ s }) {
  const state = STATE[s.state] || STATE.planned;
  const scopesMissing = s.missing_required_scopes?.length > 0;
  const degraded = Object.entries(s.degraded_without || {});

  return (
    <li className="conn">
      <div className="conn-head">
        <span className="conn-name">{s.name}</span>
        <span className={`tag ${state.cls}`}>{state.label}</span>
        <span className="conn-kind">{KINDS[s.kind] || s.kind}</span>
      </div>

      {s.state === "connected" && (
        <div className="conn-live">
          <span className="ident">{s.detail}</span>
          {/* A connection that was fine an hour ago and has not been checked
              since is not the same as one that is fine. The last test and its
              outcome are the only honest way to say which. */}
          {s.last_tested_at && (
            <span className={s.last_test_ok ? "meta" : "meta flame"}>
              {s.last_test_ok ? "last check passed" : "last check failed"} · {ago(s.last_tested_at)}
            </span>
          )}
          {!s.last_tested_at && <span className="meta muted">never tested</span>}
        </div>
      )}

      {scopesMissing && (
        <p className="conn-warn">
          Missing permissions: {s.missing_required_scopes.join(", ")}. Parts of
          this connection will fail until they are granted.
        </p>
      )}
      {degraded.length > 0 && (
        <p className="meta muted">
          Working, with less: {degraded.map(([scope, why]) => why).join("; ")}.
        </p>
      )}

      <ul className="conn-gives">
        {(s.gives || []).map((g) => <li key={g}>{g}</li>)}
      </ul>
      {s.note && <p className="conn-note">{s.note}</p>}
    </li>
  );
}

function Peripheral({ p }) {
  // "None set up" and "set up and silent" are different sentences, and only one
  // of them is a fault. The answer engine keeps the same distinction between
  // empty and unreachable; a fleet panel that flattens them tells a manager
  // their floor is fine when it is not.
  const silent = p.devices > 0 && p.active === 0;

  return (
    <li className="conn">
      <div className="conn-head">
        <span className="conn-name">{p.name}</span>
        {p.devices === 0
          ? <span className="tag muted">none set up</span>
          : silent
            ? <span className="tag flame">none answering</span>
            : <span className="tag on">{p.active} on the floor</span>}
        <span className="conn-kind">{KINDS[p.kind] || p.kind}</span>
      </div>

      {p.devices > 0 && (
        <div className="conn-live">
          <span className="meta">
            {p.devices} set up{p.revoked > 0 ? ` · ${p.revoked} revoked` : ""}
          </span>
          {p.last_seen
            ? <span className="meta muted">last heard from {ago(p.last_seen)}</span>
            : <span className="meta muted">never used</span>}
        </div>
      )}
      {p.note && <p className="conn-note">{p.note}</p>}
    </li>
  );
}

export default function Connections() {
  const [tenants, setTenants] = useState([]);
  const [slug, setSlug] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.tenants()
      .then((r) => {
        const list = r.tenants || [];
        setTenants(list);
        setSlug((s) => s || list[0]?.slug || null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!slug) return;
    setError(null);
    api.connections(slug)
      // Normalised on arrival, not trusted. A deployment where the endpoint
      // exists but is older answers 200 with a body that is nearly right, and
      // `data.systems.map` on an absent key takes the whole console down —
      // not just this panel, the rail with it. The shape a component renders
      // should never be the shape a server happened to send.
      .then((r) => setData({
        tenant: r?.tenant || slug,
        systems: Array.isArray(r?.systems) ? r.systems : [],
        peripherals: Array.isArray(r?.peripherals) ? r.peripherals : [],
        summary: r?.summary || null,
      }))
      .catch((e) => {
        // Console and the AI service deploy on separate pushes, so one being
        // ahead of the other is a real state for as long as a merge takes.
        // Named as absent rather than reported as empty — "nothing connected"
        // and "we cannot tell" are different sentences, and an internal tool
        // that invents the first gets it quoted in a meeting.
        setData(null);
        setError(/404|not found/i.test(e.message)
          ? "No connections endpoint on this deployment yet."
          : e.message);
      });
  }, [slug]);

  if (loading) return <div className="empty">Loading…</div>;

  const s = data?.summary;

  return (
    <div className="connections">
      <div className="card span-12">
        <div className="card-head">
          <h2>Connections</h2>
          {tenants.length > 1 && (
            <select value={slug || ""} onChange={(e) => setSlug(e.target.value)}>
              {tenants.map((t) => (
                <option key={t.slug} value={t.slug}>{t.name || t.slug}</option>
              ))}
            </select>
          )}
        </div>

        {error && <p className="empty">{error}</p>}

        {s && (
          <div className="conn-summary">
            {/* First, deliberately. A shop with a live system and nothing on
                the floor is a shop where nobody is being helped, and that is
                the most common way a pilot dies quietly. */}
            <div className="stat">
              <span className="stat-value">{s.answering}</span>
              <span className="stat-label">answering right now</span>
            </div>
            <div className="stat">
              <span className="stat-value">{s.devices}</span>
              <span className="stat-label">devices set up</span>
            </div>
            <div className="stat">
              <span className="stat-value">{s.systems_connected}</span>
              <span className="stat-label">systems connected</span>
            </div>
          </div>
        )}
      </div>

      {data && data.systems.length === 0 && data.peripherals.length === 0 && !error && (
        <p className="empty">
          This deployment answered, but told us nothing about connections — it is
          probably running an older build. Not the same as nothing being connected.
        </p>
      )}

      {data && (data.systems.length > 0 || data.peripherals.length > 0) && (
        <>
          <div className="card span-12">
            <h3>Systems — where the answers come from</h3>
            <p className="card-note">
              Without one of these the product has nothing true to say. Rows that
              are not built say so and say what they would take; there is no
              button on them, because a button that files a feature request is
              the thing this panel refuses to be.
            </p>
            <ul className="conn-list">
              {data.systems.map((x) => <System key={x.id} s={x} />)}
            </ul>
          </div>

          <div className="card span-12">
            <h3>Peripherals — where they show up</h3>
            <p className="card-note">
              Counted from the fleet itself, not from a setting. A surface that
              is set up and silent is the failure worth seeing, so it is named
              differently from one that was never set up. Pair and revoke
              devices under <strong>Tenants</strong>.
            </p>
            <ul className="conn-list">
              {data.peripherals.map((x) => <Peripheral key={x.id} p={x} />)}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
