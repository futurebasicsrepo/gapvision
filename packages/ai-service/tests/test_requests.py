"""What the guest asked for.

    CUE_TEST_DATABASE_URL=... python -m pytest tests/test_requests.py -q

Presence says somebody is in fitting room three. A request says they want a 32
in the barrel jean, and that is the sentence the whole product is for.

Two claims are load-bearing here and each has a test that fails loudly if it
stops being true:

  * A request needs a live check-in. It is the only thing standing between an
    open route and anybody putting whatever they like on an associate's glass.
  * A request needs no identity. "Fitting room 3 wants a 32" is completely
    actionable and names nobody — asking someone to sign in before they can
    ask for a size is friction charged for our convenience.
"""
from __future__ import annotations

import os

import pytest

DB_URL = (os.environ.get("CUE_TEST_DATABASE_URL")
          or os.environ.get("CUE_DATABASE_URL"))
if DB_URL:
    os.environ["CUE_DATABASE_URL"] = DB_URL

from fastapi.testclient import TestClient  # noqa: E402

from app import catalogue, db, presence, retention  # noqa: E402
from app import requests as guest_requests  # noqa: E402
from app.main import app  # noqa: E402

pytestmark = pytest.mark.skipif(not DB_URL, reason="needs a database")

KEY = {"x-gapvision-key": os.environ.get("GAPVISION_API_KEY", "")}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def tenant(client):
    row = db.query_one("SELECT * FROM tenants WHERE slug = %s", ("t_asks",))
    if row is None:
        db.execute("INSERT INTO tenants (slug, name, crm_provider) "
                   "VALUES (%s, %s, 'mock')", ("t_asks", "Asks Test"))
        row = db.query_one("SELECT * FROM tenants WHERE slug = %s", ("t_asks",))
    return row


def _clear(tenant):
    db.execute("DELETE FROM guest_requests WHERE tenant_id = %s", (tenant["id"],))
    db.execute("DELETE FROM presence_events WHERE tenant_id = %s", (tenant["id"],))


def _here(tenant, ref="anon-abc123", zone="fitting-room-3"):
    presence.record(tenant, guest_ref=ref, zone=zone, source="qr-plate")
    return ref


# --- the two load-bearing claims ---------------------------------------------
def test_a_request_needs_a_live_check_in(client, tenant):
    """The only thing between an open route and anybody putting a line on an
    associate's glasses from anywhere in the world."""
    _clear(tenant)
    r = client.post("/api/ingest/request", headers=KEY, json={
        "tenant": "t_asks", "guest_ref": "anon-nobody", "need": "size"})
    assert r.status_code == 409
    assert "check in" in r.json()["detail"].lower()


def test_a_request_needs_no_identity(client, tenant):
    """An anonymous reference is a pointer to nothing, and it is enough.

    The zone is the address. This is the case that makes a plate work for a
    shop with no app, no account and no CRM.
    """
    _clear(tenant)
    ref = _here(tenant, "anon-nobodyknows")
    assert presence.is_anonymous(ref)

    r = client.post("/api/ingest/request", headers=KEY, json={
        "tenant": "t_asks", "guest_ref": ref, "need": "size",
        "product": "High Rise Barrel Jeans", "size": "32x30"})
    assert r.status_code == 201, r.text
    assert r.json()["zone"] == "fitting-room-3"


# --- what reaches the glass ---------------------------------------------------
def test_the_size_leads_the_line():
    """Not a style choice. The row truncates on a 21-character display, and a
    clipped product name still names the jean while a clipped size is a wrong
    answer read out loud to a customer."""
    line = guest_requests.glass_line(
        need="size", product="MID RISE VINTAGE SLIM+", size="32x30", note=None)
    assert line.startswith("32x30")


def test_a_request_with_nothing_typed_still_says_something():
    """Somebody taps one chip and hits send. There must still be a sentence an
    associate can act on, or the vocabulary was pointless."""
    line = guest_requests.glass_line(need="checkout", product=None, size=None,
                                     note=None)
    assert line == "Ready to pay"


def test_an_unknown_need_is_refused(client, tenant):
    """The vocabulary is fixed. A caller inventing a need would put an
    unrenderable string on a display with no error path."""
    _clear(tenant)
    ref = _here(tenant)
    r = client.post("/api/ingest/request", headers=KEY, json={
        "tenant": "t_asks", "guest_ref": ref, "need": "shout"})
    assert r.status_code == 400
    assert "Unknown need" in r.json()["detail"]


def test_the_zone_comes_from_the_plate_not_the_form(client, tenant):
    """A page posts whatever was in its URL when it loaded. The check-in is
    the thing that actually happened."""
    _clear(tenant)
    ref = _here(tenant, "anon-wanderer", zone="fitting-room-3")
    r = client.post("/api/ingest/request", headers=KEY, json={
        "tenant": "t_asks", "guest_ref": ref, "need": "size",
        "zone": "the-vault"})
    assert r.json()["zone"] == "fitting-room-3"


# --- two associates, one jean -------------------------------------------------
def test_only_one_associate_can_claim_it(client, tenant):
    """Both press at the same moment. One walks; the other is told."""
    _clear(tenant)
    ref = _here(tenant)
    rid = client.post("/api/ingest/request", headers=KEY, json={
        "tenant": "t_asks", "guest_ref": ref, "need": "size"}).json()["request_id"]

    first = client.post("/api/ingest/request/claim", headers=KEY,
                        json={"tenant": "t_asks", "request_id": rid})
    second = client.post("/api/ingest/request/claim", headers=KEY,
                         json={"tenant": "t_asks", "request_id": rid})
    assert first.status_code == 200 and first.json()["status"] == "claimed"
    assert second.status_code == 409


def test_leaving_takes_it_off_the_floor(client, tenant):
    """A guest who taps Stop has stopped waiting. A request that outlives them
    sends somebody to an empty fitting room holding a jean."""
    _clear(tenant)
    ref = _here(tenant)
    client.post("/api/ingest/request", headers=KEY, json={
        "tenant": "t_asks", "guest_ref": ref, "need": "size"})

    dropped = client.post("/api/ingest/request/cancel", headers=KEY,
                          json={"tenant": "t_asks", "guest_ref": ref})
    assert dropped.json()["cancelled"] == 1
    assert guest_requests.open_for_zone(tenant["id"]) == []


def test_the_floor_list_is_oldest_first(tenant):
    """Somebody who has been waiting longest is the most urgent row in the
    building, and a list that puts the newest first inverts exactly that."""
    _clear(tenant)
    for i in range(3):
        ref = _here(tenant, f"anon-q{i}")
        guest_requests.open_request(tenant, guest_ref=ref, need="size",
                                    size=f"S{i}")
        db.execute("UPDATE guest_requests SET created_at = now() - "
                   "make_interval(mins => %s) WHERE guest_ref = %s",
                   (10 - i, ref))
    sizes = [r["size"] for r in guest_requests.open_for_zone(tenant["id"])]
    assert sizes == ["S0", "S1", "S2"], sizes


# --- what a guest is allowed to see -------------------------------------------
def test_the_catalogue_never_carries_unit_counts():
    """The route that serves this is open, so anything in it is public. "Three
    left in a 32" is a sentence about a retailer's business, and a page that
    answered it would be a live stock feed anyone could poll from the car park.
    """
    floor = catalogue.public_floor("gap")
    blob = repr(floor)
    assert floor["products"], "the mock floor should not be empty"
    for p in floor["products"]:
        assert "stock" not in p, p
        for s in p.get("sizes") or []:
            assert set(s) == {"size", "available"}, s
    assert "'stock'" not in blob


def test_out_of_stock_sizes_are_still_offered():
    """Hiding a size reads as "that size does not exist", so a guest asks for
    the wrong thing or gives up — and the floor routinely holds stock the
    system has not caught up with."""
    floor = catalogue.public_floor("gap")
    jeans = next(p for p in floor["products"] if "Barrel" in p["name"])
    by = {s["size"]: s["available"] for s in jeans["sizes"]}
    assert by["34x32"] is False          # zero in the mock floor
    assert by["32x30"] is True


def test_sizes_come_back_in_an_order_a_human_expects():
    assert [s for s in sorted(["L", "XS", "M", "XL", "S"], key=catalogue.size_key)] \
        == ["XS", "S", "M", "L", "XL"]
    assert sorted(["34x32", "28x30", "32x30", "32x32"], key=catalogue.size_key) \
        == ["28x30", "32x30", "32x32", "34x32"]


# --- retention ----------------------------------------------------------------
def test_retention_takes_the_words_and_leaves_the_demand(tenant):
    """The line this whole system draws, applied to the one thing a customer
    authors: their own words go, and what was asked for stays.

    "Which sizes do people want in fitting rooms" is a question about a shop.
    """
    _clear(tenant)
    ref = _here(tenant, "anon-oldtimer")
    guest_requests.open_request(tenant, guest_ref=ref, need="size",
                                sku="GAP-DNM-0498", product="High Rise Barrel Jeans",
                                size="32x30", note="the dark wash, my name is Sam")
    db.execute("UPDATE guest_requests SET created_at = now() - interval '400 days' "
               "WHERE tenant_id = %s", (tenant["id"],))

    retention.sweep(dict(tenant) | {"privacy": {"retention_days": 30}})

    row = db.query_one("SELECT * FROM guest_requests WHERE tenant_id = %s",
                       (tenant["id"],))
    assert row["note"] is None
    assert row["guest_ref"] == ""
    # And the half that survives.
    assert row["size"] == "32x30"
    assert row["sku"] == "GAP-DNM-0498"
    assert row["need"] == "size"


def test_sweeping_twice_changes_nothing(tenant):
    """Idempotence is what makes the sweep safe on a timer. `guest_ref` is NOT
    NULL, so it redacts to '' — and a predicate written against NULL would
    match every swept row forever and never report zero."""
    _clear(tenant)
    ref = _here(tenant, "anon-twice")
    guest_requests.open_request(tenant, guest_ref=ref, need="size")
    db.execute("UPDATE guest_requests SET created_at = now() - interval '400 days' "
               "WHERE tenant_id = %s", (tenant["id"],))

    small = dict(tenant) | {"privacy": {"retention_days": 30}}
    first = retention.sweep(small)["requests_redacted"]
    second = retention.sweep(small)["requests_redacted"]
    assert first == 1
    assert second == 0


# --- the deep-link fork -------------------------------------------------------
def test_a_store_with_no_app_gets_the_web_page(client, tenant):
    r = client.get("/api/guest/config?tenant=t_asks", headers=KEY)
    assert r.status_code == 200
    assert r.json()["mode"] == "web"
    assert r.json()["needs"]["size"]


def test_a_store_with_an_app_hands_off_to_it(client, tenant):
    """Gap's case. Only gap.com can open Gap's app, so the plate prints our URL
    and this field decides where the guest goes — which is why Gap shipping
    their route costs one config value and not a reprint of every plate."""
    db.execute("UPDATE tenants SET config = %s WHERE id = %s",
               ('{"checkin": {"mode": "app", '
                '"app_link": "https://www.gap.com/here?z={z}", '
                '"app_name": "the Gap app"}}', tenant["id"]))
    try:
        body = client.get("/api/guest/config?tenant=t_asks", headers=KEY).json()
        assert body["mode"] == "app"
        assert body["app_link"].startswith("https://www.gap.com/")
        assert body["app_name"] == "the Gap app"
    finally:
        db.execute("UPDATE tenants SET config = '{}'::jsonb WHERE id = %s",
                   (tenant["id"],))


def test_an_app_mode_with_nowhere_to_send_anyone_falls_back(client, tenant):
    """Misconfiguration must not strand a guest on a blank interstitial. Our
    page works; the mistake shows up as a flag rather than as a dead end."""
    db.execute("UPDATE tenants SET config = %s WHERE id = %s",
               ('{"checkin": {"mode": "app"}}', tenant["id"]))
    try:
        body = client.get("/api/guest/config?tenant=t_asks", headers=KEY).json()
        assert body["mode"] == "web"
        assert body["fell_back"] is True
    finally:
        db.execute("UPDATE tenants SET config = '{}'::jsonb WHERE id = %s",
                   (tenant["id"],))


def test_the_guest_surface_is_not_reachable_without_the_service_key(client):
    """A browser reaches these through the realtime server, which holds the
    key. Nothing in a browser ever holds it."""
    for path in ("/api/guest/config?tenant=t_asks",
                 "/api/guest/catalogue?tenant=t_asks"):
        assert client.get(path).status_code in (401, 403), path
    assert client.post("/api/ingest/request", json={
        "tenant": "t_asks", "guest_ref": "anon-x"}).status_code in (401, 403)
