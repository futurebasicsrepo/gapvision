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

## Run (dev, no hardware)

```bash
# from repo root — server + AI service must be running (see root README)
npm run dev --workspace=packages/glasses-plugin   # http://localhost:5180
```

Tap a beacon button: the virtual lens renders exactly what the G2 would show.

## Run on real glasses

1. `npm run build` → deploy `dist/` to any HTTPS host (or tunnel localhost).
2. In the Even App developer mode, QR-sideload the plugin URL.
3. Set `VITE_SERVER_URL` to your server's reachable address at build time.
4. For store distribution: package as `.ehpk` and submit via the
   [developer portal](https://hub.evenrealities.com/docs). Not needed for a
   sideloaded pilot fleet.

## TODO before pilot

- Real gesture event mapping (press/double/swipe sys event codes) — verify on
  device or in the official simulator; MockBridge shims them today.
- Voice query: stream `audioEvent.audioPcm` (16 kHz PCM) to a server STT
  endpoint, answer via `textContainerUpgrade`.
- Associate login / zone assignment (currently hardcoded "Denim Wall").
