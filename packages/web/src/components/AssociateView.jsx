import { useEffect, useRef, useState } from "react";
import { socket } from "../socket.js";
import GlassesDisplay from "./GlassesDisplay.jsx";

const AI_URL = import.meta.env.VITE_AI_URL || "http://localhost:8000";

export default function AssociateView() {
  const [display, setDisplay] = useState(null);
  const [guests, setGuests] = useState([]);
  const [radio, setRadio] = useState([]);
  const [draft, setDraft] = useState("");
  const registered = useRef(false);

  useEffect(() => {
    if (!registered.current) {
      socket.emit("register", { role: "associate", name: "You (Demo)", zone: "Denim Wall" });
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
    fetch(`${AI_URL}/api/guests`)
      .then((r) => r.json())
      .then(setGuests)
      .catch(() => setGuests([]));
  }, []);

  const simulateBeacon = (guestId) =>
    socket.emit("beacon:guest-enter", { guestId, zone: "Denim Wall" });

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
          <GlassesDisplay lines={display?.lines} />
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
