"""Per-tenant CRM credentials — store, load, describe.

The one module that ever holds a merchant's Shopify token in the clear, and
only for the moment it takes to seal it or hand it to the transport. Nothing
above this layer sees plaintext: `describe()` is what the API returns, and it
carries a fingerprint rather than a secret.

Read `migrations/002_tenant_crm_credentials.sql` for why this lives in its own
table and why the sealing happens in the application rather than in Postgres.
"""
from __future__ import annotations

import json
import re

from . import db, secrets_box

PROVIDERS = ("shopify",)

# What the adapter actually reads. Kept next to the code that needs them so a
# new query can't quietly start depending on a scope nobody asked the merchant
# for.
REQUIRED_SCOPES = ("read_customers", "read_orders", "read_products")

# Absence degrades a feature rather than breaking the connection, so these are
# reported separately instead of failing the test.
OPTIONAL_SCOPES = {
    "read_inventory": "live floor stock counts",
    "read_all_orders": "order history older than 60 days",
}

# A merchant admin supplies this string and the service then fetches it. Without
# a strict shape that is a server-side request forgery primitive: point it at an
# internal address and CueSea becomes a proxy into its own network. Shopify store
# domains are always <handle>.myshopify.com, so the narrow rule costs nothing.
_DOMAIN_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$")


class CredentialError(ValueError):
    """Bad input from an operator — safe to show them verbatim."""


def normalize_domain(raw: str) -> str:
    """Accept what people actually paste: a URL, a trailing slash, mixed case."""
    d = (raw or "").strip().lower()
    d = re.sub(r"^https?://", "", d)
    d = d.split("/")[0].split("?")[0].strip().rstrip(".")
    if not d:
        raise CredentialError("Store domain is required")
    if "." not in d:
        d = f"{d}.myshopify.com"   # they typed just the handle
    if not _DOMAIN_RE.match(d):
        raise CredentialError(
            f"'{d}' is not a Shopify store domain. Use the permanent "
            "<store>.myshopify.com address, not a custom domain — you'll find "
            "it in Shopify admin under Settings → Domains."
        )
    return d


def _aad(tenant_id) -> str:
    """Binds a ciphertext to its tenant, so a row moved between tenants in the
    database fails to open instead of silently pointing CueSea at another store."""
    return f"cue-crm-cred:tenant:{tenant_id}"


# --- write -------------------------------------------------------------------

def save(
    *,
    tenant_id,
    store_domain: str,
    admin_token: str | None = None,
    client_id: str | None = None,
    client_secret: str | None = None,
    provider: str = "shopify",
    created_by=None,
) -> dict:
    """Seal and store. Replaces any existing credential for this tenant."""
    if provider not in PROVIDERS:
        raise CredentialError(f"Unsupported CRM provider: {provider}")

    domain = normalize_domain(store_domain)

    admin_token = (admin_token or "").strip()
    client_id = (client_id or "").strip()
    client_secret = (client_secret or "").strip()

    # Deliberately no check on the token's shape. Shopify has changed its prefix
    # before, and refusing a valid token is a worse failure than accepting an odd
    # one — the connection test is the real check, and it runs immediately.
    if admin_token:
        auth_kind = "admin_token"
        payload = {"admin_token": admin_token}
        primary = admin_token
    elif client_id and client_secret:
        auth_kind = "client_credentials"
        payload = {"client_id": client_id, "client_secret": client_secret}
        primary = client_secret
    else:
        raise CredentialError(
            "Provide either an Admin API access token, or both a client ID and "
            "client secret."
        )

    sealed, kid = secrets_box.seal(json.dumps(payload), aad=_aad(tenant_id))

    row = db.query_one(
        """
        INSERT INTO tenant_crm_credentials
               (tenant_id, provider, store_domain, auth_kind,
                secret_sealed, key_id, fingerprint, created_by)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (tenant_id) DO UPDATE SET
               provider         = EXCLUDED.provider,
               store_domain     = EXCLUDED.store_domain,
               auth_kind        = EXCLUDED.auth_kind,
               secret_sealed    = EXCLUDED.secret_sealed,
               key_id           = EXCLUDED.key_id,
               fingerprint      = EXCLUDED.fingerprint,
               -- A new credential has not been tested, whatever the old one did.
               scopes           = '{}',
               last_tested_at   = NULL,
               last_test_ok     = NULL,
               last_test_detail = NULL,
               updated_at       = now()
        RETURNING *
        """,
        (tenant_id, provider, domain, auth_kind, sealed, kid,
         secrets_box.fingerprint(primary), created_by),
    )
    return row


def delete(tenant_id) -> bool:
    return db.execute(
        "DELETE FROM tenant_crm_credentials WHERE tenant_id = %s", (tenant_id,)
    ) > 0


def record_test(tenant_id, *, ok: bool, scopes: list[str], detail: str) -> None:
    db.execute(
        """
        UPDATE tenant_crm_credentials
           SET scopes = %s, last_tested_at = now(),
               last_test_ok = %s, last_test_detail = %s
         WHERE tenant_id = %s
        """,
        (list(scopes), ok, detail[:500], tenant_id),
    )


# --- read --------------------------------------------------------------------

def get_row(tenant_id) -> dict | None:
    return db.query_one(
        "SELECT * FROM tenant_crm_credentials WHERE tenant_id = %s", (tenant_id,)
    )


def load_secret(row: dict) -> dict:
    """Open the sealed payload. Callers must not log or return the result."""
    plain = secrets_box.open_sealed(
        row["secret_sealed"],
        aad=_aad(row["tenant_id"]),
        expect_key_id=row.get("key_id"),
    )
    return json.loads(plain)


def describe(row: dict | None) -> dict:
    """The only shape that crosses an API boundary. No secret, ever."""
    if row is None:
        return {"connected": False}

    present = set(row.get("scopes") or [])
    missing = [s for s in REQUIRED_SCOPES if s not in present]
    degraded = {
        scope: why for scope, why in OPTIONAL_SCOPES.items() if scope not in present
    }
    return {
        "connected": True,
        "provider": row["provider"],
        "store_domain": row["store_domain"],
        "auth_kind": row["auth_kind"],
        "fingerprint": row["fingerprint"],
        "key_id": row["key_id"],
        "scopes": sorted(present),
        "missing_required_scopes": missing,
        # Optional scopes that weren't granted: the connection works and a named
        # feature won't. Worth saying out loud rather than letting a merchant
        # discover it as "the stock numbers look wrong".
        "degraded_without": degraded,
        "last_tested_at": row.get("last_tested_at"),
        "last_test_ok": row.get("last_test_ok"),
        "last_test_detail": row.get("last_test_detail"),
        "updated_at": row.get("updated_at"),
    }
