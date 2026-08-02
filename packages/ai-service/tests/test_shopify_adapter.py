"""Offline test of the Shopify adapter against captured GraphQL shapes.

Run:  python -m tests.test_shopify_adapter   (from packages/ai-service)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.crm_shopify import FixtureTransport, ShopifyCRM
from app.llm import get_provider
from app.personas import match_products

FIX = os.path.join(os.path.dirname(__file__), "fixtures_shopify.json")


def main():
    crm = ShopifyCRM(transport=FixtureTransport(FIX))

    roster = crm.all_guests()
    assert len(roster) == 3, roster
    assert roster[0]["loyalty_tier"] == "Icon"       # $1840 spent
    assert roster[1]["loyalty_tier"] == "Enthusiast" # $620
    assert roster[2]["loyalty_tier"] == "Core"       # $140
    print("roster OK:", [(r['name'], r['loyalty_tier']) for r in roster])

    g = crm.get_guest("gid://shopify/Customer/801")
    assert g["name"] == "Jordan Avery"
    assert g["loyalty_tier"] == "Icon" and g["loyalty_points"] == 18400
    assert g["sizes"]["tops"] == "M", g["sizes"]        # 3 M votes
    assert g["sizes"]["bottoms"] == "32", g["sizes"]    # cargo pant
    assert "tops" in g["persona_tags"] and "jerseys" in g["persona_tags"], g["persona_tags"]
    assert g["open_cart_online"][0]["name"] == "Workwear Chore Jacket"
    print("guest OK:", g["name"], g["sizes"], g["persona_tags"][:3])

    inv = crm.floor_inventory()
    assert len(inv) == 4 and inv[0]["price"] == 90.0
    owned = {p["sku"] for p in g["purchase_history"]}
    recs = match_products(g["persona_tags"], owned, inv)
    names = [r["name"] for r in recs]
    assert "Cup Noodle Tee" not in names, "should not recommend owned item"
    assert "Paneled Logo Tee" in names, names   # tops+graphic match
    print("recommendations OK:", names)

    script = get_provider().generate_script(g, recs)
    assert "Jordan" in script["opener"]
    assert any("Jordan" in line or "Avery" in line for line in script["glasses_lines"])
    print("script OK:", script["opener"][:70], "...")
    print("glasses lines:")
    for line in script["glasses_lines"]:
        print("   ", line)
    print("\nALL SHOPIFY ADAPTER TESTS PASSED")


if __name__ == "__main__":
    main()
