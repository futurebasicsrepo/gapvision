-- Devices get identities of their own, so a lens can prove which pair it is.
--
-- What changes and why
-- --------------------
-- `devices` was written against hardware you hold: a G2 with a serial on the
-- box, a ring you pair over BLE. Both assumptions break on the Meta Ray-Ban
-- Display, where the lens is a URL, nothing is installed, and the glasses
-- expose no serial to the page. Identity therefore has to be something we
-- **mint** rather than something we **read** — so the provision token becomes
-- the device identity, and the serial drops to optional metadata.
--
-- One mechanism then serves every surface: Console mints a device, the token
-- is shown once, it rides whatever medium that surface provisions with (QR,
-- launch URL), and it is presented at register.
--
-- Why `model` becomes nullable
-- ----------------------------
-- `model text NOT NULL CHECK (model IN ('g2','g1','ring1'))` refuses every new
-- surface: a Meta device is not a `g2`, and a Lens Sim is not hardware at all.
-- The options were to widen the CHECK with values that are not models, or to
-- let `surface` own the question and leave `model` for hardware that actually
-- has one. This takes the second: `model` keeps its CHECK (which passes on
-- NULL) and stays the answer to "which physical thing is this", while
-- `surface` answers "what renders the lens". Existing rows are untouched.
--
-- **Flagged, not settled**: this was my recommendation and it shipped without
-- a ruling. If `model` should instead stay NOT NULL with a widened vocabulary,
-- the change is one ALTER and a backfill, and it is easier now than after
-- Console starts writing rows.

-- --- the columns -------------------------------------------------------------

ALTER TABLE devices
    -- What renders the lens. Defaulted rather than backfilled: every row that
    -- exists today is Even hardware, rings included — a ring is an accessory
    -- of that surface, not a surface of its own, which is why there is no
    -- 'ring' value here. Revisit if a ring ever registers on its own.
    ADD COLUMN IF NOT EXISTS surface text NOT NULL DEFAULT 'even-g2'
        CHECK (surface IN ('even-g2', 'mrbd', 'sim')),
    -- SHA-256 of the provision token, never the token. Same rule, same recipe
    -- as `auth_tokens` and `password_resets`: a leaked backup must not hand
    -- over live devices. Globally unique, because the token is presented
    -- before we know which tenant is claiming it.
    ADD COLUMN IF NOT EXISTS provision_token_hash text UNIQUE,
    ADD COLUMN IF NOT EXISTS provisioned_at timestamptz,
    -- Set rather than deleted. A revoked token that keeps knocking is the one
    -- row in the fleet worth reading, and DELETE throws that away.
    ADD COLUMN IF NOT EXISTS revoked_at timestamptz,
    -- {mode, app_version, ua} as of the last register. Diagnostics, not
    -- identity: nothing here is ever trusted to decide what a device may do.
    ADD COLUMN IF NOT EXISTS last_seen_meta jsonb;

-- `last_seen_at` is deliberately absent from that list — 001 already created
-- it. The provisioning spec proposed adding it; running that ADD would abort
-- this migration and take every statement above it down with it.

-- Serial is what the box tells you, and two of the three surfaces have no box.
ALTER TABLE devices ALTER COLUMN serial DROP NOT NULL;

-- See the header. NULL passes the existing CHECK, so the constraint stays as
-- written and keeps guarding the rows that do carry a model.
ALTER TABLE devices ALTER COLUMN model DROP NOT NULL;

-- UNIQUE (tenant_id, serial) from 001 still stands and still means what it
-- meant. Postgres treats NULLs as distinct in a unique index, so any number of
-- serial-less Meta and sim devices coexist without a partial index.

-- The one read this table gains is "who is presenting this token", on a path
-- where the answer gates a register. It needs no index of its own: the UNIQUE
-- above is a btree, and a second partial index over the same column would be
-- write amplification bought with nothing.

-- --- attribution --------------------------------------------------------------
--
-- Which device an engagement came through. Nullable and backfilled never: every
-- engagement recorded before this column existed was attributed by user, and
-- inventing a device for it would be inventing data. Written by the realtime
-- server from the socket's registered device (step 2 of the spec's build
-- order); until that lands, every new row is NULL too, which is honest.
--
-- ON DELETE SET NULL, not CASCADE: retiring a pair of glasses must never
-- delete the day's sales.
ALTER TABLE engagements
    ADD COLUMN IF NOT EXISTS device_id uuid REFERENCES devices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS engagements_device_idx
    ON engagements (device_id) WHERE device_id IS NOT NULL;
