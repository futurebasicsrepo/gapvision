# Direct messages on the floor — design for the next build

Written 16 Aug 2026 from Kyle's direction: *"users should be able to engage
over one channel; in-app users should be able to send direct to a peer's lens
through a type function."* Extends `claude/floor-comms.md`; nothing there is
discarded.

## The shape: one channel, with addressing

Not a DM system beside the radio — the same FLOOR stream, where a message may
carry an address. A broadcast is the current behaviour; an addressed message
reaches one associate's lens and nobody else's. That keeps the mental model
("the floor is one channel you're always on") and the interrupt rules
(urgent takes the frame, everything else queues behind the unread count)
identical for both.

## Server (packages/server)

- `radio:send` gains optional `to` (the target's registered associate id —
  the roster the server already builds from `register`). With `to`: deliver
  to that socket + echo to sender; without: broadcast as today. Tenant-scoped
  either way — a DM can never cross stores.
- New `roster:list` (or ride the existing registration state): active
  associates for the tenant — name, zone, id — so the phone can offer real
  people, not typed handles.
- Nothing stored. Same as the radio today: messages are live traffic, not a
  chat history. (If retention is ever wanted it goes behind the tenant
  privacy board like everything else.)

## Phone page (glasses-plugin)

- A "Floor" card: the roster as rows (name · zone, live), a text field, send.
  Tap a person first → the send is addressed; no selection → broadcast.
  Uppercase-on-glass handled by the existing `toDisplayText` path; the
  composer is free text ("the type function").
- Sent messages echo into the sender's own log line, not their lens.

## Lens (already mostly built)

- Arrives through the existing `radio:message` path: unread count in the
  header cluster, FLOOR card face shows the newest, floor menu lists it,
  reply = existing canned phrases (typed replies happen on the phone).
- A DM renders with the sender leading, same as radio — plus `→ YOU` in the
  meta so an addressed message is distinguishable from the room. Urgent DMs
  take the frame under the same rule as urgent broadcasts.
- `floorComms: off` still queues (never drops) — the setting governs
  interruption, not delivery, exactly as today.

## Open questions for Kyle before building

1. Who can DM whom — associates ↔ associates only, or managers from the
   Console dashboard too? (The Console already has the socket.)
2. Should a DM support the urgent tier, or is urgency reserved for the
   canned NEED BACKUP? (Recommend: reserved — if everything can be urgent,
   nothing is.)
3. Delivery receipt on the sender's phone ("seen on glass") — worth it, or
   surveillance-adjacent? (Recommend: show "delivered", never "read".)

## Calls on the open questions — Claude review, 16 Aug 2026

Grounded in the code as of `3c984c4`; reasoning below each call.

**1. Who can DM whom — managers yes, from Studio; never from Console.**
The surface in question is CueSea **Studio** (the retailer dashboard —
`Dashboard.jsx` registers `role: "dashboard"` and already mirrors
`radio:message`), not CueSea **Console**, which is the cross-tenant staff
surface. A store's floor channel must never be writable from a cross-tenant
surface, so Console is out on trust-shape grounds alone. Studio is in: the
manager watching the floor view is exactly the person with the overview to
direct one associate ("take fitting room 3"), the socket is already there,
and the roster is already in `dashboard:update`. Two conditions:

- The sender name must come from the authenticated Studio session, not the
  payload. `radio:send` today resolves the name from the roster because a
  name on someone's glass "is not a field to take on trust from a browser"
  — a dashboard socket has no roster entry, so without this it falls
  through to `from || "Unknown"`, which would extend the demo-harness hole
  to real managers. Resolve name from the manager's auth, or don't ship
  manager sends.
- Managers send at the normal tier only (see 2). The frame-takeover stays
  a peer distress signal, not a management channel.

Manager sends can land in a second pass without redesign — but write the
server contract now so sender-identity resolution is per-role and additive.

**2. Urgent tier — agreed, reserved for canned NEED BACKUP.**
The plugin already states the principle: *"Only the first is urgent. If
everything is urgent then nothing is"* (`main.ts`, the PHRASES table). Two
supporting facts: a typed message is by construction not time-critical —
the sender stood still and composed it, while the person who genuinely
needs help presses one canned phrase; and the server already clamps
unknown priorities to normal ("an unknown value must never be able to take
over someone's display"). So enforce it server-side: an addressed message
with `priority: "urgent"` is clamped to normal unless it is the canned
NEED BACKUP from an associate socket. Client UI simply doesn't offer it.

**3. Receipt — agreed: "delivered", never "read".**
There is no honest read signal to show — the lens queues messages behind
the unread count, so "seen" would either lie (rendered ≠ read) or require
an acknowledgement instrument, which is the surveillance-adjacent thing
this product keeps refusing to build. "Delivered" is cheap and honest: the
server knows whether the target socket was connected when it emitted. The
part of the receipt that actually matters is the *failure*: roster ids are
socket ids and churn on reconnect, so a send to a stale id must come back
to the sender's phone as "no longer on the floor" — visibly — rather than
dropping silently.

**4. One question the doc didn't ask: is a DM mirrored to Studio?**
`radio:send` today mirrors everything to the dashboard room, and for a
broadcast that's right — the floor channel is openly shared. An addressed
message that *feels* private but is silently mirrored to the manager is a
trap. Call: do **not** mirror DM bodies to Studio; count them in
`stats.radioMessages` only. If a retailer later wants ops visibility, it
goes behind the tenant privacy board like `store_transcripts`, stated, not
assumed. (A manager's own sent DMs echo back to them, as any sender's do.)

### Build notes for the next session

- Delivery: `to` is the target's roster id (socket id); validate it exists
  in `stateFor(t).associates` before emitting — that lookup *is* the
  tenant guard, since the roster is per-tenant state. Emit to the target
  socket + echo to sender; skip `associatesRoom` and (per call 4) the
  dashboard mirror.
- The phone needs the roster: associates never receive `dashboard:update`,
  so add `roster:list` (or broadcast a trimmed roster to the associates
  room on membership change) — name · zone · id only.
- Tests belong beside `tenant-isolation.mjs`: a DM cannot cross tenants, a
  stale `to` fails visibly to the sender, priority clamps to normal, the
  dashboard room does not receive DM bodies.

## Decisions — Kyle, 16 Aug 2026

All four questions ruled on. These supersede the calls above where they
differ; mostly they confirm them and widen the scope.

1. **Managers DM from Studio — confirmed. Never from Console.** And the
   access model around it is now in scope: **Studio access is a managed
   permission** — an admin in Console can add/remove which of a tenant's
   employees have Studio access (rides the existing Tenants → People
   management; the role ladder `associate < manager < client_admin <
   cue_admin` already exists). **Glasses auto-pair to their user** —
   today a device self-registers by serial and staff assign an owner by
   hand in Console; that assignment should happen automatically so a
   person's messages, attribution and DMs follow them onto whatever
   device they pick up.
2. **Urgent tier reserved for canned NEED BACKUP — agreed.** But the
   Studio composer must take **both talk-to-text and typed text**.
   Messaging is an adoption play: p2p chat has to happen easily and
   fluidly, so the input path gets dialled in — dictation and keyboard
   both first-class, not a cramped afterthought. (Dictation can ride the
   browser's own speech input; the existing Deepgram path is available if
   quality demands it.)
3. **Receipts: "delivered" only — final.**
4. **Mirroring: broadcasts stay mirrored in Studio** (current behaviour,
   correct — the floor channel is openly shared). **DM bodies are not
   mirrored; count them in `stats.radioMessages` only.** If a retailer
   later wants ops visibility it goes behind the tenant privacy board
   like `store_transcripts` — stated, not assumed.

## Status

Design decided 16 Aug 2026 (Kyle's rulings above) — not yet implemented. Next
session: server routing (+tests in packages/server/test), the phone Floor
card, `→ YOU` meta on the lens, browser test coverage. Estimated one
session alongside test updates.
