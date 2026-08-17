# Learnings

What we have actually learned about selling this, in the order we learned it.
Newest first.

Two rules, so this stays worth reading:

- **An entry names its evidence.** "Merchants care about privacy" is a belief.
  "Two of two merchant conversations went to privacy before pricing" is a
  learning. If it has no source, it goes in as a hypothesis and is labelled
  one.
- **Wrong entries get corrected in place, with the correction visible.**
  Deleting a bad call loses the more useful fact: that we believed it.

---

## 17 August 2026 · We are selling a surface we have not built

The customer deck's section 05 says *"Start on the phone in their pocket…
This is where a pilot starts."* There is no phone app. Studio refuses
associates by design — *"your surface is Lens, in the glass"* — and the only
associate-facing build in the repo is the Even Hub plugin, which requires the
glasses the whole section exists to make optional.

Not caught by a merchant. Caught by going to look, after Kyle said the
phone-delivery pitch was the part he liked — which is the uncomfortable
version, because the pitch working is exactly what makes the gap expensive.

The general lesson is the one worth keeping: **a deck written in the present
tense outruns the code silently, and nothing in the build will tell you.** The
known-edges section below is the mechanism that was supposed to catch this and
did not, because it lists limits of things we built, not things we described.

**Source:** the survey in `claude/phone-first.md`, 17 August 2026, with file
and line references so the claim is checkable rather than remembered.

## 17 August 2026 · The marketing site is painted in the product's ground

**Observation, not yet a decision.** Brand v3.2 gives the `ink` ramp the role
*"Editorial and marketing surfaces. The site is paper; the product is sea"*, and
a 70 / 25 / 5 paper-sea-flame split. cuesea.ai is grounded in slate — the
product ground — which is the one surface the rule says it should not be.

The store has an unused `assets/cuesea.css` that is the paper system, fully
written, loaded by nothing. So the paper site was built and then abandoned in
favour of the dark one, and the brand file was never updated to match the
choice. One of the two is wrong and nobody has said which.

Worth deciding rather than drifting: a light editorial ground would also make
the lens, Studio and Console read as real product windows inset in a page,
which is the usual consumer-brand device. The cost is real — seven stylesheets
hard-code white-alpha glass that assumes a dark ground.

**Source:** the v9 consumer pass, which deliberately did not do this;
`packages/brand/tokens.json`, `assets/cuesea.css` vs `layout/theme.liquid`.

## 17 August 2026 · The site and the simulator disagree about the size of the glass

**Fact, unresolved.** The homepage says the lens is `640 × 350` — in the hero
caption and again in the hardware specs. `packages/web` simulates the associate
view at `576 × 288`, and `sections/hero.liquid`'s own schema default for that
same caption is `576 × 288`. So the live setting overrides the theme's default
with a different number, and the published site and the running simulator state
different hardware.

Not fixed here, because the fix depends on which is true, and that is a hardware
question rather than a copy one. It is on a public page either way.

**Source:** `templates/index.json` (hero caption, hardware `s1`) vs
`sections/hero.liquid` schema default vs `README.md`.

> **Resolved the same day.** `576 × 288` is the number the product actually
> renders to, and there were three witnesses to it against one: the plugin, the
> simulator, and `snippets/lens.liquid`'s own header comment, which cites
> `claude/lens-hud.md` at plugin 0.1.9 and says *"576 × 288, monochrome green"*
> — in the very file that draws the lens the marketing page shows. The site now
> says 576 × 288 in both places. The `640 × 350` appears to have been typed into
> the theme editor rather than derived from anything.

## 17 August 2026 · The site was a year behind the build, and nobody could see it

**Fact, and the expensive kind.** The store site pitched one pair of glasses
with a mocked lens. Shipped and unmentioned: Cue Pocket, floor comms with
addressing, and the camera look-up. Built and unmentioned: the Meta Ray-Ban
Display lens. The homepage was last true some time before three of the four
landed.

This is the **mirror image** of the entry above about the deck outrunning the
code, and it is worth keeping both, because they look like opposite mistakes
and have one cause: *nothing joins a shipped feature to the sentence that sells
it.* A deck written in the present tense outruns the build; a site nobody
revisits falls behind it. Both are invisible until somebody reads the page with
the repo open beside them.

Worse than invisible in one place: the site claimed **"no cameras"** as a
headline fact. That was true when it was written and stopped being true when
the look-up shipped — and it is the single claim a privacy-minded merchant is
most likely to test. It now reads "never a face · the camera reads objects, not
people", which is both true and a stronger thing to say.

The cheap mechanism, if we want one: FEATURES.md already has a *Works today*
section, and the site has surfaces and capability sections. Whatever adds a row
to the first should be what adds a card to the second.

**Source:** the v9 content pass, 17 August 2026, checked against `FEATURES.md`,
`packages/pocket/README.md`, `packages/meta-lens/README.md`,
`app/vision.py` and `app/barcode.py`.

## 17 August 2026 · The known-edges section is the cheapest trust we can buy

**Hypothesis, not yet tested against a merchant.** The customer deck carries a
section listing what does not work — zones need tagging, one live CRM adapter,
empty-versus-absent, pilot-grade hardware, a printed QR can be photographed.
Vendors do not usually ship that slide.

The bet is that a buyer who finds a limit themselves discounts everything else
you said, and one who is told upfront trusts the rest. Worth measuring: if a
merchant raises an objection already on the slide, that is the slide working.

**Source:** `claude/sales-deck.md`, written with the decks.

## 17 August 2026 · The gate is a lead gate, and saying so is not optional

`?gate=1` asks for a name and email. Anyone can delete it from the URL. That
sentence is repeated in the panel, in `deck.js`, in the site README and in the
deck doc — four places, deliberately.

The failure it prevents is specific and expensive: somebody sends the pre-seed
deck to a forwarded address believing the gate protected it. There is no
version of that where the mistake is cheap.

**Source:** the drop's own design note, kept and tested rather than trimmed.

## 17 August 2026 · We cannot yet answer "who did we talk to in July"

Deck links live in one browser's localStorage. Gated opens land in a Vercel
runtime log. Neither survives a laptop, and nothing joins a deck open to a
tenant that later signed.

Not a learning about the market — a learning about us, and the one most likely
to cost real money quietly. The four endpoints that fix it are specified in
`claude/sales-deck.md` and unbuilt.

**Source:** building the Sales panel, 17 August 2026.

> **Corrected the same day.** `deck_links` and `deck_leads` exist now, the
> panel reads both, and the deck host forwards gated opens to the control
> plane. The half that is still true: nothing joins a deck open to a tenant
> that later signed, so "which pilot came from which send" remains unanswerable.
> Left in place rather than deleted — the more useful fact is that we shipped a
> sales tool before we could tell who we had sent anything to.

---

## How to add one

Edit this file, put the newest at the top, and run `npm run docs:sync` (or just
build Console — it syncs on every build). Date it, say what happened, and name
the evidence.
