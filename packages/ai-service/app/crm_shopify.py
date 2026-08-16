"""Shopify CRM adapter — GapVision on real commerce data.

Implements the same contract as the mock CRM (`crm.py`) against any Shopify
store via the Admin GraphQL API. This is what makes GapVision sellable to any
Shopify POS retailer: guest identity, order history, derived sizes, style
personas, and live floor inventory — all from the merchant's existing data.

Credentials are per tenant, not per deployment: the store domain and token live
in `tenant_crm_credentials`, sealed (see `crm_credentials.py`), and are passed
into `ShopifyCRM` explicitly. One CueSea deployment therefore serves any number of
merchants' stores. The `SHOPIFY_*` environment variables are a deprecated
fallback for the original single-store pilot — `ShopifyCRM.from_env()`.

Each merchant creates their own custom app in Shopify Admin → Settings → Apps
and sales channels → Develop apps → Create app → Admin API scopes
(read_customers, read_orders, read_products, read_inventory) → Install → reveal
token. No Shopify app review is involved. The token lives ONLY server-side,
encrypted at rest, and is never returned by any API.

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
import socket
import time
import urllib.error
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
      variants(first: 25) { edges { node {
        title inventoryQuantity price
        selectedOptions { name value }
      } } }
    } }
  }
}"""

# What the Connect Shopify panel reads. `currentAppInstallation` is readable by
# any valid Admin token with no scope of its own, which is what makes it usable
# as a connection test: a bad token fails here, and a token that is merely
# missing a scope still answers and says which ones it has.
#: One code, one variant. The search filter accepts `sku:` and `barcode:`
#: terms, so a decoded EAN and a printed style number resolve through the same
#: query — exact, against the live store, never against a cached page of 30.
Q_VARIANT_LOOKUP = """
query variantByCode($q: String!) {
  productVariants(first: 5, query: $q) {
    edges { node {
      sku barcode price inventoryQuantity
      selectedOptions { name value }
      product { title handle totalInventory }
    } }
  }
}"""

Q_SCOPES = """
query appScopes {
  currentAppInstallation { accessScopes { handle } }
  shop { name myshopifyDomain }
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


def _address(a: dict | None) -> dict:
    """Shopify's address, flattened to what a 21-character line can hold.

    `line1` / `line2` / `line3` rather than the source's field names, because
    the lens renders three rows and the caller should not have to decide how to
    fold a country into them. Empty strings rather than nulls: the card renders
    what it is given, and a missing floor is a shorter card, not a broken one.
    """
    if not a:
        return {"line1": "", "line2": "", "line3": "", "country": ""}
    city_bits = " ".join(x for x in (a.get("city"), a.get("provinceCode"),
                                     a.get("zip")) if x)
    return {
        "line1": (a.get("address1") or "").strip(),
        "line2": (a.get("address2") or "").strip(),
        "line3": city_bits.strip(),
        "country": (a.get("countryCodeV2") or "").strip(),
    }


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

    def __init__(self, transport=None, *, domain: str | None = None,
                 admin_token: str | None = None, client_id: str | None = None,
                 client_secret: str | None = None):
        """Credentials in, adapter out — nothing read from the environment.

        Instances are per tenant, so the response cache below is too. That is
        not incidental: a process-wide cache keyed only by 'roster' would serve
        one merchant's customers to another, which is the failure this whole
        change exists to make impossible.
        """
        if transport is not None:
            self.t = transport
        elif domain:
            self.t = ShopifyTransport(
                domain, token=admin_token,
                client_id=client_id, client_secret=client_secret,
            )
        else:
            raise ValueError("ShopifyCRM needs a store domain or a transport")
        self._cache: dict[str, tuple[float, object]] = {}

    @classmethod
    def from_env(cls) -> "ShopifyCRM":
        """Deprecated single-store path, kept so the original pilot deployment
        keeps working until its credentials are moved into the database."""
        if os.environ.get("GAPVISION_SHOPIFY_FIXTURES"):
            # Snapshot mode: replay a captured store (dev/demo without a token)
            return cls(transport=FixtureTransport(os.environ["GAPVISION_SHOPIFY_FIXTURES"]))
        return cls(
            domain=os.environ["SHOPIFY_STORE_DOMAIN"],
            admin_token=os.environ.get("SHOPIFY_ADMIN_TOKEN"),
            client_id=os.environ.get("SHOPIFY_CLIENT_ID"),
            client_secret=os.environ.get("SHOPIFY_CLIENT_SECRET"),
        )

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
        # The query has always fetched these and always thrown them away.
        # "When did she last order" is one of the questions a floor actually
        # asks, and the answer was already on the wire.
        oedges = c["orders"]["edges"]
        last_at = (oedges[0]["node"].get("createdAt") or "")[:10] if oedges else ""
        last_ref = oedges[0]["node"].get("name") or "" if oedges else ""
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
            # --- customer depth ---------------------------------------------
            # Kyle's ask: an associate already talking to someone should be
            # able to reach the rest of that person's record without leaving
            # the lens. Everything here is post-identification — it is depth on
            # somebody you are already serving, not enumeration of people you
            # are not, which is the line that keeps the roster endpoint closed
            # while these stay open.
            "contact": {
                "email": c.get("email") or "",
                "phone": c.get("phone") or "",
            },
            "address": _address(c.get("defaultAddress")),
            "orders": {
                "count": int(c.get("numberOfOrders") or 0),
                "last_at": last_at,
                "last_ref": last_ref,
            },
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

    # ---- one code, one variant ------------------------------------------
    def lookup_code(self, code: str) -> dict | None:
        """The variant this SKU or barcode names, or None.

        This is what the phone-camera scan resolves against on a live store.
        Exact by construction: the store's own search over `sku:` and
        `barcode:`, not containment over whatever thirty products the floor
        cache happens to hold. Raising is allowed — the caller treats an
        error as "could not answer", which must never read as "not carried".
        """
        wanted = "".join(c for c in str(code or "").strip()
                         if c.isalnum() or c in "-_./")
        if not wanted:
            return None

        def fetch():
            data = self.t.query(Q_VARIANT_LOOKUP,
                                {"q": f"sku:{wanted} OR barcode:{wanted}"})
            edges = (data.get("productVariants") or {}).get("edges") or []
            if not edges:
                return None
            v = edges[0]["node"]
            size = None
            for opt in v.get("selectedOptions") or []:
                if str(opt.get("name", "")).strip().lower() in ("size", "waist", "length"):
                    size = str(opt.get("value", "")).strip()
                    break
            qty = v.get("inventoryQuantity")
            return {
                "sku": v.get("sku") or wanted,
                "barcode": v.get("barcode"),
                "name": (v.get("product") or {}).get("title") or wanted,
                "price": float(v.get("price") or 0),
                # The variant's own count — the size in the associate's hand —
                # not the product total across every size and colour.
                "stock": int(qty) if qty is not None else None,
                "size": size,
                "location": "Floor",  # per-zone via product metafield later
            }
        return self._cached(f"code:{wanted}", fetch)

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
                item = {
                    "sku": p["handle"],
                    "name": p["title"],
                    "price": float(p["priceRangeV2"]["minVariantPrice"]["amount"]),
                    "tags": sorted(set(tags)),
                    "location": "Floor",  # per-zone via product metafield later
                    "stock": stock,
                }
                sizes = _variant_sizes(p)
                # Omitted rather than emitted empty. A product with no size
                # option — a candle, a tote — genuinely has no size breakdown,
                # and `{}` would read downstream as "we looked and there are
                # none in stock", which is a different and wrong answer.
                if sizes:
                    item["sizes"] = sizes
                items.append(item)
            return items
        return self._cached("inventory", fetch)


def _variant_sizes(product: dict) -> dict[str, int]:
    """Per-size unit counts, the shape `crm.INVENTORY` has always had.

    The query was already retrieving variants and throwing them away, which is
    why "do you have these in a 32" answered "unknown" against a live store
    while answering exactly against the mock. The data was on the wire.

    The size is taken from the option actually named "size" rather than from
    the variant title: a two-option product titles its variants "32x30 / Indigo",
    and treating that string as a size would put a colour in the answer and
    split one size across every colourway.
    """
    out: dict[str, int] = {}
    for edge in (product.get("variants") or {}).get("edges") or []:
        v = edge.get("node") or {}
        label = None
        for opt in v.get("selectedOptions") or []:
            if str(opt.get("name", "")).strip().lower() in ("size", "waist", "length"):
                label = str(opt.get("value", "")).strip()
                break
        if label is None:
            title = str(v.get("title") or "").strip()
            # "Default Title" is Shopify's placeholder for a product with no
            # options at all. It is not a size and must not become one.
            if not title or title.lower() == "default title" or "/" in title:
                continue
            label = title
        if not label:
            continue
        qty = v.get("inventoryQuantity")
        out[label] = out.get(label, 0) + (int(qty) if qty is not None else 0)
    return out


# ---------------------------------------------------------------- connection test
#
# The lesson from `/tmp/ghpush.sh` and from GitHub's undifferentiated "Invalid
# username or token": when a credential doesn't work, the operator needs to know
# *which* of the plausible things is wrong. A merchant onboarding themselves has
# four ways to get this wrong and they need four different sentences.

def probe_connection(crm: "ShopifyCRM") -> dict:
    """Ask the store who we are. Never raises — a failure is a result.

    Returns {ok, reason, detail, scopes, shop_name}. `reason` is a stable key
    the UI can branch on; `detail` is the sentence a human reads.
    """
    try:
        data = crm.t.query(Q_SCOPES)
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode()[:200]
        except Exception:
            pass
        if e.code in (401, 403):
            return _fail("token_rejected",
                         "The store answered, but rejected this token. Check you "
                         "pasted the Admin API access token (it starts with "
                         "shpat_) and that the custom app is still installed.")
        if e.code == 404:
            return _fail("store_not_found",
                         "No Shopify store at that domain. Use the permanent "
                         "<store>.myshopify.com address, not a custom domain.")
        if e.code == 429:
            return _fail("rate_limited",
                         "Shopify is rate-limiting this store right now. "
                         "Wait a minute and test again.")
        return _fail("http_error", f"Shopify returned HTTP {e.code}. {body}".strip())
    except (urllib.error.URLError, socket.timeout, TimeoutError) as e:
        return _fail("unreachable",
                     f"Couldn't reach that domain ({getattr(e, 'reason', e)}). "
                     "Check the spelling of the store address.")
    except RuntimeError as e:
        # GraphQL-level error — a valid HTTP call the API refused to answer.
        return _fail("api_error", str(e)[:300])
    except Exception as e:  # never let the panel 500 on a vendor surprise
        return _fail("unknown", f"{type(e).__name__}: {e}"[:300])

    installation = (data or {}).get("currentAppInstallation") or {}
    scopes = sorted(
        s["handle"] for s in (installation.get("accessScopes") or []) if s.get("handle")
    )
    shop = (data or {}).get("shop") or {}
    return {
        "ok": True,
        "reason": "connected",
        "detail": f"Connected to {shop.get('name') or shop.get('myshopifyDomain') or 'the store'}.",
        "scopes": scopes,
        "shop_name": shop.get("name"),
        "shop_domain": shop.get("myshopifyDomain"),
    }


def _fail(reason: str, detail: str) -> dict:
    return {"ok": False, "reason": reason, "detail": detail,
            "scopes": [], "shop_name": None, "shop_domain": None}
