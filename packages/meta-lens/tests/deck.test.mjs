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

// ------------------------------------------------------------- v2 meta mode

const RICH = {
  ...PAYLOAD,
  guest: {
    ...PAYLOAD.guest,
    open_cart: PAYLOAD.guest.open_cart.map((i, n) => ({ ...i, image: `https://cdn.example/cart-${n}.jpg` })),
  },
  recommendations: [
    { name: "High Rise Barrel Jeans", price: 89.95, location: "Denim Wall", image: "https://cdn.example/rec-0.jpg", stock: 9 },
    { name: "Heavyweight Relaxed Tee", price: 29.95, location: "Essentials", image: "https://cdn.example/rec-1.jpg" },
  ],
};

test("classic mode: no SHOW card, no images — the G2 deck 1:1", () => {
  const cards = cardsFor(RICH, "classic");
  assert.deepEqual(cards.map((c) => c.kind), ["CUE", "CART", "HISTORY", "SIZES", "FLOOR"]);
  assert.equal(cards.find((c) => c.kind === "CART").images, undefined);
});

test("meta mode deals SHOW after CART, images row-aligned", () => {
  const cards = cardsFor(RICH, "meta");
  assert.deepEqual(cards.map((c) => c.kind), ["CUE", "CART", "SHOW", "HISTORY", "SIZES", "FLOOR"]);
  const cart = cards.find((c) => c.kind === "CART");
  assert.equal(cart.images.length, cart.all.length);
  assert.equal(cart.images[2], "https://cdn.example/cart-2.jpg");
});

test("SHOW: top rec as hero with flame facts, rest scrollable", () => {
  const show = cardsFor(RICH, "meta").find((c) => c.kind === "SHOW");
  assert.equal(show.heroImage, "https://cdn.example/rec-0.jpg");
  assert.equal(show.lines[0], "HIGH RISE BARREL JEANS");
  assert.equal(show.lines[1], "$90 · DENIM WALL");
  assert.equal(show.all.length, 2);
  assert.deepEqual(show.meta, ["9 IN STOCK", "+1 MORE"]);
});

test("meta mode without recommendations deals no SHOW", () => {
  const cards = cardsFor(PAYLOAD, "meta");
  assert.ok(!cards.some((c) => c.kind === "SHOW"));
});

test("gesture vocabulary identical across modes", () => {
  let s = deckOf(RICH, "meta");
  assert.equal(select(s).action, "end-engagement");           // home still ends
  s = move(s, -1);
  assert.equal(select(s).action, "open-floor");               // FLOOR still last
  s = move(move(deckOf(RICH, "meta"), 1), 1);                 // SHOW
  const r = select(s);
  assert.equal(r.action, "clicked-in");                       // rec list scrolls like any card
});
