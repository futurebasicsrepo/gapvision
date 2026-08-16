import { useCallback, useEffect, useState } from "react";
import { api, probe, compact, when } from "../api.js";

/**
 * Platform health.
 *
 * Two sources, deliberately kept apart:
 *
 *   · `/api/admin/platform` — what the AI service can see about itself and the
 *     database. Authenticated, cross-tenant, CueSea staff only.
 *   · direct probes from this browser — whether each service answers *from
 *     where a person sits*. A service can be healthy from inside Railway and
 *     unreachable from a store's wifi, and only the second one matters.
 *
 * Every check reports ok / warn / fail / unknown, and unknown is never
 * rendered as a pass. That distinction is the whole point: the first
 * production deploy reported a healthy database that had no schema in it.
 */

const REALTIME = import.meta.env.VITE_SERVER_URL || "https://realtime-production-80f4.up.railway.app";

const SURFACES = [
  { name: "Studio", url: "https://app.cuesea.ai", note: "retailer back office" },
  { name: "Lens", url: "https://cuesea-lens.vercel.app", note: "sideloaded to the G2" },
];

function Check({ status, label, detail }) {
  return (
    <div className={`check ${status}`}>
      <span className="check-dot" />
      <span className="check-label">{label}</span>
      <span className="check-detail">{detail}</span>
    </div>
  );
}

export default function Health() {
  const [platform, setPlatform] = useState(null);
  const [probes, setProbes] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(true);

  // The mail row can only ever say whether three variables are set. Proving a
  // password is right takes sending something, so that lives behind a button
  // rather than in the poll — a health check that mails somebody every sixty
  // seconds is not a health check.
  const [mail, setMail] = useState(null);
  const [mailBusy, setMailBusy] = useState(false);

  // Same reason as the mail test, one layer down. Health reports which
  // provider *resolved at boot* — that proves an environment variable is set
  // and nothing else. An invalid key constructs a provider happily and fails
  // only when somebody speaks into the glasses.
  const [prov, setProv] = useState(null);
  const [provBusy, setProvBusy] = useState(false);

  const testProviders = useCallback(() => {
    setProvBusy(true);
    setProv(null);
    api.providersTest()
      .then(setProv)
      .catch((e) => setProv({ ok: false, results: [{ key: "err", label: "Test", status: "fail", detail: e.message }] }))
      .finally(() => setProvBusy(false));
  }, []);

  const testMail = useCallback(() => {
    setMailBusy(true);
    setMail(null);
    api.mailTest()
      .then(setMail)
      .catch((e) => setMail({ ok: false, detail: e.message }))
      .finally(() => setMailBusy(false));
  }, []);

  const load = useCallback(() => {
    setBusy(true);
    setError(null);

    // Deliberately not awaited together. The two halves answer different
    // questions and fail independently — a slow probe of a static site must
    // never hold up the platform state, and vice versa. Each renders the
    // moment it has something to say.
    api.platform()
      .then(setPlatform)
      .catch((e) => { setError(e.message); setPlatform(null); })
      .finally(() => setBusy(false));

    Promise.all([
      // Relayed by the realtime server: the AI service keeps a CORS allowlist,
      // so probing it straight from this origin would report a healthy service
      // as unreachable.
      probe("AI service", `${REALTIME}/health/ai`),
      probe("Realtime", `${REALTIME}/health`),
      // Static frontends can't be read cross-origin; reachability is the only
      // honest question to ask them from here.
      ...SURFACES.map((s) => probe(s.name, s.url, { opaque: true })),
    ]).then(setProbes);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Poll while the tab is visible. A console left open on a spare monitor
  // shouldn't keep hitting the API all weekend.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const counts = platform?.counts || {};
  const svc = platform?.service || {};
  // Fleet state, and the difference between "nothing is wrong" and "nothing is
  // being reported". `enabled_tenants` is the whole distinction: with no tenant
  // measuring, an empty low-battery list is not a healthy fleet, and rendering
  // it as one is the mistake the first production deploy made about a database
  // with no schema in it.
  const fleet = platform?.fleet || {};
  const enabledTenants = fleet.enabled_tenants || [];
  const fleetKnown = !fleet.error && enabledTenants.length > 0;
  const lowBattery = fleet.low_battery || [];
  const dropping = fleet.dropping || [];
  const openShifts = fleet.open_shifts || {};
  const arrivals = fleet.arrivals || {};
  const suspectArrivals =
    (arrivals.late_unbuffered || 0) + (arrivals.clocks_ahead || 0) > 0;
  const checks = platform?.checks || [];
  const worst = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "warn") ? "warn" : "ok";

  return (
    <div className="grid grid-12">
      <div className="card span-12">
        <div className="card-head">
          <h3>Platform</h3>
          <div className="btn-row">
            <span className="machine">
              {platform ? `checked ${when(platform.checked_at)}` : busy ? "checking…" : "—"}
            </span>
            <button className="btn small" onClick={load} disabled={busy}>Re-check</button>
          </div>
        </div>

        {error && (
          <div className="notice error" style={{ marginBottom: 14 }}>
            Couldn't read platform state: {error}
          </div>
        )}

        <p className="card-note">
          {worst === "ok" && !error
            ? "Everything asserted below is passing. These check what features actually need — a schema with tables in it, an account that can sign in — not just whether a socket opens."
            : "Rows in flame need attention. A row in grey could not be checked at all, which is not the same as passing."}
        </p>

        <div className="checks">
          {checks.map((c) => (
            <Check key={c.key} status={c.status} label={c.label} detail={c.detail} />
          ))}
          {!checks.length && !busy && <div className="empty">No checks returned.</div>}
        </div>

        {checks.some((c) => c.key === "mail") && (
          <div className="notice" style={{ marginTop: 14 }}>
            <div className="btn-row" style={{ justifyContent: "space-between" }}>
              <span className="meta">
                The mail row above reports configuration, not delivery — a wrong
                password looks exactly like a right one until something is sent.
              </span>
              <button className="btn small" onClick={testMail} disabled={mailBusy}>
                {mailBusy ? "Sending…" : "Send a test"}
              </button>
            </div>
            {mail && (
              <p className={`card-note ${mail.ok ? "" : "error"}`} style={{ marginTop: 10 }}>
                {mail.ok ? "Sent. " : "Didn't send. "}{mail.detail}
                {mail.error ? ` (${mail.error})` : ""}
              </p>
            )}
          </div>
        )}
      </div>

      {/* --- reachability from this browser --- */}
      <div className="card span-6">
        <h3>Reachable from here</h3>
        <p className="card-note">
          Probed from your browser, not from inside the platform — this is the
          view a store gets.
        </p>
        <div className="checks">
          {probes.map((p) => (
            <Check
              key={p.name}
              status={p.ok ? "ok" : "fail"}
              label={p.name}
              detail={
                p.ok
                  ? `${p.opaque ? "served" : p.status} · ${p.ms}ms`
                  : p.error || `HTTP ${p.status}`
              }
            />
          ))}
          {!probes.length && <div className="empty">Probing…</div>}
        </div>
      </div>

      {/* --- build --- */}
      <div className="card span-6">
        <h3>Deployed</h3>
        <p className="card-note">
          Which providers the AI service actually resolved at boot, not which
          ones are configured.
        </p>
        <div className="checks">
          <Check
            status={svc.stt_provider && svc.stt_provider !== "mock" ? "ok" : "warn"}
            label="Speech-to-text"
            detail={svc.stt_provider || "unknown"}
          />
          <Check
            status={svc.llm_provider && svc.llm_provider !== "mock" ? "ok" : "warn"}
            label="Language model"
            detail={svc.llm_provider || "unknown"}
          />
          <Check
            status={svc.commit ? "ok" : "unknown"}
            label="Commit"
            detail={svc.commit || "not reported"}
          />
          <Check
            status="unknown"
            label="Environment"
            detail={svc.environment || "—"}
          />
        </div>

        <div className="notice" style={{ marginTop: 14 }}>
          <div className="btn-row" style={{ justifyContent: "space-between" }}>
            <span className="meta">
              These name the provider that resolved at boot, not a credential
              that works. Rotating a key leaves this unchanged either way.
            </span>
            <button className="btn small" onClick={testProviders} disabled={provBusy}>
              {provBusy ? "Calling…" : "Call each vendor"}
            </button>
          </div>
          {prov && (
            <div className="checks" style={{ marginTop: 10 }}>
              {prov.results.map((r) => (
                <Check key={r.key} status={r.status} label={r.label} detail={r.detail} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* --- the glasses themselves ---
          A pair that goes flat at 3pm every day currently reads on a
          leaderboard as an associate who stops working after lunch, and the
          person it happens to has no way to prove otherwise. This is where
          that becomes visible.

          Serials, percentages and counts are machine values and take the mono
          face. Nothing here is `fail`: every row is either a pair that wants
          charging or a pair that keeps dropping, and one region full of flame
          is a region nobody reads. Unknown stays slate and dashed — a fleet
          nobody is reporting is not a fleet in perfect health. */}
      <div className="card span-6">
        <h3>Glasses</h3>
        <p className="card-note">
          Battery and connection, reported by the phone the Lens runs on. Only
          for stores that have switched shift telemetry on — it measures staff,
          so it is off until a retailer says otherwise.
        </p>
        <div className="checks">
          {!fleetKnown && (
            <Check
              status="unknown"
              label="Nothing reporting"
              detail={
                fleet.error
                  ? fleet.error
                  : "no tenant has shift telemetry on — this is not a healthy fleet, it is no fleet"
              }
            />
          )}
          {fleetKnown && !lowBattery.length && !dropping.length && (
            <Check
              status="ok"
              label="Every pair is charged and connected"
              detail={
                <span className="machine">
                  {enabledTenants.length} tenant(s) · above {fleet.low_battery_percent}%
                </span>
              }
            />
          )}
          {lowBattery.map((d) => (
            <Check
              key={`battery-${d.tenant}-${d.serial}`}
              status="warn"
              label={<span className="machine">{d.serial}</span>}
              detail={
                <>
                  <span className="machine">{d.battery_percent}%</span>
                  {" · "}
                  {d.assigned_to || "unassigned"}
                  {" · "}
                  <span className="machine">{d.tenant}</span>
                  {" · "}
                  {when(d.reported_at)}
                </>
              }
            />
          ))}
          {dropping.map((d) => (
            <Check
              key={`drops-${d.tenant}-${d.serial}`}
              status="warn"
              label={<span className="machine">{d.serial}</span>}
              detail={
                <>
                  dropped{" "}
                  <span className="machine">{d.disconnects_24h}×</span> in 24h ·{" "}
                  <span className="machine">{d.tenant}</span>
                </>
              }
            />
          ))}
        </div>
      </div>

      {/* --- shifts and the clocks behind them ---
          Two questions a manager's numbers depend on and nobody could ask
          before: is anybody still clocked in, and did today's events actually
          arrive today. */}
      <div className="card span-6">
        <h3>Shifts</h3>
        <p className="card-note">
          A shift with no end has no denominator — every per-hour figure in the
          product divides by these. One that stops sending is closed at its last
          heartbeat, not at the moment somebody noticed.
        </p>
        <div className="checks">
          {!fleetKnown ? (
            <Check
              status="unknown"
              label="No shifts being recorded"
              detail={fleet.error || "no tenant has shift telemetry on"}
            />
          ) : (
            <>
              <Check
                status="ok"
                label="Open right now"
                detail={
                  <>
                    <span className="machine">{openShifts.count ?? 0}</span> across{" "}
                    <span className="machine">{openShifts.tenants ?? 0}</span> tenant(s)
                    {openShifts.oldest_started_at
                      ? <> · oldest since {when(openShifts.oldest_started_at)}</>
                      : null}
                  </>
                }
              />
              <Check
                status="ok"
                label="Closed automatically after"
                detail={
                  <span className="machine">{openShifts.gap_minutes ?? "—"}m silent</span>
                }
              />
              {!arrivals.events ? (
                <Check
                  status="unknown"
                  label="Timestamps arriving on time"
                  detail="no timestamped events in 24h — nothing to judge"
                />
              ) : (
                <Check
                  status={suspectArrivals ? "warn" : "ok"}
                  label="Timestamps arriving on time"
                  detail={
                    <>
                      <span className="machine">{arrivals.events}</span> events ·{" "}
                      <span className="machine">{arrivals.replayed}</span> replayed from a
                      phone's buffer · worst{" "}
                      <span className="machine">{arrivals.worst_delay_seconds}s</span>
                      {suspectArrivals ? (
                        <>
                          {" · "}
                          <span className="machine">{arrivals.late_unbuffered}</span> late
                          without being buffered,{" "}
                          <span className="machine">{arrivals.clocks_ahead}</span> from a
                          clock ahead of ours
                        </>
                      ) : null}
                    </>
                  }
                />
              )}
            </>
          )}
        </div>
        <p className="card-note" style={{ marginTop: 12 }}>
          A replayed event is meant to be late — that is what the phone's buffer
          is for, and counting it as a fault would train everyone to ignore this
          row. Only lateness with no buffer behind it, and clocks running ahead
          of ours, are treated as a problem.
        </p>
      </div>

      {/* --- fleet --- */}
      {[
        ["Tenants", counts.tenants_active, `${counts.tenants_total ?? 0} total`],
        ["People", counts.users_active, `${counts.associates ?? 0} associates`],
        ["Devices", counts.devices, `${counts.devices_seen_24h ?? 0} seen in 24h`],
        ["Engagements 24h", counts.engagements_24h, `${counts.voice_24h ?? 0} voice queries`],
      ].map(([label, value, sub]) => (
        <div className="card span-3" key={label}>
          <div className="stat">
            <span className="stat-label">{label}</span>
            <span className="stat-value">{value === undefined ? "—" : compact(value)}</span>
            <span className="stat-sub">{sub}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
