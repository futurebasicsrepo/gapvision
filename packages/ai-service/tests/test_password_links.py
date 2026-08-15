"""Invites and password resets.

    CUE_TEST_DATABASE_URL=... python -m pytest tests/test_password_links.py -q

The interesting assertions here are the ones about what the system *refuses*
to tell you. A password-reset endpoint is the most attractive membership
oracle in any product: try an address, read the response, learn whether that
person works for a customer. So the loudest test in this file is that a real
account and a made-up one are indistinguishable from outside.
"""
from __future__ import annotations

import os

import pytest

DB_URL = (os.environ.get("CUE_TEST_DATABASE_URL")
          or os.environ.get("CUE_DATABASE_URL"))
if DB_URL:
    os.environ["CUE_DATABASE_URL"] = DB_URL

from fastapi.testclient import TestClient  # noqa: E402

from app import db, identity, mailer  # noqa: E402
from app.main import app  # noqa: E402

pytestmark = pytest.mark.skipif(not DB_URL, reason="needs a database")

PW = "correct-horse-battery"


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def tenant(client):
    row = db.query_one("SELECT * FROM tenants WHERE slug = %s", ("t_invite",))
    if row is None:
        db.execute(
            "INSERT INTO tenants (slug, name, crm_provider) VALUES (%s, %s, 'mock')",
            ("t_invite", "Invite Test"))
        row = db.query_one("SELECT * FROM tenants WHERE slug = %s", ("t_invite",))
    return row


def _user(tenant, email, password=None, role="associate"):
    """Get or create, and always reset the password to what the caller asked
    for.

    The test database is reused between runs, and these tests change
    passwords on purpose — so a returning account carries whatever the last
    run left on it. Without this line the suite passes once and then fails on
    every subsequent run, which is the worst kind of flake: it looks like a
    regression in the code under test.
    """
    existing = db.query_one("SELECT * FROM users WHERE lower(email) = lower(%s)", (email,))
    if existing:
        if password:
            db.execute("UPDATE users SET password_hash = %s, status = 'active' "
                       "WHERE id = %s", (identity.hash_password(password), existing["id"]))
        return existing
    return identity.create_user(email=email, name="Test Person", role=role,
                                tenant_id=tenant["id"], password=password)


def _sent(monkeypatch):
    """Capture what would have gone out instead of sending it."""
    box = []
    monkeypatch.setattr(mailer, "send",
                        lambda to, subject, body: (
                            box.append({"to": to, "subject": subject, "body": body})
                            or {"ok": True, "provider": "test", "delivered": True}))
    return box


# --- the oracle ---------------------------------------------------------------

def test_forgot_cannot_be_used_to_discover_who_has_an_account(client, tenant, monkeypatch):
    """A real address and a made-up one must be indistinguishable. Otherwise
    this endpoint answers "does this person work for a CueSea customer" to anyone
    who asks, one address at a time."""
    _sent(monkeypatch)
    _user(tenant, "real@invite.example.com", PW)

    real = client.post("/auth/forgot", json={"email": "real@invite.example.com"})
    fake = client.post("/auth/forgot", json={"email": "nobody@invite.example.com"})

    assert real.status_code == fake.status_code == 202
    assert real.json() == fake.json(), "the responses differ, which is the oracle"


def test_a_disabled_account_gets_no_reset_link(client, tenant, monkeypatch):
    box = _sent(monkeypatch)
    u = _user(tenant, "disabled@invite.example.com", PW)
    db.execute("UPDATE users SET status = 'disabled' WHERE id = %s", (u["id"],))
    client.post("/auth/forgot", json={"email": "disabled@invite.example.com"})
    assert not [m for m in box if m["to"] == "disabled@invite.example.com"]
    db.execute("UPDATE users SET status = 'active' WHERE id = %s", (u["id"],))


# --- the link itself ----------------------------------------------------------

def test_a_link_works_once(client, tenant):
    u = _user(tenant, "once@invite.example.com", PW)
    token, _ = identity.issue_password_link(str(u["id"]), "reset")

    first = client.post("/auth/reset", json={"token": token, "password": "a-new-password"})
    assert first.status_code == 200

    second = client.post("/auth/reset", json={"token": token, "password": "another-one"})
    assert second.status_code == 400
    assert "already been used" in second.json()["detail"]


def test_issuing_a_link_burns_the_previous_one(client, tenant):
    """Two live reset links is one more than anybody needs, and it makes
    "I clicked the old email" silently work — which is what makes people
    request a third."""
    u = _user(tenant, "burn@invite.example.com", PW)
    old, _ = identity.issue_password_link(str(u["id"]), "reset")
    new, _ = identity.issue_password_link(str(u["id"]), "reset")

    assert client.post("/auth/reset",
                       json={"token": old, "password": "x" * 12}).status_code == 400
    assert client.post("/auth/reset",
                       json={"token": new, "password": "x" * 12}).status_code == 200


def test_an_expired_link_says_so(client, tenant):
    u = _user(tenant, "expired@invite.example.com", PW)
    token, _ = identity.issue_password_link(str(u["id"]), "reset")
    db.execute("UPDATE password_resets SET expires_at = now() - interval '1 hour' "
               "WHERE user_id = %s AND used_at IS NULL", (u["id"],))
    r = client.post("/auth/reset", json={"token": token, "password": "x" * 12})
    assert r.status_code == 400
    assert "expired" in r.json()["detail"]


def test_a_garbage_token_is_rejected(client):
    r = client.post("/auth/reset", json={"token": "not-a-real-token", "password": "x" * 12})
    assert r.status_code == 400


def test_a_short_password_is_refused(client, tenant):
    u = _user(tenant, "short@invite.example.com", PW)
    token, _ = identity.issue_password_link(str(u["id"]), "reset")
    r = client.post("/auth/reset", json={"token": token, "password": "abc"})
    assert r.status_code == 400
    # And the link survives, so a weak first attempt does not cost the link.
    assert client.post("/auth/reset",
                       json={"token": token, "password": "x" * 12}).status_code == 200


def test_setting_a_password_ends_every_existing_session(client, tenant):
    """If the reset was because somebody else had the old password, leaving
    their session alive defeats the entire exercise."""
    u = _user(tenant, "sessions@invite.example.com", PW)
    login = client.post("/auth/login",
                        json={"email": "sessions@invite.example.com", "password": PW})
    assert login.status_code == 200
    tok = login.json()["token"]
    assert client.get("/auth/me", headers={"Authorization": f"Bearer {tok}"}).status_code == 200

    reset_token, _ = identity.issue_password_link(str(u["id"]), "reset")
    client.post("/auth/reset", json={"token": reset_token, "password": "brand-new-pw-1"})

    assert client.get("/auth/me",
                      headers={"Authorization": f"Bearer {tok}"}).status_code == 401


def test_reset_does_not_hand_back_a_session(client, tenant):
    """A leaked link should not be able to both set a password and return a
    live session in one request. Signing in afterwards is the extra screen
    that costs an attacker the password they just set."""
    u = _user(tenant, "nosession@invite.example.com", PW)
    token, _ = identity.issue_password_link(str(u["id"]), "reset")
    body = client.post("/auth/reset",
                       json={"token": token, "password": "another-good-pw"}).json()
    assert "token" not in body


# --- invites ------------------------------------------------------------------

def test_creating_a_person_without_a_password_invites_them(client, tenant, monkeypatch):
    """The old behaviour created an account nobody could sign in to, and staff
    read passwords out loud to get people in."""
    box = _sent(monkeypatch)
    admin = _user(tenant, "admin@invite.example.com", PW, role="client_admin")
    login = client.post("/auth/login",
                        json={"email": "admin@invite.example.com", "password": PW})
    h = {"Authorization": f"Bearer {login.json()['token']}"}

    db.execute("DELETE FROM users WHERE lower(email) = %s", ("newhire@invite.example.com",))
    r = client.post("/api/admin/users", headers=h, json={
        "email": "newhire@invite.example.com", "name": "New Hire",
        "role": "associate", "tenant": "t_invite",
    })
    assert r.status_code in (200, 201), r.text
    assert r.json()["invite"]["sent"] is True

    mail = [m for m in box if m["to"] == "newhire@invite.example.com"]
    assert len(mail) == 1
    assert "set-password?token=" in mail[0]["body"]
    # An associate belongs in Studio, not the staff console.
    assert "app.cuesea.ai" in mail[0]["body"]

    # And the link actually works, which is the half that a mock email would
    # otherwise let us skip.
    token = mail[0]["body"].split("set-password?token=")[1].split()[0]
    assert client.post("/auth/reset",
                       json={"token": token, "password": "hired-today-99"}).status_code == 200
    assert client.post("/auth/login", json={
        "email": "newhire@invite.example.com", "password": "hired-today-99",
    }).status_code == 200


def test_a_password_given_at_creation_sends_nothing(client, tenant, monkeypatch):
    box = _sent(monkeypatch)
    admin_login = client.post("/auth/login",
                              json={"email": "admin@invite.example.com", "password": PW})
    h = {"Authorization": f"Bearer {admin_login.json()['token']}"}
    db.execute("DELETE FROM users WHERE lower(email) = %s", ("preset@invite.example.com",))
    r = client.post("/api/admin/users", headers=h, json={
        "email": "preset@invite.example.com", "name": "Preset",
        "role": "associate", "tenant": "t_invite", "password": PW,
    })
    assert r.status_code in (200, 201)
    assert r.json()["invite"] is None
    assert not [m for m in box if m["to"] == "preset@invite.example.com"]


def test_cue_staff_are_sent_to_the_console_not_studio(client, tenant, monkeypatch):
    box = _sent(monkeypatch)
    staff = _user(tenant, "staff@cuesea.example.com", PW)
    db.execute("UPDATE users SET role = 'cue_admin', tenant_id = NULL WHERE id = %s",
               (staff["id"],))
    row = db.query_one("SELECT * FROM users WHERE id = %s", (staff["id"],))
    token, hours = identity.issue_password_link(str(row["id"]), "reset")
    mailer.send_reset(to=row["email"], name=row["name"], role=row["role"],
                      token=token, hours=hours)
    assert "internal.cuesea.ai" in box[-1]["body"]


# --- throttling ---------------------------------------------------------------

def test_forgot_is_throttled_per_email(client, monkeypatch):
    """Unthrottled, this is a free email cannon pointed at anyone with an
    account — the caller picks the recipient.

    conftest raises the limits for the rest of the suite, so this drives
    `throttle_key` directly with production-shaped numbers rather than relying
    on module state nobody else can see.
    """
    from app.auth import throttle_key
    key = "test-forgot-email:someone@example.com"
    for _ in range(3):
        throttle_key(key, 3, 60)
    with pytest.raises(Exception) as e:
        throttle_key(key, 3, 60)
    assert "429" in str(e.value) or "Too many" in str(e.value)


def test_login_consumes_both_an_email_bucket_and_an_ip_bucket(client, tenant):
    """A store is one NAT. Ten associates signing in at the start of a shift
    come from a single address, so an IP limit tight enough to stop somebody
    grinding one password would also lock out the morning — hence two keys.

    Asserts the wiring rather than the numbers: conftest raises the limits for
    the rest of the suite, so comparing the constants here would only be
    checking conftest.
    """
    from app.auth import _hits
    email = "buckets@invite.example.com"
    _user(tenant, email, PW)
    # Presence, not novelty: by the time the whole suite has run, the IP
    # bucket already exists from every other login. The email bucket is the
    # one that must be per-address.
    client.post("/auth/login", json={"email": email, "password": PW})
    assert f"login-email:{email}" in _hits, [k for k in _hits if "login" in k][:5]
    assert any(k.startswith("login-ip:") for k in _hits)

    # And a second address gets its own bucket rather than sharing.
    other = "buckets2@invite.example.com"
    _user(tenant, other, PW)
    client.post("/auth/login", json={"email": other, "password": PW})
    assert f"login-email:{other}" in _hits


# --- the half nobody was testing ------------------------------------------
#
# Every assertion above proves the backend does its job: a link is minted, the
# email carries it, the token redeems, the password works. All true, and all
# true on the day the first person we ever invited followed that link and got
# a 404 from the CDN.
#
# The link is a contract between three things that live in different trees and
# are deployed separately — the mailer that writes the URL, the frontend that
# has to render something at that path, and the host that has to route a cold
# navigation there instead of 404ing. Testing one third of a contract is how
# you get a green suite and a broken invitation.

import json
import pathlib

REPO = pathlib.Path(__file__).resolve().parents[3]
LINK_PATH = "/set-password"


def test_the_mailer_builds_the_path_the_frontends_actually_serve():
    from app import mailer

    url = mailer.link_for("cue_admin", "abc123")
    assert LINK_PATH in url, (
        f"mailer.link_for produced {url!r}. If this path is changing, every "
        f"assertion below has to change with it, and so does the routing in "
        f"both frontends."
    )


@pytest.mark.parametrize("package", ["internal", "web"])
def test_the_host_routes_a_cold_navigation_to_the_link(package):
    """A deep link is not a client-side concern.

    Following an invitation from an email client is a fresh request to the CDN
    for a path no file exists at. Without a rewrite the app's JavaScript never
    runs, so no amount of routing inside React can save it — which is exactly
    how this failed in production.
    """
    cfg = REPO / "packages" / package / "vercel.json"
    assert cfg.exists(), (
        f"packages/{package} has no vercel.json, so {LINK_PATH} is served by "
        f"nothing and a cold navigation 404s."
    )
    rewrites = json.loads(cfg.read_text()).get("rewrites") or []
    assert any(r.get("source") == LINK_PATH for r in rewrites), (
        f"packages/{package}/vercel.json does not rewrite {LINK_PATH} to "
        f"index.html. Invitations sent to this app will 404."
    )


@pytest.mark.parametrize("package", ["internal", "web"])
def test_the_frontend_renders_something_at_the_link(package):
    """And the app has to answer on it once the JavaScript does run."""
    src = REPO / "packages" / package / "src"
    assert (src / "components" / "SetPassword.jsx").exists(), (
        f"packages/{package} has no SetPassword screen."
    )
    app = (src / "App.jsx").read_text()
    assert LINK_PATH in app, (
        f"packages/{package}/src/App.jsx never looks at {LINK_PATH}, so the "
        f"rewrite lands on an app that renders the sign-in form instead."
    )
