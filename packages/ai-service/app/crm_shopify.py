"""Shopify CRM adapter — GapVision on real commerce data.

Implements the same contract as the mock CRM (`crm.py`) against any Shopify
store via the Admin GraphQL API. This is what makes GapVision sellable to any
Shopify POS retailer: guest identity, order history, derived sizes, style
personas, and live floor inventory — all from the merchant's existing data.

Config (env):
    GAPVISION_CRM=shopify
    SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
    SHOPIFY_ADMIN_TOKEN=shpat_...   (custom app token; scopes: read_customers,
                                     read_orders, read_products, read_inventory)

Create the token in Shopify Admin → Settings → Apps and sales channels →
Develop apps → Create app → Admin API scopes above → Install → reveal token.
The token lives ONLY in the server environment, never in client code.

Derivations (documented so merchants understand what associates see):
    tier         total spent: >= $1500 Icon, >= $500 Enthusiast, else Core
    points       floor(total spent) * 10
    sizes        most-frequent variant option per product category in history
    persona_tags top product tags/types from purchase history (max 5)
    open cart    most recent abandoned checkout line items (best-effort;
                 requires read_orders scope, returns [] if unavailable)
"""
from __future__ import annotations

import json
import os
import time
import urllib.request
from collections import Counter

API_VERSION = "2026-07"

# ---------------------------------------------------------------- transport
class ShopifyTransport:
    """Live Admin GraphQL transport.

    Two auth modes:
      - Legacy custom apps (created pre-2026 in admin): static SHOPIFY_ADMIN_TOKEN.
      - Dev Dashboard apps (2026+): SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET —
        tokens are minted via the client-credentials grant and expire every
        24h; this transport re-mints automatically.
    """

    def __init__(self, domain: str, token: str | None = None,
                 client_id: str | None = None, client_secret: str | None = None):
        self.domain = domain
        self.url = f"https://{domain}/admin/api/{API_VERSION}/graphql.json"
        self._static_token = token
        self._client_id = client_id
        self._client_secret = client_secret
        self._minted_token: str | None = None
        self._minted_expiry: float = 0.0

    def _token(self) -> str:
        if self._static_token:
            return self._static_token
        # re-mint 5 minutes before the 24h expiry
        if not self._minted_token or time.time() > self._minted_expiry - 300:
            body = json.dumps({
                "client_id": self._client_id,
                "client_secret": self._client_secret,
                "grant_type": "client_credentials",
            }).encode()
            req = urllib.request.Request(
                f"https://{self.domain}/admin/oauth/access_token",
                data=body, method="POST",
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                out = json.loads(resp.read())
            self._minted_token = out["access_token"]
            self._minted_expiry = time.time() + int(out.get("expires_in", 86399))
        return self._minted_token

    def query(self, gql: str, variables: dict | None = None) -> dict:
        body = json.dumps({"query": gql, "variables": variables or {}}).encode()
        req = urllib.request.Request(
            self.url, data=body, method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Shopify-Access-Token": self._token(),
            },
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            out = json.loads(resp.read())
        if out.get("errors"):
            raise RuntimeError(f"Shopify GraphQL error: {out['errors'][:1]}")
        return out["data"]


class FixtureTransport:
    """Replays a captured store snapshot (JSON) — offline dev and tests."""

    def __init__(self, path: str):
        self.fixtures = json.load(open(path))

    def query(self, gql: str, variables: dict | None = None) -> dict:
        for key, data in self.fixtures.items():
            if key in gql:
                return data
        raise KeyError(f"No fixture matches query. Keys: {list(self.fixtures)}")


# ---------------------------------------------------------------- queries
Q_CUSTOMERS = """
query recentCustomers($first: Int!) {
  customers(first: $first, sortKey: UPDATED_AT, reverse: true) {
    edges { node {
      id displayName amountSpent { amount } numberOfOrders tags
    } }
  }
}"""

Q_CUSTOMER_DETAIL = """
query customerDetail($id: ID!) {
  customer(id: $id) {
    id displayName amountSpent { amount } numberOfOrders tags
    orders(first: 20, sortKey: CREATED_AT, reverse: true) {
      edges { node {
        name createdAt
        lineItems(first: 20) { edges { node {
          title quantity
          variant { title price product { productType tags } }
        } } }
      } }
    }
  }
}"""

Q_PRODUCTS = """
query floorProducts($first: Int!) {
  products(first: $first, query: "status:active", sortKey: UPDATED_AT, reverse: true) {
    edges { node {
      id title handle productType tags totalInventory
      priceRangeV2 { minVariantPrice { amount } }
      variants(first: 10) { edges { node { title inventoryQuantity price } } }
    } }
  }
}"""

Q_ABANDONED = """
query abandoned($query: String!) {
  abandonedCheckouts(first: 1, query: $query, sortKey: CREATED_AT, reverse: true) {
    edges { node {
      lineItems(first: 5) { edges { node {
        title quantity variant { price }
      } } }
    } }
  }
}"""

TOP_CATEGORIES = {"tops", "tees", "shirts", "hoodies", "sweaters", "jerseys", "outerwear", "jackets"}
BOTTOM_CATEGORIES = {"bottoms", "pants", "jeans", "shorts", "joggers", "trousers"}
NON_PRODUCT_LINES = {"shipping", "tip", "gift wrap", "route package protection"}

# Many stores (including small DTC brands) leave productType/tags empty.
# Derive lightweight category tags from titles so personas & matching still work.
KEYWORD_TAGS = [
    (("tee", "t shirt", "t-shirt", "shirt"), ("tops", "tee")),
    (("hoodie", "sweater", "crew"), ("tops", "knit")),
    (("jersey",), ("tops", "jerseys")),
    (("pant", "trouser", "jean", "jogger", "cargo"), ("bottoms",)),
    (("short",), ("bottoms", "shorts")),
    (("jacket", "coat", "parka"), ("outerwear",)),
    (("trainer", "sneaker", "shoe", "boot"), ("footwear",)),
    (("hat", "cap", "beanie"), ("headwear",)),
    (("board", "skate", "fingerboard"), ("skate",)),
]


def _keyword_tags(title: str) -> list[str]:
    t = title.lower()
    out: list[str] = []
    for keys, tags in KEYWORD_TAGS:
        if any(k in t for k in keys):
            out.extend(tags)
    return out


def _tier(total_spent: float) -> str:
    if total_spent >= 1500:
        return "Icon"
    if total_spent >= 500:
        return "Enthusiast"
    return "Core"


class ShopifyCRM:
    """Same public surface as the mock crm module: get_guest / all_guests /
    floor_inventory. Results cached briefly to respect API rate limits."""

    CACHE_TTL = 60  # seconds

    def __init__(self, transport=None):
        if transport is not None:
            self.t = transport
        elif os.environ.get("GAPVISION_SHOPIFY_FIXTURES"):
            # Snapshot mode: replay a captured store (dev/demo without a token)
            self.t = FixtureTransport(os.environ["GAPVISION_SHOPIFY_FIXTURES"])
        else:
            domain = os.environ["SHOPIFY_STORE_DOMAIN"]
            self.t = ShopifyTransport(
                domain,
                token=os.environ.get("SHOPIFY_ADMIN_TOKEN"),
                client_id=os.environ.get("SHOPIFY_CLIENT_ID"),
                client_secret=os.environ.get("SHOPIFY_CLIENT_SECRET"),
            )
        self._cache: dict[str, tuple[float, object]] = {}

    def _cached(self, key: str, fn):
        hit = self._cache.get(key)
        if hit and time.time() - hit[0] < self.CACHE_TTL:
            return hit[1]
        val = fn()
        self._cache[key] = (time.time(), val)
        return val

    # ---- roster (beacon panel) ------------------------------------------
    def all_guests(self) -> list[dict]:
        def fetch():
            data = self.t.query(Q_CUSTOMERS, {"first": 10})
            out = []
            for edge in data["customers"]["edges"]:
                c = edge["node"]
                spent = float(c["amountSpent"]["amount"] or 0)
                out.append({
                    "guest_id": c["id"],
                    "name": c["displayName"],
                    "loyalty_tier": _tier(spent),
                })
            return out
        return self._cached("roster", fetch)

    # ---- full guest context ---------------------------------------------
    def get_guest(self, guest_id: str) -> dict | None:
        data = self.t.query(Q_CUSTOMER_DETAIL, {"id": guest_id})
        c = data.get("customer")
        if not c:
            return None

        spent = float(c["amountSpent"]["amount"] or 0)
        purchases, size_votes, persona = [], {"tops": Counter(), "bottoms": Counter()}, Counter()

        for oedge in c["orders"]["edges"]:
            for ledge in oedge["node"]["lineItems"]["edges"]:
                li = ledge["node"]
                if li["title"].strip().lower() in NON_PRODUCT_LINES:
                    continue  # shipping fees etc. are not products
                variant = li.get("variant") or {}
                product = variant.get("product") or {}
                ptype = (product.get("productType") or "").lower()
                if not ptype:
                    kw = _keyword_tags(li["title"])
                    ptype = kw[0] if kw else ""
                purchases.append({
                    "sku": li["title"],
                    "name": li["title"],
                    "price": float(variant.get("price") or 0),
                })
                for tag in _keyword_tags(li["title"]):
                    persona[tag] += 1
                # size inference: variant title is the size option in most
                # apparel stores (S/M/L/XL or numeric)
                vtitle = (variant.get("title") or "").strip()
                if vtitle and vtitle.lower() not in ("default title", "os"):
                    bucket = "bottoms" if ptype in BOTTOM_CATEGORIES else "tops"
                    size_votes[bucket][vtitle] += 1
                for tag in product.get("tags") or []:
                    persona[str(tag).lower()] += 1
                if ptype:
                    persona[ptype] += 1

        sizes = {
            "tops": (size_votes["tops"].most_common(1) or [("—", 0)])[0][0],
            "bottoms": (size_votes["bottoms"].most_common(1) or [("—", 0)])[0][0],
        }
        persona_tags = [t for t, _ in persona.most_common(5) if t not in ("new",)]

        return {
            "guest_id": c["id"],
            "name": c["displayName"],
            "loyalty_tier": _tier(spent),
            "loyalty_points": int(spent * 10),
            "sizes": sizes,
            "persona_tags": persona_tags or ["first-visit"],
            "purchase_history": purchases[:8],
            "open_cart_online": self._open_cart(c),
        }

    def _open_cart(self, customer: dict) -> list[dict]:
        try:
            name = customer["displayName"].split()[0]
            data = self.t.query(Q_ABANDONED, {"query": f"name:{name}"})
            edges = data["abandonedCheckouts"]["edges"]
            if not edges:
                return []
            items = []
            for ledge in edges[0]["node"]["lineItems"]["edges"]:
                li = ledge["node"]
                items.append({
                    "sku": li["title"],
                    "name": li["title"],
                    "price": float((li.get("variant") or {}).get("price") or 0),
                })
            return items[:3]
        except Exception:
            return []  # scope missing or API shape drift — degrade gracefully

    # ---- live floor inventory -------------------------------------------
    def floor_inventory(self) -> list[dict]:
        def fetch():
            data = self.t.query(Q_PRODUCTS, {"first": 30})
            items = []
            for edge in data["products"]["edges"]:
                p = edge["node"]
                stock = p.get("totalInventory") or 0
                tags = [str(t).lower() for t in (p.get("tags") or [])]
                if p.get("productType"):
                    tags.append(p["productType"].lower())
                tags.extend(_keyword_tags(p["title"]))
                items.append({
                    "sku": p["handle"],
                    "name": p["title"],
                    "price": float(p["priceRangeV2"]["minVariantPrice"]["amount"]),
                    "tags": sorted(set(tags)),
                    "location": "Floor",  # per-zone via product metafield later
                    "stock": stock,
                })
            return items
        return self._cached("inventory", fetch)
