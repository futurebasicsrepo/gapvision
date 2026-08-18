/**
 * Feed-backed widgets — the half of the deck that is data.
 *
 *   npm run test:feeds
 *
 * A feed widget's whole content is rows the control plane holds, which makes
 * this a boundary in the same sense `normalisePrefs` is: the rows are typed by
 * a retailer's admin and drawn onto 576px of monochrome, so anything malformed
 * has to resolve to something drawable rather than to a crash mid-shift.
 *
 * The property worth protecting most: **the fetch never throws and never
 * blocks.** A shop floor's wifi must not be in the path of a cue, and a
 * promotions request that rejected would take down a boot sequence with real
 * work to do.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normaliseFeeds, feedCards, fetchFeeds } from "../dist-test/feeds.js";

test("well-formed rows come through intact", () => {
  const out = normaliseFeeds({
    promos: [{ id: "p1", title: "Denim event", lines: ["20% OFF DENIM", "THIS WEEKEND"] }],
  });
  assert.equal(out.promos.length, 1);
  assert.deepEqual(out.promos[0].lines, ["20% OFF DENIM", "THIS WEEKEND"]);
});

test("a row with no lines is dropped rather than drawn as an empty heading", () => {
  // On the glass a title with nothing under it reads as a fault, and the
  // associate has no way to tell it from one.
  const out = normaliseFeeds({ promos: [{ id: "p1", title: "Empty", lines: [] }] });
  assert.equal(out.promos.length, 0);
});

test("non-string lines are discarded, not stringified", () => {
  // `[object Object]` on a shop floor is worse than a shorter promotion.
  const out = normaliseFeeds({
    promos: [{ id: "p1", title: "Mixed", lines: ["REAL", 42, null, { a: 1 }, "  "] }],
  });
  assert.deepEqual(out.promos[0].lines, ["REAL"]);
});

test("junk resolves to an empty map rather than throwing", () => {
  for (const junk of [null, undefined, "promos", 42, { promos: "not an array" }]) {
    assert.doesNotThrow(() => normaliseFeeds(junk));
  }
  assert.deepEqual(normaliseFeeds({ promos: "nope" }), {});
});

test("an unknown widget name passes through — the catalogue decides, not this", () => {
  // A service a version ahead sends a widget this package cannot draw. Dropping
  // it here would be a second place that decides what exists; `deckFrom` already
  // ignores kinds no enabled widget contributes.
  const out = normaliseFeeds({ announcements: [{ id: "a1", title: "T", lines: ["X"] }] });
  assert.equal(out.announcements.length, 1);
});

// --- rows to cards ------------------------------------------------------------

test("each row is its own card, so a second promotion is one scroll away", () => {
  // Stacking them into one card would put the second behind a click —
  // a different gesture from the one an associate is already making.
  const cards = feedCards("PROMO", [
    { id: "1", title: "A", lines: ["ONE"] },
    { id: "2", title: "B", lines: ["TWO"] },
  ]);
  assert.equal(cards.length, 2);
  assert.ok(cards.every((c) => c.kind === "PROMO"));
});

test("the glance is three lines and the rest is behind a click", () => {
  const [card] = feedCards("PROMO", [
    { id: "1", title: "Long", lines: ["A", "B", "C", "D"] },
  ]);
  assert.deepEqual(card.lines, ["A", "B", "C"]);
  assert.deepEqual(card.all, ["A", "B", "C", "D"]);
});

test("a card with nothing more to show offers no click-in", () => {
  // Clicking into a card that then shows the same three lines reads as a
  // control that does nothing.
  const [card] = feedCards("PROMO", [{ id: "1", title: "Short", lines: ["A", "B"] }]);
  assert.equal(card.all, undefined);
});

test("the title rides in meta, in the deck's own voice", () => {
  const [card] = feedCards("PROMO", [{ id: "1", title: "Denim event", lines: ["X"] }]);
  assert.deepEqual(card.meta, ["DENIM EVENT"]);
});

test("a row with no title contributes no meta rather than an empty strip", () => {
  const [card] = feedCards("PROMO", [{ id: "1", title: "", lines: ["X"] }]);
  assert.equal(card.meta, undefined);
});

// --- the fetch ----------------------------------------------------------------

test("a refused fetch is empty, not an exception", async () => {
  const out = await fetchFeeds("http://x", "gap", async () => ({ ok: false }));
  assert.deepEqual(out, {});
});

test("a fetch that throws is empty too — wifi is not in the path of a cue", async () => {
  const out = await fetchFeeds("http://x", "gap", async () => { throw new Error("offline"); });
  assert.deepEqual(out, {});
});

test("a body that is not the expected shape is empty", async () => {
  const out = await fetchFeeds("http://x", "gap",
    async () => ({ ok: true, json: async () => ({ nope: 1 }) }));
  assert.deepEqual(out, {});
});

test("a good response is normalised on the way in", async () => {
  const out = await fetchFeeds("http://x", "gap", async () => ({
    ok: true,
    json: async () => ({
      known: true,
      widgets: { promos: [{ id: "p", title: "T", lines: ["ONE", 2] }] },
    }),
  }));
  assert.deepEqual(out.promos[0].lines, ["ONE"]);
});

test("the tenant is encoded, because a slug is somebody's typed string", async () => {
  let seen = "";
  await fetchFeeds("http://x", "a store/../..", async (url) => {
    seen = url;
    return { ok: true, json: async () => ({ widgets: {} }) };
  });
  assert.ok(!seen.includes(" "), seen);
  assert.ok(seen.includes("a%20store"), seen);
});
