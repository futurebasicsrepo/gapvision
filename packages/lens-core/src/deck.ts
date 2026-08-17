/**
 * The card deck — same semantics as the G2 lens 0.3.x: the cue card is home,
 * CART / HISTORY / SIZES ride behind it, FLOOR is always last. Left/right
 * cycles the deck; select clicks into a card (scroll then moves its whole
 * content); select inside backs out; select on home ends the engagement.
 *
 * Pure module: no DOM, no socket, no storage. Every surface that renders a cue
 * imports this one — the G2 plugin, the Meta lens and Pocket — so that an
 * associate moving between them relearns nothing and, more importantly, cannot
 * be told two different things about the same guest.
 */
import type { Card, Cue, DisplayPayload, LensMode } from "./types.js";
import { CUE_LINES, joinMeta, money, toDisplayText } from "./grammar.js";

export function cueOf(payload: DisplayPayload): Cue {
  if (payload.cue?.lines?.length)
    return { lines: payload.cue.lines.slice(0, CUE_LINES).map(toDisplayText) };
  return { lines: (payload.lines || []).slice(0, CUE_LINES).map(toDisplayText) };
}

/**
 * `mode` changes the deal, not the vocabulary: classic is the G2 deck 1:1;
 * meta additionally deals SHOW (the recommendation, imagery-forward) and
 * carries image URLs on CART/HISTORY rows. Card *logic* stays identical so
 * an associate switching modes never relearns the gestures.
 */
export function cardsFor(payload: DisplayPayload, mode: LensMode = "classic"): Card[] {
  const out: Card[] = [];
  const g = payload.guest || {};
  const rich = mode === "meta";

  out.push({ kind: "CUE", lines: cueOf(payload).lines });

  const cart = g.open_cart || [];
  if (cart.length) {
    out.push({
      kind: "CART",
      lines: cart.slice(0, 3).map((i) => toDisplayText(i.name)),
      all: cart.map((i) => joinMeta([toDisplayText(i.name), money(i.price)])),
      meta: [money(cart.reduce((t, i) => t + (i.price || 0), 0)), "ONLINE"].filter(Boolean),
      ...(rich ? { images: cart.map((i) => i.image) } : {}),
    });
  }

  const recs = payload.recommendations || [];
  if (rich && recs.length) {
    const top = recs[0];
    out.push({
      kind: "SHOW",
      lines: [
        toDisplayText(top.name),
        joinMeta([money(top.price), top.location ? toDisplayText(top.location) : ""]),
      ].filter(Boolean),
      all: recs.map((r) =>
        joinMeta([toDisplayText(r.name), money(r.price), r.location ? toDisplayText(r.location) : ""])
      ),
      meta: [
        top.stock !== undefined ? `${top.stock} IN STOCK` : "",
        recs.length > 1 ? `+${recs.length - 1} MORE` : "",
      ].filter(Boolean),
      heroImage: top.image,
      images: recs.map((r) => r.image),
    });
  }

  const bought = g.purchase_history || [];
  if (bought.length) {
    out.push({
      kind: "HISTORY",
      lines: bought.slice(0, 3).map((i) => toDisplayText(i.name)),
      all: bought.map((i) => toDisplayText(i.name)),
      meta: [
        g.orders?.count ? `${g.orders.count} ORDERS` : "",
        g.orders?.last_at ? `LAST ${g.orders.last_at}` : "",
      ].filter(Boolean),
    });
  }

  const sizes = g.sizes || {};
  if (sizes.tops || sizes.bottoms) {
    out.push({
      kind: "SIZES",
      lines: [
        sizes.tops ? `TOPS ${sizes.tops}` : "",
        sizes.bottoms ? `BOTTOMS ${sizes.bottoms}` : "",
        sizes.outerwear ? `OUTERWEAR ${sizes.outerwear}` : "",
      ].filter(Boolean),
      meta: ["FROM PURCHASE HISTORY"],
    });
  }

  out.push({ kind: "FLOOR", lines: ["OPEN FLOOR CHANNEL"], meta: ["COMMS"] });
  return out;
}

// ---------------------------------------------------------------- deck state

export interface DeckState {
  cards: Card[];
  index: number;      // which card is under focus
  clickedIn: boolean; // border-3 state: scroll moves content, not the deck
  offset: number;     // first visible row of the clicked-in card
}

export const VISIBLE_ROWS = 3;

export function deckOf(payload: DisplayPayload, mode: LensMode = "classic"): DeckState {
  return { cards: cardsFor(payload, mode), index: 0, clickedIn: false, offset: 0 };
}

export function contentOf(card: Card): string[] {
  return card.all?.length ? card.all : card.lines;
}

/** Left/right at the deck; up/down inside a clicked-in card. */
export function move(s: DeckState, dir: -1 | 1): DeckState {
  if (s.clickedIn) {
    const rows = contentOf(s.cards[s.index]);
    const max = Math.max(0, rows.length - VISIBLE_ROWS);
    return { ...s, offset: Math.min(max, Math.max(0, s.offset + dir)) };
  }
  const n = s.cards.length;
  return { ...s, index: (s.index + dir + n) % n, offset: 0 };
}

export type SelectAction = "clicked-in" | "clicked-out" | "end-engagement" | "open-floor";

/** The select gesture — pinch on the Neural Band, Enter on the wire. */
export function select(s: DeckState): { state: DeckState; action: SelectAction } {
  const card = s.cards[s.index];
  if (s.clickedIn) return { state: { ...s, clickedIn: false, offset: 0 }, action: "clicked-out" };
  if (card.kind === "CUE") return { state: s, action: "end-engagement" };
  if (card.kind === "FLOOR") return { state: s, action: "open-floor" };
  return { state: { ...s, clickedIn: true, offset: 0 }, action: "clicked-in" };
}

/** The back gesture — Escape. Inside a card it backs out; at the deck it is a no-op
 *  (ending an engagement stays a deliberate select on home, same as the G2). */
export function back(s: DeckState): DeckState {
  return s.clickedIn ? { ...s, clickedIn: false, offset: 0 } : s;
}

export function titleOf(s: DeckState): string {
  const card = s.cards[s.index];
  if (card.kind === "CUE") return `CUE${joinMetaIndex(s)}`;
  if (s.clickedIn) {
    const rows = contentOf(card);
    const lo = s.offset + 1;
    const hi = Math.min(rows.length, s.offset + VISIBLE_ROWS);
    return `${card.kind} · ${lo}-${hi}/${rows.length}`;
  }
  return `${card.kind}${joinMetaIndex(s)}`;
}

function joinMetaIndex(s: DeckState): string {
  return ` · ${s.index + 1}/${s.cards.length}`;
}
