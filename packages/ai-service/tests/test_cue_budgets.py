"""The character budgets in `cue.py` are `layout.ts`'s, and must stay that way.

    python -m pytest tests/test_cue_budgets.py -q

No database, no network — this is a contract test between two packages that
deploy separately and cannot import each other.

Why it exists
-------------
`layout.ts` carried the sentence *"`cue.py` shortens the evidence line to
`RAIL_LINE_CHARS` to suit"* while `cue.py` truncated at 60. A guest cue always
has a rail beside it, so every line the service wrote was landing in a box that
holds 21 characters, and the glass clipped the difference — nearly two thirds
of a line — silently, on a stranger's face.

Nothing caught it because nothing could: the budget lives in TypeScript, the
composer lives in Python, and the only thing joining them was a comment that
described an intention rather than a fact. This is the join, expressed as an
assertion instead.

The same shape as the `/set-password` tests: when a contract spans two trees
that ship independently, test the contract, not one end of it.
"""
from __future__ import annotations

import pathlib
import re

import pytest

from app import cue

REPO = pathlib.Path(__file__).resolve().parents[3]
LAYOUT = REPO / "packages" / "glasses-plugin" / "src" / "layout.ts"


def _const(name: str) -> int:
    """Read an absolute from layout.ts.

    Deliberately a regex over the source rather than a node subprocess. This
    test has to run in an environment with no toolchain — and if layout.ts is
    ever restructured so these cannot be found, failing loudly is correct: the
    budgets moved and somebody has to look.
    """
    m = re.search(rf"^const {name} = (\d+)", LAYOUT.read_text(), re.M)
    assert m, f"{name} not found in layout.ts — has the geometry been restructured?"
    return int(m.group(1))


def _fit_chars(width: int, height: int) -> int:
    """`fitChars` from layout.ts, in Python.

    Kept as a transcription rather than an import because there is no way to
    import it. If the two ever diverge, the assertions below fail, which is the
    entire point of writing it out.
    """
    pad = _const("PAD")
    return max(0, int((width - pad * 2 - 4) // (height * 0.60)))


DISPLAY_W, DISPLAY_H = 576, 288


def _geometry() -> dict[str, int]:
    x, gutter, row = _const("X"), _const("GUTTER"), _const("ROW_H")
    w = DISPLAY_W - x * 2
    rail_w = round(DISPLAY_W * 168 / 576)
    module_w = w - rail_w - gutter
    return {
        "LINE_CHARS": _fit_chars(w, row),
        "RAIL_LINE_CHARS": _fit_chars(module_w, row),
        "FACT_CHARS": _fit_chars(rail_w, row),
    }


@pytest.mark.parametrize("name", ["LINE_CHARS", "RAIL_LINE_CHARS", "FACT_CHARS"])
def test_the_composer_uses_the_geometry_the_glass_actually_has(name):
    expected = _geometry()[name]
    actual = getattr(cue, name)
    assert actual == expected, (
        f"cue.py {name} is {actual}; layout.ts derives {expected} for the "
        f"576x288 frame. The service would write lines the glass clips."
    )


def test_a_guest_cue_is_written_to_the_railed_budget():
    """The narrow one, because a guest cue always has a rail beside it."""
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
        for line in c["lines"]:
            assert len(line) <= cue.RAIL_LINE_CHARS, (
                f"{line!r} is {len(line)} characters in a "
                f"{cue.RAIL_LINE_CHARS}-character box."
            )
        for fact in c["meta"]:
            assert len(fact) <= cue.FACT_CHARS, (
                f"meta {fact!r} is {len(fact)} characters in a "
                f"{cue.FACT_CHARS}-character box."
            )


def test_the_name_is_not_in_the_cue_lines():
    """It lives on the rail, and a row is too expensive to spend twice.

    The rail pins the name on the left where it stays put; the three lines on
    the right are the only part that moves. Putting the name in both spends one
    of three rows on a word already on screen.
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
