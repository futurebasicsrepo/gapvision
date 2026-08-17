"""Floor checkout links — the mint, the resolution, and the refusals.

The bar mirrors the voice engine's: nothing here may invent a sale. A line
that could not be resolved is reported, never silently dropped; a link that
could not be minted is a refusal with a sentence, never a 500 and never a
fake success.
"""
import os

import pytest
from fastapi.testclient import TestClient

from app import checkout
from app.crm_provider import MockCRM
from app.crm_shopify import FixtureTransport, ShopifyCRM
from app.main import app

FIX = os.path.join(os.path.dirname(__file__), "fixtures_shopify.json")

client = TestClient(app)


# --- the Shopify adapter's mint ---------------------------------------------

def shopify_crm() -> ShopifyCRM:
    return ShopifyCRM(transport=FixtureTransport(FIX))


def test_shopify_mint_returns_invoice_url_and_total():
    out = shopify_crm().create_checkout_link(
        [{"variant_id": "gid://shopify/ProductVariant/1", "qty": 1},
         {"title": "Hemming", "price": 12.0, "qty": 1}],
        guest_id="gid://shopify/Customer/801",
        note="Cue floor checkout — test",
    )
    assert out["url"].startswith("https://")
    assert out["draft_id"] == "gid://shopify/DraftOrder/9001"
    assert out["total"] == 238.0 and out["currency"] == "USD"


def test_shopify_mint_refuses_an_empty_basket():
    with pytest.raises(ValueError):
        shopify_crm().create_checkout_link([])
    # Lines with neither a variant nor a title are not lines.
    with pytest.raises(ValueError):
        shopify_crm().create_checkout_link([{"price": 10.0}])


def test_open_cart_carries_the_variant_id_through():
    """The abandoned-cart line must arrive with its variant id, so a floor
    checkout of "what's in her cart" sells the real variant, not a title."""
    g = shopify_crm().get_guest("gid://shopify/Customer/801")
    cart = g["open_cart_online"]
    assert cart and cart[0]["variant_id"] == "gid://shopify/ProductVariant/4001"


def test_lookup_code_carries_the_variant_id():
    crm = shopify_crm()

    class _T:
        def query(self, gql, variables=None):
            assert "productVariants" in gql
            return {"productVariants": {"edges": [{"node": {
                "id": "gid://shopify/ProductVariant/77",
                "sku": "HAL-STJ-RIN-32", "barcode": "2001234567897",
                "price": "148.00", "inventoryQuantity": 6,
                "selectedOptions": [{"name": "Waist", "value": "32"}],
                "product": {"title": "Straight Jean", "handle": "straight-jean",
                            "totalInventory": 11},
            }}]}}

    crm.t = _T()
    hit = crm.lookup_code("2001234567897")
    assert hit["variant_id"] == "gid://shopify/ProductVariant/77"


# --- the mock world's mint ---------------------------------------------------

def test_mock_mint_does_real_arithmetic():
    out = MockCRM().create_checkout_link(
        [{"title": "Poplin Shirt", "price": 54.95, "qty": 2},
         {"title": "Heavyweight Relaxed Tee", "price": 29.95}],
    )
    assert out["total"] == pytest.approx(139.85)
    assert out["url"].startswith("https://demo.cuesea.ai/checkout/")
    assert out["draft_id"].startswith("demo:")


def test_mock_mint_refuses_an_empty_basket():
    with pytest.raises(ValueError):
        MockCRM().create_checkout_link([])


# --- build_link: resolution and reporting ------------------------------------

def test_build_link_resolves_codes_and_names_what_it_skipped():
    out = checkout.build_link(
        MockCRM(), "gap",
        [{"code": "GAP-TEE-1150", "qty": 1},
         {"code": "NO-SUCH-SKU-000"},
         {"title": "Gift wrap", "price": 5.0}],
    )
    assert out["ok"] is True
    assert out["total"] and out["url"]
    # The unresolvable code is named, not swallowed.
    assert out["skipped"] == [{"code": "NO-SUCH-SKU-000",
                               "reason": "not found in the store"}]
    assert len(out["lines"]) == 2


def test_build_link_refuses_when_nothing_resolves():
    with pytest.raises(checkout.CheckoutRefused) as e:
        checkout.build_link(MockCRM(), "gap", [{"code": "NO-SUCH-SKU-000"}])
    assert e.value.status == 422


def test_build_link_bounds_the_basket():
    items = [{"title": f"Line {i}", "price": 1.0} for i in range(checkout.MAX_LINES + 1)]
    with pytest.raises(checkout.CheckoutRefused) as e:
        checkout.build_link(MockCRM(), "gap", items)
    assert e.value.status == 400


def test_build_link_respects_the_tenant_switch(monkeypatch):
    monkeypatch.setattr(checkout.capabilities, "checkout_links", lambda slug: False)
    with pytest.raises(checkout.CheckoutRefused) as e:
        checkout.build_link(MockCRM(), "gap", [{"title": "Tee", "price": 10.0}])
    assert e.value.status == 403


def test_build_link_names_an_adapter_that_cannot_mint():
    class NoMint:
        def lookup_code(self, code):
            return None

    with pytest.raises(checkout.CheckoutRefused) as e:
        checkout.build_link(NoMint(), "gap", [{"title": "Tee", "price": 10.0}])
    assert e.value.status == 501


def test_qr_matrix_is_inert_rows():
    qr = checkout.qr_matrix("https://demo.cuesea.ai/checkout/abc")
    assert qr and all(set(row) <= {"0", "1"} for row in qr)
    # Square, as a QR is — the page draws rectangles from these rows.
    assert all(len(row) == len(qr) for row in qr)


# --- the endpoint's own door -------------------------------------------------

def test_endpoint_requires_the_service_key():
    r = client.post("/api/checkout-link",
                    json={"tenant": "gap",
                          "items": [{"title": "Tee", "price": 10.0}]})
    assert r.status_code == 401


def test_endpoint_mints_for_the_demo_tenant(auth_headers):
    r = client.post(
        "/api/checkout-link",
        headers=auth_headers,
        json={"tenant": "gap",
              "guest_id": "guest-maya",
              "associate": "Alex R.",
              "items": [{"code": "GAP-TEE-1150", "qty": 2},
                        {"title": "Alteration", "price": 15.0}]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["url"].startswith("https://demo.cuesea.ai/checkout/")
    assert body["qr"], "the QR convenience should ride along when segno exists"
    assert body["skipped"] == []


def test_endpoint_maps_refusals_onto_http(auth_headers):
    r = client.post(
        "/api/checkout-link",
        headers=auth_headers,
        json={"tenant": "gap", "items": [{"code": "NO-SUCH-SKU-000"}]},
    )
    assert r.status_code == 422
    assert "no link was created" in r.json()["detail"].lower()
