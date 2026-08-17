# Payments through the Lens

Kyle asked, 17 Aug 2026, against `claude/shopify-pos-what-it-gives-us.md`:
**can we take payment through a Lens UI today, and when can we get rid of the
POS altogether?** Read off Shopify's, Apple's and Stripe's own docs rather
than from memory; sources at the bottom.

This is the strategic frame. Paths A and B were built the same day —
`claude/lens-checkout-and-pos.md` is the build note, and the five source files
that carry a `Path A` / `Path B` comment point back here for the *why*.

## The hard constraint set

**1. Shopify's Tap to Pay is locked inside the Shopify POS app.** The help
docs are explicit: Tap to Pay on iPhone and on Android requires the Shopify
POS app plus Shopify Payments. There is no card-present SDK or API that
Shopify exposes to third parties. Payments extensions exist, but they are
online-checkout gateways for approved partners (custom ones are Plus-gated) —
not card-present, not POS.

**2. The Lens plugin is a WebView inside the Even App**, on the associate's
phone. We cannot embed a native payment SDK — Stripe Terminal or anyone
else's — in a host app we do not own. Any native tap-to-pay path means a
separate Cue companion app on the associate's phone.

**3. Direction of travel.** Shopify is investing hard in owning the in-person
payment surface: Sidekick inside POS, the Victa Mobile handheld, POS Hub.
Betting on them opening card-present rails to third parties is betting
against their roadmap.

## Path A — possible today: the Lens builds the cart, the POS becomes a payment sheet

POS UI extensions have a Cart API that can programmatically drive the POS
cart — `addLineItem`, `addCustomSale`, `setCustomer`, line-item and cart
discounts, and line-item properties (the attribution vehicle: stamp
`cue_session`, associate id and persona onto every line). So:

- Voice or gesture on the glasses — *"Cue, ring her up"* — and the server
  holds the Lens-built cart: guest, items, loyalty discount.
- The Cue POS extension (tile or action) on the same phone: one tap pulls the
  session cart into the POS cart, with the customer attached.
- The associate hits **Charge** → Shopify Tap to Pay on that same
  iPhone or Android. Card-present rates, native receipts, returns and
  exchange flows, correct channel attribution, offline handling — all
  inherited from POS rather than rebuilt.

The POS still exists, but it is reduced from *the place you do everything* to
a payment confirmation sheet. Buildable now: it is a normal Shopify app plus
a POS UI extension against the store we already integrate through the Admin
API. The sell-in is easy — the merchant installs one app, buys no new
hardware, and it works with the Tap to Pay / POS Go / Victa hardware they
already own.

## Path B — POS-free today: the customer's phone is the terminal

`draftOrderCreate` (cart, customer, discounts) → `invoiceUrl` → delivered to
the guest as SMS or email via `draftOrderInvoiceSend`, or as a QR that the
associate's phone — or a fitting-room card — displays. The guest opens it,
Shop Pay one-taps, the order lands in Shopify. No POS app anywhere in the
loop. This works today with scopes we nearly have: add `write_draft_orders`
to the custom app.

The caveats, stated honestly because a merchant will find each of them:

- Processed as an online checkout, so **e-com card rates**, not card-present.
- **Channel attribution**: it is an online order unless we set `sourceName` —
  and a merchant who reports store performance will care about that.
- Requires the guest's phone **and their willingness**. Excellent for
  opted-in loyalty guests — exactly the population we have already
  identified — and wrong for a walk-up paying cash.
- Refunds and exchanges happen in admin, not on the floor.

## Path C — tap to pay in our own companion app (Stripe Terminal)

Technically possible today. The Stripe Terminal iOS and Android SDKs include
Tap to Pay (iPhone XS and newer on current iOS; NFC Android), PIN is
supported, 20-plus countries. It requires Apple's Tap to Pay entitlement —
an application and review, with the distribution entitlement following
internal testing — and a native app, which cannot live inside the Even App
WebView.

Why it is the wrong move **for Shopify merchants**: payment then happens
outside Shopify Payments. We would write the order back with `orderCreate`
marked paid, and the merchant gets a second payout stream, a second
reconciliation, and possible third-party-gateway friction. It also
contradicts the market-evaluation positioning — do not fight Shopify's
payment surface, price at POS-Pro-seat level, do not become a payments
company carrying PCI and AOC burden.

Hold this card for **non-Shopify tenants**: a Gap-style enterprise adapter,
where the payment rails are theirs anyway and "our app plus Stripe or Adyen"
may be the clean answer.

## So when can the POS actually go away?

Not by replacing its payment function alone. The POS survives because of
cash, card-present rates, returns and exchanges on the floor, receipt and
fiscal compliance, offline mode, and staff PINs and permissions. The
realistic sequence:

**Now (pilot): Path A.** The Lens owns discovery through cart; the POS is a
charge sheet. The demo line is that the associate never opens POS until the
moment of payment, and then only to tap Charge.

**Next (3–12 months): Path B as the default** for identified, opted-in
guests — the fitting-room close, *she pays before she's changed back*. The
POS remains for cash, walk-ups and returns. Every guest who pays on their own
phone is a POS transaction that never happened, and the POS-free share
becomes a number we report to the merchant.

**POS actually gone** only when one of three things is true:

1. A merchant's payment mix goes effectively all customer-phone / Shop Pay.
   Single-brand DTC boutiques could get there; measure it in the pilot rather
   than assuming it.
2. Shopify opens card-present rails to third parties. No sign of this, and
   the roadmap points the other way.
3. The tenant is not on Shopify, and we pair the Lens with Stripe or Adyen
   tap-to-pay in a native companion app. Treat this like the camera
   decision — an option we hold, gated on a tenant who asks for it, not a
   build-now.

## Positioning

Never pitch *"we replace your POS"* — that is a fight with Shopify we lose in
the room. Pitch **"checkout comes to the guest"**: zero-lookup through
payment, the POS reduced to a tap. The POS-free share is an outcome we
measure, not a claim we lead with. (Consistent with the market-evaluation
work; the in-repo neighbour is `docs/market-roadmap.md`.)

## Where this stands

1. ~~Cue POS UI extension (tile plus action)~~ — **built**, `packages/pos-app`.
   Needs one `shopify app dev` run on a dev store; the extension has never
   executed inside a real POS.
2. ~~`write_draft_orders` plus `POST /api/checkout-link` plus the Checkout
   card~~ — **built**. Pending the scope on the `cuesea.ai` token and a
   live-store smoke test.
3. **Pilot metric**: the share of Lens-assisted sales closed without the POS
   (Path B) against POS-charge-only (Path A). The draft tag
   `cuesea:floor-checkout` and the `cue:engagement` cart property are the raw
   data for it.
4. **Parking lot**: apply for the Stripe Terminal entitlement only when a
   non-Shopify tenant is real.
5. **Natural next, not built**: wire the camera capture result into the
   Checkout card (scan to basket), and `draftOrderInvoiceSend` for SMS or
   email delivery of the link.

## Sources

All read 17 Aug 2026.

- Payments apps and payments extensions — https://shopify.dev/docs/apps/build/payments
- POS UI extensions overview — https://shopify.dev/docs/apps/build/pos
- Cart API (2026-07) — https://shopify.dev/docs/api/pos-ui-extensions/2026-07/target-apis/contextual-apis/cart-api
- Tap to Pay on iPhone requirements — https://help.shopify.com/en/manual/sell-in-person/shopify-pos/tap-to-pay
- `draftOrderCreate` / `draftOrderInvoiceSend` — https://shopify.dev/docs/api/admin-graphql/latest/mutations/draftOrderCreate
- Stripe Terminal tap to pay — https://docs.stripe.com/terminal/payments/setup-reader/tap-to-pay
- Apple Tap to Pay on iPhone entitlement — https://developer.apple.com/tap-to-pay/

Market context: the market-evaluation note of Aug 2026 (project doc, not in
this repo) and `docs/market-roadmap.md`.
