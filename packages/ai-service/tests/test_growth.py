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


# --- the join: a gated deck open is pipeline, not a side table ----------------
#
# Before this, `decks.record_lead` wrote to `deck_leads` and stopped. The
# warmest signal the company gets — somebody typing their email to read the
# deck — lived in a table the pipeline never read, and reached a human only if
# one thought to check it. These assert the join, and the three ways it could
# quietly do harm.

def test_a_gated_deck_open_creates_a_lead_with_the_open_in_its_log():
    from app import decks, growth

    row = decks.record_lead({
        "deck": "floor", "email": "opener@merchant.example.com",
        "name": "Dana Opener", "firm": "Merchant Co", "preparedFor": "Merchant Co",
    })
    assert row is not None                       # the raw evidence still lands

    lead = next(l for l in growth.leads()
                if l["email"] == "opener@merchant.example.com")
    assert lead["source"] == "deck"
    acts = growth.activities(str(lead["id"]))
    assert [a["kind"] for a in acts] == ["deck"]
    assert "floor deck" in acts[0]["body"]
    assert "Merchant Co" in acts[0]["body"]


def test_an_open_does_not_rewrite_the_door_that_actually_produced_the_lead():
    """First-touch attribution. A merchant we cold-emailed who later opens the
    deck came from outbound — crediting the deck would let the Sources card
    quietly take credit for pipeline outbound built."""
    from app import decks, growth

    growth.create_lead({"email": "chased@merchant.example.com", "name": "Chased",
                        "source": "outbound"})
    decks.record_lead({"deck": "floor", "email": "chased@merchant.example.com"})

    lead = next(l for l in growth.leads()
                if l["email"] == "chased@merchant.example.com")
    assert lead["source"] == "outbound"


def test_an_open_never_moves_the_stage():
    """An open is not a reply and not a demo — and the opener may be a
    colleague the deck was forwarded to, not the person we are working."""
    from app import decks, growth

    lead = growth.create_lead({"email": "staged@merchant.example.com",
                               "source": "outbound", "stage": "demo"})
    growth.update_lead(str(lead["id"]), {"stage": "demo"})
    decks.record_lead({"deck": "floor", "email": "staged@merchant.example.com"})

    after = next(l for l in growth.leads()
                 if l["email"] == "staged@merchant.example.com")
    assert after["stage"] == "demo"


def test_an_open_does_not_read_as_a_reply_we_have_answered():
    """The regression this join could have introduced.

    The panel flames a lead whose reply is newer than our last *outbound*
    touch. If a deck open counted as any kind of touch for that comparison, a
    merchant who replied and then re-opened the deck would stop flaming — the
    exact failure the colour exists to prevent, arriving silently.
    """
    from app import decks, growth

    lead = growth.create_lead({"email": "waiting@merchant.example.com",
                               "source": "outbound"})
    lid = str(lead["id"])
    growth.add_activity(lid, {"kind": "email", "direction": "out", "body": "first touch"})
    growth.add_activity(lid, {"kind": "email", "direction": "in", "body": "interested!"})
    decks.record_lead({"deck": "floor", "email": "waiting@merchant.example.com"})

    row = next(l for l in growth.leads()
               if l["email"] == "waiting@merchant.example.com")
    # A reply still outstanding: newer than anything we sent.
    assert row["last_reply"] is not None
    assert row["last_outbound"] is not None
    assert row["last_reply"] >= row["last_outbound"]
    # And the open itself is not a reply.
    assert row["last_reply"] < row["last_touch"]


def test_the_deck_list_says_what_became_of_each_opener():
    """Sales shows the stage beside the open, so a link is readable as
    pipeline rather than as a number of clicks."""
    from app import decks, growth

    decks.record_lead({"deck": "floor", "email": "became@merchant.example.com",
                       "name": "Became"})
    lead = next(l for l in growth.leads()
                if l["email"] == "became@merchant.example.com")
    growth.update_lead(str(lead["id"]), {"stage": "demo"})

    entry = next(d for d in decks.leads()
                 if d["email"] == "became@merchant.example.com")
    assert entry["lead_stage"] == "demo"
    assert entry["lead_id"] is not None


def test_a_deck_open_with_no_email_writes_no_pipeline_row():
    from app import decks, growth

    before = len(growth.leads())
    assert decks.record_lead({"deck": "floor", "name": "Anonymous"}) is None
    assert len(growth.leads()) == before


# --- the work queue: what to do first ----------------------------------------
#
# The Leads table sorts by `updated_at` — the order things happened, which is
# right for reading history and useless for deciding what to do this morning.
# These assert the other question, and the ordering *is* the product: a queue
# that puts a stalled demo above an unanswered reply is a queue that costs a
# merchant.

def _touch(lead_id, kind, direction, days_ago):
    from app import db
    db.execute(
        """
        INSERT INTO lead_activities (lead_id, kind, direction, body, at)
        VALUES (%s, %s, %s, 'x', now() - make_interval(days => %s))
        """,
        (lead_id, kind, direction, days_ago),
    )


def _fresh(email, stage="contacted"):
    from app import db, growth
    db.execute("DELETE FROM leads WHERE lower(email) = lower(%s)", (email,))
    lead = growth.create_lead({"email": email, "source": "outbound"})
    if stage != "new":
        growth.update_lead(str(lead["id"]), {"stage": stage})
    return str(lead["id"])


def _row(email):
    from app import growth
    return next((r for r in growth.work_queue()
                 if r["email"].lower() == email.lower()), None)


def test_a_reply_we_have_not_answered_is_the_first_thing_in_the_queue():
    from app import growth

    # The reply is deliberately the *older* event. Sorted by recency alone the
    # quiet one would win; only reason-priority puts the reply first, which is
    # the property being asserted. An earlier version of this test had the
    # reply as the newer event and passed under a plain recency sort — it was
    # agreeing with the code by coincidence rather than testing it.
    quiet = _fresh("quiet@wq.example.com")
    _touch(quiet, "email", "out", 6)                 # recent, but unanswered

    waiting = _fresh("waiting@wq.example.com")
    _touch(waiting, "email", "out", 40)
    _touch(waiting, "email", "in", 39)               # answered us long ago

    q = [r["email"] for r in growth.work_queue()]
    assert q.index("waiting@wq.example.com") < q.index("quiet@wq.example.com"), q
    assert _row("waiting@wq.example.com")["reason"] == "awaiting_reply"


def test_a_deck_open_with_nothing_since_is_its_own_reason():
    """The warmest unsolicited signal there is. Before #30 the pipeline could
    not even see it."""
    from app import decks

    decks.record_lead({"deck": "floor", "email": "opened@wq.example.com",
                       "name": "Opened"})
    row = _row("opened@wq.example.com")
    assert row is not None
    assert row["reason"] == "opened_untouched"


def test_an_open_we_have_already_followed_up_on_leaves_the_queue():
    from app import decks, db, growth

    decks.record_lead({"deck": "floor", "email": "followed@wq.example.com"})
    lead = next(r for r in growth.leads()
                if r["email"] == "followed@wq.example.com")
    # We replied after the open — nothing is owed.
    _touch(str(lead["id"]), "email", "out", 0)
    assert _row("followed@wq.example.com") is None


def test_silence_becomes_a_nudge_only_after_the_threshold():
    from app import growth

    recent = _fresh("recent@wq.example.com")
    _touch(recent, "email", "out", growth.QUIET_DAYS - 1)
    assert _row("recent@wq.example.com") is None, "too soon to chase"

    ripe = _fresh("ripe@wq.example.com")
    _touch(ripe, "email", "out", growth.QUIET_DAYS + 1)
    assert _row("ripe@wq.example.com")["reason"] == "gone_quiet"


def test_a_live_deal_nobody_has_touched_is_stalled():
    from app import db, growth

    lead = _fresh("stalled@wq.example.com", stage="demo")
    # Everything backdated, including the stage change itself. Moving a stage
    # *is* a touch — a deal restaged this morning is not stalled — so leaving
    # that activity at `now` was the test lying, not the rule being wrong.
    db.execute(
        "UPDATE lead_activities SET at = now() - make_interval(days => %s) "
        "WHERE lead_id = %s", (growth.STALL_DAYS + 2, lead))
    db.execute(
        "UPDATE leads SET updated_at = now() - make_interval(days => %s) "
        "WHERE id = %s", (growth.STALL_DAYS + 2, lead))

    row = _row("stalled@wq.example.com")
    assert row is not None, "a demo untouched for longer than the threshold"
    assert row["reason"] == "stalled"


def test_a_deal_restaged_today_is_not_stalled():
    """The converse, and the reason the test above needed fixing rather than
    the rule: a stage change is a touch."""
    from app import db, growth

    lead = _fresh("restaged@wq.example.com", stage="demo")
    db.execute(
        "UPDATE leads SET updated_at = now() - make_interval(days => %s) "
        "WHERE id = %s", (growth.STALL_DAYS + 30, lead))
    # The stage-change activity stays at `now`.
    assert _row("restaged@wq.example.com") is None


def test_won_lost_and_nurture_never_appear():
    """`nurture` is the stage that means 'not now, on purpose'. Surfacing it
    would break the one honest way to defer something."""
    from app import growth

    for stage in ("won", "lost", "nurture"):
        lead = _fresh(f"{stage}@wq.example.com", stage=stage)
        _touch(lead, "email", "in", 1)          # would otherwise flame
        assert _row(f"{stage}@wq.example.com") is None, stage


def test_within_a_reason_the_longest_waiting_comes_first():
    from app import growth

    old = _fresh("old@wq.example.com")
    _touch(old, "email", "out", 40)
    new = _fresh("new@wq.example.com")
    _touch(new, "email", "out", 7)

    q = [r["email"] for r in growth.work_queue() if r["reason"] == "gone_quiet"]
    assert q.index("old@wq.example.com") < q.index("new@wq.example.com"), q


def test_each_row_carries_one_reason_and_how_long_it_has_waited():
    """One reason per lead: a row listing three problems is a row somebody has
    to think about before acting."""
    from app import growth

    lead = _fresh("counted@wq.example.com")
    _touch(lead, "email", "out", 12)
    row = _row("counted@wq.example.com")
    assert isinstance(row["reason"], str)
    assert row["waiting_days"] >= 12


def test_a_retailer_cannot_read_the_work_queue(client, auth):
    for who in ("admin@growth.example.com", "mgr@growth.example.com"):
        r = client.get("/api/analytics/growth/work-queue", headers=auth(who))
        assert r.status_code == 403, who


def test_the_route_reports_the_thresholds_it_actually_used(client, auth):
    from app import growth
    r = client.get("/api/analytics/growth/work-queue",
                   headers=auth("cue@growth.example.com"))
    assert r.status_code == 200
    assert r.json()["quiet_days"] == growth.QUIET_DAYS
    assert r.json()["stall_days"] == growth.STALL_DAYS
