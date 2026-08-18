/**
 * Preview stand-in for api.js. Aliased over the real client only when the
 * build runs with PREVIEW=1 — see vite.config.js. It is never imported by a
 * production build, so none of this fixture data can reach a real deploy.
 *
 * Exists so the console can be shown to someone without giving them an
 * account, a VPN, or a live tenant to poke at. The numbers below are
 * plausible-but-invented; the *shapes* are copied from real responses so the
 * preview exercises the same rendering paths, including the unhappy ones —
 * one failing check, one warning, one unknown.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const USER = {
  id: "preview",
  email: "you@thefuturebasics.com",
  name: "Preview",
  role: "cue_admin",
  tenant_slug: null,
};

export const session = {
  get token() { return "preview"; },
  get user() { return USER; },
  save() {},
  clear() {},
};

export class ApiError extends Error {
  constructor(status, detail) {
    super(detail || `Request failed (${status})`);
    this.status = status;
  }
}

export const isCueStaff = (user) => user?.role === "cue_admin";

const TENANTS = [
  {
    id: "1", slug: "gap", name: "Gap — pilot", billing_plan: "pilot", status: "active",
    users: 14, engagements: 1_284, voice_queries: 892, stt_seconds: 41_300,
  },
  {
    id: "2", slug: "shopify", name: "Future Basics", billing_plan: "standard", status: "active",
    users: 6, engagements: 341, voice_queries: 210, stt_seconds: 9_450,
  },
  {
    id: "3", slug: "northfield", name: "Northfield Outfitters", billing_plan: "pilot",
    status: "suspended", users: 3, engagements: 0, voice_queries: 0, stt_seconds: 0,
  },
];

const USERS = {
  gap: [
    { id: "u1", name: "Dana Whitfield", email: "dana@gap.example.com", role: "client_admin", status: "active", last_login_at: iso(-40) },
    { id: "u2", name: "Marcus Reyes", email: "marcus@gap.example.com", role: "manager", status: "active", last_login_at: iso(-95) },
    { id: "u3", name: "Sarah Okonkwo", email: "sarah@gap.example.com", role: "associate", status: "active", last_login_at: iso(-12) },
    { id: "u4", name: "Tomas Lind", email: "tomas@gap.example.com", role: "associate", status: "active", last_login_at: iso(-6) },
    { id: "u5", name: "Priya Raman", email: "priya@gap.example.com", role: "associate", status: "disabled", last_login_at: iso(-8_600) },
  ],
  shopify: [
    { id: "u6", name: "Kyle Riggle", email: "kyle@thefuturebasics.com", role: "client_admin", status: "active", last_login_at: iso(-3) },
    { id: "u7", name: "Jo Adeyemi", email: "jo@thefuturebasics.com", role: "associate", status: "active", last_login_at: iso(-220) },
  ],
  northfield: [
    { id: "u8", name: "Ellis Ward", email: "ellis@northfield.example.com", role: "manager", status: "active", last_login_at: iso(-14_400) },
  ],
};

const DEVICES = {
  gap: [
    { id: "d1", serial: "G2-0A41F", model: "g2", assigned_to: "Sarah Okonkwo", last_seen_at: iso(-11) },
    { id: "d2", serial: "G2-0A42C", model: "g2", assigned_to: "Tomas Lind", last_seen_at: iso(-6) },
    { id: "d3", serial: "RING-0117", model: "ring1", assigned_to: "Sarah Okonkwo", last_seen_at: iso(-11) },
    { id: "d4", serial: "G2-0A44B", model: "g2", assigned_to: null, last_seen_at: iso(-2_880) },
  ],
  shopify: [
    { id: "d5", serial: "G2-0B02D", model: "g2", assigned_to: "Jo Adeyemi", last_seen_at: iso(-215) },
  ],
  northfield: [],
};

function iso(minutesAgo) {
  return new Date(Date.now() + minutesAgo * 60_000).toISOString();
}

export const api = {
  login: async () => ({ token: "preview", user: USER }),
  logout: async () => {},
  me: async () => ({ user: USER }),

  platform: async () => {
    await wait(420);
    return {
      service: {
        llm_provider: "anthropic", stt_provider: "groq",
        commit: "686a417", environment: "production",
      },
      database: { configured: true, reachable: true, migrations: 1 },
      counts: {
        tenants_active: 2, tenants_total: 3,
        users_active: 23, associates: 15,
        devices: 19, devices_seen_24h: 14,
        engagements_24h: 168, voice_24h: 97,
      },
      // Deliberately not all-green: a preview where everything passes teaches
      // you nothing about what the panel looks like when it matters.
      checks: [
        { key: "schema", label: "Database schema", status: "ok", detail: "1 migration(s) applied" },
        { key: "staff", label: "CueSea staff accounts", status: "ok", detail: "2 able to sign in" },
        { key: "tenant_admins", label: "Every active tenant has an admin", status: "warn", detail: "no client_admin: northfield" },
        { key: "voice", label: "Voice success rate (24h)", status: "ok", detail: "94/97 answered" },
        { key: "latency", label: "Voice p95 latency (24h)", status: "warn", detail: "3140 ms" },
        { key: "engagements", label: "No stranded engagements", status: "fail", detail: "2 open for over 6 hours" },
        { key: "retention", label: "Retention enforcement", status: "warn", detail: "privacy.retention_days is stored but nothing deletes yet" },
      ],
      checked_at: iso(0),
    };
  },

  tenants: async () => { await wait(280); return { tenants: TENANTS }; },
  tenant: async (slug) => ({ tenant: TENANTS.find((t) => t.slug === slug) }),
  createTenant: async () => { throw new ApiError(403, "Preview build — nothing here writes."); },
  updateTenant: async () => { throw new ApiError(403, "Preview build — nothing here writes."); },

  users: async (tenant) => { await wait(200); return { users: USERS[tenant] || [] }; },
  createUser: async () => { throw new ApiError(403, "Preview build — nothing here writes."); },
  updateUser: async () => { throw new ApiError(403, "Preview build — nothing here writes."); },
  devices: async (tenant) => { await wait(200); return { devices: DEVICES[tenant] || [] }; },

  summary: async () => ({ summary: {} }),

  // --- growth ---------------------------------------------------------------
  // Same discipline as the platform fixture: not all quiet. One lead carries
  // an unanswered reply so the preview shows the flame state on the day it
  // matters, and one row is redacted so that state renders too.
  growthLeads: async () => {
    await wait(260);
    return {
      stages: ["new", "contacted", "replied", "demo", "pilot_scoped",
               "pilot_live", "won", "lost", "nurture"],
      leads: [
        { id: "l1", email: "retail@tecovas.example", name: "Kim H.",
          company: "Tecovas", source: "outbound", stage: "replied",
          touches: 3, last_touch: iso(-2880), last_reply: iso(-190),
          redacted_at: null },
        { id: "l2", email: "ops@studs.example", name: "Anna H.",
          company: "Studs", source: "outbound", stage: "contacted",
          touches: 1, last_touch: iso(-5760), last_reply: null, redacted_at: null },
        { id: "l3", email: "form@merchant.example", name: "Site form fill",
          company: "Marine Layer", source: "site", stage: "new",
          touches: 0, last_touch: null, last_reply: null, redacted_at: null },
        { id: "l4", email: "redacted", name: null, company: "—",
          source: "deck", stage: "lost", touches: 2,
          last_touch: iso(-590000), last_reply: null, redacted_at: iso(-43000) },
      ],
    };
  },
  createGrowthLead: async () => { throw new ApiError(403, "Preview build — nothing here writes."); },
  updateGrowthLead: async () => { throw new ApiError(403, "Preview build — nothing here writes."); },
  growthActivities: async () => ({
    activities: [
      { id: "a1", kind: "email", direction: "in", body: "Sounds interesting — can you do Tuesday?", at: iso(-190), created_by: null },
      { id: "a2", kind: "video", direction: "out", body: "Sent the fitting-room loop Loom", at: iso(-2880), created_by: "Kyle" },
      { id: "a3", kind: "email", direction: "out", body: "First touch — the walk to the back", at: iso(-10080), created_by: "Kyle" },
    ],
  }),
  addGrowthActivity: async () => { throw new ApiError(403, "Preview build — nothing here writes."); },
  growthSources: async () => ({
    days: 90,
    by_source: [
      { source: "outbound", leads: 8, live: 7, advanced: 2 },
      { source: "site", leads: 5, live: 5, advanced: 0 },
      { source: "deck", leads: 3, live: 2, advanced: 1 },
    ],
    by_stage: { new: 5, contacted: 4, replied: 3, demo: 2, lost: 2 },
    by_campaign: [
      { utm_source: "google", utm_campaign: "clienteling-search", leads: 3 },
      { utm_source: "linkedin", utm_campaign: "abm-first-200", leads: 2 },
    ],
  }),
};

export async function probe(name) {
  await wait(300 + Math.round(Math.abs(Math.sin(name.length)) * 400));
  if (name === "Lens") {
    return { name, ok: true, status: null, ms: 604, opaque: true };
  }
  return { name, ok: true, status: 200, ms: name === "AI service" ? 214 : 61 };
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
