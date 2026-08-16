import { useEffect, useRef, useState } from "react";
import { socket, currentTenant } from "../socket.js";

const EMPTY = {
  associates: [],
  activeSessions: [],
  radioLog: [],
  leaderboard: [],
  stats: { guestsToday: 0, scriptsServed: 0, radioMessages: 0 },
};

export default function Dashboard() {
  const [snap, setSnap] = useState(EMPTY);
  const registered = useRef(false);

  useEffect(() => {
    if (!registered.current) {
      socket.emit("register", { role: "dashboard", tenant: currentTenant() });
      registered.current = true;
    }
    const onUpdate = (payload) => setSnap(payload);
    socket.on("dashboard:update", onUpdate);
    return () => socket.off("dashboard:update", onUpdate);
  }, []);

  return (
    <div className="grid grid-dashboard">
      <div className="card span-3">
        <div className="stat-value">{snap.stats.guestsToday}</div>
        <div className="stat-label">Guest engagements today</div>
      </div>
      <div className="card span-3">
        <div className="stat-value">{snap.stats.scriptsServed}</div>
        <div className="stat-label">AI scripts served</div>
      </div>
      <div className="card span-3">
        <div className="stat-value">{snap.stats.radioMessages}</div>
        <div className="stat-label">Radio messages</div>
      </div>
      <div className="card span-3">
        <div className="stat-value">{snap.associates.length}</div>
        <div className="stat-label">Associates on floor</div>
      </div>

      <div className="card span-4">
        <h3>Floor Roster</h3>
        <div className="row-list">
          {snap.associates.length === 0 && (
            <div className="empty">No associates connected — open the Associate View.</div>
          )}
          {snap.associates.map((a) => (
            <div className="row" key={a.id}>
              <div>
                {a.name} <span className="meta">· {a.zone}</span>
              </div>
              <span className={`pill ${a.status}`}>{a.status}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card span-4">
        <h3>Live Guest Sessions</h3>
        <div className="row-list">
          {snap.activeSessions.length === 0 && (
            <div className="empty">No sessions yet — trigger a beacon in the Associate View.</div>
          )}
          {[...snap.activeSessions].reverse().map((s, i) => (
            <div className="row" key={i}>
              <div>
                {s.guest} <span className="meta">· {s.zone}</span>
              </div>
              <span className="pill tier">{s.tier}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card span-4">
        <h3>Leaderboard — today</h3>
        <div className="row-list">
          {snap.leaderboard.map((r, i) => (
            <div className="row" key={r.name}>
              <div>
                <span className="rank">{i + 1}</span> {r.name}
                <span className="meta"> · {r.assists} assists</span>
              </div>
              <div className="amount">${r.sales.toLocaleString()}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card span-12">
        <h3>Radio Traffic</h3>
        <div className="row-list">
          {snap.radioLog.length === 0 && <div className="empty">Quiet on the floor.</div>}
          {[...snap.radioLog].reverse().map((m, i) => (
            <div className="row" key={i}>
              <div>
                <span className="pill" style={{ marginRight: 8 }}>{m.channel}</span>
                <strong>{m.from}</strong> — {m.message}
              </div>
              <span className="meta">{new Date(m.at).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
