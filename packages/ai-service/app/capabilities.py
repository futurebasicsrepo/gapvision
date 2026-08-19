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

#: The per-tenant switch for shift boundaries, glasses battery and the offline
#: replay buffer — everything in `app/shifts.py`. Same blob, same posture, same
#: reason as the camera: it is data about the associate, not about the guest,
#: and per-person rate metrics are performance monitoring. Off until a retailer
#: says otherwise.
SHIFT_TELEMETRY = "shift_telemetry"


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


def shift_telemetry(slug: str | None) -> bool:
    """May this tenant's plugin report when somebody started and stopped working?

    Checked server-side on every shift and device-health write, for exactly the
    reason `camera_capture` is: the client's copy decides what to *send*, and a
    static bundle on a phone is not a place to enforce a decision a works
    council may one day ask about.

    Fails closed like everything else here. An associate whose store never
    switched this on is simply not measured, which is the state every store is
    in until somebody deliberately changes it.
    """
    privacy = _privacy(slug or "")
    if privacy is None:
        return False
    return bool(privacy.get(SHIFT_TELEMETRY))


def checkout_links(slug: str | None) -> bool:
    """May this tenant's floor mint checkout links at all?

    Read from `config`, like floor comms and the widget deck: on unless a
    store we actually reached said no. The privacy-blob switches protect
    people from being recorded; this one is an operational preference, and
    the store's Shopify token (which must carry write_draft_orders) is the
    gate that actually binds.

    Checked server-side on every mint, same as the camera: the client's copy
    decides what to draw, never what the service will do.
    """
    return _config(slug or "").get("checkout_links") is not False


def voice(slug: str | None) -> bool:
    """May this tenant's floor ask a question out loud?

    Read from `config`, like floor comms and checkout links: on unless a store
    we actually reached said no.

    Checked server-side on every query, which it was not until Pocket became
    the second surface that can ask. `for_tenant` has always reported this
    flag and both clients honoured it, but honouring it was all that stopped a
    store with voice switched off from being transcribed — the gate lived
    entirely in whether a client chose to draw a microphone. One client
    getting that wrong, or one build shipping before the flag was read, and
    the retailer's decision simply did not hold.

    The camera has been enforced here since it shipped. This is the same rule,
    late: the client's copy decides what to draw, never what the service does.
    """
    return _config(slug or "").get("voice") is not False


def exists(slug: str | None) -> bool:
    """Is there a tenant with this slug at all?

    Expressed through `_privacy` rather than its own query, because this module
    promises to be *the one place* a tenant row is read and a second SELECT
    would quietly make that untrue.

    Separate from the switches on purpose. `for_tenant` fails closed, so an
    unknown slug and a real store with everything switched off produce an
    identical answer — which is right as a *decision* and useless as a
    *report*. A plugin launched with a typo in its URL shows a page with no
    camera on it and no way to tell why, and the next move is to go and check a
    Console toggle that was already correct.

    That happened. The lens demo defaults to `?tenant=gap`, the store's real
    slug is `cuesea`, and the flag had been on the whole time.

    A database blip reads as absent here, which is imprecise and deliberate:
    the caller reports "cannot confirm this tenant" either way, and the only
    thing that differs is a sentence. What must never differ is the switches,
    and those are closed in both cases.
    """
    return _privacy(slug or "") is not None


def for_tenant(slug: str | None) -> dict[str, bool]:
    """The whole switchboard, as booleans.

    `voice`, `floor_comms` and `widgets` ship enabled for every tenant — they
    predate the control plane, or in the widgets' case ship on because the deck
    is what the product already showed — so they read as True unless a tenant's
    `config` says otherwise. `camera_capture` and
    `shift_telemetry` are the opposite posture and read from `privacy`, where
    the defaults-off decisions live.

    Adding a key here is a deliberate act: `tests/test_vision.py` asserts the
    exact set, so a switch cannot arrive on a client by accident and neither
    can a privacy internal.
    """
    cfg = _config(slug or "")
    return {
        CAMERA_CAPTURE: camera_capture(slug),
        SHIFT_TELEMETRY: shift_telemetry(slug),
        "voice": voice(slug),
        "floor_comms": cfg.get("floor_comms") is not False,
        # The right-hand deck. Kyle's call, 17 Aug 2026: whether a store has
        # widgets at all is an admin decision made in Studio, while their order
        # is the associate's. Same posture and same default as floor comms —
        # only an explicit False from a store we reached turns it off.
        "widgets": cfg.get("widgets") is not False,
        # Floor checkout links — a draft order the guest pays on their own
        # phone. Config posture, not privacy: it touches no personal data the
        # engagement hasn't already surfaced, and the binding gate is the
        # store's own token, which simply lacks write_draft_orders until a
        # merchant deliberately grants it. The switch exists so a store can
        # turn the affordance off without touching scopes.
        "checkout_links": checkout_links(slug),
    }
