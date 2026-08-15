-- Setting a password without a human handing you one.
--
-- Until now an account created without a password existed but could not sign
-- in, and the only way to give someone access was a staff member typing a
-- password and telling them what it was — over Slack, or out loud. That is
-- worse than no invite flow: it trains people to accept credentials through
-- channels that should never carry them.
--
-- One table serves both invites and resets, because they are the same
-- primitive with different copy: a single-use, expiring proof that whoever
-- holds it controls that mailbox. Splitting them would mean two token
-- lifecycles to get right instead of one.

CREATE TABLE IF NOT EXISTS password_resets (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- SHA-256 of the token, never the token. Same rule as auth_tokens: a
    -- database dump must not hand somebody a working link to every account.
    token_hash  text NOT NULL UNIQUE,
    -- 'invite' or 'reset'. Only changes the email copy and the lifetime, but
    -- it is worth being able to answer "was this account ever invited".
    kind        text NOT NULL DEFAULT 'reset'
                CHECK (kind IN ('invite', 'reset')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    -- Single use. Set on redemption rather than deleting the row, so a second
    -- click on the same link can say "already used" instead of "invalid",
    -- which is the difference between a confusing error and an honest one.
    used_at     timestamptz
);

CREATE INDEX IF NOT EXISTS password_resets_user_idx
    ON password_resets (user_id, created_at DESC);
