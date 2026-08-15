"""Front-door plates — the printable artwork for an acrylic check-in plate.

    python3 packages/brand/build-plates.py --tenant gap \
        --zone "Fitting room 3" --zone "Fitting room 4" --zone "Entrance"

Writes, per zone: a print PDF with bleed and crop marks, a proof PNG, and a
one-page installation sheet. Plus `plates.json` and `write-tags.txt` for
whoever programs the tags.

Why a plate at all
------------------
Every other way of knowing a guest is in a fitting room needs power, a mount,
a calibration pass and a story about what it senses. **A plate is a beacon
that costs eleven dollars and never needs a battery** — the zone is not
inferred, it is printed on the thing and baked into the URL. Move the plate,
the zone moves with it. Nothing in the store has to be told.

Two doors on one plate
----------------------
The tap and the scan carry **different `src` values** (`nfc-plate`,
`qr-plate`) on purpose. They are the same arrival, but they are not the same
door, and after a month of real traffic `GET /api/analytics/doors` can answer
which one people actually use — which is the question that decides whether the
next hundred plates need tags in them at all.

What is deliberately not on the plate
-------------------------------------
No per-plate secret and no plate id. A public URL on a wall is copyable by
anyone who photographs it, and a signature would not change that — it would
only add a key to manage and a reprint whenever it rotated. What bounds the
damage is elsewhere and already built: presence expires on its own, the
check-in page requires the guest to identify themselves, and a plate that has
been abused is retired by changing its zone slug and reprinting one plate.
That costs eleven dollars, which is the whole point of the format.

The one thing that can go wrong on the wall
-------------------------------------------
An unlocked tag on a public plate can be rewritten by any passer-by, into
anything. The installation sheet says lock the tag, in the largest type on the
page, because it is the only security property the plate has.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
import textwrap
from pathlib import Path
from urllib.parse import urlencode

import cairosvg
import segno
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent

# Reuse the mark rather than redraw it — see build-assets.py on why this is a
# construction and not a drawing. The filename has a hyphen, so it loads by
# path rather than by import name.
_spec = importlib.util.spec_from_file_location(
    "brand_assets", HERE / "build-assets.py")
_ba = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_ba)

TOKENS = _ba.TOKENS
PAPER, INK, FLAME = _ba.PAPER, _ba.INK, _ba.FLAME
SEA_500, SEA_900 = _ba.SEA_500, _ba.SEA_900
INK_500 = _ba.HEX["ink_500"]
INK_300 = _ba.HEX["ink_300"]
INK_100 = _ba.HEX["ink_100"]
FONT = _ba.FONT

#: Everything here is in millimetres. The SVG carries `width="105mm"` and a
#: viewBox in the same numbers, so a user unit *is* a millimetre and every
#: constant below can be read against a ruler.
MM = 1.0

SIZES = {
    # A6. Stock acrylic size, stock print size, and it fits a fitting-room
    # door at eye height without becoming signage.
    "a6": (105.0, 148.0),
    # A5, for an entrance or a till, where it is read from further away.
    "a5": (148.0, 210.0),
}

BLEED = 3.0          # printed area beyond the trim
MARK_GAP = 3.0       # crop marks start this far outside the trim
MARK_LEN = 4.0

#: Below this, a printed QR module starts losing its edges — on acrylic, and
#: on anything laser-etched, faster than on paper. Checked, not assumed.
MIN_MODULE_MM = 0.55

COPY = {
    "headline": "Say you’re here.",
    "sub": [
        "Your associate can see your sizes and",
        "saved items — nothing else.",
    ],
    "tap": ["Hold the top of", "your phone here"],
    "or": "or",
    "scan": "Scan with your camera",
    "fine": "Opt in, per visit. Stop any time. No cameras.",
}


# --- type, outlined ----------------------------------------------------------
def _glyphs(text: str, em: float):
    """Per-character (path, x-offset) at an em size in millimetres.

    Outlined from the vendored face for the same reason the wordmark is: the
    print shop does not have Instrument Sans, and a plate set in a polite
    substitute is a plate that does not look like ours.
    """
    font = TTFont(FONT)
    upem = font["head"].unitsPerEm
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    hmtx = font["hmtx"]
    scale = em / upem
    out, x = [], 0.0
    for ch in text:
        if ord(ch) not in cmap:
            # A missing glyph on print art disappears silently, and nobody
            # notices until the acrylic arrives.
            raise SystemExit(f"No glyph for {ch!r} in {FONT.name}: {text!r}")
        name = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        gs[name].draw(pen)
        out.append((pen.getCommands(), x))
        x += hmtx[name][0] * scale
    return out, x, scale


def text_width(text: str, em: float, track: float = 0.0) -> float:
    _, adv, _ = _glyphs(text, em)
    return adv + track * em * max(len(text) - 1, 0)


def text(s: str, *, em: float, x: float, y: float, fill: str = INK,
         anchor: str = "start", track: float = 0.0, limit: float | None = None) -> str:
    """One line of outlined type, with a width budget.

    `limit` is the same discipline the lens layout runs on: a line that does
    not fit raises here, where it is a traceback, rather than on the plate,
    where it is a reprint.
    """
    paths, adv, scale = _glyphs(s, em)
    extra = track * em
    width = adv + extra * max(len(s) - 1, 0)
    if limit is not None and width > limit + 1e-6:
        raise SystemExit(
            f"Line does not fit: {s!r} is {width:.1f}mm, budget {limit:.1f}mm.")
    ox = {"start": 0.0, "middle": -width / 2, "end": -width}[anchor]
    inner = "".join(
        f'<path transform="translate({x + ox + gx + extra * i:.4f} {y:.4f}) '
        f'scale({scale:.6f} {-scale:.6f})" d="{d}"/>'
        for i, (d, gx) in enumerate(paths)
    )
    return f'<g fill="{fill}">{inner}</g>'


def xml_escape(s: str) -> str:
    """`&` is not text in XML, and a URL is mostly ampersands."""
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# --- pieces ------------------------------------------------------------------
def nfc_glyph(cx: float, cy: float, size: float, colour: str) -> str:
    """A phone, top edge toward the plate, with the read arcs coming off it.

    The arcs are the part that matters: people know what a QR is and mostly do
    not know that the antenna is at the *top* of the phone, which is the one
    fact that decides whether the tap works first time.
    """
    w, h = size * 0.46, size * 0.80
    r = size * 0.07
    sw = size * 0.055
    x, y = cx - w / 2, cy - h / 2
    arcs = []
    for i in range(3):
        rr = size * (0.30 + 0.13 * i)
        arcs.append(
            f'<path d="M {cx - rr * 0.71:.3f} {y - rr * 0.71 + h * 0.10:.3f} '
            f'A {rr:.3f} {rr:.3f} 0 0 1 {cx + rr * 0.71:.3f} '
            f'{y - rr * 0.71 + h * 0.10:.3f}" fill="none" stroke="{colour}" '
            f'stroke-width="{sw:.3f}" stroke-linecap="round" opacity="{1 - i * 0.22:.2f}"/>')
    return f'''<g>
    <rect x="{x:.3f}" y="{y + h * 0.16:.3f}" width="{w:.3f}" height="{h * 0.84:.3f}"
          rx="{r:.3f}" fill="none" stroke="{colour}" stroke-width="{sw:.3f}"/>
    {''.join(arcs)}
  </g>'''


def qr_svg(url: str, side: float, x: float, y: float,
           dark: str = INK, light: str = PAPER) -> str:
    """A QR at a known physical size, with its quiet zone inside `side`.

    Error correction M rather than L: this is going on a wall in a shop, where
    it will be scuffed, and the cost of the extra modules is a slightly denser
    code, not a bigger one.
    """
    qr = segno.make(url, error="m")
    matrix = [row for row in qr.matrix]
    n = len(matrix)
    quiet = 4
    total = n + quiet * 2
    module = side / total
    if module < MIN_MODULE_MM:
        raise SystemExit(
            f"QR module would print at {module:.2f}mm (floor {MIN_MODULE_MM}mm). "
            f"The URL is {len(url)} chars and needs {n} modules — shorten the "
            f"zone slug or print the plate larger.")
    cells = []
    for r, row in enumerate(matrix):
        run = None
        for c in range(n + 1):
            on = c < n and row[c]
            if on and run is None:
                run = c
            elif not on and run is not None:
                cells.append(
                    f'<rect x="{x + (quiet + run) * module:.4f}" '
                    f'y="{y + (quiet + r) * module:.4f}" '
                    f'width="{(c - run) * module:.4f}" height="{module:.4f}"/>')
                run = None
    return (f'<rect x="{x:.3f}" y="{y:.3f}" width="{side:.3f}" height="{side:.3f}" '
            f'fill="{light}"/>\n  <g fill="{dark}">' + "".join(cells) + "</g>"), n, module


def nested(svg: str, x: float, y: float, w: float) -> str:
    """Place one of the brand SVGs at a physical size, keeping its aspect.

    A `<g transform>` rather than a nested `<svg viewBox>`: cairosvg drew the
    nested form **twice** in a long document — once where it was asked and once
    at the origin — and a stray logo in the corner of an installation sheet is
    the kind of thing that gets noticed after the print run. A transform has
    no such opinion.
    """
    vb = re.search(r'viewBox="([-\d.eE ]+)"', svg).group(1).split()
    minx, miny, vw, _vh = (float(v) for v in vb)
    k = w / vw
    body = svg.split(">", 1)[1].rsplit("</svg>", 1)[0]
    return (f'<g transform="translate({x - minx * k:.4f} {y - miny * k:.4f}) '
            f'scale({k:.6f})">{body}</g>')


# --- the plate ---------------------------------------------------------------
def plate_svg(*, W: float, H: float, store: str, zone_label: str,
              nfc_url: str, qr_url: str, zone_slug: str, tenant: str) -> str:
    """The printed face. One flame region — the ring — as the tokens require."""
    M = W * 0.095
    col = W - M * 2
    s = W / 105.0                     # scale everything off the A6 baseline

    head_em = 8.6 * s
    sub_em = 3.9 * s
    label_em = 3.3 * s
    fine_em = 2.7 * s

    y = M + head_em * 0.72
    out = [text(COPY["headline"], em=head_em, x=W / 2, y=y, anchor="middle",
                limit=col)]
    y += 6.4 * s
    for line in COPY["sub"]:
        y += sub_em * 1.32
        out.append(text(line, em=sub_em, x=W / 2, y=y, fill=INK_500,
                        anchor="middle", limit=col))

    # --- the tap target. The tag goes behind this circle, and the install
    # sheet prints the same circle at 1:1 so it ends up there.
    ring_r = 18.0 * s
    ring_cy = y + 5.0 * s + ring_r
    out.append(
        f'<circle cx="{W/2:.3f}" cy="{ring_cy:.3f}" r="{ring_r:.3f}" '
        f'fill="none" stroke="{FLAME}" stroke-width="{1.1*s:.3f}"/>')
    out.append(nfc_glyph(W / 2, ring_cy - ring_r * 0.24, 12.5 * s, FLAME))
    ty = ring_cy + ring_r * 0.12
    for line in COPY["tap"]:
        ty += label_em * 1.30
        out.append(text(line, em=label_em, x=W / 2, y=ty, anchor="middle",
                        limit=ring_r * 1.55))

    # --- or
    oy = ring_cy + ring_r + 6.5 * s
    ow = text_width(COPY["or"], sub_em)
    for x0, x1 in ((M, W / 2 - ow / 2 - 3 * s), (W / 2 + ow / 2 + 3 * s, W - M)):
        out.append(f'<line x1="{x0:.3f}" y1="{oy - sub_em*0.30:.3f}" '
                   f'x2="{x1:.3f}" y2="{oy - sub_em*0.30:.3f}" '
                   f'stroke="{INK_100}" stroke-width="{0.4*s:.3f}"/>')
    out.append(text(COPY["or"], em=sub_em, x=W / 2, y=oy, fill=INK_300,
                    anchor="middle"))

    # --- the QR, on its own paper card so the plate can be dark without the
    # code losing the contrast it needs.
    qr_side = 34.0 * s
    pad = 2.5 * s
    card = qr_side + pad * 2
    cy0 = oy + 4.0 * s
    out.append(f'<rect x="{(W-card)/2:.3f}" y="{cy0:.3f}" width="{card:.3f}" '
               f'height="{card:.3f}" rx="{2*s:.3f}" fill="{PAPER}"/>')
    qr_frag, modules, module_mm = qr_svg(qr_url, qr_side, (W - qr_side) / 2, cy0 + pad)
    out.append(qr_frag)
    out.append(text(COPY["scan"], em=label_em, x=W / 2, y=cy0 + card + label_em * 1.25,
                    anchor="middle", limit=col))

    # --- footer: what this is, where it is, and who made it.
    fy = H - M * 0.72
    out.append(text(COPY["fine"], em=fine_em, x=M, y=fy - fine_em * 1.7,
                    fill=INK_300, limit=col))
    out.append(text(f"{store} · {zone_label}", em=fine_em, x=M, y=fy,
                    fill=INK_500, limit=col * 0.62))
    lock = _ba.lockup_svg(INK, FLAME, INK, SEA_500)
    out.append(nested(lock, W - M - 20.0 * s, fy - 5.6 * s, 20.0 * s))

    body = "\n  ".join(out)
    xml_nfc, xml_qr = xml_escape(nfc_url), xml_escape(qr_url)
    doc_h = cy0 + card + label_em * 1.25
    if doc_h > fy - fine_em * 3.4:
        raise SystemExit(
            f"Plate content runs to {doc_h:.1f}mm and the footer starts at "
            f"{fy - fine_em*3.4:.1f}mm. Shorten the copy or use --size a5.")
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}mm" height="{H}mm"
     viewBox="0 0 {W} {H}">
  <title>cuesea check-in plate — {store}, {zone_label}</title>
  <!-- The type is outlined, so nothing on this plate is searchable. This is
       the machine-readable copy: grep a stack of artwork files to find which
       plate is which without opening any of them. -->
  <desc>tenant={tenant} zone={zone_slug} nfc={xml_nfc} qr={xml_qr}</desc>
  <rect x="0" y="0" width="{W}" height="{H}" fill="{PAPER}"/>
  {body}
</svg>''', modules, module_mm


def with_bleed(svg: str, W: float, H: float) -> str:
    """Trim marks and bleed, because this goes to a print shop and not a
    desktop printer. The ground extends into the bleed; the marks sit outside
    it, where the guillotine can see them."""
    pad = BLEED + MARK_GAP + MARK_LEN
    MW, MH = W + pad * 2, H + pad * 2
    body = svg.split(">", 1)[1].rsplit("</svg>", 1)[0]
    marks = []
    for x in (0.0, W):
        for y in (0.0, H):
            sx = -1 if x == 0 else 1
            sy = -1 if y == 0 else 1
            marks.append(
                f'<line x1="{x + sx*MARK_GAP:.3f}" y1="{y:.3f}" '
                f'x2="{x + sx*(MARK_GAP+MARK_LEN):.3f}" y2="{y:.3f}" '
                f'stroke="{INK}" stroke-width="0.25"/>'
                f'<line x1="{x:.3f}" y1="{y + sy*MARK_GAP:.3f}" '
                f'x2="{x:.3f}" y2="{y + sy*(MARK_GAP+MARK_LEN):.3f}" '
                f'stroke="{INK}" stroke-width="0.25"/>')
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{MW}mm" height="{MH}mm"
     viewBox="{-pad} {-pad} {MW} {MH}">
  <rect x="{-BLEED}" y="{-BLEED}" width="{W + BLEED*2}" height="{H + BLEED*2}" fill="{PAPER}"/>
  {body}
  {''.join(marks)}
</svg>'''


# --- the installation sheet --------------------------------------------------
def install_svg(*, W: float, H: float, store: str, zone_label: str,
                zone_slug: str, tenant: str, nfc_url: str, qr_url: str,
                plate_w: float, ring_r: float, ring_cy: float) -> str:
    """A4, for whoever mounts the plate. Not printed on the acrylic.

    The 1:1 registration circle is the reason this is a drawing rather than a
    paragraph: the tag has to land behind the tap ring, and the reliable way
    to make that happen is to let someone hold the sticker over the page.
    """
    PW, PH = 210.0, 297.0
    M = 18.0
    col = PW - M * 2
    out = []

    y = M + 9.0
    out.append(text("Plate installation", em=9.0, x=M, y=y, limit=col))
    y += 7.0
    out.append(text(f"{store} · {zone_label}", em=5.2, x=M, y=y, fill=SEA_500,
                    limit=col))
    y += 4.0
    out.append(f'<line x1="{M}" y1="{y:.2f}" x2="{PW-M}" y2="{y:.2f}" '
               f'stroke="{INK_100}" stroke-width="0.4"/>')

    def step(n: str, head: str, lines: list[str], yy: float) -> float:
        out.append(text(n, em=5.0, x=M, y=yy, fill=FLAME))
        out.append(text(head, em=5.0, x=M + 8.0, y=yy, limit=col - 8))
        for ln in lines:
            yy += 5.0
            out.append(text(ln, em=3.6, x=M + 8.0, y=yy, fill=INK_500,
                            limit=col - 8))
        return yy + 9.0

    y += 12.0
    y = step("1", "Write the tag.", [
        "NTAG213 or NTAG215, a single URL record. The URL is printed below and",
        "is also in write-tags.txt, which is there so nobody types it by hand.",
    ], y)
    y = step("2", "Lock the tag. This is not optional.", [
        "An unlocked tag on a public wall can be rewritten by anyone who walks",
        "past, to point anywhere they like. Locking is permanent and is the only",
        "security this plate has. A tag that cannot be locked must not be mounted.",
    ], y)
    y = step("3", "Stick the tag behind the ring.", [
        "Use the circle at the bottom of this page — it is printed at actual size.",
        "The tap ring on the plate is the read zone, and a tag mounted off-centre",
        "reads on the second or third try, which people read as broken.",
    ], y)
    y = step("4", "Metal needs a ferrite layer.", [
        "A tag on a metal door, frame or fixture will not read at all. A 0.3mm",
        "ferrite sheet between the tag and the metal fixes it. Acrylic, wood,",
        "glass and painted plasterboard need nothing.",
    ], y)
    y = step("5", "Mount at 1.35m to the centre of the ring.", [
        "Reachable standing, visible seated, and out of the way of a door swing.",
    ], y)
    y = step("6", "Test it before you leave.", [
        f"Tap, and the page must say {zone_label}. If it names another zone, two",
        "plates have been swapped — which is silent afterwards, and shows up",
        "later as guests in the wrong room.",
    ], y)

    # The URLs, verbatim. Different `src` on each, and the sheet says why so
    # that the next person to reprint a plate does not "fix" it.
    y += 2.0
    out.append(text("The two URLs", em=5.0, x=M, y=y, limit=col))
    y += 6.0
    for lbl, url in (("Tag (NFC)", nfc_url), ("Printed QR", qr_url)):
        out.append(text(lbl, em=3.4, x=M, y=y, fill=INK_300, track=0.08))
        y += 4.6
        for ln in textwrap.wrap(url, 74):
            out.append(text(ln, em=3.5, x=M, y=y, fill=INK, limit=col))
            y += 4.6
        y += 2.0
    out.append(text("The src values differ on purpose — it is how we learn which "
                    "door people use.", em=3.3, x=M, y=y, fill=INK_500, limit=col))

    # 1:1 registration.
    ry = PH - M - 6.0 - ring_r
    out.append(f'<circle cx="{PW/2:.2f}" cy="{ry:.2f}" r="{ring_r:.2f}" '
               f'fill="none" stroke="{FLAME}" stroke-width="0.5" '
               f'stroke-dasharray="2 2"/>')
    out.append(f'<line x1="{PW/2-4:.2f}" y1="{ry:.2f}" x2="{PW/2+4:.2f}" y2="{ry:.2f}" '
               f'stroke="{FLAME}" stroke-width="0.4"/>'
               f'<line x1="{PW/2:.2f}" y1="{ry-4:.2f}" x2="{PW/2:.2f}" y2="{ry+4:.2f}" '
               f'stroke="{FLAME}" stroke-width="0.4"/>')
    out.append(text("Actual size — the tag centres here, behind the ring.",
                    em=3.4, x=PW / 2, y=ry - ring_r - 4.0, fill=INK_500,
                    anchor="middle"))
    out.append(text(f"{tenant} · {zone_slug}", em=3.0, x=M, y=PH - M + 4.0,
                    fill=INK_300))
    out.append(nested(_ba.lockup_svg(INK, FLAME, INK, SEA_500),
                      PW - M - 22.0, PH - M, 22.0))

    xml_nfc, xml_qr = xml_escape(nfc_url), xml_escape(qr_url)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{PW}mm" height="{PH}mm"
     viewBox="0 0 {PW} {PH}">
  <title>Plate installation — {store}, {zone_label}</title>
  <desc>tenant={tenant} zone={zone_slug} nfc={xml_nfc} qr={xml_qr}</desc>
  <rect x="0" y="0" width="{PW}" height="{PH}" fill="{PAPER}"/>
  {"".join(f"{o}" for o in out)}
</svg>'''


# --- doors, checked against the service --------------------------------------
def known_sources() -> set[str] | None:
    """The registry the endpoint actually enforces.

    A plate is printed once and lives on a wall for a year. If it names a door
    the service does not know, every tap 400s — so the check happens here, at
    the point where the mistake is still a text edit.
    """
    try:
        sys.path.insert(0, str(ROOT / "packages/ai-service"))
        from app.presence import SOURCES  # noqa: PLC0415
        return set(SOURCES)
    except Exception as exc:                        # pragma: no cover
        print(f"  ! could not read the source registry ({exc.__class__.__name__}); "
              f"skipping the door check", file=sys.stderr)
        return None


def check_base(url: str) -> None:
    """Ask the URL whether it exists, before it goes on acrylic.

    The single most expensive failure this generator can produce is a pallet
    of plates pointing at a page that 404s or — worse — at a site sitting
    behind a password gate, which is what `cuesea.ai` did when this check was
    written. Both look identical in the artwork and neither is discoverable
    until a guest is standing in a fitting room with their phone out.

    A network failure is a warning, not a refusal: somebody generating plates
    on a plane should not be stopped, they should be told.
    """
    import urllib.error
    import urllib.request

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            raise _Redirected(newurl)

    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(url, timeout=8) as r:
            if r.status != 200:
                sys.exit(f"{url} answered {r.status}. Fix the route before printing.")
    except _Redirected as r:
        target = str(r)
        if any(w in target.lower() for w in ("password", "login", "signin", "auth")):
            sys.exit(
                f"{url} redirects to {target}.\n"
                "That is a gate, and a plate pointing at one is a plate that "
                "does nothing. Publish the route without protection, or point "
                "--base somewhere that answers.")
        print(f"  ! {url} redirects to {target} — check that is deliberate",
              file=sys.stderr)
    except urllib.error.HTTPError as e:
        sys.exit(f"{url} answered {e.code}. Fix the route before printing.")
    except Exception as e:                          # offline, DNS, timeout
        print(f"  ! could not reach {url} ({e.__class__.__name__}); "
              f"printing unverified", file=sys.stderr)


class _Redirected(Exception):
    pass


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--tenant", required=True, help="tenant slug, e.g. gap")
    ap.add_argument("--store", default=None,
                    help="what the plate calls the shop (default: the tenant, titled)")
    ap.add_argument("--zone", action="append", default=[], required=True,
                    help="repeatable; the human label, e.g. 'Fitting room 3'")
    ap.add_argument("--base", default="https://app.cuesea.ai/here",
                    help="the check-in page the plate points at")
    ap.add_argument("--skip-url-check", action="store_true",
                    help="print without asking the URL whether it answers")
    ap.add_argument("--size", choices=sorted(SIZES), default="a6")
    ap.add_argument("--out", default=str(HERE / "out/plates"))
    args = ap.parse_args()

    if not FONT.exists():
        sys.exit(f"Instrument Sans not found at {FONT} — see fonts/README.md.")

    known = known_sources()
    for src in ("nfc-plate", "qr-plate"):
        if known is not None and src not in known:
            sys.exit(f"'{src}' is not a door the service knows. Add it to "
                     f"app/presence.py SOURCES before printing anything.")

    if not args.skip_url_check:
        check_base(f"{args.base}?" + urlencode(
            {"t": args.tenant, "z": "plate-check", "src": "qr-plate"}))

    W, H = SIZES[args.size]
    store = args.store or args.tenant.title()
    out_dir = Path(args.out) / args.tenant
    out_dir.mkdir(parents=True, exist_ok=True)

    plates, tag_lines = [], [
        f"# NFC tag URLs — {store}. One per plate. Lock every tag after writing.",
    ]
    for label in args.zone:
        slug = slugify(label)
        def url(src: str) -> str:
            return f"{args.base}?" + urlencode(
                {"t": args.tenant, "z": slug, "src": src})
        nfc_url, qr_url = url("nfc-plate"), url("qr-plate")

        svg, modules, module_mm = plate_svg(
            W=W, H=H, store=store, zone_label=label, nfc_url=nfc_url,
            qr_url=qr_url, zone_slug=slug, tenant=args.tenant)
        stem = f"{args.tenant}-{slug}"
        (out_dir / f"{stem}-plate.svg").write_text(svg)
        cairosvg.svg2pdf(bytestring=with_bleed(svg, W, H).encode(),
                         write_to=str(out_dir / f"{stem}-plate.pdf"))
        cairosvg.svg2png(bytestring=svg.encode(),
                         write_to=str(out_dir / f"{stem}-proof.png"),
                         output_width=int(W / 25.4 * 300))

        s = W / 105.0
        inst = install_svg(
            W=W, H=H, store=store, zone_label=label, zone_slug=slug,
            tenant=args.tenant, nfc_url=nfc_url, qr_url=qr_url,
            plate_w=W, ring_r=18.0 * s, ring_cy=0.0)
        (out_dir / f"{stem}-install.svg").write_text(inst)
        cairosvg.svg2pdf(bytestring=inst.encode(),
                         write_to=str(out_dir / f"{stem}-install.pdf"))

        tag_lines.append(f"{label}\t{nfc_url}")
        plates.append({
            "zone": label, "zone_slug": slug, "tenant": args.tenant,
            "size": args.size, "trim_mm": [W, H],
            "nfc_url": nfc_url, "qr_url": qr_url,
            "qr_modules": modules, "qr_module_mm": round(module_mm, 3),
            "files": {k: f"{stem}-{k}" for k in
                      ("plate.pdf", "plate.svg", "proof.png", "install.pdf")},
        })
        print(f"  {label:<20} {slug:<20} QR {modules}×{modules} "
              f"@ {module_mm:.2f}mm/module")

    (out_dir / "write-tags.txt").write_text("\n".join(tag_lines) + "\n")
    (out_dir / "plates.json").write_text(json.dumps({
        "generated_from": "packages/brand/build-plates.py",
        "tokens_version": TOKENS.get("version"),
        "base": args.base,
        "note": ("NFC and QR carry different `src` values on purpose — "
                 "GET /api/analytics/doors is how we learn which door people "
                 "actually use."),
        "plates": plates,
    }, indent=2) + "\n")
    print(f"wrote {len(plates)} plate(s) to {out_dir}")


if __name__ == "__main__":
    main()
