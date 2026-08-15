-- What was actually shown and said, not just that something was.
--
-- The spine recorded that an engagement happened, its outcome and its sale,
-- and that a voice query happened, its intent and its latency. A manager
-- reading that can tell you how much the floor used CueSea. They cannot tell you
-- what CueSea said, or whether it was any good — which is the question anyone
-- evaluating this will actually ask, and the question a pilot has to answer.
--
-- Three columns, all nullable, all additive. Nothing that reads the old shape
-- breaks.

-- The recommendations the glasses showed for this guest. Stored as sent:
-- sku, name, price, location, stock. A jsonb snapshot rather than a foreign
-- key into a products table we do not have — and rather than re-deriving it
-- later, which would be a different answer, because stock moves.
ALTER TABLE engagements
    ADD COLUMN IF NOT EXISTS recommendations jsonb NOT NULL DEFAULT '[]'::jsonb;

-- The three lines the associate actually read off the glass. The whole
-- product is one sentence at a time; if we never store the sentence we can
-- never review it, and "the cue was wrong" is not a debuggable report.
ALTER TABLE engagements
    ADD COLUMN IF NOT EXISTS cue_lines text[];

-- What CueSea answered out loud, beside what was asked.
--
-- Gated by exactly the same `privacy.store_transcripts` flag as the
-- transcript, and for the same reason: the answer quotes the customer's
-- record back — their size, their cart, what they bought last time. Storing
-- the question and discarding the answer would be a false economy, and
-- storing the answer while discarding the question would be worse.
ALTER TABLE voice_queries
    ADD COLUMN IF NOT EXISTS answer text;
