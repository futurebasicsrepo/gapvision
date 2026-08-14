"""Manager-facing reporting, and the ingest side the realtime server writes to.

Two different callers, two different kinds of auth, so they are kept apart:

  /api/analytics/*  a signed-in human (manager and up), scoped to their tenant
  /api/ingest/*     the realtime server, holding the shared service key

The ingest routes are deliberately not reachable by a browser — the plugin
already talks to the realtime server, and the realtime server is the only
thing that knows what actually happened on the floor.
"""
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import analytics, db, identity
from .auth import KeyHeader, guard
from .identity import BearerHeader, current_user, require, scope_tenant

router = APIRouter(prefix="/api/analytics", tags=["analytics"])
ingest = APIRouter(prefix="/api/ingest", tags=["ingest"])


def _tenant_for(me, requested: str | None) -> dict:
    tenant_id = scope_tenant(me, requested)
    tenant = db.query_one("SELECT * FROM tenants WHERE id = %s", (tenant_id,))
    if tenant is None:
        raise HTTPException(status_code=404, detail="Unknown tenant")
    return tenant


@router.get("/summary")
def get_summary(days: int = 1, tenant: str | None = None,
                authorization: str | None = BearerHeader):
    me = current_user(authorization)
    require(me, "manager")
    t = _tenant_for(me, tenant)
    return {"tenant": t["slug"], **analytics.summary(t["id"], days=_clamp(days, 1, 365))}


@router.get("/leaderboard")
def get_leaderboard(days: int = 7, tenant: str | None = None,
                    authorization: str | None = BearerHeader):
    me = current_user(authorization)
    require(me, "manager")
    t = _tenant_for(me, tenant)
    return {
        "tenant": t["slug"],
        "window_days": _clamp(days, 1, 365),
        "weights": analytics._weights(t),
        "rows": analytics.leaderboard(t, days=_clamp(days, 1, 365)),
    }


@router.get("/engagements")
def get_engagements(limit: int = 20, tenant: str | None = None,
                    authorization: str | None = BearerHeader):
    me = current_user(authorization)
    require(me, "manager")
    t = _tenant_for(me, tenant)
    return {"engagements": analytics.recent_engagements(t["id"], _clamp(limit, 1, 200))}


@router.get("/voice")
def get_voice(limit: int = 20, tenant: str | None = None,
              authorization: str | None = BearerHeader):
    me = current_user(authorization)
    require(me, "manager")
    t = _tenant_for(me, tenant)
    rows = analytics.recent_voice(t["id"], _clamp(limit, 1, 200))
    return {
        "voice": rows,
        # Tell the UI why transcripts are missing, rather than letting it look
        # like a bug.
        "transcripts_stored": bool((t.get("privacy") or {}).get("store_transcripts")),
    }


@router.get("/usage")
def get_usage(days: int = 30, tenant: str | None = None,
              authorization: str | None = BearerHeader):
    me = current_user(authorization)
    require(me, "client_admin")
    t = _tenant_for(me, tenant)
    return {"tenant": t["slug"], "usage": analytics.usage(t["id"], _clamp(days, 1, 400))}


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, int(value)))


# --- ingest (service key) ----------------------------------------------------

class EngagementStart(BaseModel):
    tenant: str
    guest_ref: str | None = None
    zone: str | None = None
    associate_email: str | None = None


class EngagementEnd(BaseModel):
    engagement_id: str
    outcome: str | None = None
    sale_cents: int = 0


class VoiceRecord(BaseModel):
    tenant: str
    engagement_id: str | None = None
    associate_email: str | None = None
    intent: str | None = None
    ok: bool = True
    resolved_by: str | None = None
    latency_ms: int | None = None
    audio_seconds: float | None = None
    stt_provider: str | None = None
    transcript: str | None = None


class AssistRecord(BaseModel):
    tenant: str
    helper_email: str
    engagement_id: str | None = None
    note: str | None = None


def _ingest_tenant(slug: str) -> dict:
    tenant = identity.resolve_tenant(slug)
    if tenant is None:
        raise HTTPException(status_code=404, detail=f"Unknown tenant: {slug}")
    return tenant


def _user_in(tenant: dict, email: str | None) -> str | None:
    if not email:
        return None
    row = db.query_one(
        "SELECT id FROM users WHERE tenant_id = %s AND lower(email) = lower(%s)",
        (tenant["id"], email),
    )
    return row["id"] if row else None


@ingest.post("/engagement/start", status_code=201)
def ingest_engagement_start(req: EngagementStart, request: Request,
                            x_gapvision_key: str | None = KeyHeader):
    guard(request, req.tenant, x_gapvision_key)
    t = _ingest_tenant(req.tenant)
    row = analytics.start_engagement(
        t["id"], guest_ref=req.guest_ref, zone=req.zone,
        associate_user_id=_user_in(t, req.associate_email),
    )
    return {"engagement_id": str(row["id"]), "started_at": row["started_at"]}


@ingest.post("/engagement/end")
def ingest_engagement_end(req: EngagementEnd, request: Request,
                          x_gapvision_key: str | None = KeyHeader):
    guard(request, None, x_gapvision_key)
    row = analytics.end_engagement(
        req.engagement_id, outcome=req.outcome, sale_cents=req.sale_cents
    )
    # Already closed, or never existed: not an error worth failing a socket
    # handler over.
    return {"ok": row is not None}


@ingest.post("/voice", status_code=201)
def ingest_voice(req: VoiceRecord, request: Request,
                 x_gapvision_key: str | None = KeyHeader):
    guard(request, req.tenant, x_gapvision_key)
    t = _ingest_tenant(req.tenant)
    row = analytics.record_voice_query(
        t,
        engagement_id=req.engagement_id,
        user_id=_user_in(t, req.associate_email),
        intent=req.intent, ok=req.ok, resolved_by=req.resolved_by,
        latency_ms=req.latency_ms, audio_seconds=req.audio_seconds,
        stt_provider=req.stt_provider, transcript=req.transcript,
    )
    return {"voice_query_id": str(row["id"])}


@ingest.post("/assist", status_code=201)
def ingest_assist(req: AssistRecord, request: Request,
                  x_gapvision_key: str | None = KeyHeader):
    guard(request, req.tenant, x_gapvision_key)
    t = _ingest_tenant(req.tenant)
    helper = _user_in(t, req.helper_email)
    if helper is None:
        raise HTTPException(status_code=404, detail="Unknown associate")
    row = analytics.record_assist(
        t["id"], helper_user_id=helper, engagement_id=req.engagement_id, note=req.note
    )
    return {"assist_id": str(row["id"])}
