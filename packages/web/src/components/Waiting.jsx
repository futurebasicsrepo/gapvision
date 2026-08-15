import { duration } from "../api.js";

/**
 * What is waiting on the floor.
 *
 * Presence answers "somebody is in fitting room three". This answers the
 * question that follows it, which is the one the job is made of: what do they
 * need brought to them. An associate who knows a guest is in a room still has
 * to walk over and ask.
 *
 * Oldest first, because somebody standing in a fitting room is the most
 * time-sensitive row in the system — the service orders it that way and this
 * does not re-sort it.
 *
 * The five-minute mark is flame. It is a nudge, not a target: nothing in the
 * product promises a response time, and dressing this as an SLA would invent a
 * commitment the code does not make. It is the one thing in this region asking
 * to be looked at, which is all flame ever means here.
 */
const NUDGE_SECONDS = 300;

const waited = (iso) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));

export default function Waiting({ rows = [], demand = [] }) {
  const open = rows.filter((r) => r.status === "open").length;

  return (
    <>
      <div className="card span-12">
        <div className="card-head">
          <h2>Waiting on the floor</h2>
          <span className="meta">{rows.length === 0 ? "nothing waiting" :
            `${rows.length} open · ${open} unclaimed`}</span>
        </div>
        <p className="card-note">
          Requests a guest raised themselves, oldest first. A request names a
          place and a thing, never a person — “fitting room 3 wants a 32 in the
          barrel jean” is completely actionable and identifies nobody.
        </p>

        {rows.length === 0 ? (
          <p className="empty">
            Nothing waiting. This is the good state — it means every request
            raised in the last few minutes has been picked up.
          </p>
        ) : (
          <ul className="waiting">
            {rows.map((r) => {
              const secs = waited(r.created_at);
              const nudge = secs >= NUDGE_SECONDS;
              return (
                <li key={r.request_id} className={r.status === "claimed" ? "claimed" : ""}>
                  <span className="w-zone">{r.zone || "floor"}</span>
                  <span className="w-need">
                    <b>{[r.product, r.size].filter(Boolean).join(" · ") || r.need}</b>
                    {r.product && r.need ? <small>{r.need}</small> : null}
                  </span>
                  <span className={"w-age" + (nudge ? " nudge" : "")}>{duration(secs)}</span>
                  <span className="w-who">
                    {r.status === "claimed"
                      ? (r.claimed_by ? `${r.claimed_by} is on it` : "claimed")
                      : "unclaimed"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {demand.length > 0 && (
        <div className="card span-12">
          <div className="card-head"><h2>What the floor gets asked for</h2></div>
          <p className="card-note">
            Kept when the retention sweep runs, deliberately: what people ask
            for and how long they wait is a question about a shop, not about a
            shopper. No guest pointer and no free text survives here.
          </p>
          <table className="demand">
            <thead>
              <tr>
                <th>Asked for</th><th>Need</th>
                <th className="num">Asks</th><th className="num">Fulfilled</th>
                <th className="num">Avg pickup</th>
              </tr>
            </thead>
            <tbody>
              {demand.slice(0, 12).map((d, i) => (
                <tr key={`${d.sku || d.product}-${d.size}-${i}`}>
                  <td>{[d.product, d.size].filter(Boolean).join(" · ") || "—"}</td>
                  <td><span className="meta">{d.need}</span></td>
                  <td className="num">{d.asks}</td>
                  <td className="num">{d.fulfilled}</td>
                  <td className="num">
                    {d.avg_claim_seconds == null
                      ? <span className="meta">—</span>
                      : duration(Number(d.avg_claim_seconds))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
