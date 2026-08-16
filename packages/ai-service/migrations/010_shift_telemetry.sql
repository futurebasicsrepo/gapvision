-- Shift boundaries, glasses health, and the client clock. Per tenant, off by default.
--
-- Why any of this exists
-- ----------------------
-- Every number the dashboards show today is a raw count. A raw count has no
-- denominator, so it punishes the person who works Tuesday mornings, rewards
-- whoever left the app running over lunch, and cannot tell a quiet afternoon
-- from a router that stopped answering. Three tables' worth of plumbing fixes
-- that:
--
--   shifts               when somebody was actually working, so "cues per hour
--                        worked" has a bottom half.
--   device_health        battery and connection against a serial, so a pair
--                        that dies at 3pm every day reads as a hardware fault
--                        rather than as an associate who stopped working.
--   telemetry_arrivals   what the client said the time was, beside what the
--                        clock here said when it landed.
--
-- Why it is off by default, in `privacy`
-- --------------------------------------
-- This is data about the *associate*, not about the customer. Per-person rate
-- metrics are performance monitoring, which is regulated separately from
-- customer privacy in some jurisdictions and bargained separately in most
-- union shops. So it goes in the same blob, with the same posture, as
-- `camera_capture` and `store_transcripts`: **a capability that ships on is a
-- capability nobody consented to.**
--
-- The plugin reads the flag through `/api/tenant/capabilities` to decide what
-- to send and what to say on the associate's own phone page. Every ingest
-- route re-reads it server-side, because a static bundle on somebody's phone
-- is not where a consent decision gets enforced.

ALTER TABLE tenants
    ALTER COLUMN privacy SET DEFAULT
    '{"store_transcripts": false, "camera_capture": false, "shift_telemetry": false,
      "retention_days": 90, "opt_in_tiers": ["qr_checkin"]}'::jsonb;

-- Backfill, for the reason 009 spells out and which has not changed: the
-- default only applies to rows inserted after this runs, and a tenant whose
-- blob has no `shift_telemetry` key would read as "unset" forever. The service
-- treats unset as off — but "off because we said so" and "off because nobody
-- has said anything" are different answers to a question a works council is
-- entitled to ask, and only one of them survives being asked.
--
-- `privacy -> 'shift_telemetry' IS NULL` rather than the `?` containment
-- operator, same as 009: this file is executed through psycopg, and a bare `?`
-- in SQL text is one driver version away from being read as a placeholder. The
-- arrow form asks the same question and cannot be mistaken for anything.
UPDATE tenants
   SET privacy = privacy || '{"shift_telemetry": false}'::jsonb,
       updated_at = now()
 WHERE privacy -> 'shift_telemetry' IS NULL;


-- --- shifts ------------------------------------------------------------------
--
-- `register` fires when the app opens and nothing has ever closed it. There is
-- no clock-in and no clock-out, so an average has no denominator and an
-- associate who opened the app at 9am and went to a stock take reads as having
-- worked all day.
--
-- A shift here is *presence on the floor with the product running*, and
-- nothing more. It is deliberately not a payroll record: it starts when the
-- plugin comes up and ends when the phone stops saying otherwise. Anyone
-- reading it for hours-and-pay is reading it wrong, which is why the column is
-- `ended_reason` and not `clock_out`.

CREATE TABLE IF NOT EXISTS shifts (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Null when the glasses are not assigned to anybody yet. The shift is
    -- still worth recording: the fleet was in use, and Console can already say
    -- which serial it was. An associate mid-conversation must never have a
    -- write fail underneath them because a dropdown was not set.
    user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
    device_serial  text,
    zone           text,
    started_at     timestamptz NOT NULL DEFAULT now(),
    ended_at       timestamptz,
    -- How the shift closed. This is the column that keeps the average honest:
    -- a `heartbeat_gap` hour is an hour we inferred, not an hour anyone
    -- reported, and a report that cannot tell those apart is a report that
    -- will one day be defended in a meeting.
    ended_reason   text CHECK (ended_reason IN (
                       'signed_out', 'app_closed', 'heartbeat_gap', 'superseded')),
    -- Stamped here, never by the client. `ended_at` for a shift whose phone
    -- went flat is set to this: the last moment the floor demonstrably had the
    -- product running. Otherwise a dead battery at 3pm leaves an eleven-hour
    -- shift open and every rate in the building collapses.
    last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
    -- What the phone's own clock said. Ordering within a shift, and nothing
    -- else — see `telemetry_arrivals` below and `app/shifts.py`. Never used
    -- for a duration, a bill or a retention window.
    client_started_at timestamptz,
    client_ended_at   timestamptz
);

-- The two reads this table has: one associate's shifts over a window, and
-- "what is open right now".
CREATE INDEX IF NOT EXISTS shifts_tenant_started_idx
    ON shifts (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS shifts_user_idx
    ON shifts (user_id, started_at DESC);
-- Partial: open shifts are a handful and every sweep and every dashboard asks
-- for exactly them.
CREATE INDEX IF NOT EXISTS shifts_open_idx
    ON shifts (tenant_id, last_heartbeat_at) WHERE ended_at IS NULL;

-- The natural key for a replayed clock-in, and the reason replay is safe to
-- retry. A phone that buffered a shift start has no shift id to offer — the
-- write that would have given it one is the write that failed — so the only
-- thing identifying that event is the moment its own clock says it happened.
--
-- Without this, a flush that reached the server but whose acknowledgement did
-- not reach the phone replays on the next connection and opens a second shift,
-- superseding the first. With it, the second attempt finds the first and
-- returns it. This is the one job the client's clock is given, and it is the
-- ordering job: identity within one device's own history.
CREATE UNIQUE INDEX IF NOT EXISTS shifts_client_start_idx
    ON shifts (tenant_id, device_serial, client_started_at)
 WHERE client_started_at IS NOT NULL AND device_serial IS NOT NULL;


-- --- device health -----------------------------------------------------------
--
-- `DeviceStatus` has been in the Even SDK the whole time and nothing read it.
-- A pair of glasses that dies every afternoon currently appears on the
-- leaderboard as somebody who stops working after lunch, and the person it
-- happens to has no way to prove otherwise.
--
-- Rows, not a current-state column on `devices`: "what is the battery now" is
-- answerable from the latest row, and "does this pair drop off the floor every
-- day at three" is only answerable from the history. The second question is
-- the one that gets a unit replaced.

CREATE TABLE IF NOT EXISTS device_health (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- The serial rather than a device id: the glasses know their serial, and
    -- `devices` may not have a row yet the first time a pair appears on a
    -- floor. Joined on (tenant_id, serial), which is already UNIQUE there.
    device_serial   text NOT NULL,
    battery_percent smallint CHECK (battery_percent BETWEEN 0 AND 100),
    charging        boolean,
    in_case         boolean,
    wearing         boolean,
    -- Mirrors the SDK's DeviceConnectType. `none` is its uninitialised value
    -- and is kept rather than mapped to `disconnected`, because "we have not
    -- been told" and "it told us it is gone" are different facts.
    connection      text NOT NULL DEFAULT 'none'
                    CHECK (connection IN ('none', 'connecting', 'connected',
                                          'disconnected', 'connectionFailed')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- The phone's clock, for ordering a replayed burst. Same rule as above.
    client_at       timestamptz
);

CREATE INDEX IF NOT EXISTS device_health_recent_idx
    ON device_health (tenant_id, device_serial, created_at DESC);

-- Same natural key, same reason as `shifts_client_start_idx`: a replayed burst
-- that arrives twice must produce one row, not two. Doubling a disconnect
-- count is not a rounding error — "this pair drops off the floor six times a
-- day" is the sentence that gets a unit replaced.
CREATE UNIQUE INDEX IF NOT EXISTS device_health_client_idx
    ON device_health (tenant_id, device_serial, client_at)
 WHERE client_at IS NOT NULL;


-- --- when the client said it happened ----------------------------------------
--
-- Shop wifi drops. Socket events used to be fired into a closed connection and
-- lost, and the dashboard then reported something that did not happen — or,
-- worse, reported it at the wrong time when the phone came back.
--
-- The plugin now buffers while it is offline and replays on reconnect,
-- carrying the time the thing *occurred*. This table is where that claim is
-- kept beside the truth: `occurred_at` is the phone's word, `received_at` is
-- ours, and the gap between them is the only honest way to answer "is this
-- number late, or is it wrong".
--
-- Its own table rather than two more columns on each event table, for one
-- reason: the question "what arrived suspiciously late today" is one query
-- here and a three-way UNION otherwise, and a check nobody can write is a
-- check nobody runs.
--
-- Bounded by the same sweep that closes stale shifts — see `app/shifts.py`.
-- There is nothing in here worth keeping for a quarter.

CREATE TABLE IF NOT EXISTS telemetry_arrivals (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    kind           text NOT NULL,
    device_serial  text,
    occurred_at    timestamptz NOT NULL,
    received_at    timestamptz NOT NULL DEFAULT now(),
    -- Stored rather than derived so the "late" query is an index scan and a
    -- clamped client clock cannot make it negative. See `app/shifts.py`.
    delay_seconds  integer NOT NULL DEFAULT 0,
    -- True when the event came out of the phone's offline buffer rather than
    -- straight off the wire. A replayed event is *expected* to be late; an
    -- event that was never buffered and arrived an hour late is a clock
    -- problem, and only this column tells them apart.
    replayed       boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS telemetry_arrivals_late_idx
    ON telemetry_arrivals (tenant_id, received_at DESC);
