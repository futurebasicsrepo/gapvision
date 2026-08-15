"""What the plate art has to survive.

    python3 packages/brand/test-plates.py

A plate is printed once, glued to acrylic and screwed to a wall. Everything
here is a failure that is free to catch now and expensive to catch on a pallet
of finished plates.

The load-bearing test is the first one: the QR is **decoded back out of the
rendered artwork** and compared to the URL character for character. Every
other check in this file could pass while the printed code quietly points at
the wrong zone.
"""
from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path

import cairosvg
import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("build_plates", HERE / "build-plates.py")
bp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bp)

FAILURES: list[str] = []


def check(name: str, fn) -> None:
    try:
        fn()
        print(f"  ok    {name}")
    except AssertionError as exc:
        FAILURES.append(f"{name}: {exc}")
        print(f"  FAIL  {name}: {exc}")
    except Exception as exc:                        # a crash is also a failure
        FAILURES.append(f"{name}: {exc.__class__.__name__}: {exc}")
        print(f"  FAIL  {name}: {exc.__class__.__name__}: {exc}")


def render(zone="Fitting room 3", tenant="gap", store="Gap", size="a6",
           base="https://app.cuesea.ai/here", dpi=300):
    W, H = bp.SIZES[size]
    slug = bp.slugify(zone)
    def url(src):
        from urllib.parse import urlencode
        return f"{base}?" + urlencode({"t": tenant, "z": slug, "src": src})
    svg, modules, module_mm = bp.plate_svg(
        W=W, H=H, store=store, zone_label=zone, nfc_url=url("nfc-plate"),
        qr_url=url("qr-plate"), zone_slug=slug, tenant=tenant)
    png = cairosvg.svg2png(bytestring=svg.encode(),
                           output_width=int(W / 25.4 * dpi))
    img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_GRAYSCALE)
    return {"svg": svg, "img": img, "modules": modules, "module_mm": module_mm,
            "nfc_url": url("nfc-plate"), "qr_url": url("qr-plate"), "slug": slug}


def decode(img) -> str:
    data, *_ = cv2.QRCodeDetector().detectAndDecode(img)
    return data


# --- the tests ---------------------------------------------------------------
def test_the_printed_code_points_where_we_think_it_does():
    """Decoded out of the artwork, not out of the variable that made it."""
    r = render()
    got = decode(r["img"])
    assert got == r["qr_url"], f"decoded {got!r}, expected {r['qr_url']!r}"


def test_the_zone_is_in_the_url():
    """The whole design: the plate knows where it is because it says so."""
    r = render("Fitting room 12")
    assert "z=fitting-room-12" in decode(r["img"])


def test_the_two_doors_are_told_apart():
    """Same arrival, different door. If these ever collapse to one `src` we
    stop being able to answer whether the tags were worth paying for."""
    r = render()
    assert "src=qr-plate" in r["qr_url"]
    assert "src=nfc-plate" in r["nfc_url"]
    assert r["qr_url"].replace("qr-plate", "X") == r["nfc_url"].replace("nfc-plate", "X"), \
        "the two URLs differ by more than the door"


def test_every_door_on_the_plate_is_one_the_service_knows():
    """A plate naming an unknown source is a wall of 400s."""
    known = bp.known_sources()
    if known is None:
        raise AssertionError("could not read the SOURCES registry")
    assert {"nfc-plate", "qr-plate"} <= known, known


def test_the_code_prints_large_enough_to_scan():
    r = render()
    assert r["module_mm"] >= bp.MIN_MODULE_MM, r["module_mm"]
    # And the whole code stays inside the rule of thumb for a phone held at
    # arm's length: printed width ≥ scanning distance / 10.
    printed = r["module_mm"] * (r["modules"] + 8)
    assert printed >= 30.0, f"{printed:.1f}mm is small for a 300mm read"


def test_a_zone_name_that_will_not_fit_fails_loudly():
    """Silence here means an unreadable plate. It has to raise."""
    long_zone = "Fitting room on the mezzanine level behind menswear, number 14"
    try:
        render(long_zone)
    except SystemExit as exc:
        assert "fit" in str(exc).lower() or "module" in str(exc).lower(), exc
    else:
        raise AssertionError("an over-long zone label rendered without complaint")


def test_the_copy_budget_is_real():
    """The guard that stops the layout drifting into the footer."""
    original = dict(bp.COPY)
    try:
        bp.COPY["sub"] = ["A line long enough that it cannot possibly fit inside "
                          "the column on an A6 plate"]
        try:
            render()
        except SystemExit:
            pass
        else:
            raise AssertionError("over-long body copy rendered without complaint")
    finally:
        bp.COPY.clear()
        bp.COPY.update(original)


def test_the_artwork_is_a_single_svg():
    """A regression, and the reason `nested()` is a transform rather than a
    nested `<svg>`: cairosvg drew the nested form twice in a long document —
    once where it was asked and once in the corner of the page. It survived a
    proof render because the extra logo looked like it belonged there."""
    r = render()
    assert r["svg"].count("<svg") == 1, "nested <svg> is back"
    inst = bp.install_svg(
        W=105.0, H=148.0, store="Gap", zone_label="Fitting room 3",
        zone_slug="fitting-room-3", tenant="gap",
        nfc_url=r["nfc_url"], qr_url=r["qr_url"],
        plate_w=105.0, ring_r=18.0, ring_cy=0.0)
    assert inst.count("<svg") == 1, "nested <svg> is back on the install sheet"


def test_the_install_sheet_carries_both_urls_verbatim():
    """Whoever writes the tag reads it off this page. If the sheet and the
    printed QR ever disagree, the plate does two different things."""
    r = render()
    inst = bp.install_svg(
        W=105.0, H=148.0, store="Gap", zone_label="Fitting room 3",
        zone_slug="fitting-room-3", tenant="gap",
        nfc_url=r["nfc_url"], qr_url=r["qr_url"],
        plate_w=105.0, ring_r=18.0, ring_cy=0.0)
    # The visible type is outlined, so the URLs are not searchable in the
    # artwork. The `<desc>` is the machine copy, and it has to agree with both
    # the printed code and the sheet — otherwise a stack of plate files can
    # only be told apart by rendering them.
    for svg in (r["svg"], inst):
        desc = re.search(r"<desc>(.*?)</desc>", svg, re.S).group(1)
        fields = dict(kv.split("=", 1) for kv in desc.split(" nfc=")[0].split())
        assert fields["zone"] == r["slug"], fields
        assert bp.xml_escape(r["nfc_url"]) in desc
        assert bp.xml_escape(r["qr_url"]) in desc
    # And the machine copy must match what actually got printed.
    assert decode(r["img"]) == r["qr_url"]


def test_a5_is_a_plate_and_not_a_stretched_a6():
    """Every measurement scales off the A6 baseline, so the large plate has to
    stay in proportion rather than growing white space."""
    a6, a5 = render(size="a6"), render(size="a5")
    assert decode(a5["img"]) == a5["qr_url"]
    assert a5["module_mm"] > a6["module_mm"], "the A5 code should print larger"


def main() -> None:
    print("plate artwork")
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            check(name[5:].replace("_", " "), fn)
    print()
    if FAILURES:
        print(f"{len(FAILURES)} failure(s)")
        sys.exit(1)
    print("all good")


if __name__ == "__main__":
    main()
