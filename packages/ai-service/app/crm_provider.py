"""CRM provider selection — the seam where GapVision plugs into any retailer.

GAPVISION_CRM=mock     (default) in-memory demo dataset
GAPVISION_CRM=shopify  any Shopify store via Admin API (see crm_shopify.py)
GAPVISION_CRM=gap      future: Gap loyalty/CRM adapter per the integration spec

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


_instance = None


def get_crm():
    global _instance
    if _instance is None:
        choice = os.environ.get("GAPVISION_CRM", "mock").lower()
        if choice == "shopify":
            from .crm_shopify import ShopifyCRM
            _instance = ShopifyCRM()
        else:
            _instance = MockCRM()
    return _instance


def provider_name():
    return os.environ.get("GAPVISION_CRM", "mock").lower()
