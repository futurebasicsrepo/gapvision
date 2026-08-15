# The check-in page — contract

The page a plate points at. It lives in `packages/web` and is the one piece of
the front-door work that is not built, because that package is yours.

Everything it needs already exists and is tested: the doors, the endpoint, the
artwork generator and the way back out.

---

## The URL it is opened with

```
https://cuesea.ai/here?t=gap&z=fitting-room-3&src=nfc-plate
```

| Param | What it is | Trust it? |
|---|---|---|
| `t` | tenant slug | Yes — it only selects which retailer's world this is. |
| `z` | zone slug, e.g. `fitting-room-3` | Yes. **The zone is printed on the plate and baked into its URL.** That is the entire beacon story: an acrylic plate in fitting room three *is* the beacon for fitting room three, and it never needs a battery. |
| `src` | which door: `nfc-plate` (tapped) or `qr-plate` (scanned) | Pass it through unchanged. Never default it, never rewrite it. |

The tap and the scan carry different `src` values **on purpose**. They are the
same arrival and they are not the same door, and after a month of traffic
`GET /api/analytics/doors` answers which one people actually use — which
decides whether the next hundred plates need tags in them at all. If the page
ever normalises the two into one value, that question becomes unanswerable and
nothing else breaks, which is the worst kind of bug.

Both are `deliberate` consent. The page does not get to say so; the service
derives it from `src` and ignores any `consent` the caller sends. There is a
test whose only job is to prove that.

---

## What it posts

To the **realtime server**, not the AI service — a browser never holds the
service key.

```
POST https://realtime-production-80f4.up.railway.app/api/presence
{ "tenant": "gap", "guest_ref": "<crm customer id>", "zone": "fitting-room-3",
  "source": "nfc-plate" }

→ 200 { "ok": true, "zone": "fitting-room-3", "source": "nfc-plate",
        "consent": "deliberate", "delivered": 1 }
```

`delivered` is how many associates got the card. **Zero is not an error** — the
guest checked in fine, the cue just has nowhere to land yet. Do not show them a
failure for it.

Only `nfc-plate` and `qr-plate` are accepted here. Everything else in the
registry (the retailer's app, a wallet pass, an order collection, an associate
asking) arrives from a system that holds the key and posts to the AI service
directly. The whitelist is `PUBLIC_SOURCES` in `packages/server/src/index.js`,
and `test_presence.py` checks it against the service's own registry so a rename
on one side cannot silently 400 every plate in the estate.

### And the way out

```
POST /api/presence/revoke
{ "tenant": "gap", "guest_ref": "..." }   → { "ok": true, "closed": 2 }
```

Closes every live check-in for that guest, across every door. This is not
optional furniture: a page that can start a session but not end one is asking
the guest to trust a promise it does not implement. Put **Stop** on the screen
they land on after checking in, not two taps deep.

Presence also expires on its own after 45 minutes, because `exit` is
best-effort from every door and somebody who walks out without telling anyone
has to stop being present anyway.

---

## The open question: where `guest_ref` comes from

This is the part worth thinking about rather than picking quickly. `guest_ref`
is the retailer's own CRM id — the same value `engagements.guest_ref` holds. A
browser arriving from a wall does not have one.

The options, in the order I would try them:

1. **The retailer's existing account.** Gap has customer accounts; Shopify has
   customer login. The guest signs in as themselves and the id is theirs by
   construction. Best provenance, and it costs the guest whatever their
   password flow costs — which for a returning shopper on their own phone is
   usually a tap.
2. **A one-time code to a phone or email** they already gave the retailer.
   Slower, but it works for a guest who has an account and no memory of it.
3. **A returning-guest token in local storage**, issued after (1) or (2) once,
   so the second visit is a single tap. This is the one that makes plates feel
   magic on the second visit, and it should hold a token we issued — never a
   raw CRM id, which would be a customer identifier sitting in a browser where
   anyone can read and replay it.

What I would not do: check in an anonymous guest with a made-up reference. The
cue would be empty, the associate would learn nothing, and the presence record
would claim an arrival we cannot attribute to anyone. The plate would look like
it worked and would have done nothing.

---

## What the page must show

The three things the plate promises, in the guest's hands where they can act on
them:

- **What is shared.** Sizes and saved items — the same words as the plate. If
  the page and the plate disagree about what happens, the plate is a lie
  printed on acrylic.
- **Where.** Name the zone back to them: "You're checked in — Fitting room 3."
  It is also how a mis-mounted plate gets caught, which is the failure the
  installation sheet's last step exists to prevent.
- **Stop.** One tap, on the same screen.

No account creation wall before the check-in. A guest who cannot be identified
should be told plainly that this needs their account, not walked through a
signup on a fitting-room floor.

---

## Making plates

```bash
python3 packages/brand/build-plates.py --tenant gap --store "Gap" \
    --zone "Entrance" --zone "Fitting room 1" --zone "Fitting room 2"
```

Per zone: a print PDF with bleed and crop marks, a proof PNG, and a one-page
installation sheet. Plus `write-tags.txt` — the exact URLs to write to the
tags, so nobody types one by hand.

`python3 packages/brand/test-plates.py` decodes the QR back out of the rendered
artwork and compares it to the URL character for character. That test exists
because every other check can pass while the printed code quietly points at the
wrong zone, and by the time anyone finds out there is a pallet of them.

**The one thing the installer must not skip: lock the tag.** An unlocked tag on
a public wall can be rewritten by anyone who walks past, to point anywhere they
like. It is the only security property the plate has, and it is step 2 on the
sheet in the largest type on the page.
