# storefront — the cuesea.ai online store, in the parts we have edited

The public site at **cuesea.ai** is a Shopify online store, and its theme is a
hand-built one — `cuesea v1 … v9`, no theme-store parent. Until this directory
existed, that theme lived **only inside Shopify**: no history, no review, no way
to see what changed between v7 and v8 except by opening both in the editor.

## What this directory is, exactly

**A change record, not a deployable theme.** It holds the files the consumer
pass authored or edited, byte-for-byte as they were written to the theme. It is
deliberately not a mirror of all 84 files, and it cannot be pushed back to
Shopify as-is:

- the binary assets are absent — seven `woff2` faces and two frame `png`s,
  which the Admin API returns without a body and which nothing here needs;
- the other 81 files are unchanged and still live only in the theme.

**It will drift.** Anyone editing in the Shopify theme editor changes the store
without changing this directory, and `templates/index.json` in particular is
rewritten by Shopify on every save — its own header says so. Treat the theme as
canonical and this as the note explaining why a file reads the way it does. If
that trade stops being worth it, the answer is a real theme pull, not a
half-updated copy.

## The files

| File | Why it is here |
|---|---|
| `assets/cuesea-consumer.css` | Written by this pass. This is its source of truth — the theme has the only other copy. |
| `layout/theme.liquid` | Changed by one line: it loads the sheet above, last. |
| `templates/index.json` | The homepage composition — section order and every word of the copy. |
| `sections/surfaces.liquid` | The three surfaces. Re-clothed for the dark system (see below). |
| `sections/capability.liquid` | "Here is a thing the product does now", with the lens that shows it. Used twice. |

## The consumer pass (v9)

`cuesea v8 - work` was a good operator page that read like enterprise software:
nine dense sections stacked without pause, the pilot mechanics in the hero, and
the internal staff Console on the public homepage.

The brief was a consumer-grade *feel* for the **same buyer** — retailers and
operators, not shoppers. So the argument is unchanged and the audience is
unchanged. What changed is the register:

- **Type and air.** Section padding roughly doubles at the top end (92 → 168px),
  the hero headline goes to 94px, section headings to 62px. A section now owns a
  screen instead of joining a wall.
- **Less mechanics up front.** The hero's `one site · five people · twelve weeks
  · kill criteria agreed before week one` note is gone from the hero; the pilot
  section already says all of it, and it now runs later in the page.
- **Console off the homepage.** `sections/console.liquid` documents staff-only
  internal tooling. It is `"disabled": true` rather than deleted, so every
  setting survives and one toggle in the editor brings it back.
- **The claim leads.** The hero is now *the answer, where the customer is* —
  the line the customer deck already opens with, so the site and the deck stop
  disagreeing about what the first sentence is.

## The content pass — what the site was missing

The typography pass above changed how the page reads. It did not change what
the page *says*, and what it said was a year out of date: one pair of glasses,
a mocked lens, and no mention of three things that had already shipped.

| Now on the page | Was |
|---|---|
| **Three surfaces** — Even G2, Meta Ray-Ban Display, Cue Pocket | One pair of glasses |
| **The floor** — addressed messages, not just broadcast radio | Nothing |
| **The look-up** — point the phone at a tag, answer in the glass | Nothing |
| `576 × 288` | `640 × 350`, which matches nothing in the repo |
| "never a face · the camera reads objects, not people" | "no cameras", which stopped being true |

Two of those deserve spelling out.

**"No cameras" had to go.** It was true when written and stopped being true the
day the look-up shipped. It is also the single claim a privacy-minded merchant
is most likely to test, so leaving it would have been the expensive kind of
stale. The replacement is stronger, not weaker: there is no face detection and
no person matching on that path, a photograph whose subject is a person comes
back refused, and the image is never written to disk, database or log.

**Meta is not marked as shipping, and that is deliberate.** `packages/meta-lens`
is real code against the same core, but it has no deployment and FEATURES.md's
*Works today* does not list it. The card says "built against the same core and
running today in a browser — not yet in a store", and it is the one surface
without the shipping badge. Marking it shipped would have repeated, in the
other direction, exactly the mistake the site was being fixed for.

`sections/surfaces.liquid` was a leftover from v1: it emitted `.feat`,
`.stand`, `.surfaces` and `.surface`, all of which live only in
`assets/cuesea.css`, which no template loads. It was unstyled and unused. It
now speaks the vocabulary the dark homepage actually loads — `sec`, `head`,
`lede`, `grid`, `card`, `pane`, `mono` — so it needed no new CSS.
`sections/steps.liquid` is still in that dead state, and is still unused.

### What was deliberately not done

The ground stayed dark. Brand v3.2 says the opposite — the `ink` ramp's role is
*"Editorial and marketing surfaces. The site is paper; the product is sea"* —
and by that rule this marketing site is painted in the product's ground. Moving
it to paper is a bigger and better change than the one that was asked for, and
seven of the theme's stylesheets hard-code white-alpha glass that would have to
be reworked with it. It is flagged in `claude/marketing-learnings.md`, not
smuggled into a pass about scale and air.

### The cascade rule, which is not optional

`cuesea-consumer.css` loads **last**, so any selector it repeats beats the
identical selector in `cuesea-mobile.css` and `cuesea-extra.css` — media queries
carry no specificity, only load order decides. Every desktop size raised in that
sheet is therefore re-asserted at `max-width:700px` in the same file.

This matters more than it sounds. `cuesea-extra.css` exists *because* an
oversized hero headline once made the document wider than the phone and dragged
the sticky bar off-screen with it. Its clamp is reproduced verbatim in the
consumer sheet's phone block. Read that file's comment before touching hero type.
