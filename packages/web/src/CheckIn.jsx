/**
 * The check-in page — what a guest sees after tapping a plate.
 *
 * The only surface in this product a customer ever touches, and the only one
 * where every extra tap is charged to somebody standing in a fitting room
 * holding a pair of jeans. That governs every decision below.
 *
 * Three states, in order:
 *
 *   handoff   the retailer has their own app and wants the guest in it. One
 *             button, plus the way to carry on here — because a guest without
 *             the app must never hit a dead end.
 *   ask       what do you need. The whole reason the page exists.
 *   sent      it landed, and how to stop.
 *
 * Identity is deliberately optional. An anonymous reference is minted here, in
 * the browser, and it is a pointer to nothing: the associate gets "fitting
 * room 3 wants a 32 in the barrel jean", which is completely actionable and
 * names nobody. Signing in buys you the guest card — your sizes, your saved
 * items — and that is the retailer's own account flow, not ours.
 */
import { useEffect, useMemo, useState } from "react";
import { Wordmark } from "./components/Mark.jsx";
import "./here.css";

const BASE = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";

/** One visit, one reference. Kept in sessionStorage so closing the tab ends
 *  it — a check-in is a moment, and a reference that outlives the visit is a
 *  tracking identifier we did not ask permission for. */
const REF_KEY = "cue.here.ref";

function visitRef() {
  try {
    const held = sessionStorage.getItem(REF_KEY);
    if (held) return held;
    const made = `anon-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    sessionStorage.setItem(REF_KEY, made);
    return made;
  } catch {
    // Private mode. A reference that lives only in memory still works for
    // this visit; it just will not survive a reload.
    return `anon-${Math.random().toString(36).slice(2, 14)}`;
  }
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.detail || data.error || `Failed (${res.status})`);
  return data;
}

const zoneLabel = (slug) =>
  !slug ? "the floor"
    : slug.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export default function CheckIn() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const tenant = params.get("t") || "gap";
  const zone = params.get("z") || null;
  // Passed through untouched. The tap and the scan are different doors and
  // normalising them here would quietly destroy the only measurement that
  // tells us whether the tags were worth paying for.
  const src = params.get("src") || "qr-plate";

  const [config, setConfig] = useState(null);
  const [stage, setStage] = useState("loading");
  const [error, setError] = useState(null);
  const [products, setProducts] = useState([]);
  const [sizesKnown, setSizesKnown] = useState(false);

  const [need, setNeed] = useState("size");
  const [sku, setSku] = useState("");
  const [size, setSize] = useState("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(null);

  const guestRef = useMemo(visitRef, []);
  const product = products.find((p) => p.sku === sku) || null;

  // Check in first, then decide what to show. Deliberately in that order: the
  // arrival is the thing the store needs, and it should survive a guest who
  // reads one screen and puts their phone away.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const cfgRes = await fetch(
          `${BASE}/api/checkin/config?t=${encodeURIComponent(tenant)}`);
        const cfg = cfgRes.ok ? await cfgRes.json() : { mode: "web", needs: {} };
        if (!live) return;
        setConfig(cfg);

        await post("/api/presence", {
          tenant, guest_ref: guestRef, zone, source: src,
        });
        if (!live) return;
        setStage(cfg.mode === "app" && cfg.app_link ? "handoff" : "ask");

        const cat = await fetch(
          `${BASE}/api/catalogue?t=${encodeURIComponent(tenant)}`);
        if (!live || !cat.ok) return;
        const data = await cat.json();
        setProducts(data.products || []);
        setSizesKnown(Boolean(data.sizes_known));
      } catch (e) {
        if (live) { setError(e.message); setStage("error"); }
      }
    })();
    return () => { live = false; };
  }, [tenant, zone, src, guestRef]);

  const appHref = config?.app_link
    ? config.app_link
        .replace("{t}", encodeURIComponent(tenant))
        .replace("{z}", encodeURIComponent(zone || ""))
        .replace("{src}", encodeURIComponent(src))
        .replace("{ref}", encodeURIComponent(guestRef))
    : null;

  async function send() {
    setSending(true);
    setError(null);
    try {
      const res = await post("/api/request", {
        tenant, guest_ref: guestRef, zone, need,
        sku: sku || null,
        product: product?.name || null,
        size: size || null,
        note: note.trim() || null,
        surface: "web",
      });
      setSent(res);
      setStage("sent");
    } catch (e) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    try {
      await post("/api/presence/revoke", { tenant, guest_ref: guestRef });
    } catch { /* leaving is not something to make somebody retry */ }
    setStage("stopped");
  }

  if (stage === "loading") {
    return <Shell><p className="here-quiet">Checking you in…</p></Shell>;
  }

  if (stage === "error") {
    return (
      <Shell>
        <h1 className="here-h1">Something went wrong</h1>
        <p className="here-quiet">{error}</p>
        <p className="here-quiet">
          Ask any associate — they can help you the ordinary way.
        </p>
      </Shell>
    );
  }

  if (stage === "stopped") {
    return (
      <Shell>
        <h1 className="here-h1">You're checked out</h1>
        <p className="here-quiet">
          Nothing is waiting for you and nobody is on their way. Tap the plate
          again any time.
        </p>
      </Shell>
    );
  }

  if (stage === "handoff") {
    return (
      <Shell>
        <h1 className="here-h1">You're here</h1>
        <p className="here-lead">{zoneLabel(zone)}</p>
        <p className="here-quiet">
          Open {config.app_name} to tell us what you need — it already knows
          your sizes and what you've saved.
        </p>
        <a className="here-btn" href={appHref}>Open {config.app_name}</a>
        <button className="here-linkish" onClick={() => setStage("ask")}>
          Continue here instead
        </button>
      </Shell>
    );
  }

  if (stage === "sent") {
    return (
      <Shell>
        <h1 className="here-h1">On its way</h1>
        <p className="here-lead">{sent?.line}</p>
        <p className="here-quiet">
          {sent?.delivered > 0
            ? `Someone on the floor has it${zone ? ` — ${zoneLabel(zone)}` : ""}.`
            : `We've got it. Nobody is wearing glasses on the floor this minute, so an associate will pick it up from the floor screen.`}
        </p>
        <button className="here-linkish" onClick={() => { setSent(null); setStage("ask"); }}>
          Ask for something else
        </button>
        <button className="here-linkish" onClick={stop}>Stop — I'm done</button>
      </Shell>
    );
  }

  // --- the ask ---------------------------------------------------------------
  const needs = config?.needs || {};
  return (
    <Shell>
      <h1 className="here-h1">You're here</h1>
      <p className="here-lead">{zoneLabel(zone)}</p>

      <label className="here-label">What do you need?</label>
      <div className="here-chips">
        {Object.entries(needs).map(([key, label]) => (
          <button
            key={key}
            className={`here-chip ${need === key ? "on" : ""}`}
            onClick={() => setNeed(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {products.length > 0 && (
        <>
          <label className="here-label" htmlFor="here-product">Which item?</label>
          <select
            id="here-product"
            className="here-input"
            value={sku}
            onChange={(e) => { setSku(e.target.value); setSize(""); }}
          >
            <option value="">— pick one, or just describe it below —</option>
            {products.map((p) => (
              <option key={p.sku} value={p.sku}>{p.name}</option>
            ))}
          </select>
        </>
      )}

      {product?.sizes?.length > 0 && (
        <>
          <label className="here-label">Which size?</label>
          <div className="here-chips">
            {product.sizes.map((s) => (
              <button
                key={s.size}
                className={`here-chip ${size === s.size ? "on" : ""} ${s.available ? "" : "thin"}`}
                onClick={() => setSize(s.size)}
              >
                {s.size}
                {/* Shown and not hidden. Hiding a size reads as "that size
                    doesn't exist", so people ask for the wrong thing or give
                    up — and the floor routinely holds stock the system hasn't
                    caught up with.

                    "check" and not "low" or "out": what we actually know is
                    that our count says none, which is a weaker claim than
                    either. Somebody can look in the back, and this wording is
                    the one that gets them asked. */}
                {s.available ? "" : " · check"}
              </button>
            ))}
          </div>
        </>
      )}

      {product && !product.sizes && sizesKnown === false && (
        <p className="here-quiet">
          This store doesn't share size-level stock with us yet — say the size
          in the box below and someone will check.
        </p>
      )}

      <label className="here-label" htmlFor="here-note">Anything else?</label>
      <textarea
        id="here-note"
        className="here-input"
        rows={3}
        maxLength={400}
        placeholder="The dark wash, not the light one — and a 32 if you have it"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      {error && <p className="here-error">{error}</p>}

      <button className="here-btn" onClick={send} disabled={sending}>
        {sending ? "Sending…" : "Send it to the floor"}
      </button>

      <p className="here-fine">
        You're checked in for this visit only. We hold what you asked for and
        where you asked from — no cameras, and no record of where you walk.
      </p>
      <button className="here-linkish" onClick={stop}>Stop — I'm done</button>
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="here-shell">
      <div className="here-card">
        <div className="here-brand"><Wordmark size={18} onDark={false} /></div>
        {children}
      </div>
    </div>
  );
}
