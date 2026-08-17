# @cue/pocket

The associate's phone. An installable PWA that runs the same card deck as the
glasses, driven by a thumb.

```
src/identity.ts   which kind of phone this is, and what it may hold
src/store.ts      a whitelist of what may be written to disk
src/queue.ts      work taken on a dead network, and its ordering
src/touch.ts      a thumb → the six gestures every lens already speaks
src/platform.ts   what this particular handset can actually do
src/install.ts    add-to-home-screen, which is not decoration (see below)
src/wake.ts       the screen stays on while a guest is standing there
src/session.ts    signing in as a person
src/main.ts       wiring, and nothing with a consequence in it
public/sw.js      offline shell, and the push handlers (dormant — see below)
```

## Run it

```bash
npm run dev --workspace=packages/pocket     # http://localhost:5192, and on your phone
npm test --workspace=packages/pocket        # 42 unit tests, plain node
npm run build --workspace=packages/pocket
node packages/pocket/test/pocket-browser.mjs  # 25, against vite preview
```

`vite` is configured with `host: true`, so a phone on the same wifi can open
the dev server directly — which is the only way to feel the gestures.

Needs the realtime server (`npm run dev:server`) and the AI service
(`npm run dev:ai`). **One** base URL, `VITE_SERVER_URL` — everything, sign-in
included, goes through the realtime server, which proxies `/auth` upstream and
attaches the service key. A static client cannot hold that key, which is why
Console and Studio work the same way.

## The rule this package was asked for

**The store must not walk out on an employee's personal phone.**

Two kinds of phone, and they are not the same kind of thing:

| | Store handheld | Somebody's own phone |
|---|---|---|
| Provisioned by | an admin, scanning a QR from Console | signing in with their own account |
| Holds | a provision token — the store's identity | a session that belongs to *them* |
| Revoked by | revoking the device in Console | disabling the person in Console |
| Ends on its own | no | yes, at `CUE_SESSION_HOURS` — about a shift |
| Signing out | ends the person's session, device stays set up | **erases the phone** |
| In the fleet list | yes | **never** — there is no row to create |

The forbidden combination is *personal + provision token*, and it is refused in
three independent places, because a rule kept in one place is a rule kept by
whoever last edited that file:

1. **`identity.ts`** — `decideBoot` is a pure function with its own suite. Mode
   is decided at first boot and is sticky. A provisioning link arriving at a
   phone that already decided it is somebody's own is refused *and named as
   refused*, so the app can explain rather than appear to ignore the tap.
2. **`packages/server`** — a socket presenting both a provision token and a
   personal session is refused outright, with its own reason
   (`conflicting_identity`) so the phone can say which rule it broke.
3. **`/api/auth/associate`** — resolves a person and returns no device id. It
   creates nothing; `test_phone.py` asserts the `devices` table row count is
   unchanged, because the response-shape test alone would still pass if the
   route wrote a row and declined to mention it.

### The subtlety worth knowing about

**Erasing a personal phone leaves it erased and still personal.** `mode`
survives the wipe on purpose. A wiped phone with no stored mode is
indistinguishable from a brand-new one, so the next provisioning link tapped on
it would be honoured — the handset becomes the store, through the front door of
the feature meant to make it safe. Found by writing the browser test, not by
design.

## Guests never touch disk

`store.ts` takes a **whitelist**, not a blacklist. Every key that may be
persisted is declared with a reason; anything else is refused, logged, and
dropped rather than thrown — a caching mistake must not end an engagement.

Guests live in `ephemeral`, which is a `Map`. Closing the app is the same event
as forgetting.

The queue is the one thing derived from a live engagement that *is* written
down, so `shape()` strips every action to its declared keys. "Claim request
41f3" persists; "Claim Sarah Chen at the denim wall" cannot, whatever object a
future caller passes in.

## Cross-platform, and what that costs

Four devices are in scope: an associate's iPhone, an associate's mid-range
Android, a store iPad at the till, and a Zebra or Honeywell handheld running a
Chromium build IT will not update this year.

**Nothing in the critical path depends on a capability that is not universal.**
Cards, gestures, claiming and messaging use Pointer Events, `fetch` and a
WebSocket. Everything else is detected, and its absence is stated in words an
associate can act on rather than discovered as a dead button — see
`platform.gaps()`, which is rendered in Settings.

`platform.ts` detects features, never user agents, with one deliberate
exception: `isIOS`. iOS fires no `beforeinstallprompt`, so "can this device
install?" is not answerable by feature detection, and coaching somebody through
Share → Add to Home Screen requires knowing they are on iOS. It changes a
string, not a behaviour.

## Install is a feature, not polish

On iOS, **Web Push is delivered only to a PWA on the home screen.** Not "works
better installed" — does not exist otherwise. Since a request arriving on the
lock screen is the entire product claim on a phone, installing *is* the
feature, and the coaching in `install.ts` is load-bearing.

## Push: receiving half shipped, asking half deliberately not

`sw.js` carries complete `push` and `notificationclick` handlers, including
claim-from-the-notification. **No code in the app requests notification
permission.**

That is on purpose. A browser grants that prompt once; a "Not now" is
effectively permanent on iOS and poisons the origin for a long time on Android.
Asking before the server can deliver a push would burn the single most valuable
prompt this product gets, on a feature that does nothing yet. The asking
happens on the day the sending works — VAPID keys, a subscription store, and
the send are the next milestone.

## Deploying

Its own origin, `pocket.cuesea.ai` — not a path under Console. Pocket installs
a service worker and a home-screen icon onto a device that leaves the building,
and giving it the staff origin would be a same-origin foothold on the admin
surface for the sake of one DNS record. `devices.launch_url()` reads
`CUE_POCKET_URL`.

HTTPS is not optional: service workers, wake lock and push all require a secure
context. `localhost` is exempt, which is why the dev server works.

## Icons

```bash
npm run icons --workspace=packages/pocket
```

Same construction as the Even Hub store icons, in colour. Three outputs and the
third is the one people forget: a maskable icon (Android crops to the
launcher's mask and eats the arc without one) and an `apple-touch-icon` (iOS
reads none of the manifest, and without the PNG "Add to Home Screen" produces a
screenshot of the page).
