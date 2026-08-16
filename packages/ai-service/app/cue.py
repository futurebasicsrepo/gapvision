"""Writing for the glass.

The brand system puts the hardest constraint first and derives everything else
from it: the cue is designed in the glass, and every other surface is that
same sentence with more room. So the formatting rules live in one module that
both the guest card and the voice answer go through.

The rules, verbatim from the identity system:

  · Three lines. Never four. Name, evidence, reason to speak — in that order.
  · Under 60 characters per line.
  · Uppercase. Dot-matrix lowercase loses legibility at this resolution.
  · No punctuation but the interpunct. Commas and periods eat pixels and read
    as artefacts.
  · Two-second read, out loud. If an associate can't absorb it while walking,
    it isn't a cue.
  · The meta strip is three facts, never four. Facts that support the
    sentence and never compete with it.
  · Nothing else on the display. No buttons, no chrome, no logo, no icons.

The old renderer put seven lines and an icon glyph on each one. That was a
dashboard shrunk to fit a lens, which is the thing this product exists not to
be.
"""
from __future__ import annotations

import re

# Sanity caps, not budgets — and the difference is the whole point.
#
# These used to be `layout.ts`'s character budgets, transcribed: 33 across the
# frame, 21 beside the rail, 10 on the rail. That was an improvement on the 60
# they replaced, and it was still a fiction, because **the G2's font is
# proportional**: eleven characters is 56px of `IIIIIIIIIII` or 176px of
# `WWWWWWWWWWW`, and one number cannot mean both. The glass now measures every
# string against Even's own font tables and fits it to the box exactly.
#
# **The server cannot do that.** The metrics package is JavaScript; this
# service is Python. Transcribing a character count here was the service
# pretending to fit pixels it has no way to see — and being wrong in both
# directions at once: clipping `WOMENS OUTERWEAR WALL` while shortening
# `MAYA OKAFOR` for nothing.
#
# So the contract changed rather than the number. **The server writes short,
# and the glass fits exactly.** These caps exist to stop absurd input — a
# paragraph arriving where a cue belongs — and are deliberately generous: a
# line that runs long is now trimmed on the glass, at the pixel, by something
# that can see the box. What still belongs here is the *writing*: three lines,
# uppercase, the interpunct, front-loaded so the words that matter survive.
#
# `test_cue_budgets.py` holds the new contract, which is that the composer
# writes to the shape of a cue and not to a box it cannot measure.
LINE_CHARS = 120       # a sanity cap on any one line
RAIL_LINE_CHARS = 120  # a guest cue: same cap, and the glass fits it to the rail
FACT_CHARS = 40        # a meta fact is a fact, not a sentence
CUE_LINES = 3
META_FACTS = 3

#: Everything that isn't a letter, digit, space, the interpunct — or the
#: arrow. `→` is in the G2's font (20px advance, verified in the plugin's
#: derived charset) and it is the direction line's whole grammar: `FITTING
#: ROOMS → DENIM WALL`. This literal was written before that was known, and
#: it silently ate the arrow on its way to the glass.
_PUNCT = re.compile(r"[^A-Z0-9 ·%$£€/+→-]")
_SPACES = re.compile(r"\s+")
_MONEY = re.compile(r"([$£€])\s?(\d+(?:\.\d{1,2})?)")


def glassify(text: str, width: int = LINE_CHARS) -> str:
    """One line, as the glass will render it.

    Currency symbols, digits and the interpunct survive; everything else that
    would land as a stray lit pixel does not. Truncation is by word so a line
    never ends mid-syllable — at this size a clipped word reads as a fault.
    """
    if not text:
        return ""
    # Round currency before punctuation is stripped, or "$89.95" becomes
    # "$89 95" — which reads as two numbers. Money on the glass is whole
    # units; nobody is reading to the cent at 26px while walking.
    out = _MONEY.sub(lambda m: f"{m.group(1)}{round(float(m.group(2))):,}", str(text))
    out = _PUNCT.sub(" ", out.upper().replace("—", " ").replace("-", " "))
    out = _SPACES.sub(" ", out).strip()
    if len(out) <= width:
        return out
    words, line = out.split(" "), ""
    for w in words:
        candidate = f"{line} {w}".strip()
        if len(candidate) > width:
            break
        line = candidate
    return line or out[:width].rstrip()


def money(value) -> str:
    """Money, for the glass.

    Decimals are punctuation, and the identity system's own examples read
    "£680 LTV" not "£680.00". At 26px in a 25° field of view, ".95" is two
    characters of noise attached to a number nobody is reading to the cent.
    """
    try:
        return f"${round(float(value)):,}"
    except (TypeError, ValueError):
        return ""


def build(lines: list[str], meta: list[str] | None = None,
          width: int = LINE_CHARS) -> dict:
    """A cue: at most three lines and at most three supporting facts.

    Short cues are allowed — two lines that say the whole thing beat three
    that pad. What is not allowed is a fourth.

    `width` is the caller's, because it is the caller that knows whether a
    rail is going to be sitting beside this. A full-frame cue gets 33
    characters; anything with a rail gets 21.
    """
    shaped = [glassify(l, width) for l in lines if l and str(l).strip()][:CUE_LINES]
    facts = [glassify(m, FACT_CHARS) for m in (meta or [])
             if m and str(m).strip()][:META_FACTS]
    return {"lines": shaped, "meta": facts}


def guest_cue(guest: dict, top: dict | None, cart: list[dict] | None) -> dict:
    """The card that appears when an opted-in guest is identified.

    Evidence, then reason to speak — the evidence line is whichever fact most
    earns the associate's next sentence: something left in a cart beats a
    recommendation, because it is something the guest already chose.

    **The name is not here.** It used to be the first of the three lines, and
    it is already pinned to the fact rail on the left, where it stays put while
    the right side changes. Spending one of three rows on a word that is
    already on screen is the most expensive duplication available on this
    display. The left side is who they are; the right side is what to do about
    it, and it is the only part that moves.

    That freed a row, which the cart branch immediately wanted: it used to
    compute a recommendation and throw it away whenever a cart existed, so the
    strongest case — someone who left something behind *and* has something
    worth showing — was the case that said least.
    """
    cart = cart or []
    sizes = guest.get("sizes") or {}
    lines: list[str] = []

    if cart:
        item = cart[0]
        # Front-loaded and short. The fact rail takes a third of the frame, so
        # the sentence has 21 characters rather than 33, and "LEFT THE … IN
        # THEIR CART" spent eighteen of them on grammar before reaching the
        # thing the associate needs to say out loud.
        lines.append(f"IN CART {item['name']}")
        lines.append(f"OFFER IT IN SIZE {sizes.get('tops', '')}".strip())
        if top:
            lines.append(f"THEN {top['name']}")
    elif top:
        lines.append(f"SHOW THE {top['name']}")
        lines.append(f"AT {top.get('location', 'THE FLOOR')}")
    else:
        lines.append(f"{guest.get('loyalty_tier', '')} MEMBER".strip())
        # 19 characters. "ASK WHAT BROUGHT THEM IN" is 24 and truncates to "ASK
        # WHAT BROUGHT THEM", which ends mid-thought — the words that survive
        # have to be the whole sentence, not the start of one.
        lines.append("WHAT BRINGS THEM IN")

    # Deliberately not the tier, the points or the sizes: all three are already
    # rail rows, and the meta strip sits directly underneath the rail. Repeating
    # them there would put the same fact twice in one column, which is the same
    # mistake the name was making across two.
    meta = [guest.get("zone") or "", _visit_note(guest)]
    return build(lines, meta, RAIL_LINE_CHARS)


def _visit_note(guest: dict) -> str:
    """One fact about the relationship that the rail does not already carry.

    Falls back to nothing rather than to filler. An empty meta strip is honest;
    a padded one trains people to stop reading it.
    """
    spent = guest.get("lifetime_value")
    if spent:
        return f"{money(spent)} LTV"
    visits = guest.get("visits")
    if isinstance(visits, int) and visits > 1:
        return f"{visits} VISITS"
    return ""


def idle_cue(tenant_label: str, zone: str) -> dict:
    """Nothing to say yet. Even this obeys the grammar."""
    return build(["CUESEA READY", glassify(tenant_label), "AWAITING GUEST SIGNAL"],
                 [glassify(zone, 22)])


def flatten(cue: dict) -> list[str]:
    """The same cue as flat lines, for logs and the manager view.

    The rule that keeps the surfaces coherent: the sentence is identical
    everywhere. Only the room changes.
    """
    return [*cue.get("lines", []), " · ".join(cue.get("meta", []))] if cue.get("meta") \
        else list(cue.get("lines", []))
