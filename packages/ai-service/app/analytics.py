"""Recording what happened, and reporting on it.

Two halves: `record_*` is called by the realtime server as things happen on
the floor, and the read side backs the manager dashboard.

A note on the leaderboard, because it is the part most likely to do harm.
Ranking retail associates purely on sales reliably produces cherry-picking —
staff compete for the promising customer and stop covering for each other,
and the person who spent twenty minutes helping someone else's guest finds a
sale ends up on someone else's row. So assists are recorded as first-class
events, `score` counts them, and every component is returned separately so
the dashboard can show *why* someone ranks where they do rather than a number
nobody trusts. Weights are configurable per tenant for the same reason.
"""
from __future__ import annotations

import json
import os
from datetime import date

from . import db

#: Default leaderboard weights. Assists are worth real points on purpose.
DEFAULT_WEIGHTS = {
    "sale_dollars": 1.0,     # per dollar of attributed sale
    "engagement": 10.0,      # per guest actually helped
    "assist": 25.0,          # per time you helped someone else's guest
}


def _weights(tenant: dict | None) -> dict:
    cfg = ((tenant or {}).get("config") or {}).get("leaderboard_weights") or {}
    return {**DEFAULT_WEIGHTS, **{k: float(v) for k, v in cfg.items() if k in DEFAULT_WEIGHTS}}


# --- write side --------------------------------------------------------------

def _bump_usage(tenant_id: str, *, engagements: int = 0, voice: int = 0, stt_seconds: float = 0.0):
    db.execute(
        """
        INSERT INTO usage_daily (tenant_id, day, engagements, voice_queries, stt_seconds)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (tenant_id, day) DO UPDATE SET
            engagements   = usage_daily.engagements   + EXCLUDED.engagements,
            voice_queries = usage_daily.voice_queries + EXCLUDED.voice_queries,
            stt_seconds   = usage_daily.stt_seconds   + EXCLUDED.stt_seconds
        """,
        (tenant_id, date.today(), engagements, voice, stt_seconds),
    )


def start_engagement(
    tenant_id: str, *, guest_ref: str | None, zone: str | None,
    associate_user_id: str | None = None,
    recommendations: list | None = None, cue_lines: list | None = None,
) -> dict:
    """Open an engagement, and record what the glasses showed to open it.

    The recommendations are stored as they were sent rather than re-derived
    later, because stock moves: "what did we suggest at 2pm" and "what would
    we suggest now" are different questions and only the first one is
    reviewable. Same for the cue — the three lines the associate actually read
    are the product, and a cue nobody kept is a cue nobody can critique.
    """
    row = db.query_one(
        """
        INSERT INTO engagements
            (tenant_id, associate_user_id, guest_ref, zone, recommendations, cue_lines)
        VALUES (%s, %s, %s, %s, %s::jsonb, %s)
        RETURNING id, started_at
        """,
        # `%s::jsonb` with json.dumps is the convention this codebase already
        # uses for tenants.config and tenants.privacy — same shape, same place.
        (tenant_id, associate_user_id, guest_ref, zone,
         json.dumps(recommendations or []), list(cue_lines or []) or None),
    )
    _bump_usage(tenant_id, engagements=1)
    return row


def end_engagement(engagement_id: str, *, outcome: str | None = None,
                   sale_cents: int = 0) -> dict | None:
    return db.query_one(
        """
        UPDATE engagements
           SET ended_at = now(),
               outcome = COALESCE(%s, outcome),
               sale_cents = GREATEST(sale_cents, %s)
         WHERE id = %s AND ended_at IS NULL
        RETURNING id, tenant_id, started_at, ended_at
        """,
        (outcome, sale_cents, engagement_id),
    )


def record_voice_query(
    tenant: dict, *, engagement_id: str | None = None, user_id: str | None = None,
    intent: str | None = None, ok: bool = True, resolved_by: str | None = None,
    latency_ms: int | None = None, audio_seconds: float | None = None,
    stt_provider: str | None = None, transcript: str | None = None,
    answer: str | None = None,
) -> dict:
    """Store one voice query.

    The transcript and the answer are dropped unless the tenant has explicitly
    opted in. What the associate said standing next to a customer is not
    something CueSea should accumulate by default, and the operational analytics
    don't need it — intent, outcome and latency do that work.

    Both halves ride the same flag on purpose. The answer quotes the guest's
    record back at them — their size, their cart, what they bought last time —
    so it is no less sensitive than the question. Keeping one without the other
    would also make the log unreadable: a question with no answer cannot be
    judged, and an answer with no question is a sentence about nothing.
    """
    keep_words = bool((tenant.get("privacy") or {}).get("store_transcripts"))
    row = db.query_one(
        """
        INSERT INTO voice_queries
            (tenant_id, engagement_id, user_id, intent, ok, resolved_by,
             latency_ms, audio_seconds, stt_provider, transcript, answer)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id, created_at
        """,
        (
            tenant["id"], engagement_id, user_id, intent, ok, resolved_by,
            latency_ms, audio_seconds, stt_provider,
            transcript if keep_words else None,
            answer if keep_words else None,
        ),
    )
    _bump_usage(tenant["id"], voice=1, stt_seconds=float(audio_seconds or 0))
    return row


def record_assist(tenant_id: str, *, helper_user_id: str,
                  engagement_id: str | None = None, note: str | None = None) -> dict:
    return db.query_one(
        """
        INSERT INTO assists (tenant_id, engagement_id, helper_user_id, note)
        VALUES (%s, %s, %s, %s)
        RETURNING id, created_at
        """,
        (tenant_id, engagement_id, helper_user_id, note),
    )


# --- read side ---------------------------------------------------------------

def summary(tenant_id: str, days: int = 1) -> dict:
    totals = db.query_one(
        """
        SELECT
            count(*)                                             AS engagements,
            count(*) FILTER (WHERE outcome = 'sale')             AS sales,
            COALESCE(sum(sale_cents), 0)                         AS sale_cents,
            count(DISTINCT associate_user_id)                    AS associates,
            COALESCE(avg(EXTRACT(EPOCH FROM (ended_at - started_at)))
                     FILTER (WHERE ended_at IS NOT NULL), 0)     AS avg_seconds
          FROM engagements
         WHERE tenant_id = %s AND started_at > now() - make_interval(days => %s)
        """,
        (tenant_id, days),
    ) or {}

    voice = db.query_one(
        """
        SELECT count(*)                                   AS total,
               count(*) FILTER (WHERE ok)                 AS ok,
               COALESCE(avg(latency_ms), 0)               AS avg_latency_ms,
               COALESCE(sum(audio_seconds), 0)            AS stt_seconds
          FROM voice_queries
         WHERE tenant_id = %s AND created_at > now() - make_interval(days => %s)
        """,
        (tenant_id, days),
    ) or {}

    assists = db.query_one(
        """
        SELECT count(*) AS total FROM assists
         WHERE tenant_id = %s AND created_at > now() - make_interval(days => %s)
        """,
        (tenant_id, days),
    ) or {}

    return {
        "window_days": days,
        "engagements": int(totals.get("engagements") or 0),
        "sales": int(totals.get("sales") or 0),
        "sale_cents": int(totals.get("sale_cents") or 0),
        "associates_active": int(totals.get("associates") or 0),
        "avg_engagement_seconds": round(float(totals.get("avg_seconds") or 0), 1),
        "assists": int(assists.get("total") or 0),
        "voice": {
            "total": int(voice.get("total") or 0),
            "ok": int(voice.get("ok") or 0),
            "avg_latency_ms": round(float(voice.get("avg_latency_ms") or 0)),
            "stt_seconds": round(float(voice.get("stt_seconds") or 0), 1),
        },
    }


def leaderboard(tenant: dict, days: int = 7, limit: int = 25) -> list[dict]:
    weights = _weights(tenant)
    rows = db.query(
        """
        WITH eng AS (
            SELECT associate_user_id AS user_id,
                   count(*)                     AS engagements,
                   COALESCE(sum(sale_cents), 0) AS sale_cents
              FROM engagements
             WHERE tenant_id = %(tenant)s
               AND started_at > now() - make_interval(days => %(days)s)
               AND associate_user_id IS NOT NULL
             GROUP BY 1
        ), ast AS (
            SELECT helper_user_id AS user_id, count(*) AS assists
              FROM assists
             WHERE tenant_id = %(tenant)s
               AND created_at > now() - make_interval(days => %(days)s)
             GROUP BY 1
        ), vq AS (
            SELECT user_id, count(*) AS voice_queries
              FROM voice_queries
             WHERE tenant_id = %(tenant)s
               AND created_at > now() - make_interval(days => %(days)s)
               AND user_id IS NOT NULL
             GROUP BY 1
        )
        SELECT u.id, u.name, u.email,
               COALESCE(eng.engagements, 0)   AS engagements,
               COALESCE(eng.sale_cents, 0)    AS sale_cents,
               COALESCE(ast.assists, 0)       AS assists,
               COALESCE(vq.voice_queries, 0)  AS voice_queries
          FROM users u
     LEFT JOIN eng ON eng.user_id = u.id
     LEFT JOIN ast ON ast.user_id = u.id
     LEFT JOIN vq  ON vq.user_id  = u.id
         WHERE u.tenant_id = %(tenant)s
           AND u.role = 'associate'
           AND u.status = 'active'
        """,
        {"tenant": tenant["id"], "days": days},
    )

    out = []
    for r in rows:
        sale_dollars = (r["sale_cents"] or 0) / 100.0
        score = (
            sale_dollars * weights["sale_dollars"]
            + r["engagements"] * weights["engagement"]
            + r["assists"] * weights["assist"]
        )
        out.append({
            "user_id": str(r["id"]),
            "name": r["name"],
            "engagements": r["engagements"],
            "sale_cents": r["sale_cents"],
            "assists": r["assists"],
            "voice_queries": r["voice_queries"],
            "score": round(score, 1),
        })
    out.sort(key=lambda x: x["score"], reverse=True)
    for i, row in enumerate(out[:limit], start=1):
        row["rank"] = i
    return out[:limit]


def recent_engagements(tenant_id: str, limit: int = 20) -> list[dict]:
    return db.query(
        """
        SELECT e.id, e.guest_ref, e.zone, e.started_at, e.ended_at,
               e.outcome, e.sale_cents, e.recommendations, e.cue_lines,
               u.name AS associate
          FROM engagements e
     LEFT JOIN users u ON u.id = e.associate_user_id
         WHERE e.tenant_id = %s
         ORDER BY e.started_at DESC
         LIMIT %s
        """,
        (tenant_id, limit),
    )


def recent_voice(tenant_id: str, limit: int = 20) -> list[dict]:
    return db.query(
        """
        SELECT v.id, v.intent, v.ok, v.resolved_by, v.latency_ms,
               v.audio_seconds, v.stt_provider, v.transcript, v.answer,
               v.created_at, u.name AS associate
          FROM voice_queries v
     LEFT JOIN users u ON u.id = v.user_id
         WHERE v.tenant_id = %s
         ORDER BY v.created_at DESC
         LIMIT %s
        """,
        (tenant_id, limit),
    )


def usage(tenant_id: str, days: int = 30) -> list[dict]:
    return db.query(
        """
        SELECT day, engagements, voice_queries, stt_seconds
          FROM usage_daily
         WHERE tenant_id = %s AND day > current_date - %s
         ORDER BY day
        """,
        (tenant_id, days),
    )


def usage_all_tenants(days: int = 30) -> list[dict]:
    """CueSea-side billing view: one row per tenant for the window."""
    return db.query(
        """
        -- `privacy` and `crm_provider` ride along because the Console's
        -- tenant detail is fed from this list. They were absent, so every
        -- privacy control rendered "off" whatever the database held — a
        -- toggle that cannot show its own state is a toggle that "doesn't
        -- work", which is exactly how it was reported from the floor.
        SELECT t.id, t.slug, t.name, t.billing_plan, t.status,
               t.privacy, t.crm_provider,
               COALESCE(sum(u.engagements), 0)   AS engagements,
               COALESCE(sum(u.voice_queries), 0) AS voice_queries,
               COALESCE(sum(u.stt_seconds), 0)   AS stt_seconds,
               (SELECT count(*) FROM users WHERE tenant_id = t.id
                                             AND status = 'active') AS users
          FROM tenants t
     LEFT JOIN usage_daily u
            ON u.tenant_id = t.id AND u.day > current_date - %s
         GROUP BY t.id
         ORDER BY t.name
        """,
        (days,),
    )
