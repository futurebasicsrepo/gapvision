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

export type CardKind = "CUE" | "CART" | "HISTORY" | "SIZES" | "SHOW" | "FLOOR";

/** Lens rendering mode. `classic` is the G2 grammar 1:1 — text, hud green,
 *  no imagery. `meta` is the richer surface: icons, the mark, color, product
 *  images. The deck vocabulary is shared; `meta` additionally deals SHOW. */
export type LensMode = "classic" | "meta";

export interface Card {
  kind: CardKind;
  /** The three lines shown while browsing. */
  lines: string[];
  /** Full scrollable content once clicked in (falls back to lines). */
  all?: string[];
  /** The meta strip under the body — facts joined by interpuncts. */
  meta?: string[];
  /** Meta mode only: HTTPS thumbnails, row-aligned with lines/all. */
  images?: (string | undefined)[];
  /** Meta mode only: one large hero image for the card (SHOW). */
  heroImage?: string;
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
    open_cart?: { name: string; price?: number; image?: string }[];
    purchase_history?: { name: string; price?: number; image?: string }[];
    orders?: { count?: number; last_at?: string };
  };
  /** `image` is new for meta mode — the Shopify adapter has featuredImage a
   *  field away; classic surfaces ignore it. Always HTTPS (CDN) URLs. */
  recommendations?: { name: string; price?: number; location?: string; image?: string; stock?: number }[];
  zone?: string;
  latency_s?: number;
}
