-- The phone as a first-class surface, and the line between a store handheld
-- and an employee's own phone.
--
-- 011 named three surfaces: even-g2, mrbd, sim. A phone is the fourth, and it
-- is the one that opens the market — a pilot that starts on devices already in
-- pockets needs no hardware requisition and no vendor lead time.
--
-- ── The distinction this migration is really about ─────────────────────────
--
-- A provision token is not a login. It *is* the store's identity on a device:
-- whoever holds it registers as this shop, sees its floor and hears its comms.
-- That is exactly right for a handheld the store owns and exactly wrong for a
-- handset that leaves with its owner.
--
-- So `phone` here means **a store-owned handheld**. An associate's own phone
-- is never a row in this table — it authenticates as a *person*, through the
-- ordinary session in `auth_tokens`, and revoking that person's access in
-- Console revokes it everywhere at once with no hardware to chase.
--
-- Enforced in three places rather than one, because it is the invariant the
-- whole surface was asked for:
--   · here, by there being no BYOD row to create;
--   · in packages/server, which refuses a socket presenting both a provision
--     token and a personal session;
--   · in packages/pocket, whose boot decision will not store a store token on
--     a phone that has already decided it is somebody's own.

-- Postgres will not let a CHECK constraint be amended in place, and the
-- constraint from 011 is unnamed unless it was created inline (it was:
-- `surface text NOT NULL DEFAULT 'even-g2' CHECK (...)` produces
-- devices_surface_check). Dropped by that name, IF EXISTS so a database that
-- reached this state another way still migrates.
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_surface_check;

ALTER TABLE devices
    ADD CONSTRAINT devices_surface_check
    CHECK (surface IN ('even-g2', 'mrbd', 'sim', 'phone'));

-- Which handset this is, for the fleet list. A store with forty handhelds
-- needs to tell them apart by something an admin can read off the back of the
-- device, and `label` is already carrying the human name ("Till 2", "Sam's
-- loaner"). Free text on purpose: iOS version strings, Zebra model numbers and
-- whatever a retailer's asset tag looks like do not share a vocabulary.
ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS platform text;

-- A handheld that has been signed into by an associate has a person attached
-- for the length of that shift, which is different from `user_id` — that one
-- is the device's *assignment*, decided by an admin and durable across shifts.
-- Nullable, and cleared on sign-out, so "who is holding this right now" and
-- "whose device is this" stay separate questions.
ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS held_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS devices_held_by_idx ON devices (held_by) WHERE held_by IS NOT NULL;
