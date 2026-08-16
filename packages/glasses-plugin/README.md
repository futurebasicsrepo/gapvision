# @gapvision/glasses-plugin

The Even Hub plugin — GapVision's real glasses client. Runs as a web app
inside the Even App WebView on the associate's phone; the Even App relays the
UI to the G2 over BLE.

## How it works

- `src/bridge.ts` — acquires the native bridge via
  `waitForEvenAppBridge()` (SDK `@evenrealities/even_hub_sdk`). Outside the
  Even App it falls back to a **MockBridge** that paints the same container
  specs onto the page's virtual lens, so the full flow runs in any browser.
- `src/layout.ts` — maps the AI service's `glasses_lines` payload to Even Hub
  page containers (576×288, ≤8 text containers, one gesture receiver —
  all SDK rules enforced here).
- `src/main.ts` — socket.io client to the GapVision realtime server. Beacon →
  `glasses:display` → containers. Temple press ends a session; double-press
  is the reserved hook for voice inventory queries (mic via `audioControl`).
- `src/prefs.ts` — the associate's preferences (zone, floor messages, voice,
  points on the rail), stored through the SDK's `setLocalStorage` /
  `getLocalStorage`. Even gives a plugin no settings panel, so the phone page
  is the settings surface. Capability and preference are different things and
  that file is where the line is drawn: a preference whose tenant capability
  is false is not on the page at all.

The phone page leads with what an associate needs — the capture card, then
their settings. The developer console (status pills, virtual lens, beacon
roster, gesture simulator, event inspector, event log) is all still there,
collapsed behind the **Diagnostics** disclosure at the bottom.

## Run (dev, no hardware)

```bash
# from repo root — server + AI service must be running (see root README)
npm run dev --workspace=packages/glasses-plugin   # http://localhost:5180
```

Open **Diagnostics** and tap a beacon button: the virtual lens renders exactly
what the G2 would show.

## Run on real glasses

1. `npm run build` → deploy `dist/` to any HTTPS host (or tunnel localhost).
2. In the Even App developer mode, QR-sideload the plugin URL.
3. Set `VITE_SERVER_URL` to your server's reachable address at build time.
4. For store distribution: package as `.ehpk` and submit via the
   [developer portal](https://hub.evenrealities.com/docs). Not needed for a
   sideloaded pilot fleet.

## TODO before pilot

- ~~Real gesture event mapping~~ — **done**. `gestures.ts` decodes the SDK's
  protobuf enums (`OsEventTypeList`, `EventSourceType`); MockBridge emits the
  same shapes so dev exercises the real decoder.
- ~~Voice query~~ — **done and live**. Deepgram nova-2 for speech, Grok for
  open-ended judgement; 505 ms measured through the production socket path.
- ~~Zone assignment~~ — **done**. The zone is a preference on the phone page,
  defaulting to the tenant's own ("Denim Wall" for gap, "Front Table" for
  shopify) and stored on the phone. Associate login is still outstanding: the
  glasses identify themselves by serial, and there is no sign-in.
- **Fonts are fetched from Google and are not in the manifest whitelist** — see
  "Shipping to Even Hub" below. Decide before submitting.

## Shipping to Even Hub

Four states: **Draft → Test → Submitted → Released**. A build in *Test* is
installable as a private build and assignable to a Beta group — that is how a
pilot fleet gets this without a public listing, and it is where the locked-phone
behaviour has to be validated, because QR sideload dies when the WebView
backgrounds. Released is terminal: versions are immutable and the only way
back is publishing a higher one.

```bash
VITE_SERVER_URL=https://realtime-production-80f4.up.railway.app npm run pack
```

`npm run pack` sets `CUE_PACK=1`, which drops `public/` from the build. That
directory holds `dev-utterance.pcm` — recorded speech the MockBridge streams so
voice is demoable in a browser — and MockBridge only runs when there is no
native bridge, which on a G2 is never. Packing it shipped 93 KB of dead weight
in a 140 KB package; without it the package is 55 KB.

**Unresolved before submission: the phone page fetches Instrument Sans, IBM Plex
Mono and Doto from `fonts.googleapis.com` and `fonts.gstatic.com`, neither of
which is in `app.json`'s network whitelist.** The manifest tells a reviewer
"all requests go to cuesea's own service", and that is currently not true.
Either self-host the faces, drop to system fonts on the phone page, or add the
two hosts and give up the single-host claim. A retail floor on store wifi is
also a poor place to depend on a CDN at launch.

Then upload the `.ehpk` in the dev portal. **That is the whole upload** — there
is nothing else to attach for a Test build.

`store/icon-*.png` are *listing* artwork, not package contents. `app.json` has no
icon field (check `evenhub init` — the canonical manifest has none), and the
portal offers nowhere to attach them while an app is in Test. They are collected
when you create a public listing, i.e. at Submitted. This file previously said to
attach them alongside the upload, which sent Kyle hunting for a control that does
not exist.

### Two review rules that shaped the code

**Root-page double-tap must raise the system exit dialog** —
`shutDownPageContainer(1)`. Mode 0, a silent exit, or a custom confirmation UI
are all rejections. There is only ever one page container, so "root page" is
ours to define: `onRootPage()` in `main.ts` treats the idle screen as root and
anything with a guest on it as an internal page. That costs double-press-to-talk
at idle, which is why a plain press means "ask" there. `gestures-browser.mjs`
asserts the exit mode so this can't regress.

**No secrets in the package.** Anyone can extract a released `.ehpk`. This
build ships no keys — the service key lives on the realtime server and the
plugin only ever talks to it — so the rule costs us nothing. Keep it that way:
the only host in the network whitelist is the realtime service.
