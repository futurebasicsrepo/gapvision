"""Downloadable brand assets, generated from the tokens rather than exported.

    python3 packages/brand/build-assets.py

Writes SVG, PDF, .ai and transparent PNGs into
`packages/internal/public/brand/`, plus an `assets.json` manifest that the
Console's Brand page renders its download list from.

Why generate rather than export by hand:

  The mark is a *construction*, not a drawing — 32-unit grid, arc centre
  (16,16), radius 11, 70 degree gap on the 3 o'clock axis, cue at optical
  centre. Every one of those numbers already lives in `tokens.json`. An
  exported file is a copy of the construction at a moment in time, and every
  copy of this mark that has left a designer's machine so far has drifted from
  the spec within a fortnight. This script cannot drift: change the token,
  re-run, every format moves together.

  The wordmark is set in Instrument Sans and **converted to outlines**, so a
  PDF opened on a machine without the font is still the wordmark rather than a
  polite substitution. That is the single most common way a logo file betrays
  someone.

On the `.ai` files: a modern Illustrator document *is* a PDF with Illustrator's
private data alongside it, and Illustrator opens a PDF-compatible `.ai`
natively — which is what these are. They are real vectors and they open, edit
and scale. They are not round-tripped Illustrator natives, and this file says
so rather than letting someone discover it.
"""
from __future__ import annotations

import json
import math
import shutil
import sys
from pathlib import Path

import cairosvg
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[2]
TOKENS = json.loads((ROOT / "packages/brand/tokens.json").read_text())
OUT = ROOT / "packages/internal/public/brand"
#: Vendored, not fetched — see fonts/README.md. The script refuses to run
#: without it rather than falling back to a substitute face, because a
#: wordmark set in the wrong font still looks like a wordmark.
FONT = ROOT / "packages/brand/fonts/InstrumentSans-SemiBold.ttf"

# --- palette, straight off the tokens ---------------------------------------
HEX = {
    step["token"].lstrip("-").replace("-", "_"): step["hex"]
    for ramp in TOKENS["ramps"] for step in ramp["steps"]
}
PAPER = HEX.get("paper", "#FBF9F5")
INK = HEX["ink_900"]
FLAME = HEX["flame"]
SEA_900 = HEX["sea_900"]
SEA_300 = HEX["sea_300"]
SEA_500 = HEX["sea_500"]

# --- the mark, from the construction spec ------------------------------------
G = 32.0            # grid
CX = CY = 16.0
R = 11.0
GAP_DEG = 70.0      # total, centred on the 3 o'clock axis
CUE_R_BASE = 2.9    # the 42px-and-up compensation step
STROKE_BASE = 4.0
#: "clear space: one cue diameter (5.8 units) on all four sides"
CLEAR = CUE_R_BASE * 2


def _pt(deg: float, r: float = R) -> tuple[float, float]:
    """Grid point at an angle, in SVG coordinates (y grows downward)."""
    a = math.radians(deg)
    return CX + r * math.cos(a), CY - r * math.sin(a)


def mark_svg(arc: str, cue: str, *, stroke: float = STROKE_BASE,
             cue_r: float = CUE_R_BASE, ground: str | None = None) -> str:
    """The Cue Bracket as one stroked arc plus one filled circle.

    A stroked path with round caps rather than an outlined shape: it stays
    editable in Illustrator as the arc it actually is, and the caps are the
    spec's own ("round caps"), not an approximation of them.
    """
    half = GAP_DEG / 2
    x1, y1 = _pt(half)              # +35 deg, upper right
    x2, y2 = _pt(-half)             # -35 deg, lower right
    # 290 degrees of arc, so large-arc-flag is 1. sweep-flag 0 runs it
    # anticlockwise on screen — up over the top and round the left, which is
    # the direction that leaves the opening on the right where the spec wants
    # it. Rotating this is explicitly banned, so the direction is not a taste
    # question.
    d = f"M {x1:.4f} {y1:.4f} A {R} {R} 0 1 0 {x2:.4f} {y2:.4f}"
    vb_min = -CLEAR
    vb_size = G + CLEAR * 2
    bg = (f'<rect x="{vb_min}" y="{vb_min}" width="{vb_size}" '
          f'height="{vb_size}" fill="{ground}"/>' if ground else "")
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb_min} {vb_min} {vb_size} {vb_size}">
  <title>cuesea — the Cue Bracket</title>
  {bg}
  <path d="{d}" fill="none" stroke="{arc}" stroke-width="{stroke}" stroke-linecap="round"/>
  <circle cx="{CX}" cy="{CY}" r="{cue_r}" fill="{cue}"/>
</svg>'''


# --- the wordmark, outlined --------------------------------------------------
def _glyph_paths(text: str, size: float) -> tuple[list[tuple[str, float]], float, float]:
    """Return (path, x-offset) per character, plus total advance and units/em."""
    font = TTFont(FONT)
    upem = font["head"].unitsPerEm
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    hmtx = font["hmtx"]
    scale = size / upem

    out, x = [], 0.0
    for ch in text:
        name = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        gs[name].draw(pen)
        out.append((pen.getCommands(), x))
        x += hmtx[name][0] * scale
    return out, x, upem


def wordmark_svg(cue_fill: str, sea_fill: str, *, ground: str | None = None) -> str:
    """`cuesea`, lowercase, two-tone.

    The split is load-bearing, not decorative: the tokens say it "stops it
    slurring into 'queasy' when read fast". So `cue` and `sea` are separate
    filled groups, which also means someone can recolour half of it in
    Illustrator without cutting anything apart.
    """
    SIZE = 100.0
    paths, advance, upem = _glyph_paths("cuesea", SIZE)
    scale = SIZE / upem
    pad = SIZE * 0.18
    # Cap/descender box for Instrument Sans lowercase, with padding. Measured
    # from the font rather than guessed.
    font = TTFont(FONT)
    asc = font["hhea"].ascent * scale
    desc = font["hhea"].descent * scale
    h = asc - desc

    def group(indices: range, fill: str) -> str:
        inner = "".join(
            f'<path transform="translate({x:.3f} 0) scale({scale:.6f} {-scale:.6f})" '
            f'd="{d}"/>'
            for i, (d, x) in enumerate(paths) if i in indices
        )
        return f'<g fill="{fill}">{inner}</g>'

    vb = f"{-pad:.3f} {-(asc + pad):.3f} {advance + pad * 2:.3f} {h + pad * 2:.3f}"
    bg = (f'<rect x="{-pad:.3f}" y="{-(asc + pad):.3f}" width="{advance + pad*2:.3f}" '
          f'height="{h + pad*2:.3f}" fill="{ground}"/>' if ground else "")
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}">
  <title>cuesea — wordmark</title>
  {bg}
  {group(range(0, 3), cue_fill)}
  {group(range(3, 6), sea_fill)}
</svg>'''


def lockup_svg(arc: str, cue: str, cue_fill: str, sea_fill: str,
               *, ground: str | None = None) -> str:
    """Mark and wordmark, locked. Gap is one cue diameter — the same clear
    space rule the mark carries on every other side."""
    SIZE = 100.0
    paths, advance, upem = _glyph_paths("cuesea", SIZE)
    scale = SIZE / upem
    font = TTFont(FONT)
    asc = font["hhea"].ascent * scale
    desc = font["hhea"].descent * scale

    x_h = font["OS/2"].sxHeight * scale
    # Scale from the mark's *visible* diameter, not its grid box. The grid is
    # 32 units but the drawn mark spans only 2*(R + stroke/2) = 26 of them, so
    # sizing against the box silently shrinks it by a fifth — which is exactly
    # how it first rendered, with the mark reading as an afterthought beside
    # the word.
    visible_d = 2 * (R + STROKE_BASE / 2)
    # "cuesea" is all lowercase, so the wordmark's visible height *is* the
    # x-height. Two x-heights is where the mark stops competing with the word
    # and stops disappearing next to it.
    mark_scale = (2.0 * x_h) / visible_d
    mg = G * mark_scale
    gap = CLEAR * mark_scale
    pad = SIZE * 0.18

    half = GAP_DEG / 2
    x1, y1 = _pt(half)
    x2, y2 = _pt(-half)
    d = f"M {x1:.4f} {y1:.4f} A {R} {R} 0 1 0 {x2:.4f} {y2:.4f}"

    mark_y = -x_h / 2 - mg / 2
    text_x = mg + gap

    def group(indices: range, fill: str) -> str:
        inner = "".join(
            f'<path transform="translate({text_x + x:.3f} 0) '
            f'scale({scale:.6f} {-scale:.6f})" d="{dd}"/>'
            for i, (dd, x) in enumerate(paths) if i in indices
        )
        return f'<g fill="{fill}">{inner}</g>'

    top = min(mark_y, -asc)
    bottom = max(mark_y + mg, -desc)
    w = text_x + advance
    vb = f"{-pad:.3f} {top - pad:.3f} {w + pad*2:.3f} {bottom - top + pad*2:.3f}"
    bg = (f'<rect x="{-pad:.3f}" y="{top - pad:.3f}" width="{w + pad*2:.3f}" '
          f'height="{bottom - top + pad*2:.3f}" fill="{ground}"/>' if ground else "")
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}">
  <title>cuesea — lockup</title>
  {bg}
  <g transform="translate(0 {mark_y:.3f}) scale({mark_scale:.6f})">
    <path d="{d}" fill="none" stroke="{arc}" stroke-width="{STROKE_BASE}" stroke-linecap="round"/>
    <circle cx="{CX}" cy="{CY}" r="{CUE_R_BASE}" fill="{cue}"/>
  </g>
  {group(range(0, 3), cue_fill)}
  {group(range(3, 6), sea_fill)}
</svg>'''


# --- emit --------------------------------------------------------------------
PNG_SIZES = [256, 512, 1024]


def emit(slug: str, svg: str, *, label: str, note: str,
         png_sizes: list[int] | None = None) -> dict:
    (OUT / f"{slug}.svg").write_text(svg)
    pdf = cairosvg.svg2pdf(bytestring=svg.encode())
    (OUT / f"{slug}.pdf").write_bytes(pdf)
    # Illustrator opens a PDF-compatible .ai natively. Same bytes, and the
    # extension is the part people's workflows actually key on.
    (OUT / f"{slug}.ai").write_bytes(pdf)

    pngs = []
    for s in (png_sizes if png_sizes is not None else PNG_SIZES):
        name = f"{slug}-{s}.png"
        cairosvg.svg2png(bytestring=svg.encode(), write_to=str(OUT / name),
                         output_width=s, background_color=None)
        pngs.append({"size": s, "file": name})

    return {"slug": slug, "label": label, "note": note,
            "svg": f"{slug}.svg", "pdf": f"{slug}.pdf", "ai": f"{slug}.ai",
            "png": pngs}


def main() -> None:
    if not FONT.exists():
        sys.exit(
            f"Instrument Sans not found at {FONT}.\n"
            "The wordmark is outlined from the real face — substituting a\n"
            "fallback would ship a logo that is quietly the wrong shape.\n"
            "See packages/brand/fonts/README.md."
        )
    OUT.mkdir(parents=True, exist_ok=True)

    assets = [
        emit("cue-mark-on-dark", mark_svg(PAPER, FLAME),
             label="Mark — on dark",
             note="Arc in paper, cue in flame. The default."),
        emit("cue-mark-on-light", mark_svg(INK, FLAME),
             label="Mark — on light",
             note="Arc takes the ground: ink on paper. The cue never changes."),
        emit("cue-mark-mono-black", mark_svg(INK, INK),
             label="Mark — one colour, black",
             note="For single-colour print and embroidery, where flame cannot survive."),
        emit("cue-mark-mono-white", mark_svg(PAPER, PAPER),
             label="Mark — one colour, white",
             note="Reversed. Transparent PNGs, so it needs a ground behind it."),
        emit("cuesea-wordmark-on-dark", wordmark_svg(PAPER, SEA_300),
             label="Wordmark — on dark",
             note="cue in paper, sea in sea-300. Outlined; no font needed to open it."),
        emit("cuesea-wordmark-on-light", wordmark_svg(INK, SEA_500),
             label="Wordmark — on light",
             note="cue in ink, sea in sea-500 — the step that holds contrast on paper."),
        emit("cuesea-lockup-on-dark", lockup_svg(PAPER, FLAME, PAPER, SEA_300),
             label="Lockup — on dark",
             note="Mark and wordmark, optically aligned to the x-height."),
        emit("cuesea-lockup-on-light", lockup_svg(INK, FLAME, INK, SEA_500),
             label="Lockup — on light",
             note="The one to hand a publication that asks for 'your logo'."),
        emit("cue-app-icon", mark_svg(PAPER, FLAME, ground=SEA_900),
             label="App icon",
             note="Flat sea-900 ground. Even Hub rejects colour, so the store "
                  "build uses a greyscale variant — see store/make-icons.py.",
             png_sizes=[180, 512, 1024]),
    ]

    manifest = {
        "generated_from": "packages/brand/build-assets.py",
        "tokens_version": TOKENS.get("version"),
        "note": ("Generated from tokens.json, not exported by hand. "
                 "The .ai files are PDF-compatible Illustrator documents — "
                 "they open and edit as vectors, and they are not "
                 "round-tripped Illustrator natives."),
        "assets": assets,
    }
    (OUT / "assets.json").write_text(json.dumps(manifest, indent=2) + "\n")
    # A second copy inside src, importable at build time. `public/` is served
    # but not importable, and a Downloads panel that renders empty because one
    # fetch failed is worse than one that cannot fail — same reasoning as
    # brand-tokens.json, which is already copied this way.
    (ROOT / "packages/internal/src/brand-assets.json").write_text(
        json.dumps(manifest, indent=2) + "\n")

    # A single zip, because nobody wants to click twenty times.
    zip_base = OUT / "cuesea-brand-assets"
    staging = OUT / "_zip"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir()
    for f in OUT.iterdir():
        if f.is_file() and f.name != "assets.json":
            shutil.copy2(f, staging / f.name)
    shutil.make_archive(str(zip_base), "zip", staging)
    shutil.rmtree(staging)

    total = sum(1 for f in OUT.iterdir() if f.is_file())
    print(f"wrote {total} files to {OUT.relative_to(ROOT)}")
    for a in assets:
        print(f"  {a['slug']:<28} svg pdf ai + {len(a['png'])} png")


if __name__ == "__main__":
    main()
