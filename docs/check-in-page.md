# The check-in page

The page a plate points at, and the only surface in this product a customer
ever touches. Built: `packages/web/src/CheckIn.jsx`, served at `/here`.

```
https://cuesea.ai/here?t=gap&z=fitting-room-3&src=nfc-plate
```

| Param | What it is | Trust it? |
|---|---|---|
| `t` | tenant slug | Yes — it only selects which retailer's world this is. |
| `z` | zone slug | Yes. The zone is printed on the plate and baked into its URL. An acrylic plate in fitting room three *is* the beacon for fitting room three. |
| `src` | `nfc-plate` (tapped) or `qr-plate` (scanned) | Pass it through unchanged. Never default it, never rewrite it — the two doors are how we learn whether the tags were worth paying for. |

---

## The two paths, and why there are two

**A Shopify store has no app.** The scan opens our page: chips for what they
need, a picker for what is actually on the floor with that product's real
sizes, and a box for the rest. One screen, no account, no download.

**Gap has an app, and it already knows them.** The plate should open it — and
here is the constraint that shapes everything: **iOS opens an app for a link
only when that domain's own `apple-app-site-association` claims it.** A
cuesea.ai URL cannot open Gap's app, no matter what we put in it. Only gap.com
can.

So the plate prints our URL and the *tenant config* decides what happens on
landing:

```json
{"checkin": {"mode": "app",
             "app_link": "https://www.gap.com/here?z={z}&src={src}&ref={ref}",
             "app_name": "the Gap app"}}
```

`mode: "web"` (the default) shows our form. `mode: "app"` shows a handoff with
one button into the retailer's app and *"Continue here instead"* underneath —
because a guest who doesn't have the app must never hit a dead end.

The point of putting this in config rather than on the plate: Gap ships their
route, we change one field, and **every plate already screwed to a wall starts
opening the app.** Nothing gets reprinted. A tenant set to `app` with no
`app_link` falls back to the web page and reports `fell_back: true` rather than
stranding anyone on a blank screen.

The addendum in `docs/gap-app-integration-spec.md` is what Gap's app team needs:
one route, one screen, one POST.

---

## Identity is optional, and that was a reversal

The first version of this doc said not to check in an anonymous guest — the cue
would be empty and the plate would look like it worked while doing nothing.
That was right about the cue and wrong about the request:

> The **cue** needs to know who you are. A **request** only needs to know where
> you are.

"Fitting room 3 wants a 32 in the barrel jean" is completely actionable and
names nobody. So the page mints an `anon-…` reference in `sessionStorage` — a
pointer to no customer record, good for one visit, gone when the tab closes.
Asking someone to sign in before they can ask for a size is friction charged
for our convenience rather than theirs.

Identity still buys something real: the guest card, their sizes, their saved
items, the greeting. That comes from the retailer's own account in the
retailer's own app, which is where it belonged.

---

## The API, all on the realtime server

A browser never holds the service key. Every call below is open; the realtime
server holds the key and calls the AI service.

```
GET  /api/checkin/config?t=gap        → { mode, app_link, app_name, needs }
GET  /api/catalogue?t=gap             → { products: [{sku, name, sizes:[{size, available}]}] }
POST /api/presence                    → { ok, zone, consent, delivered, identified }
POST /api/request                     → { request_id, line, zone, delivered }
POST /api/presence/revoke             → { ok, closed, cancelled }
```

- **The catalogue carries no unit counts, ever.** "Three left in a 32" is a
  sentence about a retailer's business, and an open route that answered it
  would be a live stock feed anyone could poll from the car park. Sizes come
  back with `available: true|false` and nothing more.
- **Out-of-stock sizes are shown and marked, never hidden.** Hiding one reads
  to a guest as "that size doesn't exist", so they ask for the wrong thing or
  give up — and the floor routinely holds stock the system hasn't caught up
  with. The chip says `· check`, because what we actually know is that our
  count says none, which is weaker than either "low" or "out".
- **A request needs a live check-in** (409 otherwise). That is the only thing
  standing between an open route and anybody putting a line on an associate's
  glasses from anywhere in the world.
- **`delivered: 0` is not an error.** The guest asked fine; nobody happens to
  be wearing glasses this minute.
- **Revoking cancels their open requests too.** Somebody who taps Stop has
  stopped waiting, and a request that outlives them sends an associate to an
  empty fitting room holding a jean.

---

## On the glass

The request takes the frame like an urgent floor message — a person standing in
a fitting room in one shoe is the most time-sensitive thing in the building.

```
FITTING ROOM 3
32x30 · High Rise Barrel Jeans
PRESS TO TAKE IT
```

**The size leads the line, and that is not a style choice.** The row truncates
at 21 characters beside the fact rail. A clipped product name still names the
jean; a clipped size is a wrong answer read out loud to a customer. Same rule
as everything else on this display: wrapping is lossless, truncation is not.

Press claims it. The claim is settled server-side against the row still being
open, so two associates pressing at the same moment produce one claim and one
honest "already taken" — rather than two people walking to the same fitting
room with the same jean.

---

## Retention

`note` is a customer's own words, so it is treated like a voice transcript: it
and the guest pointer are redacted on the tenant's window. What stays is `sku`,
`size`, `need`, `zone` and the timings, because *"which sizes do people ask for
in fitting rooms, and how long do they wait"* is a question about a shop and not
about a shopper.

---

## Running it

```bash
# make plates
python3 packages/brand/build-plates.py --tenant gap --store "Gap" \
    --zone "Fitting room 3"

# the whole path, in a real browser: tap → check in → ask → glasses
node packages/web/test/checkin-browser.mjs
```

That last test is the only one in the repo that exercises the whole product in
one pass, and its final assertion is the one that matters: everything before it
can pass while nothing arrives on the glass. That was the failure that shipped
three broken packages — an event name that looked right, sent to a client that
never listened for it.

**Deployment note:** `/here` must not sit behind Vercel deployment protection
or any password gate. It is the one route in this app that a stranger's phone
has to be able to open.
