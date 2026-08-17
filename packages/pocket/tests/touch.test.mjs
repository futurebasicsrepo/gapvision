/**
 * The thumb → gesture recogniser.
 *
 * Thresholds are tuned by feel once and then broken silently by a refactor,
 * which is exactly what a test suite is for. The cases that matter are the
 * ones a shop floor produces and a desk does not: a tap taken while walking,
 * a diagonal smudge, a thumb resting on a card while reading it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { recognise, SWIPE_MIN, TAP_SLOP, TAP_MAX_MS, AXIS_RATIO } from "../.test-dist/touch.js";

const at = (x, y, t) => ({ x, y, t });

test("a still, quick touch is select", () => {
  assert.equal(recognise(at(100, 200, 0), at(102, 201, 120)), "select");
});

test("a tap taken while walking is still a tap", () => {
  // A person crossing a floor does not hold a phone still. Anything under the
  // slop is a tap; this is why the slop is not 2px.
  assert.equal(recognise(at(100, 200, 0), at(100 + TAP_SLOP - 1, 200 + 3, 200)), "select");
});

test("a thumb resting on a card while reading it is not a select", () => {
  assert.equal(recognise(at(100, 200, 0), at(101, 200, TAP_MAX_MS + 1)), null);
});

test("swiping left moves forward, the way every carousel on the device does", () => {
  assert.equal(recognise(at(300, 400, 0), at(300 - SWIPE_MIN - 10, 400, 180)), "next");
});

test("swiping right goes back through the deck", () => {
  assert.equal(recognise(at(100, 400, 0), at(100 + SWIPE_MIN + 10, 402, 180)), "prev");
});

test("swiping up and down scroll a card's content", () => {
  assert.equal(recognise(at(200, 400, 0), at(200, 400 - SWIPE_MIN - 5, 150)), "down");
  assert.equal(recognise(at(200, 400, 0), at(200, 400 + SWIPE_MIN + 5, 150)), "up");
});

test("a movement between the slop and the swipe threshold is nothing at all", () => {
  // The gap between TAP_SLOP and SWIPE_MIN is deliberate. If the two met,
  // every ambiguous smudge would become a tap or a swipe rather than a
  // shrug — and an accidental `select` on the CUE card ends an engagement.
  const mid = Math.round((TAP_SLOP + SWIPE_MIN) / 2);
  assert.ok(mid > TAP_SLOP && mid < SWIPE_MIN, "the thresholds must not meet");
  assert.equal(recognise(at(100, 100, 0), at(100 + mid, 100, 150)), null);
});

test("a diagonal smudge is refused rather than guessed", () => {
  // Equal dx and dy: no axis wins, so no gesture. Guessing here means the deck
  // jumps a card when somebody meant to scroll.
  assert.equal(recognise(at(0, 0, 0), at(60, 60, 200)), null);
});

test("the axis ratio is what separates a swipe from a drift", () => {
  const d = SWIPE_MIN + 20;                      // rightward, so a clean one is "prev"
  const withinAxis = Math.floor(d / AXIS_RATIO) - 1;
  const beyondAxis = Math.ceil(d / AXIS_RATIO) + 1;

  assert.equal(recognise(at(0, 0, 0), at(d, withinAxis, 200)), "prev",
    "a swipe with a little drift in it is still a swipe");
  assert.equal(recognise(at(0, 0, 0), at(d, beyondAxis, 200)), null,
    "once the off-axis movement catches up, it is not a horizontal swipe any more");
});

test("a slow swipe is still a swipe", () => {
  // Deliberately no time limit on swipes: an associate dragging slowly through
  // a card list is doing it on purpose, and a timeout would punish care.
  assert.equal(recognise(at(300, 400, 0), at(200, 400, 3000)), "next");
});
