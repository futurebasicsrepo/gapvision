"""Home-screen icons for Pocket.

Same construction as the Even Hub store icons (32-grid, r=11, 70 degree gap on
the 3 o'clock axis, cue at optical centre) — but in full colour, because unlike
Even's store, a phone home screen has no monochrome rule and the cue being
flame is the brand's one non-negotiable.

Three outputs, and the third is the one people forget:

  icon-192 / icon-512     the manifest's "any" icons, drawn edge to edge
  icon-maskable-512       Android crops every icon to whatever mask the
                          launcher wants — circle, squircle, teardrop. A
                          maskable icon must keep everything meaningful inside
                          the safe zone (the middle 80%), or Android eats the
                          arc. Same mark, drawn smaller on a full bleed ground.
  apple-touch-icon        iOS reads none of the manifest. Without this PNG at
                          180x180, "Add to Home Screen" produces a screenshot
                          of the page, which is how a serious tool ends up
                          looking like a bookmark.

    python3 packages/pocket/scripts/make-icons.py
"""
import math
import pathlib

from PIL import Image, ImageDraw

OUT = pathlib.Path(__file__).resolve().parent.parent / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

SLATE_900 = (0x14, 0x19, 0x20, 255)   # the product ground, brand v3.2
PAPER = (0xFB, 0xF9, 0xF5, 255)
FLAME = (0xFF, 0x6B, 0x2C, 255)

SCALE = 4  # supersample, then downsample: the arc has to survive 48px


def mark(size: int, inset: float = 1.0) -> Image.Image:
    """The cuesea mark on the product ground.

    `inset` shrinks the mark within the same canvas — 1.0 fills it the way the
    app icon should, 0.78 pulls it inside Android's maskable safe zone.
    """
    s = size * SCALE
    img = Image.new("RGBA", (s, s), SLATE_900)
    d = ImageDraw.Draw(img)

    g = s / 32.0
    c = 16 * g
    r = 11 * g * inset
    stroke = 4.0 * g * inset
    cue_r = 2.9 * g * inset

    # 70 degree gap centred on 0 degrees: the stroke runs +35 -> 325.
    d.arc([c - r, c - r, c + r, c + r], start=35, end=325, fill=PAPER, width=int(stroke))

    # PIL draws butt ends and grows an arc's width inward from the bounding
    # box, so the stroke's centreline sits at r - stroke/2. Round caps go there.
    rc = r - stroke / 2
    for deg in (35, -35):
        a = math.radians(deg)
        ex, ey = c + rc * math.cos(a), c + rc * math.sin(a)
        d.ellipse([ex - stroke / 2, ey - stroke / 2, ex + stroke / 2, ey + stroke / 2], fill=PAPER)

    d.ellipse([c - cue_r, c - cue_r, c + cue_r, c + cue_r], fill=FLAME)
    return img.resize((size, size), Image.LANCZOS)


def write(name: str, img: Image.Image) -> None:
    path = OUT / name
    img.save(path)
    print(f"  {path.relative_to(OUT.parent.parent.parent.parent)}  {img.size[0]}x{img.size[1]}")


print("pocket icons →")
write("icon-192.png", mark(192))
write("icon-512.png", mark(512))
# 0.78: Android's maskable safe zone is the central 80% circle, and the arc's
# round caps sit at the extremes of the mark, so the margin is real rather than
# cosmetic.
write("icon-maskable-512.png", mark(512, inset=0.78))
write("apple-touch-icon.png", mark(180))
