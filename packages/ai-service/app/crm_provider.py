"""CRM provider selection — the seam where GapVision plugs into any retailer.

Multi-tenant: each tenant maps to a CRM backend. One deployment serves the
Gap demo world and live Shopify stores side by side; the client chooses via
a `tenant` parameter (carried by the plugin's launch URL / QR code).

Tenants:
  gap      — Gap-branded demo dataset (mock CRM: Sarah Chen, Denim Wall, …)
  shopify  — live Shopify store via Admin API (needs SHOPIFY_* env vars)

Every provider exposes: all_guests() / get_guest(id) / floor_inventory().
"""
import os

from . import crm as _mock_data


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


_registry: dict[str, object] = {}


def get_crm_for(tenant: str | None):
    t = (tenant or "gap").lower()
    if t in _registry:
        return _registry[t]
    if t == "shopify":
        if not os.environ.get("SHOPIFY_STORE_DOMAIN") or not (
            os.environ.get("SHOPIFY_ADMIN_TOKEN")
            or (os.environ.get("SHOPIFY_CLIENT_ID") and os.environ.get("SHOPIFY_CLIENT_SECRET"))
            or os.environ.get("GAPVISION_SHOPIFY_FIXTURES")
        ):
            raise TenantNotConfigured(
                "Shopify tenant needs SHOPIFY_STORE_DOMAIN plus client credentials "
                "(SHOPIFY_CLIENT_ID/SECRET) in the environment."
            )
        from .crm_shopify import ShopifyCRM
        _registry[t] = ShopifyCRM()
    else:
        _registry["gap"] = MockCRM()
        return _registry["gap"]
    return _registry[t]


def tenant_status() -> dict:
    out = {"gap": "ok"}
    try:
        get_crm_for("shopify")
        out["shopify"] = "ok"
    except TenantNotConfigured:
        out["shopify"] = "not configured (set SHOPIFY_* vars)"
    except Exception as e:  # credential/API errors surface here
        out["shopify"] = f"error: {e}"
    return out
