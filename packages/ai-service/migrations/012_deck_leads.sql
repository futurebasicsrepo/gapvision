-- Who we sent a deck to, and who opened one.
--
-- The gap this closes
-- -------------------
-- Deck links lived in one browser's localStorage and gated opens landed in a
-- Vercel runtime log. Neither survives a laptop, and nothing joined an open to
-- the tenant that later signed. "Who did we talk to in July" had no answer —
-- recorded as a learning on the day it was noticed, and this is the fix.
--
-- Not tenant data
-- ---------------
-- Everything else in this schema belongs to a retailer and is scoped by
-- `tenant_id`. These two tables are **ours**: prospects, investors, the people
-- we are selling to. They deliberately carry no tenant column, because there is
-- no tenant they belong to and inventing one would put our fundraise pipeline
-- inside a customer's scope.
--
-- The consequence is a boundary that has to be enforced in the routes rather
-- than by a WHERE clause: these are `cue_admin` only. A retailer's manager
-- reading `/api/analytics/*` must never reach them, which is why they are not
-- simply hung off the existing manager-and-up analytics routes.

CREATE TABLE IF NOT EXISTS deck_links (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- 'floor' or 'fundraise'. Text with a check rather than an enum: a third
    -- deck is a third folder on the site, and it should not need a migration.
    deck          text NOT NULL CHECK (deck IN ('floor', 'fundraise')),
    -- The `?t=` on the link. Not a credential — it identifies a send, it does
    -- not authorise anything, and the deck opens with or without it.
    token         text NOT NULL UNIQUE,
    prepared_for  text,
    gated         boolean NOT NULL DEFAULT true,
    -- Who built it. Nullable because a link minted before this table existed
    -- has no author to name, and guessing is worse than a blank.
    created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deck_links_recent_idx ON deck_links (deck, created_at DESC);

CREATE TABLE IF NOT EXISTS deck_leads (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    deck          text CHECK (deck IN ('floor', 'fundraise')),
    -- A person typed these to read a document. That makes this table the most
    -- personal data we hold about anybody who is not a customer, and the
    -- retention sweep below treats it that way.
    name          text,
    email         text,
    firm          text,
    prepared_for  text,
    -- The link they came through, when there was one. Not a foreign key to
    -- `deck_links`: a lead is a fact that happened, and it must not fail to
    -- record because somebody cleared a link row.
    token         text,
    ref           text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    -- Stamped by the retention sweep when the personal columns are cleared, so
    -- "redacted" and "never had one" stay distinguishable — the same reason
    -- every other redaction in this schema is a nulled column beside a kept
    -- shape rather than a deleted row.
    redacted_at   timestamptz
);

CREATE INDEX IF NOT EXISTS deck_leads_recent_idx ON deck_leads (deck, created_at DESC);
-- The sweep's own read: rows old enough to redact that still hold a person.
CREATE INDEX IF NOT EXISTS deck_leads_sweep_idx ON deck_leads (created_at)
    WHERE redacted_at IS NULL;
