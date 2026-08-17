import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";

/**
 * The store's own controls, in the store's own surface.
 *
 * Kyle's call, 17 Aug 2026: turning the glasses' right-hand deck off is an
 * admin decision and it belongs here rather than on the associate's phone. That
 * splits the question cleanly — **the store decides the deck exists, the person
 * decides what is in theirs** — and it needed a surface that did not exist,
 * because until now every retailer-facing control lived in CueSea Console.
 *
 * Console is ours and spans every tenant. This is one retailer looking at their
 * own store, which is the right place for a decision about their own floor.
 *
 * `client_admin` only, and deliberately not CueSea staff: a `cue_admin` has
 * Console for this, and giving them a second door into a retailer's
 * configuration from a surface where they are viewing a store they picked from
 * a switcher is how you end up changing the wrong shop's settings.
 */
export default function Settings({ user }) {
  const [tenant, setTenant] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const slug = user.tenant_slug;

  const load = useCallback(async () => {
    if (!slug) return;
    try {
      const { tenant: row } = await api.tenant(slug);
      setTenant(row);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => { void load(); }, [load]);

  if (!slug) {
    return (
      <div className="grid grid-dashboard">
        <div className="card span-12">
          <h3>Settings</h3>
          <p className="card-note">
            These are one store's settings, and this account belongs to no store.
            CueSea staff manage every retailer in Console.
          </p>
        </div>
      </div>
    );
  }

  if (loading) return <div className="empty">Loading settings…</div>;

  const config = tenant?.config || {};

  return (
    <div className="grid grid-dashboard">
      <div className="card span-8">
        <h3>The floor</h3>
        <p className="card-note">
          What your associates' glasses offer. These apply to everyone on the
          floor — an associate arranges their own widgets on their phone, but
          whether they have them at all is set here.
        </p>
        {error && <p className="card-note error" role="alert">{error}</p>}

        <SettingSwitch
          label="Widgets"
          desc={"The right-hand side of the glass: the customer's details, what "
              + "to offer, and the floor channel. Off leaves the cue and the "
              + "fact rail, which is a complete way to work."}
          // `!== false`, not truthy. This ships on, so a store that has never
          // touched it is a store with widgets — reading it as a plain boolean
          // would draw OFF for almost every retailer, which is exactly the bug
          // the Console privacy switches were fixed for.
          on={config.widgets !== false}
          onChange={async (next) => {
            // Merge before sending as well as after: the server does it too,
            // but a client that replaces a jsonb column is one bad deploy away
            // from wiping a sibling key.
            await api.updateTenant(slug, { config: { ...config, widgets: next } });
            await load();
          }}
          onError={setError}
        />
      </div>

      <div className="card span-4">
        <h3>Where else to look</h3>
        <p className="card-note">
          Privacy — the phone camera, transcripts, shift timing and how long
          anything is kept — is set with CueSea rather than here, because those
          are the decisions a legal review asks about and they are recorded
          alongside the agreement. Ask us and we will walk through them with you.
        </p>
      </div>
    </div>
  );
}

/**
 * One switch, which moves when the server has moved and not before.
 *
 * Copied in spirit from Console's `MissionSwitch`, and for its reason: a
 * control that shows the state it *wishes* were true is the failure this whole
 * surface exists to avoid. It holds a busy state while the write is in flight
 * and surfaces a refusal where the finger is.
 */
function SettingSwitch({ label, desc, on, onChange, onError }) {
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  async function flip() {
    if (busy) return;
    setBusy(true);
    try {
      await onChange(!on);
    } catch (e) {
      onError?.(e.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <div className={`set-row ${on ? "on" : ""}`}>
      <span className="set-dot" />
      <div className="set-text">
        <span className="set-label">{label}</span>
        <span className="set-desc">{desc}</span>
      </div>
      <button type="button" role="switch" aria-checked={on} className="set-switch"
              disabled={busy} onClick={flip}>
        <span className="set-track"><span className="set-knob" /></span>
        <span className="set-state">{busy ? "…" : on ? "ON" : "OFF"}</span>
      </button>
    </div>
  );
}
