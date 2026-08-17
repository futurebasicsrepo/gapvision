import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";

/**
 * A store's own glasses, in the store's own surface.
 *
 * Build-order step 5 of the provisioning spec: the same routes Console drives,
 * minus the part where you choose which retailer you are looking at. There is
 * no tenant picker here and there never should be — a `client_admin` has
 * exactly one store, and `identity.admin_tenant` refuses anyone else's, so the
 * boundary is the server's and this screen is not re-implementing it.
 *
 * **Not a port of Console's card.** The two surfaces share the routes, which is
 * the part where being wrong would matter; they do not share the markup,
 * because Studio has no table vocabulary and dragging one in to reuse a
 * component would have meant importing a design system to avoid retyping a
 * list. This is Studio's own `row-list`, the same shape as the floor roster
 * three cards up.
 *
 * The audience is different too, and the words follow it. Console says
 * "surface" because CueSea staff think in surfaces; a shop's admin thinks in
 * "a pair of glasses" and "a browser tab", so that is what this says.
 */

/** What a lens can be, said the way a retailer would say it. */
const SURFACES = [
  { id: "even-g2", label: "Glasses", note: "A pair of Even G2s. Scan the code with them." },
  { id: "mrbd", label: "Meta glasses", note: "Meta Ray-Ban Display. Opened from a link." },
  { id: "sim", label: "Browser tab", note: "For training and trying things. Not real hardware." },
];

/** Studio's own pill vocabulary — `warnpill` is the flame one, and a revoked
 *  pair that is still being carried is the only row here that wants attention. */
const PRESENCE = {
  active: { label: "on the floor", cls: "available" },
  idle: { label: "idle", cls: "neutral" },
  provisioned: { label: "not used yet", cls: "neutral" },
  revoked: { label: "revoked", cls: "warnpill" },
};

const surfaceLabel = (id) => SURFACES.find((s) => s.id === id)?.label || id;

/** Rendered from data — rows of '0'/'1' — so nothing that arrived over the
 *  network is ever put into this document as markup. */
function Qr({ rows, size = 160 }) {
  if (!rows?.length) return null;
  const quiet = 4;
  const side = rows.length + quiet * 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${side} ${side}`}
         role="img" aria-label="Setup code" className="qr">
      <rect width={side} height={side} fill="#fff" />
      {rows.map((row, y) =>
        [...row].map((bit, x) => (bit === "1" ? (
          <rect key={`${x}-${y}`} x={x + quiet} y={y + quiet} width={1} height={1} fill="#000" />
        ) : null)),
      )}
    </svg>
  );
}

export default function Devices({ user }) {
  const slug = user.tenant_slug;
  const [devices, setDevices] = useState(null);
  const [staff, setStaff] = useState([]);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  /** The mint response. Held here and nowhere else — it carries the only copy
   *  of a token that exists, so it must never be merged into the device list. */
  const [minted, setMinted] = useState(null);

  const load = useCallback(async () => {
    if (!slug) return;
    try {
      const [d, u] = await Promise.all([api.devices(slug), api.users(slug)]);
      setDevices(d.devices);
      setStaff(u.users || []);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [slug]);

  useEffect(() => { void load(); }, [load]);

  async function act(fn) {
    try {
      await fn();
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }

  if (!slug) {
    return (
      <div className="grid grid-dashboard">
        <div className="card span-12">
          <h3>Glasses</h3>
          <p className="card-note">
            These are one store's glasses, and this account belongs to no store.
            CueSea staff manage every retailer in Console.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-dashboard">
      <div className="card span-12">
        <div className="card-head">
          <h3>Your glasses</h3>
          {!adding && !minted && (
            <button className="btn small" onClick={() => setAdding(true)}>Add a pair</button>
          )}
        </div>
        <p className="card-note">
          Every lens on your floor has an identity set up here. The setup code is
          shown once and stored scrambled — if one is lost, replace it rather
          than looking it up, because nobody can look it up.
        </p>

        {error && <p className="card-note error" role="alert">{error}</p>}

        {minted && <Minted minted={minted} onDone={() => { setMinted(null); void load(); }} />}

        {adding && (
          <AddDevice
            slug={slug} staff={staff}
            onCancel={() => setAdding(false)}
            onMinted={(m) => { setAdding(false); setMinted(m); }}
          />
        )}

        {devices === null ? (
          <div className="empty">Loading…</div>
        ) : !devices.length ? (
          <div className="empty">
            No glasses set up yet. Add a pair above — you can do it before the
            hardware arrives.
          </div>
        ) : (
          <div className="row-list">
            {devices.map((d) => {
              const state = PRESENCE[d.presence] || PRESENCE.provisioned;
              return (
                <div className="row" key={d.id}>
                  <div>
                    {d.label || d.serial || "Unnamed"}
                    <span className="meta">
                      {" · "}{surfaceLabel(d.surface)}
                      {d.serial ? ` · ${d.serial}` : ""}
                    </span>
                  </div>
                  <div className="row-right">
                    <select
                      className="assign"
                      value={d.user_id || ""}
                      onChange={(e) => act(async () => {
                        await api.updateDevice(d.id, { user_id: e.target.value || "" });
                        await load();
                      })}
                    >
                      <option value="">— nobody —</option>
                      {staff.filter((u) => u.status === "active").map((u) => (
                        <option key={u.id} value={u.id}>{u.name}</option>
                      ))}
                    </select>
                    <span className={`pill ${state.cls}`}>{state.label}</span>
                    <button className="btn small" onClick={() => act(async () => {
                      setMinted(await api.reissueDevice(d.id));
                    })}>New code</button>
                    {d.presence !== "revoked" && (
                      <button className="btn small" onClick={() => act(async () => {
                        await api.revokeDevice(d.id);
                        await load();
                      })}>Revoke code</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <p className="card-note" style={{ marginTop: 12 }}>
          A pair with nobody assigned still records what happens on the floor,
          but not against a person — so it never reaches the leaderboard.
        </p>
      </div>
    </div>
  );
}

/**
 * The setup code, shown once.
 *
 * Says so before it can be dismissed rather than after, because afterwards
 * there is nothing that could say it: the token is stored hashed and there is
 * deliberately no route that returns it.
 */
function Minted({ minted, onDone }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="card-note minted" style={{ marginBottom: 12 }}>
      <strong>{minted.device.label || "Your new lens"} is ready.</strong>
      <p style={{ margin: "8px 0 12px", lineHeight: 1.5 }}>
        This is the only time this code is shown. It is stored scrambled, so
        nobody — not you, not us — can bring it back. Set the glasses up now; if
        it goes missing, use <em>New code</em>.
      </p>
      {minted.qr && <div style={{ marginBottom: 12 }}><Qr rows={minted.qr} /></div>}
      <div className="launch-url" data-testid="launch-url">{minted.launch_url}</div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button type="button" className="btn small" onClick={async () => {
          try {
            await navigator.clipboard.writeText(minted.launch_url);
            setCopied(true);
          } catch { /* a browser that refuses the clipboard still shows the link */ }
        }}>{copied ? "Copied" : "Copy link"}</button>
        <button type="button" className="btn small" onClick={onDone}>Done — I have it</button>
      </div>
    </div>
  );
}

function AddDevice({ slug, staff, onCancel, onMinted }) {
  const [form, setForm] = useState({ surface: "even-g2", label: "", serial: "", user_id: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const surface = SURFACES.find((s) => s.id === form.surface);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      onMinted(await api.mintDevice(slug, {
        surface: form.surface,
        label: form.label.trim() || null,
        // Only a G2 has a serial to type. Sending one for anything else would
        // claim this store's one nameless serial and collide with the next pair
        // that really has it — the field is hidden, but the value it held is
        // still in this form.
        serial: form.surface === "even-g2" && form.serial.trim() ? form.serial.trim() : null,
        user_id: form.user_id || null,
      }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="add-device" onSubmit={submit}>
      {error && <p className="card-note error" role="alert">{error}</p>}
      <label className="field">
        <span>What is it</span>
        <select className="assign" value={form.surface} onChange={set("surface")}>
          {SURFACES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </label>
      <p className="card-note">{surface.note}</p>

      <label className="field">
        <span>Call it</span>
        <input className="input-inline" value={form.label} onChange={set("label")}
               placeholder="Denim wall, pair 1" />
      </label>
      {form.surface === "even-g2" && (
        <label className="field">
          <span>Serial number, if you have it</span>
          <input className="input-inline" value={form.serial} onChange={set("serial")}
                 placeholder="From the box" />
        </label>
      )}
      <label className="field">
        <span>Who wears it</span>
        <select className="assign" value={form.user_id} onChange={set("user_id")}>
          <option value="">— decide later —</option>
          {staff.filter((u) => u.status === "active").map((u) => (
            <option key={u.id} value={u.id}>{u.name}</option>
          ))}
        </select>
      </label>

      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn small" type="submit" disabled={busy}>
          {busy ? "Setting up…" : "Set it up"}
        </button>
        <button className="btn small" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
