"""The phone surface, and the line between a handheld and somebody's own phone.

Two doors, and the whole design is that they are not the same door:

  `/api/auth/device`     a store-owned handheld presenting a provision token.
                         That token *is* the store's identity on the device.
  `/api/auth/associate`  an associate's own phone presenting **their** session.
                         No device identity, ever — revoking the person revokes
                         the phone, and nobody chases a handset.

The negatives are the point here, same as `test_devices.py`:

* a personal session resolves to a person and to **no device**, so a BYOD
  handset can never appear in a fleet list under a name nobody can revoke;
* a disabled account, an expired session and a revoked token are all the same
  401, so a stolen session cannot be used to learn which shop it came from;
* a session pointed at another retailer is refused rather than quietly landed
  in the right one;
* CueSea staff and client admins cannot use this door to appear on a shop
  floor — their surfaces are Console and Studio.

Requires a Postgres at CUE_TEST_DATABASE_URL (falls back to CUE_DATABASE_URL).
"""
from __future__ import annotations

import os

import pytest

DB_URL = os.environ.get("CUE_TEST_DATABASE_URL") or os.environ.get("CUE_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB_URL, reason="no database configured")

if DB_URL:
    os.environ["CUE_DATABASE_URL"] = DB_URL

PW = "correct-horse-battery"
KEY = {"x-gapvision-key": os.environ.get("GAPVISION_API_KEY", "test-key-" + "0" * 32)}


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
    """Two retailers again, because a cross-tenant leak looks like correct
    behaviour when there is only one store to return."""
    from app import db, identity

    db.execute("DELETE FROM devices WHERE tenant_id IN "
               "(SELECT id FROM tenants WHERE slug IN ('p_alpha', 'p_beta'))")
    db.execute("DELETE FROM users WHERE email LIKE '%%@phone.example.com'")
    db.execute("DELETE FROM tenants WHERE slug IN ('p_alpha', 'p_beta')")

    alpha = db.query_one(
        "INSERT INTO tenants (slug, name) VALUES ('p_alpha', 'Alpha') RETURNING *")
    beta = db.query_one(
        "INSERT INTO tenants (slug, name) VALUES ('p_beta', 'Beta') RETURNING *")

    users = {
        "cue": identity.create_user(email="cue@phone.example.com", name="Cue Staff",
                                    role="cue_admin", tenant_id=None, password=PW),
        "admin": identity.create_user(email="admin@phone.example.com", name="Alpha Admin",
                                      role="client_admin", tenant_id=alpha["id"], password=PW),
        "mgr": identity.create_user(email="mgr@phone.example.com", name="Alpha Manager",
                                    role="manager", tenant_id=alpha["id"], password=PW),
        "sam": identity.create_user(email="sam@phone.example.com", name="Sam Okonkwo",
                                    role="associate", tenant_id=alpha["id"], password=PW),
        "beta_assoc": identity.create_user(email="bea@phone.example.com", name="Bea",
                                           role="associate", tenant_id=beta["id"], password=PW),
    }
    return {"alpha": alpha, "beta": beta, "users": users}


@pytest.fixture
def login(client):
    def _login(email: str) -> str:
        r = client.post("/auth/login", json={"email": email, "password": PW})
        assert r.status_code == 200, r.text
        return r.json()["token"]
    return _login


def associate_auth(client, session, tenant=None):
    body = {"session": session}
    if tenant:
        body["tenant"] = tenant
    return client.post("/api/auth/associate", json=body, headers=KEY)


# --- a store handheld ---------------------------------------------------------

def test_phone_is_a_surface_a_handheld_can_be_minted_on(client, login):
    r = client.post("/api/admin/tenants/p_alpha/devices",
                    json={"surface": "phone", "label": "Till 2"},
                    headers={"authorization": f"Bearer {login('admin@phone.example.com')}"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["device"]["surface"] == "phone"
    assert body["token"]
    # Pocket's own origin, not Console's. A home-screen icon and a service
    # worker scoped to the staff origin, on a device that leaves the building,
    # would be a same-origin foothold on the admin surface.
    assert "pocket" in body["launch_url"], body["launch_url"]
    assert f"tenant=p_alpha" in body["launch_url"]


def test_a_handheld_gets_a_qr_because_you_point_a_camera_at_it(client, login):
    r = client.post("/api/admin/tenants/p_alpha/devices",
                    json={"surface": "phone", "label": "Till 3"},
                    headers={"authorization": f"Bearer {login('admin@phone.example.com')}"})
    qr = r.json()["qr"]
    assert qr, "a phone has a camera and no keyboard worth typing a token into"
    assert all(set(row) <= {"0", "1"} for row in qr), "the QR crosses the wire inert"


def test_the_handhelds_token_resolves_at_the_device_door(client, login):
    minted = client.post("/api/admin/tenants/p_alpha/devices",
                         json={"surface": "phone", "label": "Till 4"},
                         headers={"authorization": f"Bearer {login('admin@phone.example.com')}"}).json()
    r = client.post("/api/auth/device",
                    json={"token": minted["token"], "tenant": "p_alpha"}, headers=KEY)
    assert r.status_code == 200, r.text
    assert r.json()["surface"] == "phone"
    assert r.json()["device_id"] == minted["device"]["id"]


# --- somebody's own phone -----------------------------------------------------

def test_a_personal_session_resolves_to_a_person(client, login):
    r = associate_auth(client, login("sam@phone.example.com"), "p_alpha")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["email"] == "sam@phone.example.com"
    assert body["name"] == "Sam Okonkwo"
    assert body["tenant"] == "p_alpha"
    assert body["role"] == "associate"


def test_and_to_no_device_at_all(client, login):
    """The invariant the whole surface exists for.

    A synthetic device row here would put the thing we refused to create back
    into the fleet list — a store credential on a handset that leaves with its
    owner, listed under a name nobody can revoke.
    """
    body = associate_auth(client, login("sam@phone.example.com"), "p_alpha").json()
    assert "device_id" not in body, body
    assert "token" not in body, body


def test_no_byod_row_is_written_to_the_fleet(client, login):
    """Not just absent from the response — absent from the table.

    The response-shape test above would still pass if the route created a row
    and simply declined to mention it, and that row is exactly the artefact
    that would show up in Console next month as a device nobody can account for.
    """
    from app import db

    before = db.query_one(
        "SELECT count(*) AS n FROM devices WHERE tenant_id = "
        "(SELECT id FROM tenants WHERE slug = 'p_alpha')")["n"]
    associate_auth(client, login("sam@phone.example.com"), "p_alpha")
    associate_auth(client, login("sam@phone.example.com"), "p_alpha")
    after = db.query_one(
        "SELECT count(*) AS n FROM devices WHERE tenant_id = "
        "(SELECT id FROM tenants WHERE slug = 'p_alpha')")["n"]
    assert after == before, "signing in on a personal phone must not create hardware"


def test_a_session_pointed_at_another_shop_is_refused(client, login):
    r = associate_auth(client, login("sam@phone.example.com"), "p_beta")
    assert r.status_code == 401
    # Refused rather than silently corrected: a phone asking for the wrong
    # store is a phone whose state is wrong, and quietly landing it in the
    # right one hides that from everybody.


def test_a_manager_may_work_the_floor_from_their_phone(client, login):
    r = associate_auth(client, login("mgr@phone.example.com"), "p_alpha")
    assert r.status_code == 200, "a manager covering the floor is an ordinary Saturday"


def test_an_admin_may_not_register_as_a_lens(client, login):
    r = associate_auth(client, login("admin@phone.example.com"), "p_alpha")
    assert r.status_code == 401, "their surfaces are Console and Studio"


def test_cue_staff_have_no_floor_to_join(client, login):
    r = associate_auth(client, login("cue@phone.example.com"))
    assert r.status_code == 401, "no tenant means no floor"


# --- revocation: the reason BYOD is safe at all -------------------------------

def test_signing_out_kills_the_phone(client, login):
    session = login("sam@phone.example.com")
    assert associate_auth(client, session, "p_alpha").status_code == 200
    client.post("/auth/logout", headers={"authorization": f"Bearer {session}"})
    assert associate_auth(client, session, "p_alpha").status_code == 401


def test_disabling_the_person_kills_the_phone(client, login, world):
    """The sentence the whole BYOD story rests on.

    An admin disabling somebody in Console has to end their access on a handset
    nobody can physically reach. If this ever regresses, "we do not need to
    collect the phone" stops being true and the phone-first pitch stops being
    honest.
    """
    from app import db, identity

    session = login("sam@phone.example.com")
    assert associate_auth(client, session, "p_alpha").status_code == 200

    uid = world["users"]["sam"]["id"]
    db.execute("UPDATE users SET status = 'disabled' WHERE id = %s", (uid,))
    try:
        assert associate_auth(client, session, "p_alpha").status_code == 401
    finally:
        db.execute("UPDATE users SET status = 'active' WHERE id = %s", (uid,))
        identity.revoke_all_for_user(uid)


def test_every_refusal_looks_the_same(client, login, world):
    """Unknown, expired, revoked, disabled, wrong shop — one 401, one body.

    Telling them apart lets somebody holding a stolen session learn whether it
    was ever real and which retailer it belonged to.
    """
    from app import db

    bodies = set()
    statuses = set()

    for session, tenant in [
        ("not-a-real-session", "p_alpha"),
        (login("sam@phone.example.com"), "p_beta"),          # wrong shop
        (login("admin@phone.example.com"), "p_alpha"),       # wrong role
        (login("cue@phone.example.com"), None),              # no tenant
    ]:
        r = associate_auth(client, session, tenant)
        statuses.add(r.status_code)
        bodies.add(r.text)

    revoked = login("sam@phone.example.com")
    db.execute("UPDATE auth_tokens SET revoked_at = now() WHERE revoked_at IS NULL "
               "AND user_id = %s", (world["users"]["sam"]["id"],))
    r = associate_auth(client, revoked, "p_alpha")
    statuses.add(r.status_code)
    bodies.add(r.text)

    assert statuses == {401}, statuses
    assert len(bodies) == 1, bodies


# --- the door is for servers, not browsers ------------------------------------

def test_the_associate_door_needs_the_service_key(client, login):
    """A phone holds a session, not a service key.

    It presents that session to the realtime server, which already holds the
    key — same shape as the device door. An unauthenticated caller reaching
    this route directly would be able to turn any stolen session into a
    confirmed identity plus the shop it belongs to.
    """
    r = client.post("/api/auth/associate",
                    json={"session": login("sam@phone.example.com"), "tenant": "p_alpha"})
    assert r.status_code in (401, 403), r.text
