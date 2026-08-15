-- What the guest actually wants.
--
-- Presence answers "someone is in fitting room three". This answers the
-- question that follows it, which is the one the job is really made of: *what
-- do they need brought to them.* An associate who knows a guest is in a room
-- still has to walk over and ask; an associate who knows they want a 32 in the
-- barrel jean can arrive holding one.
--
-- The guest writes this themselves, on their own phone, having deliberately
-- checked in — so it is opt-in twice over, and it is the first thing in this
-- system that a customer authors rather than has inferred about them. That is
-- worth protecting accordingly, and it is why `note` is treated like a voice
-- transcript rather than like an analytics field.
--
-- What retention keeps and what it drops, and why the split is here
-- ----------------------------------------------------------------
-- Dropped with the rest of the personal data: `guest_ref`, the pointer to a
-- person, and `note`, which is free text a customer typed and could contain
-- anything.
--
-- Kept: `sku`, `size`, `need`, `zone`, the timestamps and the outcome. "Which
-- sizes do people ask for in fitting rooms, and how long do they wait" is a
-- question about a shop, not about a shopper, and a retailer who turns on a
-- 30-day window should not lose it. Same line the engagement sweep draws
-- between `intent` and `transcript`.

CREATE TABLE IF NOT EXISTS guest_requests (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- The CRM's id, exactly as everywhere else: a pointer, never a name.
    guest_ref   text NOT NULL,
    -- Where to bring it. Comes from the plate, so it is as reliable as the
    -- plate is — which is the point of printing the zone on the plate.
    zone        text,
    -- How they asked: 'web' (our page) or 'app' (the retailer's own app,
    -- posting on the guest's behalf). Not the same field as the presence
    -- source, because a guest can tap a plate and then ask in the app.
    surface     text NOT NULL DEFAULT 'web',

    -- What they want. `sku` and `product` are both stored: the sku is what we
    -- act on, the product name is what the guest was actually looking at when
    -- they asked. Stock moves and catalogues get re-indexed, and "what did we
    -- show them" must survive both — the same reason engagements store the cue
    -- lines as sent rather than re-deriving them.
    sku         text,
    product     text,
    size        text,
    -- The shape of the ask, from a fixed vocabulary. Free text is optional;
    -- this never is, so there is always something actionable on the glass even
    -- when somebody types nothing.
    need        text NOT NULL DEFAULT 'other',
    -- The guest's own words. Redacted by the retention sweep.
    note        text,

    status      text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'claimed', 'done', 'cancelled')),
    -- Who picked it up. NULL while open, and NULL forever if it lapsed.
    claimed_by  uuid REFERENCES users(id) ON DELETE SET NULL,

    created_at  timestamptz NOT NULL DEFAULT now(),
    claimed_at  timestamptz,
    resolved_at timestamptz
);

-- The floor query: what is open, in this zone, oldest first. A guest waiting
-- in a fitting room is the most time-sensitive row in the system.
CREATE INDEX IF NOT EXISTS requests_open_idx
    ON guest_requests (tenant_id, status, created_at)
    WHERE status IN ('open', 'claimed');

CREATE INDEX IF NOT EXISTS requests_guest_idx
    ON guest_requests (tenant_id, guest_ref, created_at DESC);

-- Every sweep leaves a receipt, and a receipt that omits a class of data it
-- redacted is worse than no receipt: it reads as evidence that nothing was
-- there. Default 0 so existing rows stay honest about a column that did not
-- exist when they were written.
ALTER TABLE retention_runs
    ADD COLUMN IF NOT EXISTS requests_redacted integer NOT NULL DEFAULT 0;
