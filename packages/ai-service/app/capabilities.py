"""What a plugin may offer this associate.

    from app import capabilities
    capabilities.for_tenant("gap")   # {"camera_capture": False, "voice": True, ...}

Booleans, and nothing else. A plugin asking "what may I offer the person
wearing these glasses" is asking an operational question, and the answer is a
set of switches it can branch on — not a description of the retailer's legal
posture. `retention_days`, `store_transcripts` and `opt_in_tiers` are all in
the same `tenants.privacy` blob and none of them belong on a client: a static
bundle that knows a tenant keeps transcripts for 365 days is a static bundle
that has published it.

**Fail closed.** Every lookup that cannot reach a tenant row — no database, a
database blip, an unknown slug — returns the safe answer rather than the
convenient one. For `camera_capture` the safe answer is False: an associate
who cannot photograph a tag is inconvenienced, and an associate photographing
things for a retailer who never enabled it is an incident.

This module is the one place the flag is read. The route that reports
capabilities and the route that acts on them both come through here, so
"where is camera capture decided" has a single answer that fits on a screen.
"""
from __future__ import annotations

from . import db

#: The per-tenant switch for phone camera capture, in `tenants.privacy`.
#: Named once so the 403 detail, the tests and the Console all agree.
CAMERA_CAPTURE = "camera_capture"


def _privacy(slug: str) -> dict | None:
    """This tenant's privacy blob, or None if we could not read one.

    None is not an empty dict. "No row / no database / database down" and
    "a row that says nothing about this flag" are different states, and only
    the second one is a decision somebody made.
    """
    if not db.configured():
        return None
    try:
        row = db.query_one("SELECT privacy FROM tenants WHERE slug = %s",
                           ((slug or "").lower(),))
    except Exception:
        # A database blip must not silently turn a capability on. It must also
        # not take the lens offline — the caller gets the closed answer.
        return None
    if row is None:
        return None
    return row.get("privacy") or {}


def _config(slug: str) -> dict:
    if not db.configured():
        return {}
    try:
        row = db.query_one("SELECT config FROM tenants WHERE slug = %s",
                           ((slug or "").lower(),))
    except Exception:
        return {}
    return (row or {}).get("config") or {}


def camera_capture(slug: str | None) -> bool:
    """May this tenant's plugin open the phone camera at all?

    Checked server-side on every capture. The client is told the same answer
    by `for_tenant`, but the client's copy is a hint for what to draw — it is
    never the thing that decides, because a plugin is a static bundle and a
    static bundle can be edited by whoever is holding the phone.
    """
    privacy = _privacy(slug or "")
    if privacy is None:
        return False
    return bool(privacy.get(CAMERA_CAPTURE))


def for_tenant(slug: str | None) -> dict[str, bool]:
    """The whole switchboard, as booleans.

    `voice` and `floor_comms` ship enabled for every tenant — they predate the
    control plane and no retailer has asked for them off — so they read as True
    unless a tenant's `config` says otherwise. `camera_capture` is the opposite
    posture and reads from `privacy`, where the defaults-off decisions live.
    """
    cfg = _config(slug or "")
    return {
        CAMERA_CAPTURE: camera_capture(slug),
        "voice": cfg.get("voice") is not False,
        "floor_comms": cfg.get("floor_comms") is not False,
    }
