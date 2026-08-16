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

from . import analytics, capabilities, db, identity, presence, shifts
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


@router.get("/shifts")
def get_shifts(days: int = 7, tenant: str | None = None,
               authorization: str | None = BearerHeader):
    """Hours worked, and every count divided by them.

    The denominator the rest of this file has never had. Both halves of every
    rate come back beside it — the count and the hours — because the first
    question anybody asks a rate is "out of what", and a ratio nobody can
    decompose is a ratio nobody acts on.

    Answers 200 with `enabled: false` and no rows when the tenant has shift
    telemetry off, rather than 403. A manager whose store never turned this on
    is not doing anything wrong, and a panel that can say "your store has this
    switched off" is worth more than an error a dashboard renders as a crash.
    """
    me = current_user(authorization)
    require(me, "manager")
    t = _tenant_for(me, tenant)
    if not (t.get("privacy") or {}).get(capabilities.SHIFT_TELEMETRY):
        return {
            "tenant": t["slug"], "window_days": _clamp(days, 1, 365),
            "enabled": False, "rows": [],
            "totals": {"hours_worked": 0.0, "shifts": 0, "on_shift_now": 0,
                       "associates_with_hours": 0, "engagements_per_hour": None},
            "unassigned_devices": {"shifts": 0, "hours_worked": 0.0, "devices": 0},
            "gap_minutes": shifts.GAP_MINUTES,
            "min_hours_for_rate": shifts.MIN_HOURS_FOR_RATE,
            "detail": ("Shift timing is off for this store. A client_admin turns "
                       "it on in Console → Tenants. It measures staff, so it is "
                       "off until somebody says otherwise."),
        }
    return {"tenant": t["slug"], **shifts.coverage(t, days=_clamp(days, 1, 365))}


@router.get("/fleet")
def get_fleet(tenant: str | None = None, authorization: str | None = BearerHeader):
    """Battery and connection, per pair of glasses, worst first.

    A manager looking at somebody's numbers needs to be able to see that their
    glasses died at three. Same gate as `/shifts` and the same reason for
    answering 200 with `enabled: false`.
    """
    me = current_user(authorization)
    require(me, "manager")
    t = _tenant_for(me, tenant)
    enabled = bool((t.get("privacy") or {}).get(capabilities.SHIFT_TELEMETRY))
    return {
        "tenant": t["slug"],
        "enabled": enabled,
        "low_battery_percent": shifts.LOW_BATTERY_PERCENT,
        "devices": shifts.fleet(t["id"]) if enabled else [],
        "arrivals": shifts.arrivals(t["id"]) if enabled else None,
    }


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, int(value)))


# --- ingest (service key) ----------------------------------------------------

class EngagementStart(BaseModel):
    tenant: str
    guest_ref: str | None = None
    zone: str | None = None
    associate_email: str | None = None
    device_serial: str | None = None
    device_model: str | None = None
    #: What the glasses showed to open this engagement. Stored as sent — see
    #: analytics.start_engagement for why it is not re-derived later.
    recommendations: list = []
    cue_lines: list[str] = []


class EngagementEnd(BaseModel):
    engagement_id: str
    outcome: str | None = None
    sale_cents: int = 0


class VoiceRecord(BaseModel):
    tenant: str
    engagement_id: str | None = None
    associate_email: str | None = None
    device_serial: str | None = None
    device_model: str | None = None
    intent: str | None = None
    ok: bool = True
    resolved_by: str | None = None
    latency_ms: int | None = None
    audio_seconds: float | None = None
    stt_provider: str | None = None
    transcript: str | None = None
    #: Dropped alongside the transcript unless the tenant stores words.
    answer: str | None = None


class PresenceIn(BaseModel):
    tenant: str
    guest_ref: str
    zone: str | None = None
    #: Which front door. Consent is derived from this and never accepted from
    #: the caller — see presence.py.
    source: str = "demo"


class PresenceRevoke(BaseModel):
    tenant: str
    guest_ref: str


class ShiftStart(BaseModel):
    """An associate is on the floor with the product running.

    `occurred_at` is the phone's own clock, and `replayed` says whether this
    came out of the plugin's offline buffer rather than straight off the wire.
    Both are recorded and neither is trusted for a duration — see
    `app/shifts.py`, which is the only place that decides what a client clock
    may do.
    """
    tenant: str
    associate_email: str | None = None
    device_serial: str | None = None
    device_model: str | None = None
    zone: str | None = None
    #: A shift the plugin still believes in. The WebView is torn down every
    #: time the phone goes in a pocket, and one shift must not become nine.
    resume_shift_id: str | None = None
    occurred_at: str | None = None
    replayed: bool = False


class ShiftHeartbeat(BaseModel):
    tenant: str
    shift_id: str


class ShiftEnd(BaseModel):
    tenant: str
    shift_id: str
    #: `signed_out` or `app_closed`. `heartbeat_gap` and `superseded` are the
    #: server's to write; a client cannot know either and is not asked to.
    reason: str | None = None
    occurred_at: str | None = None
    replayed: bool = False


class DeviceHealth(BaseModel):
    """One `DeviceStatus` from the Even SDK, forwarded by the realtime server."""
    tenant: str
    device_serial: str
    device_model: str | None = None
    battery_percent: int | None = None
    charging: bool | None = None
    in_case: bool | None = None
    wearing: bool | None = None
    connection: str | None = None
    occurred_at: str | None = None
    replayed: bool = False


class AssistRecord(BaseModel):
    tenant: str
    helper_email: str | None = None
    engagement_id: str | None = None
    note: str | None = None
    device_serial: str | None = None
    device_model: str | None = None


@ingest.post("/presence", status_code=201)
def ingest_presence(req: PresenceIn, request: Request,
                    x_gapvision_key: str | None = KeyHeader):
    """A guest arrived, through one of the front doors.

    Sits behind the service key like every other ingest route, which means the
    caller is the realtime server or a retailer's gateway — never a browser. A
    guest's own phone reaches this by loading a page that talks to the realtime
    server, exactly as the dashboards do. Anything else would put the key in a
    browser, and the whole trust boundary is that it never goes there.
    """
    guard(request, None, x_gapvision_key)
    t = _ingest_tenant(req.tenant)
    return presence.record(t, guest_ref=req.guest_ref, zone=req.zone,
                           source=req.source)


@ingest.post("/presence/revoke")
def ingest_presence_revoke(req: PresenceRevoke, request: Request,
                           x_gapvision_key: str | None = KeyHeader):
    """A guest withdrawing mid-visit. Closes every live check-in for them."""
    guard(request, None, x_gapvision_key)
    t = _ingest_tenant(req.tenant)
    return {"ok": True, "closed": presence.revoke(t, guest_ref=req.guest_ref)}


@router.get("/doors")
def get_doors(days: int = 30, tenant: str | None = None,
              authorization: str | None = BearerHeader):
    """Which front doors people actually use.

    Counts, never a list of who came through which. The point is to decide
    where the next hundred plates go.
    """
    me = current_user(authorization)
    require(me, "manager")
    t = _tenant_for(me, tenant)
    return {"tenant": t["slug"], "window_days": _clamp(days, 1, 365),
            "doors": presence.door_counts(t["id"], _clamp(days, 1, 365)),
            "known": presence.SOURCES}


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


#: Devices announce their own model; anything unexpected is stored as a g2
#: rather than rejected, because the plugin only runs on glasses and a CHECK
#: violation here would fail a write nobody can see.
_MODELS = ("g2", "g1", "ring1")


def _associate(tenant: dict, *, device_serial: str | None,
               email: str | None, device_model: str | None = None) -> str | None:
    """Who did this — by the hardware first, by email second.

    The glasses cannot tell us an email. The Even SDK's UserInfo carries a
    uid, a display name, an avatar and a country, and that is all; attribution
    used to depend on an email the plugin had no way to obtain, which is why
    every engagement recorded so far is unattributed.

    A serial is what the device actually knows about itself, and `devices`
    already stores one per tenant with a `user_id` beside it. Email is kept as
    a fallback for the simulator and for tests, which do have one.

    Registering the device also has a side effect worth having: it is the only
    place that can honestly stamp `last_seen_at`, which the Health panel reads.
    """
    if device_serial:
        row = db.query_one(
            """
            UPDATE devices SET last_seen_at = now()
             WHERE tenant_id = %s AND serial = %s
             RETURNING user_id
            """,
            (tenant["id"], device_serial),
        )
        if row is None:
            # Never seen this one. Record it, unassigned, rather than throwing
            # the serial away: the console can then offer "this device has been
            # on the floor, who is wearing it?" instead of asking someone to
            # find a serial number on a pair of glasses and type it correctly.
            #
            # Only the realtime server can reach this route — it holds the
            # service key — so this cannot be used to fill the table from
            # outside.
            model = (device_model or "").lower()
            db.execute(
                """
                INSERT INTO devices (tenant_id, model, serial, last_seen_at)
                VALUES (%s, %s, %s, now())
                ON CONFLICT (tenant_id, serial) DO UPDATE SET last_seen_at = now()
                """,
                (tenant["id"], model if model in _MODELS else "g2", device_serial),
            )
        elif row["user_id"]:
            return str(row["user_id"])
        # Known but unassigned: falls through. Activity is still recorded
        # against the tenant, just without a name on it — an associate
        # mid-conversation must never have a write fail underneath them.
    return _user_in(tenant, email)


# --- shifts and hardware (service key + the tenant's own switch) -------------
#
# Every route below writes data about an *associate*: when they were working,
# and what their glasses were doing while they worked. That is performance
# monitoring, which is a different consent question from anything about a
# guest — so it carries a second gate on top of the service key, and the gate
# is read from the database on every call rather than taken from the caller.
#
# The plugin holds a copy of the same flag and uses it to decide what to send.
# That copy decides what is *drawn and emitted*; this is what decides what is
# *recorded*. A static bundle on a phone is not a place to enforce a consent
# decision, and the two are kept deliberately separate for that reason.

def _telemetry_tenant(slug: str) -> dict:
    tenant = _ingest_tenant(slug)
    if not capabilities.shift_telemetry(tenant["slug"]):
        raise HTTPException(
            status_code=403,
            detail=(f"Shift telemetry is off for tenant '{tenant['slug']}' "
                    f"(privacy.{capabilities.SHIFT_TELEMETRY}). It is off by "
                    f"default: this records when staff are working and how "
                    f"their hardware behaves, which is a decision for the "
                    f"retailer and their staff, not for us. A client_admin "
                    f"turns it on in Console → Tenants."),
        )
    return tenant


@ingest.post("/shift/start", status_code=201)
def ingest_shift_start(req: ShiftStart, request: Request,
                       x_gapvision_key: str | None = KeyHeader):
    guard(request, req.tenant, x_gapvision_key)
    t = _telemetry_tenant(req.tenant)
    return shifts.start(
        t,
        user_id=_associate(t, device_serial=req.device_serial,
                           email=req.associate_email, device_model=req.device_model),
        device_serial=req.device_serial, zone=req.zone,
        occurred_at=req.occurred_at, resume_shift_id=req.resume_shift_id,
        replayed=req.replayed,
    )


@ingest.post("/shift/heartbeat")
def ingest_shift_heartbeat(req: ShiftHeartbeat, request: Request,
                           x_gapvision_key: str | None = KeyHeader):
    """Still there.

    Stamped with this machine's clock and carries no client time at all — a
    heartbeat's only job is to say "now", and a claimed "now" from a phone is
    exactly the thing this design refuses to believe.
    """
    guard(request, req.tenant, x_gapvision_key)
    t = _telemetry_tenant(req.tenant)
    return shifts.heartbeat(t, shift_id=req.shift_id)


@ingest.post("/shift/end")
def ingest_shift_end(req: ShiftEnd, request: Request,
                     x_gapvision_key: str | None = KeyHeader):
    guard(request, req.tenant, x_gapvision_key)
    t = _telemetry_tenant(req.tenant)
    return shifts.end(t, shift_id=req.shift_id, reason=req.reason,
                      occurred_at=req.occurred_at, replayed=req.replayed)


@ingest.post("/device/health", status_code=201)
def ingest_device_health(req: DeviceHealth, request: Request,
                         x_gapvision_key: str | None = KeyHeader):
    guard(request, req.tenant, x_gapvision_key)
    t = _telemetry_tenant(req.tenant)
    # Registers an unknown serial the same way an engagement does, so a pair of
    # glasses that has only ever reported its battery still appears in Console
    # with a name to assign.
    _associate(t, device_serial=req.device_serial, email=None,
               device_model=req.device_model)
    return shifts.record_health(
        t, device_serial=req.device_serial, battery_percent=req.battery_percent,
        charging=req.charging, in_case=req.in_case, wearing=req.wearing,
        connection=req.connection, occurred_at=req.occurred_at,
        replayed=req.replayed,
    )


@ingest.post("/engagement/start", status_code=201)
def ingest_engagement_start(req: EngagementStart, request: Request,
                            x_gapvision_key: str | None = KeyHeader):
    guard(request, req.tenant, x_gapvision_key)
    t = _ingest_tenant(req.tenant)
    row = analytics.start_engagement(
        t["id"], guest_ref=req.guest_ref, zone=req.zone,
        associate_user_id=_associate(
            t, device_serial=req.device_serial, email=req.associate_email,
            device_model=req.device_model),
        recommendations=req.recommendations, cue_lines=req.cue_lines,
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
        user_id=_associate(
            t, device_serial=req.device_serial, email=req.associate_email,
            device_model=req.device_model),
        intent=req.intent, ok=req.ok, resolved_by=req.resolved_by,
        latency_ms=req.latency_ms, audio_seconds=req.audio_seconds,
        stt_provider=req.stt_provider, transcript=req.transcript,
        answer=req.answer,
    )
    return {"voice_query_id": str(row["id"])}


@ingest.post("/assist", status_code=201)
def ingest_assist(req: AssistRecord, request: Request,
                  x_gapvision_key: str | None = KeyHeader):
    guard(request, req.tenant, x_gapvision_key)
    t = _ingest_tenant(req.tenant)
    # An assist must name someone — the whole point of the record is that a
    # specific person gets credit for helping. Unlike an engagement, there is
    # nothing useful to store without it.
    helper = _associate(t, device_serial=req.device_serial, email=req.helper_email,
                        device_model=req.device_model)
    if helper is None:
        raise HTTPException(status_code=404, detail="Unknown associate")
    row = analytics.record_assist(
        t["id"], helper_user_id=helper, engagement_id=req.engagement_id, note=req.note
    )
    return {"assist_id": str(row["id"])}
