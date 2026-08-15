"""The floor, as a guest is allowed to see it.

    from app import catalogue
    catalogue.public_floor("gap")

The request form needs a product list, and a guest's phone is the least
trusted client in the system. So this is a deliberately lossy view of
`floor_inventory()`:

  kept     what it is, what it costs, where on the floor it sits, and which
           sizes exist and can be asked for
  dropped  unit counts, every time

**Counts never leave.** "We have three left in a 32" is a sentence about a
retailer's business — the number a competitor would like, and the number that
turns a helpful page into a live stock feed anyone can poll from the car park.
The guest does not need it either: they need to know a 32 is a size this
product comes in, and the honest answer to whether one is on the shelf is the
associate walking over with it.

Out of stock is still shown, and marked
---------------------------------------
The alternative is hiding it, which reads to a guest as "that size does not
exist" — so they ask for the wrong thing, or give up. Showing it greyed lets
them ask anyway, which is frequently the right outcome: the floor holds stock
the system does not know about, and somebody can check the back.
"""
from __future__ import annotations

import re
from typing import Any

from . import crm_provider

#: Letter sizes in the order a human expects them. Anything not in here sorts
#: numerically where it can, then alphabetically — which handles "32x30" and
#: "W32 L30" without needing to understand either.
_LETTERS = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "1X", "2X", "3X"]


def size_key(label: str) -> tuple:
    s = str(label).strip().upper()
    if s in _LETTERS:
        return (0, _LETTERS.index(s), 0.0, s)
    nums = [float(n) for n in re.findall(r"\d+(?:\.\d+)?", s)]
    if nums:
        # Waist first, then inseam: "32x30" before "32x32", and both before 34.
        return (1, nums[0], nums[1] if len(nums) > 1 else 0.0, s)
    return (2, 0, 0.0, s)


def public_floor(tenant_slug: str) -> dict[str, Any]:
    """Products a guest can ask for, with sizes and no counts."""
    crm = crm_provider.get_crm_for(tenant_slug)
    items = crm.floor_inventory() or []

    products = []
    for item in items:
        sizes_raw = item.get("sizes")
        sizes = None
        if sizes_raw:
            sizes = [
                # `available`, not `stock`. The boolean is the whole point of
                # this module.
                {"size": label, "available": bool(count and int(count) > 0)}
                for label, count in sorted(sizes_raw.items(),
                                           key=lambda kv: size_key(kv[0]))
            ]
        products.append({
            "sku": item.get("sku"),
            "name": item.get("name"),
            "price": item.get("price"),
            "location": item.get("location"),
            "sizes": sizes,
        })

    products.sort(key=lambda p: str(p.get("name") or ""))
    return {
        "tenant": tenant_slug,
        "products": products,
        # So a page can say "sizes aren't available for this store" honestly
        # rather than rendering an empty picker that looks broken.
        "sizes_known": any(p["sizes"] for p in products),
    }
