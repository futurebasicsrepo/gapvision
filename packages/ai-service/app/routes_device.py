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

from . import db, devices, identity, preflight, widgets
from .auth import KeyHeader, guard
from .identity import BearerHeader, current_user, require

admin_router = APIRouter(prefix="/api/admin", tags=["devices"])
device_auth_router = APIRouter(prefix="/api/auth", tags=["devices"])


class DeviceMint(BaseModel):
    surface: str = "even-g2"
    label: str | None = None
    serial: str | None = None
    user_id: str | None = None
    #: Mint anyway, after the preflight said the launch URL serves the wrong
    #: app. Exists because an operator mid-migration may know something the
    #: check cannot — and because a guard with no override is a guard somebody
    #: disables in the environment, permanently, at 2am. Named for what it
    #: does rather than "force".
    despite_wrong_host: bool = False


class DeviceAuth(BaseModel):
    token: str
    tenant: str | None = None
    meta: dict | None = None


class AssociateAuth(BaseModel):
    """A *person's* session, presented by the realtime server on their behalf.

    The BYOD counterpart of `DeviceAuth`. Same caller, same service key, same
    single-401 posture — and deliberately a separate model and a separate
    route, because conflating "this handset is the store" with "this person is
    signed in" is exactly the mistake the phone surface exists to avoid.
    """
    session: str
    tenant: str | None = None


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

    The QR goes to the surfaces whose provisioning medium is a thing you point
    a camera at — the G2, and a phone. A Meta launch URL goes into Meta's
    preview share flow and a sim URL goes into a browser tab; a QR beside
    either would be an affordance for something nobody does.
    """
    url = devices.launch_url(device["surface"], tenant_slug, token)
    return {
        "device": device,
        "token": token,
        "launch_url": url,
        "qr": devices.qr_rows(url) if device["surface"] in devices.QR_SURFACES else None,
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

    # Ask the launch URL's origin which app it is, *before* minting — because
    # the token does not exist yet, so there is nothing to burn if we stop
    # here. Checking after the mint would leave a live credential behind every
    # refusal.
    url = devices.launch_url(req.surface, tenant["slug"], "preflight")
    verdict = preflight.check(req.surface, url)
    if verdict.blocks and not req.despite_wrong_host:
        raise HTTPException(
            status_code=409,
            detail=(
                f"{verdict.detail} Nothing was minted. Point this surface's "
                f"hostname at the right deployment, or mint anyway if you know "
                f"better than this check."
            ),
        )

    device, token = devices.create(
        tenant["id"], tenant["slug"], surface=req.surface, label=req.label,
        serial=req.serial, user_id=req.user_id)
    out = _minted(tenant["slug"], device, token)
    # Carried on the success path too. "Reachable and correct" and "we could
    # not ask" both mint, and an admin about to hold up a QR deserves to know
    # which one they are in.
    out["preflight"] = verdict.public()
    return out


class DeviceReissue(BaseModel):
    despite_wrong_host: bool = False


@admin_router.post("/devices/{device_id}/reissue")
def reissue_device(device_id: str, req: DeviceReissue | None = None,
                   authorization: str | None = BearerHeader):
    me = current_user(authorization)
    require(me, "client_admin")
    row = _device_or_404(me, device_id)
    tenant = db.query_one("SELECT slug FROM tenants WHERE id = %s", (row["tenant_id"],))

    # The same guard as minting, because this is the same act: a reissue
    # produces a live token and puts it in a QR. Checking the mint alone would
    # leave the recovery path — the one an admin reaches for *because*
    # something already went wrong — as the unguarded way to burn a token.
    url = devices.launch_url(row["surface"], tenant["slug"], "preflight")
    verdict = preflight.check(row["surface"], url)
    if verdict.blocks and not (req and req.despite_wrong_host):
        raise HTTPException(
            status_code=409,
            detail=(
                f"{verdict.detail} No new code was issued, and the old one is "
                f"untouched. Point this surface's hostname at the right "
                f"deployment, or reissue anyway if you know better than this check."
            ),
        )

    device, token = devices.reissue(device_id)
    out = _minted(tenant["slug"], device, token)
    out["preflight"] = verdict.public()
    return out


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
    out = {
        "device_id": str(row["id"]),
        "user_id": str(row["user_id"]) if row.get("user_id") else None,
        "surface": row["surface"],
        "tenant": row["tenant_slug"],
        "label": row.get("label"),
    }
    # The associate's deck rides along with the identity that determines it.
    #
    # A separate fetch would be a second round trip in front of the first
    # frame, and — worse — a window where the lens has registered but does not
    # yet know which widgets to draw, which renders as the deck rearranging
    # itself a moment after somebody looked at it. Absent when the device is
    # assigned to nobody, which is the honest answer: there is no person whose
    # deck this is, so the package uses its own default.
    if row.get("user_id"):
        out["widget_prefs"] = widgets.prefs_for(row["user_id"])
    return out


@device_auth_router.post("/associate")
def authenticate_associate(req: AssociateAuth, request: Request,
                           x_gapvision_key: str | None = KeyHeader):
    """Resolve a personal session for the realtime server.

    This is how an associate's **own phone** connects. It holds no device
    identity and never will — the thing it presents belongs to the person, not
    to the shop, which is the entire point:

      · An admin disabling someone in Console ends this in the next second,
        because `auth_tokens` is revocable server-side. Nobody has to find a
        handset.
      · The session expires on its own (`CUE_SESSION_HOURS`, 12 by default —
        roughly a shift). A phone that has been in a drawer since Friday holds
        nothing usable on Monday without anyone having remembered anything.
      · There is no store credential on the device to leave with them.

    Returns the person and their tenant. No device_id, deliberately: activity
    from a personal phone is attributed to a human being and to no hardware,
    and inventing a synthetic device row here would put the thing we refused to
    create back into the fleet list under a name nobody can revoke.

    One 401 for every failure, same as the device door. Unknown token, expired,
    revoked, disabled account, or a session pointed at the wrong shop — telling
    them apart lets somebody holding a stolen token learn which shop it was.
    """
    guard(request, req.tenant, x_gapvision_key)

    row = identity.resolve_token(req.session)
    if row is None or row["status"] != "active":
        raise HTTPException(status_code=401, detail="Not authenticated")

    # An associate is the only role this door is for. A manager or an admin
    # holding a valid Console session must not be able to point it at the
    # realtime server and register as a lens on the floor — their surfaces are
    # Studio and Console, and a signed-in admin appearing in the roster is a
    # confusing thing that nobody asked for.
    if row["role"] not in ("associate", "manager"):
        raise HTTPException(status_code=401, detail="Not authenticated")

    slug = row.get("tenant_slug")
    if slug is None:
        # CueSea staff have no tenant, so there is no floor for them to join.
        raise HTTPException(status_code=401, detail="Not authenticated")
    if req.tenant and req.tenant.lower() != slug.lower():
        # The client named a shop that is not theirs. Refused rather than
        # silently corrected: a phone asking for the wrong store is a phone
        # whose state is wrong, and quietly landing it in the right one hides
        # that from everybody.
        raise HTTPException(status_code=401, detail="Not authenticated")

    return {
        "user_id": str(row["id"]),
        "name": row.get("name"),
        "email": row.get("email"),
        "role": row["role"],
        "tenant": slug,
    }
