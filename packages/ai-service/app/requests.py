"""What the guest wants brought to them.

    from app import requests as guest_requests
    guest_requests.open_request(tenant, guest_ref="c-1", zone="fitting-room-3",
                                need="size", sku="GAP-DNM-0498", size="32x30")

Presence says someone is here. This says what they want, in their own words,
from their own phone — and it is the first thing in this system a customer
authors rather than has inferred about them.

A request must be attached to a live check-in
---------------------------------------------
Not a formality. The zone comes from the plate they tapped, so without a live
check-in there is nowhere to bring anything and no evidence anyone agreed to
be helped. Refusing here means the only way to put a request on an associate's
glasses is for a guest to have deliberately opened a door first.

Vocabulary, not free text, for the thing that reaches the glass
---------------------------------------------------------------
`need` is a fixed set and `note` is optional. The lens has three lines and no
scrollbar in the guest's hand: if the actionable part of a request could only
be recovered by reading a paragraph, the paragraph would be the feature and it
would fail on a busy floor. So every request carries something an associate
can act on before they read a word of prose.
"""
from __future__ import annotations

import os
from typing import Any

from fastapi import HTTPException

from . import db, presence

#: A request outlives the check-in that spawned it — briefly. Somebody who asks
#: for a 32 and then walks out has stopped waiting, and a request that outlives
#: their patience is worse than no request, because an associate walks a jean
#: to an empty room.
STALE_MINUTES = int(os.getenv("CUE_REQUEST_STALE_MINUTES", "30"))

#: What a guest can be asking for. Short on purpose — this is a fitting-room
#: vocabulary, not a helpdesk taxonomy, and every entry has to mean something
#: different to the person walking over.
NEEDS: dict[str, str] = {
    "size":     "A different size",
    "colour":   "A different colour",
    "item":     "Something else from the floor",
    "checkout": "Ready to pay",
    "opinion":  "A second opinion",
    "other":    "Something else",
}

#: Where the ask came from. `app` means the retailer's own app posted on the
#: guest's behalf; `web` is our page. Kept apart from the presence source
#: because a guest can tap a plate and then ask in the app.
SURFACES = ("web", "app")


def need_label(need: str) -> str:
    return NEEDS.get(need, NEEDS["other"])


def open_request(tenant: dict, *, guest_ref: str, zone: str | None = None,
                 need: str = "other", sku: str | None = None,
                 product: str | None = None, size: str | None = None,
                 note: str | None = None, surface: str = "web") -> dict[str, Any]:
    """Log what a guest asked for. Returns the row and a line for the glass."""
    guest_ref = (guest_ref or "").strip()
    if not guest_ref:
        raise HTTPException(status_code=400, detail="guest_ref is required")
    if need not in NEEDS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown need: {need}. Known: {', '.join(sorted(NEEDS))}")
    if surface not in SURFACES:
        raise HTTPException(status_code=400, detail=f"Unknown surface: {surface}")

    live = presence.is_present(tenant, guest_ref)
    if live is None:
        # 409 rather than 404: the guest exists and the request is well formed,
        # but there is no visit to attach it to. The page's correct move is to
        # check them in again, not to retry this.
        raise HTTPException(
            status_code=409,
            detail="No live check-in for this guest. Check in first.")

    # The plate is more trustworthy than the form. A page that posts a zone is
    # posting whatever was in its URL when it loaded, and a guest who wandered
    # from one room to another re-tapped a plate to get here.
    zone = live.get("zone") or zone

    note = (note or "").strip() or None
    if note and len(note) > 400:
        note = note[:400]

    row = db.query_one(
        """
        INSERT INTO guest_requests
            (tenant_id, guest_ref, zone, surface, sku, product, size, need, note)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id, created_at, status
        """,
        (tenant["id"], guest_ref, zone, surface, sku, product, size, need, note),
    )
    return {
        "ok": True,
        "request_id": str(row["id"]),
        "status": row["status"],
        "zone": zone,
        "need": need,
        "sku": sku,
        "product": product,
        "size": size,
        "note": note,
        "created_at": row["created_at"].isoformat(),
        "line": glass_line(need=need, product=product, size=size, note=note),
    }


def glass_line(*, need: str, product: str | None, size: str | None,
               note: str | None) -> str:
    """One line an associate can act on, composed here and not by a model.

    Ordered by what gets somebody moving: the size first, because that is the
    thing they have to go and find, then what it is, then the shape of the ask.
    A note is never the whole line — it rides behind the actionable part, and
    the display layer decides how much of it survives.
    """
    bits = []
    if size:
        bits.append(size)
    if product:
        bits.append(product)
    if not bits:
        bits.append(need_label(need))
    line = " · ".join(bits)
    if note:
        line = f"{line} — {note}"
    return line


def open_for_zone(tenant_id: str, zone: str | None = None) -> list[dict]:
    """What is waiting. Oldest first — somebody in a fitting room is the most
    time-sensitive row in the system."""
    return db.query(
        """
        SELECT r.*, u.name AS claimed_by_name
          FROM guest_requests r
     LEFT JOIN users u ON u.id = r.claimed_by
         WHERE r.tenant_id = %s
           AND r.status IN ('open', 'claimed')
           AND r.created_at > now() - make_interval(mins => %s)
           -- Cast: an untyped NULL parameter compared against nothing else
           -- leaves Postgres unable to infer the type, and the query fails at
           -- execution rather than at write time.
           AND (%s::text IS NULL OR r.zone = %s::text)
      ORDER BY r.created_at ASC
        """,
        (tenant_id, STALE_MINUTES, zone, zone),
    )


def claim(tenant: dict, request_id: str, user_id: str | None) -> dict:
    """An associate picking one up. First one wins.

    Conditioned on the row still being open, so two associates tapping at once
    produce one claim and one honest "already taken" rather than two people
    walking to the same room with the same jean.
    """
    row = db.query_one(
        """
        UPDATE guest_requests
           SET status = 'claimed', claimed_by = %s, claimed_at = now()
         WHERE id = %s AND tenant_id = %s AND status = 'open'
        RETURNING id, zone, need, sku, product, size
        """,
        (user_id, request_id, tenant["id"]),
    )
    if row is None:
        raise HTTPException(status_code=409, detail="Already taken or closed")
    return {"ok": True, "request_id": str(row["id"]), "status": "claimed"}


def resolve(tenant: dict, request_id: str, status: str = "done") -> dict:
    if status not in ("done", "cancelled"):
        raise HTTPException(status_code=400, detail="status must be done or cancelled")
    row = db.query_one(
        """
        UPDATE guest_requests
           SET status = %s, resolved_at = now()
         WHERE id = %s AND tenant_id = %s AND status IN ('open', 'claimed')
        RETURNING id
        """,
        (status, request_id, tenant["id"]),
    )
    if row is None:
        raise HTTPException(status_code=404, detail="No open request with that id")
    return {"ok": True, "request_id": str(row["id"]), "status": status}


def cancel_for_guest(tenant: dict, guest_ref: str) -> int:
    """Everything this guest has open, closed at once.

    Called when they revoke: somebody who taps Stop has stopped waiting, and
    leaving their requests on the floor would send an associate to a room the
    guest has already left.
    """
    return db.execute(
        """
        UPDATE guest_requests
           SET status = 'cancelled', resolved_at = now()
         WHERE tenant_id = %s AND guest_ref = %s AND status IN ('open', 'claimed')
        """,
        (tenant["id"], guest_ref),
    )


def demand(tenant_id: str, days: int = 30) -> list[dict]:
    """What people ask for, and how long they wait for it.

    A question about a shop rather than about a shopper, which is why it
    survives the retention sweep: `sku`, `size` and `need` are kept and the
    guest pointer and their free text are not.
    """
    return db.query(
        """
        SELECT need, sku, product, size,
               count(*) AS asks,
               count(*) FILTER (WHERE status = 'done') AS fulfilled,
               round(avg(EXTRACT(EPOCH FROM (claimed_at - created_at)))
                     FILTER (WHERE claimed_at IS NOT NULL)) AS avg_claim_seconds
          FROM guest_requests
         WHERE tenant_id = %s AND created_at > now() - make_interval(days => %s)
      GROUP BY need, sku, product, size
      ORDER BY count(*) DESC
         LIMIT 100
        """,
        (tenant_id, days),
    )
