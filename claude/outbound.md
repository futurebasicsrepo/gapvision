# Outbound — the first sequence

**17 August 2026.** The first campaign, written to be sent by a founder rather
than by a tool. Drafts only: **nothing here sends until Kyle says so**, and the
recommendation stands that he reads the first ten replies before that widens.

Two blockers before a single one goes out, both real:

1. **`packages/sales-site` is not deployed.** Every link below points at
   `sales.cuesea.ai`, and today nothing answers there. An outbound email
   carrying a dead link is worse than no email — it spends the one impression
   you get on a 404.
2. **There is no list.** I can build one (below), but I have not, and inventing
   names would be the same failure as inventing numbers.

## Who this is written to

**Operations at a specialty retailer, 3–30 stores, already on Shopify POS.**
Not the CEO and not IT. The person who owns what happens on the floor, who
feels turnover directly, and who can authorise a twelve-week pilot without a
board paper.

Titles that fit: Director/VP of Retail Operations, Head of Stores, Retail
Experience Lead. At the small end this is often the founder, which is fine —
the message does not change, only the tone.

Why Shopify POS specifically: it is the one live CRM adapter. A merchant can
connect in about twenty minutes with a token they generate themselves — no
Shopify review, no OAuth callback, no per-store deployment. That is the whole
reason this segment goes first, and it is a fact about our own readiness rather
than a claim about their business.

### How to build the list

Nothing here needs a data vendor:

- Shopify's own store directories and the "powered by Shopify" footprint,
  filtered to multi-location.
- Specialty retail associations and regional trade shows — attendee lists are
  usually public.
- Job boards. **A retailer posting three store-associate roles this month is a
  retailer with a training problem this quarter**, which is the trigger event
  this whole sequence is built on.

That last one is the best signal available and costs nothing. I can run it as
standing work and surface new matches weekly.

## The angle

Grounded rather than asserted, because both halves are documented rather than
guessed:

**Retailers train associates on the POS, not on the answer.** The training
that exists teaches the till. What a customer actually asks — *do you have this
in a 32, did it work for someone like me, when is it back* — is learned over
months, and turnover resets the clock. ([Shopify, on retail employee
training](https://www.shopify.com/retail/employee-training))

**The category's own failure mode is "one more app".** Clienteling platforms
lose adoption when associates are already juggling systems and this is another
thing to open. ([Proximity, on clienteling
adoption](https://www.proximityinsight.com/resources/blog/clienteling-platform-tools-2026/))

CueSea's answer to both is the same sentence, and it is the one to lead with:
**the answer arrives where the customer already is, and there is nothing to
open.** A new hire on day one has what a five-year associate has. Nobody looks
at a screen in front of a guest, because there is no screen to look at.

## The sequence

Four touches over eleven days. Stops immediately on any reply — including
"not now", which is a real answer and gets a diarised follow-up rather than
another email.

### 1 · Day 0 — the observation

Subject: **three associates on the floor this month**

> Hi {first},
>
> You're hiring {n} store associates at {brand}. That's the part I'd want to
> talk about — not the hiring, the first ninety days after it.
>
> Most retail training covers the till. What it can't cover is the answer:
> whether you have it in a 32, whether it worked for someone with the same
> problem, when it's back. That takes months to learn and turnover resets it.
>
> We built glasses that put that answer where the customer already is — no
> phone, no screen between the two people talking, nothing for the associate
> to open. It reads from your own Shopify records, so it's your catalogue and
> your history, not a model's guess.
>
> Worth eleven minutes? I'll show you the four things it does on a real lens,
> and the list of what it can't do yet.
>
> Kyle

*Why this shape:* the trigger is theirs and observable, the claim is specific,
and the last line offers the limits before they ask. Eleven minutes rather than
"15 mins" because an odd number reads as a real estimate.

### 2 · Day 3 — the deck

Subject: *(reply on the same thread)*

> One thing I should have led with: it's camera-free. The glasses have no
> camera and aren't getting one — that's a design decision, not a roadmap
> item, and it's usually the first question a legal review asks.
>
> The whole argument is here if it's easier than a call:
> {deck link, gated, prepared for {brand}}
>
> Section 9 is the known edges — what doesn't work yet, in our words.
>
> Kyle

*Why:* pre-empts the objection that kills glasses pilots before they start, and
points at the section a sceptic will trust us for having written.

### 3 · Day 7 — the proof offer

Subject: *(same thread)*

> Last one from me for a while.
>
> If it's useful, I'll set up a store in the sim with your catalogue and send
> back a two-minute recording of the four moments — a guest arriving, an
> associate asking a question, a request from a fitting room, a backup call.
> Your products, not our demo ones.
>
> No call needed for that; just say yes and give me a store URL.
>
> Kyle

*Why:* asks for something smaller than a meeting and gives something bigger.
This is the touch most likely to convert a lurker, and it is cheap — the sim
runs the same bundle the glasses run, so nothing is faked to make it.

### 4 · Conditional — they opened the deck, they didn't reply

Fires 48 hours after a gated open with no response. Not on the calendar; on the
event.

Subject: **the section you'd have questions about**

> Saw the deck landed. If you got as far as pricing, the honest summary is
> that a twelve-week pilot with a holdout is what we're set up for, and we'd
> rather run one properly than five badly.
>
> If you stopped at privacy, I'd rather answer that directly than have you
> take our word for it in a PDF.
>
> Either way — what stopped you?
>
> Kyle

*Why:* names the two sections people actually stall on, and the closing
question is answerable in four words. **This touch is the reason the lead
endpoints matter**: without them we cannot tell an open from a silence, and
this email either never fires or fires blind.

## Rules

- **Nothing sends without a per-campaign yes.** Outbound from a founder's
  address is irreversible and reputational, and that is Kyle's call every time,
  not a standing permission.
- **Stop on any reply.** Including an out-of-office, which gets a re-queue for
  after the date, not a follow-up.
- **One thread.** Touches 2 and 3 reply to touch 1 rather than starting new
  subjects, because a new subject line reads as a sequence and a thread reads
  as a person.
- **No merge-field damage.** Any send where `{first}`, `{brand}` or `{n}` is
  unresolved is held, not sent with a blank. A visible merge field is the
  single clearest signal that nobody wrote this to you.
- **Fifty a week, maximum.** Not a deliverability rule — a *reply* rule. Fifty
  is roughly what one founder can answer properly, and outbound you cannot
  answer is worse than outbound you did not send.

## What to measure, and what not to

Three numbers, all of which need the lead endpoints from
`claude/sales-deck.md` before they exist:

| Number | Why it and not a vanity one |
|---|---|
| **Replies per 100 sent** | Not opens. An open is a pixel; a reply is a person. |
| **Deck opens that became replies** | The touch-4 conversion. If this is near zero, the deck is the problem, not the email. |
| **Which section they stalled on** | Requires the reading-depth work in `claude/marketing.md`, which needs saying out loud in the deck's privacy line before it ships. |

**Not** open rate on the email itself, and not "impressions". At fifty sends a
week those numbers are noise with a decimal point, and putting them on a
dashboard makes them get quoted.

## What I need to run this

In the order it blocks:

1. **Deploy `packages/sales-site`** — otherwise every link is dead. Steps in
   its README; own Vercel project, `sales.cuesea.ai` CNAME.
2. **The lead endpoints** — `POST /api/ingest/deck-lead` and
   `GET /api/analytics/deck-leads`. Contract already written. Without them
   touch 4 cannot fire and none of the three numbers exist.
3. **A yes on sending**, per campaign. Until then I draft into Gmail and you
   press send, which is a reasonable place to stay for the first fifty.

I can start 1 and 2 immediately — both are code. The list I can build in
parallel and have ready before either lands.
