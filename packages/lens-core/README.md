# @cue/lens-core

The lens grammar and the card deck, shared by every surface that renders a cue.

```
src/types.ts     the display payload contract, and Card / LensMode
src/grammar.ts   toDisplayText, money, joinMeta — the glass grammar's last mile
src/deck.ts      cardsFor, deckOf, move, select, back, titleOf
```

## Why it exists

Three surfaces render a cue: the Even G2 plugin (576×288 monochrome, over
BLE), the Meta Ray-Ban Display web app (600×600, on-glass), and Pocket (a
phone, in a hand, in a shop). They share nothing physically and must share
everything semantically.

If the deck forks, two things break, and the second is worse than the first.
An associate who moves from the handheld to the glasses relearns the gestures
— annoying. And the two surfaces begin answering the same question
differently — which makes the product untrustworthy in the only way that
matters, because the merchant cannot tell which one was wrong.

`meta-lens/src/deck.ts` carried the note *"liftable to lens-core"* from the
day it was written, and `types.ts` and the package README both named the same
plan. This is that lift, done when the third consumer arrived rather than
before, which is the right time to do it.

## The rule

**Everything here is pure.** No DOM, no socket, no storage, no platform
detection, no `window`. It is enforced by the tests running under plain
`node --test` with no browser and no jsdom: an import of anything browser-shaped
fails the suite rather than passing quietly and breaking a lens.

Rendering belongs to the surface. `deck.ts` decides *which card is under
focus and what is on it*; whether that is a pixel-drawn hero rail, a CSS grid
or a thumb-sized touch target is the surface's business and none of this
package's.

## Consuming it

Workspace-resolved, source-only — no build step, because a shared package with
a build step is a shared package somebody forgets to rebuild:

```ts
import { deckOf, move, select, toDisplayText } from "@cue/lens-core";
import type { DisplayPayload, LensMode } from "@cue/lens-core";
```

Vite consumers should `optimizeDeps.exclude` it so the dep pre-bundler leaves
the TypeScript alone and Vite transforms it as source.

## Test

```bash
npm test --workspace=packages/lens-core
```

Compiles the three modules with `tsc` and runs the deck suite against the
output. Both halves matter: the compile is the type check, the suite is the
behaviour.
