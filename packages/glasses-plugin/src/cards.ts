/**
 * The card stack — what the right-hand region of the lens holds.
 *
 * That region has always been a stack: three lines, a position indicator,
 * scrolled between with the ring. It just was not named one, and it only ever
 * held product recommendations. Naming it is what lets customer depth, the
 * picks, and whatever ships next share one navigation model instead of each
 * inventing a screen.
 *
 * A card is three lines and a meta strip. That is the entire vocabulary, and
 * it is not a limitation to design around — it is the reason an associate can
 * read one at arm's length while still talking to somebody.
 *
 * Order, Kyle's call (2026-08-15): the cue, then the guest, then the picks.
 * You are already talking to the person, so their details are what you reach
 * for mid-sentence; a product recommendation is what you reach for after.
 *
 * This file is deliberately pure — no socket, no bridge, no DOM. It sat in
 * main.ts first and could not be tested there, which for the one function
 * that decides what an associate can find is the wrong trade.
 */
import { CUE_LINES, RAIL_LINE_PX, toDisplayText, type Cue } from "./layout";
import { fitsPx, wrapPx } from "./text";

export type Recommendation = {
  sku: string;
  name: string;
  price?: number;
  location?: string;
  stock?: number;
};

export type DisplayPayload = {
  lines: string[];
  cue?: Cue;
  script?: { opener: string; upsell: string; closer: string };
  guest?: { name: string; tier: string; guest_id?: string } & Record<string, any>;
  recommendations?: Recommendation[];
};

export type Card = {
  kind: string;
  lines: string[];
  meta?: string[];
  /** Set on PICK cards: scrolling to one makes it what "these" refers to. */
  sku?: string;
  /**
   * The card's whole content, for the focused view. `lines` is the glance —
   * three rows, what the deck shows. `all` is the read: every cart item,
   * every past order, reachable by clicking into the card and scrolling.
   * Absent means the glance already is the whole content.
   */
  all?: string[];
};

/** What the focused view scrolls through: the full content when there is
 *  more, the glance when the glance is everything. */
export function allLines(card: Card): string[] {
  return card.all?.length ? card.all : card.lines.filter(Boolean);
}

export function cueOf(payload: DisplayPayload): Cue {
  if (payload.cue?.lines?.length) return payload.cue;
  return { lines: (payload.lines || []).slice(0, CUE_LINES).map(toDisplayText) };
}

/** Whole units on the glass — decimals are punctuation. */
export function money(v?: number): string {
  return typeof v === "number" ? `$${Math.round(v).toLocaleString()}` : "";
}

/**
 * Hard-wrap, because **wrapping is lossless and truncation is not.**
 *
 * That distinction is the whole rule for what goes on a card. A clipped
 * product name is still recognisable — an associate reads "MID RISE VINTAGE
 * SLIM+" and knows the jean. A clipped postcode or email address is not a
 * shorter answer, it is a *wrong* one, and it is wrong in the way that gets
 * read out loud to a customer with confidence.
 *
 * So anything that has to be transcribable wraps, and anything that only has
 * to be recognisable may truncate.
 *
 * The width is pixels and the break points are measured. It used to be a
 * character count, which on a proportional font meant `Rancho Santa Margarita`
 * and `IIIIIIIIIIIIIIIIIIIIII` were wrapped identically — one of them into
 * lines that overflowed the box and were clipped by the glass, which is the
 * failure this function exists to avoid.
 */
export function wrap(text: string, maxPx: number): string[] {
  return wrapPx(String(text || ""), maxPx);
}

/**
 * An address, folded to three lines that fit.
 *
 * The naive version — street, apartment, "city state zip" — truncates the
 * third line on anything longer than "San Francisco CA 94103", which costs
 * the last digits of the postcode. A truncated product name is still
 * recognisable; **a truncated postcode is wrong**, and an associate reading it
 * back to a customer would be confidently wrong, which is worse than blank.
 *
 * So the apartment is the line that gives way. It is the least load-bearing
 * part of an address on a shop floor, where this is being read out to confirm
 * a delivery rather than to write a label.
 */
export function addressLines(a: any): string[] {
  const street = String(a.line1 || "").trim();
  const unit = String(a.line2 || "").trim();
  const region = String(a.line3 || "").trim();
  // A card sits beside the rail, so it draws in the module column. Whether a
  // line fits is measured against that box, never counted.
  const fits = (t: string) => fitsPx(t, RAIL_LINE_PX);

  if (fits(region)) {
    return [street, unit, region].filter(Boolean).slice(0, CUE_LINES);
  }
  // Region too long: split it, and spend the apartment's line on doing so.
  // The tail — state and postcode — is the part that must stay whole, so it
  // takes the last line and the city gives way above it.
  const parts = region.split(" ");
  const tail = parts.slice(-2).join(" ");           // "CA 94103"
  const city = parts.slice(0, -2).join(" ");        // "San Francisco"
  return [street, city, tail].filter(Boolean).slice(0, CUE_LINES);
}

/**
 * Contact details, folded the same way and for the same reason.
 *
 * An email is the worst case on this display: truncation gets you
 * "sarah.chen@example.c" and a "+", which is not an email address — it is a
 * thing that looks like one and is not. Split at the @ instead, so both halves
 * are whole and someone can read them out.
 */
export function contactLines(c: any): string[] {
  const email = String(c.email || "").trim();
  const phone = String(c.phone || "").trim();
  const lines: string[] = [];
  if (email) {
    // Prefer the @ as the break, because it is where a person's eye expects
    // one. Fall back to a hard wrap when either half is still too long.
    const at = email.lastIndexOf("@");
    const parts = fitsPx(email, RAIL_LINE_PX) ? [email]
      : at > 0 ? [email.slice(0, at), email.slice(at)]
      : [email];
    for (const part of parts) lines.push(...wrap(part, RAIL_LINE_PX));
  }
  if (phone) lines.push(phone);
  return lines.slice(0, CUE_LINES);
}

export function cardsFor(payload: DisplayPayload): Card[] {
  const g = (payload.guest || {}) as any;
  const out: Card[] = [{ kind: "CUE", lines: cueOf(payload).lines }];

  const sizes = g.sizes || {};
  const sizeLines = [
    sizes.tops ? `TOP ${sizes.tops}` : "",
    sizes.bottoms ? `BOTTOM ${sizes.bottoms}` : "",
    sizes.outerwear ? `OUTER ${sizes.outerwear}` : "",
  ].filter(Boolean);
  if (sizeLines.length) {
    out.push({ kind: "SIZES", lines: sizeLines, meta: [g.tier || ""].filter(Boolean) });
  }

  const cart = g.open_cart_online || [];
  if (cart.length) {
    out.push({
      kind: "CART",
      lines: cart.slice(0, 3).map((i: any) => i.name),
      // The whole cart, price beside each item. Truncation used to be the
      // only answer to a fourth item; a scrollable card makes it a window.
      all: cart.map((i: any) =>
        [i.name, money(i.price)].filter(Boolean).join(" ")),
      meta: [money(cart.reduce((t: number, i: any) => t + (i.price || 0), 0)),
             "ONLINE"].filter(Boolean),
    });
  }

  const bought = g.purchase_history || [];
  const orders = g.orders || {};
  if (bought.length || orders.count) {
    out.push({
      kind: "HISTORY",
      lines: bought.slice(0, 3).map((i: any) => i.name),
      all: bought.map((i: any) => i.name),
      meta: [
        orders.count ? `${orders.count} ORDERS` : "",
        orders.last_at ? `LAST ${orders.last_at}` : "",
      ].filter(Boolean),
    });
  }

  const addr = g.address || {};
  if (addr.line1) {
    out.push({ kind: "SHIP", lines: addressLines(addr),
               meta: [addr.country || ""].filter(Boolean) });
  }

  const c = g.contact || {};
  if (c.email || c.phone) {
    // Email before phone: an associate is far more likely to be confirming
    // "is this still the right address for your receipt" than dialling.
    out.push({ kind: "CONTACT", lines: contactLines(c) });
  }

  (payload.recommendations || []).forEach((r) => {
    out.push({
      kind: "PICK",
      lines: [r.name, r.location || "", ""],
      meta: [money(r.price),
             typeof r.stock === "number" ? `${r.stock} ON HAND` : ""].filter(Boolean),
      sku: r.sku,
    });
  });

  return out;
}
