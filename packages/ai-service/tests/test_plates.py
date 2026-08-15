"""The token on the plate.

    CUE_TEST_DATABASE_URL=... python -m pytest tests/test_plates.py -q

Kyle: *"Both should be encrypted url so can't be shared."*

These tests are organised around the difference between what a token achieves
and what it cannot, because getting that boundary wrong in either direction is
expensive: overstate it and a leaked QR is treated as impossible rather than as
an errand; understate it and nobody bothers revoking anything.

  Achieved     nothing legible, nothing editable, per-door revocation, and a
               replayed rotating-tag URL refused.
  Not achieved unshareability of a printed code. It is a bearer credential on
               a wall, and the test at the bottom says so out loud so nobody
               has to rediscover it from an incident.
"""
from __future__ import annotations

import os

import pytest

DB_URL = (os.environ.get("CUE_TEST_DATABASE_URL")
          or os.environ.get("CUE_DATABASE_URL"))
if DB_URL:
    os.environ["CUE_DATABASE_URL"] = DB_URL

from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import db, plates  # noqa: E402
from app.main import app  # noqa: E402

pytestmark = pytest.mark.skipif(not DB_URL, reason="needs a database")

KEY = {"x-gapvision-key": os.environ.get("GAPVISION_API_KEY", "")}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def tenant(client):
    row = db.query_one("SELECT * FROM tenants WHERE slug = %s", ("t_plates",))
    if row is None:
        db.execute("INSERT INTO tenants (slug, name, crm_provider) "
                   "VALUES (%s, %s, 'mock')", ("t_plates", "Plates Test"))
        row = db.query_one("SELECT * FROM tenants WHERE slug = %s", ("t_plates",))
    return row


def _clear(tenant):
    db.execute("DELETE FROM plate_hits WHERE token IN "
               "(SELECT token FROM plates WHERE tenant_id = %s)", (tenant["id"],))
    db.execute("DELETE FROM plates WHERE tenant_id = %s", (tenant["id"],))


# --- what the token achieves --------------------------------------------------
def test_the_url_says_nothing_about_the_store(tenant):
    """The point of the change. A photograph of a plate used to be a readable
    map of a shop's zone naming, and an invitation to edit the room."""
    _clear(tenant)
    p = plates.mint(tenant, zone="fitting-room-3", source="nfc-plate")
    tok = p["token"]
    assert "fitting" not in tok.lower()
    assert "gap" not in tok.lower() and "t_plates" not in tok.lower()
    assert "nfc" not in tok.lower()
    assert len(tok) >= 12


def test_two_plates_in_the_same_room_get_different_tokens(tenant):
    """Random, not derived. A derived token leaks whatever it was derived from
    the moment somebody notices the pattern."""
    _clear(tenant)
    a = plates.mint(tenant, zone="fitting-room-3", source="nfc-plate")
    b = plates.mint(tenant, zone="fitting-room-3", source="qr-plate")
    assert a["token"] != b["token"]


def test_the_door_is_in_the_token_not_the_url(tenant):
    """A guest cannot claim to have tapped when they scanned, because `src` is
    no longer a field anybody sends."""
    _clear(tenant)
    tap = plates.mint(tenant, zone="fitting-room-3", source="nfc-plate")
    scan = plates.mint(tenant, zone="fitting-room-3", source="qr-plate")
    assert plates.resolve(tap["token"])["source"] == "nfc-plate"
    assert plates.resolve(scan["token"])["source"] == "qr-plate"


def test_a_token_resolves_to_its_place(tenant):
    _clear(tenant)
    tok = plates.mint(tenant, zone="fitting-room-9", source="qr-plate")["token"]
    place = plates.resolve(tok)
    assert place["zone"] == "fitting-room-9"
    assert place["tenant"] == "t_plates"


def test_a_made_up_token_is_refused(tenant):
    with pytest.raises(HTTPException) as e:
        plates.resolve("ZZZZZZZZZZZZ")
    assert e.value.status_code == 404


def test_revoking_one_door_leaves_the_other_working(tenant):
    """When a photograph of the QR ends up somewhere it should not, the tag six
    inches above it is still fine — and disabling it would cost a store its
    fitting room for no reason."""
    _clear(tenant)
    tap = plates.mint(tenant, zone="fitting-room-3", source="nfc-plate")["token"]
    scan = plates.mint(tenant, zone="fitting-room-3", source="qr-plate")["token"]

    plates.revoke(tenant, scan)
    with pytest.raises(HTTPException) as e:
        plates.resolve(scan)
    assert e.value.status_code == 404
    assert plates.resolve(tap)["zone"] == "fitting-room-3"


def test_a_revoked_token_is_indistinguishable_from_a_wrong_one(tenant):
    """Otherwise this is an oracle for which tokens exist: try one, read the
    difference in the answer, learn that you found a real plate."""
    _clear(tenant)
    tok = plates.mint(tenant, zone="fitting-room-3", source="qr-plate")["token"]
    plates.revoke(tenant, tok)

    with pytest.raises(HTTPException) as revoked:
        plates.resolve(tok)
    with pytest.raises(HTTPException) as unknown:
        plates.resolve("ZZZZZZZZZZZZ")
    assert revoked.value.status_code == unknown.value.status_code
    assert revoked.value.detail == unknown.value.detail


def test_reprinting_a_plate_puts_it_back_in_service(client, tenant):
    """Registration is idempotent, and re-registering un-revokes: the physical
    plate is the thing being described, and it has come back."""
    _clear(tenant)
    tok = plates.mint(tenant, zone="fitting-room-3", source="qr-plate")["token"]
    plates.revoke(tenant, tok)
    r = client.post("/api/ingest/plates", headers=KEY, json={
        "tenant": "t_plates",
        "plates": [{"token": tok, "zone": "fitting-room-3", "source": "qr-plate"}]})
    assert r.status_code == 201
    assert plates.resolve(tok)["zone"] == "fitting-room-3"


# --- rotating tags, which are the only real answer to sharing -----------------
def test_a_replayed_tap_is_refused(tenant):
    """The mechanism. A tag that appends a counter to every read makes a copied
    URL detectable: it carries a counter we have already seen, which is exactly
    what a shared link is."""
    _clear(tenant)
    tok = plates.mint(tenant, zone="fitting-room-3", source="nfc-plate")["token"]
    db.execute("UPDATE plates SET sun_key = NULL, sun_required = true, "
               "last_counter = NULL WHERE token = %s", (tok,))

    # Without a key the plate cannot verify anything, and must refuse rather
    # than wave a tap through — a plate configured to require a cryptogram it
    # cannot check is a misconfiguration, not a fallback.
    with pytest.raises(HTTPException) as no_key:
        plates.resolve(tok, counter="000005")
    assert no_key.value.status_code == 400

    db.execute("UPDATE plates SET sun_key = %s WHERE token = %s",
               (b"not-a-real-sealed-key", tok))
    db.execute("UPDATE plates SET last_counter = 5 WHERE token = %s", (tok,))

    with pytest.raises(HTTPException) as replay:
        plates.resolve(tok, counter="000005")     # the counter we already used
    assert replay.value.status_code == 403
    assert "already been used" in replay.value.detail


def test_a_fresh_tap_moves_the_counter_forward(tenant):
    _clear(tenant)
    tok = plates.mint(tenant, zone="fitting-room-3", source="nfc-plate")["token"]
    db.execute("UPDATE plates SET sun_key = %s, sun_required = true, "
               "last_counter = 5 WHERE token = %s", (b"key", tok))

    place = plates.resolve(tok, counter="00000A")     # 10 > 5
    assert place["zone"] == "fitting-room-3"
    row = db.query_one("SELECT last_counter FROM plates WHERE token = %s", (tok,))
    assert row["last_counter"] == 10


def test_an_ordinary_tag_is_unaffected(tenant):
    """Most plates will carry a cheap static tag for a long time. Requiring a
    cryptogram everywhere would disable every one of them."""
    _clear(tenant)
    tok = plates.mint(tenant, zone="fitting-room-3", source="nfc-plate")["token"]
    assert plates.resolve(tok)["zone"] == "fitting-room-3"


# --- noticing -----------------------------------------------------------------
def test_every_attempt_is_recorded_including_the_refusals(tenant):
    """A token being tried and refused is the most interesting thing this table
    can hold."""
    _clear(tenant)
    tok = plates.mint(tenant, zone="fitting-room-3", source="qr-plate")["token"]
    plates.resolve(tok)
    with pytest.raises(HTTPException):
        plates.resolve("ZZZZZZZZZZZZ")

    rows = db.query("SELECT token, ok, reason FROM plate_hits "
                    "WHERE token IN (%s, 'ZZZZZZZZZZZZ')", (tok,))
    assert any(r["ok"] for r in rows)
    assert any(r["reason"] == "unknown" for r in rows)


def test_the_hit_log_holds_no_people(tenant):
    """It exists to make a shared token visible, which needs counts. It does
    not need to know who tried, and a table that knew would be a different
    product with a different consent story."""
    cols = {r["column_name"] for r in db.query(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'plate_hits'")}
    for forbidden in ("guest_ref", "ip", "ip_address", "user_agent", "user_id"):
        assert forbidden not in cols


def test_a_token_used_harder_than_a_fitting_room_is_visible(tenant):
    """The QR cannot rotate, so the answer to a copied one is noticing it.
    A fitting room is busy on a Saturday; a fitting room is not busy at three
    in the morning."""
    _clear(tenant)
    tok = plates.mint(tenant, zone="fitting-room-3", source="qr-plate")["token"]
    for _ in range(plates.BUSY_HOUR + 1):
        db.execute("INSERT INTO plate_hits (token, ok) VALUES (%s, true)", (tok,))

    busy = plates.busy_plates(tenant["id"])
    assert [b["token"] for b in busy] == [tok]


def test_a_printed_code_is_still_a_bearer_credential(tenant):
    """Said out loud, in a test, because the whole point of the change invites
    the opposite conclusion.

    The token is opaque and revocable. It is *not* unshareable: anything
    printed can be photographed, and the photograph works until somebody
    revokes it. This test passes by asserting the uncomfortable half — a
    resolve does not care who is asking — so that the day it starts failing is
    the day somebody added real binding and this file should be rewritten.
    """
    _clear(tenant)
    tok = plates.mint(tenant, zone="fitting-room-3", source="qr-plate")["token"]
    first = plates.resolve(tok)
    stranger = plates.resolve(tok)          # same token, no context whatsoever
    assert first == stranger


# --- the guest surface --------------------------------------------------------
def test_the_page_gets_the_place_and_the_config_in_one_call(client, tenant):
    """A person is standing in a fitting room waiting for this, and every round
    trip is a visible pause on a shop's guest wifi."""
    _clear(tenant)
    tok = plates.mint(tenant, zone="fitting-room-3", source="nfc-plate")["token"]
    body = client.get(f"/api/guest/plate?token={tok}", headers=KEY).json()
    assert body["zone"] == "fitting-room-3"
    assert body["source"] == "nfc-plate"
    assert body["mode"] in ("web", "app")
    assert body["needs"]["size"]


def test_resolving_needs_the_service_key(client, tenant):
    _clear(tenant)
    tok = plates.mint(tenant, zone="fitting-room-3", source="qr-plate")["token"]
    assert client.get(f"/api/guest/plate?token={tok}").status_code in (401, 403)
