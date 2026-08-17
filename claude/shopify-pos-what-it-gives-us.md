# Shopify POS — what it would actually give us

Kyle asked, 17 Aug 2026, against the market roadmap's POS line. Read off
Shopify's own docs rather than from memory; sources at the bottom.

## The shape of it

POS is not an API we call. It is **a surface we build into** — a second app
extension (Preact + Polaris, its own TOML, its own review), rendered inside
the merchant's till app. Three kinds of placement:

- **Tile** — a button on the POS home grid.
- **Action** — a menu item on a native screen, usually opening a modal.
- **Block** — inline content on a native screen, including receipts.

Each placement is handed a different set of **target APIs**: Cart, Cart
Line Item, Customer, Draft Order, Order, Product.

## What it gives us that we do not have

**1. A guest signal that costs nothing to install.** When a staff member
attaches a customer to a cart, an extension can see it — the Cart API is
subscribable, so we learn who is standing at the till *as it happens*.
That is a new front door in the existing model, and its consent kind is
already defined: `assisted`, because a member of staff deliberately looked
that person up. No plate, no QR, no beacon, no phone.

**The caveat that decides how useful it is:** since April 2025 the
subscribable hook returns **`customerId` only** — `email`, `firstName`,
`lastName` and `note` were removed. To turn that id into a person we call
the Admin API with `read_customers`, which is a scope we already ask for
and a credential we already hold per tenant. So the door works, but it is
an id plus a lookup rather than a record arriving free.

**2. The real basket, live.** Today "what's in their cart" means their
*online* cart. At the till we would have the actual one, line by line, as
it is being built — which is a materially better cue than the one we
compose now, and the only version of it that is true for a walk-in.

**3. Attribution with evidence instead of inference.** `addLineItemProperties`
writes arbitrary key/values onto a line — Shopify's own example is
`employee: '472'`. That means the associate who helped can be stamped onto
the sale at the moment it happens. Today attribution is inferred from
engagements and proximity in time; this closes the loop with a fact, and
attributed sales are the number the whole product is sold on.

**4. A place to put an answer where the money is.** Blocks can render on
receipts and on checkout screens — a channel we have no equivalent for.

## What it does not give us

**It is not a floor signal.** POS knows about a customer when somebody is
checking them out or has pulled up their record at the till. It says
nothing about the person who walked in four minutes ago and is standing in
front of the denim wall — which is the moment this product exists to serve.
So POS **does not remove the "can produce a guest signal" gate**; it adds a
late-funnel door beside it. Worth being precise about, because it is easy
to read "POS integration" as solving the identification problem and it
solves the last ten metres of it.

**It is not inventory.** An extension can *show* availability across
locations, but the data still comes from the Admin API we already use.
Nothing here fixes verbatim size labels or the empty-inventory answer.

**It only pays for merchants who run Shopify POS**, which is a narrower set
than "runs Shopify". It removes no gate on its own — it deepens the value
for accounts already inside all six.

## What it would cost

A second extension surface with its own build, its own review and its own
release cadence, plus `read_customers`. That is not free, and it competes
directly with the roadmap's Phase 1 claim that the *hardware* requirement
is the binding constraint rather than the data one.

## Recommendation

**Worth doing, second — and for attribution first, identification second.**
The strongest single argument is (3): stamping the associate onto the line
item turns the number we sell on from an inference into a record. The guest
signal (1) is real but late; the live basket (2) is a genuine improvement to
the cue for walk-ins.

Against Phase 1 (phone-and-earbud mode) it is the weaker bet, because it
deepens accounts we already have rather than widening who can buy. Against
Phase 2 (bring-your-own-feed) it is arguably stronger, since it is
concrete, well-documented and lands inside an ecosystem we already speak.

## Sources

- POS UI extensions overview — https://shopify.dev/docs/apps/build/pos
- Target APIs — https://shopify.dev/docs/api/pos-ui-extensions/2026-01/target-apis
- Cart API — https://shopify.dev/docs/api/pos-ui-extensions/2026-07/target-apis/contextual-apis/cart-api
- POS API, line item properties and `setCustomer` — https://shopify.dev/docs/api/app-home/apis/device-and-platform-integration/pos-api
- Customer fields removed from the subscribable hook (22 Apr 2025) —
  https://shopify.dev/changelog/pos-ui-extensions-cart-api-customer-fields-removed-from-subscribable-hook
