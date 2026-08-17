/**
 * The deck an associate arranged.
 *
 *   node packages/glasses-plugin/test/widgets.test.mjs
 *
 * `widgets.ts` is the layer that decides *what the wearer sees* — which
 * modules, in which order — and it is deliberately pure so that a second
 * glasses platform inherits it as data and a function rather than as a
 * rewrite. That makes it worth testing on its own, with no bridge, no DOM and
 * no display: everything asserted here is true on any hardware.
 *
 * What it holds down, in order of how badly it would hurt to get wrong:
 *
 *   1. The default arrangement is today's behaviour. Nobody's shift changes
 *      because this shipped.
 *   2. Stored preferences are untrusted input. A value naming a widget that no
 *      longer exists, or repeating one, must not produce a deck with a hole or
 *      a doubled card — and a corrupt value must fall back to the product
 *      rather than to a blank right-hand side.
 *   3. The order is honoured, including for the multi-card widget.
 *   4. Removing a widget removes all of its cards, not the first one.
 *   5. The store's master switch leaves the cue and nothing else, because the
 *      cue is the product and the deck is what surrounds it.
 */
import {
  DEFAULT_ORDER, WIDGETS, deckFrom, disabledWidgets, normalisePrefs,
} from "../dist-test/widgets.js";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/** A full house: the cue, every customer card, two picks and the floor. */
const CARDS = [
  { kind: "CUE", lines: ["SARAH CHEN", "IN CART CASHSOFT CREW", "OFFER IT IN M"] },
  { kind: "SIZES", lines: ["TOP M"] },
  { kind: "CART", lines: ["CASHSOFT CREW"] },
  { kind: "HISTORY", lines: ["BARREL JEAN"] },
  { kind: "SHIP", lines: ["1 MAIN ST"] },
  { kind: "CONTACT", lines: ["SARAH@EXAMPLE.COM"] },
  { kind: "PICK", lines: ["HIGH RISE BARREL"], sku: "41221" },
  { kind: "PICK", lines: ["CASHSOFT CREW"], sku: "41222" },
  { kind: "FLOOR", lines: [] },
];

const kinds = (deck) => deck.map((c) => c.kind);

// --- 1. the default is what shipped ----------------------------------------

const def = deckFrom(CARDS);
check("the cue leads, always", kinds(def)[0] === "CUE", kinds(def).join(","));
check("the default deck is today's order — guest, picks, floor",
  kinds(def).join(",") === "CUE,SIZES,CART,HISTORY,SHIP,CONTACT,PICK,PICK,FLOOR",
  kinds(def).join(","));
check("the default order names every widget",
  DEFAULT_ORDER.length === WIDGETS.length,
  `${DEFAULT_ORDER.join(",")} vs ${WIDGETS.map((w) => w.id).join(",")}`);

// --- 2. stored preferences are untrusted -----------------------------------

check("a missing preference falls back to the default",
  normalisePrefs(null).order.join(",") === DEFAULT_ORDER.join(","));
check("a malformed preference falls back to the default, not to an empty deck",
  normalisePrefs({ order: "messaging" }).order.join(",") === DEFAULT_ORDER.join(","));
check("a widget that no longer exists is dropped",
  normalisePrefs({ order: ["messaging", "astrology", "customer"] }).order.join(",")
    === "messaging,customer");
check("a repeated widget appears once",
  normalisePrefs({ order: ["messaging", "messaging"] }).order.join(",") === "messaging");
// Deliberately distinct from the malformed case: an empty array is somebody
// removing everything, which is a choice, and it must survive as one.
check("an empty arrangement is honoured rather than reset",
  normalisePrefs({ order: [] }).order.length === 0);

// --- 3. the order is theirs -------------------------------------------------

const reordered = deckFrom(CARDS, { order: ["messaging", "inventory", "customer"] });
check("the arrangement decides the deck",
  kinds(reordered).join(",") === "CUE,FLOOR,PICK,PICK,SIZES,CART,HISTORY,SHIP,CONTACT",
  kinds(reordered).join(","));
check("a multi-card widget keeps its own internal order",
  kinds(reordered).slice(-5).join(",") === "SIZES,CART,HISTORY,SHIP,CONTACT");

// --- 4. removing takes the whole widget -------------------------------------

const noCustomer = deckFrom(CARDS, { order: ["inventory", "messaging"] });
check("removing the customer widget removes all five of its cards",
  !kinds(noCustomer).some((k) => ["SIZES", "CART", "HISTORY", "SHIP", "CONTACT"].includes(k)),
  kinds(noCustomer).join(","));
check("removing one widget leaves the others intact",
  kinds(noCustomer).join(",") === "CUE,PICK,PICK,FLOOR", kinds(noCustomer).join(","));
check("what is off is offered back",
  disabledWidgets({ order: ["inventory", "messaging"] }).map((w) => w.id).join(",")
    === "customer");

// --- 5. the store's master switch -------------------------------------------

const off = deckFrom(CARDS, { order: [...DEFAULT_ORDER] }, false);
check("widgets off leaves the cue, which is a complete product",
  kinds(off).join(",") === "CUE", kinds(off).join(","));
check("an empty arrangement is not the same as the switch being off — both "
  + "leave the cue, and neither leaves nothing",
  kinds(deckFrom(CARDS, { order: [] })).join(",") === "CUE");

// --- a guest with sparse data ------------------------------------------------
// A store with thin customer records is the normal case, not the exception.

const sparse = deckFrom(
  [{ kind: "CUE", lines: ["WALK-IN"] }, { kind: "FLOOR", lines: [] }],
  { order: [...DEFAULT_ORDER] });
check("a widget with nothing to show contributes nothing, and breaks nothing",
  kinds(sparse).join(",") === "CUE,FLOOR", kinds(sparse).join(","));

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
