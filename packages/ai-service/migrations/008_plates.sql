-- Plates, as objects the system knows about.
--
-- Until now a plate's URL carried its meaning in plain text —
-- `?t=gap&z=fitting-room-3&src=nfc-plate`. Readable, hand-editable, and the
-- same for the life of the plate. Kyle: the URL should be encrypted so it
-- cannot be shared.
--
-- What a token can and cannot do, stated here because the difference decides
-- how much to trust it
-- --------------------------------------------------------------------------
-- An opaque token *does* stop three things that were real:
--
--   * reading a photograph of a plate and learning the store's zone naming;
--   * editing the URL to check in to a different room, or to a different
--     tenant, without leaving the car park;
--   * a plate outliving its usefulness. A token can be revoked, and one plate
--     costs eleven dollars to reprint. That is the part I argued against when
--     the plates shipped this morning — I said a plate id would only add a key
--     to manage. It adds revocation, and revocation is worth the row.
--
-- It does **not** make a printed code unshareable. Anything printed can be
-- photographed, and the photograph carries the token. What actually kills
-- sharing on the tap door is a tag that emits a *different* URL every tap —
-- NTAG 424 DNA and friends, which append a counter and a CMAC. Those columns
-- are here, and `plates.py` verifies them; the QR on the same plate stays
-- copyable by physics, and the honest mitigations for it are revocation, a
-- short presence TTL, and noticing.
--
-- One token per door, not one per plate
-- --------------------------------------
-- The tap and the scan get different tokens. It keeps `src` out of the URL
-- entirely — a guest cannot claim to have tapped when they scanned — and it
-- means a QR that ends up on the internet can be killed without disabling the
-- tag six inches above it.

CREATE TABLE IF NOT EXISTS plates (
    -- The token, as printed. Random, not derived: a derived id leaks whatever
    -- it was derived from the moment somebody notices the pattern.
    token       text PRIMARY KEY,
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    zone        text,
    -- Which door this token is. Fixed at mint, never taken from a request.
    source      text NOT NULL,
    -- What a human calls it, for the Console and the installation sheet.
    label       text,

    -- --- rotating-cryptogram tags (NTAG 424 DNA and equivalents) ------------
    -- The tag's own AES key, sealed like every other secret we hold. NULL for
    -- an ordinary tag or for a printed QR.
    sun_key     text,
    -- When true, a tap without a valid, fresh cryptogram is refused. Off by
    -- default: turning it on for a plate whose tag cannot produce one would
    -- silently disable that door.
    sun_required boolean NOT NULL DEFAULT false,
    -- The highest tap counter seen. A replayed URL carries a counter we have
    -- already used, which is exactly what a shared link is.
    last_counter bigint,

    created_at  timestamptz NOT NULL DEFAULT now(),
    -- Set when a plate is retired or a token leaks. Kept rather than deleted:
    -- "when did we kill it, and did anything try afterwards" is worth having.
    revoked_at  timestamptz
);

CREATE INDEX IF NOT EXISTS plates_tenant_idx ON plates (tenant_id, created_at);

-- Every resolution attempt, so a leaked token is visible as a shape rather
-- than as a surprise. Deliberately not a log of people: no guest reference, no
-- address, no agent — just which plate, when, and whether it worked.
CREATE TABLE IF NOT EXISTS plate_hits (
    id         bigserial PRIMARY KEY,
    token      text NOT NULL,
    ok         boolean NOT NULL,
    reason     text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plate_hits_idx ON plate_hits (token, created_at DESC);
