"""Retention, enforced.

    from app import retention
    retention.sweep_all()          # every active tenant, on its own window

`tenants.privacy.retention_days` has been stored since the spine landed and
nothing ever deleted on it. This is the thing that deletes.

Redaction, not deletion — and the distinction is the whole design
-----------------------------------------------------------------
The obvious implementation is `DELETE FROM engagements WHERE started_at < ...`.
That is wrong twice over.

It destroys the analytics the product exists to produce. "How many guests did
this store help in March" is not personal data and there is no privacy argument
for losing it. A retailer who turned on a 30-day window and then found their
quarter had evaporated would be right to be angry, and would never turn it on
again — which is how a privacy control ends up disabled everywhere.

And it is not what the promise means. The promise is that Cue stops holding
information about *people* after N days. So the sweep nulls the columns that
say something about a person and leaves the skeleton that says something about
a shift:

    voice_queries.transcript, .answer   what was said near a customer
    engagements.guest_ref               the pointer to a CRM record
    engagements.cue_lines               contains the guest's name, verbatim
    engagements.recommendations         what this specific person was offered
    assists.note                        free text, so assume the worst

    kept: intent, ok, latency_ms, audio_seconds, stt_provider, zone,
          started_at, ended_at, outcome, sale_cents, and every usage rollup

After a sweep, a row records that an engagement happened, when, in which zone,
by whom, and what it earned. It records nothing about who it was with. That is
the line, and `test_retention.py` asserts both halves of it: the personal
columns go, the operational ones stay.

Bounded and idempotent
----------------------
Every sweep is capped (`BATCH`). A tenant with a year of unenforced history
would otherwise take one enormous lock the first time this ever ran, on a
service that is answering questions for people standing in front of customers.
It runs to the cap, records `more_remaining`, and picks the rest up next time.

Re-running changes nothing, because the sweep only matches rows that still have
something to redact. That means it is safe on a timer, safe on demand, and safe
to run twice by accident.
"""
from __future__ import annotations

import logging
import os
from typing import Any

from . import db

log = logging.getLogger("cue.retention")

#: Rows per class per sweep. Deliberately modest: this runs beside live traffic.
BATCH = int(os.getenv("CUE_RETENTION_BATCH", "5000"))

#: Fallback when a tenant's privacy blob has no window. Matches the schema
#: default in 001_spine.sql — a tenant that never chose still gets swept.
DEFAULT_DAYS = 90

#: Below this, a "retention window" is a foot-gun rather than a policy: a
#: tenant could set 0 and erase today's floor as it happened. The API clamps
#: too, but the sweep refuses independently — the destructive end of a system
#: should not rely on someone else's validation.
MIN_DAYS = 1


def window_days(tenant: dict) -> int:
    raw = (tenant.get("privacy") or {}).get("retention_days", DEFAULT_DAYS)
    try:
        days = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_DAYS
    return max(MIN_DAYS, days)


def sweep(tenant: dict) -> dict[str, Any]:
    """Redact one tenant's aged personal data. Returns what it did."""
    days = window_days(tenant)
    tid = tenant["id"]

    # `db.execute` returns rowcount, which is exactly the number wanted — no
    # RETURNING clause and no result set to drag back for rows nobody reads.
    n_voice = db.execute(
        """
        WITH aged AS (
            SELECT id FROM voice_queries
             WHERE tenant_id = %s
               AND created_at < now() - make_interval(days => %s)
               AND (transcript IS NOT NULL OR answer IS NOT NULL)
             LIMIT %s
        )
        UPDATE voice_queries v
           SET transcript = NULL, answer = NULL
          FROM aged WHERE v.id = aged.id
        """,
        (tid, days, BATCH),
    )

    n_eng = db.execute(
        """
        WITH aged AS (
            SELECT id FROM engagements
             WHERE tenant_id = %s
               AND started_at < now() - make_interval(days => %s)
               AND (guest_ref IS NOT NULL OR cue_lines IS NOT NULL
                    OR recommendations <> '[]'::jsonb)
             LIMIT %s
        )
        UPDATE engagements e
           SET guest_ref = NULL, cue_lines = NULL,
               recommendations = '[]'::jsonb
          FROM aged WHERE e.id = aged.id
        """,
        (tid, days, BATCH),
    )

    n_ast = db.execute(
        """
        WITH aged AS (
            SELECT id FROM assists
             WHERE tenant_id = %s
               AND created_at < now() - make_interval(days => %s)
               AND note IS NOT NULL
             LIMIT %s
        )
        UPDATE assists a
           SET note = NULL
          FROM aged WHERE a.id = aged.id
        """,
        (tid, days, BATCH),
    )

    more = max(n_voice, n_eng, n_ast) >= BATCH

    db.execute(
        """
        INSERT INTO retention_runs
            (tenant_id, retention_days, voice_redacted,
             engagements_redacted, assists_redacted, more_remaining)
        VALUES (%s, %s, %s, %s, %s, %s)
        """,
        (tid, days, n_voice, n_eng, n_ast, more),
    )

    result = {
        "tenant": tenant.get("slug"), "retention_days": days,
        "voice_redacted": n_voice, "engagements_redacted": n_eng,
        "assists_redacted": n_ast, "more_remaining": more,
    }
    if n_voice or n_eng or n_ast:
        log.info("retention swept %s", result)
    return result


def sweep_all() -> list[dict[str, Any]]:
    """Every tenant that is not archived.

    Suspended tenants are swept too, deliberately. A retailer who stopped
    paying has not thereby consented to Cue keeping their customers' data
    indefinitely — if anything that is the case where holding it is least
    defensible.
    """
    if not db.configured():
        return []
    tenants = db.query(
        "SELECT id, slug, privacy FROM tenants WHERE status <> 'archived'")
    return [sweep(t) for t in tenants]


def status() -> dict[str, Any]:
    """What retention has actually done — for /health and the platform checks.

    Reports the *oldest* last-run across tenants rather than the newest. A
    dashboard that shows the most recent sweep looks green while one tenant
    silently goes unswept for a month, which is precisely the failure this is
    meant to make impossible.
    """
    if not db.configured():
        return {"enforced": False, "reason": "no database"}

    row = db.query_one(
        """
        SELECT t.slug,
               max(r.ran_at) AS last_run,
               bool_or(r.more_remaining) FILTER (
                   WHERE r.ran_at = (SELECT max(ran_at) FROM retention_runs
                                      WHERE tenant_id = t.id)) AS backlog
          FROM tenants t
     LEFT JOIN retention_runs r ON r.tenant_id = t.id
         WHERE t.status <> 'archived'
      GROUP BY t.id, t.slug
      ORDER BY max(r.ran_at) ASC NULLS FIRST
         LIMIT 1
        """
    )
    if row is None:
        return {"enforced": True, "last_run": None, "note": "no tenants"}
    return {
        "enforced": True,
        "oldest_swept_tenant": row["slug"],
        "last_run": row["last_run"].isoformat() if row["last_run"] else None,
        "backlog": bool(row["backlog"]),
    }
