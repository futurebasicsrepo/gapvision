import test from "node:test";
import assert from "node:assert/strict";
import { cardsFor, cueOf, deckOf, move, select, back, titleOf, contentOf } from "../.test-dist/deck.js";
import { toDisplayText, money, joinMeta } from "../.test-dist/grammar.js";

const PAYLOAD = {
  cue: {
    lines: [
      "Sarah Chen",
      "Left the CashSoft Crew Sweater in their cart!",
      "Offer it in size M.",
    ],
  },
  guest: {
    name: "Sarah Chen",
    tier: "Icon",
    points: 4200,
    sizes: { tops: "M", bottoms: "28x30", outerwear: "M" },
    open_cart: [
      { name: "CashSoft Crew Sweater", price: 69.95 },
      { name: "Mid Rise Vintage Slim Jeans", price: 79.95 },
      { name: "Icon Denim Jacket", price: 98.0 },
      { name: "Poplin Shirt", price: 54.95 },
    ],
    purchase_history: [{ name: "Organic Cotton Vintage Tee", price: 24.95 }],
    orders: { count: 6, last_at: "JUL 12" },
  },
  zone: "Denim Wall",
  latency_s: 0.4,
};

test("grammar: uppercase, no punctuation but the interpunct, whole money", () => {
  assert.equal(toDisplayText("Left the sweater in their cart!"), "LEFT THE SWEATER IN THEIR CART");
  assert.equal(toDisplayText("[ICON:CART] Online cart: Sweater"), "ONLINE CART SWEATER");
  assert.equal(money(69.95), "$70");
  assert.equal(joinMeta(["ICON", "", "4200 PTS", undefined]), "ICON · 4200 PTS");
});

test("cue: three lines max, grammar applied", () => {
  const cue = cueOf(PAYLOAD);
  assert.equal(cue.lines.length, 3);
  assert.equal(cue.lines[0], "SARAH CHEN");
  assert.ok(!cue.lines[1].includes("!"));
});

test("deck order: CUE home, FLOOR last", () => {
  const cards = cardsFor(PAYLOAD);
  assert.equal(cards[0].kind, "CUE");
  assert.equal(cards[cards.length - 1].kind, "FLOOR");
  assert.deepEqual(cards.map((c) => c.kind), ["CUE", "CART", "HISTORY", "SIZES", "FLOOR"]);
});

test("cart card: whole cart in `all`, price beside each item, total in meta", () => {
  const cart = cardsFor(PAYLOAD).find((c) => c.kind === "CART");
  assert.equal(cart.lines.length, 3);
  assert.equal(cart.all.length, 4);
  assert.equal(cart.all[0], "CASHSOFT CREW SWEATER · $70");
  assert.equal(cart.meta[0], "$303");
});

test("deck cycles both directions and wraps", () => {
  let s = deckOf(PAYLOAD);
  s = move(s, -1);
  assert.equal(s.cards[s.index].kind, "FLOOR");
  s = move(s, 1);
  assert.equal(s.cards[s.index].kind, "CUE");
});

test("click-in scrolls content, not the deck; back exits", () => {
  let s = deckOf(PAYLOAD);
  s = move(s, 1); // CART
  const r = select(s);
  assert.equal(r.action, "clicked-in");
  s = r.state;
  s = move(s, 1);
  assert.equal(s.offset, 1);
  assert.equal(titleOf(s), "CART · 2-4/4");
  s = move(s, 1);
  assert.equal(s.offset, 1, "offset clamps at content end");
  s = back(s);
  assert.equal(s.clickedIn, false);
  assert.equal(s.offset, 0);
});

test("select on home ends the engagement; select on FLOOR opens comms", () => {
  let s = deckOf(PAYLOAD);
  assert.equal(select(s).action, "end-engagement");
  s = move(s, -1); // FLOOR
  assert.equal(select(s).action, "open-floor");
});

test("degrades to legacy lines payload", () => {
  const s = deckOf({ lines: ["[ICON:USER] Sarah Chen", "Hello.", "World"], guest: {} });
  assert.deepEqual(s.cards.map((c) => c.kind), ["CUE", "FLOOR"]);
  assert.equal(contentOf(s.cards[0])[0], "SARAH CHEN");
});

test("empty payload still yields a home card", () => {
  const s = deckOf({});
  assert.equal(s.cards[0].kind, "CUE");
  assert.equal(select(s).action, "end-engagement");
});
