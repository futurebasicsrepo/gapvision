"""CueSea AI Service — FastAPI.

The Brain: guest context, persona matching, clienteling script generation,
and voice queries. Multi-tenant: the `tenant` parameter selects the CRM world
("gap" demo dataset or "shopify" live store). LLM and STT are pluggable via
GAPVISION_LLM / CUE_STT. Identification is opt-in signal only.

The phone camera path (`/api/vision/analyze`) photographs objects — a SKU tag,
a part — and never people, is off per tenant by default, and stores no image.

Data endpoints require a service key — see app/auth.py. Browser clients do
not hold the key; they call the realtime server, which proxies.
"""
import base64
import binascii
import os

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import (capabilities, checkout, db, mailer, pos, retention, secrets_box,
               vision, widgets)
from .auth import KeyHeader, guard, startup_check
from . import crm_provider
from .crm_provider import TenantNotConfigured, get_crm_for, tenant_status
from .llm import get_provider
from .personas import match_products
from .routes_admin import router as admin_router
from .routes_analytics import ingest as ingest_router, router as analytics_router
from .routes_auth import router as auth_router
from .routes_device import (admin_router as device_admin_router,
                            device_auth_router)
from .routes_guest import (guest as guest_router,
                           ingest as guest_ingest_router,
                           router as guest_analytics_router)
from .stt import (
    MAX_AUDIO_BYTES,
    SAMPLE_RATE,
    STTError,
    audio_duration_seconds,
    describe_levels,
    get_stt,
)
from .voice import answer_query

app = FastAPI(title="CueSea AI Service", version="0.5.0")

_AUTH_STATE = startup_check()


@app.on_event("startup")
def _startup() -> None:
    """Apply migrations on boot.

    The control plane is small and the migrations are additive, so running
    them at startup keeps a Railway deploy to one step. If no database is
    configured the service still runs — the guest-context and voice paths
    predate it and must not start requiring one.
    """
    if not db.configured():
        print("[cue] no database configured — control plane disabled", flush=True)
        return
    try:
        applied = db.migrate()
        print(f"[cue] database ready ({len(applied)} migration(s) applied)", flush=True)
    except Exception as e:  # a bad migration must not take the lens offline
        print(f"[cue] WARNING: migrations failed: {e}", flush=True)
        return

    try:
        from .seed import bootstrap
        bootstrap()
    except Exception as e:
        print(f"[cue] WARNING: bootstrap failed: {e}", flush=True)

    _start_retention_loop()


def _start_retention_loop() -> None:
    """Sweep aged personal data on a timer, in-process.

    In-process rather than a Railway cron or an external scheduler, for one
    reason: a retention policy that depends on a second system being
    configured is a retention policy that silently stops the first time
    somebody redeploys without it. This starts whenever the service starts,
    which is the same condition under which data starts being written.

    It sweeps once shortly after boot rather than immediately — a deploy
    restarts the process, and a redeploy loop should not mean a sweep loop
    hammering the database while requests are already arriving.

    Failures are logged and swallowed. Retention falling over must never take
    the lens offline; an associate mid-conversation does not care that last
    night's sweep failed, and the Health panel will say so.
    """
    import asyncio

    interval = int(os.getenv("CUE_RETENTION_INTERVAL_SECONDS", str(6 * 3600)))
    if interval <= 0:
        print("[cue] retention sweep disabled by env", flush=True)
        return

    async def loop() -> None:
        await asyncio.sleep(60)
        while True:
            try:
                runs = await asyncio.to_thread(retention.sweep_all)
                touched = sum(
                    r["voice_redacted"] + r["engagements_redacted"]
                    + r["assists_redacted"] for r in runs)
                if touched:
                    print(f"[cue] retention: redacted {touched} row(s) "
                          f"across {len(runs)} tenant(s)", flush=True)
            except Exception as e:
                print(f"[cue] WARNING: retention sweep failed: {e}", flush=True)
            await asyncio.sleep(interval)

    try:
        # get_running_loop, not get_event_loop: the latter is deprecated when
        # there is no running loop and warns instead of raising cleanly, which
        # is the exact case this except clause exists to handle.
        asyncio.get_running_loop().create_task(loop())
        print(f"[cue] retention sweep every {interval}s", flush=True)
    except RuntimeError as e:
        # No running loop (a sync test client, a script importing the app).
        # Not fatal: the admin route can still run it on demand.
        print(f"[cue] retention loop not started: {e}", flush=True)

# Browsers should not reach this service directly any more — the realtime
# server proxies on their behalf. Keep an allowlist for local development
# rather than the previous wildcard, which let any page on the internet read
# responses cross-origin.
_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "GAPVISION_ALLOWED_ORIGINS",
        "http://localhost:5173,http://localhost:5180",
    ).split(",")
    if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ORIGINS,
    # The admin surfaces use PATCH, PUT and DELETE, and every authenticated call
    # carries an `authorization` header — which makes even a GET a preflighted
    # request. Both were missing, so a browser on a listed dev origin failed
    # every admin call at the preflight. Production never noticed because the
    # console reaches this service through the realtime server, same-origin.
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
    allow_headers=["content-type", "authorization", "x-gapvision-key"],
)


class GuestContextRequest(BaseModel):
    guest_id: str
    zone: str | None = None   # beacon zone, e.g. "Denim Wall"
    tenant: str | None = "gap"


class VoiceQueryRequest(BaseModel):
    """One utterance from an associate's glasses.

    Either `audio_b64` (raw 16 kHz mono 16-bit LE PCM, base64) or a
    pre-transcribed `transcript` — the second path lets a phone-side or
    on-device recognizer skip the server STT hop entirely.
    """
    tenant: str | None = "gap"
    audio_b64: str | None = None
    transcript: str | None = None
    sample_rate: int = SAMPLE_RATE
    guest_id: str | None = None   # who the associate is engaged with, if anyone
    focus_sku: str | None = None  # what's on the lens — resolves "these"
    zone: str | None = None


def _crm(tenant: str | None):
    try:
        return get_crm_for(tenant)
    except TenantNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))


@app.get("/health")
def health():
    """Unauthenticated on purpose — the scheduled health check polls it.

    Reports whether auth is configured, never the key itself, and no tenant
    data.
    """
    return {
        "status": "ok",
        "llm_provider": get_provider().name,
        "stt_provider": get_stt().name,
        # Counts, not slugs — the list of tenants is the list of customers, and
        # this route is deliberately open so the scheduled check can poll it.
        "tenants": tenant_status(),
        "auth": _AUTH_STATE,
        "credential_encryption": secrets_box.status(),
        "database": db.health(),
        "retention": retention.status(),
        "mail": mailer.status(),
    }


app.include_router(auth_router)
app.include_router(admin_router)
# Provisioning: minting device identities (bearer, tenant-scoped) and
# redeeming them at register (service key). Separate module, same prefixes.
app.include_router(device_admin_router)
app.include_router(device_auth_router)
app.include_router(analytics_router)
app.include_router(ingest_router)
# The guest surface: check-in config, the catalogue a request form
# offers, and requests themselves. Same key, same boundary.
app.include_router(guest_router)
app.include_router(guest_ingest_router)
app.include_router(guest_analytics_router)


@app.get("/api/guests")
def list_guests(request: Request, tenant: str = "gap", x_gapvision_key: str | None = KeyHeader):
    """Roster of guests for a demo tenant, and only ever a demo tenant.

    A list of everyone in a store is the exact shape tap-to-reveal exists to
    eliminate, and it is enumerable: the ids it returns are the ids
    `/api/guest-context` takes. It survives at all because picking a guest off
    a list is how the simulator and the associate view stage an arrival with
    no plate to tap.

    So it is bounded by the only fact that cannot be typed by hand: whether
    the adapter behind this tenant can name a real person. A mock-backed
    tenant serves invented people and may list them. Anything holding a live
    credential is refused here, whatever the tenant is called — which is what
    makes "there is no endpoint that enumerates your customers" true rather
    than merely intended.
    """
    guard(request, tenant, x_gapvision_key)
    crm = _crm(tenant)
    if not crm_provider.serves_synthetic_guests(crm):
        raise HTTPException(
            status_code=403,
            detail=("Roster listing is available for demo tenants only. This "
                    "tenant has a live store connected, and CueSea has no "
                    "endpoint that enumerates a real customer list."),
        )
    return crm.all_guests()


@app.post("/api/guest-context")
def guest_context(req: GuestContextRequest, request: Request, x_gapvision_key: str | None = KeyHeader):
    """The core call: an identified guest in, full clienteling package out."""
    guard(request, req.tenant, x_gapvision_key)

    crm = _crm(req.tenant)
    guest = crm.get_guest(req.guest_id)
    if guest is None:
        raise HTTPException(status_code=404, detail="Unknown or non-opted-in guest")

    owned = {p["sku"] for p in guest["purchase_history"]}
    recommendations = match_products(
        guest["persona_tags"], owned, crm.floor_inventory()
    )
    script = get_provider().generate_script(guest, recommendations)

    return {
        "guest": guest,
        "zone": req.zone,
        "tenant": (req.tenant or "gap").lower(),
        "recommendations": recommendations,
        "script": script,
    }


@app.post("/api/voice-query")
def voice_query(req: VoiceQueryRequest, request: Request, x_gapvision_key: str | None = KeyHeader):
    """Voice path: audio in, grounded answer + display lines out.

    Guarded like the other data endpoints. A voice query carries a guest_id,
    and history questions return purchase records — this is the same door, so
    it gets the same lock. The realtime server holds the key; the plugin
    reaches this only through it.

    Failure is a first-class result here, not a 500: the associate is wearing
    the thing, so "didn't catch that" has to render on the lens like any other
    answer. Only genuinely unexpected states raise.
    """
    guard(request, req.tenant, x_gapvision_key)

    slug = (req.tenant or "gap").lower()
    if not capabilities.voice(slug):
        raise HTTPException(
            status_code=403,
            detail=(f"Voice is off for tenant '{slug}' (config.voice). A "
                    f"tenant admin turns it on in Console → Tenants. Until "
                    f"then this store's floor is not transcribed at all."),
        )

    crm = _crm(req.tenant)
    stt = get_stt()

    transcript = (req.transcript or "").strip()
    duration = None
    levels = None
    if not transcript:
        if not req.audio_b64:
            raise HTTPException(status_code=400, detail="Provide audio_b64 or transcript")
        try:
            pcm = base64.b64decode(req.audio_b64, validate=True)
        except (binascii.Error, ValueError):
            raise HTTPException(status_code=400, detail="audio_b64 is not valid base64")
        if len(pcm) > MAX_AUDIO_BYTES:
            raise HTTPException(status_code=413, detail="Audio exceeds the per-utterance limit")
        duration = round(audio_duration_seconds(pcm, req.sample_rate), 2)
        # Diagnostic only. The plugin decides when to close the mic from its own
        # on-device level; on real hardware that never fired and every question
        # ran to the 12 s cap. Measuring the audio we already have tells us what
        # the real levels are without another Even Hub upload to find out.
        levels = describe_levels(pcm, req.sample_rate)
        print(f"[cue] audio levels {levels}", flush=True)
        try:
            transcript = stt.transcribe(pcm, req.sample_rate)
        except STTError as e:
            return _voice_failure(str(e), stt.name, duration, levels)
        except Exception as e:  # vendor client blew up in an unexpected way
            return _voice_failure(f"Transcription failed: {e}", stt.name, duration, levels)

    if not transcript:
        return _voice_failure("Didn't catch that — try again", stt.name, duration, levels)

    guest = crm.get_guest(req.guest_id) if req.guest_id else None
    result = answer_query(
        transcript,
        crm.floor_inventory(),
        guest=guest,
        focus_sku=req.focus_sku,
    )
    result.update({
        "ok": True,
        "tenant": (req.tenant or "gap").lower(),
        "audio_levels": levels,
        "zone": req.zone,
        "stt_provider": stt.name,
        "audio_seconds": duration,
    })
    return result


@app.get("/api/tenant/capabilities")
def tenant_capabilities(request: Request, tenant: str = "gap",
                        x_gapvision_key: str | None = KeyHeader):
    """What a plugin may offer this associate. Booleans only.

    A plugin asking this is asking an operational question — do I draw the
    camera button, do I open the mic — and gets switches it can branch on.
    It does not get the tenant's privacy internals: retention windows and
    transcript policy live in the same jsonb column and none of it belongs in
    a static bundle on a phone.

    The client's copy of `camera_capture` decides what to draw and nothing
    else. `/api/vision/analyze` re-reads the flag server-side on every call,
    because a bundle running on somebody's phone is not a place to enforce a
    privacy decision.
    """
    guard(request, tenant, x_gapvision_key)
    # `known` is not a switch and is not used to decide anything — the
    # switches below already fail closed, and they stay closed for a tenant
    # that does not exist.
    #
    # It is here so the plugin can say *which* nothing it is looking at. An
    # unknown slug and a real store with the camera off returned an identical
    # 200, so a typo in a launch URL rendered as a working page with no camera
    # on it. Somebody then goes and checks the Console toggle they had already
    # set correctly — which is exactly what happened: the demo defaults to
    # `?tenant=gap`, the store's slug is `cuesea`, and the flag was on all
    # along. Same rule as the Health panel's: unknown must never render as a
    # valid answer.
    return {**capabilities.for_tenant(tenant), "known": capabilities.exists(tenant)}


@app.get("/api/tenant/widgets")
def tenant_widgets(request: Request, tenant: str = "gap",
                   x_gapvision_key: str | None = KeyHeader):
    """The content of every data-defined widget, for this store, right now.

    Separate from `/api/tenant/capabilities` because they answer different
    questions and change at different rates: capabilities are switches a
    plugin branches on, and this is *content* a plugin draws. Mixing them
    would mean re-fetching the switchboard every time a promotion's window
    opened.

    Only feed-backed widgets appear here. `customer`, `inventory` and
    `messaging` are rendered from live engagement data by the package itself
    and have nothing to fetch.

    The validity window is applied server-side. A client deciding what is
    "current" would drift with the phone's clock, which on a shop floor is a
    device somebody set by hand.
    """
    guard(request, tenant, x_gapvision_key)
    row = db.query_one("SELECT id FROM tenants WHERE slug = %s", (tenant,))
    if row is None:
        # Same posture as capabilities: unknown must not render as a valid
        # empty answer, or a typo in a launch URL looks like a store with no
        # promotions running.
        return {"known": False, "widgets": {}}
    return {
        "known": True,
        "widgets": {w: widgets.live(row["id"], w) for w in widgets.FEED_WIDGETS},
    }


class WidgetPrefs(BaseModel):
    user_id: str
    prefs: dict


@app.put("/api/tenant/widget-prefs")
def put_widget_prefs(req: WidgetPrefs, request: Request,
                     x_gapvision_key: str | None = KeyHeader):
    """Save an associate's deck order.

    Service key, and the `user_id` comes from the realtime server, which
    resolved it from the device's own provision token — not from anything the
    phone typed. The phone page has no session of its own (the G2 identifies
    by serial), so this is the only conduit, and it is the same shape as the
    device door: a server that already holds the key vouching for a client
    that cannot.
    """
    guard(request, None, x_gapvision_key)
    return {"prefs": widgets.save_prefs(req.user_id, req.prefs or {})}


class CheckoutItem(BaseModel):
    """One line, in whichever vocabulary the floor has for it."""
    code: str | None = None        # SKU or barcode — resolved against the store
    variant_id: str | None = None  # already-resolved Shopify variant GID
    title: str | None = None       # custom-line fallback
    name: str | None = None        # alias for title (the lens payload's word)
    price: float | None = None
    qty: int = 1


class CheckoutLinkRequest(BaseModel):
    tenant: str | None = "gap"
    guest_id: str | None = None    # attaches the customer: pre-fill + Shop Pay
    items: list[CheckoutItem]
    note: str | None = None
    associate: str | None = None   # for the draft's note — attribution a
                                   # merchant can read on the order itself


@app.post("/api/checkout-link")
def checkout_link(req: CheckoutLinkRequest, request: Request,
                  x_gapvision_key: str | None = KeyHeader):
    """Mint a Shopify-hosted checkout for the lines the floor just sold.

    Path B of the payments exploration: the guest pays on their own phone at
    the store's own checkout. Cue never touches the payment — the one write
    is a draft order, and the response is a URL (plus an inert QR matrix the
    phone page draws) that IS the store's checkout for those lines.

    Guarded like every data endpoint: it spends the store's credential and
    names a guest. The capability gate is re-read server-side per call —
    `checkout.build_link` refuses for a store that switched it off, whatever
    a stale client believes.
    """
    guard(request, req.tenant, x_gapvision_key)

    try:
        return checkout.build_link(
            _crm(req.tenant),
            (req.tenant or "gap").lower(),
            [i.model_dump() for i in req.items],
            guest_id=req.guest_id,
            note=req.note,
            associate=req.associate,
        )
    except checkout.CheckoutRefused as e:
        raise HTTPException(status_code=e.status, detail=e.detail)


class PosVerifyRequest(BaseModel):
    token: str


@app.post("/api/pos/verify")
def pos_verify(req: PosVerifyRequest, request: Request,
               x_gapvision_key: str | None = KeyHeader):
    """Check a Shopify POS session token and say whose till it is.

    Called by the realtime server (never by a browser) before it hands the
    POS extension the floor's live engagements. Guarded with the tenant slug
    "pos" — a name that is deliberately not in DEMO_TENANTS, so this door
    needs the service key even when the deployment runs in demo mode: the
    answer maps a token onto a tenant, which is not demo data.
    """
    guard(request, "pos", x_gapvision_key)
    try:
        return pos.verify_session_token(req.token)
    except pos.PosVerifyRefused as e:
        raise HTTPException(status_code=e.status, detail=e.detail)


class VisionAnalyzeRequest(BaseModel):
    """One photograph of an object, from the phone the plugin runs on.

    The G2 has no camera. This is the paired phone's, opened by the associate,
    pointed at a SKU tag or a broken part — never at a person. See `vision.py`.
    """
    tenant: str | None = "gap"
    kind: str = "sku"          # 'sku' | 'part'
    image_base64: str
    mime: str = "image/jpeg"
    note: str | None = None    # what they said while taking it
    zone: str | None = None    # where the associate is standing, for the
                               # direction line — never stored, never matched


@app.post("/api/vision/analyze")
def vision_analyze(req: VisionAnalyzeRequest, request: Request,
                   x_gapvision_key: str | None = KeyHeader):
    """Photograph in, cue out. The image is never stored — see `vision.py`.

    Two gates before anything is read, in this order: the service key, then the
    tenant's own `privacy.camera_capture`. The second is checked here rather
    than trusted from the client, because the client is a static bundle and the
    flag is the retailer's consent.
    """
    guard(request, req.tenant, x_gapvision_key)

    slug = (req.tenant or "gap").lower()
    if not capabilities.camera_capture(slug):
        raise HTTPException(
            status_code=403,
            detail=(f"Camera capture is off for tenant '{slug}' "
                    f"(privacy.{capabilities.CAMERA_CAPTURE}). It is off by "
                    f"default; a tenant admin turns it on in Console → "
                    f"Tenants. Photographs of objects only — this capability "
                    f"is never used to identify people."),
        )

    try:
        return vision.analyze(
            tenant=slug, kind=req.kind, image_base64=req.image_base64,
            mime=req.mime, note=req.note, crm=_crm(slug),
            zone=(req.zone or "").strip()[:40] or None,
        )
    except vision.VisionRefused as e:
        raise HTTPException(status_code=e.status, detail=e.detail)


def _voice_failure(message: str, stt_name: str, duration: float | None,
                   levels: dict | None = None) -> dict:
    return {
        "ok": False,
        "transcript": "",
        "intent": "error",
        "answer": message,
        "glasses_lines": [f"[ICON:WARN] {message}"],
        "matches": [],
        "stt_provider": stt_name,
        "audio_seconds": duration,
        # A failure is the most useful sample there is: an utterance that
        # transcribed to nothing is exactly the one whose levels we want.
        "audio_levels": levels,
    }
