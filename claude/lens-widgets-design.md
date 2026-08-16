# The right side becomes widgets — design for the next build

Written 16 Aug 2026 from Kyle's direction, with Even Hub's own Dashboard →
Widgets screen as the reference: *"make the right side modules that can be
reordered in the mobile app… treated like the native dashboard in Even Hub.
Enable widgets and each module is a widget."*

Extends `claude/floor-dm-design.md` and the card deck shipped in 0.3.x.
Nothing there is discarded — this is the deck becoming configurable.

## What is already true

The right-hand region is a stack of three-line cards built by `cardsFor` in
`cards.ts`: the cue, the guest, the picks, then FLOOR. It scrolls with the
ring, a press enters a card and scrolling moves its *content*, and a press
inside leaves. So the deck is already a list of modules with an inside and
an outside. What it is not is **the associate's** list: the order is
hardcoded, membership is a function of the payload, and nothing about it is
configurable from the phone.

## The shape

**A widget is a card with an identity, an order and a switch.** The phone
page grows a Widgets screen in the same shape as Even's: a vertical list of
the enabled widgets, each draggable, each removable, with an *Add widget*
control beneath. A master **Widgets** toggle turns the whole right side on
and off, exactly as the native Dashboard does — off leaves the fact rail and
the cue, which is the 0.2.0 lens and a complete product.

**The lens reads that list and nothing else.** `cardsFor` stops deciding
membership and starts filling in whichever widgets are enabled, in the
associate's order. A widget with nothing to say renders its empty face
("FLOOR QUIET" is the pattern) rather than vanishing, because a deck whose
length changes underneath somebody mid-shift is a deck they cannot learn.

**Navigation is what it already is**, and the review rule decides the edge:
scroll moves between widgets, press enters, scroll inside moves content,
double-press leaves. Double-press at the *top* of the deck stays the system
exit dialog — Even rejects apps that do anything else on the root page — so
"inside a widget" must count as an internal page in `onRootPage()`, exactly
as the floor menu and a guest request already do.

## The widgets

Three exist today and need only an identity:

| Widget | State |
|---|---|
| **CUSTOMER** | Built — the guest card: sizes, cart, history, shipping, contact. |
| **INVENTORY** | Built as the PICK cards — floor stock, price, location, the deictic `focusSku` anchor. |
| **MESSAGING** | Built — the FLOOR card and its menu, now with addressed messages. |

Four are new, and they are not equal in cost:

| Widget | What it needs | Honest difficulty |
|---|---|---|
| **TO DO** | Opening and closing lists, plus manager-assigned tasks. A `tasks` table per tenant, an assign surface in Studio, and completion written back from the ring. | A feature, not a widget. The lens half is easy; the authoring half is a Studio screen nobody has designed. |
| **CLOCK** | Clock in/out and lunch. **This is the one to think hardest about.** The hours themselves already exist as `shifts`, and the switch that governs them — `privacy.shift_telemetry` — is off by default and is described in this codebase as the one control about staff rather than customers, the kind a works council asks about. Turning the glasses into a time clock makes CueSea a workforce-management tool, which is a different product with a different consent story. | Buildable; the question is whether we should, and under whose switch. |
| **PROMOS** | Current promotions. Per-tenant content with a start and end date, authored in Studio or pulled from the CRM. | Small if the copy is hand-authored per tenant; a project if it comes from Shopify's price rules. |
| **SHIFT NOTES** / other | The "other useful information" slot. | Undefined until somebody names it. |

## Where the configuration lives

Two options, and they are not equivalent:

- **On the phone** (`localStorage`, beside the existing preferences). Cheap,
  works today, and wrong the moment somebody picks up a different pair of
  glasses — which is exactly what Kyle's own auto-pairing decision assumes
  will happen.
- **On the person** (a `widgets` array on the user row, fetched at register).
  Follows the associate to whatever hardware they pick up, survives a
  reinstall, and is visible to a manager. Costs an endpoint and a migration.

**Recommendation: on the person, with the phone's copy as the offline
fallback.** The preferences card already proves the local half; this adds a
fetch and a write. Anything else re-teaches every associate their own layout
every time the fleet is reshuffled.

## Open questions for Kyle

1. **Which widgets are in v1?** Recommend: the three that exist (customer,
   inventory, messaging) plus PROMOS as the first new one, because it is
   read-only, per-tenant and needs no new consent conversation. TO DO and
   CLOCK land after, in that order.
2. **Clock in/out — under which switch?** It is staff measurement and
   `shift_telemetry` is the switch that already governs exactly that. Making
   it a widget makes it visible to the wearer, which is *better* than
   measuring silently — but it should not arrive under a UI toggle when the
   privacy board is where this store's answer lives.
3. **Does "Widgets: off" leave the deck empty, or leave the cue?** Recommend
   the cue: the fact rail and the three lines are the product, and the deck
   is what the associate curates around it.
4. **Who authors the to-do lists** — a manager in Studio, or the same list
   every day per store? The first is a screen; the second is a config blob.

## Two things found while looking at this

**The ring's long hold cannot be told apart from a double tap.** Kyle: *"on
home screen, both long hold and double tap bring up the exit pop up."* The
SDK's whole gesture vocabulary is nine values — `CLICK`, `SCROLL_TOP`,
`SCROLL_BOTTOM`, `DOUBLE_CLICK`, `FOREGROUND_ENTER`, `FOREGROUND_EXIT`,
`ABNORMAL_EXIT`, `SYSTEM_EXIT`, `IMU_DATA_REPORT` — and **there is no
long-press event in it**. The firmware is delivering a long hold as
`DOUBLE_CLICK_EVENT`, so the plugin cannot distinguish them and neither can
any other Even app. Since the root page's double-tap *must* raise the system
exit dialog (a review rule we already comply with deliberately), there is
nothing to separate and no fix on our side: a long hold at idle will raise
the exit dialog for as long as the firmware reports it that way. What we can
do is confirm it on device — `client:gesture` already mirrors every raw
event to the server, and the phone's event inspector shows the envelope — so
one long hold on real hardware will say in one line which enum arrived. If
it turns out to be `IMU_DATA_REPORT` or an unmapped ordinal, that changes the
answer and the decoder gains a case.

**The gesture simulators.** They were fixed in 0.3.2 (the mirror subscribes
the mock's events beside the host's), and they live inside the collapsed
**Diagnostics** disclosure on the phone page — a fleet running an older
package, or anyone who has not expanded that drawer, sees buttons that
appear not to work for two different reasons. Worth confirming against
0.4.1 before treating it as a bug.

## Status

Design only — not implemented. The work splits cleanly: the widget list and
its phone screen first (it makes the existing three configurable and is
worth shipping alone), then PROMOS, then the two that need a data model and
a consent decision.
