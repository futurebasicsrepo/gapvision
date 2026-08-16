-- Phone camera capture, per tenant, off by default.
--
-- The G2 has no camera and is not getting one. The *phone* running the plugin
-- does, and the Even SDK exposes it, so an associate can photograph a SKU tag
-- or a broken part and get the answer on the glass.
--
-- That is a capture of an object. It is not, and must never become, a capture
-- of a person: no face detection, no matching a photograph to a customer. The
-- boundary is written into the module docstring, the Console copy and the
-- permission description as well as here, because a rule that lives only in
-- someone's memory is a rule that gets relaxed by the next person who reads
-- the schema.
--
-- Same shape as `store_transcripts`: one key in the existing `privacy` blob,
-- default false, flipped by a client_admin in Console → Tenants. A capability
-- that ships on rather than off is a capability nobody consented to.

ALTER TABLE tenants
    ALTER COLUMN privacy SET DEFAULT
    '{"store_transcripts": false, "camera_capture": false, "retention_days": 90,
      "opt_in_tiers": ["qr_checkin"]}'::jsonb;

-- Backfill. The default only applies to rows inserted after this runs, and a
-- tenant whose blob has no `camera_capture` key would read as "unset" forever —
-- which the service treats as off, but "off because we said so" and "off
-- because nobody has said anything" are different answers to a privacy
-- question, and only one of them survives being asked about.
--
-- `privacy -> 'camera_capture' IS NULL` rather than the `?` containment
-- operator: this file is executed through psycopg, and a bare `?` in SQL text
-- is one driver version away from being read as a placeholder. The arrow form
-- asks the same question and cannot be mistaken for anything.
UPDATE tenants
   SET privacy = privacy || '{"camera_capture": false}'::jsonb,
       updated_at = now()
 WHERE privacy -> 'camera_capture' IS NULL;
