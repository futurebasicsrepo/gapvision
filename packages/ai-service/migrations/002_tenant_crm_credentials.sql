-- Per-tenant CRM credentials — one CueSea deployment, many merchants' stores.
--
-- Until this migration, SHOPIFY_STORE_DOMAIN and the Admin token were
-- process-wide environment variables. That is fine for one pilot store and
-- fatal for the go-to-market, which is "any Shopify POS retailer": a single
-- deployment could only ever talk to one store, and a second merchant meant a
-- second deployment.
--
-- Two decisions worth defending:
--
-- * **Its own table, not a column on `tenants`.** `routes_admin` returns
--   `SELECT *` / `RETURNING *` from `tenants` to any client_admin. A secret
--   column there is one forgotten projection away from being served over HTTP.
--   A separate table cannot leak through a query nobody remembered to narrow.
--   It also keeps `tenants` cheap to read on the hot path.
--
-- * **Ciphertext only.** `secret_sealed` is AES-256-GCM sealed by the service
--   (app/secrets_box.py); the key lives in CUE_CRED_KEY and never reaches
--   Postgres. A dump, a replica, or a read-only injection yields nothing
--   usable. `key_id` names the key that sealed each row so a rotation can be
--   audited without comparing key material.
--
-- The plaintext token is never returned by any API. `fingerprint` — last four
-- characters plus a short salted hash — is what the console renders, which is
-- enough for an operator to confirm *which* token is installed and useless to
-- anyone who steals it.

CREATE TABLE tenant_crm_credentials (
    tenant_id        uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    provider         text NOT NULL DEFAULT 'shopify',

    -- e.g. 'future-basics.myshopify.com'. Not a secret, and worth being able
    -- to read at a glance when two merchants are confused for each other.
    store_domain     text NOT NULL,

    -- admin_token        legacy custom apps: a static shpat_… token
    -- client_credentials Dev Dashboard apps (2026+): id + secret, 24h tokens
    auth_kind        text NOT NULL
                     CHECK (auth_kind IN ('admin_token', 'client_credentials')),

    secret_sealed    bytea NOT NULL,   -- nonce || AES-256-GCM ciphertext
    key_id           text NOT NULL,    -- which CUE_CRED_KEY sealed it
    fingerprint      text NOT NULL,    -- safe to display, useless to steal

    -- Result of the last Test connection. Stored so the console can show state
    -- without hitting Shopify on every page load, and so a credential that
    -- quietly stopped working is visible before a merchant reports it.
    scopes           text[] NOT NULL DEFAULT '{}',
    last_tested_at   timestamptz,
    last_test_ok     boolean,
    last_test_detail text,

    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    created_by       uuid REFERENCES users(id) ON DELETE SET NULL
);

-- Rotation audit: "which tenants are still sealed with the retired key?"
CREATE INDEX tenant_crm_credentials_key_idx ON tenant_crm_credentials (key_id);
