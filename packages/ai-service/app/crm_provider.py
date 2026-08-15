"""CRM provider selection — the seam where Cue plugs into any retailer.

Multi-tenant in the sense that actually matters: not "one deployment can label
its data two ways", but "one deployment can hold two merchants' credentials and
never confuse them". A tenant's adapter is built from that tenant's row in
`tenant_crm_credentials` and cached against that tenant alone.

Resolution order for a tenant slug:

  1. `tenants.crm_provider = 'mock'`      → the demo dataset
  2. a `tenant_crm_credentials` row       → a live store, credentials from it
  3. the legacy `SHOPIFY_*` env vars      → deprecated, slug 'shopify' only
  4. otherwise                            → TenantNotConfigured (503)

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


def _build(slug: str) -> tuple[object, str]:
    """Return (adapter, signature). The signature changes when the credential
    behind the adapter changes, which is how the cache knows to rebuild."""
    from .crm_shopify import ShopifyCRM

    tenant = _tenant_row(slug)

    # 1. explicitly a demo tenant, or no such tenant and nothing else to try
    if tenant is not None and (tenant.get("crm_provider") or "mock") == "mock":
        return _MOCK, "mock"

    # 2. per-tenant credentials — the supported path
    if tenant is not None:
        cred = _credential_row(tenant["id"])
        if cred is not None:
            from . import crm_credentials
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
            return (
                ShopifyCRM(
                    domain=cred["store_domain"],
                    admin_token=secret.get("admin_token"),
                    client_id=secret.get("client_id"),
                    client_secret=secret.get("client_secret"),
                ),
                f"db:{cred['updated_at'].isoformat()}",
            )

    # 3. deprecated environment fallback, original pilot store only
    if slug == "shopify" and env_shopify_configured():
        return ShopifyCRM.from_env(), "env"

    # 4. no tenant row at all and nothing configured — the historic behaviour
    #    for an unrecognised slug was the demo dataset, and the plugin's launch
    #    URL is a place typos happen, so keep it rather than 503 on a typo.
    if tenant is None and slug != "shopify":
        return _MOCK, "mock"

    raise TenantNotConfigured(
        f"Tenant '{slug}' is set to the Shopify adapter but has no store "
        "connected. Add one in Cue Console → Tenants → Connect Shopify."
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

    Cue staff only — see `tenant_status()` for why.
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
    slugs is the set of Cue's customers — a thing worth not publishing to
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
