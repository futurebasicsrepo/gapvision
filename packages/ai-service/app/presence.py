"""Front doors — every way a guest can say "I'm here".

    from app import presence
    presence.record(tenant, guest_ref="guest-001", zone="fitting-room-3",
                    source="nfc-plate")

One endpoint, many doors. That is the whole design: a plate tap, a QR scan,
the retailer's app, a wallet pass, an order collection and an associate asking
politely are the same event arriving through different holes in the wall. Add
a door by adding a row to `SOURCES`, not by adding a subsystem.

Consent is a property of the door, not of the request
----------------------------------------------------
Each source declares what kind of agreement stands behind it, and the caller
cannot override it. That matters: if `consent` were a free field on the
request, the weakest door in the system could claim the strongest provenance,
and the column would stop being evidence of anything.

    device      the guest's own device acted, under a standing opt-in they
                set in an app. Strongest, and the only silent one.
    deliberate  the guest physically did something in the moment — tapped a
                plate, scanned a code, pressed a button. Per-visit, explicit,
                and it happened on their own phone.
    transaction identity is a by-product of a commitment they already made —
                collecting an order, arriving for a booked appointment.
    assisted    an associate asked and the guest agreed out loud. Weakest
                provenance, because the only record of the agreement is a
                person's account of it. Deliberately still supported: it is
                how retail already works, and refusing to model it would not
                stop it happening, it would only stop it being recorded.

`assisted` is the one to watch in review, and the reason it is a distinct
value rather than lumped in with the rest.

Not modelled, on purpose
------------------------
No path, no dwell, no zone-to-zone movement. Presence is a moment at a place.
A system that can reconstruct somebody's walk through a shop is a different
product with a different consent story, and the way you avoid building it by
accident is to not have the table.
"""
from __future__ import annotations

import os
from typing import Any

from fastapi import HTTPException

from . import db

#: How long a check-in stands before it lapses. Short on purpose — a guest who
#: leaves without telling anyone must stop being present, and `exit` events are
#: best-effort from every door.
TTL_MINUTES = int(os.getenv("CUE_PRESENCE_TTL_MINUTES", "45"))

#: Ignore a repeat from the same guest and door inside this window. A plate
#: gets tapped twice by someone unsure it worked, and a phone re-reads a tag as
#: it is lifted away; neither is a second arrival.
DEBOUNCE_SECONDS = int(os.getenv("CUE_PRESENCE_DEBOUNCE_SECONDS", "60"))

#: The registry. A new front door is a line here.
SOURCES: dict[str, dict[str, str]] = {
    "nfc-plate":         {"consent": "deliberate", "label": "Tapped a plate"},
    "qr-plate":          {"consent": "deliberate", "label": "Scanned a plate"},
    "app-checkin":       {"consent": "deliberate", "label": "Checked in in the app"},
    "app-beacon":        {"consent": "device",     "label": "App recognised the store"},
    "wallet-pass":       {"consent": "device",     "label": "Wallet pass"},
    "bopis":             {"consent": "transaction", "label": "Collecting an order"},
    "appointment":       {"consent": "transaction", "label": "Booked appointment"},
    "pos-lookup":        {"consent": "transaction", "label": "At the till"},
    "associate-assisted": {"consent": "assisted",  "label": "Associate asked, guest agreed"},
    # The simulator. Named rather than hidden, so demo traffic is never
    # mistaken for a real front door in the numbers.
    "demo":              {"consent": "deliberate", "label": "Demo beacon"},
}


#: A guest who checked in without saying who they are.
#:
#: I argued against this in `docs/check-in-page.md` and was half wrong. It is
#: right for the *cue*: an anonymous arrival composes an empty card and an
#: associate learns nothing, so identity has to come from the retailer's own
#: account. It is wrong for a *request*. "Fitting room 3 wants a 32 in the
#: barrel jean" is completely actionable and names nobody — the zone is the
#: address, and asking someone to sign in before they can ask for a size is
#: friction charged for our convenience rather than theirs.
#:
#: So an anonymous reference is a pointer to nothing, minted by the guest's own
#: browser, good for one visit. It must never be handed to the CRM.
ANON_PREFIX = "anon-"


def is_anonymous(guest_ref: str) -> bool:
    return str(guest_ref or "").startswith(ANON_PREFIX)


def source_info(source: str) -> dict[str, str]:
    info = SOURCES.get(source)
    if info is None:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown presence source: {source}. "
                   f"Known: {', '.join(sorted(SOURCES))}",
        )
    return info


def record(tenant: dict, *, guest_ref: str, zone: str | None,
           source: str) -> dict[str, Any]:
    """Log a guest arriving through a door. Returns what was recorded.

    `consent` comes from the source and is never taken from the caller — see
    the module docstring.
    """
    info = source_info(source)
    guest_ref = (guest_ref or "").strip()
    if not guest_ref:
        raise HTTPException(status_code=400, detail="guest_ref is required")

    recent = db.query_one(
        """
        SELECT id, created_at FROM presence_events
         WHERE tenant_id = %s AND guest_ref = %s AND source = %s
           AND revoked_at IS NULL
           AND created_at > now() - make_interval(secs => %s)
         ORDER BY created_at DESC LIMIT 1
        """,
        (tenant["id"], guest_ref, source, DEBOUNCE_SECONDS),
    )
    if recent:
        return {"ok": True, "deduped": True, "source": source,
                "consent": info["consent"], "zone": zone}

    row = db.query_one(
        """
        INSERT INTO presence_events
            (tenant_id, guest_ref, zone, source, consent, expires_at)
        VALUES (%s, %s, %s, %s, %s, now() + make_interval(mins => %s))
        RETURNING id, created_at, expires_at
        """,
        (tenant["id"], guest_ref, zone, source, info["consent"], TTL_MINUTES),
    )
    return {
        "ok": True, "deduped": False, "presence_id": str(row["id"]),
        "source": source, "consent": info["consent"], "zone": zone,
        "expires_at": row["expires_at"].isoformat(),
    }


def revoke(tenant: dict, *, guest_ref: str) -> int:
    """A guest withdrawing, mid-visit.

    Everything live for them, across every door — somebody who taps "stop"
    means stop, not "stop for the door I came through". Returns how many
    events were closed so a caller can tell the difference between a
    revocation and a no-op.
    """
    return db.execute(
        """
        UPDATE presence_events SET revoked_at = now()
         WHERE tenant_id = %s AND guest_ref = %s
           AND revoked_at IS NULL AND expires_at > now()
        """,
        (tenant["id"], guest_ref),
    )


def is_present(tenant: dict, guest_ref: str) -> dict | None:
    """The live check-in for a guest, if there is one."""
    return db.query_one(
        """
        SELECT * FROM presence_events
         WHERE tenant_id = %s AND guest_ref = %s
           AND revoked_at IS NULL AND expires_at > now()
         ORDER BY created_at DESC LIMIT 1
        """,
        (tenant["id"], guest_ref),
    )


def door_counts(tenant_id: str, days: int = 30) -> list[dict]:
    """Which doors people actually use.

    The question that decides where the next hundred plates go, and the reason
    `source` is a column rather than a comment. Counts only — never a list of
    who came through which door.
    """
    return db.query(
        """
        SELECT source, consent, count(*) AS events,
               count(DISTINCT guest_ref) AS guests
          FROM presence_events
         WHERE tenant_id = %s AND created_at > now() - make_interval(days => %s)
      GROUP BY source, consent
      ORDER BY count(*) DESC
        """,
        (tenant_id, days),
    )
