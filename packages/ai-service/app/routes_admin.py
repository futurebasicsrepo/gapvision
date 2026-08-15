"""Admin surfaces — two audiences, one router.

  client_admin  their own retailer: users, devices, tenant config, privacy
  cue_admin     Future Basics: every tenant, provisioning, billing

Tenant scoping goes through `identity.scope_tenant` on every route rather than
being re-derived per handler. The failure mode of getting it wrong is showing
one retailer another retailer's floor, so it is worth having exactly one place
to read.
"""
import os
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, EmailStr

from . import (analytics, crm_credentials, crm_provider, db, identity,
               mailer, retention, secrets_box)
from .identity import BearerHeader, current_user, require, scope_tenant

router = APIRouter(prefix="/api/admin", tags=["admin"])


def _own_tenant(me, id_or_slug: str) -> dict:
    """Resolve a tenant this principal is allowed to administer, or raise.

    Cue staff reach any tenant; a client_admin reaches exactly their own. Same
    check as the tenant routes below, factored out because every credential
    route needs it and one of them getting it wrong hands a merchant's store to
    another merchant.
    """
    tenant = identity.resolve_tenant(id_or_slug)
    if tenant is None:
        raise HTTPException(status_code=404, detail="Unknown tenant")
    if me.role != "cue_admin" and str(tenant["id"]) != str(me.tenant_id):
        raise HTTPException(status_code=403, detail="Not your tenant")
    return tenant


# --- tenants (Cue staff) -----------------------------------------------------

class TenantCreate(BaseModel):
    slug: str
    name: str
    crm_provider: str = "mock"
    billing_plan: str = "pilot"


class TenantUpdate(BaseModel):
    name: str | None = None
    crm_provider: str | None = None
    billing_plan: str | None = None
    status: str | None = None
    config: dict | None = None
    privacy: dict | None = None


@router.get("/tenants")
def list_tenants(days: int = 30, authorization: str | None = BearerHeader):
    me = current_user(authorization)
    require(me, "cue_admin")
    return {"tenants": analytics.usage_all_tenants(days), "window_days": days}


@router.post("/tenants", status_code=201)
def create_tenant(req: TenantCreate, authorization: str | None = BearerHeader):
    me = current_user(authorization)
    require(me, "cue_admin")
    slug = req.slug.strip().lower()
    if not slug.isidentifier() and not slug.replace("-", "").isalnum():
        raise HTTPException(status_code=400, detail="Slug must be alphanumeric or hyphenated")
    if db.query_one("SELECT id FROM tenants WHERE slug = %s", (slug,)):
        raise HTTPException(status_code=409, detail="That slug is taken")
    row = db.query_one(
        """
        INSERT INTO tenants (slug, name, crm_provider, billing_plan)
        VALUES (%s, %s, %s, %s)
        RETURNING *
        """,
        (slug, req.name, req.crm_provider, req.billing_plan),
    )
    return {"tenant": row}


@router.get("/tenants/{id_or_slug}")
def get_tenant(id_or_slug: str, authorization: str | None = BearerHeader):
    me = current_user(authorization)
    require(me, "client_admin")
    tenant = identity.resolve_tenant(id_or_slug)
    if tenant is None:
        raise HTTPException(status_code=404, detail="Unknown tenant")
    if me.role != "cue_admin" and str(tenant["id"]) != str(me.tenant_id):
        raise HTTPException(status_code=403, detail="Not your tenant")
    return {"tenant": tenant}


@router.patch("/tenants/{id_or_slug}")
def update_tenant(id_or_slug: str, req: TenantUpdate,
                  authorization: str | None = BearerHeader):
    me = current_user(authorization)
    require(me, "client_admin")
    tenant = identity.resolve_tenant(id_or_slug)
    if tenant is None:
        raise HTTPException(status_code=404, detail="Unknown tenant")
    if me.role != "cue_admin" and str(tenant["id"]) != str(me.tenant_id):
        raise HTTPException(status_code=403, detail="Not your tenant")

    # A retailer's admin controls their own privacy posture and display config.
    # Status and billing plan are commercial terms — Cue side only.
    allowed = {"name", "config", "privacy"}
    if me.role == "cue_admin":
        allowed |= {"crm_provider", "billing_plan", "status"}

    fields = {k: v for k, v in req.model_dump(exclude_none=True).items() if k in allowed}
    if not fields:
        raise HTTPException(status_code=400, detail="Nothing to update")

    sets, params = [], []
    for key, value in fields.items():
        if key in ("config", "privacy"):
            sets.append(f"{key} = %s::jsonb")
            import json
            params.append(json.dumps(value))
        else:
            sets.append(f"{key} = %s")
            params.append(value)
    params.append(tenant["id"])
    row = db.query_one(
        f"UPDATE tenants SET {', '.join(sets)}, updated_at = now() WHERE id = %s RETURNING *",
        tuple(params),
    )
    return {"tenant": row}


# --- CRM credentials ---------------------------------------------------------
#
# A merchant's Shopify Admin token can read every customer, order, and price in
# their store. Three rules hold across all four routes below:
#
#   1. The plaintext token is accepted, sealed, and forgotten. No route returns
#      it, and `crm_credentials.describe()` is the only shape that goes out.
#   2. A tenant goes live when its stored credential *passes a test* — not when
#      one is merely saved. `crm_provider` is derived from that rather than
#      being a second switch someone has to remember, so a typo leaves the
#      retailer on demo data instead of taking their floor down, and a fixed
#      token flips them over on the next passing test.
#   3. Every write invalidates the adapter cache for that tenant, so a rotated
#      token takes effect on the next request rather than in a minute.

class CrmCredentialIn(BaseModel):
    store_domain: str
    admin_token: str | None = None
    client_id: str | None = None
    client_secret: str | None = None


def _test_and_record(tenant: dict, cred: dict) -> dict:
    """Ask the store who we are, store the answer, refresh the adapter."""
    from .crm_shopify import ShopifyCRM, probe_connection

    try:
        secret = crm_credentials.load_secret(cred)
    except Exception as e:
        return {"ok": False, "reason": "unreadable_credential",
                "detail": f"Stored credential could not be opened: {e}", "scopes": []}

    result = probe_connection(ShopifyCRM(
        domain=cred["store_domain"],
        admin_token=secret.get("admin_token"),
        client_id=secret.get("client_id"),
        client_secret=secret.get("client_secret"),
    ))
    crm_credentials.record_test(
        tenant["id"], ok=result["ok"], scopes=result["scopes"], detail=result["detail"]
    )
    crm_provider.invalidate(tenant["slug"])
    return result


def _sync_provider(tenant: dict, live: bool) -> dict:
    """Keep `tenants.crm_provider` in step with whether the store answers."""
    want = "shopify" if live else "mock"
    if tenant["crm_provider"] == want:
        return tenant
    tenant = db.query_one(
        "UPDATE tenants SET crm_provider = %s, updated_at = now() "
        " WHERE id = %s RETURNING *", (want, tenant["id"]),
    )
    crm_provider.invalidate(tenant["slug"])
    print(f"[cue] tenant {tenant['slug']}: crm_provider → {want}", flush=True)
    return tenant


def _crm_payload(tenant: dict, probe: dict | None = None) -> dict:
    row = crm_credentials.get_row(tenant["id"])
    out = {
        "tenant": tenant["slug"],
        "crm_provider": tenant["crm_provider"],
        "credential": crm_credentials.describe(row),
        "required_scopes": list(crm_credentials.REQUIRED_SCOPES),
        "optional_scopes": crm_credentials.OPTIONAL_SCOPES,
        "encryption": secrets_box.status(),
    }
    if probe is not None:
        out["test"] = probe
    return out


@router.get("/tenants/{id_or_slug}/crm")
def get_tenant_crm(id_or_slug: str, authorization: str | None = BearerHeader):
    me = current_user(authorization)
    require(me, "client_admin")
    tenant = _own_tenant(me, id_or_slug)

    payload = _crm_payload(tenant)
    # Be explicit that the legacy single-store path is what's serving this
    # tenant, so nobody spends an afternoon wondering where the data comes from.
    if (not payload["credential"]["connected"]
            and tenant["slug"] == "shopify"
            and crm_provider.env_shopify_configured()):
        payload["legacy_env"] = True
    return payload


@router.put("/tenants/{id_or_slug}/crm")
def connect_tenant_crm(id_or_slug: str, req: CrmCredentialIn,
                       authorization: str | None = BearerHeader):
    """Store a merchant's credentials, then immediately prove they work."""
    me = current_user(authorization)
    require(me, "client_admin")
    tenant = _own_tenant(me, id_or_slug)

    if not secrets_box.configured():
        # Refuse rather than store a token we cannot protect.
        raise HTTPException(
            status_code=503,
            detail=("This service has no credential encryption key, so it will "
                    "not accept a store token. Set CUE_CRED_KEY (openssl rand "
                    "-hex 32) and redeploy."),
        )

    try:
        cred = crm_credentials.save(
            tenant_id=tenant["id"],
            store_domain=req.store_domain,
            admin_token=req.admin_token,
            client_id=req.client_id,
            client_secret=req.client_secret,
            created_by=me["id"],
        )
    except crm_credentials.CredentialError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Who installed which store, and when. The one action in the console that
    # points Cue at a real customer database deserves a line in the log.
    print(f"[cue] tenant {tenant['slug']}: store {cred['store_domain']} "
          f"connected by {me['email']} (key {cred['key_id']})", flush=True)

    probe = _test_and_record(tenant, cred)
    tenant = _sync_provider(tenant, probe["ok"])
    return _crm_payload(tenant, probe)


@router.post("/tenants/{id_or_slug}/crm/test")
def test_tenant_crm(id_or_slug: str, authorization: str | None = BearerHeader):
    me = current_user(authorization)
    require(me, "client_admin")
    tenant = _own_tenant(me, id_or_slug)

    cred = crm_credentials.get_row(tenant["id"])
    if cred is None:
        raise HTTPException(status_code=404, detail="No store is connected to this tenant")

    # A passing retest is how a tenant recovers after a bad token: fix it in
    # Shopify, press Test, and this flips them back to live without a support
    # call. A failing one drops them to demo data rather than to an error.
    probe = _test_and_record(tenant, cred)
    tenant = _sync_provider(tenant, probe["ok"])
    return _crm_payload(tenant, probe)


@router.delete("/tenants/{id_or_slug}/crm")
def disconnect_tenant_crm(id_or_slug: str, authorization: str | None = BearerHeader):
    me = current_user(authorization)
    require(me, "client_admin")
    tenant = _own_tenant(me, id_or_slug)

    crm_credentials.delete(tenant["id"])
    print(f"[cue] tenant {tenant['slug']}: store disconnected by {me['email']}",
          flush=True)
    # Back to the demo dataset rather than to a 503: a disconnected tenant
    # should degrade to something an associate can still demo with.
    tenant = _sync_provider(tenant, live=False)
    return _crm_payload(tenant)


# --- users -------------------------------------------------------------------

class UserCreate(BaseModel):
    email: EmailStr
    name: str
    role: str = "associate"
    password: str | None = None
    tenant: str | None = None   # cue_admin only


class UserUpdate(BaseModel):
    name: str | None = None
    role: str | None = None
    status: str | None = None
    password: str | None = None


@router.get("/users")
def list_users(tenant: str | None = None, authorization: str | None = BearerHeader):
    me = current_user(authorization)
    require(me, "manager")   # managers may see the roster, not change it
    tenant_id = scope_tenant(me, tenant)
    rows = db.query(
        """
        SELECT id, tenant_id, email, name, role, status, created_at, last_login_at
          FROM users WHERE tenant_id = %s ORDER BY role, name
        """,
        (tenant_id,),
    )
    return {"users": [identity.public_user(r) for r in rows]}


@router.get("/staff")
def list_staff(authorization: str | None = BearerHeader):
    """Cue staff — the accounts with no tenant.

    Its own route rather than a flag on /users, deliberately. That endpoint is
    manager-and-up and tenant-scoped by construction: scope_tenant() refuses a
    cue_admin who names no tenant, and the query filters on tenant_id. Teaching
    it to return rows outside a tenant would put a hole in the one function
    every other read in this file depends on, to save a route.
    """
    me = current_user(authorization)
    require(me, "cue_admin")
    rows = db.query(
        """
        SELECT id, tenant_id, email, name, role, status, created_at, last_login_at
          FROM users WHERE tenant_id IS NULL ORDER BY name
        """
    )
    return {"staff": [identity.public_user(r) for r in rows]}


@router.post("/users", status_code=201)
def create_user(req: UserCreate, authorization: str | None = BearerHeader):
    me = current_user(authorization)
    require(me, "client_admin")

    if req.role == "cue_admin":
        # Only Cue staff can mint Cue staff, and never inside a tenant.
        require(me, "cue_admin")
        tenant_id = None
    else:
        tenant_id = scope_tenant(me, req.tenant)
        # A client_admin must not be able to create an account more powerful
        # than their own.
        if not me.at_least(req.role):
            raise HTTPException(status_code=403, detail="Cannot create a role above your own")

    row = identity.create_user(
        email=req.email, name=req.name, role=req.role,
        tenant_id=tenant_id, password=req.password,
    )

    # No password given means "invite them", not "create an account nobody can
    # sign in to". That was the old behaviour and it left staff reading
    # passwords out loud over Slack to get someone in, which is worse than
    # having no invite flow at all — it teaches people to accept credentials
    # through channels that should never carry them.
    invited = None
    if not req.password:
        token, hours = identity.issue_password_link(str(row["id"]), "invite")
        tenant_name = None
        if tenant_id:
            t = db.query_one("SELECT name FROM tenants WHERE id = %s", (tenant_id,))
            tenant_name = t["name"] if t else None
        sent = mailer.send_invite(
            to=row["email"], name=row["name"], role=row["role"],
            token=token, tenant_name=tenant_name, hours=hours,
        )
        # Reported so the console can say "invited" rather than implying it.
        # Unlike /auth/forgot there is no enumeration concern here: the caller
        # already knows the account exists, having just created it.
        invited = {"sent": bool(sent.get("delivered")),
                   "provider": sent.get("provider"),
                   "expires_hours": hours}

    return {"user": identity.public_user(row), "invite": invited}


@router.post("/users/{user_id}/invite")
def resend_invite(user_id: str, authorization: str | None = BearerHeader):
    """Send a fresh set-password link to somebody who never used theirs.

    Separate from creation because the common case is not "create again" — it
    is a link that expired over a long weekend, or an address that was typed
    wrong and has since been fixed. Minting a new one burns the old.
    """
    me = current_user(authorization)
    require(me, "client_admin")
    row = db.query_one("SELECT * FROM users WHERE id = %s", (user_id,))
    if row is None:
        raise HTTPException(status_code=404, detail="No such user")
    # 404 rather than 403 for someone else's tenant: a client_admin probing ids
    # should not be able to learn that an account exists elsewhere.
    if me.role != "cue_admin":
        if row["role"] == "cue_admin" or str(row["tenant_id"]) != str(me.tenant_id):
            raise HTTPException(status_code=404, detail="No such user")
    if not me.at_least(row["role"]):
        raise HTTPException(status_code=403, detail="Cannot invite a role above your own")

    kind = "invite" if row["password_hash"] is None else "reset"
    token, hours = identity.issue_password_link(str(row["id"]), kind)
    tenant_name = None
    if row["tenant_id"]:
        t = db.query_one("SELECT name FROM tenants WHERE id = %s", (row["tenant_id"],))
        tenant_name = t["name"] if t else None
    sent = (mailer.send_invite(to=row["email"], name=row["name"], role=row["role"],
                               token=token, tenant_name=tenant_name, hours=hours)
            if kind == "invite"
            else mailer.send_reset(to=row["email"], name=row["name"],
                                   role=row["role"], token=token, hours=hours))
    return {"ok": True, "kind": kind, "sent": bool(sent.get("delivered")),
            "provider": sent.get("provider"), "expires_hours": hours}


@router.patch("/users/{user_id}")
def update_user(user_id: str, req: UserUpdate, authorization: str | None = BearerHeader):
    me = current_user(authorization)
    require(me, "client_admin")
    target = db.query_one("SELECT * FROM users WHERE id = %s", (user_id,))
    if target is None:
        raise HTTPException(status_code=404, detail="No such user")
    if me.role != "cue_admin" and str(target["tenant_id"]) != str(me.tenant_id):
        raise HTTPException(status_code=403, detail="Not your tenant")
    if req.role and not me.at_least(req.role):
        raise HTTPException(status_code=403, detail="Cannot grant a role above your own")

    sets, params = [], []
    if req.name:
        sets.append("name = %s"); params.append(req.name)
    if req.role:
        sets.append("role = %s"); params.append(req.role)
    if req.status:
        if req.status not in ("active", "disabled"):
            raise HTTPException(status_code=400, detail="Status must be active or disabled")
        sets.append("status = %s"); params.append(req.status)
    if req.password:
        sets.append("password_hash = %s"); params.append(identity.hash_password(req.password))
    if not sets:
        raise HTTPException(status_code=400, detail="Nothing to update")

    params.append(user_id)
    row = db.query_one(
        f"UPDATE users SET {', '.join(sets)} WHERE id = %s RETURNING *", tuple(params)
    )
    # Disabling an account or changing its password must end live sessions —
    # otherwise "disabled" only takes effect when the token happens to expire.
    if req.status == "disabled" or req.password:
        identity.revoke_all_for_user(user_id)
    return {"user": identity.public_user(row)}


@router.delete("/users/{user_id}")
def delete_user(user_id: str, authorization: str | None = BearerHeader):
    me = current_user(authorization)
    require(me, "client_admin")
    target = db.query_one("SELECT * FROM users WHERE id = %s", (user_id,))
    if target is None:
        raise HTTPException(status_code=404, detail="No such user")
    if me.role != "cue_admin" and str(target["tenant_id"]) != str(me.tenant_id):
        raise HTTPException(status_code=403, detail="Not your tenant")
    if str(target["id"]) == str(me["id"]):
        raise HTTPException(status_code=400, detail="You cannot delete your own account")

    identity.revoke_all_for_user(user_id)
    # Engagements keep their history via ON DELETE SET NULL — deleting a
    # departed associate must not silently rewrite last quarter's numbers.
    db.execute("DELETE FROM users WHERE id = %s", (user_id,))
    return {"ok": True, "deleted": user_id}


# --- devices -----------------------------------------------------------------

class DeviceCreate(BaseModel):
    model: str            # g2 | g1 | ring1
    serial: str
    label: str | None = None
    user_id: str | None = None
    tenant: str | None = None


@router.post("/mail/test")
def mail_test(authorization: str | None = BearerHeader):
    """Send one real message, because "configured" is not "working".

    `mailer.status()` can only report that three environment variables are set.
    A wrong app password looks identical to a right one until something is
    actually sent — which is exactly how a deployment ends up reporting green
    while every invitation fails silently, and nobody finds out until a new
    colleague says they never got the link.

    Sends to the caller's own address and nowhere else. An endpoint that mails
    an arbitrary recipient is an open relay that happens to have a login on it,
    and this one is reachable by anybody holding a Cue staff token.
    """
    me = current_user(authorization)
    require(me, "cue_admin")

    st = mailer.status()
    to = me.get("email")

    if not st["configured"]:
        return {
            "ok": False, "provider": st["provider"], "to": to,
            "detail": "Not configured, so nothing was attempted. Set "
                      "CUE_SMTP_HOST, CUE_SMTP_USER and CUE_SMTP_PASSWORD on "
                      "the service, then try again.",
        }

    res = mailer.send_test(to=to, name=me.get("name"))
    if res.get("delivered"):
        return {
            "ok": True, "provider": "smtp", "to": to,
            "detail": f"Accepted by {st['host']} for delivery to {to}, sent as "
                      f"{st['from']}. If it hasn't arrived in a minute look in "
                      f"spam before changing anything — the server took it.",
        }

    return {
        "ok": False, "provider": res.get("provider"), "to": to,
        "error": res.get("error"),
        "detail": mailer.hint(res.get("error")),
    }


class DeviceUpdate(BaseModel):
    label: str | None = None
    user_id: str | None = None
    status: str | None = None


@router.get("/devices")
def list_devices(tenant: str | None = None, authorization: str | None = BearerHeader):
    me = current_user(authorization)
    require(me, "manager")
    tenant_id = scope_tenant(me, tenant)
    return {"devices": db.query(
        """
        SELECT d.*, u.name AS assigned_to
          FROM devices d LEFT JOIN users u ON u.id = d.user_id
         WHERE d.tenant_id = %s ORDER BY d.model, d.serial
        """,
        (tenant_id,),
    )}


@router.post("/devices", status_code=201)
def create_device(req: DeviceCreate, authorization: str | None = BearerHeader):
    me = current_user(authorization)
    require(me, "client_admin")
    tenant_id = scope_tenant(me, req.tenant)
    if req.model not in ("g2", "g1", "ring1"):
        raise HTTPException(status_code=400, detail="Model must be g2, g1 or ring1")
    if db.query_one("SELECT id FROM devices WHERE tenant_id = %s AND serial = %s",
                    (tenant_id, req.serial)):
        raise HTTPException(status_code=409, detail="That serial is already registered")
    row = db.query_one(
        """
        INSERT INTO devices (tenant_id, user_id, model, serial, label, assigned_at)
        VALUES (%s, %s, %s, %s, %s, %s)
        RETURNING *
        """,
        (tenant_id, req.user_id, req.model, req.serial, req.label,
         datetime.now(timezone.utc) if req.user_id else None),
    )
    return {"device": row}


@router.patch("/devices/{device_id}")
def update_device(device_id: str, req: DeviceUpdate,
                  authorization: str | None = BearerHeader):
    me = current_user(authorization)
    require(me, "client_admin")
    device = db.query_one("SELECT * FROM devices WHERE id = %s", (device_id,))
    if device is None:
        raise HTTPException(status_code=404, detail="No such device")
    if me.role != "cue_admin" and str(device["tenant_id"]) != str(me.tenant_id):
        raise HTTPException(status_code=403, detail="Not your tenant")

    sets, params = [], []
    if req.label is not None:
        sets.append("label = %s"); params.append(req.label)
    if req.status:
        sets.append("status = %s"); params.append(req.status)
    if req.user_id is not None:
        sets.append("user_id = %s"); params.append(req.user_id or None)
        sets.append("assigned_at = now()")
    if not sets:
        raise HTTPException(status_code=400, detail="Nothing to update")
    params.append(device_id)
    row = db.query_one(
        f"UPDATE devices SET {', '.join(sets)} WHERE id = %s RETURNING *", tuple(params)
    )
    return {"device": row}


# --- platform (Cue staff only) -----------------------------------------------
#
# The lesson from the first production deploy was that "reachable" is not
# "working": the service reported a healthy database while the schema did not
# exist. Every check below therefore asserts on something a feature actually
# needs, and anything it cannot prove is reported as unknown rather than ok.

def _hours_since(iso: str) -> float:
    """Hours between an ISO timestamp and now. Returns a large number rather
    than raising on anything unparseable — a check that throws takes the whole
    Health panel down, which is worse than one that reads as stale."""
    try:
        then = datetime.fromisoformat(iso)
        if then.tzinfo is None:
            then = then.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - then).total_seconds() / 3600
    except Exception:
        return 1e6


def _check(key: str, label: str, status: str, detail: str = "") -> dict:
    return {"key": key, "label": label, "status": status, "detail": detail}


def _platform_checks() -> list[dict]:
    checks: list[dict] = []
    dbstate = db.health()

    if not dbstate.get("configured"):
        checks.append(_check("schema", "Database schema", "fail",
                             "DATABASE_URL is not set on this service"))
        return checks
    if not dbstate.get("reachable"):
        checks.append(_check("schema", "Database schema", "fail",
                             dbstate.get("error", "unreachable")))
        return checks
    if dbstate.get("status") == "empty":
        checks.append(_check("schema", "Database schema", "fail",
                             "connected, but no tables — migrations did not ship"))
        return checks

    checks.append(_check("schema", "Database schema", "ok",
                         f"{dbstate.get('migrations', 0)} migration(s) applied"))

    # An account nobody can sign in with is the same as no account.
    staff = db.query_one(
        "SELECT count(*) AS n FROM users "
        " WHERE role = 'cue_admin' AND status = 'active' AND password_hash IS NOT NULL"
    )
    n_staff = (staff or {}).get("n", 0)
    checks.append(_check(
        "staff", "Cue staff accounts", "ok" if n_staff else "fail",
        f"{n_staff} able to sign in" if n_staff
        else "no active cue_admin with a password — bootstrap did not run",
    ))

    # A retailer with no admin of its own means every change routes through us.
    orphans = db.query(
        """
        SELECT t.slug FROM tenants t
         WHERE t.status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM users u
              WHERE u.tenant_id = t.id AND u.role = 'client_admin' AND u.status = 'active')
         ORDER BY t.slug
        """
    )
    checks.append(_check(
        "tenant_admins", "Every active tenant has an admin",
        "ok" if not orphans else "warn",
        "all covered" if not orphans
        else "no client_admin: " + ", ".join(r["slug"] for r in orphans),
    ))

    # Voice is the feature most likely to fail quietly — a bad STT key returns
    # answers that are merely wrong rather than errors.
    vq = db.query_one(
        """
        SELECT count(*) AS n,
               count(*) FILTER (WHERE NOT ok) AS failed,
               percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
          FROM voice_queries WHERE created_at > now() - interval '24 hours'
        """
    ) or {}
    n_vq = vq.get("n") or 0
    if n_vq == 0:
        checks.append(_check("voice", "Voice queries (24h)", "unknown",
                             "no queries — nothing to judge"))
    else:
        rate = (vq.get("failed") or 0) / n_vq
        checks.append(_check(
            "voice", "Voice success rate (24h)",
            "ok" if rate < 0.05 else "warn" if rate < 0.2 else "fail",
            f"{n_vq - (vq.get('failed') or 0)}/{n_vq} answered",
        ))
        p95 = vq.get("p95")
        if p95 is not None:
            checks.append(_check(
                "latency", "Voice p95 latency (24h)",
                "ok" if p95 < 2500 else "warn" if p95 < 5000 else "fail",
                f"{int(p95)} ms",
            ))

    # Hardware nobody owns. These record activity against the store but not
    # against a person, so it never reaches a leaderboard — the failure is
    # silent from the floor and only visible here.
    unbound = db.query(
        """
        SELECT t.slug, d.serial FROM devices d
          JOIN tenants t ON t.id = d.tenant_id
         WHERE d.user_id IS NULL AND d.status = 'active'
           AND d.last_seen_at > now() - interval '7 days'
         ORDER BY d.last_seen_at DESC LIMIT 5
        """
    )
    checks.append(_check(
        "devices", "Active devices are assigned to someone",
        "ok" if not unbound else "warn",
        "all assigned" if not unbound
        else "unassigned: " + ", ".join(f"{r['serial']} ({r['slug']})" for r in unbound),
    ))

    # An engagement that never closed corrupts average-length reporting, and
    # usually means a socket dropped without the disconnect handler firing.
    stuck = db.query_one(
        "SELECT count(*) AS n FROM engagements "
        " WHERE ended_at IS NULL AND started_at < now() - interval '6 hours'"
    ) or {}
    n_stuck = stuck.get("n") or 0
    checks.append(_check(
        "engagements", "No stranded engagements", "ok" if n_stuck == 0 else "warn",
        "all closed" if n_stuck == 0 else f"{n_stuck} open for over 6 hours",
    ))

    # Retention is enforced now (app/retention.py, swept on a timer). This
    # check asserts it actually *ran*, per tenant, rather than that the code
    # exists — a sweep that silently stopped is the same outcome as never
    # having written it, and looks better.
    #
    # `retention.status()` reports the *oldest* last-run across tenants, not
    # the newest, so one tenant going unswept cannot hide behind the others.
    ret = retention.status()
    if not ret.get("enforced"):
        checks.append(_check("retention", "Retention enforcement", "unknown",
                             ret.get("reason", "not determinable")))
    elif ret.get("last_run") is None:
        checks.append(_check("retention", "Retention enforcement", "warn",
                             "no sweep has run yet — first one is 60s after boot"))
    else:
        stale = _hours_since(ret["last_run"]) > 26
        detail = f"last swept {ret['last_run']}"
        if ret.get("oldest_swept_tenant"):
            detail += f" (oldest: {ret['oldest_swept_tenant']})"
        if ret.get("backlog"):
            detail += " · backlog remaining, next sweep continues"
        checks.append(_check(
            "retention", "Retention enforcement",
            "warn" if stale or ret.get("backlog") else "ok", detail))

    # Mail. Password resets answer 202 whether or not they sent, by design, so
    # a broken sender is invisible from outside — this is where it becomes
    # visible. "console" is not a failure, it is an unconfigured deployment,
    # and it is reported as such rather than as healthy.
    m = mailer.status()
    checks.append(_check(
        "mail", "Outbound email",
        "ok" if m["configured"] else "warn",
        f"{m['provider']} · {m['from']}" if m["configured"]
        else "not configured — invites and resets are logged, not sent",
    ))

    # --- merchant credentials -------------------------------------------------
    enc = secrets_box.status()
    checks.append(_check(
        "cred_key", "Credential encryption key",
        "ok" if enc.get("configured") else "fail",
        f"key {enc['key_id']}" + (" (+ rotation key)" if enc.get("rotation_key_present") else "")
        if enc.get("configured")
        else enc.get("error", "CUE_CRED_KEY is not set — no store can be connected"),
    ))

    # A tenant pointed at the Shopify adapter with nothing to authenticate with
    # serves 503 to the lens. Silent from the floor, obvious here.
    orphaned = db.query(
        """
        SELECT t.slug FROM tenants t
         WHERE t.status = 'active' AND t.crm_provider = 'shopify'
           AND NOT EXISTS (SELECT 1 FROM tenant_crm_credentials c
                            WHERE c.tenant_id = t.id)
         ORDER BY t.slug
        """
    )
    # The legacy environment fallback genuinely serves the 'shopify' slug, so it
    # is not an orphan while those variables are still set.
    if crm_provider.env_shopify_configured():
        orphaned = [r for r in orphaned if r["slug"] != "shopify"]
    checks.append(_check(
        "crm_credentials", "Shopify tenants have a store connected",
        "ok" if not orphaned else "fail",
        "all connected" if not orphaned
        else "no credentials: " + ", ".join(r["slug"] for r in orphaned),
    ))

    # A token that worked at setup and stopped working since — revoked app,
    # rotated secret, uninstalled custom app. Nobody finds this out until an
    # associate is standing in front of a customer.
    stale = db.query(
        """
        SELECT t.slug, c.last_test_ok, c.last_tested_at, c.scopes
          FROM tenant_crm_credentials c JOIN tenants t ON t.id = c.tenant_id
         WHERE t.status = 'active'
         ORDER BY t.slug
        """
    )
    failing = [r["slug"] for r in stale if r["last_test_ok"] is False]
    untested = [r["slug"] for r in stale if r["last_test_ok"] is None]
    short = [
        r["slug"] for r in stale
        if r["last_test_ok"]
        and any(s not in (r["scopes"] or []) for s in crm_credentials.REQUIRED_SCOPES)
    ]
    if failing:
        detail, status = "last test failed: " + ", ".join(failing), "fail"
    elif short:
        detail, status = "missing required scopes: " + ", ".join(short), "warn"
    elif untested:
        detail, status = "never tested: " + ", ".join(untested), "unknown"
    elif stale:
        detail, status = f"{len(stale)} connected and passing", "ok"
    else:
        detail, status = "no stores connected", "unknown"
    checks.append(_check("crm_health", "Connected stores answer", status, detail))

    # Rotation audit: which rows still hold the retired key. Compares key ids,
    # never key material.
    if enc.get("configured"):
        old = db.query(
            "SELECT count(*) AS n FROM tenant_crm_credentials WHERE key_id <> %s",
            (enc["key_id"],),
        )
        n_old = (old[0] if old else {}).get("n", 0)
        if n_old:
            checks.append(_check(
                "cred_rotation", "Credentials sealed with the current key", "warn",
                f"{n_old} still sealed with a previous key — re-enter those tokens "
                "before dropping CUE_CRED_KEY_OLD",
            ))
    return checks


@router.get("/retention")
def get_retention(authorization: str | None = BearerHeader):
    """Every tenant's window, and what the last sweep actually deleted.

    The Health panel hard-codes retention to warn because days are stored and,
    until a sweep has run, nothing has acted on them. That warn is correct and
    it is also a dead end — there is nowhere to go and see which store is
    behind. This is that place.
    """
    me = current_user(authorization)
    require(me, "cue_admin")
    return {
        "default_days": retention.DEFAULT_DAYS,
        "summary": retention.status(),
        "tenants": retention.detail(),
    }


@router.post("/retention/run")
def run_retention(authorization: str | None = BearerHeader):
    """Sweep now, rather than waiting for the timer.

    cue_admin only, and across every tenant — this is the operations lever for
    "a retailer has asked us to prove retention works", and for the first run
    after a window is shortened, where waiting six hours to see the effect is
    the difference between a control that feels real and one that feels
    theoretical.

    Safe to hammer: the sweep only matches rows that still have something to
    redact, so a second call in a row does nothing and says so.
    """
    me = current_user(authorization)
    require(me, "cue_admin")
    runs = retention.sweep_all()
    return {
        "runs": runs,
        "redacted": sum(r["voice_redacted"] + r["engagements_redacted"]
                        + r["assists_redacted"] for r in runs),
    }


@router.get("/platform")
def platform(authorization: str | None = BearerHeader):
    """Cross-tenant operational state. Cue staff only — this is the one view
    that deliberately ignores tenant scoping, so it gets the strictest role."""
    me = current_user(authorization)
    require(me, "cue_admin")

    from .llm import get_provider
    from .stt import get_stt

    counts: dict = {}
    if db.health().get("reachable") and db.health().get("status") != "empty":
        row = db.query_one(
            """
            SELECT (SELECT count(*) FROM tenants WHERE status = 'active') AS tenants_active,
                   (SELECT count(*) FROM tenants) AS tenants_total,
                   (SELECT count(*) FROM users WHERE status = 'active') AS users_active,
                   (SELECT count(*) FROM users WHERE role = 'associate' AND status = 'active')
                     AS associates,
                   (SELECT count(*) FROM devices WHERE status = 'active') AS devices,
                   (SELECT count(*) FROM devices
                     WHERE last_seen_at > now() - interval '24 hours') AS devices_seen_24h,
                   (SELECT count(*) FROM engagements
                     WHERE started_at > now() - interval '24 hours') AS engagements_24h,
                   (SELECT count(*) FROM voice_queries
                     WHERE created_at > now() - interval '24 hours') AS voice_24h
            """
        )
        counts = dict(row or {})

    return {
        "service": {
            "llm_provider": get_provider().name,
            "stt_provider": get_stt().name,
            # Named per tenant here rather than on /health, which is open.
            "tenants": crm_provider.tenant_status_detail(),
            "commit": (os.environ.get("RAILWAY_GIT_COMMIT_SHA")
                       or os.environ.get("GIT_COMMIT") or "")[:7] or None,
            "deployed_at": os.environ.get("RAILWAY_DEPLOYMENT_CREATED_AT"),
            "environment": os.environ.get("RAILWAY_ENVIRONMENT_NAME", "local"),
        },
        "database": db.health(),
        "counts": counts,
        "checks": _platform_checks(),
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }
