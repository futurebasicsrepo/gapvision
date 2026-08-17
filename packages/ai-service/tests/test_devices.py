"""Device provisioning — minting identities, and what they may not do.

The positive story is short: Console mints a device, gets a token once, and a
lens presenting that token at register is told which device it is. Everything
else here is a negative, and the negatives are the point:

* the token never comes back out — not from a list, not from a detail read,
  not from a second mint;
* a retailer's admin cannot mint into, list, reissue or revoke a neighbouring
  retailer's fleet;
* a revoked or retired device is refused, and every refusal looks identical, so
  a stolen token cannot be used to learn which shop it came from;
* the pre-provisioning device routes — which select `d.*` and predate the
  token hash living in that star — do not publish credentials.

Requires a Postgres at CUE_TEST_DATABASE_URL (falls back to CUE_DATABASE_URL).
Skipped entirely when neither is set.
"""
from __future__ import annotations

import os

import pytest

DB_URL = os.environ.get("CUE_TEST_DATABASE_URL") or os.environ.get("CUE_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB_URL, reason="no database configured")

if DB_URL:
    os.environ["CUE_DATABASE_URL"] = DB_URL

PW = "correct-horse-battery"


# --- fixtures ----------------------------------------------------------------

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
    """Two retailers with their own people. Two, because a cross-tenant leak
    reads as correct behaviour when there is only one store to return."""
    from app import db, identity

    db.execute("DELETE FROM devices WHERE tenant_id IN "
               "(SELECT id FROM tenants WHERE slug IN ('d_alpha', 'd_beta'))")
    db.execute("DELETE FROM users WHERE email LIKE '%%@dev.example.com'")
    db.execute("DELETE FROM tenants WHERE slug IN ('d_alpha', 'd_beta')")

    alpha = db.query_one(
        "INSERT INTO tenants (slug, name) VALUES ('d_alpha', 'Alpha') RETURNING *")
    beta = db.query_one(
        "INSERT INTO tenants (slug, name) VALUES ('d_beta', 'Beta') RETURNING *")

    users = {
        "cue": identity.create_user(email="cue@dev.example.com", name="Cue",
                                    role="cue_admin", tenant_id=None, password=PW),
        "a_admin": identity.create_user(email="a.admin@dev.example.com", name="A Admin",
                                        role="client_admin", tenant_id=alpha["id"],
                                        password=PW),
        "b_admin": identity.create_user(email="b.admin@dev.example.com", name="B Admin",
                                        role="client_admin", tenant_id=beta["id"],
                                        password=PW),
        "a_mgr": identity.create_user(email="a.mgr@dev.example.com", name="A Manager",
                                      role="manager", tenant_id=alpha["id"], password=PW),
        "a_assoc": identity.create_user(email="a.assoc@dev.example.com", name="A Associate",
                                        role="associate", tenant_id=alpha["id"],
                                        password=PW),
    }
    return {"alpha": alpha, "beta": beta, "users": users}


@pytest.fixture
def auth(client):
    def token_for(email: str) -> dict:
        r = client.post("/auth/login", json={"email": email, "password": PW})
        assert r.status_code == 200, r.text
        return {"authorization": f"Bearer {r.json()['token']}"}
    return token_for


@pytest.fixture
def mint(client, auth):
    """Mint a device as alpha's admin and hand back the whole response."""
    def _mint(slug="d_alpha", who="a.admin@dev.example.com", **body):
        body.setdefault("surface", "even-g2")
        r = client.post(f"/api/admin/tenants/{slug}/devices",
                        json=body, headers=auth(who))
        assert r.status_code == 201, r.text
        return r.json()
    return _mint


# --- minting -----------------------------------------------------------------

def test_mint_returns_a_token_and_a_launch_url(mint):
    out = mint(label="Denim Wall pair 1", serial="G2-0001")
    assert out["token"]
    assert out["device"]["surface"] == "even-g2"
    assert out["device"]["provisioned"] is True
    assert out["device"]["presence"] == "provisioned"   # minted, never seen
    assert out["token"] in out["launch_url"]
    assert "tenant=d_alpha" in out["launch_url"]


def test_the_token_is_never_stored_in_the_clear(mint):
    from app import db

    out = mint(label="Clear text check")
    row = db.query_one("SELECT * FROM devices WHERE id = %s", (out["device"]["id"],))
    assert row["provision_token_hash"] != out["token"]
    assert len(row["provision_token_hash"]) == 64          # sha256 hex
    assert out["token"] not in str(row)


def test_every_surface_mints_and_serial_free_ones_coexist(mint):
    """The Meta lens and the sim expose no serial. More than one of them in a
    tenant must not collide on the (tenant_id, serial) unique index."""
    a = mint(surface="mrbd", label="Meta pair")
    b = mint(surface="sim", label="Demo tab")
    c = mint(surface="sim", label="Second demo tab")
    assert a["device"]["serial"] is None and c["device"]["serial"] is None
    assert len({a["device"]["id"], b["device"]["id"], c["device"]["id"]}) == 3
    assert "lens-sim" in b["launch_url"]


def test_a_model_is_not_required_for_a_surface_that_has_none(mint):
    """011 drops NOT NULL on `model` so `surface` can own the question. A Meta
    device is not a g2, and a sim is not hardware."""
    out = mint(surface="mrbd", label="No model here")
    assert out["device"]["model"] is None


def test_an_unknown_surface_is_refused(client, auth):
    r = client.post("/api/admin/tenants/d_alpha/devices",
                    json={"surface": "hololens"}, headers=auth("a.admin@dev.example.com"))
    assert r.status_code == 400


def test_a_duplicate_serial_within_a_tenant_is_refused(client, auth, mint):
    mint(serial="G2-DUP", label="First")
    r = client.post("/api/admin/tenants/d_alpha/devices",
                    json={"surface": "even-g2", "serial": "G2-DUP"},
                    headers=auth("a.admin@dev.example.com"))
    assert r.status_code == 409


def test_a_device_cannot_be_assigned_to_another_tenants_person(client, auth, world):
    r = client.post(
        "/api/admin/tenants/d_alpha/devices",
        json={"surface": "even-g2", "user_id": str(world["users"]["b_admin"]["id"])},
        headers=auth("a.admin@dev.example.com"))
    assert r.status_code == 400


# --- who may mint ------------------------------------------------------------

def test_a_manager_may_see_the_fleet_but_not_mint(client, auth, mint):
    mint(label="Visible to managers")
    hdr = auth("a.mgr@dev.example.com")
    assert client.get("/api/admin/tenants/d_alpha/devices", headers=hdr).status_code == 200
    r = client.post("/api/admin/tenants/d_alpha/devices",
                    json={"surface": "even-g2"}, headers=hdr)
    assert r.status_code == 403


def test_an_associate_reaches_none_of_it(client, auth):
    hdr = auth("a.assoc@dev.example.com")
    assert client.get("/api/admin/tenants/d_alpha/devices", headers=hdr).status_code == 403
    assert client.post("/api/admin/tenants/d_alpha/devices",
                       json={"surface": "even-g2"}, headers=hdr).status_code == 403


def test_an_unauthenticated_caller_reaches_none_of_it(client):
    assert client.get("/api/admin/tenants/d_alpha/devices").status_code == 401
    assert client.post("/api/admin/tenants/d_alpha/devices",
                       json={"surface": "even-g2"}).status_code == 401


# --- tenant isolation --------------------------------------------------------

def test_one_retailer_cannot_mint_into_anothers_fleet(client, auth):
    r = client.post("/api/admin/tenants/d_beta/devices",
                    json={"surface": "even-g2", "label": "Not yours"},
                    headers=auth("a.admin@dev.example.com"))
    assert r.status_code == 403


def test_one_retailer_cannot_list_anothers_fleet(client, auth, mint):
    mint(slug="d_beta", who="b.admin@dev.example.com", label="Beta pair")
    r = client.get("/api/admin/tenants/d_beta/devices",
                   headers=auth("a.admin@dev.example.com"))
    assert r.status_code == 403


def test_a_neighbours_device_reads_as_absent_not_forbidden(client, auth, mint):
    """404, not 403. A device uuid is not something you guess your way to, and
    confirming one exists in a shop you cannot see is a fact worth withholding."""
    theirs = mint(slug="d_beta", who="b.admin@dev.example.com")["device"]
    hdr = auth("a.admin@dev.example.com")
    assert client.post(f"/api/admin/devices/{theirs['id']}/reissue",
                       headers=hdr).status_code == 404
    assert client.post(f"/api/admin/devices/{theirs['id']}/revoke",
                       headers=hdr).status_code == 404


def test_cue_staff_reach_any_tenant(client, auth):
    hdr = auth("cue@dev.example.com")
    assert client.get("/api/admin/tenants/d_beta/devices", headers=hdr).status_code == 200
    assert client.post("/api/admin/tenants/d_beta/devices",
                       json={"surface": "sim", "label": "Onboarding tab"},
                       headers=hdr).status_code == 201


# --- the token never comes back out -------------------------------------------

def test_no_response_body_ever_contains_a_hash(client, auth, mint):
    out = mint(label="Readback")
    hdr = auth("a.admin@dev.example.com")
    bodies = [
        client.get("/api/admin/tenants/d_alpha/devices", headers=hdr).text,
        client.get("/api/admin/devices?tenant=d_alpha", headers=hdr).text,
        client.patch(f"/api/admin/devices/{out['device']['id']}",
                     json={"label": "Renamed"}, headers=hdr).text,
        client.post(f"/api/admin/devices/{out['device']['id']}/revoke", headers=hdr).text,
    ]
    for body in bodies:
        assert "provision_token_hash" not in body
        assert out["token"] not in body


def test_the_legacy_hardware_route_does_not_publish_the_hash(client, auth):
    """POST /api/admin/devices predates provisioning and returns `RETURNING *`.
    Since 011 that star contains the token hash."""
    hdr = auth("a.admin@dev.example.com")
    r = client.post("/api/admin/devices",
                    json={"model": "g2", "serial": "G2-LEGACY", "tenant": "d_alpha"},
                    headers=hdr)
    assert r.status_code == 201, r.text
    assert "provision_token_hash" not in r.text
    # And a hardware row minted without a token reads as exactly that.
    assert r.json()["device"]["provisioned"] is False


# --- the register handshake ---------------------------------------------------

def test_a_minted_token_resolves_to_its_device(client, mint, api_key):
    out = mint(label="Registers fine", surface="mrbd")
    r = client.post("/api/auth/device",
                    json={"token": out["token"], "tenant": "d_alpha",
                          "meta": {"mode": "meta", "app_version": "0.2.0"}},
                    headers={"x-gapvision-key": api_key})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["device_id"] == out["device"]["id"]
    assert body["surface"] == "mrbd"
    assert body["tenant"] == "d_alpha"


def test_registering_stamps_last_seen_and_flips_presence(client, auth, mint, api_key):
    out = mint(label="Presence")
    client.post("/api/auth/device",
                json={"token": out["token"], "tenant": "d_alpha",
                      "meta": {"mode": "classic", "ua": "x" * 500}},
                headers={"x-gapvision-key": api_key})
    rows = client.get("/api/admin/tenants/d_alpha/devices",
                      headers=auth("a.admin@dev.example.com")).json()["devices"]
    row = next(d for d in rows if d["id"] == out["device"]["id"])
    assert row["presence"] == "active"
    assert row["last_seen_at"]
    # Whitelisted and bounded — this blob is written by whatever is on the far
    # end of a socket.
    assert row["last_seen_meta"]["mode"] == "classic"
    assert len(row["last_seen_meta"]["ua"]) == 200


def test_the_handshake_needs_the_service_key(client, mint):
    out = mint(label="No key")
    r = client.post("/api/auth/device", json={"token": out["token"], "tenant": "d_alpha"})
    assert r.status_code == 401


def test_unknown_revoked_and_cross_tenant_are_indistinguishable(client, auth, mint, api_key):
    """One body for every failure. Told apart, they would let somebody holding
    a stolen token work out which shop it came from."""
    key = {"x-gapvision-key": api_key}

    revoked = mint(label="Revoked")
    client.post(f"/api/admin/devices/{revoked['device']['id']}/revoke",
                headers=auth("a.admin@dev.example.com"))

    theirs = mint(slug="d_beta", who="b.admin@dev.example.com", label="Beta pair")

    attempts = [
        {"token": "nonsense-token", "tenant": "d_alpha"},
        {"token": revoked["token"], "tenant": "d_alpha"},
        {"token": theirs["token"], "tenant": "d_alpha"},   # right token, wrong shop
        {"token": "", "tenant": "d_alpha"},
    ]
    seen = set()
    for body in attempts:
        r = client.post("/api/auth/device", json=body, headers=key)
        assert r.status_code == 401, (body, r.text)
        seen.add(r.text)
    assert len(seen) == 1, seen


def test_a_retired_unit_stops_registering(client, auth, mint, api_key):
    out = mint(label="Retired")
    client.patch(f"/api/admin/devices/{out['device']['id']}",
                 json={"status": "retired"}, headers=auth("a.admin@dev.example.com"))
    r = client.post("/api/auth/device", json={"token": out["token"], "tenant": "d_alpha"},
                    headers={"x-gapvision-key": api_key})
    assert r.status_code == 401


def test_reissue_kills_the_old_token_immediately(client, auth, mint, api_key):
    out = mint(label="Reissued")
    key = {"x-gapvision-key": api_key}
    assert client.post("/api/auth/device",
                       json={"token": out["token"], "tenant": "d_alpha"},
                       headers=key).status_code == 200

    again = client.post(f"/api/admin/devices/{out['device']['id']}/reissue",
                        headers=auth("a.admin@dev.example.com")).json()
    assert again["token"] != out["token"]
    assert client.post("/api/auth/device",
                       json={"token": out["token"], "tenant": "d_alpha"},
                       headers=key).status_code == 401
    assert client.post("/api/auth/device",
                       json={"token": again["token"], "tenant": "d_alpha"},
                       headers=key).status_code == 200


def test_reissue_brings_a_revoked_device_back(client, auth, mint, api_key):
    """Revoke is not a tombstone. A pair that turns up in a drawer is reissued,
    not re-created, so its history and its assignment survive."""
    out = mint(label="Back from the drawer")
    hdr = auth("a.admin@dev.example.com")
    client.post(f"/api/admin/devices/{out['device']['id']}/revoke", headers=hdr)
    again = client.post(f"/api/admin/devices/{out['device']['id']}/reissue",
                        headers=hdr).json()
    assert again["device"]["presence"] != "revoked"
    assert client.post("/api/auth/device",
                       json={"token": again["token"], "tenant": "d_alpha"},
                       headers={"x-gapvision-key": api_key}).status_code == 200


def test_a_token_with_no_tenant_named_still_resolves(client, mint, api_key):
    """The tenant on the launch URL is a hint, not an authorisation — the row
    is the authority. A lens that lost its `?tenant=` is still that device."""
    out = mint(label="Tenantless")
    r = client.post("/api/auth/device", json={"token": out["token"]},
                    headers={"x-gapvision-key": api_key})
    assert r.status_code == 200
    assert r.json()["tenant"] == "d_alpha"


# --- presence ----------------------------------------------------------------

def test_presence_is_derived_and_does_not_overwrite_status():
    """`status` is what an admin decided about a unit; presence is what the
    fleet is doing. A pair marked active that nobody has switched on all week
    is exactly the row worth surfacing."""
    from datetime import datetime, timedelta, timezone

    from app import devices

    now = datetime.now(timezone.utc)
    assert devices.presence({"status": "active", "last_seen_at": None}) == "provisioned"
    assert devices.presence({"status": "active", "last_seen_at": now}) == "active"
    assert devices.presence(
        {"status": "active", "last_seen_at": now - timedelta(hours=3)}) == "idle"
    assert devices.presence(
        {"status": "active", "last_seen_at": now, "revoked_at": now}) == "revoked"


def test_a_naive_timestamp_does_not_crash_presence():
    """Rows read back from psycopg carry tzinfo; rows built in a test, or by a
    driver configured differently, may not. Presence is on the path that draws
    Console's fleet, and a TypeError there takes the whole card down."""
    from datetime import datetime

    from app import devices

    assert devices.presence({"last_seen_at": datetime.utcnow()}) == "active"
