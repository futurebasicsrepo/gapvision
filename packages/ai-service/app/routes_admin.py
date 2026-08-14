"""Admin surfaces — two audiences, one router.

  client_admin  their own retailer: users, devices, tenant config, privacy
  cue_admin     Future Basics: every tenant, provisioning, billing

Tenant scoping goes through `identity.scope_tenant` on every route rather than
being re-derived per handler. The failure mode of getting it wrong is showing
one retailer another retailer's floor, so it is worth having exactly one place
to read.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, EmailStr

from . import analytics, db, identity
from .identity import BearerHeader, current_user, require, scope_tenant

router = APIRouter(prefix="/api/admin", tags=["admin"])


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
    return {"user": identity.public_user(row)}


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
