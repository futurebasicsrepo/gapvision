"""CRM provider selection — the seam where CueSea plugs into any retailer.

Multi-tenant in the sense that actually matters: not "one deployment can label
its data two ways", but "one deployment can hold two merchants' credentials and
never confuse them". A tenant's adapter is built from that tenant's row in
`tenant_crm_credentials` and cached against that tenant alone.

Resolution order for a tenant slug:

  1. `tenants.crm_provider = 'mock'`      → the demo dataset
  2. a `tenant_crm_credentials` row       → the adapter named by its `provider`,
                                            built from that row (ADAPTER_BUILDERS)
  3. the legacy `SHOPIFY_*` env vars      → deprecated, slug 'shopify' only
  4. otherwise                            → TenantNotConfigured (503)

Adding a CRM is an entry in `ADAPTER_BUILDERS` and a provider in
`crm_credentials.PROVIDERS`. The adapter contract is three methods —
`all_guests()`, `get_guest(id)`, `floor_inventory()` — and nothing above this
module knows which backend a tenant is on.

Step 3 exists so the original single-store pilot keeps working through this
deploy. It is the last thing consulted, so a tenant that has been connected
properly can never be silently overridden by a stale environment variable.

Caching: adapter instances are held per tenant so a minted OAuth token and the
response cache survive between requests. The credential row is re-read every
`_RECHECK_SECONDS`; if it changed the adapter is rebuilt. That bound matters
because Railway can run more than one replica — an explicit invalidation only
reaches the process that handled the write, so the others need to notice on
their own.
"""
from __future__ import annotations

import os
import threading
import time

from . import crm as _mock_data

_RECHECK_SECONDS = 60


class MockCRM:
    def all_guests(self):
        return [
            {"guest_id": g["guest_id"], "name": g["name"], "loyalty_tier": g["loyalty_tier"]}
            for g in _mock_data.all_guests()
        ]

    def get_guest(self, guest_id: str):
        return _mock_data.get_guest(guest_id)

    def floor_inventory(self):
        return _mock_data.INVENTORY

    def lookup_code(self, code: str):
        """Same contract as the Shopify adapter: SKU or barcode, exact.

        The demo inventory carries no barcode column, so each item answers to
        the same derived EAN-13 the seeding script writes to a live store —
        one generator (`barcode.ean13_for_sku`), both worlds, so a label
        printed against either resolves in both.
        """
        from . import barcode
        wanted = str(code or "").strip().upper()
        if not wanted:
            return None
        for item in _mock_data.INVENTORY:
            sku = str(item.get("sku") or "").upper()
            if wanted in (sku, barcode.ean13_for_sku(sku)):
                return dict(item)
        return None

    def create_checkout_link(self, items: list[dict], *, guest_id: str | None = None,
                             note: str | None = None) -> dict:
        """Same contract as the Shopify adapter, against nothing.

        The demo world has no checkout to host, so the link points at a page
        that does not exist under a domain we own — deliberately obvious in a
        demo, and deliberately not a live store's URL. The total is real
        arithmetic over the requested lines, because the number on the lens is
        the part of the demo that has to be believed.
        """
        import hashlib
        total = 0.0
        count = 0
        for it in items or []:
            title = str(it.get("title") or it.get("name") or "").strip()
            if not (title or it.get("variant_id")):
                continue
            try:
                qty = max(1, int(it.get("qty") or 1))
            except (TypeError, ValueError):
                qty = 1
            total += float(it.get("price") or 0) * qty
            count += 1
        if not count:
            raise ValueError("A checkout link needs at least one line")
        ref = hashlib.sha256(
            f"{guest_id}|{count}|{total:.2f}".encode()).hexdigest()[:12]
        return {
            "url": f"https://demo.cuesea.ai/checkout/{ref}",
            "draft_id": f"demo:{ref}",
            "total": round(total, 2),
            "currency": "USD",
        }


class TenantNotConfigured(Exception):
    pass


_MOCK = MockCRM()
_cache: dict[str, dict] = {}
_lock = threading.Lock()


# --- credential lookup -------------------------------------------------------

def env_shopify_configured() -> bool:
    return bool(
        os.environ.get("GAPVISION_SHOPIFY_FIXTURES")
        or (
            os.environ.get("SHOPIFY_STORE_DOMAIN")
            and (
                os.environ.get("SHOPIFY_ADMIN_TOKEN")
                or (os.environ.get("SHOPIFY_CLIENT_ID") and os.environ.get("SHOPIFY_CLIENT_SECRET"))
            )
        )
    )


def _tenant_row(slug: str) -> dict | None:
    from . import db
    if not db.configured():
        return None
    try:
        return db.query_one("SELECT * FROM tenants WHERE slug = %s", (slug,))
    except Exception:
        # A database blip must not take the demo tenant offline; the caller
        # falls back to the environment and then to TenantNotConfigured.
        return None


def _credential_row(tenant_id) -> dict | None:
    from . import crm_credentials, db
    if not db.configured():
        return None
    try:
        return crm_credentials.get_row(tenant_id)
    except Exception:
        return None


def _shopify_from_credential(cred: dict, secret: dict):
    from .crm_shopify import ShopifyCRM
    return ShopifyCRM(
        domain=cred["store_domain"],
        admin_token=secret.get("admin_token"),
        client_id=secret.get("client_id"),
        client_secret=secret.get("client_secret"),
    )


# provider name → how to build its adapter from a stored credential.
#
# Shopify is the only entry today, and the registry exists anyway because the
# alternative is what this code did first: build a ShopifyCRM from *any*
# credential row without reading `provider` at all. That is harmless while one
# provider exists and silently wrong the moment a second one lands — an
# enterprise adapter's row would be handed to the Shopify client, which would
# fail somewhere far from the cause. Gap is the expected second case: their
# standing plan is an enterprise adapter running in their own cloud, so it will
# not be a store domain and a token, and it should not be forced into that
# shape. Adding an adapter is one entry here plus a `crm_credentials` provider.
ADAPTER_BUILDERS = {"shopify": _shopify_from_credential}


def _build(slug: str) -> tuple[object, str]:
    """Return (adapter, signature). The signature changes when the credential
    behind the adapter changes, which is how the cache knows to rebuild."""
    tenant = _tenant_row(slug)

    # 1. explicitly a demo tenant, or no such tenant and nothing else to try
    if tenant is not None and (tenant.get("crm_provider") or "mock") == "mock":
        return _MOCK, "mock"

    # 2. per-tenant credentials — the supported path
    if tenant is not None:
        cred = _credential_row(tenant["id"])
        if cred is not None:
            from . import crm_credentials

            provider = cred.get("provider") or tenant.get("crm_provider") or ""
            builder = ADAPTER_BUILDERS.get(provider)
            if builder is None:
                # Checked before decrypting: no reason to open a secret we have
                # nothing to hand it to.
                raise TenantNotConfigured(
                    f"Tenant '{slug}' has credentials for CRM provider "
                    f"'{provider}', which this service has no adapter for. "
                    f"Adapters available: {', '.join(sorted(ADAPTER_BUILDERS))}."
                )

            try:
                secret = crm_credentials.load_secret(cred)
            except Exception as e:
                # A missing or rotated-away CUE_CRED_KEY, or a corrupted row.
                # The lens must get the same clean 503 it gets for a tenant with
                # no store at all, not a 500 — and the reason has to name the
                # key, because that is the only thing an operator can act on.
                raise TenantNotConfigured(
                    f"Tenant '{slug}' has a stored store credential that cannot "
                    f"be opened: {e}"
                ) from e

            return builder(cred, secret), f"db:{cred['updated_at'].isoformat()}"

    # 3. deprecated environment fallback, original pilot store only
    if slug == "shopify" and env_shopify_configured():
        from .crm_shopify import ShopifyCRM
        return ShopifyCRM.from_env(), "env"

    # 4. no tenant row at all and nothing configured — the historic behaviour
    #    for an unrecognised slug was the demo dataset, and the plugin's launch
    #    URL is a place typos happen, so keep it rather than 503 on a typo.
    if tenant is None and slug != "shopify":
        return _MOCK, "mock"

    provider = (tenant or {}).get("crm_provider") or "shopify"
    raise TenantNotConfigured(
        f"Tenant '{slug}' is set to the '{provider}' adapter but has nothing "
        "connected. Add it in Console → Tenants."
    )


def get_crm_for(tenant: str | None):
    slug = (tenant or "gap").lower()
    now = time.monotonic()

    entry = _cache.get(slug)
    if entry and now - entry["checked_at"] < _RECHECK_SECONDS:
        return entry["crm"]

    with _lock:
        # Another thread may have refreshed this while we waited.
        entry = _cache.get(slug)
        if entry and now - entry["checked_at"] < _RECHECK_SECONDS:
            return entry["crm"]

        crm, signature = _build(slug)
        if entry and entry["signature"] == signature:
            # Same credential as before: keep the live adapter, which is holding
            # a minted token and a warm response cache, and discard the rebuild.
            entry["checked_at"] = now
            return entry["crm"]

        _cache[slug] = {"crm": crm, "signature": signature, "checked_at": now}
        return crm


def invalidate(tenant: str | None = None) -> None:
    """Drop cached adapters after a credential change.

    Best-effort by design: this only reaches the process that handled the write.
    Other replicas pick the change up within `_RECHECK_SECONDS`, which is what
    makes that recheck non-optional.
    """
    with _lock:
        if tenant is None:
            _cache.clear()
        else:
            _cache.pop((tenant or "").lower(), None)


def _active_slugs() -> list[str]:
    from . import db
    if db.configured():
        try:
            return [r["slug"] for r in db.query(
                "SELECT slug FROM tenants WHERE status = 'active' ORDER BY slug"
            )]
        except Exception:
            pass
    return ["gap"] + (["shopify"] if env_shopify_configured() else [])


def tenant_status_detail() -> dict:
    """Per-tenant readiness, by slug. Names no credential and no store domain.

    CueSea staff only — see `tenant_status()` for why.
    """
    out: dict[str, str] = {}
    for slug in _active_slugs():
        try:
            get_crm_for(slug)
            out[slug] = "ok"
        except TenantNotConfigured:
            out[slug] = "no store connected"
        except Exception as e:
            out[slug] = f"error: {str(e)[:120]}"
    return out


def tenant_status() -> dict:
    """Counts for the unauthenticated /health route.

    Deliberately not a list of slugs. /health is open on purpose so the
    scheduled check can poll it without a credential, and the set of tenant
    slugs is the set of CueSea's customers — a thing worth not publishing to
    anyone who curls the hostname. The named breakdown lives behind
    `/api/admin/platform`, which requires a cue_admin.
    """
    counts = {"active": 0, "ready": 0, "not_connected": 0, "error": 0}
    for state in tenant_status_detail().values():
        counts["active"] += 1
        if state == "ok":
            counts["ready"] += 1
        elif state == "no store connected":
            counts["not_connected"] += 1
        else:
            counts["error"] += 1
    return counts
