"""The deck as configuration — whose order it is, and what a data widget shows.

Two properties, and the second is the one Kyle asked for:

  1. **The order belongs to the person, not the handset.** Somebody picking up
     a different pair of glasses gets their own deck. That is the case
     auto-pairing already assumes will happen, and the localStorage version
     got it wrong.

  2. **A read-only widget is data, not a release.** Adding PROMOS to a store
     is a row. Adding a *new* feed-backed widget is an id in `FEED_WIDGETS`
     plus a catalogue entry in the package — no migration, and for an existing
     one, no new `.ehpk` for every pair in the field.

The tests that matter most are the boundary ones. `widget_prefs` arrives from
a phone and is read by a renderer, so an id the lens cannot resolve is a hole
in somebody's deck, and a validity window computed on a client would drift
with a clock somebody set by hand.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import pytest

DB_URL = os.environ.get("CUE_TEST_DATABASE_URL") or os.environ.get("CUE_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB_URL, reason="no database configured")

if DB_URL:
    os.environ["CUE_DATABASE_URL"] = DB_URL

PW = "correct-horse-battery"
KEY = {"x-gapvision-key": os.environ.get("GAPVISION_API_KEY", "test-key-" + "0" * 32)}
NOW = datetime.now(timezone.utc)


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient
    from app import db
    from app.main import app

    db.migrate(verbose=False)
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module", autouse=True)
def world(client):
    from app import db, identity

    db.execute("DELETE FROM tenant_feeds WHERE tenant_id IN "
               "(SELECT id FROM tenants WHERE slug IN ('w_alpha', 'w_beta'))")
    db.execute("DELETE FROM users WHERE email LIKE '%%@wid.example.com'")
    db.execute("DELETE FROM tenants WHERE slug IN ('w_alpha', 'w_beta')")

    alpha = db.query_one(
        "INSERT INTO tenants (slug, name) VALUES ('w_alpha', 'Alpha') RETURNING *")
    beta = db.query_one(
        "INSERT INTO tenants (slug, name) VALUES ('w_beta', 'Beta') RETURNING *")
    users = {
        "admin": identity.create_user(email="admin@wid.example.com", name="Admin",
                                      role="client_admin", tenant_id=alpha["id"], password=PW),
        "mgr": identity.create_user(email="mgr@wid.example.com", name="Manager",
                                    role="manager", tenant_id=alpha["id"], password=PW),
        "sam": identity.create_user(email="sam@wid.example.com", name="Sam",
                                    role="associate", tenant_id=alpha["id"], password=PW),
        "bea": identity.create_user(email="bea@wid.example.com", name="Bea",
                                    role="associate", tenant_id=alpha["id"], password=PW),
        "b_admin": identity.create_user(email="b@wid.example.com", name="B Admin",
                                        role="client_admin", tenant_id=beta["id"], password=PW),
    }
    return {"alpha": alpha, "beta": beta, "users": users}


@pytest.fixture
def auth(client):
    def _auth(email):
        r = client.post("/auth/login", json={"email": email, "password": PW})
        assert r.status_code == 200, r.text
        return {"authorization": f"Bearer {r.json()['token']}"}
    return _auth


# --- the order belongs to the person -----------------------------------------

def test_a_deck_is_stored_against_the_person(world):
    from app import widgets

    sam, bea = world["users"]["sam"]["id"], world["users"]["bea"]["id"]
    widgets.save_prefs(sam, {"order": ["messaging", "customer"]})
    widgets.save_prefs(bea, {"order": ["inventory"]})

    assert widgets.prefs_for(sam)["order"] == ["messaging", "customer"]
    assert widgets.prefs_for(bea)["order"] == ["inventory"], \
        "two associates on the same fleet must not share a layout"


def test_someone_who_has_never_arranged_a_deck_has_no_document(world):
    """Absent, not empty. An empty order means "I turned everything off" — a
    real choice the design says leaves the cue — and the package's own default
    is the answer for somebody who never opened the screen."""
    from app import widgets

    assert widgets.prefs_for(world["users"]["admin"]["id"]) == {}


def test_an_unknown_widget_is_dropped_without_losing_the_rest(world):
    """A package a version ahead sends an id this deployment has never heard
    of. Refusing the document would discard the preferences that *are* valid,
    over a name we simply do not have yet."""
    from app import widgets

    sam = world["users"]["sam"]["id"]
    saved = widgets.save_prefs(sam, {"order": ["customer", "teleporter", "messaging"]})
    assert saved["order"] == ["customer", "messaging"]


def test_a_repeated_widget_collapses(world):
    """A duplicate renders the same widget twice — a deck with two FLOOR cards
    and a hole where somebody expected something else."""
    from app import widgets

    sam = world["users"]["sam"]["id"]
    assert widgets.save_prefs(sam, {"order": ["customer", "customer", "messaging"]})["order"] \
        == ["customer", "messaging"]


def test_garbage_resolves_to_an_empty_order_rather_than_an_exception(world):
    from app import widgets

    sam = world["users"]["sam"]["id"]
    for junk in ({"order": "customer"}, {"order": None}, {}, {"order": [1, 2, 3]}):
        assert widgets.save_prefs(sam, junk)["order"] == []


def test_on_and_off_is_presence_in_the_order_and_nothing_else(world):
    """One source of truth.

    `widgets.ts` encodes "this widget is on" as its presence in `order`. A
    second `enabled` map beside it would be two facts that disagree the first
    time a client wrote one and not the other.
    """
    from app import widgets

    sam = world["users"]["sam"]["id"]
    saved = widgets.save_prefs(sam, {"order": ["customer"], "enabled": {"messaging": True}})
    assert set(saved) == {"order"}, saved
    assert saved["order"] == ["customer"]


def test_the_device_door_carries_the_deck_of_whoever_holds_it(client, world):
    """Which is what makes it the person's rather than the handset's.

    It rides on the identity that determines it rather than a second fetch: a
    separate round trip would leave a window where the lens has registered but
    does not know what to draw, which renders as the deck rearranging itself a
    moment after somebody looked at it.
    """
    from app import devices, widgets

    sam = world["users"]["sam"]["id"]
    widgets.save_prefs(sam, {"order": ["promos", "customer"]})
    device, token = devices.create(world["alpha"]["id"], "w_alpha",
                                   surface="even-g2", label="Pair 1", user_id=sam)

    r = client.post("/api/auth/device", json={"token": token, "tenant": "w_alpha"},
                    headers=KEY)
    assert r.status_code == 200, r.text
    assert r.json()["widget_prefs"]["order"] == ["promos", "customer"]


def test_an_unassigned_device_carries_no_deck(client, world):
    """Absent rather than a default: there is no person whose deck this is."""
    from app import devices

    device, token = devices.create(world["alpha"]["id"], "w_alpha",
                                   surface="even-g2", label="Unassigned")
    r = client.post("/api/auth/device", json={"token": token, "tenant": "w_alpha"},
                    headers=KEY)
    assert "widget_prefs" not in r.json(), r.json()


# --- a data widget ------------------------------------------------------------

def test_a_promotion_is_a_row_not_a_release(client, auth, world):
    r = client.post("/api/admin/tenants/w_alpha/feeds",
                    json={"widget": "promos", "title": "Denim event",
                          "lines": ["20% OFF ALL DENIM", "THIS WEEKEND ONLY"]},
                    headers=auth("admin@wid.example.com"))
    assert r.status_code == 201, r.text
    assert r.json()["item"]["lines"] == ["20% OFF ALL DENIM", "THIS WEEKEND ONLY"]


def test_the_lens_sees_only_what_is_running_now(client, world):
    """The window is applied server-side, because a client computing "current"
    drifts with a phone clock somebody set by hand."""
    from app import widgets

    tid = world["alpha"]["id"]
    widgets.create(tid, widget="promos", title="Live", lines=["ON NOW"])
    widgets.create(tid, widget="promos", title="Over", lines=["ENDED"],
                   ends_at=NOW - timedelta(days=1))
    widgets.create(tid, widget="promos", title="Later", lines=["NOT YET"],
                   starts_at=NOW + timedelta(days=1))

    titles = [p["title"] for p in widgets.live(tid, "promos")]
    assert "Live" in titles
    assert "Over" not in titles and "Later" not in titles, titles


def test_the_authoring_view_shows_what_the_lens_does_not(client, auth, world):
    """An admin editing promotions needs the one that ended yesterday."""
    r = client.get("/api/admin/tenants/w_alpha/feeds/promos",
                   headers=auth("admin@wid.example.com"))
    assert r.status_code == 200, r.text
    titles = [i["title"] for i in r.json()["items"]]
    assert "Over" in titles, titles


def test_open_ended_promotions_are_a_real_state(world):
    """Null start means already running; null end means until we say otherwise.
    An end date invented to satisfy a NOT NULL vanishes on a day nobody chose."""
    from app import widgets

    live = widgets.live(world["alpha"]["id"], "promos")
    assert any(p["starts_at"] is None and p["ends_at"] is None for p in live)


def test_the_lens_endpoint_returns_every_feed_widget(client, world):
    r = client.get("/api/tenant/widgets?tenant=w_alpha", headers=KEY)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["known"] is True
    from app import widgets
    assert set(body["widgets"]) == set(widgets.FEED_WIDGETS)


def test_an_unknown_tenant_is_named_as_unknown(client):
    """Same rule as capabilities: unknown must never render as a valid empty
    answer, or a typo in a launch URL looks like a store with nothing running."""
    r = client.get("/api/tenant/widgets?tenant=not-a-store", headers=KEY)
    assert r.json()["known"] is False


def test_lines_are_bounded_because_the_glass_is(world):
    from app import widgets

    item = widgets.create(world["alpha"]["id"], widget="promos", title="Long",
                          lines=["x" * 200, "b", "c", "d", "e", "f"])
    assert len(item["lines"]) <= widgets.MAX_LINES
    assert all(len(line) <= widgets.MAX_LINE_CHARS for line in item["lines"])


def test_a_widget_that_is_code_cannot_be_fed_rows(client, auth):
    """`customer` is rendered from live engagement data. A row claiming to feed
    it would be content nothing ever draws — accepted, invisible, and reported
    to whoever typed it as success."""
    r = client.post("/api/admin/tenants/w_alpha/feeds",
                    json={"widget": "customer", "title": "Nope", "lines": ["x"]},
                    headers=auth("admin@wid.example.com"))
    assert r.status_code == 400
    assert "data-defined" in r.json()["detail"]


def test_writing_to_the_glass_is_an_admin_act(client, auth):
    """A manager may read the fleet; putting a sentence in front of every
    associate in the store is the same class of act as changing what the floor
    can do."""
    r = client.post("/api/admin/tenants/w_alpha/feeds",
                    json={"widget": "promos", "title": "From a manager", "lines": ["x"]},
                    headers=auth("mgr@wid.example.com"))
    assert r.status_code == 403


def test_another_retailers_admin_cannot_write_to_this_floor(client, auth):
    r = client.post("/api/admin/tenants/w_alpha/feeds",
                    json={"widget": "promos", "title": "Wrong shop", "lines": ["x"]},
                    headers=auth("b@wid.example.com"))
    assert r.status_code == 403


def test_deleting_is_scoped_by_tenant_as_well_as_id(client, auth, world):
    """An id alone is enough for the query and not enough for the rule."""
    from app import widgets

    item = widgets.create(world["beta"]["id"], widget="promos", title="Beta's", lines=["x"])
    r = client.delete(f"/api/admin/tenants/w_alpha/feeds/{item['id']}",
                      headers=auth("admin@wid.example.com"))
    assert r.status_code == 404, "alpha's admin must not reach beta's row"
    assert widgets.all_for(world["beta"]["id"], "promos"), "and it is still there"


def test_a_store_sees_only_its_own_promotions(client, world):
    from app import widgets

    alpha_titles = {p["title"] for p in widgets.live(world["alpha"]["id"], "promos")}
    beta_titles = {p["title"] for p in widgets.live(world["beta"]["id"], "promos")}
    assert "Beta's" in beta_titles
    assert "Beta's" not in alpha_titles


def test_the_prefs_door_needs_the_service_key(client, world):
    """A phone holds no session — the realtime server, which already holds the
    key, vouches for it. Same shape as the device door."""
    r = client.put("/api/tenant/widget-prefs",
                   json={"user_id": str(world["users"]["sam"]["id"]),
                         "prefs": {"order": ["customer"]}})
    assert r.status_code in (401, 403), r.text
