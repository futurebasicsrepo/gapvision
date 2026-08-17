# Phone first — what it takes, and what is actually in the repo

Kyle, 17 Aug 2026: *"I like the pitch around delivery to the phone and not
letting glass hold back shipping this to clients. How do we wrap this tool up
and make it a super slick experience for POS and phones that are already in
employees' pockets."*

This answers that. It starts with a correction, because the pitch is ahead of
the code.

---

## The correction

`/customers` section 05 says **"Start on the phone in their pocket… This is
where a pilot starts."** There is no phone app. If a merchant said yes on
Monday, we would have nothing to hand them.

The evidence, so this is checkable rather than an opinion:

- `packages/web/src/App.jsx:15` — `VIEWS` gives `associate` no views at all,
  with the comment *"An associate has no business in here at all — their
  surface is the lens."* An associate who signs into Studio gets a card that
  says *"Associates don't have a dashboard — your surface is Lens, in the
  glass."*
- `packages/web/src/components/AssociateView.jsx` is 160 lines labelled
  *"Beacon Simulator"* and *"Full Sales Script (phone view)"*. Studio's own
  navigation files it under **Simulator**, after the real views. It is a demo
  harness and says so.
- No `manifest.webmanifest`, no service worker, no `apple-mobile-web-app-*`
  anywhere in the repo. Nothing is installable.
- The only thing an associate can run today is the Even Hub `.ehpk`
  (`packages/glasses-plugin/app.json`) — which is to say, the thing that
  requires the glasses.

`docs/market-roadmap.md` already calls this Phase 1 and "the big one". It is
right about the priority and slightly out of date about the method: it
proposes a third `bridge.ts` implementation. Since it was written we built
something better to start from.

## The part that is further along than it looks

`packages/meta-lens` is **already a phone app that has never been pointed at a
phone.** 981 lines, and its own README's first paragraph is the reason:

> a standard HTML/CSS/JS app rendered by the glasses themselves. **No phone
> page, no bridge SDK.**

Concretely, what it does not need in order to run in Safari on an associate's
iPhone right now:

| | Status |
|---|---|
| Transport | `socket.io-client` straight to the realtime server over HTTPS. No SDK, no BLE, no host app. |
| Identity | `?t=<token>&tenant=<slug>` on the launch URL, persisted to `localStorage`. Exactly the URL `devices.launch_url()` already mints. |
| Grammar | `deck.ts` / `grammar.ts` — pure modules, no DOM, no socket, tested under `node --test`. |
| Input | `input.ts` narrows everything to six gestures: `prev next up down select back`. |
| Rendering | Ordinary CSS into a 600×600 box. |

That last row is the whole port. `input.ts` maps *keyboard* to `LensGesture`
because the Neural Band arrives as arrow keys. A phone needs a second source —
touch — feeding the same six-value union. Nothing downstream of that union
changes, which is the payoff for having written the deck as a pure module in
the first place.

And provisioning already covers it: `011_device_provisioning.sql`, the
mint/revoke routes, the QR, presence, the Console card. A phone is a device
that opens a URL, and that is the only kind of device that spine knows how to
make.

So the honest summary: **the phone surface is one package and one input
adapter from existing, not one product from existing.**

---

## What "slick" means on a phone

The temptation is to treat the phone as the degraded rung on the ladder and
build a smaller Studio. That would produce something that works and that
nobody uses. Four things decide it, in order of how badly each one hurts when
skipped.

### 1. It has to arrive, not be opened

This is the entire product claim. `/customers`: *"Every other tool on this
floor asks the associate to break eye contact, pick up a device and search.
cuesea is the one where the answer arrives instead."*

On glass that is free — the sentence is already in their eye. On a phone, a
request that requires noticing, unlocking and opening is a request that gets
missed on a busy floor, and once it is missed twice the app is dead. So:

- **Web Push, with notification actions.** The request lands on the lock
  screen carrying the sentence, with **Claim** and **Pass** as buttons.
- **Claiming happens from the notification**, in the service worker, without
  opening the app. Opening the app is what you do *after* you have claimed.
- The app is where the engagement lives; the notification is where it starts.

**The constraint that makes this load-bearing rather than decorative:** on
iOS, Web Push only works for a PWA the user has added to their home screen
(Safari, 16.4+). So item 2 is not polish — item 1 does not exist without it.

### 2. It must not look like a website

A store handheld showing a URL bar reads as "a link somebody sent us", and
that perception is worth more than it sounds when a district manager walks
past. Installed PWA: `display: standalone`, `apple-touch-icon`,
`apple-mobile-web-app-capable`, a real icon, our own status-bar colour. Plus
an install step we actually walk them through — a QR from Console that opens
the launch URL, and a first-run card that says *Share → Add to Home Screen*
rather than assuming anyone will guess.

### 3. It must survive the store's wifi

Retail wifi is bad in a specific way: not down, just intermittent behind
concrete and steel fixtures. This is where phone pilots die quietly.

- Service worker precaches the shell, so a cold start paints instantly
  instead of spinning on a dead network.
- Last known state renders immediately, marked as last known.
- Outgoing actions — claim, mark, end, a floor message — **queue and replay**.
- The queue is **visible**: *"not connected · 2 waiting"*. Same rule the
  answer engine already keeps about empty-versus-unreachable. An action that
  silently did not happen is worse than one that visibly has not happened yet.

### 4. One thumb, screen on

- **Wake Lock** for the duration of an engagement. A screen that sleeps
  mid-conversation is the single most annoying possible failure.
- One card fills the screen. Actions live in the bottom third, where a thumb
  reaches without regripping.
- Swipe left/right → `prev`/`next`. Tap → `select`. Back gesture → `back`.
  Six gestures, same union, same `deck.ts`.
- Large type by default. This is read at arm's length, in motion, under
  retail lighting — the same reason the G2 lens has a pixel-drawn hero rail.

---

## What the phone earns that glass cannot do

This is what stops it being "the cheap version" — which the roadmap already
warns against selling it as, correctly.

- **A camera pointed at a tag.** `BarcodeDetector` → SKU → price, count,
  location from records we already hold. The roadmap's Phase 3 note is that
  the barcode path is *already category-neutral*: it works in a hardware store
  or an auto-parts counter with no sizing logic at all. The privacy sentence
  survives intact — **things, never people**, off by default per store, which
  is what `/customers` section 07 already promises.
- **A keyboard.** Floor comms and notes typed rather than dictated. On glass
  those are read-only in practice.
- **The whole customer card**, scrollable. Glass gets eight containers; a
  phone gets the record.
- **An earbud.** Browser mic in, TTS out — the middle rung of the
  phone → earbud → glasses ladder, and the rung that makes the ladder a story
  rather than a discount.

---

## Two kinds of phone, and they must not be the same thing

This distinction should be in the data model from day one, because retrofitting
it after a security review has read the first version is expensive.

**The store handheld** is a *device*. It gets a device token, is minted from
Console with a QR, appears in Devices with presence, and is revocable as
hardware. `surface: 'phone'`.

**The associate's own phone** is a *person*. They sign in. There is no device
token, the device is never trusted to be the store, and revoking their access
means revoking the person — not chasing a handset that left with someone who
quit. It also gives the security review the answer it wants: *we install
nothing on your staff's phones and we do not manage their device.*

Getting this wrong in the other direction — minting a device token onto a
personal phone — means a resignation leaves a live store credential in a
stranger's pocket, and the only record of it is a row labelled "Sam's iPhone".

## POS

Already researched and decided: `claude/shopify-pos-what-it-gives-us.md`. Not
repeated here, except for the two sentences that matter for sequencing.

**It is a surface we build into, not an API we call** — a POS UI extension,
its own build, its own review. **The strongest reason to do it is attribution,
not identification:** `addLineItemProperties` stamps the associate onto the
line item at the moment of sale, which turns the number the whole product is
sold on from an inference into a record.

And it is second, not first, for the reason that doc gives: POS deepens
accounts already inside all six gates, while the phone widens who can buy at
all. The model already has a slot waiting for it — `presence.py:70` defines
the `pos-lookup` door with consent kind `transaction`, labelled *"At the
till"*. What is missing is an app at the till, not a place to put it.

---

## Order of work

1. **`packages/lens-core`.** Lift `deck.ts`, `grammar.ts`, `types.ts` out of
   `meta-lens` — already pure, already node-tested, already annotated
   *"liftable to lens-core"* in three places. Both existing lenses import it.
   No behaviour change; the tests move with the code. This is a prerequisite
   only in the sense that not doing it means maintaining the deck grammar in
   three places instead of one.
2. **`packages/pocket`** — the phone app. Touch source into `LensGesture`, a
   phone render profile, manifest, service worker with shell precache and an
   offline action queue, wake lock, install coaching.
3. **`surface: 'phone'` end to end** — migration + `CHECK`, `SURFACES` tuple,
   `launch_url()`, QR (currently rendered for `even-g2` only; phone is the
   second surface where scanning is the natural pairing), the Console card and
   Studio's Devices list. Plus the BYOD sign-in path above.
4. **Web Push** — VAPID keys, a subscription store per associate, notification
   actions, and claim-from-the-notification in the service worker.
5. **Camera on a tag, and the full customer card.**
6. **Earbud mode** — browser mic, TTS.
7. **POS extension**, once a phone pilot has signed.

1–3 is the demoable thing: an associate scans a QR, adds it to their home
screen, and takes a request on the floor. 4 is what makes it a tool they keep
using rather than one they tried.

## The claim, meanwhile

Until 1–3 exist, section 05 of the customer deck describes a surface we do not
have. Three options, and it is Kyle's call which:

- **Build it** — roughly the two weeks the roadmap already budgeted, for the
  unlock it already called the biggest.
- **Soften the deck** to "the phone is where a pilot starts — shipping this
  quarter", which is true and still sells the ladder.
- **Leave it** and take the risk that a merchant asks to see it in the meeting
  where they were going to say yes.

Recommendation: build it. But the deck should not describe it in the present
tense on a Monday when it does not exist on that Monday, and of the three,
only the third option is actually a bad one.
