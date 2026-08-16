# What CueSea sells today, and how to widen the market for it

**16 August 2026 · read off the code at `22ff1aa`, not off a deck.**

Three parts. **[Part 1](#part-1--the-feature-list)** is the feature list, written
for someone selling it rather than someone building it, and honest about what
carries a caveat. **[Part 2](#part-2--the-six-gates)** is why the reachable
market is currently small — six gates, each one a multiplier we are choosing to
leave in place. **[Part 3](#part-3--the-roadmap)** orders the work by market
unlocked per week spent. **[Part 4](#part-4--selling-it)** is the go-to-market.

The engineering-grade version of Part 1 is `FEATURES.md`, and where the two
disagree, `FEATURES.md` wins.

---

## Part 1 — the feature list

### What an associate gets

| | Status | The sentence a buyer understands |
|---|---|---|
| **In-lens guest cue** | Shipped | Three lines on the glass: who just walked in, the evidence for it, and the reason to speak. Composed by code, never improvised by a model. |
| **Fact rail** | Shipped | Name, loyalty tier, points, top size, bottom size — pinned to the left of the display while everything else scrolls. |
| **Card deck** | Shipped | Ring-scroll through the cue, then the guest (sizes, live online cart, purchase history, shipping address, contact), then the product picks. |
| **Ask out loud** | Shipped | Double-press, ask, answer on the glass in about three seconds. No wake word. |
| **Six answer types** | Shipped | Stock, floor location, price, guest history, recommendations, and an open fallback. |
| **Deictic questions** | Shipped | "Do you have *these* in a 32" resolves against whatever is on the lens. The associate never has to name the product in front of the customer. |
| **Honest failure** | Shipped | A garment we don't carry gets "we don't carry that," not a confident answer about something else. The model is forbidden from estimating stock, sizes or prices. |
| **Sizing-scheme safety** | Shipped | A question about a 32×30 is never answered with a tee. A letter size is never offered as an alternative to a waist size. |
| **Point the camera at a thing** | Shipped | Phone camera at a swing tag, barcode or serial plate; the answer lands in the glass. Barcodes are read by a real decoder, never guessed by the model. Objects only — the path refuses a photograph of a person, and the image is never written anywhere. |
| **Floor comms** | Shipped, untested by two people on a real floor | One channel with addressing. Broadcast to the room, or `→ YOU` to one person's lens. Urgent takes the frame; the rest queue behind an unread marker. |
| **Gestures** | Shipped | Ring first, temple mirrors it — an associate can turn a ring without the customer noticing, which they cannot do by tapping their temple. |
| **Shift boundaries & glasses health** | Shipped, off by default | An explicit clock-in and clock-out so per-hour metrics have a denominator, and a battery reading so a dying pair doesn't read on the leaderboard as a lazy associate. |
| **Survives the wifi** | Shipped | Events buffer on the phone and replay on reconnect carrying the time they *occurred*. |

### What a guest gets

| | Status | |
|---|---|---|
| **Tap or scan a plate** | Shipped | An $11 acrylic plate is a beacon that never needs a battery, and the zone is printed on it rather than inferred. |
| **`/here` check-in page** | Shipped | Says what room you're in, takes what you need — chips, a product picker with real variant sizes, or free text — and it is on an associate's glass before you've put your phone away. Stop is one tap on the same screen. |
| **Identity is optional** | Shipped | A request only needs to know *where* you are. The page mints a per-visit reference that points at no customer record and dies with the tab. Signing in buys the guest card. |
| **Out of stock is shown, not hidden** | Shipped | Marked `check` rather than removed, because our count saying none is weaker than "none," and the floor routinely holds stock the system hasn't caught. |
| **Six front doors** | Shipped | Plate tap, QR scan, retailer app check-in, app geofence, wallet pass, order collection, appointment, till lookup, associate-asked. Each door declares its own consent grade and the caller can't override it. |
| **Never modelled** | By design | No path, no dwell, no zone-to-zone movement. The columns don't exist and a test asserts they don't. |

### What a manager gets — CueSea Studio

| | Status | |
|---|---|---|
| **One floor view** | Shipped | Guests helped, attributed sales, assists, questions asked, over 1 / 7 / 30 days. |
| **Who's on the floor now** | Shipped | |
| **Leaderboard that counts assists** | Shipped | Assists are weighted (25 points default, tunable per tenant) and every component of a score is returned, so a ranking can be explained rather than asserted. Ranking retail staff on sales alone reliably produces cherry-picking. |
| **What CueSea actually said** | Shipped, off by default | The three lines the associate read, stored as sent. And the questions the floor asked *with the answer beside them* — so a manager can see not just that someone asked about stock but whether we told them something true. |

### What we get — CueSea Console

Platform health (eleven live checks), cross-tenant usage, tenant creation,
people and device management, printed-plate management and revocation,
retention windows and sweep receipts, the Connect Shopify panel, and reference
pages including a real architecture diagram. Ten panels. Onboarding a retailer
is a Console job with no terminal in it (`docs/onboarding.md`).

### The platform underneath

- **Multi-tenant by construction** — rosters, radio, voice logs, leaderboards and stats are partitioned; socket rooms are per-tenant; a socket's tenant is pinned at register and can't change mid-flight.
- **Per-merchant Shopify credentials**, sealed AES-256-GCM under a key Postgres never sees. Write-only: no CueSea employee can read a token back, only a fingerprint. Rotation supported.
- **Live Shopify adapter** — real Admin GraphQL, static tokens and client-credentials with automatic re-minting. Connection probing names the specific failure.
- **Four roles** (`associate` < `manager` < `client_admin` < `cue_admin`), scrypt passwords, 12-hour sessions, nobody can grant a role above their own, disabling an account kills every live session.
- **Retention, enforced** — aged personal data redacted per tenant on that tenant's own window, with a receipt for every sweep. The operational skeleton survives, so turning privacy on doesn't cost a retailer their quarter.
- **Transcripts off by default.** The analytics work without them.
- **Demoable with no hardware in the room** — the plugin detects the native bridge and falls back to a browser mock; mock STT returns deterministic transcripts. This is a bigger commercial asset than it looks. See [Part 4](#the-demo-is-the-top-of-the-funnel).

### Known caveats worth a salesperson knowing before a customer finds them

1. **Size labels pass through verbatim.** A guest asking for "a 32" finds nothing on a product whose sizes read `W30 L32`, even though the 32 is sitting there. Also breaks on `EU 41`, `UK 9`, `15 / 33`.
2. **An empty inventory reads as "we don't carry that."** The adapter can't yet say *"I can't see stock right now"* as a distinct outcome. This is the single most damaging bug in the system commercially: it makes an outage look like a lie.
3. **Floor location is hardcoded to "Floor"** on Shopify. Per-zone placement needs a product metafield.
4. **`cuesea.ai` has no SPF record.** Nothing we send is aligned or signed, which taxes deliverability on every invite, reset and sales email the domain sends — including from Gmail. This is a DNS change, not a project.
5. **Even Hub submission hasn't been made.** The package builds clean; the store listing doesn't exist.
6. **Anthropic, OpenAI and Google model providers** are registered and stubbed; Grok is the live one.

---

## Part 2 — the six gates

Reachable market is not a number, it is a product of the constraints we haven't
removed yet. Today a prospect has to clear **all six** of these to be sellable
to, which is why the pipeline feels narrow.

| # | Gate | Who it excludes |
|---|---|---|
| **G1** | **Buys Even Realities G2 glasses, one pair per associate** | Everyone who won't put hardware capex against an unproven line. This is a procurement cycle, a device-management conversation and a single-vendor supply risk, all before value is demonstrated. It is the largest gate by an order of magnitude. |
| **G2** | **Runs Shopify** | Every retailer on Lightspeed, Square, Clover, NetSuite, Aptos, Manhattan, Oracle Xstore, SAP or a homegrown ERP. That is most of retail by store count and nearly all of it by revenue. |
| **G3** | **Sells apparel** | Hardware, auto parts, electronics, grocery, beauty, sporting goods, furniture, optical, garden. The sizing logic is apparel-shaped; almost nothing else in the system is. |
| **G4** | **Can produce a guest signal** | Retailers without a loyalty app and unwilling to hang plates. Mitigated — plates work standalone — but the richest experience still needs an app integration, and `docs/gap-app-integration-spec.md` shows that's a whole customer sprint. |
| **G5** | **Operates in English** | Every non-English market, and — domestically — a large fraction of the US retail floor workforce. |
| **G6** | **Is worth hand-onboarding** | Every store below enterprise scale. There is no self-serve signup, no app-store listing and no free tier. The funnel is outbound-only by construction. |

**Two of these are load-bearing on purpose and should stay:** the camera-free,
opt-in-only, never-passive-matching posture (G4's cause) is what gets this
product past a privacy committee, and grounded-answers-only is what keeps it
trusted on a floor. Everything else is a gate we can choose to remove.

**Sizing the prize honestly.** Removing G1 and G2 alone plausibly moves the
reachable account count by one to two orders of magnitude, but treat that as a
hypothesis, not a figure for a deck. Before any of this reaches an investor
page, firm it up against: US Census County Business Patterns (retail
establishments with ≥10 employees, by NAICS), Shopify's own disclosed POS
locations, Lightspeed and Square published merchant counts, and NRF store-count
data for the top 100 chains. Numbers we can't source, we don't say — same rule
as the answer engine.

---

## Part 3 — the roadmap

Ordered by market unlocked per week of work, not by how interesting it is to
build.

### Phase 0 — earn the right to scale (do this first, ~2–4 weeks)

Nothing here opens a market. All of it stops us losing the reference customers
that open every subsequent one.

1. **Normalize size labels.** Parse `W30 L32`, `EU 41`, `UK 9`, `15 / 33`, `S/M` into a structured size with the label preserved for display. Generalize `size_scheme()` while you're in there — see Phase 3, this is the same seam.
2. **Make "I can't see stock right now" a distinct outcome.** `crm.floor_inventory()` needs to distinguish empty from unreachable, and the answer engine needs to say which. One data source makes this a bug; two make it a liability.
3. **The five-minute locked-phone test**, on real hardware. It gates Even Hub submission and settles a live coin-flip in `foreground-exit`.
4. **Fix DNS.** SPF, DKIM in Workspace, `_dmarc` at `p=none`. An afternoon, and every outbound sales email lands better forever.
5. **Ship the pilot scorecard as a product feature.** Attributed sales per associate-hour, assist rate, question coverage, answered-correctly rate — the data is already collected. A pilot that produces its own case study is worth more than any deck we write about it.

### Phase 1 — remove the hardware gate (the big one)

**Glasses-free mode: the associate's own phone, with an earbud.**

Everything except the display is already hardware-independent — the answer
engine, the grounded lookups, the guest cards, floor comms, check-in requests,
attribution, analytics. `bridge.ts` already has two implementations (native and
browser mock); this is a third. `layout.ts` already renders a card deck; on a
phone it renders bigger. Voice is a browser mic instead of an SDK audio stream.

What it changes commercially:

- **Capex goes to zero.** A store manager can try it this afternoon on staff phones instead of raising a hardware requisition.
- **The pilot gets to prove value before anyone buys a device**, which inverts the sale: glasses become the upsell you earn, not the objection you open with.
- **It de-risks single-vendor supply.** Right now our whole business depends on one hardware company's roadmap and lead times.
- **It makes self-serve possible at all** (Phase 4 depends on this).

Sell it as a ladder: **phone → earbud → glasses**, same product, same data, each
rung hands-free-er than the last. Do not position it as the cheap version.

### Phase 2 — remove the Shopify gate

The adapter contract is three methods (`all_guests`, `get_guest`,
`floor_inventory`) and `ADAPTER_BUILDERS` is a dict with one entry. Order:

1. **A bring-your-own-feed adapter** — nightly CSV/SFTP or a REST endpoint the retailer already has, with a mapping UI in Console. This is the cheapest item on the roadmap and the widest: it makes *any* retailer who can export inventory a candidate, without waiting on their IT roadmap. Enterprise retail runs on flat files; meet it there.
2. **Lightspeed Retail and Square** — documented APIs, SMB-heavy, same shape as Shopify. Two adapters, similar effort each.
3. **Enterprise connectors** (Manhattan Active, Aptos, Oracle Xstore, SAP) — expensive, slow, and only build one when a signed customer is paying for it. The feed adapter in item 1 is the interim answer for all of them, and often the permanent one.

Also worth doing here: **read-through caching and a stale-data indicator**, because a nightly feed is not a live API and the product must never present day-old counts as current. Same honesty rule as everywhere else.

### Phase 3 — remove the category gate

**The observation that matters: the barcode path is already category-neutral.**
Point a phone at a code, get price, count and location from records we hold.
That works in a hardware store, an auto-parts counter or an electronics floor
*today*, with no sizing logic involved at all. The cheapest new-vertical pilot
we can run is a barcode-first one, and it needs roughly none of the work below.

Then generalize:

- **`size_scheme` → `variant_axis`.** Size is one axis. Vehicle fitment is another (auto parts). Shade is another (beauty). Voltage/gauge/thread pitch is another (hardware). The "never offer an incompatible alternative" rule is the valuable part and it is axis-agnostic — the code just needs to stop assuming the axis is called "size."
- **Personas → attribute matching** on whatever the category's own taxonomy is.
- **Category packs** — a set of intents, answer templates and axis definitions per vertical, configured per tenant rather than forked per customer.

Rough order by how well the existing product fits: **home improvement / hardware**
(location questions dominate, cross-compatibility is the killer feature) →
**auto parts** (fitment is a sizing scheme with a different name) → **consumer
electronics** (compatibility, spec comparison) → **beauty** (shade matching) →
**sporting goods, furniture, optical**. Grocery and pharmacy are large but carry
their own regulatory weight — don't lead with them.

Non-retail adjacencies that reuse the same spine — warehouse pick/pack, field
service, hospitality, venue staff — are real and should be logged, but they are
a different buyer and a different sale. Don't chase them until Phases 1–3 are
paying.

### Phase 4 — remove the motion gate

- **Self-serve signup**, gated behind Phase 1 (glasses-free) — otherwise there is nothing to self-serve *onto*.
- **A public Shopify App Store listing**, alongside the custom-app path. The custom-app route stays as the enterprise wedge because it dodges app review; the listing exists because it is a distribution channel that markets while we sleep.
- **A free "check-in only" tier.** The `/here` page and requests, no glasses, no CRM connection, no voice. Ten minutes to install, an $11 plate, immediate visible value ("a customer in a fitting room can ask for a size without waving"). This is the widest possible top of funnel and it builds the logo list and the question corpus that everything else monetizes.

### Phase 5 — remove the language and hardware-vendor gates

- **Multilingual STT and answers.** Deepgram and Whisper are already multilingual; the work is answer templates and intent patterns, not models. Unlocks EU/LatAm/APAC — and, unglamorously but immediately, Spanish-speaking floor staff in US stores, which several US chains will ask about in the first meeting.
- **A second glasses target** (Vuzix, RayNeo, Brilliant Labs, and Meta's display SDK when it opens). Abstract a **display profile** — 576×288 monochrome is currently an assumption baked through `layout.ts`. Also lets us sell into fleets of Zebra/Honeywell handhelds retailers already own.

### Phase 6 — grow the account, not the account count

The questions log is proprietary data nobody else has: *what customers actually
ask on a floor, and whether we could answer it.* Packaged as a **Floor Demand
Signal** report it sells to merchandising and e-commerce — a second budget in
the same building, with zero new hardware and near-zero new engineering. "Here
are the forty things people asked for last month that you didn't have in the
store they asked in" is a sentence a merchandising VP pays for.

### The one-line summary

| Phase | Gate removed | Effort | Priority |
|---|---|---|---|
| 0 | none — trust and proof | 2–4 wks | **Do first** |
| 1 | G1 hardware | 4–8 wks | **Highest leverage** |
| 2 | G2 Shopify-only | 2 wks (feed) + 3–4 wks (2 adapters) | High |
| 3 | G3 apparel-only | ~0 for barcode-first pilots; 4–6 wks to generalize | High, cheap to start |
| 4 | G6 outbound-only | 6–10 wks, depends on Phase 1 | Medium |
| 5 | G5 English, single vendor | 3–4 wks each | Medium |
| 6 | — (revenue per account) | 2–3 wks | Opportunistic |

---

## Part 4 — selling it

### Don't sell AR glasses

Buyers have AR fatigue and a drawer full of failed pilots. They do not have
answer fatigue. Lead with the problem in the buyer's own words: *"Your best
associate knows the stock. Everyone else guesses, and a guess costs you the
sale."* The glasses are how the answer is delivered, and they should come up
third, not first.

Working category line: **e-commerce-grade answers, on the floor, hands-free.**

### The demo is the top of the funnel

The browser mock and deterministic mock STT mean the entire product demos with
no hardware in the room. Almost nobody in this category can say that. Use it:

- **Put a self-serve interactive demo on the website.** Prospects should be able to see the lens, ask a question and get a grounded answer before they talk to anyone. That is a lead magnet and a qualification filter in one.
- **Every AE can demo from a laptop** on a first call. No shipping, no charging, no "let me get the glasses out of my bag."
- **Pin a transcript** (`CUE_STT_MOCK_TRANSCRIPT`) for a scripted demo that never misfires.

### Make privacy the wedge, not the paperwork

Every competitor in this space dies in privacy review. We are architected to
pass it, and that is a *sales* asset that nobody is currently monetizing:

> No cameras. No faces. No biometrics. No path tracking — the table doesn't
> exist and a test asserts it doesn't. Images are never written to disk.
> Transcripts are off by default. Every front door records the grade of consent
> behind it and the caller can't overstate it. Aged personal data is deleted on
> the retailer's own window and every sweep leaves a receipt.

**Build a "Privacy Review Pack" as a first-class collateral piece** — the
architecture diagram already in Console, the consent-grade table, the retention
receipts, the "objects, never people" boundary, and the data-flow claim that the
customer record never enters our services. Hand it over on call one. It can take
months out of an enterprise cycle, and it converts the slowest stakeholder in
the building from a blocker into a champion.

### Structure every pilot to produce its own case study

Don't run a pilot and then go looking for numbers. Design it as a measurement:

- One store, associates split into equipped and control, **alternating weeks** so it's the same people and the same weather.
- Primary metric: **attributed sales per associate-hour.** Secondary: assist rate, question coverage, answered-correctly rate, new-hire ramp time.
- Agree the success threshold *in writing before it starts.* A pilot with no pre-agreed bar becomes an opinion contest you lose.
- Ship the scorecard in-product (Phase 0, item 5) so the customer watches it accumulate rather than waiting on a readout.

One measured, named reference customer is worth more than the next twelve months
of content marketing.

### Who's in the room

| Role | What they care about | What to show them |
|---|---|---|
| **VP Store Ops / Chief Stores Officer** | Conversion, walkouts, consistency between the best associate and the median one | The pilot scorecard |
| **CFO / COO** | Labor productivity, capex | Phase 1 phone mode — zero capex to prove it |
| **Privacy / Legal** | Can this get us in the paper | The Privacy Review Pack |
| **IT / Security** | Integration burden, credential handling, device management | Per-tenant sealed credentials, write-only tokens, the feed adapter (no IT project) |
| **CIO / Digital** | Yet another system | It reads their existing commerce backend and adds no system of record |
| **Merchandising** (Phase 6) | Demand signal | The questions log |

The economic buyer is usually Store Ops with COO sign-off. The blocker is almost
always Privacy or IT. Get to both early and on purpose — a deal killed in month
four by a stakeholder you hadn't met is the standard failure mode in this
category.

### Channels, in the order they'll pay

1. **Even Realities co-marketing.** They need software that makes the hardware worth buying; we need distribution and hardware credibility. Structurally aligned, and probably the fastest partnership to close.
2. **Shopify App Store** (Phase 4) — inbound while you sleep, and it self-qualifies for G2.
3. **Shopify Plus agencies and retail SIs** — they already own the customer relationship and the implementation budget.
4. **NRF Big Show** — the anchor event for this buyer. Book the demo slots early; the hardware-free demo makes booth logistics trivial.
5. **Direct outbound to specialty apparel chains, 20–200 stores.** Big enough to have the problem and a budget, small enough that one champion can say yes.

### Content that only we can write

The questions log is a data asset nobody else has. Publish an anonymized
**"What shoppers actually ask on the shop floor"** report — real question
distribution, real answer-coverage rates, the gap between what stores think
customers want and what they say out loud. That is genuinely novel data, it is
press-worthy, and it markets the product by describing the problem. Do it once a
year and it becomes the thing people cite.

Everything else is secondary: a 90-second floor video shot over a real
associate's shoulder, the measured pilot case study, and the Privacy Review Pack.
Three assets, and they carry the first year.

### Pricing shape

Per-associate-seat per month, with hardware passed through at cost as a separate
line so the software price never has to absorb it. A paid pilot that credits
100% toward the annual — free pilots don't get staffed by the customer, and an
unstaffed pilot fails for reasons that have nothing to do with the product. Free
check-in tier at the bottom (Phase 4), Floor Demand Signal as an upsell at the
top (Phase 6).

### Three things not to do

1. **Don't demo on a thin store.** Against a live Shopify store with sparse customer data, the guest cards render sparse — correctly, and unimpressively. Seed or pick the demo tenant deliberately.
2. **Don't sell the questions log to a customer before transcripts are on.** It's off by default, per tenant, and it should stay that way. Sell the switch, and the reason it exists.
3. **Don't promise per-zone stock location on Shopify yet.** It's hardcoded to "Floor." It's a small fix, but until it's done, don't put it on a slide.
