-- The pipeline itself — every prospect, not just the ones who opened a deck.
--
-- The gap this closes
-- -------------------
-- `deck_leads` (012) records one event: somebody typed an email to open a
-- deck. It cannot say what happened next — whether Kyle emailed them, whether
-- they replied, whether a demo was booked, or that the site's "book a pilot"
-- form produced them in the first place. Outbound to the first ten target
-- accounts starts this week, and a pipeline that lives in a founder's inbox
-- is a pipeline that cannot be read, measured, or handed to the first
-- salesperson.
--
-- Not tenant data — same boundary as 012
-- --------------------------------------
-- These rows are **ours**: merchants we are chasing, people who filled the
-- site form. No tenant column, `cue_admin` only in the routes, and the same
-- reasoning as `deck_leads` — a retailer's manager must never read our
-- pipeline through an endpoint built for their floor numbers.

CREATE TABLE IF NOT EXISTS leads (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- An email is the only field that makes a lead a lead (the same rule
    -- decks.record_lead keeps). Everything else is context.
    email         text NOT NULL,
    name          text,
    company       text,
    title         text,
    store_count   integer,
    pos           text,
    -- Which door produced them. Text with a check rather than an enum for the
    -- same reason `deck_links.deck` is: a new channel should be a new value,
    -- not a migration.
    source        text NOT NULL DEFAULT 'other'
                  CHECK (source IN ('site', 'outbound', 'ads', 'referral',
                                    'event', 'deck', 'other')),
    -- The UTM set as it arrived, verbatim. One jsonb column rather than five
    -- text columns because ad platforms invent parameters faster than schemas
    -- change, and the Sources panel reads keys out of it rather than joining.
    utm           jsonb,
    stage         text NOT NULL DEFAULT 'new'
                  CHECK (stage IN ('new', 'contacted', 'replied', 'demo',
                                   'pilot_scoped', 'pilot_live', 'won',
                                   'lost', 'nurture')),
    owner         uuid REFERENCES users(id) ON DELETE SET NULL,
    notes         text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    -- Stamped by the retention sweep when the personal columns are cleared —
    -- "redacted" and "never had one" stay distinguishable, as everywhere else.
    redacted_at   timestamptz
);

-- One row per email while it is live. The site form retries, browsers double
-- submit, and the same merchant filling the form twice is one lead with a
-- fresher timestamp — not two rows for the first salesperson to reconcile.
CREATE UNIQUE INDEX IF NOT EXISTS leads_live_email_idx
    ON leads (lower(email)) WHERE redacted_at IS NULL;
CREATE INDEX IF NOT EXISTS leads_stage_idx  ON leads (stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS leads_recent_idx ON leads (created_at DESC);
-- The sweep's own read: rows old enough to redact that still hold a person.
CREATE INDEX IF NOT EXISTS leads_sweep_idx  ON leads (created_at)
    WHERE redacted_at IS NULL;

-- What actually happened, one row per touch. A log, deliberately not an
-- automation engine: at founder-led volume the record of what was sent and
-- what came back is the asset, and a sequencer can be built on top of a log
-- far more easily than a log can be recovered from a sequencer.
CREATE TABLE IF NOT EXISTS lead_activities (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id       uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    kind          text NOT NULL
                  CHECK (kind IN ('email', 'linkedin', 'video', 'call',
                                  'meeting', 'note', 'stage')),
    -- 'out' is us reaching them, 'in' is them answering. Null for the kinds
    -- that have no direction (a note, a stage change).
    direction     text CHECK (direction IN ('out', 'in')),
    body          text,
    at            timestamptz NOT NULL DEFAULT now(),
    created_by    uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS lead_activities_lead_idx
    ON lead_activities (lead_id, at DESC);
