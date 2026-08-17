# Payments through the Lens — what was built (17 Aug 2026)

Kyle's ask, against `claude/shopify-pos-what-it-gives-us.md` and the payments
exploration: build Path A and Path B. Both are in this commit. The strategic
frame (why not Path C / Stripe Terminal, when the POS can actually disappear)
lives in the project doc `claude/lens-payments.md`; this file is the build.

## The one sentence per path

**Path B — the guest's phone is the terminal.** Lens phone page → Checkout
card → `POST /api/checkout-link` → `draftOrderCreate` through the tenant's own
sealed credential → the draft's `invoiceUrl` drawn as a QR. The guest pays at
the *store's own* checkout (Shop Pay included, details pre-filled when the
draft names the customer). Cue never touches the payment.

**Path A — the POS reduced to Charge.** A Cue tile inside Shopify POS lists
the floor's live engagements; one tap attaches the customer, loads the cart
lines, and stamps `cue:engagement` / `cue:associate` / `cue:zone` onto the
cart as properties. Attribution becomes a recorded fact on the order.

## What changed, where

### ai-service

- `app/crm_shopify.py` — `create_checkout_link()` (the adapter's one write:
  `draftOrderCreate`, validated against the 2026-07 Admin schema; refuses
  loudly without `write_draft_orders`). `lookup_code` and `_open_cart` now
  carry `variant_id`, so a scan or an online-cart line becomes a *real*
  variant line, not a title that looks like one. Custom lines keep the
  deprecated currency-less `originalUnitPrice` deliberately — the shop's own
  currency is the only right answer on the shop's own floor.
- `app/checkout.py` — new. Resolution (`code` → `lookup_code`, `variant_id`
  passthrough, title+price fallback), the refusal vocabulary
  (`CheckoutRefused`: 400/403/422/501/502, each a sentence), the QR as inert
  '1'/'0' rows (same shape as Console's device QRs), MAX_LINES=20. Skipped
  lines are *named in the response*, never dropped — a guest paying for three
  things because the fourth vanished is worse than no link.
- `app/pos.py` — new. POS session-token verification: ~20 lines of stdlib
  hmac, alg pinned to HS256, signature checked before the clock (an expiry
  read from an unverified payload is attacker-controlled). Shop domain →
  tenant via the `tenant_crm_credentials` row; requires `auth_kind =
  client_credentials` — the merchant's client secret is both the CRM
  credential and the token verifier, one paste in Console.
- `app/capabilities.py` — `checkout_links`, config posture (on unless a store
  we reached said no); the binding gate is the token's scopes.
- `app/main.py` — `POST /api/checkout-link` (guarded like guest-context),
  `POST /api/pos/verify` (guarded with slug "pos", deliberately not a demo
  tenant, so demo mode never opens this door).
- `MockCRM.create_checkout_link` — demo world mints `demo.cuesea.ai/checkout/…`
  with real arithmetic; the number on the lens is the believable part.

### realtime server

- `proxy.js` — `POST /api/checkout-link` passthrough with the service key
  attached (machine call, exactly like guest-context).
- `index.js` — `posSessions` per tenant: one record per **live** engagement
  (deleted on session end and on disconnect), deliberately separate from
  `activeSessions`, which the dashboard broadcasts — the handoff record
  carries ids and cart lines the manager view has no business receiving as a
  side effect. `GET /pos/handoff`: Bearer session token → AI verify → that
  tenant's live engagements in POS vocabulary (numeric ids via `numericGid`).

### glasses-plugin

- Checkout card on the phone page (`mountCheckoutCard`), gated on
  `checkout_links` with the floor card's fail-open posture. Items: the open
  online cart (toggles, on by default), the pick on the lens (off by default —
  a titled line, priced as shown, because `floor_inventory` carries no variant
  ids yet), typed codes (resolved server-side, misses named). Draws the QR
  black-on-white on a canvas — the one element on the page a *guest's* camera
  reads. `associateName` from `getUserInfo` rides on the draft's note.
- `vision.ts` `Capabilities` + fetch mapping gained `checkout_links`.

### packages/pos-app (new, NOT in npm workspaces)

Tile + modal, Preact + `s-*` POS web components, API 2026-07. Per-merchant
app: `shopify app config link` against the merchant's own Dev Dashboard app —
no Shopify review, same go-to-market as the CRM connection. `CUE_SERVER` in
`Modal.tsx` is the realtime URL. See its README for the merchant steps.

## Tests

- `tests/test_checkout.py` — 15: the mint (fixture transport), the mock's
  arithmetic, resolution + skip reporting, every refusal status, QR inertness,
  endpoint auth + refusal mapping.
- `tests/test_pos.py` — 10: good token, forged signature, `alg:none` and
  RS256 pinning, expiry ± leeway, wrong audience, non-Shopify dest, malformed
  shapes, lookup refusal passthrough, endpoint key + no-database sentence.
- Plugin: tsc clean, cards 22 / page-shape 50 / capabilities 33 all green,
  `build:plugin` builds. `test_vision.py` capability set updated
  (+`checkout_links`), 104 green.
- Pre-existing failures, NOT from this work (confirmed on stashed main):
  `test_shopify_adapter` standalone (script-lines drift) and
  `test_vision_barcode` (decoder returns [] in this sandbox).

## What only a store / a device can answer

1. Run `/api/checkout-link` against `cuesea.ai` once its token carries
   `write_draft_orders` — the fixtures model the shapes, not the store.
2. `shopify app dev` on a dev store for the POS extension — component props
   and Cart API calls follow the 2026-07 docs but have never executed.
   The CLI scaffold (`shopify app generate extension`) is authoritative if
   anything drifted.
3. The QR on a real phone screen through a real guest camera (density is
   error-level M, same as the plates).
4. Scan-to-basket: typed codes work; wiring the *camera* capture result into
   the Checkout card is a natural next step and deliberately not in this
   commit.

## Decisions that will be questioned later

- **Draft orders, not orders.** The mildest write Shopify has; payment,
  receipt, refund, fraud stay the store's problem. This is the entire point.
- **No Stripe Terminal.** A native tap-to-pay app cannot live in the Even App
  WebView, splits the merchant's payouts, and makes Cue a payments company.
  Parked for non-Shopify tenants (see the project doc).
- **`checkout_links` fails open** (config posture, like floor comms), because
  the real gate is the store's own token scopes and a network blip must not
  take checkout away for a shift. The camera's fail-closed reasoning does not
  apply: no personal data appears that the engagement hadn't already surfaced.
- **The pick is a custom line.** Until `floor_inventory` carries variant ids,
  a titled line at the price the guest was shown beats a lookup that misses
  on a handle. When that lands, delete the comment in `renderLines` and send
  a `variant_id`.
