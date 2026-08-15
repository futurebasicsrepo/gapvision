# Cue — features as of 15 August 2026

Plugin `0.1.9`, `main` at `7911e79`. Read off the code, not the roadmap:
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
| **Recommendation carousel** | Scroll cycles through matched products; whatever is showing becomes what "these" refers to in the next voice question. |
| **Voice** | Double-press → mic opens → Deepgram → Grok → answer in-lens. About three seconds end to end. Endpointing is peak-relative with hysteresis, so it closes when you stop talking rather than running to a cap. |
| **Gestures** | Ring and temple, mirrored: press, double-press, scroll up/down. Root-page double-press raises the system exit dialog, as Even requires. |
| **Session resume** | Survives a WebView foreground transition — the card is rebuilt from the CRM rather than restored stale. |
| **Diagnostics on glass** | Build version on the idle screen, gesture telemetry mirrored to the server, and a type ruler (scroll up at idle) that measures what the display will actually render. |

### Voice — what it can actually answer

Six intents, detected from the transcript: **stock, location, price, history,
recommend**, and an open fallback that goes to the model.

- **Inventory** — unit counts by size, out-of-stock with nearest available
  sizes in the same sizing scheme, wrong-scheme corrections ("isn't sized 32,
  comes in S, M, L"), floor location, price.
- **The guest record** — their sizes, what's in their online cart, their points
  and tier, what they've bought before.
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
and the questions the floor actually asked, over 1, 7 or 30 days. Respects the
tenant's transcript-storage setting — it says "transcript not stored" rather
than showing nothing. Cue staff get a store picker.

### Cue Console — cuesea staff only

Platform health, cross-tenant usage, tenant creation, people and device
management, and the Connect Shopify panel — which stores, tests and reports
which scopes a token actually carries, shows a fingerprint rather than a token,
and refuses to accept credentials at all if the encryption key is missing. Plus
a live brand reference and an architecture map.

---

## Partial — works, with a caveat worth knowing

| Thing | The caveat |
|---|---|
| **Size questions** | Only fully answerable against the mock dataset. The Shopify adapter fetches variants but doesn't yet emit per-size counts, so a live store answers "unknown" for size availability. This is the highest-value small fix on the list. |
| **Floor location** | The Shopify adapter hardcodes location to "Floor". Per-zone placement needs a product metafield. |
| **Voice and gestures in the browser** | Fully wired server-side and covered by tests, but Cue Studio has no UI that drives them — they are exercised from the glasses or the test harness. |
| **The demo harness** | The associate view with its beacon buttons and its leaderboard names is demo-only, and the seeded names appear for the `gap` tenant alone. |
| **Radio on the glass** | The plugin already subscribes to floor messages — it writes them to a debug log instead of rendering them. Transport done, surface not built. |
| **Guest roster endpoint** | Deliberately gated off for non-demo tenants. A list of every customer in the store is exactly the shape the tap-to-reveal design exists to eliminate. |
| **User management** | The API can create, update, disable and delete people. The Console can only create them. Changing a role or resetting a password currently needs a direct API call. |

---

## Not built

- **Retention enforcement.** `privacy.retention_days` is stored and nothing
  deletes on it. The published privacy policy admits this in writing.
- **Invites, password reset, any email at all.** An account created without a
  password exists but cannot sign in until staff set one.
- **Floor comms** — designed in detail, decided (priority tier), not started.
- **Customer search** — see below.
- **Even Hub submission** — packs clean; the store listing has not been created.
- **QR check-in / presence** — the opt-in identification path.
- **Anthropic, OpenAI and Google model providers** — registered and stubbed.

---

## The gap to "more searchable per customer"

Worth being precise, because the answer is better than it sounds in one place
and worse in another.

**The pathway already exists.** Voice is not inventory-only — the `history`
intent already reads the guest record, and already answers questions about
their sizes, their cart, their points and tier, and their purchase history. So
"search more parameters, not just inventory" is half-built already.

**The data is the problem.** A guest record is exactly eight fields:

```
guest_id · name · loyalty_tier · loyalty_points
sizes · persona_tags · purchase_history · open_cart_online
```

**There is no shipping address anywhere in the system.** No address, no email,
no phone, no order dates, no order numbers. The Shopify query doesn't even ask
for them — it requests display name, amount spent, order count, tags and line
items, and nothing else. Tier and points aren't stored either; they're derived
from lifetime spend on the way past.

So the work is four steps, in order:

1. **Widen the Shopify query** to fetch `defaultAddress`, order dates and order
   numbers, and decide what else earns its place.
2. **Widen the adapter contract** so both the mock and the live adapter return
   the same enlarged record — the contract is three methods and both
   implementations honour it, so this stays clean.
3. **Add a customer-card module to the scroll carousel.** This is the cheap
   part: the right-hand region already scrolls between modules, so customer
   cards are a new module rather than new layout. Costs **zero new containers**
   — the budget that has silently eaten two features already.
4. **Extend the history intent's vocabulary** so "where do we ship her" and
   "when did she last order" resolve.

**One thing to notice:** this does *not* collide with the opt-in-only standing
decision. Everything above happens **after** a customer has been identified and
a session is open — it is depth on someone you are already talking to, not
enumeration of people you are not. That distinction is what keeps the roster
endpoint closed while this stays open.

---

## Two things to run before building anything else

1. **The five-minute locked-phone test.** It gates Even Hub submission, decides
   whether floor comms is messaging or an inbox, and settles a live coin-flip
   in the plugin's `foreground-exit` handling.
2. **Install `0.1.9` and confirm the socket connects** — the last three
   packages dialled localhost, so no guest could arrive and no voice question
   could reach anything. Fixed and guarded, but unverified on hardware.
