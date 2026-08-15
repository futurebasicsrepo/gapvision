"""Seed the control plane.

    python -m app.seed                 # tenants + a CueSea admin, idempotent
    python -m app.seed --demo          # also a store manager and associates

Idempotent by design: safe to run against a database that already has data,
so it can be used to bootstrap production (tenants + the first admin) and to
reset a demo without dropping anything.

Passwords come from the environment. There are no default credentials — a
seeded admin with a known password is a back door, not a convenience.
"""
from __future__ import annotations

import argparse
import os
import secrets

from . import db, identity

TENANTS = [
    {
        "slug": "gap",
        "name": "Gap — demo",
        "crm_provider": "mock",
        "billing_plan": "demo",
    },
    {
        "slug": "shopify",
        "name": "Future Basics",
        "crm_provider": "shopify",
        "billing_plan": "pilot",
    },
]

DEMO_ASSOCIATES = [
    ("alex@example.com", "Alex Rivera"),
    ("jordan@example.com", "Jordan Mills"),
    ("sam@example.com", "Sam Tran"),
]


def ensure_tenant(spec: dict) -> dict:
    existing = db.query_one("SELECT * FROM tenants WHERE slug = %s", (spec["slug"],))
    if existing:
        return existing
    row = db.query_one(
        """
        INSERT INTO tenants (slug, name, crm_provider, billing_plan)
        VALUES (%(slug)s, %(name)s, %(crm_provider)s, %(billing_plan)s)
        RETURNING *
        """,
        spec,
    )
    print(f"  + tenant {spec['slug']}")
    return row


def ensure_user(email: str, name: str, role: str, tenant_id, password: str | None) -> dict:
    existing = db.query_one("SELECT * FROM users WHERE lower(email) = lower(%s)", (email,))
    if existing:
        return existing
    row = identity.create_user(
        email=email, name=name, role=role, tenant_id=tenant_id, password=password
    )
    print(f"  + {role} {email}")
    return row


def bootstrap() -> None:
    """Idempotent boot-time seed, for platforms with no shell.

    Railway gives no console to run `python -m app.seed` in, so a deploy would
    otherwise come up with a working database and no way to log into it. This
    runs on startup and is a no-op once things exist.

    Creating the first admin requires BOTH env vars to be set explicitly. No
    default password is ever generated here — a publicly reachable service
    that mints an account with a guessable password is a back door, and unlike
    the CLI path there is nobody watching stdout to catch what it chose.
    """
    for spec in TENANTS:
        ensure_tenant(spec)

    email = os.environ.get("CUE_ADMIN_EMAIL")
    password = os.environ.get("CUE_ADMIN_PASSWORD")
    if not email or not password:
        if not db.query_one("SELECT id FROM users WHERE role = 'cue_admin' LIMIT 1"):
            print(
                "[cue] no admin account yet — set CUE_ADMIN_EMAIL and "
                "CUE_ADMIN_PASSWORD to create the first one on next boot",
                flush=True,
            )
        return

    existing = db.query_one("SELECT id FROM users WHERE lower(email) = lower(%s)", (email,))
    if existing:
        return
    identity.create_user(
        email=email, name=os.environ.get("CUE_ADMIN_NAME", "Cue Admin"),
        role="cue_admin", tenant_id=None, password=password,
    )
    print(f"[cue] created first admin: {email}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed the CueSea control plane")
    parser.add_argument("--demo", action="store_true",
                        help="also create a demo manager and associates")
    args = parser.parse_args()

    if not db.configured():
        raise SystemExit(
            "No database configured. Set CUE_DATABASE_URL (or DATABASE_URL)."
        )

    db.migrate()
    print("Seeding:")

    tenants = {spec["slug"]: ensure_tenant(spec) for spec in TENANTS}

    admin_email = os.environ.get("CUE_ADMIN_EMAIL")
    admin_password = os.environ.get("CUE_ADMIN_PASSWORD")
    if admin_email:
        if not admin_password:
            admin_password = secrets.token_urlsafe(16)
            print(f"  ! generated password for {admin_email}: {admin_password}")
            print("    (shown once — store it in a password manager now)")
        ensure_user(admin_email, os.environ.get("CUE_ADMIN_NAME", "Cue Admin"),
                    "cue_admin", None, admin_password)
    else:
        print("  · set CUE_ADMIN_EMAIL (and optionally CUE_ADMIN_PASSWORD) to "
              "create the first CueSea admin")

    if args.demo:
        gap = tenants["gap"]
        demo_password = os.environ.get("CUE_DEMO_PASSWORD") or secrets.token_urlsafe(12)
        ensure_user("manager@example.com", "Dana Alvarez", "manager", gap["id"], demo_password)
        ensure_user("admin@example.com", "Robin Shah", "client_admin", gap["id"], demo_password)
        for email, name in DEMO_ASSOCIATES:
            ensure_user(email, name, "associate", gap["id"], demo_password)
        print(f"  · demo accounts share the password: {demo_password}")

    print("Done.")


if __name__ == "__main__":
    main()
