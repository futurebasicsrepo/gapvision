"""The barcode path: decoded by a decoder, resolved against records.

    python -m pytest tests/test_vision_barcode.py -q

Covers the three claims the phone-camera scan now makes:

  1. a barcode in frame is decoded locally and the vision model is never
     consulted — asserted with a provider that *raises* if asked;
  2. the decoded code resolves through `lookup_code` (exact) with the floor
     match as fallback, and an adapter that errors reads as "could not
     answer", never as "not carried";
  3. the answer carries the direction line, with the associate's own zone in
     front of the arrow when it is known and different.

The barcode images are rendered by `python-barcode` — real EAN-13s with real
check digits — so the decoder under test is doing the same work it does on a
photograph of a printed label. What no unit test can cover is a *phone photo*
of a label (glare, angle, focus); that is the on-floor test.
"""
from __future__ import annotations

import base64
import io
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("GAPVISION_LLM", "mock")

from barcode import EAN13                      # noqa: E402  (python-barcode)
from barcode.writer import ImageWriter         # noqa: E402

from app import barcode as bc                  # noqa: E402
from app import vision                         # noqa: E402
from app.crm_provider import MockCRM           # noqa: E402


def _png_of(code: str) -> bytes:
    buf = io.BytesIO()
    EAN13(code, writer=ImageWriter()).write(buf)
    return buf.getvalue()


def _scan(sku: str, crm, zone=None):
    png = _png_of(bc.ean13_for_sku(sku))
    return vision.analyze(tenant="gap", kind="sku",
                          image_base64=base64.b64encode(png).decode(),
                          mime="image/png", note=None, crm=crm, zone=zone)


FLOOR_SKU = "GAP-DNM-0498"   # High Rise Barrel Jeans, Denim Wall, 9 on hand


# --- the generator -----------------------------------------------------------

def test_derived_ean13_is_valid_stable_and_in_store_range():
    code = bc.ean13_for_sku(FLOOR_SKU)
    assert len(code) == 13 and code.isdigit()
    assert code.startswith("20"), "in-store GS1 range"
    assert code == bc.ean13_for_sku(FLOOR_SKU), "deterministic"
    assert code != bc.ean13_for_sku("GAP-SWT-3310")
    total = sum(int(d) * (3 if i % 2 else 1) for i, d in enumerate(code[:12]))
    assert (10 - total % 10) % 10 == int(code[12]), "check digit"


def test_decoder_roundtrips_a_rendered_label():
    code = bc.ean13_for_sku(FLOOR_SKU)
    assert bc.decode(_png_of(code)) == [code]


def test_decoder_answers_nothing_for_a_plain_image():
    from PIL import Image
    buf = io.BytesIO()
    Image.new("L", (400, 300), 128).save(buf, format="PNG")
    assert bc.decode(buf.getvalue()) == []


# --- the model is never consulted when a barcode is present ------------------

class _ForbiddenProvider:
    name = "forbidden"

    def read_image(self, *a, **k):
        raise AssertionError("the vision model was consulted for a barcode")


def test_barcode_skips_the_model(monkeypatch):
    monkeypatch.setattr(vision, "get_provider", lambda: _ForbiddenProvider())
    out = _scan(FLOOR_SKU, MockCRM())
    assert out["grounded"] is True
    assert out["sku"] == FLOOR_SKU
    assert out["meta"] == ["BARCODE"]
    assert out["provider"] == "zxing"


# --- resolution and the direction line ---------------------------------------

def test_barcode_resolves_to_the_floor_record():
    out = _scan(FLOOR_SKU, MockCRM(), zone="Fitting Rooms")
    assert out["lines"][0] == "HIGH RISE BARREL JEANS"
    assert out["lines"][1] == "$90 · FITTING ROOMS → DENIM WALL"
    assert out["lines"][2] == "9 ON HAND"


def test_direction_without_a_zone_is_an_arrow():
    out = _scan(FLOOR_SKU, MockCRM())
    assert out["lines"][1] == "$90 · → DENIM WALL"


def test_no_direction_to_where_you_already_stand():
    out = _scan(FLOOR_SKU, MockCRM(), zone="Denim Wall")
    assert out["lines"][1] == "$90 · DENIM WALL"


def test_unknown_barcode_is_a_real_miss_not_an_invention():
    stranger = bc.ean13_for_sku("NOT-A-SKU-WE-HOLD")   # valid EAN, matches nothing
    out = vision.analyze(tenant="gap", kind="sku",
                         image_base64=base64.b64encode(_png_of(stranger)).decode(),
                         mime="image/png", note=None, crm=MockCRM())
    assert out["lines"][0] == "NOT IN FLOOR RECORDS"
    assert stranger in out["lines"][1]


class _BrokenCRM:
    def lookup_code(self, code):
        raise RuntimeError("store API down")

    def floor_inventory(self):
        raise RuntimeError("store API down")


def test_a_broken_adapter_never_reads_as_not_carried():
    out = _scan(FLOOR_SKU, _BrokenCRM())
    assert out["grounded"] is False
    assert out["lines"][0] == "NO FLOOR RECORDS LOADED"


# --- the shopify adapter's lookup shape, against fixtures --------------------

def test_shopify_lookup_code_parses_a_variant(monkeypatch):
    from app import crm_shopify

    class _T:
        def query(self, q, v):
            assert "sku:" in v["q"] and "barcode:" in v["q"]
            return {"productVariants": {"edges": [{"node": {
                "sku": "HAL-STJ-RIN-32", "barcode": "2001234567897",
                "price": "148.00", "inventoryQuantity": 6,
                "selectedOptions": [{"name": "Waist", "value": "32"}],
                "product": {"title": "Halden Straight Jean — Rinse Indigo",
                            "handle": "halden-straight-jean-rinse-indigo",
                            "totalInventory": 11},
            }}]}}

    crm = crm_shopify.ShopifyCRM(transport=_T())
    item = crm.lookup_code("2001234567897")
    assert item["sku"] == "HAL-STJ-RIN-32"
    assert item["price"] == 148.0
    assert item["stock"] == 6
    assert item["size"] == "32"
