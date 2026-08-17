"""Connections — what a store is plugged into, and the honesty rule.

The read is simple. The tests are almost entirely about one property:

  **The panel cannot claim a connector exists by asserting that it does.**

`connections._state_of` reads `crm_credentials.PROVIDERS` — the tuple that
actually gates whether an adapter can be built — rather than trusting the
`state` a registry entry declared. So a future contributor adding a hopeful
`"state": "available"` to a Salesforce entry does not thereby ship a Connect
button for a thing that would 503.

The second property is the fleet one: "none set up" and "set up and silent"
must not collapse into the same answer, because only one of them is a fault.

Requires Postgres at CUE_TEST_DATABASE_URL (falls back to CUE_DATABASE_URL).
"""
from __future__ import annotations

import os

import pytest

DB_URL = os.environ.get("CUE_TEST_DATABASE_URL") or os.environ.get("CUE_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB_URL, reason="no database configured")

if DB_URL:
    os.environ["CUE_DATABASE_URL"] = DB_URL

PW = "correct-horse-battery"


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

    db.execute("DELETE FROM devices WHERE tenant_id IN "
               "(SELECT id FROM tenants WHERE slug IN ('c_alpha', 'c_beta'))")
    db.execute("DELETE FROM users WHERE email LIKE '%%@conn.example.com'")
    db.execute("DELETE FROM tenants WHERE slug IN ('c_alpha', 'c_beta')")

    alpha = db.query_one(
        "INSERT INTO tenants (slug, name) VALUES ('c_alpha', 'Alpha') RETURNING *")
    beta = db.query_one(
        "INSERT INTO tenants (slug, name) VALUES ('c_beta', 'Beta') RETURNING *")

    users = {
        "admin": identity.create_user(email="admin@conn.example.com", name="Admin",
                                      role="client_admin", tenant_id=alpha["id"], password=PW),
        "mgr": identity.create_user(email="mgr@conn.example.com", name="Manager",
                                    role="manager", tenant_id=alpha["id"], password=PW),
        "assoc": identity.create_user(email="assoc@conn.example.com", name="Associate",
                                      role="associate", tenant_id=alpha["id"], password=PW),
        "b_admin": identity.create_user(email="b@conn.example.com", name="B Admin",
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


def read(client, auth, slug="c_alpha", who="mgr@conn.example.com"):
    r = client.get(f"/api/admin/tenants/{slug}/connections", headers=auth(who))
    assert r.status_code == 200, r.text
    return r.json()


# --- the honesty rule ---------------------------------------------------------

def test_only_a_real_adapter_can_be_available(client, auth):
    """The property this module exists for.

    `available` means "connect it from this screen today". It is derived from
    `crm_credentials.PROVIDERS`, so the registry cannot hand out a Connect
    button for something that would 503.
    """
    from app import crm_credentials

    body = read(client, auth)
    for s in body["systems"]:
        if s["state"] == "available":
            assert s["id"] in crm_credentials.PROVIDERS, s


def test_a_hopeful_registry_entry_cannot_promote_itself(client, auth, monkeypatch):
    """The regression that would otherwise ship silently.

    Somebody adds `"state": "available"` to the Salesforce entry — an easy,
    well-meaning edit that reads as documentation. Without `_state_of` reading
    the adapter tuple, Console renders a Connect button for a backend with no
    adapter behind it, and a merchant finds out during a pilot.
    """
    from app import connections

    hopeful = tuple(
        {**s, "state": "available"} if s["id"] == "salesforce" else s
        for s in connections.SYSTEMS
    )
    monkeypatch.setattr(connections, "SYSTEMS", hopeful)

    body = read(client, auth)
    sf = next(s for s in body["systems"] if s["id"] == "salesforce")
    assert sf["state"] != "available", "a declaration is not an adapter"
    assert sf["state"] in ("planned", "exploring"), sf


def test_unbuilt_connectors_are_listed_rather_than_hidden(client, auth):
    """Hiding them would be honest and useless.

    A merchant asking "do you do Salesforce" deserves the real answer, which is
    "not yet, and here is exactly what it would take" — not silence that reads
    as never.
    """
    body = read(client, auth)
    ids = {s["id"] for s in body["systems"]}
    assert {"salesforce", "feed", "shopify-pos"} <= ids
    for s in body["systems"]:
        assert s.get("note"), f"{s['id']} says nothing about itself"
        assert s.get("gives"), f"{s['id']} does not say what it would give you"


def test_every_state_is_from_the_fixed_vocabulary(client, auth):
    from app import connections

    body = read(client, auth)
    for s in body["systems"]:
        assert s["state"] in connections.STATES, s


# --- the fleet half -----------------------------------------------------------

def test_silent_is_not_the_same_as_absent(client, auth, world):
    """Only one of these is a fault, and a panel that flattens them tells a
    manager their floor is fine when nobody on it is answering."""
    from app import db

    tid = world["alpha"]["id"]
    db.execute(
        "INSERT INTO devices (tenant_id, surface, label, last_seen_at) "
        "VALUES (%s, 'phone', 'Till 2', now() - interval '6 hours')", (tid,))

    body = read(client, auth)
    phone = next(p for p in body["peripherals"] if p["id"] == "phone")
    mrbd = next(p for p in body["peripherals"] if p["id"] == "mrbd")

    assert phone["devices"] == 1 and phone["active"] == 0, phone
    assert phone["last_seen"] is not None, "silent, but it has been here"
    assert mrbd["devices"] == 0 and mrbd["last_seen"] is None, mrbd


def test_a_live_device_counts_as_answering(client, auth, world):
    from app import db

    db.execute(
        "INSERT INTO devices (tenant_id, surface, label, last_seen_at) "
        "VALUES (%s, 'even-g2', 'Pair 1', now())", (world["alpha"]["id"],))

    body = read(client, auth)
    g2 = next(p for p in body["peripherals"] if p["id"] == "even-g2")
    assert g2["active"] == 1, g2
    assert body["summary"]["answering"] >= 1


def test_a_revoked_device_is_not_counted_as_set_up(client, auth, world):
    """A revoked pair still in somebody's bag is not fleet capacity, and a
    count that includes it overstates what the shop can actually do."""
    from app import db

    db.execute(
        "INSERT INTO devices (tenant_id, surface, label, revoked_at) "
        "VALUES (%s, 'even-g2', 'Lost pair', now())", (world["alpha"]["id"],))

    body = read(client, auth)
    g2 = next(p for p in body["peripherals"] if p["id"] == "even-g2")
    assert g2["revoked"] == 1, g2
    assert g2["devices"] == 1, "the revoked one is reported, not counted"


def test_the_phone_row_repeats_the_byod_rule(client, auth):
    """Said wherever an admin might be about to get it wrong.

    A rule that lives only in a design doc is a rule that is broken by the
    person who never read it — and the person about to set up a device is
    exactly that person.
    """
    body = read(client, auth)
    phone = next(p for p in body["peripherals"] if p["id"] == "phone")
    assert "own phone is not one of these" in phone["note"]


# --- who may read it ----------------------------------------------------------

def test_a_manager_may_read_it(client, auth):
    r = client.get("/api/admin/tenants/c_alpha/connections",
                   headers=auth("mgr@conn.example.com"))
    assert r.status_code == 200, "whether the shop is answering is a shift question"


def test_an_associate_may_not(client, auth):
    r = client.get("/api/admin/tenants/c_alpha/connections",
                   headers=auth("assoc@conn.example.com"))
    assert r.status_code == 403


def test_another_retailers_admin_may_not(client, auth):
    r = client.get("/api/admin/tenants/c_alpha/connections",
                   headers=auth("b@conn.example.com"))
    assert r.status_code == 403


def test_no_secret_crosses_the_boundary(client, auth):
    """Belt and braces on top of `crm_credentials.describe()`.

    Asserted against the serialised response rather than the fields, because
    the failure mode is a future change spreading a credential row into the
    payload and nobody noticing which key carried it.
    """
    r = client.get("/api/admin/tenants/c_alpha/connections",
                   headers=auth("admin@conn.example.com"))
    text = r.text.lower()
    for forbidden in ("admin_token", "client_secret", "secret", "ciphertext", "shpat_"):
        assert forbidden not in text, forbidden
