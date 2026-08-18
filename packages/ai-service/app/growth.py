"""The pipeline — leads, touches, and which door produced them.

`decks.py` records one event: a gated deck open. This module holds the rest of
the sales motion: the site form's arrivals, the outbound targets Kyle adds by
hand, every touch against each of them, and the stage they sit in. Same
boundary as `decks.py`, stated once more because it is the boundary that would
be easy to ship wrong: these rows are **ours**, there is no tenant to scope by,
and every read route requires `cue_admin`.

Design in `claude/gtm-plan-aug-2026.md` §6. Deliberately a log with stages,
not an automation engine — at founder-led volume, automation is where
deliverability and authenticity go to die.
"""
from __future__ import annotations

import json
from typing import Any

from . import db

STAGES = ("new", "contacted", "replied", "demo", "pilot_scoped",
          "pilot_live", "won", "lost", "nurture")

SOURCES = ("site", "outbound", "ads", "referral", "event", "deck", "other")

ACTIVITY_KINDS = ("email", "linkedin", "video", "call", "meeting", "note", "stage")

#: Same window and same posture as `decks.LEAD_RETENTION_DAYS`: long enough
#: that a pilot which took three quarters to close keeps its origin, short
#: enough that we are not holding a stranger's details forever because they
#: once filled a form. Redacted, not deleted — the shape of the pipeline is
#: worth keeping, the person in it is not.
LEAD_RETENTION_DAYS = 730

MAX_FIELD = 200
MAX_NOTES = 4000

#: The UTM keys the site form is allowed to hand us. A whitelist rather than
#: "whatever was in the query string" because this arrives from the open
#: internet and a jsonb column is a tempting place to park a kilobyte.
UTM_KEYS = ("utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content")


def _clip(value: Any, limit: int = MAX_FIELD) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value[:limit] if value else None


def _clip_int(value: Any) -> int | None:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if 0 <= n <= 100_000 else None


def record_site_lead(payload: dict) -> dict | None:
    """A form fill from cuesea.ai. Returns the row, or None if it wasn't one.

    An email is the only field that makes a lead a lead — the same rule
    `decks.record_lead` keeps. The same email arriving again is the same
    merchant still interested: the row is refreshed, not duplicated, and its
    stage is left alone so a form re-fill cannot un-work the pipeline.
    """
    email = _clip(payload.get("email"))
    if not email or "@" not in email:
        return None

    utm = {k: _clip(payload.get(k)) for k in UTM_KEYS if _clip(payload.get(k))}

    return db.query_one(
        """
        INSERT INTO leads (email, name, company, title, store_count, pos,
                           source, utm)
        VALUES (%s, %s, %s, %s, %s, %s, 'site', %s)
        ON CONFLICT (lower(email)) WHERE redacted_at IS NULL
        DO UPDATE SET
            name        = COALESCE(EXCLUDED.name, leads.name),
            company     = COALESCE(EXCLUDED.company, leads.company),
            title       = COALESCE(EXCLUDED.title, leads.title),
            store_count = COALESCE(EXCLUDED.store_count, leads.store_count),
            pos         = COALESCE(EXCLUDED.pos, leads.pos),
            utm         = COALESCE(EXCLUDED.utm, leads.utm),
            updated_at  = now()
        RETURNING *
        """,
        (email, _clip(payload.get("name")), _clip(payload.get("company")),
         _clip(payload.get("title")), _clip_int(payload.get("storeCount")),
         _clip(payload.get("pos")), json.dumps(utm) if utm else None),
    )


def create_lead(payload: dict, created_by: str | None = None) -> dict | None:
    """A lead added by hand from Console — an outbound target, a referral."""
    email = _clip(payload.get("email"))
    if not email or "@" not in email:
        return None
    source = payload.get("source")
    source = source if source in SOURCES else "outbound"
    stage = payload.get("stage")
    stage = stage if stage in STAGES else "new"

    return db.query_one(
        """
        INSERT INTO leads (email, name, company, title, store_count, pos,
                           source, stage, owner, notes)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (lower(email)) WHERE redacted_at IS NULL
        DO UPDATE SET updated_at = now()
        RETURNING *
        """,
        (email, _clip(payload.get("name")), _clip(payload.get("company")),
         _clip(payload.get("title")), _clip_int(payload.get("storeCount")),
         _clip(payload.get("pos")), source, stage, created_by,
         _clip(payload.get("notes"), MAX_NOTES)),
    )


def leads(stage: str | None = None, days: int = 365) -> list[dict]:
    """The pipeline, most recently touched first.

    Redacted rows are included for the same reason `decks.leads` includes
    them: an aged-out lead is still evidence of that month's pipeline, and
    filtering it would quietly shrink history every time the sweep runs.
    """
    where = "WHERE l.updated_at > now() - make_interval(days => %s)"
    params: list = [max(1, min(int(days or 365), 3650))]
    if stage in STAGES:
        where += " AND l.stage = %s"
        params.append(stage)
    return db.query(
        f"""
        SELECT l.*, u.name AS owner_name,
               (SELECT count(*) FROM lead_activities a
                 WHERE a.lead_id = l.id)                       AS touches,
               (SELECT max(a.at) FROM lead_activities a
                 WHERE a.lead_id = l.id)                       AS last_touch,
               (SELECT max(a.at) FROM lead_activities a
                 WHERE a.lead_id = l.id AND a.direction = 'in') AS last_reply
          FROM leads l LEFT JOIN users u ON u.id = l.owner
         {where}
         ORDER BY l.updated_at DESC
         LIMIT 500
        """,
        tuple(params),
    )


def update_lead(lead_id: str, payload: dict,
                updated_by: str | None = None) -> dict | None:
    """Stage, owner, notes — the fields the panel edits.

    A stage change writes its own activity row, so "when did this move to
    demo" is answerable from the log rather than reconstructed from memory.
    """
    row = db.query_one("SELECT * FROM leads WHERE id = %s", (lead_id,))
    if not row:
        return None

    stage = payload.get("stage")
    stage = stage if stage in STAGES else None
    sets, params = ["updated_at = now()"], []
    if stage and stage != row["stage"]:
        sets.append("stage = %s")
        params.append(stage)
    if "notes" in payload:
        sets.append("notes = %s")
        params.append(_clip(payload.get("notes"), MAX_NOTES))
    if "owner" in payload:
        sets.append("owner = %s")
        params.append(payload.get("owner") or None)

    params.append(lead_id)
    updated = db.query_one(
        f"UPDATE leads SET {', '.join(sets)} WHERE id = %s RETURNING *",
        tuple(params),
    )
    if stage and stage != row["stage"]:
        add_activity(lead_id, {"kind": "stage",
                               "body": f"{row['stage']} → {stage}"},
                     created_by=updated_by)
    return updated


def activities(lead_id: str) -> list[dict]:
    return db.query(
        """
        SELECT a.id, a.kind, a.direction, a.body, a.at, u.name AS created_by
          FROM lead_activities a LEFT JOIN users u ON u.id = a.created_by
         WHERE a.lead_id = %s
         ORDER BY a.at DESC
         LIMIT 200
        """,
        (lead_id,),
    )


def add_activity(lead_id: str, payload: dict,
                 created_by: str | None = None) -> dict | None:
    kind = payload.get("kind")
    if kind not in ACTIVITY_KINDS:
        return None
    direction = payload.get("direction")
    direction = direction if direction in ("out", "in") else None

    row = db.query_one(
        """
        INSERT INTO lead_activities (lead_id, kind, direction, body, created_by)
        VALUES (%s, %s, %s, %s, %s)
        RETURNING *
        """,
        (lead_id, kind, direction, _clip(payload.get("body"), MAX_NOTES),
         created_by),
    )
    if row:
        # A touch is the pipeline moving. `updated_at` is what the panel sorts
        # by and what "gone quiet" is measured against, so it must follow.
        db.execute("UPDATE leads SET updated_at = now() WHERE id = %s",
                   (lead_id,))
        # A reply is the one event that must not sit unnoticed. The panel
        # flames any lead whose last_reply is newer than its last outbound
        # touch — that read comes free from the log, no column needed.
    return row


def sources(days: int = 90) -> dict:
    """The marketing mirror of `/api/analytics/doors`: which door produced
    the pipeline, and what each stage looks like right now.

    Counts, not spend — ad spend lives with the ad accounts, and a panel that
    invents a CPL from a number nobody entered is the panel that gets quoted.
    """
    window = max(1, min(int(days or 90), 3650))
    by_source = db.query(
        """
        SELECT source, count(*) AS leads,
               count(*) FILTER (WHERE stage NOT IN ('lost'))       AS live,
               count(*) FILTER (WHERE stage IN ('demo', 'pilot_scoped',
                                                'pilot_live', 'won')) AS advanced
          FROM leads
         WHERE created_at > now() - make_interval(days => %s)
         GROUP BY source ORDER BY leads DESC
        """,
        (window,),
    )
    by_stage = db.query(
        "SELECT stage, count(*) AS n FROM leads GROUP BY stage",
    )
    by_campaign = db.query(
        """
        SELECT utm ->> 'utm_source'   AS utm_source,
               utm ->> 'utm_campaign' AS utm_campaign,
               count(*) AS leads
          FROM leads
         WHERE utm IS NOT NULL
           AND created_at > now() - make_interval(days => %s)
         GROUP BY 1, 2 ORDER BY leads DESC LIMIT 50
        """,
        (window,),
    )
    return {"days": window, "by_source": by_source,
            "by_stage": {r["stage"]: r["n"] for r in by_stage},
            "by_campaign": by_campaign}


def sweep_leads(days: int = LEAD_RETENTION_DAYS) -> int:
    """Clear the person out of aged leads, keep the fact of the pipeline.

    Activities go with the lead's personal half: a touch log's bodies are
    drafts of and replies to a named person, which makes them the most
    personal thing here. The row count of touches survives on the lead via
    the panel's window queries; the words do not need to.
    """
    db.execute(
        """
        UPDATE lead_activities SET body = NULL
         WHERE body IS NOT NULL
           AND lead_id IN (SELECT id FROM leads
                            WHERE redacted_at IS NULL
                              AND created_at < now() - make_interval(days => %s))
        """,
        (days,),
    )
    return db.execute(
        """
        UPDATE leads
           SET email = 'redacted', name = NULL, title = NULL, notes = NULL,
               redacted_at = now()
         WHERE redacted_at IS NULL
           AND created_at < now() - make_interval(days => %s)
        """,
        (days,),
    )
