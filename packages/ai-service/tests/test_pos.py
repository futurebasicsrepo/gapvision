"""POS session-token verification — the till's proof, attacked from each side.

Every test that matters here is a refusal: the one success case is easy, and
the product of this module is the set of things it will not accept.
"""
import base64
import hashlib
import hmac
import json
import time

import pytest
from fastapi.testclient import TestClient

from app import pos
from app.main import app

client = TestClient(app)

SECRET = "shpss_test_secret_000000000000000000"
CLIENT_ID = "client-id-abc123"
DOMAIN = "teststore.myshopify.com"


def _enc(obj: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()


def make_token(payload: dict | None = None, *, secret: str = SECRET,
               header: dict | None = None) -> str:
    h = {"alg": "HS256", "typ": "JWT", **(header or {})}
    p = {
        "dest": f"https://{DOMAIN}",
        "aud": CLIENT_ID,
        "exp": time.time() + 60,
        "nbf": time.time() - 1,
        "sub": "42",
        **(payload or {}),
    }
    signing_input = f"{_enc(h)}.{_enc(p)}"
    sig = base64.urlsafe_b64encode(
        hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
    ).rstrip(b"=").decode()
    return f"{signing_input}.{sig}"


def lookup(domain: str):
    assert domain == DOMAIN
    return ("cuesea", CLIENT_ID, SECRET)


def test_a_good_token_names_its_tenant():
    out = pos.verify_session_token(make_token(), lookup=lookup)
    assert out == {"ok": True, "tenant": "cuesea", "shop_domain": DOMAIN,
                   "user_id": "42"}


def test_a_forged_signature_is_refused():
    with pytest.raises(pos.PosVerifyRefused) as e:
        pos.verify_session_token(make_token(secret="not-the-secret"), lookup=lookup)
    assert e.value.status == 401 and "signature" in e.value.detail


def test_the_algorithm_is_pinned():
    """`alg: none` is the classic JWT bypass; a pinned verifier never reads it."""
    with pytest.raises(pos.PosVerifyRefused):
        pos.verify_session_token(make_token(header={"alg": "none"}), lookup=lookup)
    with pytest.raises(pos.PosVerifyRefused):
        pos.verify_session_token(make_token(header={"alg": "RS256"}), lookup=lookup)


def test_an_expired_token_is_refused_but_leeway_holds():
    with pytest.raises(pos.PosVerifyRefused) as e:
        pos.verify_session_token(
            make_token({"exp": time.time() - 60}), lookup=lookup)
    assert "expired" in e.value.detail
    # Ten seconds of clock skew is a till, not an attack.
    out = pos.verify_session_token(
        make_token({"exp": time.time() - pos.LEEWAY_SECONDS + 2}), lookup=lookup)
    assert out["ok"] is True


def test_a_token_for_another_app_is_refused():
    with pytest.raises(pos.PosVerifyRefused) as e:
        pos.verify_session_token(
            make_token({"aud": "some-other-app"}), lookup=lookup)
    assert "different app" in e.value.detail


def test_a_token_naming_no_shopify_store_is_refused():
    with pytest.raises(pos.PosVerifyRefused):
        pos.verify_session_token(
            make_token({"dest": "https://evil.example.com"}), lookup=lookup)


def test_malformed_tokens_are_refusals_not_crashes():
    for bad in ("", "a.b", "a.b.c", "not a token at all", "..", None):
        with pytest.raises(pos.PosVerifyRefused):
            pos.verify_session_token(bad, lookup=lookup)  # type: ignore[arg-type]


def test_the_lookup_refusal_passes_through():
    def refuse(domain):
        raise pos.PosVerifyRefused(401, "No Cue tenant is connected to that store.")
    with pytest.raises(pos.PosVerifyRefused) as e:
        pos.verify_session_token(make_token(), lookup=refuse)
    assert e.value.status == 401


# --- the endpoint's own door -------------------------------------------------

def test_endpoint_requires_the_service_key():
    r = client.post("/api/pos/verify", json={"token": make_token()})
    assert r.status_code == 401


def test_endpoint_without_a_database_says_so(auth_headers):
    """The sandbox has no control plane; the refusal must be the 503 sentence,
    never a 500 — a till mid-shift reads sentences, not stack traces."""
    r = client.post("/api/pos/verify", headers=auth_headers,
                    json={"token": make_token()})
    assert r.status_code == 503
    assert "database" in r.json()["detail"].lower()
