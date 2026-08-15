import { useEffect, useState } from "react";
import { api, ApiError } from "../api.js";
import { PersonRow } from "./Tenants.jsx";

/**
 * Cue staff.
 *
 * The endpoint has always been able to mint staff — role cue_admin, tenant
 * forced to null, and only a cue_admin may do it. Nothing in the Console
 * reached it: AddUser is rendered inside a tenant and always passes one, so
 * the only way to add a colleague was a hand-written API call. Which meant in
 * practice that onboarding the person who is meant to help you was the one
 * thing the tool could not do.
 *
 * Staff are listed from their own route. /users is manager-and-up and
 * tenant-scoped by construction; widening it to see accounts with no tenant
 * would weaken the function every other read depends on.
 */
export default function Staff() {
  const [staff, setStaff] = useState(null);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);

  function load() {
    api.staff()
      .then((r) => { setStaff(r.staff || []); setError(null); })
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }
  useEffect(load, []);

  return (
    <div className="card span-12">
      <div className="card-head">
        <h2>Cue staff</h2>
        {!adding && (
          <button className="btn small" onClick={() => setAdding(true)}>Add staff</button>
        )}
      </div>
      <p className="card-note">
        Accounts with no tenant. The schema enforces that — Cue staff
        structurally cannot belong to a retailer, which is what keeps the
        boundary real rather than a matter of who remembered to set a field.
      </p>

      {error && <div className="notice error" style={{ marginBottom: 12 }}>{error}</div>}

      {adding && (
        <AddStaff onCancel={() => setAdding(false)}
                  onDone={() => { setAdding(false); load(); }} />
      )}

      {staff === null ? (
        <p className="empty">Loading…</p>
      ) : !staff.length ? (
        <p className="empty">No staff accounts.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Role</th><th>Status</th><th>Last seen</th><th></th></tr>
            </thead>
            <tbody>
              {staff.map((u) => (
                <PersonRow key={u.id} user={u} onChange={load} onError={setError} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AddStaff({ onDone, onCancel }) {
  const [form, setForm] = useState({ email: "", name: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [invited, setInvited] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      // No password, ever, on this form. Staff get an invite or they get
      // nothing — a colleague's first experience of the tool should not be
      // somebody reading them a password.
      const r = await api.createStaff({ email: form.email.trim(), name: form.name.trim() });
      if (r.invite && !r.invite.sent) {
        setInvited({ ok: false, provider: r.invite.provider });
      } else {
        onDone();
        return;
      }
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ marginBottom: 18 }}>
      {err && <div className="notice error" style={{ marginBottom: 12 }}>{err}</div>}
      {invited && !invited.ok && (
        <div className="notice error" style={{ marginBottom: 12 }}>
          The account exists but the invite did not send
          {invited.provider ? ` (${invited.provider})` : ""}. Use Invite on their
          row to try again rather than creating them twice.
        </div>
      )}
      <div className="form-grid">
        <label className="field">
          <span>Name</span>
          <input value={form.name} onChange={set("name")} autoComplete="off" required />
        </label>
        <label className="field">
          <span>Email</span>
          <input type="email" value={form.email} onChange={set("email")}
                 autoComplete="off" required />
        </label>
      </div>
      <p className="meta" style={{ marginTop: 8, lineHeight: 1.5 }}>
        They get an emailed invite — single use, expires in a week, which is
        long enough to survive a weekend. Role is cue_admin: staff have no
        lesser tier, because a Cue account that cannot see across tenants has
        nothing to do.
      </p>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn primary" type="submit"
                disabled={busy || !form.email || !form.name}>
          {busy ? "inviting…" : "Send invite"}
        </button>
        <button className="btn" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
