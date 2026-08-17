"""The mint preflight — not pointing a QR at the wrong application.

A provision token *is* the store's identity, and on a URL-launched surface it
travels in a query string inside a QR somebody holds up to be scanned. If that
hostname is serving a different app, the scan hands a live store credential to
an unrelated deployment — its logs, its analytics, the phone's history — and
the pairing merely appears to fail. Nobody revokes a token they were never told
was burned.

This is not hypothetical: `pocket.cuesea.ai` spent its first hours pointing at
an old project, found by a human opening it rather than by anything in the
system.

The two properties that matter, and they pull in opposite directions:

  1. **A definite wrong answer stops the mint**, and stops it *before* a token
     exists, so there is nothing to burn.
  2. **An unreachable host does not.** Refusing there would take provisioning
     offline because a network blinked, for a check that did not exist last
     week. Same three-outcome shape as `resolveDevice` in packages/server.
"""
from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

DB_URL = os.environ.get("CUE_TEST_DATABASE_URL") or os.environ.get("CUE_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB_URL, reason="no database configured")

if DB_URL:
    os.environ["CUE_DATABASE_URL"] = DB_URL

PW = "correct-horse-battery"


# --- a host that answers however a test wants --------------------------------

class _Host:
    """A real HTTP server, because the thing under test is an HTTP fetch.

    Mocking `urlopen` would test that the code calls a function. This tests
    that it correctly reads what a server said, which is the part that was
    wrong in production.
    """

    def __init__(self, body: bytes | None, status: int = 200):
        self.body, self.status = body, status
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                if outer.body is None:
                    self.send_response(outer.status)
                    self.end_headers()
                    return
                self.send_response(outer.status)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(outer.body)

            def log_message(self, *a):  # keep pytest output readable
                pass

        self.srv = HTTPServer(("127.0.0.1", 0), H)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/"

    def close(self):
        self.srv.shutdown()


def surface_file(app: str) -> bytes:
    return json.dumps({"app": app, "surface": "phone", "version": 1}).encode()


# --- the check itself ---------------------------------------------------------

def test_the_right_app_passes():
    from app import preflight

    h = _Host(surface_file("cue-pocket"))
    try:
        v = preflight.check("phone", h.url)
        assert v.state == "ok", v.detail
        assert not v.blocks
    finally:
        h.close()


def test_the_wrong_app_blocks_and_names_what_it_found():
    """The production bug, exactly: a live host serving something else."""
    from app import preflight

    h = _Host(surface_file("cue-console"))
    try:
        v = preflight.check("phone", h.url)
        assert v.state == "wrong-app"
        assert v.blocks
        assert "cue-console" in v.detail, v.detail
        assert "cue-pocket" in v.detail, "it has to say what it expected, not just what it found"
    finally:
        h.close()


def test_a_host_with_no_surface_file_blocks():
    """What `pocket.cuesea.ai` actually did: 404 for the well-known path.

    A live host that has never heard of Cue is a definite wrong answer, not an
    unreachable one — that distinction is the whole point of the module.
    """
    from app import preflight

    h = _Host(None, status=404)
    try:
        v = preflight.check("phone", h.url)
        assert v.state == "wrong-app", v.detail
        assert "404" in v.detail
    finally:
        h.close()


def test_a_host_answering_junk_blocks():
    from app import preflight

    h = _Host(b"<!doctype html><title>GapVision</title>")
    try:
        assert preflight.check("phone", h.url).state == "wrong-app"
    finally:
        h.close()


def test_an_unreachable_host_does_NOT_block():
    """The half that keeps an outage from becoming a provisioning freeze."""
    from app import preflight

    h = _Host(surface_file("cue-pocket"))
    port = h.port
    h.close()  # nothing is listening now

    v = preflight.check("phone", f"http://127.0.0.1:{port}/")
    assert v.state == "unreachable", v.detail
    assert not v.blocks, "refusing here takes provisioning down because a network blinked"


def test_even_g2_is_not_checked_at_all():
    """Its launch URL is a sideload target, not a web app we serve. There is
    nothing to ask, and inventing an answer would block real provisioning."""
    from app import preflight

    v = preflight.check("even-g2", "https://lens.cuesea.ai/g2/")
    assert v.state == "skipped"
    assert not v.blocks


def test_a_non_https_public_url_is_not_fetched():
    from app import preflight

    v = preflight.check("phone", "http://pocket.cuesea.ai/")
    assert v.state == "unreachable"
    assert not v.blocks


def test_the_check_can_be_switched_off(monkeypatch):
    from app import preflight

    monkeypatch.setattr(preflight, "ENABLED", False)
    h = _Host(surface_file("cue-console"))
    try:
        v = preflight.check("phone", h.url)
        assert v.state == "skipped"
        assert not v.blocks
    finally:
        h.close()


# --- and the routes that use it ----------------------------------------------

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
               "(SELECT id FROM tenants WHERE slug = 'pf_alpha')")
    db.execute("DELETE FROM users WHERE email LIKE '%%@pf.example.com'")
    db.execute("DELETE FROM tenants WHERE slug = 'pf_alpha'")
    t = db.query_one("INSERT INTO tenants (slug, name) VALUES ('pf_alpha', 'Alpha') RETURNING *")
    identity.create_user(email="admin@pf.example.com", name="Admin",
                         role="client_admin", tenant_id=t["id"], password=PW)
    return t


@pytest.fixture
def auth(client):
    def _auth(email="admin@pf.example.com"):
        r = client.post("/auth/login", json={"email": email, "password": PW})
        assert r.status_code == 200, r.text
        return {"authorization": f"Bearer {r.json()['token']}"}
    return _auth


def _verdict(state):
    from app import preflight
    return lambda surface, url: preflight.Verdict(state, f"stub: {state}")


def test_minting_a_phone_at_the_wrong_host_is_refused(client, auth, monkeypatch):
    from app import preflight, routes_device

    monkeypatch.setattr(routes_device.preflight, "check", _verdict("wrong-app"))
    r = client.post("/api/admin/tenants/pf_alpha/devices",
                    json={"surface": "phone", "label": "Till 9"}, headers=auth())
    assert r.status_code == 409, r.text
    assert "Nothing was minted" in r.json()["detail"]


def test_and_nothing_was_actually_created(client, auth, monkeypatch, world):
    """The sentence in the error has to be true.

    A refusal that still wrote a row would leave a live token in the database
    with nobody aware of it — worse than not checking at all, because the error
    message says otherwise.
    """
    from app import db, routes_device

    before = db.query_one("SELECT count(*) AS n FROM devices WHERE tenant_id = %s",
                          (world["id"],))["n"]
    monkeypatch.setattr(routes_device.preflight, "check", _verdict("wrong-app"))
    client.post("/api/admin/tenants/pf_alpha/devices",
                json={"surface": "phone", "label": "Till 10"}, headers=auth())
    after = db.query_one("SELECT count(*) AS n FROM devices WHERE tenant_id = %s",
                         (world["id"],))["n"]
    assert after == before


def test_an_admin_who_knows_better_can_mint_anyway(client, auth, monkeypatch):
    from app import routes_device

    monkeypatch.setattr(routes_device.preflight, "check", _verdict("wrong-app"))
    r = client.post("/api/admin/tenants/pf_alpha/devices",
                    json={"surface": "phone", "label": "Override", "despite_wrong_host": True},
                    headers=auth())
    assert r.status_code == 201, r.text
    assert r.json()["token"]


def test_an_unreachable_host_still_mints_and_says_so(client, auth, monkeypatch):
    from app import routes_device

    monkeypatch.setattr(routes_device.preflight, "check", _verdict("unreachable"))
    r = client.post("/api/admin/tenants/pf_alpha/devices",
                    json={"surface": "phone", "label": "Blind"}, headers=auth())
    assert r.status_code == 201, r.text
    assert r.json()["preflight"]["state"] == "unreachable", \
        "an admin about to hold up a QR deserves to know it was not verified"


def test_a_good_host_mints_and_says_it_checked(client, auth, monkeypatch):
    from app import routes_device

    monkeypatch.setattr(routes_device.preflight, "check", _verdict("ok"))
    r = client.post("/api/admin/tenants/pf_alpha/devices",
                    json={"surface": "phone", "label": "Verified"}, headers=auth())
    assert r.status_code == 201
    assert r.json()["preflight"]["state"] == "ok"


def test_reissue_is_guarded_the_same_way(client, auth, monkeypatch):
    """The recovery path is the one an admin reaches for *because* something
    went wrong, so leaving it unguarded would be leaving the likely door open."""
    from app import routes_device

    monkeypatch.setattr(routes_device.preflight, "check", _verdict("ok"))
    minted = client.post("/api/admin/tenants/pf_alpha/devices",
                         json={"surface": "phone", "label": "Reissue me"}, headers=auth())
    device_id = minted.json()["device"]["id"]

    monkeypatch.setattr(routes_device.preflight, "check", _verdict("wrong-app"))
    r = client.post(f"/api/admin/devices/{device_id}/reissue", headers=auth())
    assert r.status_code == 409, r.text
    assert "old one is untouched" in r.json()["detail"]


def test_a_refused_reissue_leaves_the_existing_token_working(client, auth, monkeypatch):
    """Says what the error claims. A reissue that rotated the hash and then
    refused would silently brick a device that was working a second ago."""
    from app import db, routes_device

    monkeypatch.setattr(routes_device.preflight, "check", _verdict("ok"))
    minted = client.post("/api/admin/tenants/pf_alpha/devices",
                         json={"surface": "phone", "label": "Keep working"}, headers=auth())
    device_id = minted.json()["device"]["id"]
    before = db.query_one("SELECT provision_token_hash FROM devices WHERE id = %s",
                          (device_id,))["provision_token_hash"]

    monkeypatch.setattr(routes_device.preflight, "check", _verdict("wrong-app"))
    client.post(f"/api/admin/devices/{device_id}/reissue", headers=auth())

    after = db.query_one("SELECT provision_token_hash FROM devices WHERE id = %s",
                         (device_id,))["provision_token_hash"]
    assert after == before


def test_the_g2_path_is_unaffected(client, auth):
    """Every pair of glasses in the field provisions this way, and none of them
    goes near a host we serve."""
    r = client.post("/api/admin/tenants/pf_alpha/devices",
                    json={"surface": "even-g2", "label": "Pair 1"}, headers=auth())
    assert r.status_code == 201, r.text
    assert r.json()["preflight"]["state"] == "skipped"
