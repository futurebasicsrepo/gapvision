"""POS session-token verification — how the merchant's till proves itself.

Path A of `claude/lens-payments.md`: a Cue extension inside Shopify POS pulls
the live Lens engagement into the till's cart, so the associate's last act at
the POS is one tap on Charge. Before the realtime server will hand that
extension anything, the extension has to prove which store it is — and it
can, because Shopify signs a session token (a JWT) for every extension call
with the *app's own client secret*, and the merchant already pasted that
secret into Cue Console when they connected their Dev-Dashboard app.

So the proof chain is: token's `dest` names the shop → the shop names the
tenant (one credentials row per store) → the tenant's sealed secret checks
the signature. A token signed by anything but that store's own app fails on
the only copy of the secret that matters, which is the one the merchant gave
us. Merchants still on a legacy admin-token connection have no client secret
on file, and are refused with the sentence that says exactly that.

Verification is ~20 lines of stdlib hmac. Deliberately no JWT dependency:
the alg is pinned to HS256, and a library that honours an attacker's `alg`
header is the classic way this check goes wrong.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

from . import crm_credentials, db

#: Clock skew allowance. Shopify session tokens live for one minute; a till
#: whose clock is ten seconds out is a till, not an attacker.
LEEWAY_SECONDS = 10


class PosVerifyRefused(Exception):
    """A refusal with a sentence. `status` maps onto HTTP."""

    def __init__(self, status: int, detail: str):
        self.status = status
        self.detail = detail
        super().__init__(detail)


def _b64url(seg: str) -> bytes:
    pad = "=" * (-len(seg) % 4)
    try:
        return base64.urlsafe_b64decode(seg + pad)
    except Exception:
        raise PosVerifyRefused(401, "Malformed session token.")


def _credentials_for_domain(domain: str) -> tuple[str, str, str]:
    """(tenant_slug, client_id, client_secret) for this shop, or a refusal.

    Split out so tests can stand in a store without a database. The join runs
    on `store_domain`, which `crm_credentials.save` normalised — one row per
    tenant, one store per row, so a domain names at most one tenant.
    """
    if not db.configured():
        raise PosVerifyRefused(503, "No database — POS handoff is not available.")
    try:
        row = db.query_one(
            """
            SELECT c.tenant_id, c.auth_kind, c.secret_sealed, c.key_id, t.slug
              FROM tenant_crm_credentials c
              JOIN tenants t ON t.id = c.tenant_id
             WHERE c.store_domain = %s
            """,
            (domain,),
        )
    except Exception:
        raise PosVerifyRefused(503, "Could not read tenant credentials right now.")
    if row is None:
        raise PosVerifyRefused(
            401, f"No Cue tenant is connected to {domain}. Connect the store "
                 f"in Console → Tenants first.")
    if row["auth_kind"] != "client_credentials":
        raise PosVerifyRefused(
            401, "This store is connected with a legacy admin token, which "
                 "carries no client secret to check a POS token against. "
                 "Reconnect in Console with the app's client ID and secret.")
    try:
        secret = crm_credentials.load_secret(row)
    except Exception:
        raise PosVerifyRefused(503, "The stored credential could not be opened.")
    return row["slug"], secret.get("client_id") or "", secret.get("client_secret") or ""


def verify_session_token(token: str, *, now: float | None = None,
                         lookup=_credentials_for_domain) -> dict:
    """The claims Cue acts on, or a refusal. Never returns a half-answer.

    Checks, in order: shape, shop→tenant mapping, signature (against that
    tenant's secret and no other), audience (that tenant's client id), and
    the clock. The signature comes before the clock on purpose — an expiry
    read from an unverified payload is an attacker-controlled expiry.
    """
    parts = (token or "").strip().split(".")
    if len(parts) != 3 or not all(parts):
        raise PosVerifyRefused(401, "Malformed session token.")
    header_b64, payload_b64, sig_b64 = parts

    header = _parse(_b64url(header_b64))
    if header.get("alg") != "HS256":
        # Pinned. A token that asks to be verified some other way is not a
        # Shopify session token, whatever else it is.
        raise PosVerifyRefused(401, "Unsupported token algorithm.")

    payload = _parse(_b64url(payload_b64))
    dest = str(payload.get("dest") or "")
    domain = dest.removeprefix("https://").split("/")[0].strip().lower()
    if not domain.endswith(".myshopify.com"):
        raise PosVerifyRefused(401, "The token names no Shopify store.")

    tenant, client_id, client_secret = lookup(domain)
    if not client_secret:
        raise PosVerifyRefused(503, "The stored credential carries no client secret.")

    expected = hmac.new(
        client_secret.encode(),
        f"{header_b64}.{payload_b64}".encode(),
        hashlib.sha256,
    ).digest()
    if not hmac.compare_digest(expected, _b64url(sig_b64)):
        raise PosVerifyRefused(401, "The token's signature does not check out "
                                    "against this store's app secret.")

    aud = payload.get("aud")
    audiences = aud if isinstance(aud, list) else [aud]
    if client_id and client_id not in [str(a) for a in audiences]:
        raise PosVerifyRefused(401, "The token was minted for a different app.")

    t = now if now is not None else time.time()
    try:
        exp = float(payload.get("exp") or 0)
        nbf = float(payload.get("nbf") or 0)
    except (TypeError, ValueError):
        raise PosVerifyRefused(401, "Malformed token clock claims.")
    if exp and t > exp + LEEWAY_SECONDS:
        raise PosVerifyRefused(401, "The session token has expired — the POS "
                                    "extension fetches a fresh one per call.")
    if nbf and t < nbf - LEEWAY_SECONDS:
        raise PosVerifyRefused(401, "The session token is not valid yet.")

    return {
        "ok": True,
        "tenant": tenant,
        "shop_domain": domain,
        "user_id": str(payload.get("sub") or ""),
    }


def _parse(raw: bytes) -> dict:
    try:
        out = json.loads(raw)
    except Exception:
        raise PosVerifyRefused(401, "Malformed session token.")
    if not isinstance(out, dict):
        raise PosVerifyRefused(401, "Malformed session token.")
    return out
