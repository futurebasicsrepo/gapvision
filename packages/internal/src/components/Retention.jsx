import { useEffect, useState } from "react";
import { api, ApiError, when } from "../api.js";

/**
 * Retention — the window, and what the last sweep actually deleted.
 *
 * The Health panel hard-codes retention to warn, and that warn is honest:
 * days are stored, and a number you can set that nothing acts on is worse
 * than a number you cannot set. But a warn with nowhere to go is a dead end.
 * This is where it goes.
 *
 * Never-swept sorts to the top, because that is the row that matters and a
 * table sorted by newest hides it. The service orders it that way; this does
 * not re-sort.
 *
 * "Nothing to redact" is not the same as "has not run", and the panel refuses
 * to collapse them: a sweep that deleted zero rows is a working control on a
 * quiet store, and a store that has never been swept is an unproven one.
 */
export default function Retention() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [sweeping, setSweeping] = useState(false);
  const [result, setResult] = useState(null);

  function load() {
    api.retention()
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }
  useEffect(load, []);

  async function sweep() {
    if (!window.confirm(
      "Sweep every tenant now?\n\n" +
      "This permanently redacts personal data older than each store's own " +
      "window. It cannot be undone. The operational skeleton — intent, " +
      "latency, zone, outcome, sale — survives, so this does not cost a " +
      "retailer their quarter."
    )) return;
    setSweeping(true); setResult(null);
    try {
      const r = await api.runRetention();
      setResult(r);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSweeping(false);
    }
  }

  if (error && !data) return <div className="card span-12"><p className="empty">{error}</p></div>;
  if (!data) return <div className="card span-12"><p className="empty">Loading retention…</p></div>;

  const rows = data.tenants || [];
  const never = rows.filter((r) => !r.last_run).length;

  return (
    <div className="card span-12">
      <div className="card-head">
        <h2>Retention</h2>
        <button className="btn small" onClick={sweep} disabled={sweeping}>
          {sweeping ? "sweeping…" : "Sweep now"}
        </button>
      </div>
      <p className="card-note">
        Aged personal data is redacted on a timer, per tenant, on that tenant's
        own window — transcripts, answers, the CRM pointer, cue lines,
        recommendations, assist notes. The operational skeleton is kept
        deliberately, so turning the control on does not cost a retailer their
        quarter. Default is {data.default_days} days.
        {never > 0 && ` ${never} of ${rows.length} stores have never been swept.`}
      </p>

      {error && <p className="empty">{error}</p>}
      {result && (
        <p className="card-note">
          Swept {result.runs?.length ?? 0} {result.runs?.length === 1 ? "store" : "stores"} ·{" "}
          {result.redacted} {result.redacted === 1 ? "row" : "rows"} redacted.
          {result.redacted === 0 && " Nothing was old enough — the control ran and had nothing to do."}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="empty">No active tenants.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Store</th><th className="num">Window</th><th>Last sweep</th>
              <th className="num">Voice</th><th className="num">Engagements</th>
              <th className="num">Assists</th><th className="num">Requests</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const swept = !!t.last_run;
              const backlog = !!t.more_remaining;
              return (
                <tr key={t.slug}>
                  <td>{t.name || t.slug}<span className="meta"> · {t.slug}</span></td>
                  <td className="num">{t.retention_days}d</td>
                  <td>{swept
                    ? <span className="meta">{when(t.last_run)}</span>
                    : <span className="pill hot">never</span>}</td>
                  <td className="num">{swept ? (t.voice_redacted || 0) : "—"}</td>
                  <td className="num">{swept ? (t.engagements_redacted || 0) : "—"}</td>
                  <td className="num">{swept ? (t.assists_redacted || 0) : "—"}</td>
                  <td className="num">{swept ? (t.requests_redacted || 0) : "—"}</td>
                  <td>
                    {!swept ? <span className="meta">unproven</span>
                      : backlog ? <span className="pill hot">more to do</span>
                      : <span className="meta">clear</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
