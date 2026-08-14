"""Store icon assets for Even Hub.

Even rejects colour assets — icons must be monochrome/greyscale. The brand
rule that the cue is always flame cannot hold here, so the cue is rendered at
flame's *relative luminance* instead: the same tonal step down from the arc
that flame reads as against paper. The shape survives; only the hue is spent.

Drawn from the construction spec (32-grid, r=11, 70 degree gap on the 3
o'clock axis, cue r=2.9 at optical centre) rather than traced, and at the
largest compensation step because these render big.
"""
import math
from PIL import Image, ImageDraw

S = 1024
G = S / 32.0            # one grid unit

def lum(hexstr):
    r, g, b = (int(hexstr[i:i+2], 16) / 255 for i in (1, 3, 5))
    f = lambda c: c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    y = 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    v = int(round((y ** (1 / 2.2)) * 255))
    return (v, v, v)

SEA900, PAPER, FLAME = lum("#04122E"), lum("#FBF9F5"), lum("#FF6B2C")
print("sea-900", SEA900, "paper", PAPER, "flame", FLAME)

# --- background: flat, so the foreground carries every edge ---
bg = Image.new("RGBA", (S, S), SEA900 + (255,))
bg.save("packages/glasses-plugin/store/icon-background.png")

# --- foreground: transparent, arc + cue ---
SCALE = 4                      # supersample, then downsample for clean curves
fg = Image.new("RGBA", (S * SCALE, S * SCALE), (0, 0, 0, 0))
d = ImageDraw.Draw(fg)

c = 16 * G * SCALE
r = 11 * G * SCALE
stroke = 4.0 * G * SCALE
cue_r = 2.9 * G * SCALE

# 70 degree total gap centred on 0 degrees, so the stroke runs +35 -> 325.
d.arc([c - r, c - r, c + r, c + r], start=35, end=325,
      fill=PAPER + (255,), width=int(stroke))
# PIL draws butt ends; the spec calls for round caps, and at this size the
# difference is visible. Cap each terminal with a circle of the stroke width.
# PIL grows an arc's width inward from the bounding box, so the stroke's
# centreline sits at r - stroke/2, not r. Caps go on the centreline.
rc = r - stroke / 2
for deg in (35, -35):
    a = math.radians(deg)
    ex, ey = c + rc * math.cos(a), c + rc * math.sin(a)
    d.ellipse([ex - stroke / 2, ey - stroke / 2, ex + stroke / 2, ey + stroke / 2],
              fill=PAPER + (255,))
d.ellipse([c - cue_r, c - cue_r, c + cue_r, c + cue_r], fill=FLAME + (255,))

fg = fg.resize((S, S), Image.LANCZOS)
fg.save("packages/glasses-plugin/store/icon-foreground.png")

# --- flattened preview, plus the 48px legibility check ---
flat = Image.alpha_composite(bg, fg)
flat.save("/tmp/icon-flat.png")
strip = Image.new("RGBA", (S + 400, S), (20, 20, 20, 255))
strip.paste(flat, (0, 0))
y = 40
for size in (256, 128, 64, 48, 32):
    strip.paste(flat.resize((size, size), Image.LANCZOS), (S + 60, y))
    y += size + 30
strip.save("/tmp/icon-sizes.png")
print("written")
