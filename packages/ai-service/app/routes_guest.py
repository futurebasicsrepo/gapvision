"""The guest surface — what a customer's own phone can reach, one hop away.

Every route here is behind the service key like the rest of the ingest side,
because the thing calling them is the **realtime server**, never the browser
itself. The guest's phone talks to the realtime server; the realtime server
holds the key. That boundary is the whole trust story and it does not bend for
a page that would be more convenient if it could call us directly.

Three things a check-in page needs and could not previously get:

    /api/guest/config      where to send this guest — our page, or the
                           retailer's own app
    /api/guest/catalogue   what they can ask for, sizes but never counts
    /api/ingest/request    what they asked for
"""
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import catalogue, db, identity, plates
from . import requests as guest_requests
from .auth import KeyHeader, guard
from .identity import BearerHeader, current_user, require, scope_tenant

guest = APIRouter(prefix="/api/guest", tags=["guest"])
ingest = APIRouter(prefix="/api/ingest", tags=["ingest"])
router = APIRouter(prefix="/api/analytics", tags=["analytics"])


def _tenant(slug: str) -> dict:
    t = identity.resolve_tenant(slug)
    if t is None:
        raise HTTPException(status_code=404, detail=f"Unknown tenant: {slug}")
    return t


# --- where does this guest go ------------------------------------------------
@guest.get("/config")
def guest_config(tenant: str, request: Request,
                 x_gapvision_key: str | None = KeyHeader):
    """How this retailer wants a check-in to happen.

    The deep-link problem, stated plainly: iOS only opens an app for a link on
    a domain that app's own `apple-app-site-association` claims. A cuesea.ai
    URL therefore *cannot* open Gap's app, no matter what we put in it — only
    gap.com can. So the plate prints our URL, and this decides what happens
    when the guest lands:

        mode "web"   our own page, with the request form. The default, and the
                     whole flow for a Shopify store that has no app.
        mode "app"   hand off to the retailer's app via `app_link`, which is on
                     *their* domain and which their app claims. Their app posts
                     the request back through the same endpoint.

    The mode is a tenant config value rather than a property of the plate, which
    is the point: Gap ships their route, we flip one field, and every plate
    already in the store starts opening the app. Nothing gets reprinted.

    `{z}`, `{t}` and `{src}` in `app_link` are substituted by the page.
    """
    guard(request, None, x_gapvision_key)
    t = _tenant(tenant)
    cfg = (t.get("config") or {}).get("checkin") or {}
    mode = cfg.get("mode", "web")
    if mode not in ("web", "app"):
        mode = "web"
    app_link = cfg.get("app_link")
    if mode == "app" and not app_link:
        # A tenant set to `app` with nowhere to send anyone would strand every
        # guest on a blank interstitial. Fall back rather than fail: our page
        # works, and the misconfiguration shows up as `fell_back`.
        mode, fell_back = "web", True
    else:
        fell_back = False

    return {
        "tenant": t["slug"],
        "name": t["name"],
        "mode": mode,
        "app_link": app_link if mode == "app" else None,
        # Shown on the interstitial for a guest who does not have the app.
        "app_name": cfg.get("app_name") or f"the {t['name']} app",
        "fell_back": fell_back,
        "needs": guest_requests.NEEDS,
    }


@guest.get("/plate")
def guest_plate(token: str, request: Request, counter: str | None = None,
                cmac: str | None = None, x_gapvision_key: str | None = KeyHeader):
    """A printed token, back into a place — plus everything the page needs.

    One call rather than three: the page has a person standing in a fitting
    room waiting for it, and each round trip is a visible pause on a shop's
    guest wifi.

    `counter` and `cmac` are what a rotating-cryptogram tag appends to its URL
    on every tap. They are the only mechanism here that can tell a shared link
    from a real one — see plates.py.
    """
    guard(request, None, x_gapvision_key)
    place = plates.resolve(token, counter=counter, cmac=cmac)
    t = _tenant(place["tenant"])
    return {**guest_config(place["tenant"], request, x_gapvision_key),
            "zone": place["zone"], "source": place["source"],
            "label": place["label"], "token": place["token"],
            "tenant": t["slug"]}


@guest.get("/catalogue")
def guest_catalogue(tenant: str, request: Request,
                    x_gapvision_key: str | None = KeyHeader):
    """What a guest can ask for. Sizes, never counts — see catalogue.py."""
    guard(request, None, x_gapvision_key)
    t = _tenant(tenant)
    return catalogue.public_floor(t["slug"])


# --- what they asked for -----------------------------------------------------
class RequestIn(BaseModel):
    tenant: str
    guest_ref: str
    zone: str | None = None
    need: str = "other"
    sku: str | None = None
    product: str | None = None
    size: str | None = None
    note: str | None = None
    surface: str = "web"


class RequestRef(BaseModel):
    tenant: str
    request_id: str
    #: Who picked it up, by email. Resolved to a user id here so the caller
    #: never has to know one.
    associate_email: str | None = None


class GuestRef(BaseModel):
    tenant: str
    guest_ref: str


@ingest.post("/request", status_code=201)
def ingest_request(req: RequestIn, request: Request,
                   x_gapvision_key: str | None = KeyHeader):
    """A guest asking for something, attached to a live check-in."""
    guard(request, None, x_gapvision_key)
    t = _tenant(req.tenant)
    return guest_requests.open_request(
        t, guest_ref=req.guest_ref, zone=req.zone, need=req.need,
        sku=req.sku, product=req.product, size=req.size, note=req.note,
        surface=req.surface)


@ingest.post("/request/claim")
def ingest_request_claim(req: RequestRef, request: Request,
                         x_gapvision_key: str | None = KeyHeader):
    """An associate taking it. First one wins; the second gets a 409."""
    guard(request, None, x_gapvision_key)
    t = _tenant(req.tenant)
    user_id = None
    if req.associate_email:
        row = db.query_one(
            "SELECT id FROM users WHERE tenant_id = %s AND lower(email) = lower(%s)",
            (t["id"], req.associate_email))
        user_id = row["id"] if row else None
    return guest_requests.claim(t, req.request_id, user_id)


@ingest.post("/request/done")
def ingest_request_done(req: RequestRef, request: Request,
                        x_gapvision_key: str | None = KeyHeader):
    guard(request, None, x_gapvision_key)
    return guest_requests.resolve(_tenant(req.tenant), req.request_id, "done")


@ingest.post("/request/cancel")
def ingest_request_cancel(req: GuestRef, request: Request,
                          x_gapvision_key: str | None = KeyHeader):
    """Everything this guest has open. Called when they revoke, so nobody
    walks a jean to a room they have already left."""
    guard(request, None, x_gapvision_key)
    t = _tenant(req.tenant)
    return {"ok": True,
            "cancelled": guest_requests.cancel_for_guest(t, req.guest_ref)}


@ingest.get("/requests")
def ingest_open_requests(tenant: str, request: Request, zone: str | None = None,
                         x_gapvision_key: str | None = KeyHeader):
    """What is waiting, for the realtime server to hand to the glasses."""
    guard(request, None, x_gapvision_key)
    t = _tenant(tenant)
    rows = guest_requests.open_for_zone(t["id"], zone)
    return {"requests": [{
        "request_id": str(r["id"]), "zone": r["zone"], "need": r["need"],
        "sku": r["sku"], "product": r["product"], "size": r["size"],
        "note": r["note"], "status": r["status"],
        "claimed_by": r.get("claimed_by_name"),
        "created_at": r["created_at"].isoformat(),
        "line": guest_requests.glass_line(need=r["need"], product=r["product"],
                                          size=r["size"], note=r["note"]),
    } for r in rows]}


class PlateIn(BaseModel):
    zone: str | None = None
    source: str
    label: str | None = None
    token: str | None = None


class PlatesIn(BaseModel):
    tenant: str
    plates: list[PlateIn]


@ingest.post("/plates", status_code=201)
def ingest_plates(req: PlatesIn, request: Request,
                  x_gapvision_key: str | None = KeyHeader):
    """Register printed plates.

    Idempotent on the token, so re-running a registration after a reprint is
    safe and un-revokes a plate that is being put back into service.
    """
    guard(request, None, x_gapvision_key)
    t = _tenant(req.tenant)
    return {"ok": True, "plates": [
        plates.mint(t, zone=p.zone, source=p.source, label=p.label, token=p.token)
        for p in req.plates]}


# --- what the floor asked for, for a manager ---------------------------------
@router.get("/plates")
def get_plates(tenant: str | None = None, authorization: str | None = BearerHeader):
    """Every plate in a store, and how hard each is being used.

    `hits_last_hour` is the shared-token signal. Not an alarm: a fitting room
    is busy on a Saturday. A fitting room is not busy at three in the morning.
    """
    me = current_user(authorization)
    require(me, "manager")
    tenant_id = scope_tenant(me, tenant)
    t = db.query_one("SELECT * FROM tenants WHERE id = %s", (tenant_id,))
    if t is None:
        raise HTTPException(status_code=404, detail="Unknown tenant")
    rows = plates.listing(t["id"])
    return {"tenant": t["slug"], "busy_over": plates.BUSY_HOUR,
            "plates": rows,
            "busy": [r["token"] for r in rows
                     if (r["hits_last_hour"] or 0) > plates.BUSY_HOUR]}


@router.post("/plates/{token}/revoke")
def revoke_plate(token: str, tenant: str | None = None,
                 authorization: str | None = BearerHeader):
    """Kill one door on one plate.

    Deliberately not both: when a photograph of the QR ends up somewhere it
    should not, the tag six inches above it is still fine, and disabling it
    would cost a store its fitting room for no reason.
    """
    me = current_user(authorization)
    require(me, "manager")
    tenant_id = scope_tenant(me, tenant)
    t = db.query_one("SELECT * FROM tenants WHERE id = %s", (tenant_id,))
    if t is None:
        raise HTTPException(status_code=404, detail="Unknown tenant")
    return plates.revoke(t, token)



@router.get("/requests")
def get_requests(days: int = 7, tenant: str | None = None,
                 authorization: str | None = BearerHeader):
    """Demand, and how fast the floor answered it.

    Survives the retention sweep on purpose: what people ask for and how long
    they wait is a question about a shop, not about a shopper.
    """
    me = current_user(authorization)
    require(me, "manager")
    tenant_id = scope_tenant(me, tenant)
    t = db.query_one("SELECT * FROM tenants WHERE id = %s", (tenant_id,))
    if t is None:
        raise HTTPException(status_code=404, detail="Unknown tenant")
    days = max(1, min(int(days), 365))
    waiting = guest_requests.open_for_zone(t["id"])
    return {
        "tenant": t["slug"],
        "window_days": days,
        # What is waiting right now, because a manager looking at this screen
        # during a shift needs the floor and not the quarter. Redacted rows
        # cannot appear here — the query only reaches back STALE_MINUTES.
        "waiting": [{
            "request_id": str(r["id"]), "zone": r["zone"], "need": r["need"],
            "product": r["product"], "size": r["size"], "status": r["status"],
            "claimed_by": r.get("claimed_by_name"),
            "created_at": r["created_at"].isoformat(),
        } for r in waiting],
        "demand": guest_requests.demand(t["id"], days),
    }
