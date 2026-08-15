<!-- GENERATED — do not edit. Source: FEATURES.md. Run `npm run docs:sync`. -->

# Cue — features as of 15 August 2026

Plugin `0.1.11`, `main` at `10158d5`. Read off the code, not the roadmap:
everything in **Works today** is built, wired and deployed. Everything else is
in its own section, and the sections are honest about the difference.

---

## Works today

### Cue Lens — the glasses (Even Realities G2)

| | |
|---|---|
| **Install** | Sideloads as an `.ehpk` through Even Hub. Detects the native bridge and falls back to a browser mock, so the whole flow is demoable with no hardware in the room. |
| **The cue** | Three lines at 576×288 monochrome — who they are, the evidence, the reason to speak. Composed by `cue.py`, never by the model. |
| **Fact rail** | Persistent left column: name, tier, points, top size, bottom size. Stays put while the right side scrolls. |
| **Header** | The Cue mark (a real image container) and a live clock. |
| **Voice** | Double-press → mic opens → Deepgram → Grok → answer in-lens. About three seconds end to end. Endpointing is peak-relative with hysteresis, so it closes when you stop talking rather than running to a cap. |
| **Gestures** | Ring and temple, mirrored: press, double-press, scroll up/down. Root-page double-press raises the system exit dialog, as Even requires. |
| **Session resume** | Survives a WebView foreground transition — the card is rebuilt from the CRM rather than restored stale. |
| **Card stack** | The right-hand region is a stack of three-line cards, scrolled with the ring: the cue, then the guest (sizes, cart, history, shipping address, contact), then the product picks. Scrolling to a pick makes it what "these" refers to in the next voice question. Press returns to the cue from anywhere; press at the cue ends the engagement. Everything shipping next lands here as a card rather than a new screen. |
| **Floor comms** | Associate-to-associate. Urgent messages take the frame; everything else queues behind an unread marker on the rail. Scroll down opens the floor — what's waiting, then canned phrases to send or reply. |
| **Diagnostics on glass** | Build version on the idle screen, gesture telemetry mirrored to the server, and a type ruler (scroll up at idle) that measures what the display will actually render. |

### Voice — what it can actually answer

Six intents, detected from the transcript: **stock, location, price, history,
recommend**, and an open fallback that goes to the model.

- **Inventory** — unit counts by size, out-of-stock with nearest available
  sizes in the same sizing scheme, wrong-scheme corrections ("isn't sized 32,
  comes in S, M, L"), floor location, price.
- **The guest record** — their sizes, what's in their online cart, their points
  and tier, what they've bought before, **where they ship, how to reach them,
  and when they last ordered**. Asking for a phone does not answer with an
  email.
- **Recommendations** — persona-tag matching against floor stock, excluding
  what they already own.
- **Honest failure** — naming a garment the floor doesn't carry gets "we don't
  carry that", not a wrong answer about something else. Answers are grounded in
  records we hold; the model is forbidden from estimating stock, sizes or
  prices, and a model outage says "Model unavailable" rather than guessing.

Product resolution has six strategies, including deictic reference ("do you
have *these* in a 32" resolves to whatever is on the lens) and singular/plural
matching in both directions.

### The backend

- **Multi-tenant by construction.** Every retailer's roster, radio, voice log,
  leaderboard and stats are partitioned; socket rooms are per-tenant; a
  socket's tenant is pinned at register and cannot be changed mid-flight.
- **Per-merchant Shopify credentials**, sealed AES-256-GCM under a key Postgres
  never sees, bound to the tenant. Write-only: no surface and no Cue employee
  can read a token back — only a fingerprint. Key rotation supported.
- **Live Shopify adapter** — real Admin GraphQL, both static admin tokens and
  client-credentials with automatic re-minting before expiry. Connection
  probing maps failures to specific causes (token rejected, store not found,
  rate limited, unreachable).
- **Service auth** — shared-secret guard, fail-closed, rate limited, CORS
  allowlist. Customer records are not reachable unauthenticated.
- **People auth** — four roles (`associate` < `manager` < `client_admin` <
  `cue_admin`), scrypt passwords, opaque bearer tokens, 12-hour sessions.
  Nobody can grant a role above their own; disabling an account or changing a
  password revokes every live session.
- **Invites and password resets.** Creating a person without a password emails
  them a single-use link to set their own. `/auth/forgot` answers identically
  whether or not the address exists, so it cannot be used to discover who works
  for a Cue customer. Login and reset are throttled per-email *and* per-IP,
  because a shop floor is one NAT.
- **Retention, enforced.** Aged personal data is redacted per tenant on that
  tenant's own window; the shape of the shift survives. Every sweep leaves a
  receipt.
- **Attribution** — glasses self-register by serial on first connect; staff
  assign an owner in the Console. Engagements, voice queries and assists are
  all attributed to a person and a device.
- **Analytics** — engagement summary, leaderboard, engagement history, voice
  log, per-tenant usage. Leaderboard weights are configurable per tenant.
- **Platform health** — eleven live checks including schema state, orphaned
  tenants, voice success rate and p95 latency, unassigned devices, stranded
  engagements, credential key state and stale credential tests.

### Cue Studio — the retailer dashboard

Manager sign-in, then one floor view: guests helped, attributed sales, assists
and questions asked; who is on the floor right now; leaderboard; recent guests;
and the questions the floor actually asked, over 1, 7 or 30 days. Cue staff get
a store picker.

**Recent guests show what Cue actually said** — the three lines the associate
read off the glass and the products offered, stored as sent rather than
re-derived, because stock moves. **Questions show the answer beside them**, so
a manager can see not just that the floor asked about stock but whether we told
them something true.

Both of those last two ride the tenant's `store_transcripts` setting, off by
default, now toggleable in Cue Console rather than only by a hand-written API
call. The question and the answer move together: an answer quotes the guest's
own record back at them, and a question with no answer beside it can't be
judged.

### The guest page — app.cuesea.ai/here

The only surface a customer touches, and the only route in Cue Studio that is
public by design. Tap or scan a plate, land on paper-toned page that names the
room you are in, say what you need, and it is on an associate's glass before
you have put your phone away. Stop is on the same screen, one tap, and it takes
back both the check-in and anything still waiting on the floor.

Out-of-stock sizes are shown and marked `check` rather than hidden: what we
know is that our count says none, which is weaker than "out", and the floor
routinely holds stock the system has not caught up with.

### Cue Console — cuesea staff only

Platform health, cross-tenant usage, tenant creation, people and device
management, and the Connect Shopify panel — which stores, tests and reports
which scopes a token actually carries, shows a fingerprint rather than a token,
and refuses to accept credentials at all if the encryption key is missing. Plus
a live brand reference and an **architecture map with a real diagram** — an
inline SVG built from the brand tokens, arranged around the thing people get
wrong about this system: the service key never leaves our services, and the
customer record never enters them.

The left rail is ten panels in two groups:

| Panel | What it is for |
|---|---|
| **Health** | What the platform can prove about itself right now. |
| **Tenants** | Every retailer, their people, their hardware, what they've used. |
| **Cue staff** | Accounts with no tenant — us. Invite a colleague, change a role, end a session. |
| **Plates** | Every printed door, how hard each is being used, and revocation. |
| **Retention** | Each store's window, and what the last sweep actually deleted. |
| **Architecture** · **What Cue does** · **Onboarding** · **Employee one-pager** · **Brand** | Reference. |

**Cue staff is the only screen that creates an account with no tenant.** That
restriction is in the API, not the interface: `POST /api/admin/users` with role
`cue_admin` requires the caller to already be `cue_admin` and forces
`tenant_id` to null, so a retailer's own admin cannot mint one of us by
guessing a payload.

---

## Partial — works, with a caveat worth knowing

| Thing | The caveat |
|---|---|
| **Size questions** | Fixed. The Shopify adapter now emits per-size counts from the variants the query was already fetching and discarding, taking the size from the option actually named "size" rather than from the variant title — so a two-option product doesn't put a colour in the answer. There is now a live store to test it against: `cuesea.ai` carries 300 seeded products / 1,395 variants with deliberately inconsistent sizing (waist, alpha, EU, UK, neck, `W30 L32`, `S/M`) and about a fifth of variants at zero. See `claude/store-seed.md`. |
| **Size labels are passed through verbatim** | Verified against the seeded store, and this is the next real gap. `_variant_sizes()` reads the option named "size" and emits its value unchanged, which is right for `32`, `M` and `10`, and wrong the moment a merchant writes `W30 L32`, `EU 41`, `UK 9` or `15 / 33`. A guest asking for "a 32" gets no match against a product whose sizes are `W30 L32` / `W32 L32`, even though the 32 is sitting there. What is confirmed working on live data: the size comes from the option and not the variant title, so a two-option product sums `S / Fog` and `S / Ink` into one `S` instead of leaking the colour; `Default Title` is correctly skipped so a tie reports no sizes rather than a size called "Default Title"; and a zero reaches the answer as a zero. |
| **Completeness of an empty answer** | Not fixed, and the seeded store is what will prove it. `main.py` calls `crm.floor_inventory()` bare, so an empty or partial inventory is indistinguishable from "not carried" — the floor hears *"We don't carry that on this floor"* either way. The adapter needs to be able to say **"I can't see stock right now"** as a distinct outcome. This bug exists at one data source; it gets worse with two. |
| **Floor location** | The Shopify adapter hardcodes location to "Floor". Per-zone placement needs a product metafield. |
| **Voice and gestures in the browser** | Fully wired server-side and covered by tests, but Cue Studio has no UI that drives them — they are exercised from the glasses or the test harness. |
| **The demo harness** | The associate view with its beacon buttons and its leaderboard names is demo-only, and the seeded names appear for the `gap` tenant alone. |
| **Floor comms** | Built and unblocked by the locked-phone test. Not yet exercised by two people on a real floor, which is the only test that matters for the phrase vocabulary — seven phrases written from a whiteboard. |
| **Customer depth** | Built. Address, contact and order history reach both the cards and the voice answers. Against a live Shopify store the fields come from `defaultAddress` and the customer record, so a store with sparse customer data shows sparse cards — correctly, but a demo on a thin store will look thinner than the mock. |
| **Outbound email** | The transport is pluggable and unconfigured in production. Until `CUE_SMTP_*` is set, invites and resets are written to the service log rather than sent, and the Health panel says so rather than showing green. |
| **Guest roster endpoint** | Deliberately gated off for non-demo tenants. A list of every customer in the store is exactly the shape the tap-to-reveal design exists to eliminate. |
| **User management** | Done in the Console. Create, invite, re-invite, change a role, disable — all reachable from Tenants → People for a retailer's staff, and from the Cue staff panel for ours. The role select is capped at the operator's own rank, so the interface cannot offer an escalation the API would refuse. What is still API-only: hard-deleting a person, which is deliberate — disabling is the reversible thing and should be the easy one. |
| **Retention** | Enforced. Aged personal data is redacted on a timer, per tenant, on that tenant's own window — transcripts, answers, the CRM pointer, cue lines, recommendations, assist notes. The operational skeleton (intent, latency, zone, outcome, sale) survives deliberately, so turning the control on does not cost a retailer their quarter. Every sweep leaves a receipt in `retention_runs`. |

---

## Not built

- **Even Hub submission** — packs clean; the store listing has not been created.
- **Anthropic, OpenAI and Google model providers** — registered and stubbed.

---

## Front doors — how a guest says "I'm here"

One endpoint, many doors. A plate tap, a QR scan, the retailer's app, a wallet
pass, an order collection and an associate asking politely are the same event
arriving through different holes in the wall. A new door is a row in
`SOURCES`, not a subsystem.

**Consent is a property of the door, not of the request.** Each source declares
what kind of agreement stands behind it — `device`, `deliberate`, `transaction`
or `assisted` — and the caller cannot override it. If it were a free field, the
weakest door in the system could claim the strongest provenance and the column
would stop being evidence of anything, which is the one thing it exists to be.
The open route accepts only the two plate doors; everything else arrives from a
system that holds the service key.

**Deliberately not modelled:** no path, no dwell, no zone-to-zone movement.
Presence is a moment at a place. A system that can reconstruct somebody's walk
through a shop is a different product with a different consent story, and the
way you avoid building it by accident is to not have the table. A test asserts
the missing columns rather than trusting a comment to hold the line.

**What the guest asks for.** Presence says somebody is in fitting room three;
a request says they want a 32 in the barrel jean, which is the sentence the
product is for. The guest page (`app.cuesea.ai/here`) checks them in, offers
what they need as chips, what is on the floor as a picker with that product's
real variant sizes, and a box for the rest. It reaches the covering associate's
glasses as a frame they can press to take, claimed server-side so two people
never walk to the same room with the same jean.

**Identity is optional, and that is the design.** The cue needs to know who you
are; a request only needs to know where you are. The page mints a per-visit
reference that points at no customer record and dies with the tab. Signing in
buys the guest card, through the retailer's own account.

**Two paths, one plate.** iOS opens an app only for a link the domain's own
association file claims, so a cuesea.ai URL can never open Gap's app. The plate
prints ours and a tenant config field decides: our form, or a handoff into the
retailer's app with a way to carry on here. Gap ships their route, one field
changes, every plate already on a wall starts opening the app.

**The plate URL is a token.** `?p=K7QX3MZP2A9F` — nothing about the store is
legible in it, one token per door so either can be revoked without touching the
other, and it resolves server-side or not at all. What that does *not* buy is
unshareability: anything printed can be photographed. The tap door can be made
genuinely unshareable with a rotating-cryptogram tag (the service verifies the
counter and refuses a replay); a printed QR cannot rotate, so its mitigations
are revocation, the presence TTL, and `GET /api/analytics/plates` making an
over-used token visible.

**Plates.** `packages/brand/build-plates.py` generates the printable artwork:
print PDF with bleed and crop marks, proof, and an installation sheet, with the
zone baked into every URL. An acrylic plate is a beacon that costs eleven
dollars and never needs a battery — the zone is not inferred, it is printed on
the thing. The tap and the scan carry different `src` values so we learn which
door people actually use. The QR is decoded back out of the rendered artwork in
the test suite, and the installation sheet's second step, in the largest type
on the page, is *lock the tag*.

---

## Customer depth — what shipped, and what it cost

The ask was "more searchable per customer… once on them, should see customer
cards like shipping address."

**The pathway already existed.** Voice was never inventory-only — the `history`
intent has always read the guest record. What was missing was fields: a guest
record was eight of them, and **there was no shipping address anywhere in the
system**, not in the record and not in the query.

Now: `defaultAddress`, email and phone are fetched, and order dates and numbers
— which the query had been retrieving and discarding all along, so "when did
she last order" was answerable from data already on the wire.

**One rule came out of building it, and it governs everything on this display:**

> Wrapping is lossless. Truncation is not.
>
> A clipped product name is still recognisable — "MID RISE VINTAGE SLIM+" and
> an associate knows the jean. A clipped postcode or email is not a *shorter*
> answer, it is a **wrong** one, and it is wrong in the way that gets read out
> loud to a customer with confidence.

So anything that must be transcribable wraps, and anything that need only be
recognisable may truncate. Emails break at the `@` then hard-wrap and the test
asserts the lines rejoin exactly; addresses give up the apartment line before
the postcode. The spoken answer follows the same rule as the card, because they
were allowed to disagree once and the voice answer lost the postcode.

## Two things to run before building anything else

1. **The five-minute locked-phone test.** It gates Even Hub submission, decides
   whether floor comms is messaging or an inbox, and settles a live coin-flip
   in the plugin's `foreground-exit` handling.
2. **Install `0.1.9` and confirm the socket connects** — the last three
   packages dialled localhost, so no guest could arrive and no voice question
   could reach anything. Fixed and guarded, but unverified on hardware.
