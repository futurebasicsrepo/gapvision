/**
 * Cue Console API client.
 *
 * Same backend as Cue Studio, reached through the realtime server's
 * passthrough routes so there is one origin to allow and no service key in a
 * browser. The difference from Studio's client is the role gate below.
 */
const BASE = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";

/** Deliberately a different key from Cue Studio's `cue.token`. They're on
 *  separate origins so they can't collide anyway, but if the two are ever
 *  served from one host by accident, signing into one must not sign you into
 *  the other. */
const TOKEN_KEY = "cue.console.token";
const USER_KEY = "cue.console.user";

export const session = {
  get token() {
    try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  get user() {
    try { return JSON.parse(sessionStorage.getItem(USER_KEY) || "null"); } catch { return null; }
  },
  save(token, user) {
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
      sessionStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch { /* private mode — the session just won't survive a reload */ }
  },
  clear() {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(USER_KEY);
    } catch { /* nothing to clean up */ }
  },
};

export class ApiError extends Error {
  constructor(status, detail) {
    super(detail || `Request failed (${status})`);
    this.status = status;
  }
}

async function request(path, { method = "GET", body, auth = true } = {}) {
  const headers = { "content-type": "application/json" };
  if (auth && session.token) headers.authorization = `Bearer ${session.token}`;

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Can't reach the server.");
  }

  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { detail: text.slice(0, 200) }; }

  if (!res.ok) {
    if (res.status === 401 && auth && session.token) session.clear();
    throw new ApiError(res.status, data.detail || data.message);
  }
  return data;
}

/**
 * The role gate.
 *
 * The API already refuses everyone but Cue staff — every staff route calls
 * `require(me, "cue_admin")`, and the schema forbids a cue_admin from having a
 * tenant at all. This check adds nothing to that; it exists so a retailer's
 * admin who somehow reaches this URL gets a clear "not for you" instead of a
 * shell that 403s on every panel and looks broken.
 *
 * Treat it as a courtesy, never as the boundary. The boundary is server-side.
 */
export const isCueStaff = (user) => user?.role === "cue_admin";

export const api = {
  login: (email, password) =>
    request("/auth/login", { method: "POST", body: { email, password }, auth: false }),
  logout: () => request("/auth/logout", { method: "POST" }).catch(() => {}),
  me: () => request("/auth/me"),

  // --- platform -------------------------------------------------------------
  platform: () => request("/api/admin/platform"),

  // --- tenants --------------------------------------------------------------
  tenants: (days = 30) => request(`/api/admin/tenants?days=${days}`),
  tenant: (slug) => request(`/api/admin/tenants/${encodeURIComponent(slug)}`),
  createTenant: (body) => request("/api/admin/tenants", { method: "POST", body }),
  updateTenant: (slug, body) =>
    request(`/api/admin/tenants/${encodeURIComponent(slug)}`, { method: "PATCH", body }),

  // --- CRM credentials ------------------------------------------------------
  // The token goes up and never comes back: every response here carries a
  // fingerprint and a scope list, never the secret. Nothing in this client
  // stores it either — the input is cleared the moment the request resolves.
  crm: (slug) => request(`/api/admin/tenants/${encodeURIComponent(slug)}/crm`),
  connectCrm: (slug, body) =>
    request(`/api/admin/tenants/${encodeURIComponent(slug)}/crm`, { method: "PUT", body }),
  testCrm: (slug) =>
    request(`/api/admin/tenants/${encodeURIComponent(slug)}/crm/test`, { method: "POST" }),
  disconnectCrm: (slug) =>
    request(`/api/admin/tenants/${encodeURIComponent(slug)}/crm`, { method: "DELETE" }),

  // --- people and hardware --------------------------------------------------
  // Staff have no tenant, so they are unreachable through /users - that route
  // is tenant-scoped by construction and would have to be weakened to see them.
  staff: () => request("/api/admin/staff"),
  createStaff: (body) => request("/api/admin/users", { method: "POST", body: { ...body, role: "cue_admin" } }),
  users: (tenant) => request(`/api/admin/users?tenant=${encodeURIComponent(tenant)}`),
  createUser: (body) => request("/api/admin/users", { method: "POST", body }),
  updateUser: (id, body) => request(`/api/admin/users/${id}`, { method: "PATCH", body }),
  // Invites landed with the mailbox. Resend covers the two real cases: the
  // first one expired (a week), and it went to a typo'd address.
  resendInvite: (id) => request(`/api/admin/users/${id}/invite`, { method: "POST" }),
  devices: (tenant) => request(`/api/admin/devices?tenant=${encodeURIComponent(tenant)}`),
  updateDevice: (id, body) => request(`/api/admin/devices/${id}`, { method: "PATCH", body }),

  // --- retention ------------------------------------------------------------
  retention: () => request("/api/admin/retention"),
  runRetention: () => request("/api/admin/retention/run", { method: "POST" }),

  // --- plates ---------------------------------------------------------------
  // These live on a second APIRouter in routes_guest.py that also mounts at
  // /api/analytics, so grepping the source for "analytics/plates" finds
  // nothing. The realtime proxy passes /api/analytics through, so no plumbing.
  plates: (tenant) =>
    request(`/api/analytics/plates?tenant=${encodeURIComponent(tenant)}`),
  revokePlate: (tenant, token) =>
    request(`/api/analytics/plates/${encodeURIComponent(token)}/revoke` +
            `?tenant=${encodeURIComponent(tenant)}`, { method: "POST" }),

  // --- analytics, for the usage column -------------------------------------
  summary: (tenant, days = 7) =>
    request(`/api/analytics/summary?days=${days}&tenant=${encodeURIComponent(tenant)}`),
};

/**
 * Probe a service from this browser. Returns a shape the UI can always
 * render — an unreachable service is a result, not an exception.
 *
 * Two modes, because the two kinds of target answer differently:
 *
 *   · our own `/health` routes send CORS headers, so the status and body are
 *     readable and worth reporting.
 *   · a static frontend on Vercel does not. Reading it cross-origin always
 *     fails, which would report a perfectly healthy site as down. `opaque`
 *     uses no-cors: the response is unreadable by design, so the only signal
 *     is whether the request completed at all — which is exactly the question.
 *
 * Always time-boxed. A probe with no timeout doesn't fail, it hangs, and a
 * health panel stuck on "checking…" is worse than one reporting a problem.
 */
export async function probe(name, url, { opaque = false, timeoutMs = 6000 } = {}) {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      mode: opaque ? "no-cors" : "cors",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (opaque) return { name, url, ok: true, status: null, ms: elapsed(), opaque: true };
    let body = null;
    try { body = await res.json(); } catch { /* not every health route is JSON */ }
    return { name, url, ok: res.ok, status: res.status, ms: elapsed(), body };
  } catch (e) {
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    return {
      name, url, ok: false, status: 0, ms: elapsed(),
      error: timedOut ? `no answer in ${timeoutMs / 1000}s` : String(e.message || e),
    };
  }
}

export const compact = (n) => {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}K`;
  return v.toLocaleString();
};

export const money = (cents) =>
  `$${((cents || 0) / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export const when = (iso) => {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "—";
  }
};
