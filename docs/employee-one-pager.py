"""The employee one-pager: turn on, pair, control.

    python3 docs/employee-one-pager.py

Writes SVG, print-ready PDF and a PNG into `packages/internal/public/docs/`,
so an operator can pull it up in the Console and print it for a stock room
wall.

Why a generator and not a drawing
---------------------------------
The gesture half of this page is not documentation *about* the code, it *is*
the code — every row comes from the switch in `glasses-plugin/src/main.ts`.
A hand-drawn PDF of a control scheme goes wrong the first time somebody adds a
gesture, and it goes wrong silently, in a stock room, on a wall nobody thinks
to check. Keeping it generated means the page and the plugin move together.

Where the facts come from, because it matters that these are not invented
-------------------------------------------------------------------------
Hardware — power, case, pairing — is from Even Realities' own documentation
(support.evenrealities.com and hub.evenrealities.com, read 2026-08-15). Notably
**the G2 has no power button**: the case is the switch. That is the single most
surprising thing for a new wearer and it leads the page for that reason.

Control is from our own source. The G2's native temple gestures exist too and
do other things inside Even's own dashboard — that distinction is on the page,
because an associate who taps their temple expecting Cue and gets Even's menu
will conclude the glasses are broken.
"""
from __future__ import annotations

import json
from pathlib import Path

import cairosvg

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "packages/internal/public/docs"
TOKENS = json.loads((ROOT / "packages/brand/tokens.json").read_text())
HEX = {s["token"].lstrip("-").replace("-", "_"): s["hex"]
       for r in TOKENS["ramps"] for s in r["steps"]}

INK, PAPER, FLAME = HEX["ink_900"], HEX.get("paper", "#FBF9F5"), HEX["flame"]
SEA, MUTED, RULE = HEX["sea_700"], HEX["ink_500"], "#D9D5CE"

# A4 portrait at 96dpi. Printed on paper, not read on the product's dark
# ground — this is the one Cue surface that lives in a stock room.
W, H = 794, 1123
M = 46


def esc(t: str) -> str:
    return (t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def text(x, y, s, size=11, fill=INK, weight="400", anchor="start",
         family="sans", spacing=None) -> str:
    fam = {"sans": "Instrument Sans, Helvetica, Arial, sans-serif",
           "mono": "IBM Plex Mono, ui-monospace, monospace"}[family]
    ls = f' letter-spacing="{spacing}"' if spacing else ""
    return (f'<text x="{x}" y="{y}" font-family="{fam}" font-size="{size}" '
            f'fill="{fill}" font-weight="{weight}" text-anchor="{anchor}"{ls}>'
            f'{esc(s)}</text>')


def mark(cx, cy, r, arc=INK, cue=FLAME) -> str:
    """The Cue Bracket, from the construction spec in tokens.json."""
    import math
    stroke = r * (4.0 / 11.0)
    p = lambda d: (cx + r * math.cos(math.radians(d)), cy - r * math.sin(math.radians(d)))
    x1, y1 = p(35)
    x2, y2 = p(-35)
    return (f'<path d="M {x1:.2f} {y1:.2f} A {r} {r} 0 1 0 {x2:.2f} {y2:.2f}" '
            f'fill="none" stroke="{arc}" stroke-width="{stroke:.2f}" '
            f'stroke-linecap="round"/>'
            f'<circle cx="{cx}" cy="{cy}" r="{r * (2.9 / 11.0):.2f}" fill="{cue}"/>')


def panel(x, y, w, h) -> str:
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" '
            f'fill="#FFFFFF" stroke="{RULE}" stroke-width="1"/>')


def step_num(x, y, n) -> str:
    return (f'<circle cx="{x}" cy="{y}" r="11" fill="{SEA}"/>'
            + text(x, y + 4, str(n), 12, PAPER, "600", "middle"))


# --- gesture glyphs ----------------------------------------------------------
# Small, geometric, and readable at print size. A ring seen face-on with the
# thumb's motion shown as an arrow or a dot; that is all the fidelity a
# one-pager can carry and all it needs.

def g_press(x, y) -> str:
    return (f'<circle cx="{x}" cy="{y}" r="12" fill="none" stroke="{INK}" stroke-width="2"/>'
            f'<circle cx="{x}" cy="{y}" r="4.5" fill="{FLAME}"/>')


def g_double(x, y) -> str:
    return (f'<circle cx="{x}" cy="{y}" r="12" fill="none" stroke="{INK}" stroke-width="2"/>'
            f'<circle cx="{x - 4.5}" cy="{y}" r="3.4" fill="{FLAME}"/>'
            f'<circle cx="{x + 4.5}" cy="{y}" r="3.4" fill="{FLAME}"/>')


def g_scroll(x, y, up=True) -> str:
    """Arrow points the way the thumb travels. The first version put the head
    at the tail, so `up` drew a down arrow — invisible in code, obvious the
    moment it was rendered, and the sort of thing a printed page carries onto a
    wall for a year."""
    tip = y - 6 if up else y + 6
    tail = y + 6 if up else y - 6
    barb = y - 1 if up else y + 1
    return (f'<circle cx="{x}" cy="{y}" r="12" fill="none" stroke="{INK}" stroke-width="2"/>'
            f'<path d="M {x} {tail} L {x} {tip}" stroke="{FLAME}" '
            f'stroke-width="2.4" stroke-linecap="round"/>'
            f'<path d="M {x - 4.5} {barb} L {x} {tip} L {x + 4.5} {barb}" '
            f'fill="none" stroke="{FLAME}" stroke-width="2.4" '
            f'stroke-linecap="round" stroke-linejoin="round"/>')


GLYPH = {"press": g_press, "double": g_double,
         "up": lambda x, y: g_scroll(x, y, True),
         "down": lambda x, y: g_scroll(x, y, False)}


def gesture_row(x, y, glyph, title, body) -> str:
    return (GLYPH[glyph](x + 14, y)
            + text(x + 38, y - 2, title, 11.5, INK, "600")
            + text(x + 38, y + 13, body, 10, MUTED))


def build() -> str:
    s: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" '
        f'width="{W}" height="{H}">',
        f'<rect width="{W}" height="{H}" fill="{PAPER}"/>',
    ]

    # --- header ---------------------------------------------------------
    s.append(mark(M + 15, M + 12, 15))
    s.append(text(M + 40, M + 18, "Cue Lens", 21, INK, "600"))
    s.append(text(W - M, M + 6, "YOUR GLASSES, IN ONE PAGE", 9.5, MUTED, "500",
                  "end", "mono", "0.12em"))
    s.append(text(W - M, M + 22, "Keep this. It is the whole thing.", 10, MUTED,
                  "400", "end"))
    s.append(f'<line x1="{M}" y1="{M + 40}" x2="{W - M}" y2="{M + 40}" '
             f'stroke="{RULE}" stroke-width="1"/>')

    # --- 1. turn on -----------------------------------------------------
    y = M + 62
    s.append(text(M, y + 4, "1 · TURN THEM ON", 12, INK, "600", "start", "mono", "0.1em"))
    s.append(text(M, y + 22, "There is no power button. The case is the switch.",
                  11.5, FLAME, "600"))
    s.append(panel(M, y + 34, W - M * 2, 128))

    cx = M + 24
    cy = y + 92
    # closed case
    s.append(f'<rect x="{cx}" y="{cy - 22}" width="74" height="44" rx="9" '
             f'fill="none" stroke="{INK}" stroke-width="2"/>')
    s.append(f'<line x1="{cx}" y1="{cy}" x2="{cx + 74}" y2="{cy}" '
             f'stroke="{INK}" stroke-width="1.4"/>')
    s.append(step_num(cx + 37, cy - 40, 1))
    s.append(text(cx + 37, cy + 52, "Glasses in, lid shut", 9.5, MUTED,
                  "400", "middle"))

    # open case + light
    ox = cx + 168
    s.append(f'<path d="M {ox} {cy + 22} L {ox} {cy} L {ox + 74} {cy} '
             f'L {ox + 74} {cy + 22} Z" fill="none" stroke="{INK}" stroke-width="2"/>')
    s.append(f'<path d="M {ox + 4} {cy - 4} L {ox + 22} {cy - 30} '
             f'L {ox + 78} {cy - 30} L {ox + 70} {cy - 4} Z" fill="none" '
             f'stroke="{INK}" stroke-width="2" stroke-linejoin="round"/>')
    s.append(f'<circle cx="{ox + 37}" cy="{cy + 11}" r="5" fill="{PAPER}" '
             f'stroke="{INK}" stroke-width="1.6"/>')
    s.append(step_num(ox + 37, cy - 40, 2))
    s.append(text(ox + 37, cy + 52, "Open the lid — they wake up", 9.5,
                  MUTED, "400", "middle"))

    # light meaning
    lx = cx + 344
    s.append(f'<circle cx="{lx}" cy="{cy - 8}" r="8" fill="#FFFFFF" '
             f'stroke="{INK}" stroke-width="1.6"/>')
    s.append(text(lx + 18, cy - 4, "White — charged and ready", 10.5, INK, "500"))
    s.append(f'<circle cx="{lx}" cy="{cy + 16}" r="8" fill="{FLAME}"/>')
    s.append(text(lx + 18, cy + 20, "Orange — still charging, or seated wrong",
                  10.5, INK, "500"))
    s.append(text(lx - 24, cy + 44, "Flashing orange — they are not sitting on the",
                  9.5, MUTED))
    s.append(text(lx - 24, cy + 57, "charging pins. Take them out and reseat them.",
                  9.5, MUTED))
    s.append(step_num(lx - 24, cy - 40, 3))

    # --- 2. pair --------------------------------------------------------
    y2 = y + 188
    s.append(text(M, y2 + 4, "2 · PAIR THEM, ONCE", 12, INK, "600", "start",
                  "mono", "0.1em"))
    s.append(text(M, y2 + 22, "Only the first time. After that they connect "
                  "themselves.", 11.5, MUTED))
    s.append(panel(M, y2 + 30, W - M * 2, 124))

    py = y2 + 52
    phone = M + 26
    s.append(f'<rect x="{phone}" y="{py}" width="46" height="76" rx="7" '
             f'fill="none" stroke="{INK}" stroke-width="2"/>')
    s.append(f'<line x1="{phone + 15}" y1="{py + 8}" x2="{phone + 31}" y2="{py + 8}" '
             f'stroke="{INK}" stroke-width="2" stroke-linecap="round"/>')
    s.append(mark(phone + 23, py + 42, 11))
    s.append(text(phone + 23, py + 88, "The Even app", 9.5, MUTED, "400", "middle"))

    steps = [
        ("Open the Even app and sign in.", ""),
        ("Take the glasses out of the open case.",
         "They are only discoverable while awake."),
        ("Pick your G2 from the list the app finds.", ""),
        ("Wait for it to say Connected.", "Then open Cue."),
    ]
    sx = phone + 92
    for n, (head, sub) in enumerate(steps, 1):
        # Two lines per step, always — estimating where a string ends in order
        # to start another beside it is how the first draft overlapped.
        ry = py + 8 + (n - 1) * 23
        s.append(step_num(sx, ry, n))
        s.append(text(sx + 20, ry + 4, head, 11, INK, "500"))
        if sub:
            s.append(text(sx + 250, ry + 4, sub, 9.5, MUTED))

    # --- 3. control -----------------------------------------------------
    y3 = y2 + 182
    s.append(text(M, y3 + 4, "3 · CONTROL IT", 12, INK, "600", "start", "mono", "0.1em"))
    s.append(text(M, y3 + 20, "Use the ring. Your temple does the same things — "
                  "but reaching up is a tell, and the customer sees it.",
                  11.5, MUTED))

    col_w = (W - M * 2 - 16) / 2
    s.append(panel(M, y3 + 30, col_w, 208))
    s.append(panel(M + col_w + 16, y3 + 30, col_w, 208))

    s.append(text(M + 18, y3 + 54, "NOBODY IN FRONT OF YOU", 10, SEA, "600",
                  "start", "mono", "0.09em"))
    s.append(text(M + col_w + 34, y3 + 54, "WITH A CUSTOMER", 10, SEA, "600",
                  "start", "mono", "0.09em"))

    left = [
        ("press", "Press", "Ask a question out loud"),
        ("double", "Press twice", "Puts the glasses away"),
        ("up", "Scroll up", "Type size check (for us, not you)"),
        ("down", "Scroll down", "The floor — messages, and replies"),
    ]
    right = [
        ("down", "Scroll", "Move through their cards"),
        ("press", "Press", "Back to the cue. Again to finish"),
        ("double", "Press twice", "Ask a question out loud"),
        ("press", "Press on an urgent message", "Takes it — replies On my way"),
    ]
    for n, (glyph, title, body) in enumerate(left):
        s.append(gesture_row(M + 12, y3 + 90 + n * 38, glyph, title, body))
    for n, (glyph, title, body) in enumerate(right):
        s.append(gesture_row(M + col_w + 28, y3 + 90 + n * 38, glyph, title, body))

    # The cards, named, because "their cards" above is otherwise abstract.
    cy2 = y3 + 258
    s.append(text(M, cy2, "Their cards, in order:", 10.5, INK, "600"))
    chips = ["CUE", "SIZES", "CART", "HISTORY", "SHIP", "CONTACT", "PICKS"]
    x = M + 128
    for c in chips:
        w = 11 + len(c) * 6.6
        s.append(f'<rect x="{x}" y="{cy2 - 12}" width="{w:.0f}" height="18" rx="9" '
                 f'fill="none" stroke="{RULE}" stroke-width="1"/>')
        s.append(text(x + w / 2, cy2 + 1, c, 8.5, MUTED, "500", "middle", "mono"))
        x += w + 7

    # --- 4. what you see ------------------------------------------------
    # An associate meets this display before they ever meet a gesture, and a
    # page that explains the controls without showing the thing being
    # controlled leaves them working it out on a customer.
    y4 = y3 + 282
    s.append(text(M, y4, "4 · WHAT YOU SEE", 12, INK, "600", "start", "mono", "0.1em"))
    s.append(text(M, y4 + 18, "Only you can see it. It is not a screen the "
                  "customer can read over your shoulder.", 11.5, MUTED))
    s.append(panel(M, y4 + 28, W - M * 2, 182))

    # The lens, to scale: 576x288 becomes 380x190.
    lx0, ly0, lw, lh = M + 28, y4 + 44, 300, 150
    s.append(f'<rect x="{lx0}" y="{ly0}" width="{lw}" height="{lh}" rx="6" '
             f'fill="{HEX["sea_900"]}"/>')
    k = lw / 576.0
    s.append(mark(lx0 + 34 * k, ly0 + 26 * k, 13 * k, arc=PAPER, cue=FLAME))
    s.append(text(lx0 + lw - 14, ly0 + 30 * k, "14·32", 9, "#8FC7F0", "500",
                  "end", "mono"))
    # rail
    s.append(f'<rect x="{lx0 + 20 * k}" y="{ly0 + 52 * k}" width="{168 * k}" '
             f'height="{156 * k}" rx="3" fill="none" stroke="#8FC7F0" '
             f'stroke-opacity="0.5" stroke-width="1"/>')
    for n, row in enumerate(["SARAH CHEN", "ICON", "4200 PTS", "TOP M", "BTM 28X30"]):
        s.append(text(lx0 + 28 * k, ly0 + (72 + n * 26) * k, row, 7.5,
                      PAPER if n == 0 else "#8FC7F0", "500", "start", "mono"))
    # the three lines
    for n, row in enumerate(["IN CART CASHSOFT CREW", "BOUGHT BARREL JEANS",
                             "OFFER IT IN SIZE M"]):
        s.append(text(lx0 + 202 * k, ly0 + (72 + n * 32) * k, row, 8.5, PAPER,
                      "500", "start", "mono"))
    s.append(text(lx0 + 20 * k, ly0 + 262 * k, "DENIM WALL", 7.5, "#8FC7F0",
                  "500", "start", "mono"))
    s.append(text(lx0 + 202 * k, ly0 + 262 * k, "CUE 1/7", 7.5, "#8FC7F0",
                  "500", "start", "mono"))

    notes = [
        ("Who they are", "Stays put on the left while you scroll."),
        ("What to say", "Three lines. Never more — you are talking, not reading."),
        ("Where you are", "CUE 1/7 means card one of seven."),
    ]
    nx = lx0 + lw + 26
    for n, (head, body) in enumerate(notes):
        ny = ly0 + 24 + n * 48
        s.append(f'<circle cx="{nx}" cy="{ny - 4}" r="3" fill="{FLAME}"/>')
        s.append(text(nx + 12, ny, head, 11, INK, "600"))
        s.append(text(nx + 12, ny + 15, body, 9.5, MUTED))

    # --- footer ---------------------------------------------------------
    fy = H - M - 82
    s.append(f'<line x1="{M}" y1="{fy - 14}" x2="{W - M}" y2="{fy - 14}" '
             f'stroke="{RULE}" stroke-width="1"/>')
    s.append(text(M, fy + 6, "IF SOMETHING IS WRONG", 10, INK, "600", "start",
                  "mono", "0.09em"))

    fixes = [
        ("Nothing on the glass", "Take them off and put them back on."),
        ("Cue will not open", "Check the Even app says Connected."),
        ("A tap did something odd",
         "You were in Even's own menu, not Cue. Press twice to come back."),
        ("Still wrong", "Tell your manager. Do not factory reset them."),
    ]
    for n, (a, b) in enumerate(fixes):
        ly = fy + 24 + n * 15
        s.append(text(M, ly, a, 10, INK, "600"))
        s.append(text(M + 168, ly, b, 10, MUTED))

    s.append(text(W - M, H - 26, "cuesea.ai", 9.5, MUTED, "400", "end",
                  "mono", "0.08em"))
    s.append("</svg>")
    return "\n".join(s)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    svg = build()
    (OUT / "cue-employee-one-pager.svg").write_text(svg)
    cairosvg.svg2pdf(bytestring=svg.encode(),
                     write_to=str(OUT / "cue-employee-one-pager.pdf"))
    cairosvg.svg2png(bytestring=svg.encode(),
                     write_to=str(OUT / "cue-employee-one-pager.png"),
                     output_width=W * 2)
    print(f"wrote 3 files to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
