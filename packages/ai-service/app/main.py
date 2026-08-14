"""GapVision AI Service — FastAPI.

The Brain: guest context, persona matching, and clienteling script
generation. Multi-tenant: the `tenant` parameter selects the CRM world
("gap" demo dataset or "shopify" live store). LLM is pluggable via
GAPVISION_LLM. Identification is opt-in signal only.

Data endpoints require a service key — see app/auth.py. Browser clients do
not hold the key; they call the realtime server, which proxies.
"""
import os

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .auth import KeyHeader, guard, startup_check
from .crm_provider import TenantNotConfigured, get_crm_for, tenant_status
from .llm import get_provider
from .personas import match_products

app = FastAPI(title="GapVision AI Service", version="0.5.0")

_AUTH_STATE = startup_check()

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
    allow_methods=["GET", "POST"],
    allow_headers=["content-type", "x-gapvision-key"],
)


class GuestContextRequest(BaseModel):
    guest_id: str
    zone: str | None = None   # beacon zone, e.g. "Denim Wall"
    tenant: str | None = "gap"


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
        "tenants": tenant_status(),
        "auth": _AUTH_STATE,
    }


@app.get("/api/guests")
def list_guests(request: Request, tenant: str = "gap", x_gapvision_key: str | None = KeyHeader):
    """Roster of opted-in guests for the given tenant.

    Dev affordance only. In production, tap check-in resolves one specific
    guest on request — a roster of everyone is the shape this product exists
    to avoid. Do not expose it to a client.
    """
    guard(request, tenant, x_gapvision_key)
    return _crm(tenant).all_guests()


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
