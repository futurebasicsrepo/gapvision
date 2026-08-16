"""Barcodes: decoded by a decoder, never guessed by a model.

    from app import barcode
    barcode.decode(image_bytes)      # -> ["2001234567897", ...] or []
    barcode.ean13_for_sku("HAL-STJ-RIN-28")   # -> "2xxxxxxxxxxxC", stable

The vision path's standing rule is that answers are grounded in records we
hold. A barcode is the strongest grounding available on a shop floor — it is
machine-written and machine-read — so when a capture contains one, the code
comes from `zxing-cpp` (the maintained C++ port of ZXing, shipped as manylinux
wheels: nothing to apt-install, works in the `python:3.12-slim` image as-is)
and the vision model is never consulted. The model remains the fallback for
what a decoder cannot do: a washed-out swing tag, a handwritten style number,
a care label.

**The image is never stored** — same law as `vision.py`. Bytes in, strings
out, nothing written, nothing logged.

`ean13_for_sku` is the other half of making this real rather than demo-only:
the pilot store's variants carry no barcodes (verified against the live
store), so `scripts/seed_barcodes.py` derives one per variant from its SKU and
writes it to Shopify. The prefix is **20** — the GS1 range reserved for
in-store / restricted distribution, which is what a retailer printing its own
labels is supposed to use — and the check digit is computed, so any real
scanner (and zxing) reads them as valid EAN-13. Deterministic on purpose: the
same SKU always yields the same barcode, so reseeding never churns labels.
"""
from __future__ import annotations

import hashlib
import io


def _ean13_check_digit(digits12: str) -> str:
    total = sum(int(d) * (3 if i % 2 else 1) for i, d in enumerate(digits12))
    return str((10 - total % 10) % 10)


def ean13_for_sku(sku: str) -> str:
    """A valid, stable, in-store-range EAN-13 for this SKU."""
    seed = hashlib.sha256(str(sku or "").strip().upper().encode()).hexdigest()
    body = "20" + str(int(seed[:12], 16) % 10_000_000_000).zfill(10)
    return body + _ean13_check_digit(body)


def decode(image_bytes: bytes) -> list[str]:
    """Every barcode the decoder can read from this image, best-first.

    Empty list for "no barcode in frame" and for "decoder unavailable" alike —
    the caller's fallback (the vision model) is the same either way, and the
    unavailable case logs nothing because there is nothing an associate could
    do with it. QR codes are excluded: a QR on a swing tag is a marketing URL,
    not a product identifier, and handing a URL to the SKU lookup produces a
    miss that reads as "not carried".
    """
    try:
        import zxingcpp
        from PIL import Image
    except ImportError:
        return []
    try:
        img = Image.open(io.BytesIO(image_bytes))
        img.load()
    except Exception:
        return []
    try:
        results = zxingcpp.read_barcodes(img)
    except Exception:
        return []
    out: list[str] = []
    for r in results or []:
        text = str(getattr(r, "text", "") or "").strip()
        fmt = str(getattr(r, "format", "") or "")
        if not text or "QR" in fmt.upper():
            continue
        if text not in out:
            out.append(text)
    return out
