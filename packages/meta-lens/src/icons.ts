/**
 * The icon set — inline SVG, no network, no font. Meta mode's rule is
 * "default to icons and logos when we can"; classic mode uses none of these
 * (it is the G2 grammar, 1:1).
 *
 * The mark is the Cue Bracket from the brand construction spec: a ring with
 * a 70° gap on the 3 o'clock axis and the flame cue at optical centre.
 * Colors ride CSS custom properties (--hud-500, --sea-400, --flame) so the
 * same geometry serves both modes and future themes. On merge, reconcile
 * exact hex values with packages/web/src/brand.css — that file owns them.
 */

const svg = (body: string, viewBox = "0 0 32 32") =>
  `<svg viewBox="${viewBox}" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;

/** Ring r=11 on a 32-grid, 70° gap centred on 3 o'clock, flame at centre. */
export const MARK = svg(
  `<path d="M 25.34 9.65 A 11 11 0 1 0 25.34 22.35" stroke="var(--hud-500)" stroke-width="3" stroke-linecap="round"/>
   <circle cx="16" cy="16" r="3.2" fill="var(--flame)"/>`
);

export const SHIRT = svg(
  `<path d="M11 5 L16 8 L21 5 L27 9 L24 14 L22 12 V27 H10 V12 L8 14 L5 9 Z"
     stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`
);

export const TROUSERS = svg(
  `<path d="M10 5 H22 V10 L20 27 H17 L16 14 L15 27 H12 L10 10 Z"
     stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`
);

export const STAR = svg(
  `<path d="M16 4 L19.5 12.2 L28 13 L21.6 18.8 L23.6 27 L16 22.6 L8.4 27 L10.4 18.8 L4 13 L12.5 12.2 Z"
     fill="currentColor"/>`
);

export const CART = svg(
  `<path d="M5 7 H9 L12 21 H24 L27 11 H10" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
   <circle cx="13.5" cy="25.5" r="2" fill="currentColor"/>
   <circle cx="22.5" cy="25.5" r="2" fill="currentColor"/>`
);

export const HISTORY = svg(
  `<circle cx="16" cy="16" r="11" stroke="currentColor" stroke-width="2"/>
   <path d="M16 9 V16 L21 19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`
);

export const PIN = svg(
  `<path d="M16 4 A 8 8 0 0 1 24 12 C 24 18 16 28 16 28 C 16 28 8 18 8 12 A 8 8 0 0 1 16 4 Z"
     stroke="currentColor" stroke-width="2"/>
   <circle cx="16" cy="12" r="3" fill="currentColor"/>`
);

export const RADIO = svg(
  `<circle cx="16" cy="16" r="3" fill="currentColor"/>
   <path d="M9 9 A 10 10 0 0 0 9 23 M23 9 A 10 10 0 0 1 23 23" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`
);

export const CARD_ICON: Record<string, string> = {
  CART, HISTORY, SIZES: SHIRT, FLOOR: RADIO, SHOW: PIN,
};
