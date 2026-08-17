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

And it is not what the promise means. The promise is that CueSea stops holding
information about *people* after N days. So the sweep nulls the columns that
say something about a person and leaves the skeleton that says something about
a shift:

    voice_queries.transcript, .answer   what was said near a customer
    engagements.guest_ref               the pointer to a CRM record
    engagements.cue_lines               contains the guest's name, verbatim
    engagements.recommendations         what this specific person was offered
    assists.note                        free text, so assume the worst
    guest_requests.guest_ref, .note     the pointer, and words a guest typed

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

    # A guest's own words, typed on their own phone. Treated like a voice
    # transcript rather than like an analytics field — and the pointer goes
    # with it. What stays is the ask itself (sku, size, need, zone, timings),
    # because "which sizes do people want in fitting rooms and how long do they
    # wait" is a question about a shop and not about a shopper.
    n_req = db.execute(
        """
        WITH aged AS (
            SELECT id FROM guest_requests
             WHERE tenant_id = %s
               AND created_at < now() - make_interval(days => %s)
               -- `<> ''` and not `IS NOT NULL`: the column is NOT NULL, so the
               -- redacted value is the empty string, and matching on NULL
               -- would re-sweep every row forever and never report zero.
               AND (guest_ref <> '' OR note IS NOT NULL)
             LIMIT %s
        )
        UPDATE guest_requests r
           SET guest_ref = '', note = NULL
          FROM aged WHERE r.id = aged.id
        """,
        (tid, days, BATCH),
    )

    more = max(n_voice, n_eng, n_ast, n_req) >= BATCH

    db.execute(
        """
        INSERT INTO retention_runs
            (tenant_id, retention_days, voice_redacted,
             engagements_redacted, assists_redacted, requests_redacted,
             more_remaining)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (tid, days, n_voice, n_eng, n_ast, n_req, more),
    )

    result = {
        "tenant": tenant.get("slug"), "retention_days": days,
        "voice_redacted": n_voice, "engagements_redacted": n_eng,
        "assists_redacted": n_ast, "requests_redacted": n_req,
        "more_remaining": more,
    }
    if n_voice or n_eng or n_ast or n_req:
        log.info("retention swept %s", result)
    return result


def sweep_all() -> list[dict[str, Any]]:
    """Every tenant that is not archived.

    Suspended tenants are swept too, deliberately. A retailer who stopped
    paying has not thereby consented to CueSea keeping their customers' data
    indefinitely — if anything that is the case where holding it is least
    defensible.
    """
    if not db.configured():
        return []
    tenants = db.query(
        "SELECT id, slug, privacy FROM tenants WHERE status <> 'archived'")
    runs = [sweep(t) for t in tenants]

    # Shift and device history, on the same per-tenant window.
    #
    # A retention promise that covers the customer's half of this product and
    # quietly excludes the staff's is the promise somebody will find first. It
    # rides here rather than in `sweep()` because it reports nothing into
    # `retention_runs` — those columns are a contract the Console panel and its
    # tests both read — and because a failure to prune telemetry must not make
    # a tenant's guest-data sweep look like it did not happen.
    try:
        from . import shifts
        pruned = shifts.prune_expired()
        if any(pruned.values()):
            log.info("retention pruned shift telemetry %s", pruned)
    except Exception as e:
        log.warning("retention could not prune shift telemetry: %s", e)

    # Our own leads, on their own window.
    #
    # `deck_leads` carries no tenant, so the per-tenant loop above cannot reach
    # it — and a table of names and email addresses that no sweep touches is
    # exactly the table a reviewer finds. It is *our* prospects rather than a
    # retailer's customers, which changes whose window applies and changes
    # nothing about whether one applies at all.
    #
    # Same posture as the telemetry prune: outside `sweep()`, because it writes
    # nothing into `retention_runs` and because failing to redact a lead must
    # not make a tenant's guest-data sweep look like it did not run.
    try:
        from . import decks
        redacted = decks.sweep_leads()
        if redacted:
            log.info("retention redacted %s aged deck leads", redacted)
    except Exception as e:
        log.warning("retention could not redact deck leads: %s", e)

    return runs


def detail() -> list[dict[str, Any]]:
    """Every tenant's window and its most recent sweep — for the Console panel.

    `status()` deliberately reports only the worst tenant, because a health
    check that names the newest sweep looks green while one store silently
    goes unswept for a month. A panel has the opposite job: it has to show all
    of them, so the one that is behind can be seen next to the ones that are
    not. Same NULLS FIRST ordering, for the same reason — never-swept sorts to
    the top, where it cannot be missed.
    """
    if not db.configured():
        return []
    return db.query(
        """
        SELECT t.slug, t.name,
               COALESCE(NULLIF(t.privacy->>'retention_days', '')::int, %s)
                   AS retention_days,
               r.ran_at AS last_run,
               r.voice_redacted, r.engagements_redacted,
               r.assists_redacted, r.requests_redacted, r.more_remaining
          FROM tenants t
     LEFT JOIN LATERAL (
               SELECT * FROM retention_runs rr
                WHERE rr.tenant_id = t.id
             ORDER BY rr.ran_at DESC
                LIMIT 1
               ) r ON true
         WHERE t.status <> 'archived'
      ORDER BY r.ran_at ASC NULLS FIRST, t.slug ASC
        """,
        (DEFAULT_DAYS,),
    )


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
      -- Slug breaks the tie. Without it, several never-swept tenants sort
      -- arbitrarily and the Health panel names a different one on every
      -- refresh — which reads as flapping rather than as "none of these have
      -- been swept".
      ORDER BY max(r.ran_at) ASC NULLS FIRST, t.slug ASC
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
