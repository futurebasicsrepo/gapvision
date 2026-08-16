"""Shift boundaries, glasses health, and what to do with a phone's clock.

    from app import shifts
    shifts.start(tenant, device_serial="G2-0001", ...)   # clock in
    shifts.heartbeat(tenant, shift_id)                   # still here
    shifts.end(tenant, shift_id, reason="app_closed")    # clock out

Why this module exists
----------------------
Every metric on the dashboards is a raw count, and a raw count has no
denominator. It punishes the part-timer, rewards whoever left the app running
over lunch, and cannot tell a quiet afternoon from a router that stopped
answering. `register` fired when the app opened and nothing ever closed it, so
"cues per hour worked" had no bottom half at all.

Three things in here, and all of them are plumbing:

1. **Shifts.** An explicit start and an explicit end, so there is something to
   divide by.
2. **Device health.** `DeviceStatus` has been in the Even SDK the whole time
   and nothing read it. A pair that dies at 3pm every day is a hardware fault
   that currently reads, on the leaderboard, as an associate who stops working
   after lunch — and the person it happens to has no way to prove otherwise.
3. **Client timestamps.** Shop wifi drops. The plugin buffers what happened
   and replays it on reconnect, carrying the time it *occurred*.

Off by default, per tenant
--------------------------
`privacy.shift_telemetry`, same blob and same posture as `camera_capture`.
This is data about the *associate*, not about the guest: per-person rate
metrics are performance monitoring, regulated separately from customer privacy
in some jurisdictions and bargained separately in most union shops. The routes
that write here re-read the flag on every call — the plugin's copy decides what
to send, never what is recorded.

What the client's clock is allowed to decide
--------------------------------------------
**Ordering within a shift. Nothing else.** A buffered burst replayed at 14:32
needs to land in the order it happened, and only the phone knows that order.

It never decides a duration, a bill or a retention window, because a phone's
clock is settable, drifts, and jumps by an hour twice a year in most of the
world. So:

* `shifts.started_at`, `shifts.ended_at`, `shifts.last_heartbeat_at`,
  `device_health.created_at` — this machine's clock, always.
* `shifts.client_started_at`, `shifts.client_ended_at`,
  `device_health.client_at` — the phone's word, stored beside ours and used for
  ordering and for diagnosis.
* `telemetry_arrivals` — both, plus the gap between them, so "is this number
  late or is it wrong" is answerable rather than arguable.

How a shift ends when a phone dies
----------------------------------
It does not stay open until somebody notices. `last_heartbeat_at` is stamped
here on every heartbeat, and a shift whose heartbeat is older than
`GAP_MINUTES` is closed at **its last heartbeat**, not at the time the sweep
happened to run. A phone that goes flat at 3pm produces a shift that ended at
3pm; the alternative is an eleven-hour shift that quietly destroys every
average in the building.

The sweep runs on every read rather than on a timer. That is deliberate: a
timer is a second thing that can silently stop, and the only moment a stale
shift can do harm is the moment somebody looks at it.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

from . import db

#: How long a shift may go without a heartbeat before it is treated as over.
#: Long enough to ride out a wifi drop or a lift, short enough that a dead
#: phone does not contaminate an afternoon.
GAP_MINUTES = int(os.getenv("CUE_SHIFT_GAP_MINUTES", "15"))

#: How often the plugin is expected to say it is still there. Reported to the
#: client so one number governs both halves.
HEARTBEAT_SECONDS = int(os.getenv("CUE_SHIFT_HEARTBEAT_SECONDS", "60"))

#: At or below this, a pair of glasses is not going to finish the shift.
LOW_BATTERY_PERCENT = int(os.getenv("CUE_LOW_BATTERY_PERCENT", "20"))

#: An event that took longer than this to arrive is worth looking at. A
#: replayed one is *expected* to be late — that is what the buffer is for — so
#: the two are counted separately everywhere this number is used.
LATE_SECONDS = int(os.getenv("CUE_TELEMETRY_LATE_SECONDS", "120"))

#: Arrival records are diagnostics, not history. Swept with the stale shifts.
ARRIVAL_KEEP_DAYS = int(os.getenv("CUE_TELEMETRY_KEEP_DAYS", "30"))

#: Below this, a rate is not a rate. Ten minutes of shift and one engagement is
#: "six an hour", which is arithmetic rather than information — and on a
#: leaderboard it is the number that beats everybody. Under the floor the rate
#: is None, and the surface renders unknown rather than a winner.
MIN_HOURS_FOR_RATE = float(os.getenv("CUE_MIN_SHIFT_HOURS_FOR_RATE", "0.25"))

#: What the client may claim as a reason. `heartbeat_gap` and `superseded` are
#: ours to write and a client asserting either would be asserting something it
#: cannot know.
CLIENT_REASONS = ("signed_out", "app_closed")


class TelemetryOff(RuntimeError):
    """The tenant has not turned shift telemetry on.

    Its own type so the route can answer 403 with a sentence naming the flag,
    the same shape the camera gate uses, rather than every caller re-deriving
    what a False means.
    """


# --- the client's clock ------------------------------------------------------

def parse_client_time(raw: str | None) -> datetime | None:
    """The phone's word, or None if it did not give one we can read.

    Unparseable is None rather than "now": inventing a timestamp on the
    client's behalf is how a made-up ordering ends up looking like evidence.
    Naive values are read as UTC, which is what the plugin sends.
    """
    if not raw:
        return None
    text = str(raw).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        when = datetime.fromisoformat(text)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return when


def _delay_seconds(occurred: datetime | None) -> int:
    """How late this arrived, floored at zero.

    A phone whose clock is ahead reports a negative delay, which is a clock
    problem and not a punctual event — it clamps to zero here and shows up in
    `telemetry_arrivals` as an `occurred_at` in the future, which is the honest
    record of what happened.
    """
    if occurred is None:
        return 0
    return max(0, int((datetime.now(timezone.utc) - occurred).total_seconds()))


def _record_arrival(tenant_id: str, kind: str, *, device_serial: str | None,
                    occurred: datetime | None, replayed: bool) -> None:
    """Log the claim beside the truth. No claim, no row.

    Never raises: this is the diagnostic layer, and losing a diagnostic must
    not lose the shift it describes.
    """
    if occurred is None:
        return
    try:
        db.execute(
            """
            INSERT INTO telemetry_arrivals
                (tenant_id, kind, device_serial, occurred_at, delay_seconds, replayed)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (tenant_id, kind, device_serial, occurred, _delay_seconds(occurred),
             bool(replayed)),
        )
    except Exception:
        return


def _uuid_or_none(value: str | None) -> str | None:
    """A shift id off the wire, or None. A malformed one is not an error worth
    failing somebody's clock-in over — it just means there is nothing to
    resume."""
    if not value:
        return None
    try:
        return str(uuid.UUID(str(value)))
    except (TypeError, ValueError):
        return None


# --- the sweep ---------------------------------------------------------------

def close_stale(tenant_id: str | None = None) -> int:
    """Close shifts whose phone stopped saying it was there.

    `ended_at` is the **last heartbeat**, not now(). That single choice is what
    keeps the denominator honest: the shift ends at the last moment the floor
    demonstrably had the product running, so a phone that went flat at 3pm does
    not report an eleven-hour day because nobody looked until midnight.

    Called at the top of every read and before every new shift, rather than on
    a timer. A timer is a second thing that can stop without telling anyone,
    and stale rows only do harm at the moment somebody reads them.
    """
    params: list = [GAP_MINUTES]
    where = ""
    if tenant_id:
        where = " AND tenant_id = %s"
        params.append(tenant_id)
    closed = db.execute(
        f"""
        UPDATE shifts
           SET ended_at = GREATEST(started_at, last_heartbeat_at),
               ended_reason = 'heartbeat_gap'
         WHERE ended_at IS NULL
           AND last_heartbeat_at < now() - make_interval(mins => %s)
           {where}
        """,
        tuple(params),
    )
    return closed


def prune_arrivals() -> int:
    """Arrival records are diagnostics with a shelf life. Bounded here so the
    table cannot become the largest thing in the database by doing nothing."""
    return db.execute(
        "DELETE FROM telemetry_arrivals WHERE received_at < now() - make_interval(days => %s)",
        (ARRIVAL_KEEP_DAYS,),
    )


def prune_expired() -> dict:
    """Drop shift and device history past each tenant's own retention window.

    These three tables are the associate's half of this product, and a
    retention promise that covers the customer's half and quietly excludes the
    staff's is the promise a works council will find first. So the window comes
    from the same `privacy.retention_days` the guest data uses, per tenant,
    rather than from a constant here.

    Deleted rather than redacted, unlike `retention.py`'s sweeps. There is
    nothing in a shift worth keeping once the identity is gone — a row saying
    "somebody worked four hours" with no name on it is not analytics, it is
    ballast — and the aggregate a manager reads is only ever asked for over a
    window far shorter than this.

    Called from the retention loop and returns its own counts without touching
    `retention_runs`: that table's columns are a contract the Console panel and
    its tests both read, and widening it is not what this change is for.
    """
    from .retention import DEFAULT_DAYS

    removed = {"shifts": 0, "device_health": 0, "arrivals": prune_arrivals()}
    for t in db.query("SELECT id, privacy FROM tenants WHERE status <> 'archived'"):
        days = (t.get("privacy") or {}).get("retention_days")
        try:
            days = int(days)
        except (TypeError, ValueError):
            days = DEFAULT_DAYS
        days = max(1, days)
        removed["shifts"] += db.execute(
            "DELETE FROM shifts WHERE tenant_id = %s "
            "  AND started_at < now() - make_interval(days => %s)",
            (t["id"], days),
        )
        removed["device_health"] += db.execute(
            "DELETE FROM device_health WHERE tenant_id = %s "
            "  AND created_at < now() - make_interval(days => %s)",
            (t["id"], days),
        )
    return removed


# --- write side --------------------------------------------------------------

def start(tenant: dict, *, user_id: str | None, device_serial: str | None,
          zone: str | None = None, occurred_at: str | None = None,
          resume_shift_id: str | None = None, replayed: bool = False) -> dict:
    """Somebody is on the floor with the product running.

    Three things happen, in this order, and the order matters:

    1. Stale shifts are closed, so a resume of a shift that already gapped out
       falls through to a new one instead of reopening an afternoon.
    2. If the plugin handed back a shift id it still believes in, and that
       shift is open and belongs to the same glasses, it is continued. A
       WebView teardown — which on this host is every time the phone goes in a
       pocket — must not fragment one shift into nine.
    3. Otherwise any other open shift for the same glasses or the same person
       is closed as `superseded`, at *its* last heartbeat, and a new one opens.

    Step 3 is what stops two shifts existing for one person. A second pair of
    glasses assigned to the same associate closes the first: they cannot be
    wearing both, and two open shifts would double their denominator and halve
    every rate they have.
    """
    close_stale(tenant["id"])

    resume = _uuid_or_none(resume_shift_id)
    if resume:
        row = db.query_one(
            """
            UPDATE shifts
               SET last_heartbeat_at = now(),
                   zone = COALESCE(%s, zone),
                   user_id = COALESCE(%s, user_id)
             WHERE id = %s AND tenant_id = %s AND ended_at IS NULL
               AND device_serial IS NOT DISTINCT FROM %s
            RETURNING id, started_at, user_id, device_serial, zone
            """,
            (zone, user_id, resume, tenant["id"], device_serial),
        )
        if row:
            return {"ok": True, "resumed": True, "shift_id": str(row["id"]),
                    "started_at": row["started_at"].isoformat(),
                    "user_id": str(row["user_id"]) if row["user_id"] else None,
                    "heartbeat_seconds": HEARTBEAT_SECONDS}

    occurred = parse_client_time(occurred_at)

    # The same clock-in arriving twice.
    #
    # A phone that buffered a start has no shift id to hand back — the write
    # that would have produced one is exactly the write that failed — so a
    # flush whose acknowledgement got lost replays it on the next connection.
    # (tenant, serial, the phone's own start time) is the natural key for that
    # event, enforced by a unique index, and matching on it here turns a
    # duplicate into the row it already made instead of a second shift that
    # supersedes the first.
    if occurred is not None and device_serial:
        seen = db.query_one(
            """
            SELECT id, started_at, user_id, ended_at FROM shifts
             WHERE tenant_id = %s AND device_serial = %s AND client_started_at = %s
            """,
            (tenant["id"], device_serial, occurred),
        )
        if seen:
            return {"ok": True, "resumed": True, "duplicate": True,
                    "shift_id": str(seen["id"]),
                    "started_at": seen["started_at"].isoformat(),
                    "user_id": str(seen["user_id"]) if seen["user_id"] else None,
                    "heartbeat_seconds": HEARTBEAT_SECONDS}

    # Anything else this person or this hardware still has open. The
    # `IS NOT NULL` guards are deliberate: a NULL user_id must not match every
    # other unassigned pair of glasses in the store, and a NULL serial must not
    # match every device that has never reported one.
    #
    # Explicitly cast, because a bare placeholder inside `IS NOT NULL` gives the
    # planner nothing to infer a type from and Postgres refuses the statement
    # rather than guessing — which is the right behaviour and an opaque error
    # the first time you meet it.
    db.execute(
        """
        UPDATE shifts
           SET ended_at = GREATEST(started_at, last_heartbeat_at),
               ended_reason = 'superseded'
         WHERE tenant_id = %(tenant)s AND ended_at IS NULL
           AND ((%(serial)s::text IS NOT NULL AND device_serial = %(serial)s::text)
             OR (%(user)s::uuid IS NOT NULL AND user_id = %(user)s::uuid))
        """,
        {"tenant": tenant["id"], "serial": device_serial, "user": user_id},
    )

    row = db.query_one(
        """
        INSERT INTO shifts (tenant_id, user_id, device_serial, zone, client_started_at)
        VALUES (%s, %s, %s, %s, %s)
        RETURNING id, started_at
        """,
        (tenant["id"], user_id, device_serial, zone, occurred),
    )
    _record_arrival(tenant["id"], "shift.start", device_serial=device_serial,
                    occurred=occurred, replayed=replayed)
    return {"ok": True, "resumed": False, "shift_id": str(row["id"]),
            "started_at": row["started_at"].isoformat(),
            "user_id": user_id,
            "heartbeat_seconds": HEARTBEAT_SECONDS}


def heartbeat(tenant: dict, *, shift_id: str) -> dict:
    """Still here. Stamped with this machine's clock and no other.

    Answers `open: False` for a shift that has already closed rather than
    reopening it. The plugin reads that and starts a fresh one — which is the
    right outcome: whatever closed it (a gap, a supersede) was a real event,
    and un-closing it would erase the only record of the gap.
    """
    sid = _uuid_or_none(shift_id)
    if not sid:
        return {"ok": False, "open": False, "reason": "unknown_shift"}
    row = db.query_one(
        """
        UPDATE shifts SET last_heartbeat_at = now()
         WHERE id = %s AND tenant_id = %s AND ended_at IS NULL
        RETURNING id, started_at
        """,
        (sid, tenant["id"]),
    )
    if row is None:
        return {"ok": True, "open": False, "reason": "closed"}
    return {"ok": True, "open": True, "shift_id": str(row["id"]),
            "heartbeat_seconds": HEARTBEAT_SECONDS}


def end(tenant: dict, *, shift_id: str, reason: str | None = None,
        occurred_at: str | None = None, replayed: bool = False) -> dict:
    """Clock out.

    `ended_at` is server-stamped even when the end arrives late, and it is
    clamped to the last heartbeat whenever the phone has stopped talking to
    us. So an end that spent the night in the phone's offline buffer closes the
    shift at the last moment we know the app was running — not at breakfast,
    when it finally reconnected. The phone's own claim is kept in
    `client_ended_at`, where it can be read and cannot inflate an hour count.

    Idempotent. A shift already closed by the gap sweep answers `ok: False`
    with the reason it actually closed for; the buffered end that arrives
    afterwards is then a no-op rather than a rewrite of history.
    """
    sid = _uuid_or_none(shift_id)
    if not sid:
        return {"ok": False, "reason": "unknown_shift"}
    if reason not in CLIENT_REASONS:
        reason = "app_closed"
    occurred = parse_client_time(occurred_at)
    row = db.query_one(
        """
        UPDATE shifts
           SET ended_at = CASE
                   WHEN last_heartbeat_at > now() - make_interval(mins => %(gap)s)
                        THEN now()
                   ELSE GREATEST(started_at, last_heartbeat_at)
               END,
               ended_reason = %(reason)s,
               client_ended_at = %(client)s
         WHERE id = %(id)s AND tenant_id = %(tenant)s AND ended_at IS NULL
        RETURNING id, device_serial, started_at, ended_at, ended_reason
        """,
        {"gap": GAP_MINUTES, "reason": reason, "client": occurred,
         "id": sid, "tenant": tenant["id"]},
    )
    if row is None:
        already = db.query_one(
            "SELECT ended_at, ended_reason FROM shifts WHERE id = %s AND tenant_id = %s",
            (sid, tenant["id"]),
        )
        return {"ok": False,
                "reason": (already or {}).get("ended_reason") or "unknown_shift",
                "ended_at": (already or {}).get("ended_at").isoformat()
                if (already or {}).get("ended_at") else None}
    _record_arrival(tenant["id"], "shift.end", device_serial=row["device_serial"],
                    occurred=occurred, replayed=replayed)
    return {
        "ok": True, "shift_id": str(row["id"]),
        "ended_at": row["ended_at"].isoformat(),
        "ended_reason": row["ended_reason"],
        "seconds": int((row["ended_at"] - row["started_at"]).total_seconds()),
    }


#: Mirrors the SDK's DeviceConnectType. Anything unrecognised is stored as
#: `none` — "we have not been told" — rather than rejected, because a CHECK
#: violation here would fail a write nobody can see.
CONNECTIONS = ("none", "connecting", "connected", "disconnected", "connectionFailed")


def record_health(tenant: dict, *, device_serial: str, battery_percent: int | None,
                  charging: bool | None = None, in_case: bool | None = None,
                  wearing: bool | None = None, connection: str | None = None,
                  occurred_at: str | None = None, replayed: bool = False) -> dict:
    """One `DeviceStatus` from the phone, against the serial it came from.

    Rows rather than a current-state column on `devices`: "what is the battery
    now" is answerable from the latest row, and "does this pair fall off the
    floor every afternoon" is only answerable from the history — and the second
    question is the one that gets a unit replaced.

    Battery outside 0–100 is dropped rather than clamped. A percentage of 127
    is a decode bug, and clamping it to 100 would file that bug as a healthy
    pair of glasses.
    """
    serial = (device_serial or "").strip()
    if not serial:
        return {"ok": False, "reason": "no_serial"}

    level = battery_percent
    if level is not None:
        try:
            level = int(level)
        except (TypeError, ValueError):
            level = None
        if level is not None and not 0 <= level <= 100:
            level = None

    conn = connection if connection in CONNECTIONS else "none"
    occurred = parse_client_time(occurred_at)

    # `DO NOTHING` against the unique index on (tenant, serial, client_at): a
    # replayed burst that arrives twice must produce one row. Doubling a
    # disconnect count is not a rounding error — "this pair drops off the floor
    # six times a day" is the sentence that gets a unit replaced.
    row = db.query_one(
        """
        INSERT INTO device_health
            (tenant_id, device_serial, battery_percent, charging, in_case,
             wearing, connection, client_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT DO NOTHING
        RETURNING id, created_at
        """,
        (tenant["id"], serial, level, charging, in_case, wearing, conn, occurred),
    )
    if row is None:
        return {"ok": True, "duplicate": True, "battery_percent": level,
                "connection": conn}
    # The same side effect `_associate` has, for the same reason: this is one
    # of the few things that honestly knows the hardware was on a floor.
    db.execute(
        "UPDATE devices SET last_seen_at = now() WHERE tenant_id = %s AND serial = %s",
        (tenant["id"], serial),
    )
    _record_arrival(tenant["id"], "device.health", device_serial=serial,
                    occurred=occurred, replayed=replayed)
    return {"ok": True, "health_id": str(row["id"]),
            "recorded_at": row["created_at"].isoformat(),
            "battery_percent": level, "connection": conn}


# --- read side ---------------------------------------------------------------

def _rate(count: float | int | None, hours: float) -> float | None:
    """Per hour, or None when there are not enough hours to divide by.

    None, not zero and not the raw count. A rate computed over four minutes is
    the number that wins a leaderboard, and unknown must never render as a
    result.
    """
    if hours < MIN_HOURS_FOR_RATE:
        return None
    return round(float(count or 0) / hours, 2)


def coverage(tenant: dict, days: int = 7) -> dict:
    """Hours worked, and every count divided by them.

    The shape a dashboard reads. Both halves of every rate are returned beside
    it — the count and the hours — for the same reason the leaderboard returns
    its components: a ratio nobody can decompose is a ratio nobody trusts, and
    the first question anybody asks a rate is "out of what".

    The activity counts are for the whole window, not only for time inside a
    shift. A cue that landed while somebody's phone was between shifts still
    happened, and quietly discarding it to make the arithmetic tidy would make
    the total disagree with every other panel in the product.
    """
    close_stale(tenant["id"])

    rows = db.query(
        """
        WITH sh AS (
            SELECT user_id,
                   count(*)                                        AS shifts,
                   count(*) FILTER (WHERE ended_at IS NULL)        AS open_shifts,
                   count(*) FILTER (WHERE ended_reason = 'heartbeat_gap')
                                                                   AS gap_closed,
                   sum(EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - started_at)))
                                                                   AS seconds,
                   max(COALESCE(ended_at, last_heartbeat_at))      AS last_seen_at
              FROM shifts
             WHERE tenant_id = %(tenant)s
               AND started_at > now() - make_interval(days => %(days)s)
             GROUP BY 1
        ), eng AS (
            SELECT associate_user_id AS user_id, count(*) AS engagements,
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
        SELECT u.id, u.name,
               COALESCE(sh.shifts, 0)        AS shifts,
               COALESCE(sh.open_shifts, 0)   AS open_shifts,
               COALESCE(sh.gap_closed, 0)    AS gap_closed,
               COALESCE(sh.seconds, 0)       AS seconds,
               sh.last_seen_at,
               COALESCE(eng.engagements, 0)  AS engagements,
               COALESCE(eng.sale_cents, 0)   AS sale_cents,
               COALESCE(ast.assists, 0)      AS assists,
               COALESCE(vq.voice_queries, 0) AS voice_queries
          FROM users u
     LEFT JOIN sh  ON sh.user_id  = u.id
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
        hours = round(float(r["seconds"] or 0) / 3600.0, 2)
        out.append({
            "user_id": str(r["id"]),
            "name": r["name"],
            "shifts": int(r["shifts"] or 0),
            "hours_worked": hours,
            "on_shift": bool(r["open_shifts"]),
            # How many of those shifts we had to infer the end of. A row where
            # this is most of the shifts is a phone with a battery problem, and
            # its rates are worth less than the ones beside it.
            "shifts_closed_by_gap": int(r["gap_closed"] or 0),
            "last_seen_at": r["last_seen_at"].isoformat() if r["last_seen_at"] else None,
            "engagements": int(r["engagements"] or 0),
            "assists": int(r["assists"] or 0),
            "voice_queries": int(r["voice_queries"] or 0),
            "sale_cents": int(r["sale_cents"] or 0),
            "engagements_per_hour": _rate(r["engagements"], hours),
            "assists_per_hour": _rate(r["assists"], hours),
            "voice_queries_per_hour": _rate(r["voice_queries"], hours),
            "sale_cents_per_hour": _rate(r["sale_cents"], hours),
        })
    out.sort(key=lambda x: (-(x["hours_worked"]), x["name"] or ""))

    # Glasses that were on the floor with nobody assigned to them. Reported
    # rather than folded into the totals: those hours were worked by somebody,
    # and hiding them makes the store's total hours look wrong in a way nobody
    # can chase. Console names the serial; here it is a count and a nudge.
    orphan = db.query_one(
        """
        SELECT count(*) AS shifts,
               COALESCE(sum(EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - started_at))), 0)
                   AS seconds,
               count(DISTINCT device_serial) AS devices
          FROM shifts
         WHERE tenant_id = %(tenant)s AND user_id IS NULL
           AND started_at > now() - make_interval(days => %(days)s)
        """,
        {"tenant": tenant["id"], "days": days},
    ) or {}

    total_hours = round(sum(r["hours_worked"] for r in out), 2)
    return {
        "window_days": days,
        "enabled": bool((tenant.get("privacy") or {}).get("shift_telemetry")),
        "gap_minutes": GAP_MINUTES,
        "min_hours_for_rate": MIN_HOURS_FOR_RATE,
        "totals": {
            "hours_worked": total_hours,
            "shifts": sum(r["shifts"] for r in out),
            "on_shift_now": sum(1 for r in out if r["on_shift"]),
            "associates_with_hours": sum(1 for r in out if r["hours_worked"] > 0),
            "engagements_per_hour": _rate(sum(r["engagements"] for r in out), total_hours),
        },
        "rows": out,
        "unassigned_devices": {
            "shifts": int(orphan.get("shifts") or 0),
            "hours_worked": round(float(orphan.get("seconds") or 0) / 3600.0, 2),
            "devices": int(orphan.get("devices") or 0),
        },
    }


def fleet(tenant_id: str) -> list[dict]:
    """The state of every pair of glasses we have heard from.

    Latest row per serial, plus how often it dropped off in the last day.
    Battery ascending, so the pair that will not finish the shift is first and
    nobody has to scan a list to find it.
    """
    return db.query(
        """
        WITH latest AS (
            SELECT DISTINCT ON (device_serial) *
              FROM device_health
             WHERE tenant_id = %(tenant)s
               AND created_at > now() - interval '30 days'
             ORDER BY device_serial, created_at DESC
        ), drops AS (
            SELECT device_serial, count(*) AS disconnects
              FROM device_health
             WHERE tenant_id = %(tenant)s
               AND created_at > now() - interval '24 hours'
               AND connection IN ('disconnected', 'connectionFailed')
             GROUP BY 1
        )
        SELECT l.device_serial, l.battery_percent, l.charging, l.in_case,
               l.wearing, l.connection, l.created_at AS reported_at,
               COALESCE(dr.disconnects, 0) AS disconnects_24h,
               d.model, d.label, u.name AS assigned_to
          FROM latest l
     LEFT JOIN drops dr ON dr.device_serial = l.device_serial
     LEFT JOIN devices d ON d.tenant_id = %(tenant)s AND d.serial = l.device_serial
     LEFT JOIN users u ON u.id = d.user_id
         ORDER BY l.battery_percent NULLS LAST, l.device_serial
        """,
        {"tenant": tenant_id},
    )


def arrivals(tenant_id: str | None = None, hours: int = 24) -> dict:
    """How honest the timestamps coming in look.

    Replayed and unbuffered lateness are counted apart on purpose. A replayed
    event is *supposed* to be late — that is the entire point of the buffer, and
    counting it as a fault would train everyone to ignore this number. An event
    that was never buffered and still took an hour is a clock that needs
    looking at.
    """
    where = ""
    params: dict = {"hours": hours, "late": LATE_SECONDS}
    if tenant_id:
        where = " AND tenant_id = %(tenant)s"
        params["tenant"] = tenant_id
    row = db.query_one(
        f"""
        SELECT count(*) AS events,
               count(*) FILTER (WHERE replayed) AS replayed,
               count(*) FILTER (WHERE delay_seconds > %(late)s) AS late,
               count(*) FILTER (WHERE delay_seconds > %(late)s AND NOT replayed)
                   AS late_unbuffered,
               COALESCE(max(delay_seconds), 0) AS worst_delay_seconds,
               count(*) FILTER (WHERE occurred_at > received_at + interval '2 minutes')
                   AS clocks_ahead
          FROM telemetry_arrivals
         WHERE received_at > now() - make_interval(hours => %(hours)s)
         {where}
        """,
        params,
    ) or {}
    return {
        "window_hours": hours,
        "late_after_seconds": LATE_SECONDS,
        "events": int(row.get("events") or 0),
        "replayed": int(row.get("replayed") or 0),
        "late": int(row.get("late") or 0),
        "late_unbuffered": int(row.get("late_unbuffered") or 0),
        "worst_delay_seconds": int(row.get("worst_delay_seconds") or 0),
        # A phone whose clock is ahead of ours. Rare, and worth its own number:
        # it is the one failure that makes an ordering wrong rather than late.
        "clocks_ahead": int(row.get("clocks_ahead") or 0),
    }


def platform_fleet() -> dict:
    """Cross-tenant fleet state, for Console.

    Every number here answers "is the hardware the reason a store's figures
    look like that". Tenants with the flag off contribute nothing and are
    counted, so an empty panel can say *why* it is empty instead of reading as
    a healthy fleet of zero devices.
    """
    close_stale()
    prune_arrivals()

    enabled = db.query(
        """
        SELECT slug FROM tenants
         WHERE status = 'active' AND privacy ->> 'shift_telemetry' = 'true'
         ORDER BY slug
        """
    )

    low = db.query(
        """
        WITH latest AS (
            SELECT DISTINCT ON (tenant_id, device_serial) *
              FROM device_health
             WHERE created_at > now() - interval '7 days'
             ORDER BY tenant_id, device_serial, created_at DESC
        )
        SELECT t.slug, l.device_serial, l.battery_percent, l.charging,
               l.connection, l.created_at AS reported_at, u.name AS assigned_to
          FROM latest l
          JOIN tenants t ON t.id = l.tenant_id
     LEFT JOIN devices d ON d.tenant_id = l.tenant_id AND d.serial = l.device_serial
     LEFT JOIN users u ON u.id = d.user_id
         WHERE l.battery_percent IS NOT NULL
           AND l.battery_percent <= %s
           AND COALESCE(l.charging, false) = false
         ORDER BY l.battery_percent
         LIMIT 10
        """,
        (LOW_BATTERY_PERCENT,),
    )

    dropping = db.query(
        """
        SELECT t.slug, h.device_serial, count(*) AS disconnects
          FROM device_health h JOIN tenants t ON t.id = h.tenant_id
         WHERE h.created_at > now() - interval '24 hours'
           AND h.connection IN ('disconnected', 'connectionFailed')
         GROUP BY 1, 2
        HAVING count(*) >= 3
         ORDER BY count(*) DESC
         LIMIT 10
        """
    )

    open_now = db.query_one(
        """
        SELECT count(*) AS n,
               count(DISTINCT tenant_id) AS tenants,
               min(started_at) AS oldest_started_at
          FROM shifts WHERE ended_at IS NULL
        """
    ) or {}

    return {
        "enabled_tenants": [r["slug"] for r in enabled],
        "low_battery_percent": LOW_BATTERY_PERCENT,
        "low_battery": [
            {"tenant": r["slug"], "serial": r["device_serial"],
             "battery_percent": r["battery_percent"],
             "charging": r["charging"], "connection": r["connection"],
             "assigned_to": r["assigned_to"],
             "reported_at": r["reported_at"].isoformat() if r["reported_at"] else None}
            for r in low
        ],
        "dropping": [
            {"tenant": r["slug"], "serial": r["device_serial"],
             "disconnects_24h": int(r["disconnects"])}
            for r in dropping
        ],
        "open_shifts": {
            "count": int(open_now.get("n") or 0),
            "tenants": int(open_now.get("tenants") or 0),
            "oldest_started_at": open_now["oldest_started_at"].isoformat()
            if open_now.get("oldest_started_at") else None,
            "gap_minutes": GAP_MINUTES,
        },
        "arrivals": arrivals(),
    }
