"""Retention — the only thing in this repo that destroys data on purpose.

    CUE_TEST_DATABASE_URL=... python -m pytest tests/test_retention.py -q

Two properties, and they are equally load-bearing:

  1. Aged personal data is gone.
  2. Aged *operational* data is still there.

The second is not a nice-to-have. A sweep that also ate the analytics would be
correct on privacy and catastrophic on product — a retailer who set a 30-day
window and lost their quarter would turn the control off and never turn it back
on, which leaves them keeping everything forever. The privacy-safest code that
nobody enables protects nobody.
"""
from __future__ import annotations

import os

import pytest

# Same plumbing as test_spine: `db` reads the URL at call time, but the module
# has to be pointed at a database before anything imports the app, and this
# file sorts ahead of test_spine so it cannot rely on that one doing it.
DB_URL = (os.environ.get("CUE_TEST_DATABASE_URL")
          or os.environ.get("CUE_DATABASE_URL"))
if DB_URL:
    os.environ["CUE_DATABASE_URL"] = DB_URL

from app import analytics, db, identity, retention  # noqa: E402

pytestmark = pytest.mark.skipif(not DB_URL, reason="needs a database")

PW = "retention-test-pw"


@pytest.fixture(scope="module", autouse=True)
def schema():
    """Migrations run at app startup, and this module never starts the app —
    it exercises `retention` directly, which is the point. So bring the schema
    up itself rather than depending on whichever test file happened to run
    first."""
    db.migrate(verbose=False)


@pytest.fixture(scope="module")
def tenant():
    slug = "t_retention"
    row = db.query_one("SELECT * FROM tenants WHERE slug = %s", (slug,))
    if row is None:
        db.execute(
            """INSERT INTO tenants (slug, name, crm_provider, privacy)
               VALUES (%s, %s, 'mock', %s::jsonb)""",
            (slug, "Retention Test",
             '{"store_transcripts": true, "retention_days": 30}'),
        )
        row = db.query_one("SELECT * FROM tenants WHERE slug = %s", (slug,))
    return row


def _age(table: str, column: str, row_id: str, days: int) -> None:
    """Backdate a row. Cheaper and far more precise than waiting a month."""
    db.execute(
        f"UPDATE {table} SET {column} = now() - make_interval(days => %s) "
        f"WHERE id = %s", (days, row_id))


def test_aged_personal_data_is_redacted_and_the_numbers_survive(tenant):
    eng = analytics.start_engagement(
        tenant["id"], guest_ref="guest-001", zone="Denim Wall",
        recommendations=[{"sku": "GAP-1", "name": "Barrel Jean", "price": 89.95}],
        cue_lines=["SARAH CHEN", "IN CART CASHSOFT CREW", "OFFER IT IN SIZE M"],
    )
    analytics.end_engagement(str(eng["id"]), outcome="sale", sale_cents=9000)
    voice = analytics.record_voice_query(
        tenant, engagement_id=str(eng["id"]), intent="stock", ok=True,
        latency_ms=1180, audio_seconds=2.4, stt_provider="deepgram",
        transcript="do we have these in a 32",
        answer="Yes — 3 on hand in 32x30",
    )

    # Fresh: nothing should move.
    retention.sweep(tenant)
    v = db.query_one("SELECT * FROM voice_queries WHERE id = %s", (voice["id"],))
    assert v["transcript"] == "do we have these in a 32", "swept inside the window"
    assert v["answer"] == "Yes — 3 on hand in 32x30"

    # Age both past the tenant's 30-day window.
    _age("engagements", "started_at", eng["id"], 45)
    _age("voice_queries", "created_at", voice["id"], 45)
    result = retention.sweep(tenant)
    assert result["voice_redacted"] >= 1
    assert result["engagements_redacted"] >= 1

    v = db.query_one("SELECT * FROM voice_queries WHERE id = %s", (voice["id"],))
    e = db.query_one("SELECT * FROM engagements WHERE id = %s", (eng["id"],))

    # --- gone: everything that says something about a person ----------------
    assert v["transcript"] is None
    assert v["answer"] is None
    assert e["guest_ref"] is None
    assert e["cue_lines"] is None
    assert e["recommendations"] == []

    # --- kept: everything that says something about a shift -----------------
    # If this half ever starts failing, the fix is not to relax the assertion.
    assert v["intent"] == "stock"
    assert v["ok"] is True
    assert v["latency_ms"] == 1180
    assert float(v["audio_seconds"]) == 2.4
    assert v["stt_provider"] == "deepgram"
    assert e["zone"] == "Denim Wall"
    assert e["outcome"] == "sale"
    assert e["sale_cents"] == 9000
    assert e["started_at"] is not None


def test_a_sweep_is_idempotent(tenant):
    """Safe on a timer, safe on demand, safe to run twice by accident."""
    first = retention.sweep(tenant)
    second = retention.sweep(tenant)
    assert second["voice_redacted"] == 0
    assert second["engagements_redacted"] == 0
    assert second["assists_redacted"] == 0
    assert first["retention_days"] == 30


def test_every_sweep_leaves_a_receipt(tenant):
    """A retention policy nobody can prove ran is a policy in the same sense
    that an untested backup is a backup."""
    before = db.query_one(
        "SELECT count(*) AS n FROM retention_runs WHERE tenant_id = %s",
        (tenant["id"],))["n"]
    retention.sweep(tenant)
    after = db.query_one(
        "SELECT count(*) AS n FROM retention_runs WHERE tenant_id = %s",
        (tenant["id"],))["n"]
    assert after == before + 1

    run = db.query_one(
        "SELECT * FROM retention_runs WHERE tenant_id = %s "
        "ORDER BY ran_at DESC LIMIT 1", (tenant["id"],))
    assert run["retention_days"] == 30
    assert run["more_remaining"] is False


def test_a_zero_day_window_cannot_erase_today(tenant):
    """The API clamps, but the destructive end refuses independently. A tenant
    that sets 0 — by hand, by a bad migration, by a typo in a PATCH — must not
    be able to delete a conversation as it is happening."""
    assert retention.window_days({"privacy": {"retention_days": 0}}) == 1
    assert retention.window_days({"privacy": {"retention_days": -30}}) == 1
    assert retention.window_days({"privacy": {"retention_days": "nonsense"}}) == 90
    assert retention.window_days({"privacy": {}}) == 90
    assert retention.window_days({}) == 90


def test_status_reports_the_oldest_tenant_not_the_newest():
    """A dashboard that shows the most recent sweep looks green while one
    tenant silently goes unswept for a month."""
    st = retention.status()
    assert st["enforced"] is True
    # Whatever it names, it must be the tenant whose last run is oldest.
    rows = db.query(
        """SELECT t.slug, max(r.ran_at) AS last_run
             FROM tenants t LEFT JOIN retention_runs r ON r.tenant_id = t.id
            WHERE t.status <> 'archived'
         GROUP BY t.id, t.slug
         ORDER BY max(r.ran_at) ASC NULLS FIRST, t.slug ASC""")
    assert st.get("oldest_swept_tenant") == rows[0]["slug"]


def test_assist_notes_are_redacted(tenant):
    """Free text, so assume the worst about what someone typed into it."""
    helper = identity.create_user(
        email="retention-helper@example.com", name="Helper", role="associate",
        tenant_id=tenant["id"], password=PW,
    ) if not db.query_one(
        "SELECT id FROM users WHERE lower(email) = %s",
        ("retention-helper@example.com",)) else db.query_one(
        "SELECT id FROM users WHERE lower(email) = %s",
        ("retention-helper@example.com",))

    a = analytics.record_assist(
        tenant["id"], helper_user_id=str(helper["id"]),
        note="covered Sarah Chen at the denim wall")
    _age("assists", "created_at", a["id"], 60)
    retention.sweep(tenant)
    row = db.query_one("SELECT * FROM assists WHERE id = %s", (a["id"],))
    assert row["note"] is None
    assert row["helper_user_id"] is not None, "the attribution is not personal data about a guest"
