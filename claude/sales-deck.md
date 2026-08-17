# The sales decks — two sites, one Console tab

**16 August 2026.** Two motion-led, mobile-first decks that share one stylesheet,
one script and one set of share parameters, plus the Console panel that turns
them into something you send.

```
/                     → redirects to /customers
/customers            for the floor  — merchants and operators   (11 sections)
/fundraise            pre-seed       — investors                 (13 sections)
/assets/deck.css      the deck sheet: tokens, lens, motion, print
/assets/deck.js       decode, reveals, counters, pinned rooms, share, gate, PDF
/cuesea-for-the-floor.pdf   printed from /customers
/cuesea-preseed.pdf         the slide deck
/api/lead.js          gated-open capture (log + optional webhook)
```

Both pages are plain HTML against those two assets — no framework, no bundler,
nothing to rot between now and the raise. A third deck is a third folder.

## Which deck is which

**`/customers` — for the floor.** The one a salesperson lives in. Four
capabilities on real lenses (ask, requests, presence, floor comms, switched by
tapping); verticals; how a merchant connects; privacy written for their legal
review; **known edges**, said out loud; a twelve-week rollout with a holdout;
pricing. It is the demo argument in a page: *ask it something you already know
the answer to.*

**`/fundraise` — pre-seed.** Problem, insight, product, what is built, market
three ways, competition, model, the bear case in our own words, the plan, the
ask.

The customer deck deliberately carries a **Known edges** section — zones need
tagging, one live adapter, empty-versus-absent, glasses are pilot-grade, a
printed QR can be photographed. Vendors do not usually ship that slide. It is
the cheapest trust we will ever buy, and every item on it is true.

## Shared machinery

**Share parameters, identical on both:** `?to=` personalises the header
(*prepared for Reformation*), `?gate=1` asks for a name and email first, `?t=`
carries the link's token. The Share sheet builds them; the Console panel builds
them; they mean the same thing either way.

**The lens is drawn, never approximated** — 640 × 350, rail at 29.375% (twelve
characters), one type size, uppercase, opaque black, Doto. Eight of them across
the two pages. **Green appears inside a lens and nowhere else**: card labels and
the decode's lit flash are sea.

**Motion** per `design/product-surfaces.md`: decode on arrival with per-word
`nowrap` spans and a timeout backstop, scan sweep once on the bar, pipeline
draws on entry, counters and bars fire once and unobserve. The capability
switcher is **click-driven, not timed** — a sales page is read at the reader's
pace, and a lens that changes mid-sentence is a lens they stop trusting.
`prefers-reduced-motion` branches before any loop starts.

**Mobile:** the pipeline goes vertical under 620px, the capability lens sticks
to the top so a tap is visibly answered, tables become blocks, repeated surfaces
drop `backdrop-filter`.

**PDF:** the file when it is deployed beside the page, the browser's own
print-to-PDF when it is not. `cuesea-for-the-floor.pdf` is generated from the
page itself, one section per page, so the leave-behind and the link never drift
apart. Regenerate after edits:

```bash
node tools/print-deck.js http://localhost:8902/customers cuesea-for-the-floor.pdf
```

## Deploying

**Its own project, recommended.** Client-facing, and keeps both decks off the
staff origin:

```bash
cd sales-site
vercel deploy --prod          # project: cuesea-sales
# add sales.cuesea.ai in Vercel; GoDaddy CNAME sales → cname.vercel-dns.com
```

Set `LEAD_WEBHOOK_URL` there if gated opens should be forwarded somewhere;
without it they land in the runtime log. Then set `VITE_SALES_URL` on the
Console project to that origin — the panel builds every link from it.

The alternative — dropping the folder at `packages/internal/public/sales/` so it
ships with the next merge — works and costs nothing, but serves a customer-facing
document from the staff origin, which is the boundary `cue-console.md` exists to
keep. Fine for a rehearsal, wrong for a send.

## Wiring the Console tab

The rail in `packages/internal/src/App.jsx` is **Platform** (health, tenants)
and **Reference** (architecture, what cue does, onboarding, employee one-pager,
brand). Sales belongs under Platform, third — it is live state, not reference:

```jsx
import Sales from "./panels/Sales.jsx";
import "./panels/sales.css";

// rail, Platform group:
{ id: "sales", label: "sales", hint: "the decks, and who has them" }

// route table:
sales: <Sales />
```

One rail item, two sub-tabs inside it: **For the floor** (default) and
**Fundraise**. Do not add sibling rail items — the last mock invented two and
the correction is recorded in `plates-requests-panel.md`.

## The endpoints this wants next

Small, and what turns the panel from a link builder into a record.
`/api/analytics/*` is manager-and-up and already passes through the realtime
proxy, so none of this needs new plumbing.

```
POST /api/ingest/deck-lead        service key
  { deck, name, email, firm, preparedFor, token, ref }
  -> 204. Rate limit by IP. The only write the public decks make.

GET  /api/analytics/deck-leads    days=90
  -> { leads: [{ id, deck, name, email, firm, preparedFor, token, at }] }

GET  /api/analytics/deck-links    so a link made on a laptop is visible on a phone
POST /api/analytics/deck-links
```

`deck` is `floor` or `fundraise`; the panel already filters on it and tolerates
its absence. Leads are personal data and belong in the retention sweep on the
tenant's own window, like everything in `retention_runs` — add them there in the
same change, not afterwards.

## Say this out loud

**The gate is a lead gate, not authentication.** Anyone can delete `gate=1` from
the URL and read the deck. The panel says so in flame, the function's header
comment says so, and this document says so. If that sentence ever gets softened,
someone will send a deck they believed was protected.

And the panel reports an **absent** lead endpoint as absent rather than as zero,
and holds links in `localStorage` until the API lands — both stated in the UI.
Invented numbers in an internal tool are worse than no numbers: they get quoted.
