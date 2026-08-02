# GapVision × Gap App — Presence & Opt-In Integration Spec

**Version 0.1 · August 2026 · Author: Kyle (The Future Basics) · Audience: Gap mobile app engineering, Office of AI, privacy/legal review**

---

## 1. Problem Statement

GapVision gives floor associates e-commerce-level guest context on smart glasses, but it can only know a guest is present if the guest's own device tells it. Today the prototype simulates that signal. Without a supported, opt-in presence feature in the Gap app, the pilot cannot run against real guests — and any alternative identification method (cameras, probe-request sniffing) is a privacy non-starter. This spec defines the smallest feature the Gap app team must ship: an **opt-in, revocable, store-scoped presence signal** tied to the loyalty program.

## 2. Goals

1. A loyalty member can opt in to in-store recognition in under 30 seconds, and opt out just as fast, from the Gap app.
2. When an opted-in member enters a pilot store zone, GapVision receives a presence event within 5 seconds, zone-accurate to the fixture group (e.g., "Denim Wall").
3. Zero guest PII travels in presence events — an opaque, short-lived token only.
4. Consent revocation propagates to GapVision in under 60 seconds, including mid-visit.
5. The feature ships behind a flag, enabled only for the pilot store, with less than one sprint of ongoing maintenance for the app team.

## 3. Non-Goals

- **No background location history.** Presence is detected at store entry and zone level only; no path tracking, no dwell heatmaps of individuals, nothing persisted beyond the visit TTL. (Scope discipline + privacy posture.)
- **No camera- or biometric-based identification, ever.** Out of scope permanently per the GapVision Pro decision framework — not just for v1.
- **No push marketing triggered by presence.** Recognition serves the associate interaction only. Presence-triggered offers are a separate (later, separately consented) initiative.
- **No support for non-loyalty guests.** Opt-in is a loyalty perk; guests without accounts are simply invisible to the system. This keeps consent anchored to an authenticated identity.
- **No Android/iOS parity requirement for v1.** Pilot may launch iOS-first if that halves app-team effort; the associate experience is unaffected.

## 4. User Stories

**Guest (loyalty member)**
- As a loyalty member, I want to turn on "Recognize me in store" so that associates greet me knowing my sizes and my online cart.
- As a loyalty member, I want to turn recognition off at any moment — including while standing in the store — so that I stay in control.
- As a loyalty member, I want to see exactly what an associate sees about me, so that the feature feels like a perk and not surveillance.
- As a first-time opt-in, I want a clear explanation of what is shared and when, so that consent is informed.

**Associate**
- As an associate, I want recognized guests to appear in my lens only when they are in my zone, so that context is timely and relevant.

**Gap app engineer**
- As an app engineer, I want the presence SDK to be a thin, well-bounded module behind a feature flag, so that it cannot affect app stability or review outcomes.

**Privacy officer**
- As the privacy owner, I want an auditable consent record and a kill switch, so that the pilot can pass review and be halted instantly if needed.

## 5. User Experience

**Enrollment.** Settings → Loyalty → "In-Store Recognition" toggle, plus a one-time promo card on the loyalty tab during the pilot. Copy direction: *"Get the online experience in store. Share your style profile with the associate helping you — only while you're in the store, only if you opt in. Turn it off anytime."* The consent screen lists exactly the six fields shared (see §8) and links to the privacy notice.

**In-store.** Nothing visible happens on the guest's phone (no notification spam). Optional P1: a subtle "You're being recognized — tap to pause" ambient row in the app while presence is active.

**Revocation.** The same toggle. Turning it off fires a consent-revoked event; GapVision drops any active session and the associate's lens reverts to idle within 60 seconds.

## 6. Architecture & Sequence

The Gap app embeds a small **Presence SDK** with two detection modes: an OS geofence for store entry/exit (coarse, battery-cheap) and BLE beacon ranging for zone resolution inside pilot stores (Estimote-class hardware, one beacon cluster per fixture zone). On zone entry, the SDK posts a presence event to Gap's API gateway, which forwards to GapVision's presence endpoint. GapVision validates consent, pulls the guest-context card from Gap's loyalty/CRM APIs (server-to-server), and routes it to the zone's assigned associate.

Sequence (happy path):

1. Guest app (opted in) enters store geofence → SDK arms beacon ranging.
2. SDK hears zone beacon `denim-wall` → `POST /v1/presence {guest_token, store_id, zone_id, event: "enter"}`.
3. GapVision server validates token + consent, calls Gap CRM `GET /loyalty/context` (server-to-server).
4. AI service assembles the six-field card + recommendation + script.
5. Associate's glasses render the card; Command Center logs the session.
6. Guest exits zone/store or TTL expires → session ends, presence record deleted.

## 7. API Contract

### 7.1 Presence event (Gap app → GapVision)

```
POST /v1/presence
Authorization: Bearer <gap-gateway service JWT>
{
  "guest_token": "opaque-jwt, 15-min TTL, aud=gapvision, no PII claims",
  "store_id":   "US-0142",
  "zone_id":    "denim-wall",
  "event":      "enter" | "exit",
  "ts":         "2026-08-01T14:22:31Z"
}
→ 202 Accepted | 401 invalid token | 403 consent not active | 429 rate limited
```

`guest_token` is minted by Gap's identity service: an opaque reference the guest cannot be identified from in transit; GapVision exchanges it server-side for the context card. Debounce client-side: no more than one event per zone per 30 s; `exit` is best-effort (server TTL is the backstop).

### 7.2 Consent webhook (Gap identity → GapVision)

```
POST /v1/consent-events
{ "guest_ref": "…", "action": "granted" | "revoked", "ts": "…" }
```

On `revoked`: kill active sessions, purge cached context, ack within 60 s.

### 7.3 Guest context (GapVision → Gap CRM, server-to-server)

```
GET /loyalty/context?guest_ref=…   (mTLS + OAuth2 client-credentials)
→ { tier, points, sizes, open_cart[≤3], recent_purchases[≤5], persona_tags[≤5] }
```

This is the mock `crm.py` contract today — the swap point is one module.

## 8. Data Contract & Minimization

| Field | Source | Shown to associate | Retention in GapVision |
|---|---|---|---|
| First name + last initial | Loyalty profile | Yes | Session only (≤15 min TTL) |
| Loyalty tier + points | Loyalty | Yes | Session only |
| Sizes (tops/bottoms/outerwear) | Profile / purchase-derived | Yes | Session only |
| Open online cart (≤3 items) | Commerce | Yes | Session only |
| Persona tags (≤5) | Precomputed nightly | Indirectly (drives recommendation) | Session only |
| Recent purchases (≤5) | Order history | Never shown raw; drives "already owns" filtering | Session only |

Explicitly **never** requested: payment data, addresses, contact info, birthdate, browsing history, location history.

## 9. Requirements

**P0 — pilot cannot ship without:**
1. Opt-in toggle with informed-consent screen; default OFF. *AC: Given a member who has never opted in, when they view loyalty settings, then recognition is off and no presence events are ever sent.*
2. Presence SDK: geofence arm + beacon ranging + `POST /v1/presence`, feature-flagged to pilot store. *AC: Given an opted-in member entering the pilot store's Denim Wall zone, when the beacon is ranged, then GapVision receives an enter event within 5 s; given any other store, no event is sent.*
3. Opaque guest token; no PII in the event payload. *AC: payload inspection shows no name/email/ID beyond the token.*
4. Consent revocation webhook, ≤60 s end-to-end. *AC: Given an active in-store session, when the guest opts out in the app, then the associate's lens returns to idle within 60 s and cached context is purged.*
5. Server-side presence TTL (15 min) and session purge on exit. 
6. Consent audit log (grant/revoke events, immutable, queryable by privacy team).

**P1 — fast follow:**
7. "You're being recognized — tap to pause" ambient indicator in-app during active presence.
8. "See what associates see" preview screen (renders the guest's own six-field card).
9. Store-level geofence fallback when beacons are unreachable (store-level card, no zone routing).

**P2 — design for, don't build:**
10. Multi-store rollout config (beacon registry service, per-banner flags).
11. Presence-aware associate assignment (route to best-matched associate, not just zone owner).
12. Guest-side visit summary ("what you tried on") as a post-visit loyalty touch.

## 10. Edge Cases

- Two opted-in guests in one zone: queue by arrival; associate lens shows one card at a time with a "+1 waiting" status row.
- Guest opted in but BLE/location off: no events, no degradation — the system simply behaves as if they're anonymous.
- Zone bounce (walking past): 30 s debounce + 10 s dwell threshold before an enter event fires.
- Associate not assigned to zone: card routes to Command Center as unclaimed; any available associate can accept.
- Token expiry mid-visit: SDK silently re-mints; a failed re-mint ends the session server-side at TTL.

## 11. Success Metrics

Leading (pilot weeks 1–4): opt-in rate among pilot-store loyalty visitors (target ≥8%, stretch 15%); presence-event delivery success ≥99%; median beacon-to-lens latency <2 s; revocation propagation p95 <60 s. Lagging (weeks 5–12): recognized-visit conversion vs. control, AOV/UPT lift on recognized visits, opt-out rate after first recognized visit (<10% signals the experience feels like a perk), zero privacy incidents/escalations.

## 12. Open Questions

- **[Gap identity/eng, blocking]** Token minting: can the existing loyalty auth service issue short-lived scoped tokens, or is a new endpoint needed?
- **[Gap legal, blocking]** Does the existing loyalty T&C cover in-store presence sharing, or is a consent-flow addendum required per state?
- **[Gap app eng, non-blocking]** iOS-first or dual-platform for pilot? (Affects timeline, not architecture.)
- **[GapVision + Gap IT, non-blocking]** Does the presence endpoint sit behind Gap's API gateway or is direct mTLS to GapVision acceptable for the pilot?
- **[Store ops, non-blocking]** Beacon mounting/power at the pilot store — fixture power available at Denim Wall and New Arrivals?

## 13. Timeline & Phasing

Assuming pilot target Q4 2026: **Sprint 1** — consent screen + toggle + token minting alignment; **Sprint 2** — presence SDK (geofence + ranging) behind flag, integration tests against GapVision staging; **Sprint 3** — revocation webhook, audit logging, privacy review, beacon install + calibration at pilot store. Total app-team ask: **~3 sprints of one iOS engineer plus part-time backend support** — deliberately small; every heavy component (AI, realtime, glasses client) lives on the GapVision side.
