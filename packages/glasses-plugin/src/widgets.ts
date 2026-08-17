/**
 * The deck as widgets — what the associate curates, and what a host renders.
 *
 * The right-hand region has always been a stack of cards. What it was not is
 * *theirs*: `cardsFor` decided membership from the payload and the order was
 * written down in one place, so nobody could put messaging above the cart or
 * take the picks out of their way.
 *
 * A widget is a named group of cards with a switch and a position. This module
 * owns three facts and nothing else: which widgets exist, which cards each one
 * contributes, and how a stored preference resolves into a deck.
 *
 * **Deliberately pure — no bridge, no DOM, no socket, no host API.** That is
 * not tidiness. The G2 is one glasses platform and it will not be the last;
 * when a second provider arrives, everything that decides *what the associate
 * sees* should port as data and a pure function, leaving only the drawing to
 * be rewritten. `layout.ts` already draws for one specific 576×288 monochrome
 * display. This file must never learn about any of that.
 *
 * The cue is not a widget. It is the product — three lines and the fact rail —
 * and the deck is what an associate curates *around* it. Turning widgets off
 * leaves the cue, which is the 0.2.0 lens and a complete thing.
 */
import type { Card } from "./cards";

/** Every widget that can appear in the deck, in the order they are offered. */
export type WidgetId = "customer" | "inventory" | "messaging" | "promos";

export interface WidgetSpec {
  id: WidgetId;
  /** What the phone calls it. The glass uses the card's own `kind`. */
  label: string;
  /** One sentence, for the phone's list. */
  blurb: string;
  /** Which card kinds this widget contributes, in deck order. */
  kinds: string[];
  /**
   * Where the content comes from.
   *
   * `live` — the package builds these cards from the engagement payload.
   * `feed` — the cards are rows the control plane sent, and the package only
   *          draws them.
   *
   * The distinction is the one that decides whether a *new* widget costs a
   * release. A feed widget is a row in `tenant_feeds` plus an entry in this
   * catalogue; a live one is code. Kyle, 17 Aug 2026, asked for widgets that
   * plug in rather than forcing a rebuild each time — this is how far that
   * can honestly go, and PROMOS is the first instance rather than a special
   * case.
   */
  content: "live" | "feed";
}

/**
 * The catalogue.
 *
 * CUSTOMER is one widget rather than five cards because an associate does not
 * think "sizes, cart, history, shipping, contact" — they think *the person*.
 * Splitting it into five switches would be five decisions nobody wants to make
 * and a settings screen longer than the feature.
 */
export const WIDGETS: WidgetSpec[] = [
  {
    id: "customer",
    label: "Customer",
    blurb: "Their sizes, cart, order history, shipping and contact.",
    kinds: ["SIZES", "CART", "HISTORY", "SHIP", "CONTACT"],
    content: "live",
  },
  {
    id: "inventory",
    label: "Inventory",
    blurb: "What to offer, with price, stock and where it is on the floor.",
    kinds: ["PICK"],
    content: "live",
  },
  {
    id: "messaging",
    label: "Messaging",
    blurb: "The floor channel — what is waiting, and what you can say back.",
    kinds: ["FLOOR"],
    content: "live",
  },
  {
    // The first widget that is data rather than code.
    //
    // Kyle, 17 Aug 2026: the source is a marketing asset — a PDF or a live
    // feed at a URL — not hand-typed copy. That is why the rows live in
    // `tenant_feeds` with a validity window and an ingest source, and why the
    // package's whole contribution here is "draw a titled list of lines".
    //
    // Nothing about this widget is promotion-specific, which is the point:
    // announcements, shift notes and the "other useful information" slot are
    // the same shape and can be added as data.
    id: "promos",
    label: "Promotions",
    blurb: "What is running in store today, from your marketing feed.",
    kinds: ["PROMO"],
    content: "feed",
  },
];

/** Today's behaviour, exactly: the guest, then the picks, then the floor. An
 *  associate who never opens the widgets screen sees no change. */
export const DEFAULT_ORDER: WidgetId[] = ["customer", "inventory", "messaging"];

/** What the phone stores and the lens reads. */
export interface WidgetPrefs {
  /** Enabled widgets, in the associate's order. */
  order: WidgetId[];
}

export const DEFAULT_PREFS: WidgetPrefs = { order: [...DEFAULT_ORDER] };

const KNOWN = new Set<string>(WIDGETS.map((w) => w.id));

/**
 * Read a stored preference without trusting it.
 *
 * Storage is the phone's `localStorage` and one day a server row, so this is
 * a boundary: a value that predates a widget, names one that has been removed,
 * or repeats one, must resolve to something sane rather than a deck with two
 * FLOOR cards and a hole. Unknown ids are dropped, duplicates collapse, and a
 * value that parses to nothing falls back to the default rather than to an
 * empty deck — an associate whose storage is corrupt should get the product,
 * not a blank right-hand side.
 */
export function normalisePrefs(raw: unknown): WidgetPrefs {
  const list = Array.isArray((raw as any)?.order) ? (raw as any).order : null;
  if (!list) return { order: [...DEFAULT_ORDER] };
  const seen = new Set<string>();
  const order: WidgetId[] = [];
  for (const id of list) {
    if (typeof id !== "string" || !KNOWN.has(id) || seen.has(id)) continue;
    seen.add(id);
    order.push(id as WidgetId);
  }
  return { order };
}

/** A widget the associate has switched off is absent from `order`; this is
 *  what the phone's list uses to draw the off ones underneath. */
export function disabledWidgets(prefs: WidgetPrefs): WidgetSpec[] {
  const on = new Set<string>(prefs.order);
  return WIDGETS.filter((w) => !on.has(w.id));
}

/**
 * The deck, as the associate arranged it.
 *
 * Takes cards rather than a payload on purpose. `cardsFor` still decides what
 * each card *says* — it is the thing that knows a cart with four items needs a
 * scrollable window — but not every card comes from a guest: FLOOR exists with
 * nobody on the glass at all. Accepting a list keeps this function ignorant of
 * where cards are born, which is the same reason it knows nothing about the
 * display.
 *
 * `widgetsOn` is the store's master switch. Off leaves the cue alone on the
 * glass, which is the documented behaviour and the reason the cue is not a
 * widget.
 */
export function deckFrom(
  all: Card[],
  prefs: WidgetPrefs = DEFAULT_PREFS,
  widgetsOn = true,
): Card[] {
  const cue = all.filter((c) => c.kind === "CUE");
  if (!widgetsOn) return cue;

  const byKind = new Map<string, Card[]>();
  for (const card of all) {
    if (card.kind === "CUE") continue;
    const bucket = byKind.get(card.kind);
    if (bucket) bucket.push(card);
    else byKind.set(card.kind, [card]);
  }

  const out: Card[] = [...cue];
  for (const id of prefs.order) {
    const spec = WIDGETS.find((w) => w.id === id);
    if (!spec) continue;
    for (const kind of spec.kinds) out.push(...(byKind.get(kind) || []));
  }
  return out;
}
