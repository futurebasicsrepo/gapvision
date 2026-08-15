"""Draw the pages `buildCue` produces, at 576x288, as the G2 would.

    npm run render:lens

An approximation of one thing only: the host scales glyphs to the container,
so this fits each string to its box's inner height and reports anything that
then overruns the box's width. That is the failure the last two builds shipped
with — a row whose text did not fit the box it was given — and it is the one
thing a preview can catch before an upload.

Everything else here is a lie of convenience: the real display is monochrome
with its own dither, and the mark is gray-4. Judge the fit, not the finish.
"""
import base64
import json
import re
import subprocess
import sys
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H = 576, 288
SCALE = 2

ROOT = Path(__file__).resolve().parents[3]
FONTS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]
FONT_PATH = next((f for f in FONTS if Path(f).exists()), None)


def font_for(box_h):
    """The host scales the glyph to the box; approximate by fitting cap height."""
    size = max(6, int((box_h - 6) * SCALE))
    if not FONT_PATH:
        return ImageFont.load_default()
    return ImageFont.truetype(FONT_PATH, size)


pages = json.loads(subprocess.check_output(
    ["node", str(ROOT / "packages/glasses-plugin/test/render-lens.mjs")], text=True))

mark_src = (ROOT / "packages/glasses-plugin/src/mark.ts").read_text()
b64 = "".join(re.findall(r'"([A-Za-z0-9+/=]{8,})"', mark_src))
mark = Image.open(BytesIO(base64.b64decode(b64))).convert("L")

overruns = []
tiles = []

for name, page in pages.items():
    img = Image.new("RGB", (W * SCALE, H * SCALE), (6, 8, 14))
    d = ImageDraw.Draw(img)

    def cell(x, y, w, h, text, dim=False, box=False):
        f = font_for(h)
        fill = (150, 168, 190) if dim else (232, 244, 255)
        if box:
            d.rounded_rectangle([x * SCALE, y * SCALE, (x + w) * SCALE, (y + h) * SCALE],
                                radius=2 * SCALE, outline=(90, 105, 125), width=1)
        d.text((x * SCALE + 4 * SCALE, (y + h / 2) * SCALE), text, font=f, fill=fill,
               anchor="lm")
        used = d.textlength(text, font=f) / SCALE + 8
        if used > w:
            overruns.append(f"{name}: {text[:28]!r} needs {used:.0f}px in a {w}px box")

    for c in page["textObject"]:
        dim = c["containerName"] in ("cue-label", "cue-clock", "cue-meta", "cue-modules")
        cell(c["xPosition"], c["yPosition"], c["width"], c["height"], c["content"], dim)

    for c in page.get("listObject", []):
        rows = c["itemContainer"]["itemName"]
        row_h = c["height"] / max(1, len(rows))
        d.rounded_rectangle(
            [c["xPosition"] * SCALE, c["yPosition"] * SCALE,
             (c["xPosition"] + c["width"]) * SCALE, (c["yPosition"] + c["height"]) * SCALE],
            radius=2 * SCALE, outline=(90, 105, 125), width=1)
        for i, row in enumerate(rows):
            cell(c["xPosition"] + 6, c["yPosition"] + i * row_h,
                 c["width"] - 12, row_h, row, dim=(i > 0))

    for c in page.get("imageObject", []):
        m = mark.resize((c["width"] * SCALE, c["height"] * SCALE), Image.LANCZOS)
        # Pasted through itself as a mask, because the lens is additive: black
        # in the mark is unlit, not a black square. Pasting it opaquely draws a
        # rectangle that does not exist on the glass.
        img.paste(Image.merge("RGB", (m, m, m)),
                  (c["xPosition"] * SCALE, c["yPosition"] * SCALE), m)

    tiles.append((name, img))

pad, label = 16, 26
sheet = Image.new("RGB", (W * SCALE + pad * 2,
                          (H * SCALE + label + pad) * len(tiles) + pad), (18, 20, 26))
sd = ImageDraw.Draw(sheet)
lf = font_for(11)
y = pad
for name, img in tiles:
    sd.text((pad, y), f"{name.upper()}   576 x 288", font=lf, fill=(150, 168, 190))
    sheet.paste(img, (pad, y + label))
    y += H * SCALE + label + pad

out = ROOT / "packages/glasses-plugin/store/lens-preview.png"
sheet.save(out)
print(f"wrote {out}")

if overruns:
    print("\nrows that do not fit their container:")
    for o in overruns:
        print(f"  {o}")
    sys.exit(1)
print("every row fits its container")
