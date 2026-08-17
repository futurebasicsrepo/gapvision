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

---

## How to add one

Edit this file, put the newest at the top, and run `npm run docs:sync` (or just
build Console — it syncs on every build). Date it, say what happened, and name
the evidence.
