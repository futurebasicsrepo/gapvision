"""Control plane tests — identity, tenant isolation, roles, and analytics.

The assertions that matter most are the negative ones. A dashboard that shows
a manager their own store is table stakes; a dashboard that can be made to
show them someone else's store is the thing that ends a pilot. Most of this
file is about what people *cannot* do.

Requires a Postgres to point CUE_TEST_DATABASE_URL at (falls back to
CUE_DATABASE_URL). Skipped entirely when neither is set, so the rest of the
suite still runs on a machine with no database.
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
    with TestClient(app) as c:   # triggers startup, which migrates
        yield c


@pytest.fixture(scope="module", autouse=True)
def fixtures(client):
    """Two tenants with their own people, so isolation can actually be tested.

    One tenant is never enough: every leak looks like correct behaviour when
    there is only one set of data to return.
    """
    from app import db, identity

    db.execute("DELETE FROM users")
    db.execute("DELETE FROM tenants WHERE slug IN ('t_alpha', 't_beta')")

    alpha = db.query_one(
        "INSERT INTO tenants (slug, name) VALUES ('t_alpha', 'Alpha Retail') RETURNING *"
    )
    beta = db.query_one(
        "INSERT INTO tenants (slug, name) VALUES ('t_beta', 'Beta Stores') RETURNING *"
    )

    made = {
        "cue": identity.create_user(email="cue@cue.example.com", name="Cue Admin",
                                    role="cue_admin", tenant_id=None, password=PW),
        "a_admin": identity.create_user(email="admin@alpha.example.com", name="A Admin",
                                        role="client_admin", tenant_id=alpha["id"], password=PW),
        "a_mgr": identity.create_user(email="mgr@alpha.example.com", name="A Manager",
                                      role="manager", tenant_id=alpha["id"], password=PW),
        "a_assoc": identity.create_user(email="assoc@alpha.example.com", name="A Associate",
                                        role="associate", tenant_id=alpha["id"], password=PW),
        "b_mgr": identity.create_user(email="mgr@beta.example.com", name="B Manager",
                                      role="manager", tenant_id=beta["id"], password=PW),
    }
    return {"alpha": alpha, "beta": beta, "users": made}


def token(client, email: str, password: str = PW) -> str:
    res = client.post("/auth/login", json={"email": email, "password": password})
    assert res.status_code == 200, res.text
    return res.json()["token"]


def auth(client, email: str) -> dict:
    return {"Authorization": f"Bearer {token(client, email)}"}


# --- passwords ---------------------------------------------------------------

def test_password_hashing_roundtrip():
    from app.identity import hash_password, verify_password

    encoded = hash_password(PW)
    assert PW not in encoded
    assert encoded.startswith("scrypt$")
    assert verify_password(PW, encoded)
    assert not verify_password("wrong", encoded)
    assert not verify_password(PW, None)
    assert not verify_password("", encoded)
    # Same password, different salt, different hash.
    assert hash_password(PW) != encoded


def test_short_passwords_rejected():
    from app.identity import hash_password

    with pytest.raises(ValueError):
        hash_password("short")


# --- login -------------------------------------------------------------------

def test_login_and_me(client):
    res = client.post("/auth/login", json={"email": "mgr@alpha.example.com", "password": PW})
    assert res.status_code == 200
    body = res.json()
    assert body["user"]["role"] == "manager"
    assert body["user"]["tenant_slug"] == "t_alpha"
    assert "password" not in str(body["user"])

    me = client.get("/auth/me", headers={"Authorization": f"Bearer {body['token']}"})
    assert me.status_code == 200
    assert me.json()["user"]["email"] == "mgr@alpha.example.com"


def test_bad_credentials_are_indistinguishable(client):
    wrong_pw = client.post("/auth/login", json={"email": "mgr@alpha.example.com", "password": "nope"})
    no_user = client.post("/auth/login", json={"email": "ghost@alpha.example.com", "password": "nope"})
    assert wrong_pw.status_code == no_user.status_code == 401
    assert wrong_pw.json()["detail"] == no_user.json()["detail"]


def test_unauthenticated_and_garbage_tokens(client):
    assert client.get("/auth/me").status_code == 401
    assert client.get("/auth/me", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.get("/auth/me", headers={"Authorization": "Basic abc"}).status_code == 401


def test_logout_revokes_immediately(client):
    t = token(client, "mgr@alpha.example.com")
    h = {"Authorization": f"Bearer {t}"}
    assert client.get("/auth/me", headers=h).status_code == 200
    client.post("/auth/logout", headers=h)
    assert client.get("/auth/me", headers=h).status_code == 401


def test_disabling_a_user_kills_live_sessions(client, fixtures):
    from app import identity

    victim = identity.create_user(email="temp@alpha.example.com", name="Temp", role="associate",
                                  tenant_id=fixtures["alpha"]["id"], password=PW)
    h = {"Authorization": f"Bearer {token(client, 'temp@alpha.example.com')}"}
    assert client.get("/auth/me", headers=h).status_code == 200

    res = client.patch(f"/api/admin/users/{victim['id']}", json={"status": "disabled"},
                       headers=auth(client, "admin@alpha.example.com"))
    assert res.status_code == 200
    # The point: the existing token stops working now, not at expiry.
    assert client.get("/auth/me", headers=h).status_code == 401


# --- role gates --------------------------------------------------------------

def test_associate_cannot_read_the_dashboard(client):
    res = client.get("/api/analytics/summary", headers=auth(client, "assoc@alpha.example.com"))
    assert res.status_code == 403


def test_manager_can_read_but_not_create_users(client):
    h = auth(client, "mgr@alpha.example.com")
    assert client.get("/api/admin/users", headers=h).status_code == 200
    res = client.post("/api/admin/users", headers=h,
                      json={"email": "new@alpha.example.com", "name": "New", "role": "associate"})
    assert res.status_code == 403


def test_client_admin_cannot_create_cue_staff(client):
    res = client.post("/api/admin/users", headers=auth(client, "admin@alpha.example.com"),
                      json={"email": "sneak@cue.example.com", "name": "Sneak", "role": "cue_admin"})
    assert res.status_code == 403


def test_client_admin_cannot_reach_the_tenant_list(client):
    assert client.get("/api/admin/tenants",
                      headers=auth(client, "admin@alpha.example.com")).status_code == 403
    assert client.get("/api/admin/tenants",
                      headers=auth(client, "cue@cue.example.com")).status_code == 200


def test_client_admin_cannot_change_commercial_terms(client, fixtures):
    """A retailer may set their own privacy posture; they may not upgrade
    their own billing plan or un-suspend themselves."""
    h = auth(client, "admin@alpha.example.com")
    ok = client.patch("/api/admin/tenants/t_alpha", headers=h,
                      json={"privacy": {"store_transcripts": True, "retention_days": 30}})
    assert ok.status_code == 200
    assert ok.json()["tenant"]["privacy"]["store_transcripts"] is True

    attempt = client.patch("/api/admin/tenants/t_alpha", headers=h,
                           json={"billing_plan": "enterprise", "status": "active"})
    assert attempt.status_code == 400   # nothing left that they may set

    fresh = client.get("/api/admin/tenants/t_alpha", headers=h).json()["tenant"]
    assert fresh["billing_plan"] != "enterprise"

    # Put it back so later tests see the default posture.
    client.patch("/api/admin/tenants/t_alpha", headers=h,
                 json={"privacy": {"store_transcripts": False, "retention_days": 90}})


# --- tenant isolation --------------------------------------------------------

def test_manager_cannot_read_another_tenant(client):
    """Asking for someone else's tenant returns your own data, not theirs."""
    res = client.get("/api/admin/users?tenant=t_beta", headers=auth(client, "mgr@alpha.example.com"))
    assert res.status_code == 200
    emails = {u["email"] for u in res.json()["users"]}
    assert emails and all(e.endswith("@alpha.example.com") for e in emails), emails


def test_client_admin_cannot_edit_another_tenants_user(client, fixtures):
    from app import db

    victim = db.query_one("SELECT id FROM users WHERE email = 'mgr@beta.example.com'")
    res = client.patch(f"/api/admin/users/{victim['id']}", json={"name": "Hacked"},
                       headers=auth(client, "admin@alpha.example.com"))
    assert res.status_code == 403


def test_client_admin_cannot_read_another_tenants_config(client):
    res = client.get("/api/admin/tenants/t_beta", headers=auth(client, "admin@alpha.example.com"))
    assert res.status_code == 403


def test_cue_admin_must_name_a_tenant(client):
    h = auth(client, "cue@cue.example.com")
    assert client.get("/api/analytics/summary", headers=h).status_code == 400
    assert client.get("/api/analytics/summary?tenant=t_beta", headers=h).status_code == 200


# --- ingest + analytics ------------------------------------------------------

def service_key() -> dict:
    return {"x-gapvision-key": os.environ["GAPVISION_API_KEY"]}


def test_ingest_requires_the_service_key(client):
    body = {"tenant": "t_alpha", "guest_ref": "guest-001", "zone": "Denim Wall"}
    assert client.post("/api/ingest/engagement/start", json=body).status_code == 401
    assert client.post("/api/ingest/engagement/start", json=body,
                       headers=service_key()).status_code == 201


def test_full_engagement_flow_reaches_the_dashboard(client):
    start = client.post("/api/ingest/engagement/start", headers=service_key(), json={
        "tenant": "t_alpha", "guest_ref": "guest-001",
        "zone": "Denim Wall", "associate_email": "assoc@alpha.example.com",
    })
    eid = start.json()["engagement_id"]

    client.post("/api/ingest/voice", headers=service_key(), json={
        "tenant": "t_alpha", "engagement_id": eid, "associate_email": "assoc@alpha.example.com",
        "intent": "stock", "ok": True, "latency_ms": 820, "audio_seconds": 1.4,
        "stt_provider": "mock", "transcript": "do we have these in a 32",
    })
    client.post("/api/ingest/engagement/end", headers=service_key(), json={
        "engagement_id": eid, "outcome": "sale", "sale_cents": 8995,
    })

    h = auth(client, "mgr@alpha.example.com")
    summary = client.get("/api/analytics/summary?days=1", headers=h).json()
    assert summary["engagements"] >= 1
    assert summary["sale_cents"] >= 8995
    assert summary["voice"]["total"] >= 1

    engagements = client.get("/api/analytics/engagements", headers=h).json()["engagements"]
    assert any(str(e["id"]) == eid for e in engagements)


def test_transcripts_are_not_stored_unless_the_tenant_opts_in(client):
    """The default is off. An associate's speech near a customer should not
    accumulate in Cue as a side effect of asking about stock."""
    client.post("/api/ingest/voice", headers=service_key(), json={
        "tenant": "t_alpha", "intent": "price", "ok": True,
        "transcript": "this should not be stored", "audio_seconds": 1.0,
    })
    rows = client.get("/api/analytics/voice", headers=auth(client, "mgr@alpha.example.com")).json()
    assert rows["transcripts_stored"] is False
    assert all(r["transcript"] is None for r in rows["voice"])

    # Flip the tenant's posture and the next one is kept.
    client.patch("/api/admin/tenants/t_alpha", headers=auth(client, "admin@alpha.example.com"),
                 json={"privacy": {"store_transcripts": True, "retention_days": 90}})
    client.post("/api/ingest/voice", headers=service_key(), json={
        "tenant": "t_alpha", "intent": "price", "ok": True,
        "transcript": "now it is kept", "audio_seconds": 1.0,
    })
    rows = client.get("/api/analytics/voice", headers=auth(client, "mgr@alpha.example.com")).json()
    assert rows["transcripts_stored"] is True
    assert any(r["transcript"] == "now it is kept" for r in rows["voice"])

    client.patch("/api/admin/tenants/t_alpha", headers=auth(client, "admin@alpha.example.com"),
                 json={"privacy": {"store_transcripts": False, "retention_days": 90}})


def test_leaderboard_counts_assists_not_just_sales(client, fixtures):
    """The whole point of the weighting: someone who only helps other people's
    guests must still be able to place."""
    from app import identity

    helper = identity.create_user(email="helper@alpha.example.com", name="Helper",
                                  role="associate", tenant_id=fixtures["alpha"]["id"],
                                  password=PW)
    for _ in range(4):
        res = client.post("/api/ingest/assist", headers=service_key(), json={
            "tenant": "t_alpha", "helper_email": "helper@alpha.example.com",
        })
        assert res.status_code == 201

    board = client.get("/api/analytics/leaderboard?days=7",
                       headers=auth(client, "mgr@alpha.example.com")).json()
    rows = {r["name"]: r for r in board["rows"]}
    assert rows["Helper"]["assists"] == 4
    assert rows["Helper"]["score"] > 0
    assert board["weights"]["assist"] > 0
    # Every component is exposed, so a ranking can be explained rather than
    # just asserted.
    assert {"engagements", "sale_cents", "assists", "voice_queries"} <= set(
        rows["Helper"].keys()
    )


def test_usage_rollup_feeds_billing(client):
    h = auth(client, "cue@cue.example.com")
    rows = client.get("/api/admin/tenants", headers=h).json()["tenants"]
    alpha = next(r for r in rows if r["slug"] == "t_alpha")
    assert alpha["voice_queries"] >= 1
    assert alpha["engagements"] >= 1
    assert alpha["users"] >= 1

    own = client.get("/api/analytics/usage?days=30",
                     headers=auth(client, "admin@alpha.example.com")).json()
    assert own["tenant"] == "t_alpha"
    assert own["usage"] and own["usage"][-1]["voice_queries"] >= 1


def test_ingest_rejects_an_unknown_tenant(client):
    res = client.post("/api/ingest/engagement/start", headers=service_key(),
                      json={"tenant": "does-not-exist"})
    assert res.status_code == 404


# --- user lifecycle ----------------------------------------------------------

def test_create_disable_and_delete_a_user(client):
    h = auth(client, "admin@alpha.example.com")
    created = client.post("/api/admin/users", headers=h, json={
        "email": "lifecycle@alpha.example.com", "name": "Lifecycle",
        "role": "associate", "password": PW,
    })
    assert created.status_code == 201
    uid = created.json()["user"]["id"]

    dup = client.post("/api/admin/users", headers=h, json={
        "email": "lifecycle@alpha.example.com", "name": "Dup", "role": "associate",
    })
    assert dup.status_code == 409

    assert client.delete(f"/api/admin/users/{uid}", headers=h).status_code == 200
    assert client.post("/auth/login", json={"email": "lifecycle@alpha.example.com",
                                            "password": PW}).status_code == 401


def test_admin_cannot_delete_themselves(client):
    from app import db

    me = db.query_one("SELECT id FROM users WHERE email = 'admin@alpha.example.com'")
    res = client.delete(f"/api/admin/users/{me['id']}", headers=auth(client, "admin@alpha.example.com"))
    assert res.status_code == 400


def test_deleting_an_associate_keeps_their_history(client, fixtures):
    """Someone leaving must not silently rewrite last quarter's numbers."""
    from app import db, identity

    leaver = identity.create_user(email="leaver@alpha.example.com", name="Leaver",
                                  role="associate", tenant_id=fixtures["alpha"]["id"],
                                  password=PW)
    start = client.post("/api/ingest/engagement/start", headers=service_key(), json={
        "tenant": "t_alpha", "guest_ref": "guest-002", "associate_email": "leaver@alpha.example.com",
    })
    eid = start.json()["engagement_id"]

    client.delete(f"/api/admin/users/{leaver['id']}", headers=auth(client, "admin@alpha.example.com"))

    row = db.query_one("SELECT associate_user_id FROM engagements WHERE id = %s", (eid,))
    assert row is not None                      # the engagement survives
    assert row["associate_user_id"] is None     # the person is unlinked


# --- devices -----------------------------------------------------------------

def test_device_registration_and_assignment(client):
    from app import db

    h = auth(client, "admin@alpha.example.com")
    res = client.post("/api/admin/devices", headers=h, json={
        "model": "ring1", "serial": "RING-0001", "label": "Ring — floor 1",
    })
    assert res.status_code == 201
    did = res.json()["device"]["id"]

    assert client.post("/api/admin/devices", headers=h, json={
        "model": "ring1", "serial": "RING-0001"}).status_code == 409
    assert client.post("/api/admin/devices", headers=h, json={
        "model": "hololens", "serial": "X"}).status_code == 400

    assoc = db.query_one("SELECT id FROM users WHERE email = 'assoc@alpha.example.com'")
    assigned = client.patch(f"/api/admin/devices/{did}", headers=h,
                            json={"user_id": str(assoc["id"])})
    assert assigned.status_code == 200
    assert assigned.json()["device"]["user_id"] is not None

    listed = client.get("/api/admin/devices", headers=auth(client, "mgr@alpha.example.com")).json()
    assert any(d["serial"] == "RING-0001" and d["assigned_to"] == "A Associate"
               for d in listed["devices"])


def test_devices_are_tenant_scoped(client):
    beta = client.get("/api/admin/devices", headers=auth(client, "mgr@beta.example.com")).json()
    assert all(d["serial"] != "RING-0001" for d in beta["devices"])


# --- health ------------------------------------------------------------------

def test_health_reports_database_state(client):
    body = client.get("/health").json()
    assert body["database"]["configured"] is True
    assert body["database"]["reachable"] is True
    assert body["database"]["migrations"] >= 1


# --- platform console (Cue staff only) ---------------------------------------
#
# This is the one endpoint that deliberately ignores tenant scoping, so the
# negative cases matter more here than anywhere else in the suite.

def test_platform_is_cue_staff_only(client):
    for email in ("assoc@alpha.example.com", "mgr@alpha.example.com",
                  "admin@alpha.example.com"):
        res = client.get("/api/admin/platform", headers=auth(client, email))
        assert res.status_code == 403, f"{email} reached the platform console"
    assert client.get("/api/admin/platform").status_code == 401


def test_platform_reports_real_state(client):
    body = client.get("/api/admin/platform",
                      headers=auth(client, "cue@cue.example.com")).json()

    assert body["database"]["migrations"] >= 1
    assert body["counts"]["tenants_active"] >= 2
    assert body["counts"]["users_active"] >= 5

    checks = {c["key"]: c for c in body["checks"]}
    # Schema and staff are the two that make everything else meaningful.
    assert checks["schema"]["status"] == "ok"
    assert checks["staff"]["status"] == "ok"
    # Every check reports a status the UI knows how to render.
    assert all(c["status"] in ("ok", "warn", "fail", "unknown") for c in body["checks"])


def test_platform_never_claims_healthy_on_an_empty_schema(client, monkeypatch):
    """The bug that shipped once already: reachable but empty read as fine."""
    from app import db, routes_admin

    monkeypatch.setattr(db, "health", lambda: {
        "configured": True, "reachable": True, "migrations": 0, "status": "empty",
    })
    checks = {c["key"]: c for c in routes_admin._platform_checks()}
    assert checks["schema"]["status"] == "fail"


def test_platform_flags_a_tenant_with_no_admin(client, fixtures):
    """t_beta has a manager but no client_admin — that should surface, not pass."""
    body = client.get("/api/admin/platform",
                      headers=auth(client, "cue@cue.example.com")).json()
    check = {c["key"]: c for c in body["checks"]}["tenant_admins"]
    assert check["status"] == "warn"
    assert "t_beta" in check["detail"]
