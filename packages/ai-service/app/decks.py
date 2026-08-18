"""Deck links and deck leads — our own pipeline, not a retailer's.

Every other module here reads a tenant's data through `scope_tenant`. This one
reads **ours**: who we sent a deck to, and who typed a name and an email to
open one. There is no tenant to scope by, so the boundary has to be a role
check in the routes — `cue_admin` only, no exceptions — and it is worth naming
why rather than leaving it to a reader to infer.

A retailer's manager legitimately reaches most of `/api/analytics/*`. If these
lived there under the same rule, one of our customers could read our fundraise
pipeline: which investors opened the pre-seed deck, when, and from what firm.
That is not a tenant-isolation bug in the usual direction, which is exactly why
it would have been easy to ship.

The design note for the endpoints is `claude/sales-deck.md`. It proposed
manager-and-up; this is a deliberate departure from it.
"""
from __future__ import annotations

from typing import Any

from . import db, growth

DECKS = ("floor", "fundraise")

#: How long a lead keeps a name and an email attached to it.
#:
#: Not the tenant retention window — that belongs to a retailer and these rows
#: do not. Two years is long enough that a slow fundraise or a pilot that took
#: three quarters to close still has its origin attached, and short enough that
#: we are not holding somebody's contact details forever because they once read
#: a PDF. Redacted rather than deleted: the *shape* of the pipeline is worth
#: keeping, the person in it is not.
LEAD_RETENTION_DAYS = 730

#: Bound on what a public endpoint may write. The client is a page on the open
#: internet — this is the same posture `api/lead.js` keeps at the edge, restated
#: here because the edge is not the last line of defence.
MAX_FIELD = 200


def _clip(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value[:MAX_FIELD] if value else None


def record_lead(payload: dict) -> dict | None:
    """Write a gated open. Returns the row, or None if there was nothing to write.

    An email is the only field that makes a lead a lead; everything else is
    context. A payload without one is dropped rather than stored as an
    anonymous row, because a table of nameless opens is a table nobody can act
    on and everybody has to explain to a reviewer.
    """
    email = _clip(payload.get("email"))
    if not email:
        return None

    deck = payload.get("deck")
    deck = deck if deck in DECKS else None

    row = db.query_one(
        """
        INSERT INTO deck_leads (deck, name, email, firm, prepared_for, token, ref)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        RETURNING *
        """,
        (deck, _clip(payload.get("name")), email, _clip(payload.get("firm")),
         _clip(payload.get("preparedFor")) or _clip(payload.get("to")),
         _clip(payload.get("token")), _clip(payload.get("ref"))),
    )

    # …and again into the pipeline, where somebody will actually act on it.
    #
    # `deck_leads` stays the raw record of who opened what and when — it is the
    # evidence, and it survives the pipeline row being merged, restaged or
    # redacted. `growth.record_deck_open` is the *consequence*: the lead exists,
    # with the open in its touch log, next to the emails and calls.
    #
    # Guarded, and deliberately after the write above. The merchant is standing
    # in front of a deck that will not open until this returns, so a pipeline
    # that is mid-migration or briefly unhappy must cost them nothing — the
    # gated open still succeeds and the evidence is still recorded. Losing the
    # pipeline row is recoverable from `deck_leads`; making somebody stare at a
    # failed form is not.
    try:
        growth.record_deck_open(payload)
    except Exception as exc:   # pragma: no cover - diagnostics only
        print(f"[cue] deck open not mirrored to pipeline: {exc}", flush=True)

    return row


def leads(days: int = 90) -> list[dict]:
    """Gated opens in a window, newest first.

    Redacted rows are included rather than filtered out. A lead whose personal
    columns have aged out is still evidence that somebody read the deck that
    week, and dropping it would quietly shrink last year's history every time
    the sweep runs.
    """
    return db.query(
        """
        SELECT d.id, d.deck, d.name, d.email, d.firm, d.prepared_for, d.token,
               d.ref, d.created_at AS at, d.redacted_at,
               -- What became of them. Joined on the email rather than a stored
               -- id so an open recorded before the pipeline existed still finds
               -- its lead, and so a lead merged by hand does not orphan its
               -- opens. Null means the pipeline has no row for this address —
               -- which now only happens for opens predating the join.
               g.stage AS lead_stage, g.id AS lead_id
          FROM deck_leads d
          LEFT JOIN leads g
                 ON lower(g.email) = lower(d.email) AND g.redacted_at IS NULL
         WHERE d.created_at > now() - make_interval(days => %s)
         ORDER BY d.created_at DESC
         LIMIT 500
        """,
        (max(1, min(int(days or 90), 3650)),),
    )


def links(days: int = 365) -> list[dict]:
    return db.query(
        """
        SELECT l.id, l.deck, l.token, l.prepared_for, l.gated, l.created_at AS at,
               u.name AS created_by,
               (SELECT count(*) FROM deck_leads d WHERE d.token = l.token) AS opens,
               -- Distinct people, not opens: one merchant reading a deck four
               -- times is one lead, and a link that reads "4" when a single
               -- person looked at it four times is a link that gets chased as
               -- though four rooms are interested.
               (SELECT count(DISTINCT lower(d.email)) FROM deck_leads d
                 WHERE d.token = l.token)                          AS openers
          FROM deck_links l LEFT JOIN users u ON u.id = l.created_by
         WHERE l.created_at > now() - make_interval(days => %s)
         ORDER BY l.created_at DESC
         LIMIT 500
        """,
        (max(1, min(int(days or 365), 3650)),),
    )


def create_link(*, deck: str, token: str, prepared_for: str | None,
                gated: bool, created_by: str | None) -> dict:
    """Record a link somebody built. Idempotent on the token.

    The same link posted twice is one link — the panel re-sends on reconnect and
    a browser that retried should not produce a duplicate row that then reports
    two sends where there was one.
    """
    return db.query_one(
        """
        INSERT INTO deck_links (deck, token, prepared_for, gated, created_by)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (token) DO UPDATE
            SET prepared_for = EXCLUDED.prepared_for, gated = EXCLUDED.gated
        RETURNING *
        """,
        (deck, token, _clip(prepared_for), bool(gated), created_by),
    )


def sweep_leads(days: int = LEAD_RETENTION_DAYS) -> int:
    """Clear the person out of aged leads, keep the fact of the open.

    Same shape as every other redaction here: null the personal columns, stamp
    when it happened, leave the row. Returns how many were redacted.
    """
    return db.execute(
        """
        UPDATE deck_leads
           SET name = NULL, email = NULL, ref = NULL, redacted_at = now()
         WHERE redacted_at IS NULL
           AND created_at < now() - make_interval(days => %s)
        """,
        (days,),
    )
