"""Shift boundaries, glasses health, and what a phone's clock is allowed to do.

    cd packages/ai-service && python3 -m pytest tests/test_shifts.py -q

Requires a Postgres to point CUE_TEST_DATABASE_URL at (falls back to
CUE_DATABASE_URL), same as `test_spine.py`. Skipped entirely without one.

Three failures this file exists to prevent, all of them silent:

1. **A shift that never closes.** A phone that goes flat at 3pm leaves an open
   row, and an open row counted to now() is an eleven-hour shift. That single
   number destroys every rate in the store, and it destroys them *quietly* —
   the leaderboard still renders, it is just wrong.
2. **A replayed event stamped with its delivery time.** The buffer exists so an
   event that happened during an outage still arrives. If it arrives claiming
   to have happened when the wifi came back, the buffer has made the data worse
   than losing it would have, because a wrong number looks like a real one.
3. **A write landing for a tenant that never turned this on.** The plugin holds
   a copy of the capability and uses it to decide what to send. That copy is in
   a static bundle on somebody's phone. It is not the gate.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import pytest

DB_URL = os.environ.get("CUE_TEST_DATABASE_URL") or os.environ.get("CUE_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB_URL, reason="no database configured")

if DB_URL:
    os.environ["CUE_DATABASE_URL"] = DB_URL

PW = "correct-horse-battery"
SERIAL = "G2-SHIFT-0001"
OTHER_SERIAL = "G2-SHIFT-0002"


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient
    from app import db
    from app.main import app

    db.migrate(verbose=False)
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def world(client):
    """Two tenants: one measuring its staff, one not.

    One is never enough here for the same reason it is never enough for
    isolation — a gate that is only ever tested from the permitted side is a
    gate nobody has tried to walk through.
    """
    from app import db, identity

    db.execute("DELETE FROM users WHERE email LIKE '%%@shifty.example.com'")
    db.execute("DELETE FROM tenants WHERE slug IN ('s_on', 's_off')")

    on = db.query_one(
        """
        INSERT INTO tenants (slug, name, privacy)
        VALUES ('s_on', 'Measured Retail',
                '{"shift_telemetry": true, "camera_capture": false,
                  "store_transcripts": false, "retention_days": 90}'::jsonb)
        RETURNING *
        """
    )
    off = db.query_one(
        """
        INSERT INTO tenants (slug, name, privacy)
        VALUES ('s_off', 'Unmeasured Retail',
                '{"shift_telemetry": false, "camera_capture": false,
                  "store_transcripts": false, "retention_days": 90}'::jsonb)
        RETURNING *
        """
    )
    maya = identity.create_user(email="maya@shifty.example.com", name="Maya Okafor",
                                role="associate", tenant_id=on["id"], password=PW)
    mgr = identity.create_user(email="mgr@shifty.example.com", name="Shifty Manager",
                               role="manager", tenant_id=on["id"], password=PW)
    db.execute(
        """
        INSERT INTO devices (tenant_id, user_id, model, serial, status)
        VALUES (%s, %s, 'g2', %s, 'active')
        ON CONFLICT (tenant_id, serial) DO UPDATE SET user_id = EXCLUDED.user_id
        """,
        (on["id"], maya["id"], SERIAL),
    )
    return {"on": on, "off": off, "maya": maya, "mgr": mgr}


@pytest.fixture(autouse=True)
def clean(world):
    """Every test starts with no shifts, no health and no activity.

    These tables are append-only in production, so a leftover open shift or a
    leftover engagement from the test above is exactly the state half of these
    assertions are about — and a rate test that inherits eight engagements from
    a coverage test fails for a reason that has nothing to do with rates.
    """
    from app import db
    for t in (world["on"], world["off"]):
        db.execute("DELETE FROM shifts WHERE tenant_id = %s", (t["id"],))
        db.execute("DELETE FROM device_health WHERE tenant_id = %s", (t["id"],))
        db.execute("DELETE FROM telemetry_arrivals WHERE tenant_id = %s", (t["id"],))
        db.execute("DELETE FROM assists WHERE tenant_id = %s", (t["id"],))
        db.execute("DELETE FROM voice_queries WHERE tenant_id = %s", (t["id"],))
        db.execute("DELETE FROM engagements WHERE tenant_id = %s", (t["id"],))


def service_key() -> dict:
    return {"x-gapvision-key": os.environ["GAPVISION_API_KEY"]}


def auth(client, email: str) -> dict:
    res = client.post("/auth/login", json={"email": email, "password": PW})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['token']}"}


def iso(when: datetime) -> str:
    return when.astimezone(timezone.utc).isoformat()


# --- the gate ----------------------------------------------------------------

def test_a_tenant_with_the_flag_off_is_refused_every_write(client, world):
    """The client's copy decides what to send. This decides what is recorded.

    All four routes, not just the first: a gate applied to three of four doors
    is not a gate, and the one that gets forgotten is always the one nobody
    thought of as a write.
    """
    from app import db

    calls = [
        ("/api/ingest/shift/start", {"tenant": "s_off", "device_serial": SERIAL}),
        ("/api/ingest/shift/heartbeat", {"tenant": "s_off", "shift_id": str(world["on"]["id"])}),
        ("/api/ingest/shift/end", {"tenant": "s_off", "shift_id": str(world["on"]["id"])}),
        ("/api/ingest/device/health",
         {"tenant": "s_off", "device_serial": SERIAL, "battery_percent": 40}),
    ]
    for path, body in calls:
        res = client.post(path, headers=service_key(), json=body)
        assert res.status_code == 403, f"{path} → {res.status_code}: {res.text}"
        # The refusal has to name the flag and where to change it, or the next
        # person debugs it by reading the schema.
        assert "shift_telemetry" in res.text, res.text
        assert "Console" in res.text, res.text

    assert db.query_one("SELECT count(*) AS n FROM shifts WHERE tenant_id = %s",
                        (world["off"]["id"],))["n"] == 0
    assert db.query_one("SELECT count(*) AS n FROM device_health WHERE tenant_id = %s",
                        (world["off"]["id"],))["n"] == 0


def test_the_gate_is_read_from_the_database_not_from_the_caller(client, world):
    """Flipping the flag takes effect on the next call, with nothing restarted.

    The plugin cannot be redeployed when a retailer changes their mind, and a
    capability cached at boot would mean a store that switched this off kept
    being measured until somebody noticed.
    """
    from app import db

    ok = client.post("/api/ingest/shift/start", headers=service_key(),
                     json={"tenant": "s_on", "device_serial": SERIAL})
    assert ok.status_code == 201, ok.text

    db.execute("UPDATE tenants SET privacy = privacy || '{\"shift_telemetry\": false}'::jsonb "
               " WHERE id = %s", (world["on"]["id"],))
    try:
        refused = client.post("/api/ingest/shift/start", headers=service_key(),
                              json={"tenant": "s_on", "device_serial": SERIAL})
        assert refused.status_code == 403, refused.text
    finally:
        db.execute("UPDATE tenants SET privacy = privacy || '{\"shift_telemetry\": true}'::jsonb "
                   " WHERE id = %s", (world["on"]["id"],))


def test_the_ingest_routes_still_need_the_service_key(client, world):
    """Same door, same lock as every other ingest route.

    Each body is complete, so a 401 is the auth refusing and not the schema —
    a 422 would pass a naive "not 200" assertion while proving nothing about
    the lock.
    """
    fake = "00000000-0000-0000-0000-000000000000"
    for path, body in (
        ("/api/ingest/shift/start", {"tenant": "s_on", "device_serial": SERIAL}),
        ("/api/ingest/shift/heartbeat", {"tenant": "s_on", "shift_id": fake}),
        ("/api/ingest/shift/end", {"tenant": "s_on", "shift_id": fake}),
        ("/api/ingest/device/health", {"tenant": "s_on", "device_serial": SERIAL}),
    ):
        assert client.post(path, json=body).status_code == 401, path


def test_capabilities_reports_the_switch_to_the_plugin(client, world):
    body = client.get("/api/tenant/capabilities?tenant=s_on",
                      headers=service_key()).json()
    assert body["shift_telemetry"] is True, body
    off = client.get("/api/tenant/capabilities?tenant=s_off",
                     headers=service_key()).json()
    assert off["shift_telemetry"] is False, off


# --- a shift that never closes -----------------------------------------------

def test_a_shift_whose_phone_died_closes_at_its_last_heartbeat(client, world):
    """The one that matters.

    A phone that goes flat leaves an open row. If the sweep closed it at the
    moment the sweep happened to run, a battery that died at 3pm would be
    recorded as an eleven-hour shift — and the associate it happened to would
    be the one whose per-hour numbers collapsed.
    """
    from app import db, shifts

    opened = client.post("/api/ingest/shift/start", headers=service_key(),
                         json={"tenant": "s_on", "device_serial": SERIAL}).json()
    shift_id = opened["shift_id"]

    # The phone stops talking. Wind both timestamps back rather than sleeping:
    # the behaviour under test is a gap, not a duration.
    died = datetime.now(timezone.utc) - timedelta(hours=4)
    db.execute(
        "UPDATE shifts SET started_at = %s, last_heartbeat_at = %s WHERE id = %s",
        (died - timedelta(hours=3), died, shift_id),
    )

    closed = shifts.close_stale(world["on"]["id"])
    assert closed == 1

    row = db.query_one("SELECT * FROM shifts WHERE id = %s", (shift_id,))
    assert row["ended_reason"] == "heartbeat_gap"
    # Ended when the phone stopped, not when we noticed. Within a second, which
    # is the resolution the assertion is actually about.
    assert abs((row["ended_at"] - died).total_seconds()) < 1, row
    # And therefore three hours, not seven.
    hours = (row["ended_at"] - row["started_at"]).total_seconds() / 3600
    assert 2.9 < hours < 3.1, hours


def test_a_heartbeat_inside_the_window_keeps_one_shift_rather_than_forty(client, world):
    """Flaky wifi is not forty shifts.

    Closing on every dropped socket would turn one afternoon on a bad access
    point into a column of two-minute shifts — a worse lie than the single open
    row it replaced, and a much more convincing one.
    """
    from app import db, shifts

    opened = client.post("/api/ingest/shift/start", headers=service_key(),
                         json={"tenant": "s_on", "device_serial": SERIAL}).json()
    shift_id = opened["shift_id"]

    beat = client.post("/api/ingest/shift/heartbeat", headers=service_key(),
                       json={"tenant": "s_on", "shift_id": shift_id}).json()
    assert beat["open"] is True, beat
    assert shifts.close_stale(world["on"]["id"]) == 0

    # The plugin comes back and offers the shift it still believes in.
    again = client.post("/api/ingest/shift/start", headers=service_key(),
                        json={"tenant": "s_on", "device_serial": SERIAL,
                              "resume_shift_id": shift_id}).json()
    assert again["resumed"] is True, again
    assert again["shift_id"] == shift_id
    assert db.query_one("SELECT count(*) AS n FROM shifts WHERE tenant_id = %s",
                        (world["on"]["id"],))["n"] == 1


def test_a_heartbeat_for_a_closed_shift_says_so_instead_of_reopening_it(client, world):
    """Whatever closed the shift was a real event, and un-closing it would erase
    the only record of the gap. The plugin reads `open: false` and starts a
    fresh shift, which is the honest outcome."""
    from app import db

    opened = client.post("/api/ingest/shift/start", headers=service_key(),
                         json={"tenant": "s_on", "device_serial": SERIAL}).json()
    client.post("/api/ingest/shift/end", headers=service_key(),
                json={"tenant": "s_on", "shift_id": opened["shift_id"],
                      "reason": "signed_out"})

    beat = client.post("/api/ingest/shift/heartbeat", headers=service_key(),
                       json={"tenant": "s_on", "shift_id": opened["shift_id"]}).json()
    assert beat["open"] is False, beat
    assert beat["reason"] == "closed"
    row = db.query_one("SELECT * FROM shifts WHERE id = %s", (opened["shift_id"],))
    assert row["ended_reason"] == "signed_out"


def test_a_second_pair_of_glasses_supersedes_the_first(client, world):
    """One person cannot be wearing two. Two open shifts would double their
    denominator and halve every rate they have."""
    from app import db

    first = client.post("/api/ingest/shift/start", headers=service_key(),
                        json={"tenant": "s_on", "device_serial": SERIAL,
                              "associate_email": "maya@shifty.example.com"}).json()
    second = client.post("/api/ingest/shift/start", headers=service_key(),
                         json={"tenant": "s_on", "device_serial": OTHER_SERIAL,
                               "associate_email": "maya@shifty.example.com"}).json()
    assert first["shift_id"] != second["shift_id"]

    rows = db.query("SELECT * FROM shifts WHERE tenant_id = %s ORDER BY started_at",
                    (world["on"]["id"],))
    assert len(rows) == 2
    assert rows[0]["ended_reason"] == "superseded"
    assert rows[1]["ended_at"] is None


def test_an_end_that_arrives_after_the_gap_does_not_stretch_the_shift(client, world):
    """An end that spent the night in a phone's buffer closes the shift at the
    last moment we know the app was running — not at breakfast."""
    from app import db

    opened = client.post("/api/ingest/shift/start", headers=service_key(),
                         json={"tenant": "s_on", "device_serial": SERIAL}).json()
    stopped = datetime.now(timezone.utc) - timedelta(hours=14)
    db.execute(
        "UPDATE shifts SET started_at = %s, last_heartbeat_at = %s WHERE id = %s",
        (stopped - timedelta(hours=2), stopped, opened["shift_id"]),
    )

    ended = client.post("/api/ingest/shift/end", headers=service_key(),
                        json={"tenant": "s_on", "shift_id": opened["shift_id"],
                              "reason": "app_closed", "occurred_at": iso(stopped),
                              "replayed": True}).json()
    assert ended["ok"] is True, ended
    assert 1.9 < ended["seconds"] / 3600 < 2.1, ended
    row = db.query_one("SELECT * FROM shifts WHERE id = %s", (opened["shift_id"],))
    assert abs((row["ended_at"] - stopped).total_seconds()) < 1, row
    # The phone's own claim is kept beside ours, where it can be read and
    # cannot inflate an hour count.
    assert abs((row["client_ended_at"] - stopped).total_seconds()) < 1, row


def test_ending_an_already_closed_shift_is_a_no_op_not_a_rewrite(client, world):
    """The buffered end that arrives after the gap sweep must not overwrite the
    reason the shift actually closed for."""
    from app import shifts

    opened = client.post("/api/ingest/shift/start", headers=service_key(),
                         json={"tenant": "s_on", "device_serial": SERIAL}).json()
    from app import db
    db.execute("UPDATE shifts SET last_heartbeat_at = now() - interval '2 hours' "
               " WHERE id = %s", (opened["shift_id"],))
    shifts.close_stale(world["on"]["id"])

    late = client.post("/api/ingest/shift/end", headers=service_key(),
                       json={"tenant": "s_on", "shift_id": opened["shift_id"],
                             "reason": "app_closed", "replayed": True}).json()
    assert late["ok"] is False, late
    assert late["reason"] == "heartbeat_gap", late


# --- the client's clock ------------------------------------------------------

def test_a_replayed_event_keeps_the_time_it_happened(client, world):
    """The whole point of the buffer.

    An event delivered at 09:04 that happened at 17:58 is recorded as having
    happened at 17:58. Reporting the delivery time would make the buffer worse
    than losing the event, because a wrong number looks like a real one.
    """
    from app import db

    happened = datetime.now(timezone.utc) - timedelta(hours=9)
    res = client.post("/api/ingest/device/health", headers=service_key(),
                      json={"tenant": "s_on", "device_serial": SERIAL,
                            "battery_percent": 12, "connection": "connected",
                            "occurred_at": iso(happened), "replayed": True})
    assert res.status_code == 201, res.text

    row = db.query_one(
        "SELECT * FROM device_health WHERE tenant_id = %s ORDER BY created_at DESC LIMIT 1",
        (world["on"]["id"],))
    assert abs((row["client_at"] - happened).total_seconds()) < 1, row
    # And ours is still ours: the receipt time is this machine's clock, so the
    # two together say "this happened nine hours ago and reached us now".
    assert (datetime.now(timezone.utc) - row["created_at"]).total_seconds() < 60

    arrival = db.query_one(
        "SELECT * FROM telemetry_arrivals WHERE tenant_id = %s "
        " ORDER BY received_at DESC LIMIT 1", (world["on"]["id"],))
    assert arrival["replayed"] is True
    assert arrival["delay_seconds"] > 8 * 3600, arrival


def test_the_same_buffered_start_replayed_twice_is_one_shift(client, world):
    """A flush that landed but whose acknowledgement did not is replayed on the
    next connection. Without a natural key that would open a second shift and
    supersede the first, which reads as an associate who clocked in twice."""
    from app import db

    happened = datetime.now(timezone.utc) - timedelta(minutes=5)
    body = {"tenant": "s_on", "device_serial": SERIAL,
            "occurred_at": iso(happened), "replayed": True}
    first = client.post("/api/ingest/shift/start", headers=service_key(), json=body).json()
    second = client.post("/api/ingest/shift/start", headers=service_key(), json=body).json()

    assert first["shift_id"] == second["shift_id"], (first, second)
    assert second.get("duplicate") is True, second
    assert db.query_one("SELECT count(*) AS n FROM shifts WHERE tenant_id = %s",
                        (world["on"]["id"],))["n"] == 1


def test_a_replayed_health_burst_arriving_twice_is_counted_once(client, world):
    """Doubling a disconnect count is not a rounding error — "this pair drops
    off the floor six times a day" is the sentence that gets a unit
    replaced."""
    from app import db

    happened = datetime.now(timezone.utc) - timedelta(minutes=30)
    body = {"tenant": "s_on", "device_serial": SERIAL, "battery_percent": 44,
            "connection": "disconnected", "occurred_at": iso(happened),
            "replayed": True}
    client.post("/api/ingest/device/health", headers=service_key(), json=body)
    client.post("/api/ingest/device/health", headers=service_key(), json=body)

    assert db.query_one(
        "SELECT count(*) AS n FROM device_health WHERE tenant_id = %s",
        (world["on"]["id"],))["n"] == 1


def test_an_unreadable_client_time_is_dropped_rather_than_invented(client, world):
    """Unparseable is None, never now(). Inventing a timestamp on a client's
    behalf is how a made-up ordering ends up looking like evidence."""
    from app import db, shifts

    assert shifts.parse_client_time("not a time") is None
    assert shifts.parse_client_time("") is None
    assert shifts.parse_client_time(None) is None

    res = client.post("/api/ingest/device/health", headers=service_key(),
                      json={"tenant": "s_on", "device_serial": SERIAL,
                            "battery_percent": 55, "occurred_at": "yesterday-ish"})
    assert res.status_code == 201, res.text
    row = db.query_one(
        "SELECT * FROM device_health WHERE tenant_id = %s ORDER BY created_at DESC LIMIT 1",
        (world["on"]["id"],))
    assert row["client_at"] is None
    assert db.query_one("SELECT count(*) AS n FROM telemetry_arrivals WHERE tenant_id = %s",
                        (world["on"]["id"],))["n"] == 0


def test_a_clock_running_ahead_never_produces_a_negative_delay(client, world):
    """A phone whose clock is ahead is a clock problem, not a punctual event.
    The claim is recorded as it was made and the delay floors at zero."""
    from app import db

    ahead = datetime.now(timezone.utc) + timedelta(hours=2)
    client.post("/api/ingest/device/health", headers=service_key(),
                json={"tenant": "s_on", "device_serial": SERIAL,
                      "battery_percent": 90, "occurred_at": iso(ahead)})
    arrival = db.query_one(
        "SELECT * FROM telemetry_arrivals WHERE tenant_id = %s ORDER BY received_at DESC LIMIT 1",
        (world["on"]["id"],))
    assert arrival["delay_seconds"] == 0, arrival
    assert arrival["occurred_at"] > arrival["received_at"], arrival

    # And it is counted as what it is, rather than as lateness.
    from app import shifts
    state = shifts.arrivals(world["on"]["id"])
    assert state["clocks_ahead"] == 1, state
    assert state["late"] == 0, state


# --- what a dashboard reads --------------------------------------------------

def test_coverage_divides_the_counts_by_the_hours(client, world):
    from app import db, shifts

    row = db.query_one(
        """
        INSERT INTO shifts (tenant_id, user_id, device_serial, started_at,
                            ended_at, ended_reason, last_heartbeat_at)
        VALUES (%s, %s, %s, now() - interval '4 hours', now(), 'signed_out', now())
        RETURNING id
        """,
        (world["on"]["id"], world["maya"]["id"], SERIAL),
    )
    assert row
    for _ in range(8):
        db.execute(
            "INSERT INTO engagements (tenant_id, associate_user_id) VALUES (%s, %s)",
            (world["on"]["id"], world["maya"]["id"]),
        )

    report = shifts.coverage(world["on"], days=7)
    mine = next(r for r in report["rows"] if r["user_id"] == str(world["maya"]["id"]))
    assert 3.9 < mine["hours_worked"] < 4.1, mine
    assert mine["engagements"] == 8
    assert 1.9 < mine["engagements_per_hour"] < 2.1, mine
    # Both halves are returned beside the rate. The first question anybody asks
    # a ratio is "out of what", and one nobody can decompose is one nobody acts
    # on.
    assert {"engagements", "hours_worked"} <= set(mine)


def test_a_rate_over_four_minutes_is_unknown_rather_than_a_winner(client, world):
    """Ten minutes of shift and one engagement is "six an hour", which is
    arithmetic rather than information — and on a leaderboard it is the number
    that beats everybody."""
    from app import db, shifts

    db.execute(
        """
        INSERT INTO shifts (tenant_id, user_id, device_serial, started_at,
                            ended_at, ended_reason, last_heartbeat_at)
        VALUES (%s, %s, %s, now() - interval '4 minutes', now(), 'signed_out', now())
        """,
        (world["on"]["id"], world["maya"]["id"], SERIAL),
    )
    db.execute("INSERT INTO engagements (tenant_id, associate_user_id) VALUES (%s, %s)",
               (world["on"]["id"], world["maya"]["id"]))

    report = shifts.coverage(world["on"], days=7)
    mine = next(r for r in report["rows"] if r["user_id"] == str(world["maya"]["id"]))
    assert mine["engagements"] == 1
    assert mine["engagements_per_hour"] is None, mine


def test_hours_on_unassigned_glasses_are_reported_rather_than_hidden(client, world):
    """Those hours were worked by somebody. Folding them into nothing makes the
    store's total disagree with every other panel and gives nobody a thread to
    pull."""
    from app import db, shifts

    db.execute(
        """
        INSERT INTO shifts (tenant_id, user_id, device_serial, started_at,
                            ended_at, ended_reason, last_heartbeat_at)
        VALUES (%s, NULL, %s, now() - interval '2 hours', now(), 'signed_out', now())
        """,
        (world["on"]["id"], "G2-NOBODY"),
    )
    report = shifts.coverage(world["on"], days=7)
    assert report["unassigned_devices"]["shifts"] == 1
    assert 1.9 < report["unassigned_devices"]["hours_worked"] < 2.1, report


def test_the_shifts_endpoint_says_so_when_a_store_has_this_off(client, world):
    """A manager whose store never turned this on is not doing anything wrong,
    and a 403 is a panel that renders as a crash."""
    from app import db, identity

    off_mgr = db.query_one("SELECT * FROM users WHERE email = %s",
                           ("offmgr@shifty.example.com",))
    if off_mgr is None:
        identity.create_user(email="offmgr@shifty.example.com", name="Off Manager",
                             role="manager", tenant_id=world["off"]["id"], password=PW)

    res = client.get("/api/analytics/shifts", headers=auth(client, "offmgr@shifty.example.com"))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["enabled"] is False, body
    assert body["rows"] == []
    assert "off" in body["detail"].lower()


def test_the_shifts_endpoint_needs_a_manager(client, world):
    assert client.get("/api/analytics/shifts").status_code == 401
    assert client.get("/api/analytics/shifts",
                      headers=auth(client, "maya@shifty.example.com")).status_code == 403


# --- the fleet ---------------------------------------------------------------

def test_the_fleet_view_puts_the_pair_that_will_not_last_the_shift_first(client, world):
    from app import shifts

    for serial, level in ((SERIAL, 72), (OTHER_SERIAL, 9)):
        client.post("/api/ingest/device/health", headers=service_key(),
                    json={"tenant": "s_on", "device_serial": serial,
                          "battery_percent": level, "connection": "connected"})
    rows = shifts.fleet(world["on"]["id"])
    assert [r["device_serial"] for r in rows] == [OTHER_SERIAL, SERIAL], rows
    # The assigned pair carries the name, so a manager reading a low battery
    # knows whose afternoon it is about to be.
    assert next(r for r in rows if r["device_serial"] == SERIAL)["assigned_to"] == "Maya Okafor"


def test_a_battery_outside_the_range_is_dropped_rather_than_clamped(client, world):
    """127% is a decode bug. Clamping it to 100 files that bug as a healthy pair
    of glasses."""
    from app import db

    client.post("/api/ingest/device/health", headers=service_key(),
                json={"tenant": "s_on", "device_serial": SERIAL,
                      "battery_percent": 127, "connection": "connected"})
    row = db.query_one(
        "SELECT * FROM device_health WHERE tenant_id = %s ORDER BY created_at DESC LIMIT 1",
        (world["on"]["id"],))
    assert row["battery_percent"] is None, row


def test_a_battery_of_zero_is_a_reading_and_not_an_absence(client, world):
    """The one every optional-field guard gets wrong. Zero is the most
    important battery level there is."""
    from app import db

    client.post("/api/ingest/device/health", headers=service_key(),
                json={"tenant": "s_on", "device_serial": SERIAL,
                      "battery_percent": 0, "connection": "disconnected"})
    row = db.query_one(
        "SELECT * FROM device_health WHERE tenant_id = %s ORDER BY created_at DESC LIMIT 1",
        (world["on"]["id"],))
    assert row["battery_percent"] == 0, row


def test_platform_fleet_says_why_it_is_empty_rather_than_reading_as_healthy(client, world):
    """Console's rule, and the one the first production deploy broke: unknown
    must never render as a pass. A fleet nobody is reporting is not a fleet in
    perfect health."""
    from app import db, shifts

    state = shifts.platform_fleet()
    assert "s_on" in state["enabled_tenants"], state
    assert "s_off" not in state["enabled_tenants"], state

    db.execute("UPDATE tenants SET privacy = privacy || '{\"shift_telemetry\": false}'::jsonb "
               " WHERE id = %s", (world["on"]["id"],))
    try:
        quiet = shifts.platform_fleet()
        assert quiet["enabled_tenants"] == [] or "s_on" not in quiet["enabled_tenants"]
    finally:
        db.execute("UPDATE tenants SET privacy = privacy || '{\"shift_telemetry\": true}'::jsonb "
                   " WHERE id = %s", (world["on"]["id"],))


def test_shift_history_expires_on_the_tenants_own_retention_window(client, world):
    """The staff's half of this product is covered by the same promise as the
    customer's. A retention window that quietly excludes the table full of
    "when did this person work" is the omission somebody finds first."""
    from app import db, retention, shifts

    db.execute(
        """
        INSERT INTO shifts (tenant_id, user_id, device_serial, started_at,
                            ended_at, ended_reason, last_heartbeat_at)
        VALUES (%s, %s, %s, now() - interval '200 days',
                now() - interval '200 days' + interval '3 hours', 'signed_out',
                now() - interval '200 days')
        """,
        (world["on"]["id"], world["maya"]["id"], SERIAL),
    )
    db.execute(
        """
        INSERT INTO device_health (tenant_id, device_serial, battery_percent,
                                   connection, created_at)
        VALUES (%s, %s, 50, 'connected', now() - interval '200 days')
        """,
        (world["on"]["id"], SERIAL),
    )
    fresh = client.post("/api/ingest/shift/start", headers=service_key(),
                        json={"tenant": "s_on", "device_serial": OTHER_SERIAL}).json()

    removed = shifts.prune_expired()
    assert removed["shifts"] >= 1 and removed["device_health"] >= 1, removed
    assert db.query_one("SELECT count(*) AS n FROM shifts WHERE tenant_id = %s "
                        " AND started_at < now() - interval '100 days'",
                        (world["on"]["id"],))["n"] == 0
    # And today's is untouched — a prune that takes the live shift is not a
    # retention policy, it is a bug with a good excuse.
    assert db.query_one("SELECT count(*) AS n FROM shifts WHERE id = %s",
                        (fresh["shift_id"],))["n"] == 1
    # It rides the retention loop without touching what that loop reports.
    runs = retention.sweep_all()
    assert all({"voice_redacted", "engagements_redacted"} <= set(r) for r in runs)


def test_health_checks_report_a_low_battery_and_an_open_shift(client, world):
    from app.routes_admin import _platform_checks, fleet_state

    client.post("/api/ingest/shift/start", headers=service_key(),
                json={"tenant": "s_on", "device_serial": SERIAL})
    client.post("/api/ingest/device/health", headers=service_key(),
                json={"tenant": "s_on", "device_serial": SERIAL,
                      "battery_percent": 6, "charging": False,
                      "connection": "connected"})

    checks = {c["key"]: c for c in _platform_checks(fleet_state())}
    assert checks["fleet"]["status"] == "warn", checks["fleet"]
    assert SERIAL in checks["fleet"]["detail"], checks["fleet"]
    assert checks["shifts"]["status"] == "ok"
    assert "1 across" in checks["shifts"]["detail"], checks["shifts"]
