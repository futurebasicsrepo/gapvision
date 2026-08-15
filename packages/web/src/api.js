/**
 * API client.
 *
 * Everything goes through the realtime server on one origin: the socket, the
 * proxied guest data, and the signed-in-human routes. The dashboard is a
 * static bundle, so it holds a *user's* token and never a service key.
 */
const BASE = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";

const TOKEN_KEY = "cue.token";
const USER_KEY = "cue.user";

/** sessionStorage, not localStorage: a shared back-office machine shouldn't
 *  keep a manager signed in after the tab closes. */
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
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Is the realtime service up?");
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    // An expired token should drop us to the sign-in screen, not show a wall
    // of 401s behind a dashboard that looks live.
    if (res.status === 401 && auth && session.token) session.clear();
    throw new ApiError(res.status, data.detail || data.message);
  }
  return data;
}

export const api = {
  login: (email, password) =>
    request("/auth/login", { method: "POST", body: { email, password }, auth: false }),
  logout: () => request("/auth/logout", { method: "POST" }).catch(() => {}),
  me: () => request("/auth/me"),

  // Cue staff aren't scoped to a retailer, so they name the tenant. Everyone
  // else is pinned to their own and the parameter is ignored server-side.
  summary: (days = 1, t) => request(`/api/analytics/summary?days=${days}${tq(t)}`),
  leaderboard: (days = 7, t) => request(`/api/analytics/leaderboard?days=${days}${tq(t)}`),
  engagements: (limit = 15, t) => request(`/api/analytics/engagements?limit=${limit}${tq(t)}`),
  voice: (limit = 15, t) => request(`/api/analytics/voice?limit=${limit}${tq(t)}`),
  // Declared on a second APIRouter in routes_guest.py that also mounts at
  // /api/analytics, so the source never contains the literal path. Returns
  // both what is waiting right now and the demand history.
  requests: (days = 7, t) => request(`/api/analytics/requests?days=${days}${tq(t)}`),
  tenants: () => request("/api/admin/tenants"),
  users: (t) => request(`/api/admin/users${tq(t, true)}`),
  devices: (t) => request(`/api/admin/devices${tq(t, true)}`),
};

const tq = (tenant, first = false) =>
  tenant ? `${first ? "?" : "&"}tenant=${encodeURIComponent(tenant)}` : "";

export const money = (cents) =>
  `$${((cents || 0) / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

export const compact = (n) => {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}K`;
  return v.toLocaleString();
};

export const duration = (seconds) => {
  const s = Math.round(Number(seconds) || 0);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

export const clock = (iso) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "—";
  }
};
