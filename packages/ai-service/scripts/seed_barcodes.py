"""Write a barcode onto every variant that doesn't have one.

    cd packages/ai-service
    python -m scripts.seed_barcodes            # dry run: report only
    python -m scripts.seed_barcodes --write    # actually write

The pilot store was seeded with real SKUs and no barcodes (verified live:
`barcode: null` across the catalogue), which means the phone-camera scan can
decode a label perfectly and still resolve nothing. This closes that gap: one
EAN-13 per variant, derived deterministically from its SKU by
`app.barcode.ean13_for_sku` — the **same generator** the demo CRM answers to,
so a label printed for either world scans in both. Prefix 20 (GS1's in-store
range: the sanctioned choice for retailer-internal labels), valid check digit,
so any scanner reads them.

Credentials come from the environment exactly as the adapter's env fallback
does (`SHOPIFY_STORE_DOMAIN` + `SHOPIFY_ADMIN_TOKEN`); run it wherever those
already live — a Railway one-off shell is the expected home. Deterministic and
idempotent: rerunning writes nothing new, and a variant that already carries a
barcode is never touched (a real GS1 code from a brand must survive this).

Needs `write_products` scope. The mutation is `productVariantsBulkUpdate`,
one call per product, so 300 products is 300 requests — throttled politely.
"""
from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.barcode import ean13_for_sku          # noqa: E402
from app.crm_shopify import ShopifyTransport   # noqa: E402

Q_PAGE = """
query page($cursor: String) {
  products(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      id title
      variants(first: 100) { edges { node { id sku barcode } } }
    } }
  }
}"""

M_UPDATE = """
mutation setBarcodes($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    userErrors { field message }
  }
}"""


def main() -> int:
    write = "--write" in sys.argv
    t = ShopifyTransport(
        domain=os.environ["SHOPIFY_STORE_DOMAIN"],
        token=os.environ.get("SHOPIFY_ADMIN_TOKEN"),
        client_id=os.environ.get("SHOPIFY_CLIENT_ID"),
        client_secret=os.environ.get("SHOPIFY_CLIENT_SECRET"),
    )

    cursor = None
    products = missing = written = 0
    while True:
        data = t.query(Q_PAGE, {"cursor": cursor})
        page = data["products"]
        for edge in page["edges"]:
            p = edge["node"]
            products += 1
            updates = []
            for vedge in p["variants"]["edges"]:
                v = vedge["node"]
                if v.get("barcode"):          # a real code is never overwritten
                    continue
                if not v.get("sku"):          # nothing to derive from
                    continue
                missing += 1
                updates.append({"id": v["id"], "barcode": ean13_for_sku(v["sku"])})
            if updates and write:
                out = t.query(M_UPDATE, {"productId": p["id"], "variants": updates})
                errs = out["productVariantsBulkUpdate"]["userErrors"]
                if errs:
                    print(f"  ERROR on {p['title']}: {errs}")
                else:
                    written += len(updates)
                time.sleep(0.3)               # stay far inside the rate limit
        if not page["pageInfo"]["hasNextPage"]:
            break
        cursor = page["pageInfo"]["endCursor"]

    verb = "wrote" if write else "would write (dry run — pass --write)"
    print(f"{products} products scanned; {missing} variants without a barcode; "
          f"{verb} {written if write else missing}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
