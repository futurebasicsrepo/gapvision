import { useCallback, useEffect, useState } from "react";
import { api, compact, when, session, ApiError } from "../api.js";

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
        Leave the password blank and they get an invite by email — a single-use
        link that expires in a week, which is long enough to survive a weekend.
        Typing one here instead means handing a credential over out of band,
        which trains people to accept passwords through channels that should
        never carry them. Prefer the invite.
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

/**
 * Connect Shopify.
 *
 * A merchant creates their own custom app in Shopify admin and pastes the token
 * here. No Shopify review, no OAuth callback, no per-store deployment — which is
 * the whole go-to-market for Shopify POS retailers.
 *
 * Three things this screen is careful about:
 *
 *  · The token is write-only. It goes up once and the API never sends it back,
 *    so what's rendered below is a fingerprint — enough to check against what
 *    Shopify shows you, useless to anyone reading over your shoulder.
 *  · Saving runs a live test immediately. A credential that is stored but never
 *    exercised is how you find out it's wrong from an associate on the floor.
 *  · Scopes are reported individually. "Connected" and "can actually read
 *    customers" are different claims and the panel makes both.
 */
function ConnectShopify({ tenant }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState("admin_token");
  const [form, setForm] = useState({
    store_domain: "", admin_token: "", client_id: "", client_secret: "",
  });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const load = useCallback(() => {
    setError(null);
    api.crm(tenant.slug).then(setState).catch((e) => setError(e.message));
  }, [tenant.slug]);

  useEffect(() => { load(); }, [load]);

  async function run(fn) {
    setBusy(true); setError(null);
    try {
      setState(await fn());
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(e) {
    e.preventDefault();
    const body = mode === "admin_token"
      ? { store_domain: form.store_domain, admin_token: form.admin_token }
      : {
          store_domain: form.store_domain,
          client_id: form.client_id, client_secret: form.client_secret,
        };
    const ok = await run(() => api.connectCrm(tenant.slug, body));
    if (ok) {
      // Don't leave a live token sitting in a React state tree on a machine
      // that's probably shared and definitely unlocked.
      setForm({ store_domain: "", admin_token: "", client_id: "", client_secret: "" });
      setEditing(false);
    }
  }

  async function disconnect() {
    if (!window.confirm(
      `Disconnect ${tenant.name} from Shopify? The token is deleted and this ` +
      `tenant goes back to the demo dataset.`
    )) return;
    await run(() => api.disconnectCrm(tenant.slug));
  }

  const cred = state?.credential;
  const enc = state?.encryption;
  const test = state?.test;
  const missing = cred?.missing_required_scopes || [];
  const showForm = editing || (state && !cred?.connected);

  return (
    <div className="card span-12">
      <div className="card-head">
        <h3>{tenant.name} · Shopify</h3>
        {cred?.connected && !editing && (
          <div className="btn-row">
            <button className="btn small" disabled={busy}
                    onClick={() => run(() => api.testCrm(tenant.slug))}>
              {busy ? "Testing…" : "Test connection"}
            </button>
            <button className="btn small ghost" onClick={() => setEditing(true)}>
              Replace credentials
            </button>
            <button className="btn small ghost" onClick={disconnect} disabled={busy}>
              Disconnect
            </button>
          </div>
        )}
      </div>

      {error && <div className="notice error" style={{ marginBottom: 12 }}>{error}</div>}

      {state === null && !error && <div className="empty">Loading…</div>}

      {enc && !enc.configured && (
        <div className="notice error" style={{ marginBottom: 12 }}>
          This service has no credential encryption key, so it will not accept a
          store token. Set <code>CUE_CRED_KEY</code> on the AI service
          (<code>openssl rand -hex 32</code>) and redeploy. {enc.error}
        </div>
      )}

      {state?.legacy_env && (
        <div className="notice" style={{ marginBottom: 12 }}>
          This tenant is being served from the old <code>SHOPIFY_*</code>{" "}
          environment variables on the AI service — one store per deployment.
          Connect it here and the environment stops being consulted; then remove
          those variables from Railway.
        </div>
      )}

      {cred?.connected && (
        <>
          <div className="checks" style={{ marginBottom: 14 }}>
            <Check
              status={cred.last_test_ok === false ? "fail"
                : cred.last_test_ok == null ? "unknown"
                : missing.length ? "warn" : "ok"}
              label={cred.store_domain}
              detail={
                cred.last_test_ok == null
                  ? "connected but never tested"
                  : `${cred.last_test_detail || ""} · tested ${when(cred.last_tested_at)}`
              }
            />
            {CRM_SCOPES.map((s) => (
              <Check
                key={s.handle}
                status={
                  (cred.scopes || []).includes(s.handle) ? "ok"
                    : s.required ? "fail" : "warn"
                }
                label={s.handle}
                detail={(cred.scopes || []).includes(s.handle)
                  ? "granted"
                  : s.required ? `required — ${s.why}` : `absent — ${s.why} won't work`}
              />
            ))}
          </div>

          <p className="meta" style={{ lineHeight: 1.6 }}>
            Token {cred.fingerprint} · sealed with key{" "}
            <span className="mono">{cred.key_id}</span> ·{" "}
            {cred.auth_kind === "admin_token"
              ? "static Admin API token"
              : "client credentials (re-minted every 24h)"}
            {" · "}updated {when(cred.updated_at)}.
            {" "}The token itself is encrypted at rest and is never sent back to
            this browser — to change it, replace it.
          </p>

          {missing.length > 0 && (
            <div className="notice" style={{ marginTop: 12 }}>
              The connection works but {missing.join(" and ")}{" "}
              {missing.length > 1 ? "are" : "is"} missing, so guest cards will be
              incomplete. Add the scope in Shopify admin → Apps → your custom app
              → Configuration, then <strong>reinstall the app</strong> — a scope
              change doesn't reach an existing token — and paste the new one here.
            </div>
          )}
        </>
      )}

      {showForm && (
        <form onSubmit={save} style={{ marginTop: cred?.connected ? 16 : 0 }}>
          <p className="card-note">
            In Shopify admin: Settings → Apps and sales channels → Develop apps →
            Create an app → Configure Admin API scopes
            (<span className="mono">{(state?.required_scopes || []).join(", ")}</span>,
            plus <span className="mono">read_inventory</span> for live stock) →
            Install app → reveal the Admin API access token.
          </p>

          <div className="btn-row" style={{ marginBottom: 12 }}>
            {[["admin_token", "Admin API token"], ["client_credentials", "Client ID + secret"]]
              .map(([k, label]) => (
                <button key={k} type="button"
                        className={`btn small ${mode === k ? "primary" : "ghost"}`}
                        onClick={() => setMode(k)}>
                  {label}
                </button>
              ))}
          </div>

          <div className="form-grid">
            <label className="field">
              <span>Store domain</span>
              <input value={form.store_domain} onChange={set("store_domain")}
                     required placeholder="future-basics.myshopify.com"
                     autoComplete="off" />
            </label>
            {mode === "admin_token" ? (
              <label className="field">
                <span>Admin API access token</span>
                <input type="password" value={form.admin_token} onChange={set("admin_token")}
                       required placeholder="shpat_…" autoComplete="off" />
              </label>
            ) : (
              <>
                <label className="field">
                  <span>Client ID</span>
                  <input value={form.client_id} onChange={set("client_id")}
                         required autoComplete="off" />
                </label>
                <label className="field">
                  <span>Client secret</span>
                  <input type="password" value={form.client_secret}
                         onChange={set("client_secret")} required autoComplete="off" />
                </label>
              </>
            )}
          </div>

          <p className="meta" style={{ marginTop: 8, lineHeight: 1.5 }}>
            Use the permanent <span className="mono">.myshopify.com</span>{" "}
            address, not a custom domain. Saving tests the connection straight
            away and reports which scopes the token actually carries.
          </p>

          <div className="btn-row" style={{ marginTop: 12 }}>
            <button className="btn primary" type="submit"
                    disabled={busy || !enc?.configured}>
              {busy ? "Connecting…" : cred?.connected ? "Replace and test" : "Connect and test"}
            </button>
            {cred?.connected && (
              <button className="btn ghost" type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </div>
        </form>
      )}

      {test && !test.ok && (
        <div className="notice error" style={{ marginTop: 12 }}>
          <strong>{TEST_HEADLINE[test.reason] || "Couldn't reach the store"}</strong>
          <div style={{ marginTop: 4 }}>{test.detail}</div>
        </div>
      )}
    </div>
  );
}

/** Named individually because "connected" and "can read customers" are
 *  different claims, and a merchant who granted three of four scopes needs to
 *  be told which one they missed rather than that something is wrong. */
const CRM_SCOPES = [
  { handle: "read_customers", required: true, why: "guest identity and tier" },
  { handle: "read_orders", required: true, why: "purchase history and sizes" },
  { handle: "read_products", required: true, why: "recommendations" },
  { handle: "read_inventory", required: false, why: "live floor stock counts" },
];

/** A failed test gets a headline naming which of the plausible things is wrong.
 *  GitHub's undifferentiated "Invalid username or token" cost this project an
 *  afternoon; a merchant onboarding themselves gets the specific sentence. */
const TEST_HEADLINE = {
  token_rejected: "The store rejected this token",
  store_not_found: "No Shopify store at that address",
  unreachable: "Couldn't reach that domain",
  rate_limited: "Shopify is rate-limiting this store",
  api_error: "Shopify refused the query",
  unreadable_credential: "Stored credential could not be opened",
  http_error: "Shopify returned an error",
};

function Check({ status, label, detail }) {
  return (
    <div className={`check ${status}`}>
      <span className="check-dot" />
      <span className="check-label">{label}</span>
      <span className="check-detail">{detail}</span>
    </div>
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
  /** Merge, never replace. `privacy` is a single jsonb column, so PATCHing a
   *  bare `{store_transcripts}` would silently drop retention_days and the
   *  opt-in tiers alongside it. */
  async function setPrivacy(patch) {
    try {
      await api.updateTenant(tenant.slug, {
        privacy: { ...(tenant.privacy || {}), ...patch },
      });
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
                <tr><th>Name</th><th>Role</th><th>Status</th><th>Last seen</th><th></th></tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <PersonRow key={u.id} user={u} onChange={load} onError={setError} />
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

        {/* Privacy posture. Off by default and deliberately a little hard to
            turn on: it is the difference between analytics and a record of
            what staff said near customers. It lives here rather than nowhere
            because it was previously only reachable by a hand-written PATCH,
            which is not a control — it is a trapdoor. */}
        <div className="form-grid" style={{ marginBottom: 10 }}>
          <label className="field">
            <span>Store what was said</span>
            <select
              value={(tenant.privacy || {}).store_transcripts ? "on" : "off"}
              onChange={(e) => setPrivacy({ store_transcripts: e.target.value === "on" })}
            >
              <option value="off">off — intent and latency only</option>
              <option value="on">on — keep questions and answers</option>
            </select>
          </label>
          <label className="field">
            <span>Retention</span>
            <select
              value={String((tenant.privacy || {}).retention_days ?? 90)}
              onChange={(e) => setPrivacy({ retention_days: Number(e.target.value) })}
            >
              {[30, 60, 90, 180, 365].map((d) => (
                <option key={d} value={d}>{d} days</option>
              ))}
            </select>
          </label>
        </div>
        <p className="meta" style={{ marginBottom: 16, lineHeight: 1.5 }}>
          With this on, the manager dashboard shows the question the floor asked
          and the answer Cue gave. Both halves move together — an answer quotes
          the guest's own record back at them, and a question with no answer
          beside it can't be judged.{" "}
          <strong>Retention is not enforced yet</strong>; the number is recorded
          and nothing deletes on it.
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

      {/* Full width and below, because connecting a store is the step that
          takes a tenant off demo data — it deserves more room than a corner of
          the hardware card, and it reads after the people who'll use it. */}
      <ConnectShopify tenant={tenant} />
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


/**
 * One person, operable.
 *
 * The API has been able to change a role, disable an account and resend an
 * invite for a while; the Console could only create people, so in practice
 * those things were done with curl or not at all. A permission model you
 * cannot operate is a permission model you do not have.
 *
 * The role list is capped at the operator's own rank. The server enforces
 * this too - it refuses to grant a role above your own - but offering a
 * choice that will be rejected teaches people the UI is lying to them.
 *
 * Disabling is the incident control, so the confirm says the part that makes
 * it worth pressing: it ends live sessions immediately rather than waiting
 * for a token to expire.
 */
const ROLES = ["associate", "manager", "client_admin", "cue_admin"];

export function PersonRow({ user, onChange, onError }) {
  const me = session.user;
  const myRank = ROLES.indexOf(me?.role || "associate");
  const grantable = ROLES.filter((r) => ROLES.indexOf(r) <= myRank);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const disabled = user.status === "disabled";
  const isMe = me && (me.id === user.id || me.email === user.email);

  async function run(fn) {
    setBusy(true);
    try { await fn(); onChange(); }
    catch (e) { onError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const setRole = (role) => {
    if (role === user.role) return;
    run(() => api.updateUser(user.id, { role }));
  };

  const toggle = () => {
    const next = disabled ? "active" : "disabled";
    if (next === "disabled" && !window.confirm(
      `Disable ${user.name}?\n\n` +
      `Every live session of theirs ends immediately — this does not wait for ` +
      `a token to expire. They keep their history and can be re-enabled.`
    )) return;
    run(() => api.updateUser(user.id, { status: next }));
  };

  const invite = () => run(async () => {
    await api.resendInvite(user.id);
    setSent(true);
    setTimeout(() => setSent(false), 4000);
  });

  return (
    <tr className={disabled ? "row-muted" : ""}>
      <td>
        <div>{user.name}{isMe ? <span className="meta"> · you</span> : null}</div>
        <div className="ident" style={{ fontSize: 11 }}>{user.email}</div>
      </td>
      <td>
        {isMe || grantable.length <= 1 ? (
          <span className="pill muted">{user.role.replace("_", " ")}</span>
        ) : (
          <select className="input-inline" value={user.role} disabled={busy}
                  onChange={(e) => setRole(e.target.value)}>
            {grantable.map((r) => (
              <option key={r} value={r}>{r.replace("_", " ")}</option>
            ))}
          </select>
        )}
      </td>
      <td>
        {disabled
          ? <span className="pill flame">disabled</span>
          : <span className="meta">active</span>}
      </td>
      <td className="meta mono">{when(user.last_login_at)}</td>
      <td className="right">
        <div className="btn-row" style={{ justifyContent: "flex-end", gap: 6 }}>
          {!user.last_login_at && !disabled && (
            <button className="btn small" onClick={invite} disabled={busy}>
              {sent ? "sent" : "Invite"}
            </button>
          )}
          {!isMe && (
            <button className="btn small" onClick={toggle} disabled={busy}>
              {disabled ? "Enable" : "Disable"}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
