-- Cue control plane — tenants, people, devices, and the events worth keeping.
--
-- Design notes that matter more than the columns:
--
-- * Guests are referenced by their CRM id (`guest_ref`), never copied here.
--   Cue is not a second home for a retailer's customer database, and an
--   opt-in-only product should not accumulate profiles as a side effect.
-- * Transcripts are opt-in per tenant (see tenants.privacy) and default OFF.
--   The intent and outcome of a voice query are what the analytics need; the
--   words the associate said near a customer are not.
-- * Every tenant-scoped table carries tenant_id directly rather than relying
--   on a join to enforce isolation. One WHERE clause, hard to get wrong.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- --- tenants -----------------------------------------------------------------

CREATE TABLE tenants (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug          text NOT NULL UNIQUE,          -- 'gap', 'shopify', matches the plugin launch URL
    name          text NOT NULL,
    crm_provider  text NOT NULL DEFAULT 'mock',  -- mock | shopify | (enterprise adapters later)
    status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'suspended', 'archived')),
    billing_plan  text NOT NULL DEFAULT 'pilot',
    config        jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Privacy posture is a first-class tenant property, not a config afterthought.
    privacy       jsonb NOT NULL DEFAULT
                  '{"store_transcripts": false, "retention_days": 90,
                    "opt_in_tiers": ["qr_checkin"]}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- --- people ------------------------------------------------------------------
--
-- tenant_id IS NULL means Cue/Future Basics staff, who are not part of any
-- retailer. Enforced rather than conventional: a cue_admin must not belong to
-- a tenant, and everyone else must.

CREATE TABLE users (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid REFERENCES tenants(id) ON DELETE CASCADE,
    email          text NOT NULL,
    name           text NOT NULL,
    role           text NOT NULL
                   CHECK (role IN ('associate', 'manager', 'client_admin', 'cue_admin')),
    password_hash  text,
    status         text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'disabled')),
    created_at     timestamptz NOT NULL DEFAULT now(),
    last_login_at  timestamptz,
    CONSTRAINT cue_staff_have_no_tenant CHECK (
        (role = 'cue_admin' AND tenant_id IS NULL)
        OR (role <> 'cue_admin' AND tenant_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));
CREATE INDEX users_tenant_idx ON users (tenant_id) WHERE tenant_id IS NOT NULL;

-- Opaque bearer tokens, stored hashed. A leaked database backup should not
-- hand over live sessions.
CREATE TABLE auth_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  text NOT NULL UNIQUE,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    revoked_at  timestamptz
);

CREATE INDEX auth_tokens_user_idx ON auth_tokens (user_id);

-- --- devices -----------------------------------------------------------------

CREATE TABLE devices (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
    model         text NOT NULL CHECK (model IN ('g2', 'g1', 'ring1')),
    serial        text NOT NULL,
    label         text,
    status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'retired', 'lost')),
    assigned_at   timestamptz,
    last_seen_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, serial)
);

CREATE INDEX devices_tenant_idx ON devices (tenant_id);

-- --- engagements -------------------------------------------------------------
--
-- One guest interaction. `guest_ref` is the CRM's id for an opted-in guest —
-- a pointer, not a copy.

CREATE TABLE engagements (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    associate_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    guest_ref          text,
    zone               text,
    started_at         timestamptz NOT NULL DEFAULT now(),
    ended_at           timestamptz,
    outcome            text CHECK (outcome IN ('sale', 'no_sale', 'handoff', 'abandoned')),
    sale_cents         integer NOT NULL DEFAULT 0
);

CREATE INDEX engagements_tenant_started_idx ON engagements (tenant_id, started_at DESC);
CREATE INDEX engagements_associate_idx ON engagements (associate_user_id, started_at DESC);

-- Credit for helping someone else's guest. Recorded separately from sales so
-- a leaderboard can reward the behaviour that a sales-only ranking punishes.
CREATE TABLE assists (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    engagement_id   uuid REFERENCES engagements(id) ON DELETE CASCADE,
    helper_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note            text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX assists_tenant_idx ON assists (tenant_id, created_at DESC);
CREATE INDEX assists_helper_idx ON assists (helper_user_id);

-- --- voice queries -----------------------------------------------------------
--
-- `transcript` stays NULL unless the tenant has opted in to storing it. The
-- rest is what analytics actually need: did it work, how fast, what kind of
-- question, what did it cost.

CREATE TABLE voice_queries (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    engagement_id  uuid REFERENCES engagements(id) ON DELETE SET NULL,
    user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
    intent         text,
    ok             boolean NOT NULL DEFAULT true,
    resolved_by    text,
    latency_ms     integer,
    audio_seconds  numeric(6, 2),
    stt_provider   text,
    transcript     text,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX voice_queries_tenant_created_idx ON voice_queries (tenant_id, created_at DESC);
CREATE INDEX voice_queries_user_idx ON voice_queries (user_id, created_at DESC);

-- --- usage rollup ------------------------------------------------------------
--
-- Billing reads this, not the event tables. Incremented on write so a month's
-- invoice never depends on scanning every voice query ever recorded.

CREATE TABLE usage_daily (
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    day           date NOT NULL,
    engagements   integer NOT NULL DEFAULT 0,
    voice_queries integer NOT NULL DEFAULT 0,
    stt_seconds   numeric(10, 2) NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, day)
);
