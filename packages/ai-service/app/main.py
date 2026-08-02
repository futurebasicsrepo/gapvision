"""GapVision AI Service — FastAPI.

The Brain: guest context, persona matching, and clienteling script
generation. CRM is pluggable (mock / Shopify / Gap) via GAPVISION_CRM;
LLM is pluggable via GAPVISION_LLM. Identification is opt-in signal only.
"""
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .crm_provider import get_crm, provider_name
from .llm import get_provider
from .personas import match_products

app = FastAPI(title="GapVision AI Service", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class GuestContextRequest(BaseModel):
    guest_id: str
    zone: str | None = None  # beacon zone, e.g. "Denim Wall"


@app.get("/health")
def health():
    return {
        "status": "ok",
        "llm_provider": get_provider().name,
        "crm_provider": provider_name(),
    }


@app.get("/api/guests")
def list_guests():
    """Roster of opted-in guests (used by the simulator's beacon panel)."""
    return get_crm().all_guests()


@app.post("/api/guest-context")
def guest_context(req: GuestContextRequest):
    """The core call: beacon signal in, full clienteling package out."""
    crm = get_crm()
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
        "recommendations": recommendations,
        "script": script,
    }
