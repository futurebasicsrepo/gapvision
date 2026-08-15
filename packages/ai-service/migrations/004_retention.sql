-- Retention, enforced.
--
-- `tenants.privacy.retention_days` has been stored since the spine landed and
-- nothing has ever deleted on it. The published privacy policy admits that in
-- writing, which is honest and is also the single worst sentence in it: a
-- promise the code does not keep is worse than no promise, and it is the one
-- item on the open list with actual legal exposure.
--
-- This table is not the enforcement — `app/retention.py` is. This is the
-- receipt. A retention policy nobody can prove ran is a policy in the same
-- sense that an untested backup is a backup.

CREATE TABLE IF NOT EXISTS retention_runs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    ran_at          timestamptz NOT NULL DEFAULT now(),
    retention_days  int NOT NULL,
    -- Counts per class, so "what did retention actually do last night" has an
    -- answer that is not "read the logs".
    voice_redacted        int NOT NULL DEFAULT 0,
    engagements_redacted  int NOT NULL DEFAULT 0,
    assists_redacted      int NOT NULL DEFAULT 0,
    -- Set when a sweep stops early on its batch cap, so a tenant quietly
    -- accumulating more than one sweep can clear is visible rather than
    -- looking like a clean run.
    more_remaining  boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS retention_runs_tenant_idx
    ON retention_runs (tenant_id, ran_at DESC);

-- The sweep finds rows by age, so give it an index to find them with. Without
-- these, retention on a busy tenant is a sequential scan of every engagement
-- and voice query the system has ever recorded, run every few hours.
CREATE INDEX IF NOT EXISTS voice_queries_created_idx
    ON voice_queries (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS engagements_started_idx
    ON engagements (tenant_id, started_at);
CREATE INDEX IF NOT EXISTS assists_created_idx
    ON assists (tenant_id, created_at);
