import { useEffect, useState } from "react";
import { api, ApiError, when } from "../api.js";

/**
 * Plates — every printed door, and the one control that matters.
 *
 * A printed code is a bearer credential. Tokens made the plate URL opaque and
 * revocable, and revocation is the difference between an incident and an
 * errand — but until now it was reachable only by API call, which means in
 * practice it was reachable by nobody at 6pm on a Saturday.
 *
 * `hits_last_hour` is the shared-token signal, and the service is careful to
 * say it is not an alarm: a fitting room is busy on a Saturday. A fitting room
 * is not busy at three in the morning. So busy rows are flame — the one thing
 * in this region asking to be looked at — and never presented as a failure.
 *
 * Revoking kills ONE door. The tag six inches above the QR is still fine, and
 * disabling it would cost a store its fitting room for no reason.
 */
export default function Plates() {
  const [tenants, setTenants] = useState([]);
  const [slug, setSlug] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busyToken, setBusyToken] = useState(null);

  useEffect(() => {
    api.tenants()
      .then((r) => {
        const list = r.tenants || [];
        setTenants(list);
        if (list.length && !slug) setSlug(list[0].slug);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, []);

  function load(s) {
    if (!s) return;
    setError(null);
    api.plates(s)
      .then(setData)
      .catch((e) => { setData(null); setError(e instanceof ApiError ? e.message : String(e)); });
  }

  useEffect(() => { load(slug); }, [slug]);

  async function revoke(token, zone, source) {
    if (!window.confirm(
      `Revoke the ${source} door on ${zone}?\n\n` +
      `That token stops resolving immediately and cannot be un-revoked — the ` +
      `plate has to be reprinted. The other door on the same plate is unaffected.`
    )) return;
    setBusyToken(token);
    try {
      await api.revokePlate(slug, token);
      load(slug);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusyToken(null);
    }
  }

  if (error && !data) return <div className="card span-12"><p className="empty">{error}</p></div>;
  if (!data) return <div className="card span-12"><p className="empty">Loading plates…</p></div>;

  const rows = data.plates || [];
  const live = rows.filter((r) => !r.revoked_at);
  const busy = new Set(data.busy || []);

  return (
    <>
      <div className="card span-12">
        <div className="card-head">
          <h2>Plates</h2>
          {tenants.length > 1 && (
            <select className="input-inline" value={slug} onChange={(e) => setSlug(e.target.value)}>
              {tenants.map((t) => <option key={t.slug} value={t.slug}>{t.name || t.slug}</option>)}
            </select>
          )}
        </div>
        <p className="card-note">
          {live.length} live {live.length === 1 ? "door" : "doors"} of {rows.length}.
          Busy is more than {data.busy_over} taps in an hour — a signal, not an alarm.
          A fitting room is busy on a Saturday; a fitting room is not busy at three in the morning.
        </p>
        {error && <p className="empty">{error}</p>}

        {rows.length === 0 ? (
          <p className="empty">
            No plates registered for this store yet. Printed artwork ships with a
            register.json; until it is posted the printed tokens resolve to nothing,
            which is the right failure.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Zone</th><th>Door</th><th>Token</th>
                <th className="num">Last hour</th><th className="num">Refused 24h</th>
                <th>State</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const dead = !!p.revoked_at;
                const hot = !dead && busy.has(p.token);
                return (
                  <tr key={p.token} className={dead ? "row-muted" : ""}>
                    <td>{p.zone}{p.label ? <span className="machine"> · {p.label}</span> : null}</td>
                    <td><span className="pill muted">{p.source}</span></td>
                    <td className="ident">{p.token}</td>
                    <td className={"num" + (hot ? " hot" : "")}>{p.hits_last_hour || 0}</td>
                    <td className="num">{p.refused_today || 0}</td>
                    <td>
                      {dead
                        ? <span className="machine">revoked {when(p.revoked_at)}</span>
                        : hot
                          ? <span className="pill hot">busy</span>
                          : <span className="machine">live</span>}
                    </td>
                    <td className="right">
                      {!dead && (
                        <button className="btn small" disabled={busyToken === p.token}
                                onClick={() => revoke(p.token, p.zone, p.source)}>
                          {busyToken === p.token ? "revoking…" : "Revoke"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
