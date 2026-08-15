"""Front doors.

    CUE_TEST_DATABASE_URL=... python -m pytest tests/test_presence.py -q

The load-bearing assertion in this file is that **consent comes from the door,
not from the request.** If a caller could name its own consent level, the
weakest front door in the system could claim the strongest provenance and the
column would stop being evidence of anything — which is the one thing it
exists to be.
"""
from __future__ import annotations

import os

import pytest

DB_URL = (os.environ.get("CUE_TEST_DATABASE_URL")
          or os.environ.get("CUE_DATABASE_URL"))
if DB_URL:
    os.environ["CUE_DATABASE_URL"] = DB_URL

from fastapi.testclient import TestClient  # noqa: E402

from app import db, presence  # noqa: E402
from app.main import app  # noqa: E402

pytestmark = pytest.mark.skipif(not DB_URL, reason="needs a database")

KEY = {"x-gapvision-key": os.environ.get("GAPVISION_API_KEY", "")}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def tenant(client):
    row = db.query_one("SELECT * FROM tenants WHERE slug = %s", ("t_doors",))
    if row is None:
        db.execute("INSERT INTO tenants (slug, name, crm_provider) "
                   "VALUES (%s, %s, 'mock')", ("t_doors", "Doors Test"))
        row = db.query_one("SELECT * FROM tenants WHERE slug = %s", ("t_doors",))
    return row


def _clear(tenant):
    db.execute("DELETE FROM presence_events WHERE tenant_id = %s", (tenant["id"],))


def test_consent_is_a_property_of_the_door(tenant):
    """The whole reason `consent` is worth storing."""
    _clear(tenant)
    plate = presence.record(tenant, guest_ref="g1", zone="fitting-room-3",
                            source="nfc-plate")
    asked = presence.record(tenant, guest_ref="g2", zone="Floor",
                            source="associate-assisted")
    app_ = presence.record(tenant, guest_ref="g3", zone="Floor",
                           source="app-beacon")

    assert plate["consent"] == "deliberate"
    assert asked["consent"] == "assisted"
    assert app_["consent"] == "device"


def test_a_caller_cannot_choose_its_own_consent_level(client, tenant):
    """An associate-assisted check-in must not be able to arrive claiming the
    provenance of a guest tapping their own phone."""
    _clear(tenant)
    r = client.post("/api/ingest/presence", headers=KEY, json={
        "tenant": "t_doors", "guest_ref": "g-spoof", "zone": "Floor",
        "source": "associate-assisted",
        # The field a caller might hope is honoured.
        "consent": "device",
    })
    assert r.status_code == 201
    assert r.json()["consent"] == "assisted"

    row = db.query_one("SELECT consent FROM presence_events "
                       "WHERE tenant_id = %s AND guest_ref = %s",
                       (tenant["id"], "g-spoof"))
    assert row["consent"] == "assisted"


def test_an_unknown_door_is_refused(client):
    """A typo in a plate's URL must not create a new consent category by
    silently inserting whatever it said."""
    r = client.post("/api/ingest/presence", headers=KEY, json={
        "tenant": "t_doors", "guest_ref": "g4", "source": "nfc_plate",
    })
    assert r.status_code == 400
    assert "Unknown presence source" in r.json()["detail"]


def test_the_zone_comes_from_the_door(tenant):
    """Each plate names where it is mounted, which is what lets this work with
    no beacons, no calibration and no fixture power."""
    _clear(tenant)
    presence.record(tenant, guest_ref="g5", zone="fitting-room-3", source="nfc-plate")
    live = presence.is_present(tenant, "g5")
    assert live["zone"] == "fitting-room-3"


def test_tapping_twice_is_one_arrival(tenant):
    """Somebody unsure it worked taps again; a phone re-reads the tag as it is
    lifted away. Neither is a second visit."""
    _clear(tenant)
    first = presence.record(tenant, guest_ref="g6", zone="Floor", source="nfc-plate")
    second = presence.record(tenant, guest_ref="g6", zone="Floor", source="nfc-plate")
    assert first["deduped"] is False
    assert second["deduped"] is True
    n = db.query_one("SELECT count(*) AS n FROM presence_events "
                     "WHERE tenant_id = %s AND guest_ref = %s",
                     (tenant["id"], "g6"))["n"]
    assert n == 1


def test_a_different_door_is_a_different_arrival(tenant):
    """Debounce is per door. Someone who taps a plate and then gets asked by an
    associate has genuinely come through twice, and both are worth knowing."""
    _clear(tenant)
    presence.record(tenant, guest_ref="g7", zone="Floor", source="nfc-plate")
    second = presence.record(tenant, guest_ref="g7", zone="Floor",
                             source="associate-assisted")
    assert second["deduped"] is False


def test_presence_expires_on_its_own(tenant):
    """`exit` is best-effort from every door, so a guest who simply walks out
    has to stop being present anyway."""
    _clear(tenant)
    presence.record(tenant, guest_ref="g8", zone="Floor", source="qr-plate")
    assert presence.is_present(tenant, "g8") is not None
    db.execute("UPDATE presence_events SET expires_at = now() - interval '1 minute' "
               "WHERE tenant_id = %s AND guest_ref = %s", (tenant["id"], "g8"))
    assert presence.is_present(tenant, "g8") is None


def test_revoking_closes_every_door_not_just_the_one_they_came_through(client, tenant):
    """Somebody who taps "stop" means stop."""
    _clear(tenant)
    presence.record(tenant, guest_ref="g9", zone="Floor", source="nfc-plate")
    presence.record(tenant, guest_ref="g9", zone="Floor", source="app-beacon")
    assert presence.is_present(tenant, "g9") is not None

    r = client.post("/api/ingest/presence/revoke", headers=KEY,
                    json={"tenant": "t_doors", "guest_ref": "g9"})
    assert r.status_code == 200
    assert r.json()["closed"] == 2
    assert presence.is_present(tenant, "g9") is None


def test_presence_is_not_reachable_without_the_service_key(client):
    """A browser must never be able to post presence directly — it would be an
    open door for asserting that anybody is anywhere."""
    r = client.post("/api/ingest/presence", json={
        "tenant": "t_doors", "guest_ref": "g10", "source": "qr-plate"})
    assert r.status_code in (401, 403)


def test_the_doors_report_counts_and_never_names(client, tenant):
    """It answers "where do the next hundred plates go", which needs counts —
    and never "who came through which door", which does not."""
    _clear(tenant)
    for i in range(3):
        presence.record(tenant, guest_ref=f"gd{i}", zone="fitting-room-1",
                        source="nfc-plate")
    presence.record(tenant, guest_ref="gq", zone="Floor", source="qr-plate")

    rows = presence.door_counts(tenant["id"])
    by = {r["source"]: r for r in rows}
    assert by["nfc-plate"]["events"] == 3
    assert by["nfc-plate"]["guests"] == 3
    assert by["qr-plate"]["events"] == 1
    assert not any("guest_ref" in r for r in rows), rows


def test_the_public_doors_are_doors_this_service_knows():
    """The realtime server keeps its own short list of the sources a *browser*
    may claim, because that route is open to the internet and the consent class
    follows the source. Two files, one fact — so the fact gets checked.

    Renaming a source here and not there is silent: every plate in the estate
    would 400 at the edge, and the only symptom is guests reporting that
    tapping does nothing.
    """
    import pathlib
    import re

    js = (pathlib.Path(__file__).resolve().parents[2]
          / "server/src/index.js").read_text()
    listed = re.search(r"const PUBLIC_SOURCES = new Set\(\[(.*?)\]\)", js, re.S)
    assert listed, "PUBLIC_SOURCES has moved or been removed"
    public = set(re.findall(r'"([^"]+)"', listed.group(1)))
    assert public == {"nfc-plate", "qr-plate"}, public
    assert public <= set(presence.SOURCES), public - set(presence.SOURCES)
    for src in public:
        assert presence.SOURCES[src]["consent"] == "deliberate", src


def test_no_path_through_the_shop_can_be_reconstructed(tenant):
    """Presence is a moment at a place. The table deliberately cannot answer
    "where did this person walk", and this asserts the shape rather than
    trusting a comment to hold the line."""
    cols = {r["column_name"] for r in db.query(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'presence_events'")}
    for forbidden in ("path", "dwell_seconds", "previous_zone", "sequence"):
        assert forbidden not in cols
