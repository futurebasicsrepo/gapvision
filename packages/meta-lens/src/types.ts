/**
 * The display contract — the same payload the realtime server already sends
 * the Even plugin over `glasses:display`. This package treats every field as
 * optional and degrades to the cue lines alone, so server evolution never
 * breaks the lens.
 *
 * NOTE for the extraction pass: `Card`, `cueOf`, `cardsFor` mirror
 * packages/glasses-plugin/src/cards.ts (0.3.x). When this package lands in
 * the monorepo, lift the shared shapes into packages/lens-core and import
 * from there in both plugins — the logic must not fork.
 */

export type CardKind = "CUE" | "CART" | "HISTORY" | "SIZES" | "FLOOR";

export interface Card {
  kind: CardKind;
  /** The three lines shown while browsing. */
  lines: string[];
  /** Full scrollable content once clicked in (falls back to lines). */
  all?: string[];
  /** The meta strip under the body — facts joined by interpuncts. */
  meta?: string[];
}

export interface Cue {
  lines: string[];
}

export interface DisplayPayload {
  /** Pre-formatted cue (the AI service's glass grammar). */
  cue?: Cue;
  /** Legacy pre-formatted lines (v0.2 servers). */
  lines?: string[];
  guest?: {
    name?: string;
    tier?: string;
    points?: number;
    sizes?: { tops?: string; bottoms?: string; outerwear?: string };
    open_cart?: { name: string; price?: number }[];
    purchase_history?: { name: string; price?: number }[];
    orders?: { count?: number; last_at?: string };
  };
  recommendations?: { name: string; price?: number; location?: string }[];
  zone?: string;
  latency_s?: number;
}
