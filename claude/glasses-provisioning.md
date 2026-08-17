# Glasses provisioning — tenants declare their hardware (design, 17 Aug 2026)

How a new tenant's glasses get identities, and how the floor's registrations
tie back to them. Written against control-plane v0.7 (`claude/control-plane.md`)
and the Meta lens work (`claude/meta-lens-plugin.md`). Companion, runnable
today: the **Lens Sim** in `claude/code/meta-lens-0.2.0.patch` — see the last
section, and the second half of Kyle's ask.

**Where the UI lives.** Cue-staff onboarding happens in **Console** (the
Tenants panel already click-throughs to a tenant's people and devices — this
extends that screen); the same routes are scoped so **Studio** gives
`client_admin`s the identical flow for their own tenant later. Nothing here is
a new boundary: `devices` already exists in the schema ("G2s and rings,
assigned to people, unique serial per tenant"), and device→user binding is
already control-plane Open item 3. This design closes it.

## The shape of the problem

A device row today assumes hardware with a serial in your hand (a G2 you
sideload, a ring you pair). The Meta Web App breaks both assumptions: the lens
is a URL, the glasses expose no serial to it, and nothing is installed. So
identity has to come from something we mint, not something we read — **the
provision token becomes the device identity**, and the serial becomes optional
metadata. Once you accept that, one mechanism serves every surface:

```
Console mints a device  →  token (shown once)  →  carried by the surface's
provisioning medium     →  presented at register  →  row goes live, last_seen ticks
```

Per surface, the medium differs and nothing else does:

| Surface | `surface` value | Provisioning medium | Serial |
|---|---|---|---|
| Even G2 | `even-g2` | QR (the existing sideload QR gains `t=` on the plugin URL) | yes, from the box |
| Meta Ray-Ban Display | `mrbd` | launch URL `https://lens.cuesea.ai/?t=…` (password-protected share during Meta preview) | none exposed — token is the identity |
| Lens Sim | `sim` | the sim URL with `?t=…` | none |

`sim` is a first-class surface on purpose: a tenant being onboarded before
their hardware arrives (exactly today's situation) gets a provisioned,
attributable lens in a browser tab, and everything downstream — engagements,
voice, leaderboards, Studio's floor view — exercises the real pipeline. A sim
device is visibly badged in Console and excludable from analytics
(`WHERE surface != 'sim'`) so demo traffic never pollutes a pilot's numbers.

## Schema (one migration)

```sql
-- 00XX_device_provisioning.sql
ALTER TABLE devices
  ADD COLUMN surface text NOT NULL DEFAULT 'even-g2'
    CHECK (surface IN ('even-g2', 'mrbd', 'sim')),
  ADD COLUMN provision_token_hash text UNIQUE,     -- sha256, same recipe as auth_tokens
  ADD COLUMN provisioned_at timestamptz,
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN last_seen_at timestamptz,
  ADD COLUMN last_seen_meta jsonb;                 -- {mode, app_version, ua} from register
ALTER TABLE devices ALTER COLUMN serial DROP NOT NULL;  -- if currently NOT NULL
-- serial stays UNIQUE per tenant where present; token hash is globally unique
```

Rules, matching the credential patterns already standing: the token is
**shown once at mint, stored only hashed** (the `auth_tokens` recipe — no new
crypto); reissue writes a new hash and stamps `revoked_at` history rather than
deleting; a device with `revoked_at` refuses registration. Engagements gain a
`device_id` column (nullable, backfilled never) — that is the device→user
binding that retires email-based attribution.

## Routes (ai-service, `routes_admin.py`)

All through the existing scoping — `client_admin` reaches only their tenant via
`scope_tenant()`, `cue_admin` reaches any. Responses never echo the token
except the mint/reissue response itself:

```
POST   /api/admin/tenants/{tid}/devices        {surface, label, serial?, user_id?}
       → 201 {device, token, launch_url}       -- token appears HERE and never again
POST   /api/admin/devices/{id}/reissue         → {device, token, launch_url}
POST   /api/admin/devices/{id}/revoke          → {device}
PATCH  /api/admin/devices/{id}                 {label?, user_id?}   -- reassignment
GET    /api/admin/tenants/{tid}/devices        → [{…, last_seen_at, status}]
```

`launch_url` is derived server-side per surface (plugin URL + `t=` for
`even-g2`; `lens.cuesea.ai/?t=…` for `mrbd`; sim URL for `sim`) so Console
never assembles URLs client-side and QR rendering is just "encode this string".
`status` is derived, not stored: `revoked` → `provisioned` (never seen) →
`active` (seen ≤10 min) → `idle`.

And one service-key ingest route, fire-and-forget like the rest:

```
POST /api/ingest/device-heartbeat   {token_hash_preimage?: no — see below}
```

## The register handshake (realtime server)

The plugin/lens already sends `register {role, name, zone, tenant, surface}`
(the Meta lens sends `surface: "mrbd-webapp"` since 0.1.0 — normalize to
`mrbd`). It gains `deviceToken` (from `?t=`, which the Meta lens already
stores as `cue.t`). On register the realtime server calls the AI service —
service key, same channel as every other validation — to resolve the token:

```
POST /api/auth/device   {token, tenant}   → {device_id, user_id?, surface} | 401/403
```

- **Valid**: socket binds `{tenant, device_id, user_id}` at register (a
  socket's tenant is already pinned at register — this rides that exact
  mechanism), heartbeat updates `last_seen_at` + `last_seen_meta` on register
  and hourly. Engagements written by this socket carry `device_id` — the
  attribution fix.
- **Invalid/revoked**: production refuses the register and the lens renders
  `NOT PROVISIONED · SEE YOUR MANAGER` on the idle screen (a lens that
  silently half-works is worse than one that says why). Dev keeps a
  `CUE_DEV_ALLOW_UNPROVISIONED=1` escape hatch so localhost never needs a
  minted token.
- **Token mismatch vs tenant**: same posture as `scope_tenant()` — behave as
  unknown, don't confirm existence.

## Console UI (Tenants → tenant → Devices card)

The card the tenant click-through already implies, grown up:

- **Add glasses**: surface picker (Even G2 / Meta Ray-Ban Display / Lens Sim),
  label ("Denim Wall pair 1"), optional serial, optional assignee from the
  tenant's people. On mint: the one-time token panel — QR (for `even-g2`,
  rendered from `launch_url`), the copyable launch URL, and the sentence that
  it will not be shown again. Same write-only discipline as merchant
  credentials, same UI pattern as the Connect Shopify panel.
- **Rows**: label · surface badge (`sim` visibly distinct, slate not sea) ·
  assignee · status chip · last seen. Row actions: reassign, reissue, revoke.
  Flame only on rows that want attention (revoked-but-recently-seen — a
  revoked token that keeps knocking is the one row worth reading).
- **Tenant creation flow** gains one optional step: "how many pairs, which
  surface" → bulk-mints labeled devices, prints a QR sheet / URL list. A new
  tenant leaves onboarding with their glasses already identified.

Studio (client_admin) reuses the same routes and card verbatim, minus tenant
selection. Build Console-first; the Studio mount is a route + nav item.

## The Lens Sim in Console (Kyle's second question)

Yes — and it exists as of tonight, hardware-free by construction. The Meta
lens is a Web App, so **the browser replica is not a replica: it is the
identical bundle the glasses run**, drawn in an iframe at 600×600.
`sim.html` (in the 0.2.0 patch) wraps it in a right-lens frame with a driver
panel — the mock-CRM trio as guest signals, the Neural Band as a button pad,
classic↔meta switchable at idle — and drives it over a same-origin
postMessage bridge (`cue:display` / `cue:idle` / `cue:gesture`). Run it today
with `npm run dev` in `packages/meta-lens` → `/sim.html`. The G2 half of this
story already exists separately (the MockBridge virtual lens); the Lens Sim is
its Meta-side sibling with a real device frame around it.

Console embedding is one panel: serve the built `meta-lens/dist` under the
console's own origin (a `/lens-sim/` static mount in the Vercel project — the
bridge is same-origin-only *on purpose*; do not loosen it to embed
cross-origin, because a page that can iframe the lens cross-origin could drive
it) and iframe `sim.html` in a new **Lens Sim** rail item. Two modes there:

- **Demo drive** (works with zero backend): what ships in the patch.
- **Live drive**: the iframe carries a minted `sim` device token and connects
  to the realtime server like any lens; the driver panel is then replaced by
  the real beacon flow — fire a guest from the seeded `cuesea.ai` store and
  watch the same payload hit the sim lens and Studio at once. That is the
  pre-hardware acceptance test for the whole Meta path.

## Build order

1. **Migration + `/api/auth/device` + mint/list routes** — the spine; pytest
   negatives mirror the credential suite (no token readback, cross-tenant mint
   refused, revoked refused, response bodies never contain a hash).
2. **Realtime register handshake** + `device_id` on engagements (attribution).
3. **Console Devices card** (mint → QR/URL → status chips), Console-first.
4. **Lens Sim rail item** embedding `sim.html` (demo drive), then live drive
   with a `sim` token once 1–2 land.
5. **Studio mount** of the same card for client_admins.
6. When Meta hardware arrives: mint an `mrbd` device, put the launch URL into
   Meta's preview share flow, and the provisioning path is proven end to end
   with zero new code.

Prerequisite from the standing list: the sandbox couldn't reach the repo this
session (no PAT — item 7/9 on the rotation list), so steps 1–5 are specified
here rather than committed. First session with repo access: `git am` the
0.2.0 patch for the lens+sim, then implement 1–3 directly.

## Open questions

- Does `devices.serial` carry a NOT NULL today? (Migration assumes it may —
  drop it if so.) Check `migrations/` for the exact devices DDL.
- Ring pairing: rings stay serial-first — do they also want tokens for
  consistency, or is BLE pairing to a provisioned phone enough? Lean: leave
  rings as-is until a ring feature needs attribution.
- Meta preview's password-protected URL share: whether the password wraps the
  URL itself or the app listing decides how much the launch-URL token must
  carry alone. Test when hardware arrives; if the URL is shareable-secret
  enough, consider short-lived tokens + re-mint from Console.
- QR sheet printing for bulk onboarding: the plate generator
  (`plates-requests-panel.md`) already renders QR artwork — reuse it rather
  than a second QR path.

---

## Read off the schema before building — 17 Aug 2026

The Open questions above ask what `devices` actually looks like. It is in
`migrations/001_spine.sql` and it answers one question and raises two the
spec did not anticipate. All three change the migration.

**1. `serial` is `NOT NULL` today.** So the `DROP NOT NULL` is required, not
conditional. The `UNIQUE (tenant_id, serial)` that comes with it is fine as
written: Postgres treats NULLs as distinct, so any number of token-only
devices coexist per tenant without a partial index.

**2. `last_seen_at` already exists.** The migration as drafted adds it, which
will fail with *column already exists* and take the whole migration with it.
Drop that line; keep `last_seen_meta`.

**3. `model` will refuse every new surface, and the spec never mentions it.**

```sql
model text NOT NULL CHECK (model IN ('g2', 'g1', 'ring1'))
```

A Meta Ray-Ban Display is not a `g2` and a Lens Sim is not hardware at all,
so minting either one fails the check constraint before `surface` is ever
consulted. This is the one that would have looked like a bug in the mint
route rather than in the migration. Two ways out, and they are not equal:

- **Widen the check** — add `'mrbd'` and `'sim'`. Cheap, and leaves `model`
  and `surface` carrying overlapping meaning forever.
- **Make `model` nullable and let `surface` own the question.** `model` then
  means what it always meant — which *hardware* this is, where hardware
  exists — and `surface` means which lens runs on it. A sim has a surface and
  no model, which is exactly true.

Recommend the second, because the first creates two columns that must agree
and nothing to enforce that they do.

**4. `status` is already a stored column**, with `('active','retired','lost')`
— a different vocabulary from the derived `revoked → provisioned → active →
idle` this spec describes. Two things called status, one stored and one
computed, will be misread. Recommend the derived one is named something else
in the API response (`presence`, say) rather than shadowing a column that
means "is this hardware still in service".

None of this changes the design. It changes the migration, and it is cheaper
to know now than after the first mint fails in Console.
