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

LINE_CHARS = 60
CUE_LINES = 3
META_FACTS = 3

#: Everything that isn't a letter, digit, space, or the interpunct.
_PUNCT = re.compile(r"[^A-Z0-9 ·%$£€/+-]")
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


def build(lines: list[str], meta: list[str] | None = None) -> dict:
    """A cue: exactly three lines and at most three supporting facts.

    Short cues are allowed — two lines that say the whole thing beat three
    that pad. What is not allowed is a fourth.
    """
    shaped = [glassify(l) for l in lines if l and str(l).strip()][:CUE_LINES]
    facts = [glassify(m, 22) for m in (meta or []) if m and str(m).strip()][:META_FACTS]
    return {"lines": shaped, "meta": facts}


def guest_cue(guest: dict, top: dict | None, cart: list[dict] | None) -> dict:
    """The card that appears when an opted-in guest is identified.

    Name, evidence, reason to speak — the evidence line is whichever fact
    most earns the associate's next sentence: something left in a cart beats a
    recommendation, because it is something the guest already chose.
    """
    name = guest.get("name", "")
    cart = cart or []
    sizes = guest.get("sizes") or {}

    if cart:
        item = cart[0]
        evidence = f"LEFT THE {item['name']} IN THEIR CART"
        reason = f"OFFER IT IN SIZE {sizes.get('tops', '')}".strip()
    elif top:
        evidence = f"SHOW THE {top['name']}"
        reason = f"AT {top.get('location', 'THE FLOOR')}"
    else:
        evidence = f"{guest.get('loyalty_tier', '')} MEMBER".strip()
        reason = "ASK WHAT BROUGHT THEM IN"

    meta = [
        f"{guest.get('loyalty_tier', '')}",
        f"{guest.get('loyalty_points', 0)} PTS",
        f"SIZE {sizes.get('tops', '')} · {sizes.get('bottoms', '')}".strip(" ·"),
    ]
    return build([name, evidence, reason], meta)


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
