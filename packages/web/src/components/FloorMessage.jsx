import { useEffect, useRef, useState } from "react";
import { socket } from "../socket.js";
import { Empty } from "./Charts.jsx";

/**
 * Say something to the floor, from Studio.
 *
 * Kyle's call, 2026-08-16: managers send from **Studio** and never from
 * Console. Studio is one retailer's own surface and its floor is the floor
 * this message belongs to; Console is CueSea staff and spans every tenant, and
 * a store's channel must not be writable from a cross-tenant surface at all.
 *
 * Two things this deliberately does not do:
 *
 * - **No urgent tier.** The frame-takeover belongs to the canned backup call,
 *   which is a press on an associate's ring — a peer distress signal, not a
 *   management channel. The server clamps this too; the interface simply never
 *   offers it.
 * - **No name field.** The sender's name is pinned to the socket at register
 *   from the signed-in session, so what lands on somebody's glasses is who the
 *   manager actually is rather than what this browser claimed.
 */
export default function FloorMessage({ roster, user }) {
  const [target, setTarget] = useState(null);
  const [text, setText] = useState("");
  const [status, setStatus] = useState(null);
  const [listening, setListening] = useState(false);
  const recognition = useRef(null);

  // Receipts. "Delivered" is the honest word and the only one available: the
  // lens queues a message behind its unread count, so a "read" receipt would
  // either be a lie or need an acknowledgement instrument nobody asked for.
  useEffect(() => {
    const onDelivered = ({ toName, reach }) => {
      if (toName) return setStatus({ tone: "ok", text: `Delivered to ${toName}.` });
      // A broadcast's receipt is a count of glasses, and zero is the case that
      // must not read as success — it is the broadcast version of "they left".
      if (reach === 0) {
        return setStatus({ tone: "error", text: "Nobody is on the floor — nothing received it." });
      }
      if (typeof reach === "number") {
        return setStatus({ tone: "ok", text: `Sent to ${reach} on the floor.` });
      }
      return setStatus({ tone: "ok", text: "Sent." });
    };
    const onUndelivered = ({ reason }) =>
      setStatus({
        tone: "error",
        text: reason === "not_on_floor"
          ? "They're no longer on the floor — nothing was sent."
          : reason === "floor_comms_off"
            ? "Floor messages are switched off for this store, in Console."
            : "Not delivered.",
      });
    socket.on("radio:delivered", onDelivered);
    socket.on("radio:undelivered", onUndelivered);
    return () => {
      socket.off("radio:delivered", onDelivered);
      socket.off("radio:undelivered", onUndelivered);
    };
  }, []);

  // A target who walks off the floor stops being a target. Without this the
  // composer keeps pointing at a socket id that no longer resolves, and the
  // send fails at the server for a reason the manager can't see coming.
  useEffect(() => {
    if (target && !roster.some((r) => r.id === target)) setTarget(null);
  }, [roster, target]);

  /**
   * Dictation, where the browser has it.
   *
   * Kyle's adoption note: typing and talking are both first-class, because a
   * manager on a shop floor has their hands full as often as an associate
   * does. `webkitSpeechRecognition` is Chrome and Safari; anywhere it is
   * missing the button is not rendered and the keyboard is the whole
   * interface, which is a complete way to use this card rather than a
   * degraded one.
   */
  const SpeechRecognition =
    typeof window !== "undefined"
      && (window.SpeechRecognition || window.webkitSpeechRecognition);

  const dictate = () => {
    if (!SpeechRecognition) return;
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const rec = new SpeechRecognition();
    rec.lang = navigator.language || "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    // Appended, not replaced: someone who typed half a sentence and then
    // reached for the mic means to finish it, not to lose it.
    const base = text ? `${text.trim()} ` : "";
    rec.onresult = (e) => {
      const said = Array.from(e.results).map((r) => r[0].transcript).join("");
      setText((base + said).slice(0, 140));
    };
    rec.onerror = (e) => {
      setListening(false);
      setStatus({
        tone: "error",
        text: e.error === "not-allowed"
          ? "Microphone blocked in this browser — type instead."
          : "Dictation didn't catch that — try again or type it.",
      });
    };
    rec.onend = () => setListening(false);
    recognition.current = rec;
    setListening(true);
    setStatus(null);
    rec.start();
  };

  const send = () => {
    const message = text.trim();
    if (!message) return;
    if (!socket.connected) {
      setStatus({ tone: "error", text: "No connection to the floor — nothing was sent." });
      return;
    }
    socket.emit("radio:send", { message, ...(target ? { to: target } : {}) });
    setText("");
    // "Sending", not "Sent" — this is written before anything has been
    // delivered. The server's receipt is a moment away and it is the only
    // thing that knows whether anybody was there to receive it.
    setStatus({ tone: "", text: targetName ? `Sending to ${targetName}…` : "Sending to the floor…" });
  };

  const targetName = roster.find((r) => r.id === target)?.name;

  return (
    <div className="card span-4">
      <h3>Message the floor</h3>
      <p className="card-note">
        Reaches {targetName ? `${targetName}'s` : "every associate's"} glasses now.
        {" "}Pick a name to reach one person, or send to everyone.
        {" "}Urgent stays with the floor's own backup call — this arrives behind
        their unread count rather than taking over what they're looking at.
      </p>

      <div className="btn-row">
        <button
          className={`btn ${target === null ? "primary" : "ghost"}`}
          aria-pressed={target === null}
          onClick={() => setTarget(null)}
        >
          Everyone
        </button>
        {roster.map((a) => (
          <button
            key={a.id}
            className={`btn ${target === a.id ? "primary" : "ghost"}`}
            aria-pressed={target === a.id}
            onClick={() => setTarget(target === a.id ? null : a.id)}
          >
            {a.name}
            <span className="meta"> · {a.zone}</span>
          </button>
        ))}
      </div>

      {roster.length === 0 && (
        <Empty>Nobody is on the floor — a message now would reach no glasses.</Empty>
      )}

      <div className="floor-compose">
        <input
          type="text"
          className="floor-input"
          value={text}
          maxLength={140}
          placeholder={targetName ? `Message ${targetName}` : "Message the floor"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }}
        />
        {SpeechRecognition && (
          <button
            className={`btn ${listening ? "primary" : "ghost"}`}
            onClick={dictate}
            aria-pressed={listening}
            title="Dictate"
          >
            {listening ? "Listening…" : "Speak"}
          </button>
        )}
        <button
          className="btn primary"
          onClick={send}
          disabled={!text.trim() || roster.length === 0}
        >
          Send
        </button>
      </div>

      {status && (
        <p className={`card-note ${status.tone === "error" ? "error" : ""}`}
           role="status">
          {status.text}
        </p>
      )}
      <p className="card-note">
        Sent as {user?.name || "you"}. Direct messages aren't shown on this
        dashboard — only what's sent to the whole floor.
      </p>
    </div>
  );
}
