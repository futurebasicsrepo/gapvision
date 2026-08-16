"""The contract between the composer and the glass.

    python -m pytest tests/test_cue_budgets.py -q

No database, no network — this is a contract test between two packages that
deploy separately and cannot import each other.

What the contract used to be, and why it changed
------------------------------------------------
`layout.ts` carried the sentence *"`cue.py` shortens the evidence line to
`RAIL_LINE_CHARS` to suit"* while `cue.py` truncated at 60. A guest cue always
has a rail beside it, so every line the service wrote was landing in a box that
was believed to hold 21 characters, and the glass clipped the difference
silently, on a stranger's face. Nothing caught it because nothing could: the
budget lived in TypeScript, the composer lives in Python, and the only thing
joining them was a comment. So this file asserted that the two numbers agreed.

They agreed on a number that could not have been right. **The G2's font is
proportional** — eleven characters is 56px of `IIIIIIIIIII` or 176px of
`WWWWWWWWWWW`, a 3.1× range — so a character count is not a description of a
box, and both ends of the contract were writing to one. The glass now measures
every string against Even Realities' own font tables (`@evenrealities/pretext`)
and fits it to the box exactly, at the pixel.

**The server cannot do that, and must stop pretending to.** The metrics package
is JavaScript; this service is Python. There is no honest number to transcribe.

So the contract is now: **the server writes short, and the glass fits exactly.**
This file tests that — the shape of a cue, and a guard generous enough to be
about absurd input rather than about a box the service cannot see. It no longer
reads `layout.ts` at all, because there is no longer anything in `layout.ts`
for it to agree with; agreement was the fault.
"""
from __future__ import annotations

import pathlib
import re

import pytest

from app import cue

REPO = pathlib.Path(__file__).resolve().parents[3]
LAYOUT = REPO / "packages" / "glasses-plugin" / "src" / "layout.ts"


def test_the_service_no_longer_claims_to_fit_the_glass():
    """The caps are sanity guards, and have to be obviously too big to be a fit.

    A number that looks like a box invites the next person to treat it as one —
    which is exactly how `RAIL_LINE_CHARS = 21` came to be transcribed into a
    service that has never been able to measure a glyph. Anything near a real
    line's worth of characters would read as a budget again.
    """
    assert cue.RAIL_LINE_CHARS >= 100, (
        "the guard is meant to stop a paragraph, not to fit a box — a number "
        "in the range of a real line reads as a budget and will be treated as "
        "one"
    )
    assert cue.LINE_CHARS >= 100
    assert cue.FACT_CHARS >= 30


def test_the_glass_no_longer_publishes_a_character_budget():
    """The other half: `layout.ts` must not offer one to transcribe.

    A regex over the source rather than a node subprocess, because this test
    has to run in an environment with no toolchain. If somebody reintroduces
    `LINE_CHARS`, `RAIL_LINE_CHARS`, `FACT_CHARS` or `fitChars` on the glass
    side, this fails and the conversation happens before the number spreads
    into a second language again.
    """
    source = LAYOUT.read_text()
    # Declarations only. `layout.ts` still *narrates* `CHAR_ASPECT` and
    # `fitChars` at length, because the reasoning that retired them is worth
    # more than the two lines of code were — so this looks for code, at the
    # start of a line, rather than for the words anywhere in the file.
    banned = [
        r"^\s*(LINE_CHARS|RAIL_LINE_CHARS|FACT_CHARS)\s*:",
        r"^\s*(export )?(const|function) fitChars\b",
        r"^\s*const CHAR_ASPECT\b",
    ]
    for pattern in banned:
        hit = re.search(pattern, source, re.M)
        assert not hit, (
            f"{hit.group(0)!r} is back in layout.ts. Character budgets are what "
            f"this contract stopped being: the font is proportional, so the "
            f"glass measures and the service writes short."
        )
    # And the pixel budgets it publishes instead really are there, so this test
    # fails loudly if the geometry is restructured rather than passing on the
    # absence of everything.
    for expected in ("LINE_PX:", "RAIL_LINE_PX:", "FACT_PX:"):
        assert expected in source, f"{expected!r} missing — has the geometry moved?"


def test_a_guest_cue_is_written_short_enough_to_read_out_loud():
    """The real constraint on the composer, now that the box is not its job.

    Not a pixel budget in disguise: this is the two-second read the identity
    system asks for, which is a property of the sentence rather than of the
    display. The glass will fit whatever arrives; what it cannot do is make a
    long sentence glanceable.
    """
    guest = {
        "name": "Maya Okafor", "loyalty_tier": "Icon", "loyalty_points": 4200,
        "sizes": {"tops": "M", "bottoms": "28x30"}, "zone": "Denim Wall",
    }
    cases = [
        ([{"sku": "A", "name": "Mid Rise Vintage Slim Jeans"}],
         {"name": "CashSoft Crew Sweater", "location": "Knitwear"}),
        ([], {"name": "Icon Denim Jacket", "location": "Outerwear"}),
        ([], None),
    ]
    for cart, top in cases:
        c = cue.guest_cue(guest, top, cart)
        assert len(c["lines"]) <= cue.CUE_LINES
        for line in c["lines"]:
            # Generous, and deliberately about reading rather than fitting: the
            # glass truncates at the pixel, and an associate cannot absorb a
            # 40-character line at arm's length while talking to somebody.
            assert len(line) <= 40, f"{line!r} is not a glanceable line"
        assert len(c["meta"]) <= cue.META_FACTS


def test_the_composer_writes_in_the_glass_charset():
    """Everything outside it is replaced on the way to the display.

    The glass charset is derived from the font's own tables now, and it is
    *wider* than it was — box drawing, blocks and the arrow are all in the font
    and were banned by a hand-written literal. What the service writes is
    narrower than that on purpose: the brand allows uppercase, digits, money
    and the interpunct, and a comma written here arrives as a hole.
    """
    guest = {"name": "Maya Okafor", "loyalty_tier": "Icon",
             "sizes": {"tops": "M"}, "zone": "Denim Wall"}
    c = cue.guest_cue(guest, {"name": "Icon Denim Jacket, Washed"}, [])
    for line in [*c["lines"], *c["meta"]]:
        assert not re.search(r"[^A-Z0-9 ·%$£€/+-]", line), line


def test_a_long_line_is_left_for_the_glass_to_fit():
    """The point of raising the guard: nothing is cut here that need not be.

    `glassify` truncates on a word boundary at the cap, so a sentence under it
    passes through whole and reaches the lens intact — where it is measured
    against the actual box. Under the old 21-character budget this sentence
    lost its last two words in Python, before anything with access to the font
    tables ever saw it.
    """
    line = "OFFER THE CASHSOFT CREW IN SIZE M"
    assert cue.glassify(line, cue.RAIL_LINE_CHARS) == line
    assert len(line) > 21, "this test is meaningless if it fits the old budget"


def test_the_guard_still_stops_something_absurd():
    """It exists for input that is not a cue at all."""
    paragraph = "WORD " * 200
    out = cue.glassify(paragraph, cue.RAIL_LINE_CHARS)
    assert len(out) <= cue.RAIL_LINE_CHARS


def test_the_name_is_not_in_the_cue_lines():
    """It lives on the rail, and a row is too expensive to spend twice.

    The rail pins the name on the left where it stays put; the three lines on
    the right are the only part that moves. Putting the name in both spends one
    of three rows on a word already on screen.

    And the name fits the rail whole now — `MAYA OKAFOR` is 127px in a 156px
    column, where the old ten-character budget shortened it to `MAYA O`.
    """
    guest = {"name": "Maya Okafor", "loyalty_tier": "Icon",
             "sizes": {"tops": "M"}, "zone": "Denim Wall"}
    c = cue.guest_cue(guest, {"name": "Icon Denim Jacket"}, [])
    assert not any("MAYA" in line for line in c["lines"]), c["lines"]


def test_the_meta_strip_does_not_repeat_the_rail():
    """Tier, points and sizes are rail rows, and meta sits under the rail."""
    guest = {"name": "Maya Okafor", "loyalty_tier": "Icon",
             "loyalty_points": 4200, "sizes": {"tops": "M", "bottoms": "28x30"},
             "zone": "Denim Wall"}
    meta = " ".join(cue.guest_cue(guest, None, [])["meta"])
    for repeated in ("ICON", "4200", "PTS", "28X30"):
        assert repeated not in meta, f"{repeated!r} is already a rail row: {meta!r}"


def test_a_cart_no_longer_discards_the_recommendation():
    """The strongest case used to say the least.

    Someone who left something behind *and* has something worth showing is the
    best cue this system can produce, and it was the one that dropped a fact —
    the recommendation was computed and thrown away whenever a cart existed.
    """
    guest = {"name": "Maya Okafor", "sizes": {"tops": "M"}, "zone": "Denim Wall"}
    c = cue.guest_cue(guest, {"name": "CashSoft Crew"},
                      [{"sku": "A", "name": "Vintage Slim Jeans"}])
    assert len(c["lines"]) == 3, c["lines"]
    assert any("CASHSOFT" in line for line in c["lines"]), c["lines"]


@pytest.mark.parametrize("value,expected", [
    (89.95, "$90"),
    (680, "$680"),
    ("nonsense", ""),
])
def test_money_is_whole_units(value, expected):
    """Decimals are punctuation. The charset has no full stop, so "$89.95"
    would arrive as "$89 95" — one number that reads as two."""
    assert cue.money(value) == expected
