"""The pipeline — leads, touches, and who must not see them.

Follows `test_decks.py`, and for the same reason: these rows are ours, the
isolation runs the opposite way from every other table, and the negative
tests are the point. Three things must hold or the panel lies:

  1. A retailer's admin or manager can never read, write, or move a lead.
  2. The site form's door cannot be used to overwrite pipeline state — a
     re-submitted form refreshes contact fields and leaves the stage alone.
  3. The sweep clears the person and the words, and keeps the shape.

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

    db.execute("DELETE FROM lead_activities")
    db.execute("DELETE FROM leads")
    db.execute("DELETE FROM users WHERE email LIKE '%%@growth.example.com'")
    db.execute("DELETE FROM tenants WHERE slug = 'k_growth'")

    tenant = db.query_one(
        "INSERT INTO tenants (slug, name) VALUES ('k_growth', 'Growth Co') RETURNING *")
    return {
        "tenant": tenant,
        "users": {
            "cue": identity.create_user(email="cue@growth.example.com", name="Cue",
                                        role="cue_admin", tenant_id=None, password=PW),
            "admin": identity.create_user(email="admin@growth.example.com", name="Admin",
                                          role="client_admin", tenant_id=tenant["id"],
                                          password=PW),
            "mgr": identity.create_user(email="mgr@growth.example.com", name="Manager",
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


# --- the positive story ------------------------------------------------------

def test_site_lead_lands_in_the_pipeline(client, auth, key):
    r = client.post("/api/ingest/site-lead", headers=key, json={
        "email": "ops@merchant.example", "name": "Jo", "company": "Merchant Co",
        "storeCount": 12, "pos": "shopify", "utm_source": "google",
        "utm_campaign": "clienteling-search",
    })
    assert r.status_code == 204

    cue = auth("cue@growth.example.com")
    leads = client.get("/api/analytics/growth/leads", headers=cue).json()["leads"]
    row = next(l for l in leads if l["email"] == "ops@merchant.example")
    assert row["source"] == "site"
    assert row["stage"] == "new"
    assert row["utm"]["utm_campaign"] == "clienteling-search"


def test_resubmitted_form_refreshes_but_does_not_reset_stage(client, auth, key):
    cue = auth("cue@growth.example.com")
    leads = client.get("/api/analytics/growth/leads", headers=cue).json()["leads"]
    lead = next(l for l in leads if l["email"] == "ops@merchant.example")

    r = client.patch(f"/api/analytics/growth/leads/{lead['id']}",
                     headers=cue, json={"stage": "demo"})
    assert r.status_code == 200

    # The merchant fills the form again, months later, with a fresher title.
    r = client.post("/api/ingest/site-lead", headers=key, json={
        "email": "OPS@merchant.example", "title": "VP Retail"})
    assert r.status_code == 204

    leads = client.get("/api/analytics/growth/leads", headers=cue).json()["leads"]
    same = [l for l in leads if l["email"].lower() == "ops@merchant.example"]
    assert len(same) == 1, "one merchant, one row — case-insensitively"
    assert same[0]["stage"] == "demo", "a form fill must not un-work the pipeline"
    assert same[0]["title"] == "VP Retail"


def test_stage_change_writes_its_own_log_row(client, auth):
    cue = auth("cue@growth.example.com")
    lead = client.post("/api/analytics/growth/leads", headers=cue, json={
        "email": "kim@boots.example", "company": "Boots Co",
    }).json()["lead"]

    client.patch(f"/api/analytics/growth/leads/{lead['id']}",
                 headers=cue, json={"stage": "contacted"})
    acts = client.get(f"/api/analytics/growth/leads/{lead['id']}/activities",
                      headers=cue).json()["activities"]
    assert any(a["kind"] == "stage" and "contacted" in (a["body"] or "")
               for a in acts)


def test_a_touch_is_recorded_and_counted(client, auth):
    cue = auth("cue@growth.example.com")
    lead = client.post("/api/analytics/growth/leads", headers=cue, json={
        "email": "anna@studios.example",
    }).json()["lead"]

    r = client.post(f"/api/analytics/growth/leads/{lead['id']}/activities",
                    headers=cue,
                    json={"kind": "email", "direction": "out",
                          "body": "first touch"})
    assert r.status_code == 201

    leads = client.get("/api/analytics/growth/leads", headers=cue).json()["leads"]
    row = next(l for l in leads if l["id"] == lead["id"])
    assert row["touches"] == 1
    assert row["last_touch"] is not None


def test_sources_counts_by_door(client, auth):
    cue = auth("cue@growth.example.com")
    s = client.get("/api/analytics/growth/sources", headers=cue).json()
    doors = {r["source"]: r["leads"] for r in s["by_source"]}
    assert doors.get("site", 0) >= 1
    assert doors.get("outbound", 0) >= 2


# --- the negatives, which are the point --------------------------------------

def test_a_retailer_cannot_read_our_pipeline(client, auth):
    for who in ("admin@growth.example.com", "mgr@growth.example.com"):
        headers = auth(who)
        assert client.get("/api/analytics/growth/leads",
                          headers=headers).status_code == 403
        assert client.get("/api/analytics/growth/sources",
                          headers=headers).status_code == 403
        assert client.post("/api/analytics/growth/leads", headers=headers,
                           json={"email": "x@y.example"}).status_code == 403


def test_the_ingest_door_requires_the_service_key(client):
    r = client.post("/api/ingest/site-lead",
                    json={"email": "stranger@curl.example"})
    assert r.status_code in (401, 403)


def test_a_payload_without_an_email_writes_nothing(client, key, auth):
    r = client.post("/api/ingest/site-lead", headers=key,
                    json={"name": "No Email", "company": "Anon Co"})
    assert r.status_code == 204, "the caller still gets its 204"
    cue = auth("cue@growth.example.com")
    leads = client.get("/api/analytics/growth/leads", headers=cue).json()["leads"]
    assert not any(l.get("name") == "No Email" for l in leads)


# --- retention ---------------------------------------------------------------

def test_sweep_clears_the_person_and_keeps_the_shape():
    from app import db, growth

    lead = growth.create_lead({"email": "old@gone.example", "name": "Old Lead",
                               "notes": "met at NRF"})
    growth.add_activity(lead["id"], {"kind": "email", "direction": "out",
                                     "body": "words about a person"})
    db.execute(
        "UPDATE leads SET created_at = now() - interval '900 days' WHERE id = %s",
        (lead["id"],))

    assert growth.sweep_leads() >= 1

    row = db.query_one("SELECT * FROM leads WHERE id = %s", (lead["id"],))
    assert row["redacted_at"] is not None
    assert row["name"] is None and row["notes"] is None
    assert row["email"] == "redacted"
    acts = db.query("SELECT body FROM lead_activities WHERE lead_id = %s",
                    (lead["id"],))
    assert all(a["body"] is None for a in acts), "the words go with the person"
