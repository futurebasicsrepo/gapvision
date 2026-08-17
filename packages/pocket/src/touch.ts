/**
 * A thumb, translated into the six gestures every lens already speaks.
 *
 * `@cue/lens-core` deals a card deck navigated by exactly six verbs. The Even
 * G2 produces them from a temple strip and a ring; the Meta Ray-Ban Display
 * produces them from a Neural Band that arrives as arrow keys. A phone
 * produces them from one thumb, and nothing downstream needs to know which.
 *
 * That is the whole reason the deck was written as a pure module: this file is
 * the port, and it is 90 lines.
 *
 * ── Cross-platform, deliberately boring ──────────────────────────────────
 *
 * Pointer Events, not Touch Events and not `gesturestart`. Pointer Events are
 * the one input model Safari, Chrome on Android and the Chromium build on a
 * Zebra handheld all implement the same way, and they cover a stylus and a
 * mouse for free — which matters because half the "phones" on a shop floor are
 * a store handheld somebody sometimes drives with a finger in a glove.
 *
 * The recogniser itself is pure: two samples in, a gesture out. It runs under
 * `node --test`, because thresholds are exactly the kind of thing that is
 * tuned once by feel and then silently broken by a refactor.
 */
import type { LensGesture } from "./gestures.js";

export interface Sample {
  x: number;
  y: number;
  /** ms; only differences are used, so any monotonic clock will do. */
  t: number;
}

/**
 * Thresholds, in CSS pixels and milliseconds.
 *
 * `SWIPE_MIN` is 40 rather than something smaller because a person walking
 * across a shop floor does not hold a phone still, and a 15px threshold turns
 * every tap on a moving train of a sales floor into an accidental swipe.
 *
 * `TAP_SLOP` is deliberately below `SWIPE_MIN` with a gap between them: the
 * band in between is *nothing*, which is the correct answer for a movement
 * that was neither a tap nor a swipe. Making the two thresholds meet means
 * every ambiguous smudge becomes one or the other.
 */
export const SWIPE_MIN = 40;
export const TAP_SLOP = 12;
export const TAP_MAX_MS = 500;
/** How much more horizontal than vertical a swipe must be to count as one. */
export const AXIS_RATIO = 1.6;

/**
 * One completed pointer interaction → a gesture, or nothing.
 *
 * `null` is a real and common answer. A recogniser that always returns
 * something is a recogniser that fires on a pocket.
 */
export function recognise(start: Sample, end: Sample): LensGesture | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  const dt = end.t - start.t;

  if (adx < TAP_SLOP && ady < TAP_SLOP) {
    // Held rather than tapped: on a phone that is a press-and-hold, which we
    // do not use — and firing `select` after a two-second hold would surprise
    // somebody who was just resting a thumb while reading a card.
    return dt <= TAP_MAX_MS ? "select" : null;
  }

  if (adx >= SWIPE_MIN && adx >= ady * AXIS_RATIO) {
    // Swipe left moves *forward* through the deck — the content follows the
    // thumb, the same direction as every carousel on the device already.
    return dx < 0 ? "next" : "prev";
  }

  if (ady >= SWIPE_MIN && ady >= adx * AXIS_RATIO) {
    // Inside a clicked-in card these scroll its content; at the deck they flip
    // the lens mode. `deck.ts` owns that distinction, not this file.
    return dy < 0 ? "down" : "up";
  }

  return null;
}

/**
 * Bind the recogniser to an element.
 *
 * `back` is not produced here. It comes from the platform's own back
 * affordance — Android's system gesture, and an on-screen control on iOS which
 * has none — because inventing a seventh swipe for "back" on a surface that
 * already has a back gesture is how an app feels foreign.
 */
export function onTouchGesture(
  el: HTMLElement,
  handler: (g: LensGesture) => void,
  clock: () => number = () => performance.now(),
): () => void {
  let start: Sample | null = null;

  const down = (e: PointerEvent) => {
    start = { x: e.clientX, y: e.clientY, t: clock() };
  };
  const up = (e: PointerEvent) => {
    if (!start) return;
    const g = recognise(start, { x: e.clientX, y: e.clientY, t: clock() });
    start = null;
    if (g) handler(g);
  };
  const cancel = () => { start = null; };

  el.addEventListener("pointerdown", down);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", cancel);
  // A pointer that leaves the element never produces a pointerup on it. Without
  // this the next tap anywhere would be measured from a stale origin and read
  // as an enormous swipe.
  el.addEventListener("pointerleave", cancel);

  return () => {
    el.removeEventListener("pointerdown", down);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", cancel);
    el.removeEventListener("pointerleave", cancel);
  };
}
