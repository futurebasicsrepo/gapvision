-- Front doors.
--
-- A guest can tell us they are here in a lot of ways: a tag on an acrylic
-- plate, the QR beside it, the retailer's own app, a wallet pass, arriving to
-- collect an order, or an associate asking and the guest agreeing. Kyle's
-- position, and the right one: a business should feel like it has options.
--
-- They are all the same event. What differs is *how much that event proves*,
-- and that is the thing worth storing.
--
--   source   which door. Also the only honest way to answer "which doors do
--            customers actually use", which decides where the next hundred
--            plates go.
--   consent  what kind of agreement stands behind it. A guest tapping a plate
--            with their own phone and an associate saying "mind if I look you
--            up?" are both presence, and they are not the same evidence. When
--            privacy review asks how a session was authorised, the answer has
--            to be a column and not a recollection.
--
-- Deliberately not modelled: any path, dwell time or movement between zones.
-- Presence is a moment at a place, and a table that can reconstruct a walk
-- through a shop is a different product with a different consent story.

CREATE TABLE IF NOT EXISTS presence_events (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- The CRM's id, same as engagements.guest_ref. Never a name, never an
    -- email — this table holds a pointer, like everything else here.
    guest_ref   text NOT NULL,
    zone        text,
    source      text NOT NULL,
    consent     text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    -- Presence is a moment, not a state. Everything expires; `exit` and
    -- revocation are best-effort and this is the backstop that means a guest
    -- who walks out without telling anyone stops being present anyway.
    expires_at  timestamptz NOT NULL,
    -- Set when a guest withdraws mid-visit. Kept rather than deleted so
    -- "did they revoke, and when" is answerable.
    revoked_at  timestamptz
);

CREATE INDEX IF NOT EXISTS presence_live_idx
    ON presence_events (tenant_id, guest_ref, expires_at DESC);
CREATE INDEX IF NOT EXISTS presence_created_idx
    ON presence_events (tenant_id, created_at);
