import { useCallback, useEffect, useState } from "react";
import { api, compact, when } from "../api.js";

/**
 * Tenants, their people, their hardware, and what they've used.
 *
 * The one screen in the system that reads across retailers on purpose. Every
 * other surface goes through `scope_tenant()` precisely so this can't happen
 * by accident anywhere else.
 *
 * Note what is *not* here: guests. Cue stores a CRM reference and never a
 * customer profile, so there is nothing to browse and no screen where someone
 * could go looking. That is a property of the schema, not a UI decision.
 */

const PLANS = ["pilot", "standard", "enterprise"];
const STATUSES = ["active", "suspended", "archived"];

function CreateTenant({ onDone, onCancel }) {
  const [form, setForm] = useState({ slug: "", name: "", crm_provider: "mock", billing_plan: "pilot" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const { tenant } = await api.createTenant({
        ...form,
        slug: form.slug.trim().toLowerCase(),
      });
      onDone(tenant);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card span-12" onSubmit={submit}>
      <h3>New tenant</h3>
      <p className="card-note">
        The slug is permanent and load-bearing — it's what the Cue Lens launch
        URL carries (<code>?tenant=gap</code>) and what every scoped query keys
        on. Lowercase, hyphens allowed.
      </p>
      {error && <div className="notice error" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="form-grid">
        <label className="field">
          <span>Slug</span>
          <input value={form.slug} onChange={set("slug")} required placeholder="gap" />
        </label>
        <label className="field">
          <span>Name</span>
          <input value={form.name} onChange={set("name")} required placeholder="Gap" />
        </label>
        <label className="field">
          <span>CRM adapter</span>
          <select value={form.crm_provider} onChange={set("crm_provider")}>
            <option value="mock">mock — demo data</option>
            <option value="shopify">shopify</option>
          </select>
        </label>
        <label className="field">
          <span>Billing plan</span>
          <select value={form.billing_plan} onChange={set("billing_plan")}>
            {PLANS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
      </div>
      <div className="btn-row" style={{ marginTop: 14 }}>
        <button className="btn primary" type="submit" disabled={busy || !form.slug || !form.name}>
          {busy ? "Creating…" : "Create tenant"}
        </button>
        <button className="btn ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function AddUser({ tenant, onDone, onCancel }) {
  const [form, setForm] = useState({ email: "", name: "", role: "client_admin", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.createUser({
        email: form.email.trim(), name: form.name.trim(), role: form.role,
        tenant: tenant.slug,
        // Empty means no password set: the account exists but cannot sign in
        // until someone sets one. That's a deliberate state, not a bug.
        password: form.password || undefined,
      });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ marginTop: 14 }}>
      {error && <div className="notice error" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="form-grid">
        <label className="field">
          <span>Email</span>
          <input type="email" value={form.email} onChange={set("email")} required />
        </label>
        <label className="field">
          <span>Name</span>
          <input value={form.name} onChange={set("name")} required />
        </label>
        <label className="field">
          <span>Role</span>
          <select value={form.role} onChange={set("role")}>
            <option value="associate">associate</option>
            <option value="manager">manager</option>
            <option value="client_admin">client admin</option>
          </select>
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" value={form.password} onChange={set("password")}
                 autoComplete="new-password" placeholder="leave blank to set later" />
        </label>
      </div>
      <p className="meta" style={{ marginTop: 8, lineHeight: 1.5 }}>
        There's no invite flow yet, so a blank password means this person can't
        sign in until you come back and set one. Until that ships, type one here
        and hand it over out of band.
      </p>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn primary" type="submit" disabled={busy || !form.email || !form.name}>
          {busy ? "Adding…" : "Add person"}
        </button>
        <button className="btn ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function TenantDetail({ tenant, onChanged }) {
  const [users, setUsers] = useState(null);
  const [devices, setDevices] = useState(null);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    setError(null);
    Promise.all([api.users(tenant.slug), api.devices(tenant.slug)])
      .then(([u, d]) => { setUsers(u.users); setDevices(d.devices); })
      .catch((e) => setError(e.message));
  }, [tenant.slug]);

  useEffect(() => { load(); }, [load]);

  async function setPlan(billing_plan) {
    try {
      await api.updateTenant(tenant.slug, { billing_plan });
      onChanged();
    } catch (e) { setError(e.message); }
  }
  async function setStatus(status) {
    try {
      await api.updateTenant(tenant.slug, { status });
      onChanged();
    } catch (e) { setError(e.message); }
  }

  async function assignDevice(deviceId, userId) {
    // Optimistic: the select has already moved, and snapping it back on a
    // slow round trip reads as the click not registering.
    setDevices((ds) => ds.map((d) => (d.id === deviceId ? { ...d, user_id: userId || null } : d)));
    try {
      await api.updateDevice(deviceId, { user_id: userId || "" });
      load();
    } catch (e) {
      setError(e.message);
      load();
    }
  }

  const admins = (users || []).filter((u) => u.role === "client_admin");

  return (
    <>
      <div className="card span-6">
        <div className="card-head">
          <h3>{tenant.name} · people</h3>
          {!adding && (
            <button className="btn small" onClick={() => setAdding(true)}>Add person</button>
          )}
        </div>

        {error && <div className="notice error" style={{ marginBottom: 12 }}>{error}</div>}

        {!admins.length && users && (
          <div className="notice" style={{ marginBottom: 12 }}>
            No client admin here — every change to this retailer has to route
            through us until one exists.
          </div>
        )}

        {adding ? (
          <AddUser tenant={tenant} onCancel={() => setAdding(false)}
                   onDone={() => { setAdding(false); load(); }} />
        ) : users === null ? (
          <div className="empty">Loading…</div>
        ) : !users.length ? (
          <div className="empty">Nobody yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Name</th><th>Role</th><th>Status</th><th>Last seen</th></tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div>{u.name}</div>
                      <div className="ident" style={{ fontSize: 11 }}>{u.email}</div>
                    </td>
                    <td><span className="pill muted">{u.role.replace("_", " ")}</span></td>
                    <td>
                      {u.status === "active"
                        ? <span className="meta">active</span>
                        : <span className="pill flame">disabled</span>}
                    </td>
                    <td className="meta mono">{when(u.last_login_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card span-6">
        <h3>{tenant.name} · hardware & terms</h3>

        <div className="form-grid" style={{ marginBottom: 16 }}>
          <label className="field">
            <span>Billing plan</span>
            <select value={tenant.billing_plan} onChange={(e) => setPlan(e.target.value)}>
              {PLANS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Status</span>
            <select value={tenant.status} onChange={(e) => setStatus(e.target.value)}>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        </div>
        <p className="meta" style={{ marginBottom: 16, lineHeight: 1.5 }}>
          Commercial terms are Cue-side only — a retailer's own admin can set
          their privacy posture but can't change either of these.
        </p>

        {devices === null ? (
          <div className="empty">Loading…</div>
        ) : !devices.length ? (
          <div className="empty">
            No devices yet. A pair of glasses registers itself the first time it
            connects — put them on and reload.
          </div>
        ) : (
          <>
            {devices.some((d) => !d.assigned_to) && (
              <div className="notice" style={{ marginBottom: 12 }}>
                Hardware with nobody assigned records activity against the store
                but not against a person, so it never reaches the leaderboard.
                Pick a name to fix it.
              </div>
            )}
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Serial</th><th>Model</th><th>Assigned to</th><th>Last seen</th></tr>
                </thead>
                <tbody>
                  {devices.map((d) => (
                    <tr key={d.id}>
                      <td className="ident">{d.serial}</td>
                      <td><span className="pill muted">{d.model}</span></td>
                      <td>
                        {/* Assigning is the whole job of this table, so it's a
                            control rather than a value with an edit affordance
                            hidden behind it. */}
                        <select
                          className="assign"
                          value={d.user_id || ""}
                          onChange={(e) => assignDevice(d.id, e.target.value)}
                        >
                          <option value="">— unassigned —</option>
                          {/* Role is shown because it changes what the
                              assignment does: the leaderboard ranks the sales
                              floor, so hardware assigned to a manager records
                              a name but never appears there. */}
                          {(users || []).filter((u) => u.status === "active").map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.name}{u.role !== "associate" ? ` · ${u.role.replace("_", " ")}` : ""}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="meta mono">{when(d.last_seen_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}

export default function Tenants() {
  const [tenants, setTenants] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const [days, setDays] = useState(30);

  const load = useCallback(() => {
    setError(null);
    api.tenants(days)
      .then(({ tenants }) => {
        setTenants(tenants);
        // Keep the open row in sync after an edit rather than closing it.
        setSelected((cur) => (cur ? tenants.find((t) => t.slug === cur.slug) || null : null));
      })
      .catch((e) => setError(e.message));
  }, [days]);

  useEffect(() => { load(); }, [load]);

  if (error) {
    return (
      <div className="card">
        <div className="notice error">{error}</div>
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={load}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-12">
      <div className="card span-12">
        <div className="card-head">
          <h3>Tenants</h3>
          <div className="btn-row">
            {[7, 30, 90].map((d) => (
              <button key={d} className={`btn small ${d === days ? "primary" : "ghost"}`}
                      onClick={() => setDays(d)}>
                {d}d
              </button>
            ))}
            {!creating && (
              <button className="btn small" onClick={() => setCreating(true)}>New tenant</button>
            )}
          </div>
        </div>

        {tenants === null ? (
          <div className="empty">Loading…</div>
        ) : !tenants.length ? (
          <div className="empty">No tenants yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Retailer</th><th>Slug</th><th>Plan</th><th>Status</th>
                  <th className="num">People</th>
                  <th className="num">Engagements</th>
                  <th className="num">Voice</th>
                  <th className="num">STT min</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((t) => (
                  <tr key={t.id}
                      className={`clickable ${selected?.slug === t.slug ? "selected" : ""}`}
                      onClick={() => setSelected(selected?.slug === t.slug ? null : t)}>
                    <td>{t.name}</td>
                    <td className="ident">{t.slug}</td>
                    <td><span className="pill muted">{t.billing_plan}</span></td>
                    <td>
                      {t.status === "active"
                        ? <span className="meta">active</span>
                        : <span className="pill flame">{t.status}</span>}
                    </td>
                    <td className="num">{compact(t.users)}</td>
                    <td className="num">{compact(t.engagements)}</td>
                    <td className="num">{compact(t.voice_queries)}</td>
                    <td className="num">{Math.round((Number(t.stt_seconds) || 0) / 60)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="meta" style={{ marginTop: 12 }}>
          Usage comes from the daily rollup, not a scan of every event — an
          invoice shouldn't get slower as a retailer gets busier. Click a row
          for its people and hardware.
        </p>
      </div>

      {creating && (
        <CreateTenant
          onCancel={() => setCreating(false)}
          onDone={(t) => { setCreating(false); load(); setSelected(t); }}
        />
      )}

      {selected && <TenantDetail tenant={selected} onChanged={load} />}
    </div>
  );
}
