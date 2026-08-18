-- A gated deck open is a kind of touch.
--
-- Why this is its own migration
-- -----------------------------
-- 015 shipped the `lead_activities` CHECK with six kinds and no 'deck'. It is
-- already applied in production, so the constraint is altered here rather than
-- edited there — a migration that has run is a historical fact, and rewriting
-- one only changes what a fresh database gets, which is the definition of two
-- environments drifting.
--
-- What it unblocks
-- ----------------
-- `decks.record_lead` now mirrors a gated open into the pipeline
-- (`growth.record_deck_open`). Without this the INSERT violates the check, and
-- because that mirror is deliberately wrapped in a try/except — a merchant
-- must never meet a failed form because our CRM was unhappy — the failure is
-- *silent*: the lead appears with an empty touch log and nothing says why.
--
-- 'deck' carries no direction. It is plainly something they did, but it is not
-- a reply, and `last_reply` is what the Leads panel flames on. An open that
-- counted as a reply would flame every opener and spend, within a week, the
-- one colour reserved for "a warm merchant is waiting on you in the inbox".

ALTER TABLE lead_activities DROP CONSTRAINT IF EXISTS lead_activities_kind_check;

ALTER TABLE lead_activities ADD CONSTRAINT lead_activities_kind_check
    CHECK (kind IN ('email', 'linkedin', 'video', 'call',
                    'meeting', 'note', 'stage', 'deck'));
