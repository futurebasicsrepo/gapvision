# @cue/meta-lens

Cue Lens for **Meta Ray-Ban Display** — the second lens surface, built on
Meta's Web Apps path: a standard HTML/CSS/JS app rendered by the glasses
themselves into the 600×600 in-lens display. No phone page, no bridge SDK.

Design doc: `claude/meta-lens-plugin.md` in the project (covers the Web App
vs native Device Access Toolkit decision, input mapping, and the voice gap).

## How it maps from the G2 lens

| | Even G2 (`glasses-plugin`) | Meta Ray-Ban Display (this package) |
|---|---|---|
| Runtime | Web app in the Even App WebView, containers over BLE | Web app on the glasses, DOM rendering |
| Display | 576×288 monochrome, ≤8 text containers | 600×600 color, ordinary CSS |
| Big type | Pixel-drawn hero rail (`hero.ts`/`png.ts`) | Just CSS font-size |
| Input | Temple/ring: scroll, press | Neural Band + captouch as keyboard events (arrows / Enter / Escape) |
| Voice | `audioControl` → 16 kHz PCM → Deepgram | **Not available** (Web Apps expose no mic) — see design doc |
| Dev preview | MockBridge virtual lens | The browser is the device: same key events, same viewport |

`src/deck.ts` + `src/grammar.ts` mirror the 0.3.x card-deck semantics
(CUE home · CART · HISTORY · SIZES · FLOOR last, click-in scrolling, end
only from home). When this lands in the monorepo, lift those shared shapes
into `packages/lens-core` and import from both plugins.

## Run

```bash
npm install
npm run dev        # http://localhost:5190 — arrows/Enter/Escape = the Neural Band
npm test           # deck + grammar suites (node --test)
npm run build      # static dist/ for any HTTPS host
```

Requires the Cue realtime server on :4000 (`npm run dev:server` at repo
root); set `VITE_SERVER_URL` at build time for production.

## Launch on glasses

Deploy `dist/` to HTTPS, then open the URL on the glasses (Meta's developer
flow; password-protected URLs supported in preview). Identity rides the
launch URL once — `?t=<associate-token>&tenant=gap&zone=Denim%20Wall` — and
persists in localStorage.
