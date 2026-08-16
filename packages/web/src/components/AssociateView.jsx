import { useEffect, useRef, useState } from "react";
import { socket, currentTenant } from "../socket.js";
import GlassesDisplay from "./GlassesDisplay.jsx";

// Through the realtime server's proxy — the dashboard is a static bundle and
// cannot hold the AI service key.
const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";

const ZONE = "Denim Wall";

/**
 * The lens fact rail, from the guest the socket sent.
 *
 * Tier, points, then what fits them — the name is the lens's own first row and
 * is passed separately. TOP/BTM rather than TOPS/BOTTOMS: the rail holds
 * twelve characters and "BOTTOMS 28X30" is thirteen, so it clipped to
 * "BOTTOMS 28X" and lost the inseam, which is the half of that fact worth
 * having. Abbreviating the label saves the value.
 *
 * Everything here is conditional on the payload actually carrying it. A rail
 * row invented to fill the column is worse than a short rail.
 */
function railFacts(guest) {
  if (!guest) return [];
  const sizes = guest.sizes || {};
  return [
    guest.tier,
    typeof guest.points === "number" ? `${guest.points} PTS` : "",
    sizes.tops ? `TOP ${sizes.tops}` : "",
    sizes.bottoms ? `BTM ${sizes.bottoms}` : "",
  ].filter(Boolean);
}

export default function AssociateView() {
  const [display, setDisplay] = useState(null);
  const [guests, setGuests] = useState([]);
  const [radio, setRadio] = useState([]);
  const [draft, setDraft] = useState("");
  const registered = useRef(false);

  useEffect(() => {
    if (!registered.current) {
      socket.emit("register", { role: "associate", name: "You (Demo)", zone: ZONE, tenant: currentTenant() });
      registered.current = true;
    }
    const onDisplay = (payload) => setDisplay(payload);
    const onRadio = (msg) => setRadio((r) => [...r.slice(-30), msg]);
    socket.on("glasses:display", onDisplay);
    socket.on("radio:message", onRadio);
    return () => {
      socket.off("glasses:display", onDisplay);
      socket.off("radio:message", onRadio);
    };
  }, []);

  useEffect(() => {
    fetch(`${SERVER_URL}/api/guests`)
      .then((r) => r.json())
      .then(setGuests)
      .catch(() => setGuests([]));
  }, []);

  const simulateBeacon = (guestId) =>
    socket.emit("beacon:guest-enter", { guestId, zone: ZONE });

  const endSession = () => {
    setDisplay(null);
    socket.emit("session:end");
  };

  const sendRadio = (e) => {
    e.preventDefault();
    if (!draft.trim()) return;
    socket.emit("radio:send", { from: "You (Demo)", message: draft.trim() });
    setDraft("");
  };

  return (
    <div className="associate-layout">
      <div className="grid" style={{ gap: 16 }}>
        <div className="card">
          <h3>In-Lens View</h3>
          {/* The socket's `lines` is still the only required prop; everything
              else is what the same payload happens to carry, and the lens
              degrades to an empty rail without it rather than inventing a
              guest. */}
          <GlassesDisplay
            lines={display?.lines}
            name={display?.guest?.name}
            facts={railFacts(display?.guest)}
            zone={ZONE}
            cycle={
              display?.recommendations?.length
                ? { index: 0, count: display.recommendations.length }
                : undefined
            }
          />
        </div>

        <div className="card">
          <h3>Beacon Simulator — opted-in guest enters your zone</h3>
          <div className="btn-row">
            {guests.length === 0 && (
              <div className="empty">AI service offline — start it on :8000</div>
            )}
            {guests.map((g) => (
              <button
                key={g.guest_id}
                className="btn primary"
                onClick={() => simulateBeacon(g.guest_id)}
              >
                {g.name} · {g.loyalty_tier}
              </button>
            ))}
            {display && (
              <button className="btn ghost" onClick={endSession}>
                End session
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="grid" style={{ gap: 16 }}>
        <div className="card">
          <h3>Full Sales Script (phone view)</h3>
          {display?.script ? (
            <div className="script-block">
              <p><strong>Open:</strong> {display.script.opener}</p>
              <p><strong>Guide:</strong> {display.script.upsell}</p>
              <p><strong>Close:</strong> {display.script.closer}</p>
            </div>
          ) : (
            <div className="empty">Trigger a beacon signal to generate a script.</div>
          )}
        </div>

        <div className="card">
          <h3>Digital Radio — floor channel</h3>
          <div className="radio-log">
            {radio.length === 0 && <div className="empty">No traffic yet.</div>}
            {radio.map((m, i) => (
              <div className="radio-msg" key={i}>
                <span className="from">{m.from}:</span> {m.message}
              </div>
            ))}
          </div>
          <form className="radio-input" onSubmit={sendRadio}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Push to talk… (e.g. 'Need a 28x30 runner to Denim Wall')"
            />
            <button className="btn primary" type="submit">Send</button>
          </form>
        </div>
      </div>
    </div>
  );
}
