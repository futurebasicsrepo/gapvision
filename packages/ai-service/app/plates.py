"""Plates, and the token printed on them.

    from app import plates
    plates.mint(tenant, zone="fitting-room-3", source="nfc-plate")
    plates.resolve("K7QX3MZP2A9F")        # -> tenant, zone, source

Kyle: *"Both should be encrypted url so can't be shared."* Both doors now carry
an opaque token instead of `?t=gap&z=fitting-room-3&src=nfc-plate`, and this
module is what turns one back into a place.

What the token buys, precisely
------------------------------
1. **Nothing is readable.** A photograph of a plate no longer tells you the
   store's zone vocabulary, the tenant slug, or that there is a `src` field
   worth editing.
2. **Nothing is editable.** The old URL could be retyped for a different room
   or a different retailer. A token resolves or it does not.
3. **The door is in the token.** Tap and scan get different tokens, so a guest
   cannot claim the tap door — and the QR can be killed without disabling the
   tag six inches above it.
4. **It can be revoked.** One plate, one row, `revoked_at`. This is the part I
   argued against when the plates shipped this morning: I said a plate id would
   only add a key to manage. It adds revocation, and a leaked plate costing
   eleven dollars to replace is the difference between an incident and an
   errand.

What it does not buy, and pretending otherwise would be worse than the old URL
---------------------------------------------------------------------------
**A printed code can be photographed, and the photograph carries the token.**
Encryption does not change that: whatever is printed is a bearer credential
for as long as it is on the wall. Anyone claiming a static QR is unshareable is
describing a wish.

What actually ends sharing on the *tap* door is a tag that emits a different
URL every time it is read — NTAG 424 DNA and its equivalents append a tap
counter and a CMAC over it. A copied URL then carries a counter we have already
seen, and `check_sun()` refuses it. Those tags cost cents rather than a
redesign, and the columns and the check are here for when they are bought.

For the printed QR, which cannot rotate, the honest answer is three things,
none of which is cryptography: revoke and reprint (eleven dollars), a short
presence TTL so a stale check-in expires on its own, and `hits()` so a token
being used far more than a fitting room could plausibly produce is *visible*
rather than silent.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from typing import Any

from fastapi import HTTPException

from . import db, presence, secrets_box

#: Crockford-style: no I, L, O, U. A token gets read aloud down a phone line
#: to a store manager and typed into an installation sheet, and every pair
#: those letters form is a support call.
ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
TOKEN_LEN = 12          # 60 bits. Unguessable, and short enough for a small QR.

#: How many resolutions of one plate in an hour stop looking like a fitting
#: room and start looking like a link somebody posted. Not enforcement — a
#: fitting room on a Saturday is genuinely busy — but the number that makes a
#: shared token visible.
BUSY_HOUR = int(os.getenv("CUE_PLATE_BUSY_HOUR", "60"))


def new_token() -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(TOKEN_LEN))


def mint(tenant: dict, *, zone: str | None, source: str,
         label: str | None = None, token: str | None = None) -> dict[str, Any]:
    """Register a plate. The token is random, never derived.

    A token derived from the zone would leak the zone the moment somebody
    noticed the pattern, which is the thing we just stopped printing.
    """
    presence.source_info(source)          # refuse a door the service can't open
    tok = (token or new_token()).upper()
    if len(tok) < 8:
        raise HTTPException(status_code=400, detail="Token is too short to be a secret")

    row = db.query_one(
        """
        INSERT INTO plates (token, tenant_id, zone, source, label)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (token) DO UPDATE
            SET zone = EXCLUDED.zone, label = EXCLUDED.label, revoked_at = NULL
        RETURNING token, zone, source, label, created_at
        """,
        (tok, tenant["id"], zone, source, label),
    )
    return {"token": row["token"], "zone": row["zone"], "source": row["source"],
            "label": row["label"]}


def _hit(token: str, ok: bool, reason: str | None = None) -> None:
    db.execute("INSERT INTO plate_hits (token, ok, reason) VALUES (%s, %s, %s)",
               (token, ok, reason))


def resolve(token: str, *, counter: str | None = None,
            cmac: str | None = None) -> dict[str, Any]:
    """A token, back into a place. Raises rather than guessing.

    Every outcome is recorded, including the failures — a token being tried and
    refused is the most interesting thing this table can hold.
    """
    tok = (token or "").strip().upper()
    if not tok:
        raise HTTPException(status_code=400, detail="No plate token")

    row = db.query_one(
        """
        SELECT p.*, t.slug AS tenant_slug, t.name AS tenant_name
          FROM plates p JOIN tenants t ON t.id = p.tenant_id
         WHERE p.token = %s
        """,
        (tok,),
    )
    if row is None:
        _hit(tok, False, "unknown")
        # Deliberately the same answer as a revoked plate. Telling the
        # difference would turn this into an oracle for which tokens exist.
        raise HTTPException(status_code=404, detail="This code isn't in use.")
    if row["revoked_at"] is not None:
        _hit(tok, False, "revoked")
        raise HTTPException(status_code=404, detail="This code isn't in use.")

    if row["sun_required"] or (counter and row["sun_key"]):
        check_sun(row, counter=counter, cmac=cmac)

    _hit(tok, True, None)
    return {
        "token": tok,
        "tenant": row["tenant_slug"],
        "tenant_name": row["tenant_name"],
        "zone": row["zone"],
        "source": row["source"],
        "label": row["label"],
    }


# --- rotating-cryptogram tags -------------------------------------------------
def check_sun(plate: dict, *, counter: str | None, cmac: str | None) -> None:
    """Verify a tap that carries a fresh cryptogram, and refuse a replayed one.

    A tag like the NTAG 424 DNA appends two things to its URL on every read: a
    counter that only goes up, and a CMAC computed over it with a key that
    never leaves the tag. A copied URL carries a counter we have already seen —
    which is precisely the definition of a shared link, and the only mechanism
    in this system that can tell the difference.

    Honest about its own status: the counter check below is exercised by tests
    and is the half that catches sharing. The CMAC comparison is written to the
    scheme but has **never been run against a physical tag**, because there
    isn't one yet. It is therefore advisory unless `sun_required` is on, and
    the first tag that arrives is the thing that promotes it.
    """
    if not plate.get("sun_key"):
        raise HTTPException(
            status_code=400,
            detail="This plate is set to require a rotating tag but has no key.")
    if not counter:
        _hit(plate["token"], False, "sun_missing")
        raise HTTPException(status_code=403, detail="This code isn't in use.")

    try:
        seen = int(str(counter), 16)
    except ValueError:
        _hit(plate["token"], False, "sun_counter_malformed")
        raise HTTPException(status_code=403, detail="This code isn't in use.")

    last = plate.get("last_counter")
    if last is not None and seen <= last:
        # The whole point. Somebody is replaying a URL that was captured once.
        _hit(plate["token"], False, "sun_replay")
        raise HTTPException(
            status_code=403,
            detail="That link has already been used. Tap the plate again.")

    if cmac and plate.get("sun_key"):
        key = secrets_box.open_sealed(bytes(plate["sun_key"]),
                                      aad=str(plate["token"]))
        expected = hmac.new(bytes.fromhex(key), str(counter).encode(),
                            hashlib.sha256).hexdigest()[:16].upper()
        if not hmac.compare_digest(expected, str(cmac).upper()):
            _hit(plate["token"], False, "sun_cmac")
            raise HTTPException(status_code=403, detail="This code isn't in use.")

    db.execute("UPDATE plates SET last_counter = %s WHERE token = %s",
               (seen, plate["token"]))


# --- the operator's side ------------------------------------------------------
def revoke(tenant: dict, token: str) -> dict:
    """Kill one plate. The other door on the same plate keeps working, which is
    usually what you want when a photograph of the QR ends up somewhere."""
    row = db.query_one(
        "UPDATE plates SET revoked_at = now() "
        " WHERE token = %s AND tenant_id = %s AND revoked_at IS NULL "
        "RETURNING token",
        ((token or "").upper(), tenant["id"]),
    )
    if row is None:
        raise HTTPException(status_code=404, detail="No live plate with that token")
    return {"ok": True, "token": row["token"], "revoked": True}


def listing(tenant_id: str) -> list[dict]:
    """Every plate for a store, with how hard each is being used.

    `hits_last_hour` against `busy` is the shared-token signal: a fitting room
    is busy on a Saturday, and a fitting room is not busy at three in the
    morning from four hundred distinct taps.
    """
    return db.query(
        """
        SELECT p.token, p.zone, p.source, p.label, p.created_at, p.revoked_at,
               p.sun_required, p.last_counter,
               (SELECT count(*) FROM plate_hits h
                 WHERE h.token = p.token AND h.ok
                   AND h.created_at > now() - interval '1 hour') AS hits_last_hour,
               (SELECT count(*) FROM plate_hits h
                 WHERE h.token = p.token AND NOT h.ok
                   AND h.created_at > now() - interval '24 hours') AS refused_today
          FROM plates p
         WHERE p.tenant_id = %s
      ORDER BY p.revoked_at NULLS FIRST, p.zone, p.source
        """,
        (tenant_id,),
    )


def busy_plates(tenant_id: str) -> list[dict]:
    """The ones worth looking at. Not an alarm — a question."""
    return [p for p in listing(tenant_id)
            if (p["hits_last_hour"] or 0) > BUSY_HOUR]
