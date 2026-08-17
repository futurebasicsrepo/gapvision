"""Provisioning routes — minting device identities, and redeeming them.

Two audiences on two doors, and they are not the same door on purpose:

  `/api/admin/…`  a signed-in human (CueSea staff, or a retailer's own admin)
                  minting, reassigning, reissuing and revoking. Bearer token,
                  tenant-scoped through `identity.admin_tenant`.
  `/api/auth/device`  the realtime server, resolving a token presented at
                  register. Service key, no bearer, no session.

The one rule that spans both: **a provision token appears in exactly one
response body — the mint or reissue that created it — and never again.** Not
in a list, not in a detail read, not in an error. Everything else goes through
`devices.public()`, which drops the hash and derives presence.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import db, devices, identity
from .auth import KeyHeader, guard
from .identity import BearerHeader, current_user, require

admin_router = APIRouter(prefix="/api/admin", tags=["devices"])
device_auth_router = APIRouter(prefix="/api/auth", tags=["devices"])


class DeviceMint(BaseModel):
    surface: str = "even-g2"
    label: str | None = None
    serial: str | None = None
    user_id: str | None = None


class DeviceAuth(BaseModel):
    token: str
    tenant: str | None = None
    meta: dict | None = None


def _device_or_404(me, device_id: str) -> dict:
    """A device this principal may administer.

    404 for a device in another tenant rather than 403: unlike a tenant slug
    somebody typed, a device uuid is not something you guess your way to, and
    confirming that one exists in a shop you cannot see is a fact worth not
    confirming.
    """
    try:
        row = db.query_one("SELECT * FROM devices WHERE id = %s", (device_id,))
    except Exception:
        row = None  # not a valid uuid
    if row is None:
        raise HTTPException(status_code=404, detail="No such device")
    if me.role != "cue_admin" and str(row["tenant_id"]) != str(me.tenant_id):
        raise HTTPException(status_code=404, detail="No such device")
    return row


def _minted(tenant_slug: str, device: dict, token: str) -> dict:
    """The one response that carries a token, and everything derived from it.

    The QR is only for `even-g2`, because that is the only surface whose
    provisioning medium is a thing you point a camera at. A Meta launch URL
    goes into Meta's preview share flow and a sim URL goes into a browser tab;
    a QR beside either would be an affordance for something nobody does.
    """
    url = devices.launch_url(device["surface"], tenant_slug, token)
    return {
        "device": device,
        "token": token,
        "launch_url": url,
        "qr": devices.qr_rows(url) if device["surface"] == "even-g2" else None,
    }


# --- admin -------------------------------------------------------------------

@admin_router.get("/tenants/{id_or_slug}/devices")
def list_tenant_devices(id_or_slug: str, authorization: str | None = BearerHeader):
    me = current_user(authorization)
    require(me, "manager")
    tenant = identity.admin_tenant(me, id_or_slug)
    return {"devices": devices.list_for_tenant(tenant["id"])}


@admin_router.post("/tenants/{id_or_slug}/devices", status_code=201)
def mint_device(id_or_slug: str, req: DeviceMint,
                authorization: str | None = BearerHeader):
    """Mint a device and hand back its one and only token.

    Minting is a `client_admin` action, not a manager one. A manager can see
    the fleet; handing out an identity that registers as this store is the
    same class of act as adding a colleague.
    """
    me = current_user(authorization)
    require(me, "client_admin")
    tenant = identity.admin_tenant(me, id_or_slug)

    if req.surface not in devices.SURFACES:
        raise HTTPException(
            status_code=400,
            detail=f"Surface must be one of {', '.join(devices.SURFACES)}")
    if req.serial and db.query_one(
            "SELECT id FROM devices WHERE tenant_id = %s AND serial = %s",
            (tenant["id"], req.serial)):
        raise HTTPException(status_code=409, detail="That serial is already registered")
    if req.user_id and not db.query_one(
            "SELECT id FROM users WHERE id = %s AND tenant_id = %s",
            (req.user_id, tenant["id"])):
        # Assigning a device to somebody else's employee would be a quiet
        # cross-tenant write. It is refused here rather than by a foreign key,
        # because the foreign key would have allowed it.
        raise HTTPException(status_code=400, detail="No such person in this tenant")

    device, token = devices.create(
        tenant["id"], tenant["slug"], surface=req.surface, label=req.label,
        serial=req.serial, user_id=req.user_id)
    return _minted(tenant["slug"], device, token)


@admin_router.post("/devices/{device_id}/reissue")
def reissue_device(device_id: str, authorization: str | None = BearerHeader):
    me = current_user(authorization)
    require(me, "client_admin")
    row = _device_or_404(me, device_id)
    tenant = db.query_one("SELECT slug FROM tenants WHERE id = %s", (row["tenant_id"],))
    device, token = devices.reissue(device_id)
    return _minted(tenant["slug"], device, token)


@admin_router.post("/devices/{device_id}/revoke")
def revoke_device(device_id: str, authorization: str | None = BearerHeader):
    me = current_user(authorization)
    require(me, "client_admin")
    _device_or_404(me, device_id)
    return {"device": devices.revoke(device_id)}


# --- the register handshake ---------------------------------------------------

@device_auth_router.post("/device")
def authenticate_device(req: DeviceAuth, request: Request,
                        x_gapvision_key: str | None = KeyHeader):
    """Resolve a provision token for the realtime server.

    Service key, because the caller is a server and never a browser — a lens
    holds a device token, not a service key, and the token it holds buys it
    exactly this one answer through a server that already holds the key.

    Every failure is the same 401 with the same body. Unknown token, revoked
    token, retired unit, right token pointed at the wrong tenant: telling them
    apart would let somebody with a stolen token enumerate which shop it came
    from.
    """
    guard(request, req.tenant, x_gapvision_key)

    row = devices.resolve(req.token, req.tenant)
    if row is None:
        if devices.DEV_ALLOW_UNPROVISIONED:
            # Localhost, a fresh clone, a demo laptop. Never set in production
            # — and it grants no device identity, so anything written under it
            # is attributed to nobody rather than to the wrong pair.
            return {"device_id": None, "user_id": None, "surface": None,
                    "tenant": req.tenant, "unprovisioned": True}
        raise HTTPException(status_code=401, detail="Unknown device")

    devices.seen(row["id"], req.meta)
    return {
        "device_id": str(row["id"]),
        "user_id": str(row["user_id"]) if row.get("user_id") else None,
        "surface": row["surface"],
        "tenant": row["tenant_slug"],
        "label": row.get("label"),
    }
