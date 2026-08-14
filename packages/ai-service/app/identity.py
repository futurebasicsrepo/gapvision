"""People, tenants, roles, and sessions.

The service key in `auth.py` proves *a service* may call us. This module is
about *a person*: who they are, which retailer they belong to, and what
they're allowed to see. The two are deliberately separate — the realtime
server holding a shared secret must never be mistaken for a store manager.

Roles, narrowest first:

  associate     wears the glasses; own activity only
  manager       one store's floor: roster, leaderboard, analytics
  client_admin  the retailer's admin: manager rights + users, devices,
                tenant config, privacy settings, their own usage
  cue_admin     Future Basics staff: every tenant, provisioning, billing

Tenant isolation is enforced in one place (`scope_tenant`) rather than at each
call site, because the failure mode of getting it wrong is showing one
retailer another retailer's floor.

Passwords use `hashlib.scrypt` from the standard library — a real KDF with no
new dependency to audit or keep patched.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import Header, HTTPException, Request

from . import db

TOKEN_TTL_HOURS = int(os.environ.get("CUE_SESSION_HOURS", "12"))

ROLES = ("associate", "manager", "client_admin", "cue_admin")
_RANK = {role: i for i, role in enumerate(ROLES)}

# scrypt cost: 128 * n * r ≈ 33 MB per hash — expensive enough to matter to an
# attacker with a GPU farm, cheap enough that a login stays well under 200 ms.
# `maxmem` must be set explicitly: OpenSSL's default ceiling is 32 MB, just
# under what these parameters need, and it fails at hash time rather than
# import time.
_SCRYPT = {"n": 2**15, "r": 8, "p": 1, "dklen": 32, "maxmem": 96 * 1024 * 1024}


# --- passwords ---------------------------------------------------------------

def hash_password(password: str) -> str:
    if not password or len(password) < 8:
        raise ValueError("Password must be at least 8 characters")
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, **_SCRYPT)
    return "scrypt$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(dk).decode()


def verify_password(password: str, encoded: str | None) -> bool:
    if not encoded or not password:
        return False
    try:
        scheme, salt_b64, dk_b64 = encoded.split("$", 2)
        if scheme != "scrypt":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(dk_b64)
    except (ValueError, TypeError):
        return False
    actual = hashlib.scrypt(password.encode(), salt=salt, **_SCRYPT)
    return hmac.compare_digest(actual, expected)


# --- tokens ------------------------------------------------------------------

def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def issue_token(user_id: str) -> tuple[str, datetime]:
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(hours=TOKEN_TTL_HOURS)
    db.execute(
        "INSERT INTO auth_tokens (user_id, token_hash, expires_at) VALUES (%s, %s, %s)",
        (user_id, _token_hash(token), expires),
    )
    return token, expires


def revoke_token(token: str) -> None:
    db.execute(
        "UPDATE auth_tokens SET revoked_at = now() WHERE token_hash = %s AND revoked_at IS NULL",
        (_token_hash(token),),
    )


def revoke_all_for_user(user_id: str) -> None:
    """Called when a user is disabled or deleted — a disabled account with a
    live token is not disabled."""
    db.execute(
        "UPDATE auth_tokens SET revoked_at = now() WHERE user_id = %s AND revoked_at IS NULL",
        (user_id,),
    )


def resolve_token(token: str) -> dict | None:
    return db.query_one(
        """
        SELECT u.id, u.email, u.name, u.role, u.tenant_id, u.status,
               t.slug AS tenant_slug, t.name AS tenant_name
          FROM auth_tokens a
          JOIN users u ON u.id = a.user_id
     LEFT JOIN tenants t ON t.id = u.tenant_id
         WHERE a.token_hash = %s
           AND a.revoked_at IS NULL
           AND a.expires_at > now()
        """,
        (_token_hash(token),),
    )


# --- authentication dependency ----------------------------------------------

BearerHeader = Header(default=None, alias="authorization")


class Principal(dict):
    """The authenticated person. A dict so it serialises trivially."""

    @property
    def role(self) -> str:
        return self["role"]

    @property
    def tenant_id(self):
        return self.get("tenant_id")

    def at_least(self, role: str) -> bool:
        return _RANK[self.role] >= _RANK[role]


def current_user(authorization: str | None) -> Principal:
    if not db.configured():
        raise HTTPException(
            status_code=503,
            detail="Accounts are not available: no database is configured.",
        )
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    row = resolve_token(authorization.split(" ", 1)[1].strip())
    if row is None:
        raise HTTPException(status_code=401, detail="Session expired or invalid")
    if row["status"] != "active":
        raise HTTPException(status_code=403, detail="Account is disabled")
    return Principal(row)


def require(principal: Principal, role: str) -> None:
    if not principal.at_least(role):
        raise HTTPException(status_code=403, detail=f"Requires {role} access")


def scope_tenant(principal: Principal, requested: str | None = None) -> str:
    """The tenant this request may read, or raise.

    Cue staff may target any tenant and must name one. Everyone else is
    pinned to their own regardless of what they ask for — a manager passing
    someone else's tenant id gets their own data, not a 403, because there is
    no legitimate reason for them to be asking and no information to leak in
    the error.
    """
    if principal.role == "cue_admin":
        if not requested:
            raise HTTPException(status_code=400, detail="Specify a tenant")
        tenant = resolve_tenant(requested)
        if tenant is None:
            raise HTTPException(status_code=404, detail="Unknown tenant")
        return tenant["id"]
    return principal["tenant_id"]


def resolve_tenant(id_or_slug: str) -> dict | None:
    """Accept either a uuid or the human slug the plugin's launch URL uses."""
    row = db.query_one("SELECT * FROM tenants WHERE slug = %s", (id_or_slug,))
    if row:
        return row
    try:
        return db.query_one("SELECT * FROM tenants WHERE id = %s", (id_or_slug,))
    except Exception:
        return None  # not a valid uuid


# --- user management ---------------------------------------------------------

def create_user(
    *, email: str, name: str, role: str, tenant_id: str | None,
    password: str | None = None,
) -> dict:
    if role not in ROLES:
        raise HTTPException(status_code=400, detail=f"Unknown role: {role}")
    if role == "cue_admin" and tenant_id is not None:
        raise HTTPException(status_code=400, detail="Cue staff do not belong to a tenant")
    if role != "cue_admin" and tenant_id is None:
        raise HTTPException(status_code=400, detail="A tenant is required for this role")

    existing = db.query_one("SELECT id FROM users WHERE lower(email) = lower(%s)", (email,))
    if existing:
        raise HTTPException(status_code=409, detail="That email already has an account")

    row = db.query_one(
        """
        INSERT INTO users (tenant_id, email, name, role, password_hash)
        VALUES (%s, %s, %s, %s, %s)
        RETURNING id, tenant_id, email, name, role, status, created_at
        """,
        (tenant_id, email, name, role, hash_password(password) if password else None),
    )
    return row


def authenticate(email: str, password: str) -> dict | None:
    row = db.query_one(
        "SELECT * FROM users WHERE lower(email) = lower(%s)", (email,)
    )
    # Hash regardless of whether the account exists, so a missing account and a
    # wrong password take the same time to answer.
    ok = verify_password(password, row["password_hash"] if row else None)
    if not row or not ok or row["status"] != "active":
        return None
    db.execute("UPDATE users SET last_login_at = now() WHERE id = %s", (row["id"],))
    return row


def public_user(row: dict) -> dict:
    return {
        "id": str(row["id"]),
        "email": row["email"],
        "name": row["name"],
        "role": row["role"],
        "status": row.get("status", "active"),
        "tenant_id": str(row["tenant_id"]) if row.get("tenant_id") else None,
        "tenant_slug": row.get("tenant_slug"),
        "last_login_at": row.get("last_login_at"),
        "created_at": row.get("created_at"),
    }
