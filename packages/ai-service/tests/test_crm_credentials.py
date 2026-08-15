"""Per-tenant CRM credentials — sealing, isolation, and who may touch them.

Like `test_spine.py`, most of the value here is in the negative assertions. A
console that connects a store is easy; a console that can be made to hand one
merchant's Shopify token — or one merchant's customers — to another merchant is
the thing that ends the company. So: the token never comes back out, a tenant
admin cannot reach a neighbouring tenant, and two connected stores never share
an adapter.

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
TOKEN_A = "shpat_" + "a" * 32
TOKEN_B = "shpat_" + "b" * 32


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
    """Two retailers, each with its own admin. One is never enough: every leak
    looks like correct behaviour when there is only one store to return."""
    from app import db, identity

    # '%%' — psycopg reads a bare % as a placeholder even with no parameters.
    db.execute("DELETE FROM users WHERE email LIKE '%%@cred.example.com'")
    db.execute("DELETE FROM tenants WHERE slug IN ('c_alpha', 'c_beta')")

    alpha = db.query_one(
        "INSERT INTO tenants (slug, name) VALUES ('c_alpha', 'Alpha') RETURNING *")
    beta = db.query_one(
        "INSERT INTO tenants (slug, name) VALUES ('c_beta', 'Beta') RETURNING *")

    users = {
        "cue": identity.create_user(email="cue@cred.example.com", name="Cue",
                                    role="cue_admin", tenant_id=None, password=PW),
        "a_admin": identity.create_user(email="a.admin@cred.example.com", name="A Admin",
                                        role="client_admin", tenant_id=alpha["id"],
                                        password=PW),
        "b_admin": identity.create_user(email="b.admin@cred.example.com", name="B Admin",
                                        role="client_admin", tenant_id=beta["id"],
                                        password=PW),
        "a_mgr": identity.create_user(email="a.mgr@cred.example.com", name="A Manager",
                                      role="manager", tenant_id=alpha["id"], password=PW),
    }
    return {"alpha": alpha, "beta": beta, "users": users}


@pytest.fixture
def auth(client):
    def token_for(email: str) -> dict:
        r = client.post("/auth/login", json={"email": email, "password": PW})
        assert r.status_code == 200, r.text
        return {"authorization": f"Bearer {r.json()['token']}"}
    return token_for


@pytest.fixture(autouse=True)
def offline_probe(monkeypatch):
    """No network in the suite. Every store answers, with the scopes we ask for.

    Individual tests override this to exercise the failure branches.
    """
    from app import crm_shopify

    def fake(crm):
        return {"ok": True, "reason": "connected",
                "detail": f"Connected to {crm.t.domain}.",
                "scopes": ["read_customers", "read_orders", "read_products",
                           "read_inventory"],
                "shop_name": crm.t.domain, "shop_domain": crm.t.domain}

    monkeypatch.setattr(crm_shopify, "probe_connection", fake)
    return fake


@pytest.fixture(autouse=True)
def clean_credentials(client):
    from app import crm_provider, db
    db.execute("DELETE FROM tenant_crm_credentials")
    db.execute("UPDATE tenants SET crm_provider = 'mock' "
               " WHERE slug IN ('c_alpha', 'c_beta')")
    crm_provider.invalidate()
    yield
    crm_provider.invalidate()


def connect(client, headers, slug, domain, token=TOKEN_A):
    return client.put(f"/api/admin/tenants/{slug}/crm", headers=headers,
                      json={"store_domain": domain, "admin_token": token})


# --- sealing -----------------------------------------------------------------

def test_seal_round_trip_and_tenant_binding():
    from app import secrets_box

    blob, kid = secrets_box.seal(TOKEN_A, aad="tenant:one")
    assert secrets_box.open_sealed(blob, aad="tenant:one", expect_key_id=kid) == TOKEN_A
    assert TOKEN_A.encode() not in blob      # not merely encoded — encrypted

    # The move an attacker with database write access would make: copy a sealed
    # token onto another tenant's row so CueSea reads a store it shouldn't.
    with pytest.raises(ValueError):
        secrets_box.open_sealed(blob, aad="tenant:two")


def test_key_rotation_opens_old_rows(monkeypatch):
    from app import secrets_box

    old_key = "11" * 32
    new_key = "22" * 32
    monkeypatch.setenv("CUE_CRED_KEY", old_key)
    blob, old_id = secrets_box.seal(TOKEN_A, aad="t")

    monkeypatch.setenv("CUE_CRED_KEY", new_key)
    monkeypatch.setenv("CUE_CRED_KEY_OLD", old_key)
    assert secrets_box.open_sealed(blob, aad="t", expect_key_id=old_id) == TOKEN_A
    assert secrets_box.status()["key_id"] != old_id

    # Drop the retired key and the old row becomes unreadable — which is the
    # point of the rotation check on the platform page.
    monkeypatch.delenv("CUE_CRED_KEY_OLD")
    with pytest.raises(ValueError):
        secrets_box.open_sealed(blob, aad="t", expect_key_id=old_id)


def test_fingerprint_does_not_leak_the_token():
    from app import secrets_box

    fp = secrets_box.fingerprint(TOKEN_A)
    assert TOKEN_A not in fp
    assert fp.endswith(TOKEN_A[-4:]) is False       # tail is embedded, not trailing
    assert TOKEN_A[-4:] in fp                       # …but is present, for matching
    assert TOKEN_A[:20] not in fp
    assert secrets_box.fingerprint(TOKEN_B) != fp


# --- domain validation (SSRF) ------------------------------------------------

@pytest.mark.parametrize("raw,expected", [
    ("alpha-store", "alpha-store.myshopify.com"),
    ("Alpha-Store.myshopify.com", "alpha-store.myshopify.com"),
    ("https://alpha-store.myshopify.com/admin", "alpha-store.myshopify.com"),
    ("  alpha-store.myshopify.com/  ", "alpha-store.myshopify.com"),
])
def test_domain_normalises(raw, expected):
    from app.crm_credentials import normalize_domain
    assert normalize_domain(raw) == expected


def test_a_bare_word_can_only_ever_become_a_shopify_subdomain():
    """The convenience of typing just a store handle is safe precisely because
    a bare word gets the myshopify.com suffix — `localhost` resolves to
    `localhost.myshopify.com`, which is Shopify's namespace, not ours."""
    from app.crm_credentials import normalize_domain
    assert normalize_domain("localhost") == "localhost.myshopify.com"


@pytest.mark.parametrize("raw", [
    "127.0.0.1",
    "169.254.169.254",                       # cloud metadata service
    "evil.com",
    "shop.myshopify.com.evil.com",
    "alpha.myshopify.com:8080",
    "",
])
def test_domain_rejects_anything_not_a_shopify_store(raw):
    """The service fetches this string. Without a narrow rule it is an SSRF
    primitive pointed at CueSea's own network."""
    from app.crm_credentials import CredentialError, normalize_domain
    with pytest.raises(CredentialError):
        normalize_domain(raw)


# --- the token never comes back out ------------------------------------------

def test_token_is_never_returned_and_is_ciphertext_at_rest(client, auth):
    from app import db

    h = auth("cue@cred.example.com")
    r = connect(client, h, "c_alpha", "alpha-store", TOKEN_A)
    assert r.status_code == 200, r.text
    assert TOKEN_A not in r.text

    for resp in (client.get("/api/admin/tenants/c_alpha/crm", headers=h),
                 client.get("/api/admin/tenants/c_alpha", headers=h),
                 client.post("/api/admin/tenants/c_alpha/crm/test", headers=h)):
        assert resp.status_code == 200, resp.text
        assert TOKEN_A not in resp.text

    cred = r.json()["credential"]
    assert cred["connected"] and cred["store_domain"] == "alpha-store.myshopify.com"
    assert cred["fingerprint"].endswith(TOKEN_A[-4:]) or TOKEN_A[-4:] in cred["fingerprint"]
    # `auth_kind: "admin_token"` is a label and legitimately present; what must
    # not appear is a field carrying the secret itself.
    assert not {"admin_token", "client_secret", "secret_sealed"} & set(cred)

    # And the row itself holds no plaintext.
    row = db.query_one("SELECT * FROM tenant_crm_credentials WHERE tenant_id = "
                       "(SELECT id FROM tenants WHERE slug = 'c_alpha')")
    assert TOKEN_A.encode() not in bytes(row["secret_sealed"])
    assert TOKEN_A not in str(row)


def test_config_blob_is_not_where_the_token_went(client, auth):
    """The tenants.config jsonb is readable *and writable* by a client_admin.
    A credential must never be reachable through it."""
    h = auth("cue@cred.example.com")
    connect(client, h, "c_alpha", "alpha-store", TOKEN_A)

    tenant = client.get("/api/admin/tenants/c_alpha", headers=h).json()["tenant"]
    assert TOKEN_A not in str(tenant.get("config"))
    assert TOKEN_A not in str(tenant)


# --- authorization -----------------------------------------------------------

def test_client_admin_can_connect_their_own_store(client, auth):
    h = auth("a.admin@cred.example.com")
    r = connect(client, h, "c_alpha", "alpha-store", TOKEN_A)
    assert r.status_code == 200, r.text
    assert r.json()["credential"]["connected"]


def test_client_admin_cannot_touch_another_tenant(client, auth):
    a = auth("a.admin@cred.example.com")
    assert client.get("/api/admin/tenants/c_beta/crm", headers=a).status_code == 403
    assert connect(client, a, "c_beta", "beta-store", TOKEN_B).status_code == 403
    assert client.post("/api/admin/tenants/c_beta/crm/test", headers=a).status_code == 403
    assert client.delete("/api/admin/tenants/c_beta/crm", headers=a).status_code == 403


def test_manager_cannot_connect_a_store(client, auth):
    h = auth("a.mgr@cred.example.com")
    assert connect(client, h, "c_alpha", "alpha-store", TOKEN_A).status_code == 403
    assert client.get("/api/admin/tenants/c_alpha/crm", headers=h).status_code == 403


def test_unauthenticated_is_refused(client):
    assert client.get("/api/admin/tenants/c_alpha/crm").status_code == 401
    assert client.put("/api/admin/tenants/c_alpha/crm",
                      json={"store_domain": "x", "admin_token": "y"}).status_code == 401


# --- isolation ---------------------------------------------------------------

def test_two_tenants_get_two_adapters(client, auth):
    """The whole point. Before this change there was one process-wide Shopify
    client, so a second merchant was a second deployment."""
    from app import crm_provider

    connect(client, auth("a.admin@cred.example.com"), "c_alpha", "alpha-store", TOKEN_A)
    connect(client, auth("b.admin@cred.example.com"), "c_beta", "beta-store", TOKEN_B)

    a = crm_provider.get_crm_for("c_alpha")
    b = crm_provider.get_crm_for("c_beta")
    assert a is not b
    assert a.t.domain == "alpha-store.myshopify.com"
    assert b.t.domain == "beta-store.myshopify.com"
    assert a.t._static_token == TOKEN_A
    assert b.t._static_token == TOKEN_B
    # Response caches are per instance, so one merchant's roster can never be
    # served from the other's cache.
    assert a._cache is not b._cache


def test_an_unknown_provider_refuses_instead_of_building_a_shopify_client(
        client, auth, monkeypatch):
    """The trap this guards: `_build` used to construct a ShopifyCRM from any
    credential row without reading `provider`. Harmless with one adapter, and
    silently wrong the day an enterprise row gets handed to the Shopify client.
    Gap is the expected second case — their own cloud, no store domain.
    """
    from app import crm_provider, db

    connect(client, auth("a.admin@cred.example.com"), "c_alpha", "alpha-store", TOKEN_A)

    # Simulate the row a future adapter would write, without writing one.
    db.execute(
        "UPDATE tenant_crm_credentials SET provider = 'gap_enterprise' "
        " WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'c_alpha')"
    )
    crm_provider.invalidate("c_alpha")

    with pytest.raises(crm_provider.TenantNotConfigured) as e:
        crm_provider.get_crm_for("c_alpha")
    assert "gap_enterprise" in str(e.value)
    assert "shopify" in str(e.value)      # names what it *does* have


def test_the_registry_is_what_adds_an_adapter(client, auth):
    """Registering a builder is the whole cost of a new CRM — no change to
    routing, caching, sealing, or tenant isolation."""
    from app import crm_provider

    class FakeEnterpriseCRM:
        def __init__(self, cred, secret):
            self.cred, self.secret = cred, secret

        def all_guests(self): return []
        def get_guest(self, gid): return None
        def floor_inventory(self): return []

    connect(client, auth("a.admin@cred.example.com"), "c_alpha", "alpha-store", TOKEN_A)
    from app import db
    db.execute(
        "UPDATE tenant_crm_credentials SET provider = 'acme' "
        " WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'c_alpha')"
    )
    crm_provider.ADAPTER_BUILDERS["acme"] = FakeEnterpriseCRM
    try:
        crm_provider.invalidate("c_alpha")
        crm = crm_provider.get_crm_for("c_alpha")
        assert isinstance(crm, FakeEnterpriseCRM)
        # The sealed secret still opens — sealing is provider-agnostic.
        assert crm.secret["admin_token"] == TOKEN_A
    finally:
        crm_provider.ADAPTER_BUILDERS.pop("acme", None)
        crm_provider.invalidate("c_alpha")


def test_connecting_takes_the_tenant_off_demo_data_and_disconnect_restores_it(client, auth):
    from app import crm_provider
    from app.crm_provider import MockCRM

    h = auth("a.admin@cred.example.com")
    assert isinstance(crm_provider.get_crm_for("c_alpha"), MockCRM)

    r = connect(client, h, "c_alpha", "alpha-store", TOKEN_A)
    assert r.json()["crm_provider"] == "shopify"
    assert not isinstance(crm_provider.get_crm_for("c_alpha"), MockCRM)

    r = client.delete("/api/admin/tenants/c_alpha/crm", headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["crm_provider"] == "mock"
    assert not r.json()["credential"]["connected"]
    # Back to something an associate can still demo with, not a 503.
    assert isinstance(crm_provider.get_crm_for("c_alpha"), MockCRM)


def test_rotating_a_token_takes_effect_immediately(client, auth):
    from app import crm_provider

    h = auth("a.admin@cred.example.com")
    connect(client, h, "c_alpha", "alpha-store", TOKEN_A)
    assert crm_provider.get_crm_for("c_alpha").t._static_token == TOKEN_A

    connect(client, h, "c_alpha", "alpha-store", TOKEN_B)
    assert crm_provider.get_crm_for("c_alpha").t._static_token == TOKEN_B


# --- test-connection reporting -----------------------------------------------

def test_missing_scopes_are_named(client, auth, monkeypatch):
    from app import crm_shopify

    monkeypatch.setattr(crm_shopify, "probe_connection", lambda crm: {
        "ok": True, "reason": "connected", "detail": "Connected to Alpha.",
        "scopes": ["read_products"], "shop_name": "Alpha", "shop_domain": "x",
    })
    r = connect(client, auth("a.admin@cred.example.com"), "c_alpha", "alpha-store")
    body = r.json()
    assert body["test"]["ok"] is True
    assert set(body["credential"]["missing_required_scopes"]) == {
        "read_customers", "read_orders"}
    assert "read_inventory" in body["credential"]["degraded_without"]


def test_a_rejected_token_is_reported_not_raised(client, auth, monkeypatch):
    from app import crm_shopify

    monkeypatch.setattr(crm_shopify, "probe_connection", lambda crm: {
        "ok": False, "reason": "token_rejected",
        "detail": "The store answered, but rejected this token.", "scopes": [],
    })
    r = connect(client, auth("a.admin@cred.example.com"), "c_alpha", "alpha-store")
    assert r.status_code == 200, r.text          # a failed test is a result
    assert r.json()["test"]["reason"] == "token_rejected"
    assert r.json()["credential"]["last_test_ok"] is False
    # A typo must not take the retailer's floor down: they stay on demo data.
    assert r.json()["crm_provider"] == "mock"


def test_a_fixed_token_recovers_the_tenant_without_a_support_call(client, auth,
                                                                  monkeypatch):
    from app import crm_credentials, crm_provider, crm_shopify
    from app.crm_provider import MockCRM

    h = auth("a.admin@cred.example.com")
    monkeypatch.setattr(crm_shopify, "probe_connection", lambda crm: {
        "ok": False, "reason": "token_rejected", "detail": "no", "scopes": []})
    connect(client, h, "c_alpha", "alpha-store")
    assert isinstance(crm_provider.get_crm_for("c_alpha"), MockCRM)

    # They fix the app in Shopify and press Test — same stored token, and now
    # the store answers.
    monkeypatch.setattr(crm_shopify, "probe_connection", lambda crm: {
        "ok": True, "reason": "connected", "detail": "yes",
        "scopes": list(crm_credentials.REQUIRED_SCOPES),
        "shop_name": "Alpha", "shop_domain": "x"})
    r = client.post("/api/admin/tenants/c_alpha/crm/test", headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["crm_provider"] == "shopify"
    assert not isinstance(crm_provider.get_crm_for("c_alpha"), MockCRM)


def test_probe_distinguishes_failure_modes(monkeypatch):
    """Four ways a merchant gets this wrong, four different sentences.

    `monkeypatch` is function-scoped and shared with the autouse `offline_probe`
    fixture, so undoing it here gets the real implementation back.
    """
    import urllib.error

    monkeypatch.undo()
    from app.crm_shopify import probe_connection

    class Boom:
        def __init__(self, exc):
            self.exc = exc
            self.domain = "alpha-store.myshopify.com"

        def query(self, *a, **k):
            raise self.exc

    def reason(exc):
        crm = type("C", (), {"t": Boom(exc)})()
        return probe_connection(crm)["reason"]

    http = lambda code: urllib.error.HTTPError("u", code, "m", {}, None)  # noqa: E731
    assert reason(http(401)) == "token_rejected"
    assert reason(http(404)) == "store_not_found"
    assert reason(http(429)) == "rate_limited"
    assert reason(urllib.error.URLError("nodename nor servname provided")) == "unreachable"
    assert reason(RuntimeError("Shopify GraphQL error: [...]")) == "api_error"


def test_refuses_to_store_a_token_it_cannot_protect(client, auth, monkeypatch):
    from app import secrets_box

    monkeypatch.setattr(secrets_box, "configured", lambda: False)
    r = connect(client, auth("a.admin@cred.example.com"), "c_alpha", "alpha-store")
    assert r.status_code == 503
    assert "CUE_CRED_KEY" in r.json()["detail"]


def test_bad_domain_is_a_400_with_a_usable_message(client, auth):
    r = connect(client, auth("a.admin@cred.example.com"), "c_alpha", "https://evil.com")
    assert r.status_code == 400
    assert "myshopify.com" in r.json()["detail"]


def test_credentials_without_a_secret_are_refused(client, auth):
    r = client.put("/api/admin/tenants/c_alpha/crm",
                   headers=auth("a.admin@cred.example.com"),
                   json={"store_domain": "alpha-store"})
    assert r.status_code == 400


# --- operational visibility --------------------------------------------------

def test_platform_flags_a_shopify_tenant_with_no_store(client, auth):
    from app import db

    db.execute("UPDATE tenants SET crm_provider = 'shopify' WHERE slug = 'c_alpha'")
    checks = client.get("/api/admin/platform",
                        headers=auth("cue@cred.example.com")).json()["checks"]
    row = next(c for c in checks if c["key"] == "crm_credentials")
    assert row["status"] == "fail" and "c_alpha" in row["detail"]


def test_open_health_route_does_not_publish_the_customer_list(client, auth):
    connect(client, auth("cue@cred.example.com"), "c_alpha", "alpha-store", TOKEN_A)

    body = client.get("/health").json()
    assert "c_alpha" not in str(body["tenants"])
    assert body["tenants"]["ready"] >= 1
    assert body["credential_encryption"]["configured"] is True
    assert "key_id" in body["credential_encryption"]

    # The named breakdown is behind a cue_admin.
    detail = client.get("/api/admin/platform",
                        headers=auth("cue@cred.example.com")).json()
    assert "c_alpha" in detail["service"]["tenants"]
