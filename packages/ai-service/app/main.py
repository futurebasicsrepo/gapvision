"""GapVision AI Service — FastAPI.

The Brain: guest context, persona matching, and clienteling script
generation. Multi-tenant: the `tenant` parameter selects the CRM world
("gap" demo dataset or "shopify" live store). LLM is pluggable via
GAPVISION_LLM. Identification is opt-in signal only.
"""
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .crm_provider import TenantNotConfigured, get_crm_for, tenant_status
from .llm import get_provider
from .personas import match_products

app = FastAPI(title="GapVision AI Service", version="0.4.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
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
    return {
        "status": "ok",
        "llm_provider": get_provider().name,
        "tenants": tenant_status(),
    }


@app.get("/api/guests")
def list_guests(tenant: str = "gap"):
    """Roster of opted-in guests for the given tenant."""
    return _crm(tenant).all_guests()


@app.post("/api/guest-context")
def guest_context(req: GuestContextRequest):
    """The core call: beacon signal in, full clienteling package out."""
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
