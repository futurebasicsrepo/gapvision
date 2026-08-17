"""Deck links and leads — our own pipeline, and who must not see it.

The positive story is two lines: a gated open is recorded, and CueSea staff can
read it. Everything else here is a negative, and one of them is the reason this
file exists at all.

**A retailer must not be able to read our pipeline.** Every other route in
`/api/analytics/*` is manager-and-up and tenant-scoped, and these two rows are
not a tenant's — they are which investors opened the pre-seed deck and which
merchants we are chasing. Hung off the same rule, a customer's own manager
could read them through an endpoint built for their floor numbers. The
isolation runs the opposite way from every other test in this suite, which is
exactly why it would have shipped unnoticed.

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

    db.execute("DELETE FROM deck_leads")
    db.execute("DELETE FROM deck_links")
    db.execute("DELETE FROM users WHERE email LIKE '%%@deck.example.com'")
    db.execute("DELETE FROM tenants WHERE slug = 'k_deck'")

    tenant = db.query_one(
        "INSERT INTO tenants (slug, name) VALUES ('k_deck', 'Deck Co') RETURNING *")
    return {
        "tenant": tenant,
        "users": {
            "cue": identity.create_user(email="cue@deck.example.com", name="Cue",
                                        role="cue_admin", tenant_id=None, password=PW),
            "admin": identity.create_user(email="admin@deck.example.com", name="Admin",
                                          role="client_admin", tenant_id=tenant["id"],
                                          password=PW),
            "mgr": identity.create_user(email="mgr@deck.example.com", name="Manager",
                                        role="manager", tenant_id=tenant["id"],
                                        password=PW),
        },
    }


@pytest.fixture
def auth(client):
    def token_for(email: str) -> dict:
        r = client.post("/auth/login", json={"email": email, "password": PW})
        assert r.status_code == 200, r.text
        return {"authorization": f"Bearer {r.json()['token']}"}
    return token_for


@pytest.fixture
def key(api_key) -> dict:
    return {"x-gapvision-key": api_key}


def open_deck(client, key, **body):
    body.setdefault("deck", "floor")
    body.setdefault("email", "dana@reformation.example.com")
    return client.post("/api/ingest/deck-lead", json=body, headers=key)


# --- who may read our pipeline ------------------------------------------------

def test_a_retailers_manager_cannot_read_our_leads(client, auth, key):
    open_deck(client, key, name="Dana Ops")
    for who in ("mgr@deck.example.com", "admin@deck.example.com"):
        r = client.get("/api/analytics/deck-leads", headers=auth(who))
        assert r.status_code == 403, (who, r.text)
        assert "dana@reformation.example.com" not in r.text


def test_a_retailers_admin_cannot_read_or_write_our_links(client, auth):
    hdr = auth("admin@deck.example.com")
    assert client.get("/api/analytics/deck-links", headers=hdr).status_code == 403
    assert client.post("/api/analytics/deck-links",
                       json={"deck": "fundraise", "token": "nope"},
                       headers=hdr).status_code == 403


def test_an_unauthenticated_caller_reaches_none_of_it(client):
    assert client.get("/api/analytics/deck-leads").status_code == 401
    assert client.get("/api/analytics/deck-links").status_code == 401


def test_cue_staff_can_read_both(client, auth, key):
    open_deck(client, key, name="Dana Ops", firm="Reformation")
    hdr = auth("cue@deck.example.com")
    leads = client.get("/api/analytics/deck-leads", headers=hdr)
    assert leads.status_code == 200
    assert any(l["email"] == "dana@reformation.example.com"
               for l in leads.json()["leads"])
    assert client.get("/api/analytics/deck-links", headers=hdr).status_code == 200


# --- the ingest ---------------------------------------------------------------

def test_the_ingest_needs_the_service_key(client):
    assert client.post("/api/ingest/deck-lead",
                       json={"email": "x@example.com"}).status_code == 401


def test_a_gated_open_records_what_the_deck_sent(client, auth, key):
    open_deck(client, key, email="sam@acme.vc", name="Sam VC", firm="Acme Ventures",
              deck="fundraise", preparedFor="Acme Ventures", token="abc123",
              ref="https://mail.example.com/")
    rows = client.get("/api/analytics/deck-leads",
                      headers=auth("cue@deck.example.com")).json()["leads"]
    row = next(l for l in rows if l["email"] == "sam@acme.vc")
    assert row["deck"] == "fundraise"
    assert row["firm"] == "Acme Ventures"
    assert row["prepared_for"] == "Acme Ventures"
    # The token is what turns "somebody opened a deck" into "the link sent on
    # Tuesday was opened" — the whole reason it rides along.
    assert row["token"] == "abc123"


def test_an_open_with_no_email_is_not_a_lead(client, auth, key):
    before = len(client.get("/api/analytics/deck-leads",
                            headers=auth("cue@deck.example.com")).json()["leads"])
    assert client.post("/api/ingest/deck-lead",
                       json={"deck": "floor", "name": "Anonymous"},
                       headers=key).status_code == 204
    after = len(client.get("/api/analytics/deck-leads",
                           headers=auth("cue@deck.example.com")).json()["leads"])
    assert after == before, "a nameless open should not become a row"


def test_the_ingest_answers_204_even_on_rubbish(client, key):
    """It sits between a person and the document they asked for. A gate that
    traps a real investor behind a 500 costs more than a missed lead."""
    for body in ({"email": "ok@example.com", "deck": "not-a-deck"},
                 {"email": "ok2@example.com", "name": "x" * 5_000},
                 {}):
        assert client.post("/api/ingest/deck-lead", json=body,
                           headers=key).status_code == 204


def test_an_unknown_deck_is_stored_as_unknown_rather_than_guessed(client, auth, key):
    open_deck(client, key, email="odd@example.com", deck="not-a-deck")
    rows = client.get("/api/analytics/deck-leads",
                      headers=auth("cue@deck.example.com")).json()["leads"]
    assert next(l for l in rows if l["email"] == "odd@example.com")["deck"] is None


def test_fields_are_bounded(client, auth, key):
    open_deck(client, key, email="long@example.com", name="n" * 900)
    rows = client.get("/api/analytics/deck-leads",
                      headers=auth("cue@deck.example.com")).json()["leads"]
    assert len(next(l for l in rows if l["email"] == "long@example.com")["name"]) == 200


# --- links --------------------------------------------------------------------

def test_a_link_is_recorded_and_counts_its_opens(client, auth, key):
    hdr = auth("cue@deck.example.com")
    assert client.post("/api/analytics/deck-links",
                       json={"deck": "floor", "token": "tok-counted",
                             "preparedFor": "Reformation", "gated": True},
                       headers=hdr).status_code == 201
    open_deck(client, key, email="one@reformation.example.com", token="tok-counted")
    open_deck(client, key, email="two@reformation.example.com", token="tok-counted")

    link = next(l for l in client.get("/api/analytics/deck-links", headers=hdr)
                .json()["links"] if l["token"] == "tok-counted")
    assert link["opens"] == 2
    assert link["prepared_for"] == "Reformation"
    # Who built it, so a link made on a laptop is attributable from a phone —
    # which is the point of storing these at all.
    assert link["created_by"] == "Cue"


def test_the_same_link_posted_twice_is_one_link(client, auth):
    """The panel re-sends on reconnect. A retry must not report two sends where
    there was one."""
    hdr = auth("cue@deck.example.com")
    body = {"deck": "floor", "token": "tok-once", "preparedFor": "First"}
    client.post("/api/analytics/deck-links", json=body, headers=hdr)
    client.post("/api/analytics/deck-links",
                json={**body, "preparedFor": "Second"}, headers=hdr)
    rows = [l for l in client.get("/api/analytics/deck-links", headers=hdr).json()["links"]
            if l["token"] == "tok-once"]
    assert len(rows) == 1
    assert rows[0]["prepared_for"] == "Second"


def test_an_unknown_deck_is_refused_on_a_link(client, auth):
    r = client.post("/api/analytics/deck-links",
                    json={"deck": "hololens", "token": "t"},
                    headers=auth("cue@deck.example.com"))
    assert r.status_code == 400


# --- retention ----------------------------------------------------------------

def test_aged_leads_lose_the_person_and_keep_the_open(client, auth, key):
    """The same redaction shape as everything else here: null the personal
    columns, stamp when, leave the row. A lead that vanished would quietly
    shrink last year's history every time the sweep ran."""
    from app import db, decks

    open_deck(client, key, email="old@example.com", name="Old Lead",
              firm="Ancient Co", ref="https://somewhere.example.com/")
    db.execute("UPDATE deck_leads SET created_at = now() - interval '900 days' "
               "WHERE email = 'old@example.com'")

    assert decks.sweep_leads() >= 1

    row = db.query_one("SELECT * FROM deck_leads WHERE firm = 'Ancient Co'")
    assert row is not None, "the row itself must survive"
    assert row["name"] is None and row["email"] is None and row["ref"] is None
    assert row["redacted_at"] is not None, "redacted and never-had-one must differ"
    # The shape of the pipeline is what is worth keeping.
    assert row["firm"] == "Ancient Co" and row["deck"] == "floor"


def test_a_recent_lead_is_left_alone(client, auth, key):
    from app import db, decks

    open_deck(client, key, email="fresh@example.com", name="Fresh Lead")
    decks.sweep_leads()
    row = db.query_one("SELECT * FROM deck_leads WHERE email = 'fresh@example.com'")
    assert row is not None and row["name"] == "Fresh Lead"


def test_the_sweep_runs_as_part_of_retention(client, key, monkeypatch):
    """Leads carry no tenant, so the per-tenant loop cannot reach them. A table
    of names that no sweep touches is the table a reviewer finds."""
    from app import decks, retention

    called = {}
    monkeypatch.setattr(decks, "sweep_leads",
                        lambda *a, **k: called.setdefault("n", 1) and 1)
    retention.sweep_all()
    assert called.get("n") == 1
