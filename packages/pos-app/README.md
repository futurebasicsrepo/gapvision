# Cue POS Handoff

One tile in Shopify POS. Tap it, pick the guest your floor is serving, and the
till's cart gets three things in one motion: the customer attached, their cart
lines loaded, and `cue:engagement` / `cue:associate` / `cue:zone` stamped on
the cart as properties — so the sale that closes at the POS is *recorded* as
the engagement the Lens opened, not inferred from timing.

This is Path A of `claude/lens-payments.md`: the POS is reduced to its last
irreplaceable act, Charge. (Path B — no POS at all, the guest pays on their
own phone — lives in the Lens plugin's Checkout card and needs none of this.)

## How trust works (read before touching)

The extension never says which tenant it is. It sends a Shopify **session
token** — a JWT signed with the merchant's own app secret — to
`GET /pos/handoff` on the Cue realtime server. The AI service checks that
signature against the client secret **the same merchant stored in Cue
Console** (Connect Shopify with client ID + secret; a legacy admin-token
connection has no secret on file and is refused with a sentence saying so).
Which floor a till sees is decided by that cryptography.

## Per-merchant setup (the go-to-market shape: no app review, no shared app)

1. In the Shopify **Dev Dashboard**, the merchant opens the same custom app
   they use for Cue (or creates one), with the Admin scopes Cue already asks
   for. Note its **client ID** and **client secret**.
2. In **Cue Console → Tenants → Connect Shopify**, connect the store with
   that client ID + secret (not an admin token) — this is both the CRM
   credential and the POS-token verifier.
3. From this directory: `npm install`, then `shopify app config link`
   (rewrites `shopify.app.toml` against their app), then
   `shopify app deploy`.
4. In POS: Smart grid → Add tile → Cue.

Prerequisites: Node 20+, the Shopify CLI (`npm i -g @shopify/cli`), and for
testing, the POS app signed into a development store (no POS hardware
needed — extensions run in preview during `shopify app dev`).

## Pointing at a different Cue deployment

`CUE_SERVER` at the top of `src/Modal.tsx` is the realtime server. The
pilot's Railway URL ships as the default.

## What it deliberately does not do

- No Admin API calls, no scopes of its own — the cart is written through the
  POS Cart API locally, and everything else arrives from Cue.
- No payment anything. Charging, receipts, refunds stay native POS.
- No roster: the list is *live engagements only*, capped at ten, gone the
  moment an engagement ends.

## Files

- `shopify.app.toml` — per-merchant template; `shopify app config link` owns it.
- `extensions/cue-pos-handoff/shopify.extension.toml` — tile + modal targets,
  API version 2026-07.
- `extensions/cue-pos-handoff/src/Tile.tsx` — the smart-grid tile.
- `extensions/cue-pos-handoff/src/Modal.tsx` — the engagement list and the
  one-tap pull.
- Server side: `packages/server/src/index.js` (`/pos/handoff`, the
  `posSessions` records) and `packages/ai-service/app/pos.py` (token
  verification).

This package is intentionally **not** in the monorepo's npm workspaces — the
Shopify CLI owns its install/build, and its tree must not leak into the
plugin or server builds.
