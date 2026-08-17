-- The deck becomes the associate's, and the first data-defined widget.
--
-- Two changes that look unrelated and are the same idea: what an associate
-- sees on the right-hand side of the glass should be *configuration* rather
-- than a build.
--
-- ── Per-person widget order ───────────────────────────────────────────────
--
-- The widget list has lived in the phone's localStorage since it shipped,
-- which is wrong for the reason the auto-pairing decision already assumed:
-- somebody picks up a different pair of glasses and inherits a stranger's
-- layout. `claude/lens-widgets-design.md` recommended "on the person, with
-- the phone's copy as the offline fallback" and this is that.
--
-- On `users` rather than in its own table because it is one small document
-- per person with no history worth keeping and no query that ever asks
-- "who has messaging third". A row nobody joins on is a column.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS widget_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ── Promotions, and why they are a table rather than code ────────────────
--
-- Kyle, 17 Aug 2026: not all associates need every widget, and new widgets
-- should plug in rather than force a rebuild each time.
--
-- That is only achievable for some widgets, and it is worth being exact
-- about which. A widget that *writes* (to-do completion) or reads a
-- privileged source (clock, behind shift_telemetry) needs code in the
-- package, and adding one means a new `.ehpk`, an Even Hub upload and a
-- version bump for every pair in the field.
--
-- A widget that is a **titled list of short lines with a validity window**
-- does not. That shape covers promotions, store announcements, shift notes
-- and whatever the "other useful information" slot turns out to be — so it
-- is built once, here, as data. PROMOS is the first instance rather than a
-- special case, which is what makes the plug-and-play claim true instead of
-- aspirational.
--
-- `source` records where the rows came from because the answer changes what
-- a stale one means: a hand-written promotion is somebody's decision, and a
-- feed-ingested one going quiet is an outage.
CREATE TABLE IF NOT EXISTS tenant_feeds (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Which data-defined widget this row feeds. Not a foreign key: the
    -- catalogue lives in code beside the renderer, and a text column here
    -- means a new feed-backed widget needs no migration at all — which is
    -- the entire point of the table.
    widget       text NOT NULL,
    title        text NOT NULL,
    -- The lines as they should appear on the glass. An array rather than a
    -- blob of prose: 576px of monochrome fits about 60 characters, and the
    -- decision about where a promotion breaks belongs to whoever wrote it,
    -- not to a wrapping algorithm run at the last millisecond.
    lines        jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- Validity. Both nullable: "runs until we say otherwise" is a real and
    -- common state, and an end date invented to satisfy a NOT NULL is a
    -- promotion that silently disappears on a date nobody chose.
    starts_at    timestamptz,
    ends_at      timestamptz,
    -- manual | url | pdf. Kyle's call was that the real source is a marketing
    -- asset — a PDF or a live feed — rather than hand-typed copy, so the
    -- column exists from the start even though only `manual` is wired today.
    source       text NOT NULL DEFAULT 'manual',
    source_ref   text,
    position     integer NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The only query this table serves: "what is live for this store's widget,
-- in order". Partial on the window so an archive of expired promotions never
-- slows the floor down.
CREATE INDEX IF NOT EXISTS tenant_feeds_live_idx
    ON tenant_feeds (tenant_id, widget, position);
