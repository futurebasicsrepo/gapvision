/**
 * The hero rail — the one place this display gets big type, and how.
 *
 * There is no font control on the G2. Text containers draw one glyph size
 * (`ROW_H = 26` is the floor, measured on glass) and the SDK serialises no
 * font field, so every *text* row on the lens is one size, forever. The apps
 * that look typographically alive on this hardware — the Weather dashboard's
 * dotted-LED temperature, Navigaze's speed numeral — all do the same thing:
 * they draw their display type as pixels and ship it as an image container.
 *
 * This module is that lever for CueSea. It renders a dotted 5×7 face —
 * deliberately the same construction as Doto, the brand's lens face — into a
 * greyscale buffer, alongside pixel-art garment icons on even-toolkit's
 * 2px-unit grid, and hands back PNG bytes for `updateImageRawData`.
 *
 * The sizes are the payload. A shirt above trousers, each carrying the
 * guest's size in type three times the height of a text row, is the rail
 * saying the one thing an associate reaches for mid-sentence — and saying it
 * at a glance instead of a read.
 *
 * Everything here is pure pixels: no canvas, no DOM, testable in node. The
 * *decision* to use it latches off the first time the host refuses an image,
 * exactly like the mark — see `useHeroRail` in main.ts. The text rail remains
 * the fallback, so the failure mode is the 0.2.0 lens, never a hole.
 */
import { grayPng } from "./png";

/** Brightness levels, on the 4-bit grid the glass actually has. */
const INK = 255;        // the value itself — peak, like the cue lines
const INK_DIM = 136;    // icons — present, not competing

/**
 * A 5×7 dot face. Each glyph is seven rows of five bits, drawn as square
 * dots with a one-pixel gap — the LED construction that survives monochrome,
 * low resolution and a 25° field better than any outline font could.
 */
const DOT_FONT: Record<string, number[]> = {
  "0": [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  "1": [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  "2": [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  "3": [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  "4": [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  "5": [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  "6": [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  "7": [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  "8": [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  "9": [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11100, 0b10010, 0b10001, 0b10001, 0b10001, 0b10010, 0b11100],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b10101, 0b01010],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  "/": [0b00001, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b10000],
  "-": [0b00000, 0b00000, 0b00000, 0b01110, 0b00000, 0b00000, 0b00000],
  "·": [0b00000, 0b00000, 0b00000, 0b00100, 0b00000, 0b00000, 0b00000],
  $: [0b00100, 0b01111, 0b10100, 0b01110, 0b00101, 0b11110, 0b00100],
  "%": [0b11001, 0b11010, 0b00010, 0b00100, 0b01000, 0b01011, 0b10011],
  " ": [0, 0, 0, 0, 0, 0, 0],
};

/**
 * Garment icons, 16×16, drawn on even-toolkit's grid discipline (their 191
 * icons are 32×32 in 2×2px units — a 16×16 cell map is the same drawing).
 * even-toolkit itself has no apparel icons — its nearest is a storefront —
 * so these two are ours, in the same construction so a future icon from
 * their set sits beside them without a style seam.
 */
const SHIRT: string[] = [
  "................",
  ".#####....#####.",
  "################",
  "################",
  "###.########.###",
  "##..########..##",
  "....########....",
  "....########....",
  "....########....",
  "....########....",
  "....########....",
  "....########....",
  "....########....",
  "....########....",
  "....########....",
  "................",
];

const PANTS: string[] = [
  "................",
  ".##############.",
  ".##############.",
  ".##############.",
  ".######..######.",
  ".######..######.",
  ".#####....#####.",
  ".#####....#####.",
  ".#####....#####.",
  ".#####....#####.",
  ".#####....#####.",
  ".#####....#####.",
  ".#####....#####.",
  ".#####....#####.",
  ".#####....#####.",
  "................",
];

class Gray {
  readonly pix: Uint8Array;
  constructor(readonly w: number, readonly h: number) {
    this.pix = new Uint8Array(w * h);
  }
  set(x: number, y: number, v: number) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.pix[y * this.w + x] = v;
  }
  rect(x: number, y: number, w: number, h: number, v: number) {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) this.set(x + dx, y + dy, v);
  }
}

/** Width of `text` in the dot face at dot size `dot` (gap is always 1px). */
export function dotTextWidth(text: string, dot: number): number {
  const cell = dot + 1;
  const chars = [...String(text ?? "")].length;
  if (!chars) return 0;
  return chars * 5 * cell + (chars - 1) * cell;
}

/** Glyph height at dot size `dot`: seven dot rows, six gaps. */
export function dotTextHeight(dot: number): number {
  return 7 * dot + 6;
}

function drawDots(g: Gray, text: string, x: number, y: number, dot: number, ink = INK) {
  const cell = dot + 1;
  let at = x;
  for (const ch of String(text ?? "").toUpperCase()) {
    const glyph = DOT_FONT[ch];
    if (glyph) {
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (glyph[row] & (1 << (4 - col))) g.rect(at + col * cell, y + row * cell, dot, dot, ink);
        }
      }
    }
    at += 6 * cell;   // five columns and one column of air
  }
}

function drawIcon(g: Gray, rows: string[], x: number, y: number, scale: number, ink = INK_DIM) {
  rows.forEach((row, ry) => {
    [...row].forEach((ch, rx) => {
      if (ch === "#") g.rect(x + rx * scale, y + ry * scale, scale, scale, ink);
    });
  });
}

/**
 * The largest dot size from `max` down at which `text` fits `maxPx` — the
 * same shape as `truncatePx`, except type this large shrinks rather than
 * truncates: `28X30+` is not a size, and a smaller whole value beats a
 * larger wrong one.
 */
function dotFit(text: string, maxPx: number, max: number): number {
  for (let dot = max; dot > 1; dot--) {
    if (dotTextWidth(text, dot) <= maxPx) return dot;
  }
  return 1;
}

/** The hero rail's fixed pixel size. Fixed, because an image container whose
 *  size followed its content would change the page shape on every guest.
 *  144 is the host's ceiling for an image, and the third band earns it. */
export const HERO_W = 160;
export const HERO_H = 144;

/**
 * Compose the hero rail: shirt icon beside the top size, trousers beside the
 * bottom size, values in dot type at up to three times a text row's height —
 * and a stat band underneath, the Weather-dashboard construction: the figure
 * big and bright, its unit small and dim beside it (`4200 ᴾᵀˢ`). A stat of
 * `""` leaves the band dark, which is what "points switched off" looks like.
 *
 * Missing size values draw a dash rather than nothing: an empty slot beside
 * an icon reads as the renderer failing, a dash reads as "not on file".
 */
export function heroRail(topValue: string, btmValue: string, stat = ""): Uint8Array {
  const g = new Gray(HERO_W, HERO_H);
  const top = String(topValue || "-").toUpperCase();
  const btm = String(btmValue || "-").toUpperCase();

  const ICON = 32;           // 16×16 at even-toolkit's 2px unit
  const VALUE_X = 44;
  const width = HERO_W - VALUE_X;

  // Each group: the value at the biggest dot that fits, and whichever of the
  // pair is shorter centred against the taller.
  const group = (icon: string[], value: string, y: number) => {
    const dot = dotFit(value, width, 5);
    const valueH = dotTextHeight(dot);
    const groupH = Math.max(ICON, valueH);
    drawIcon(g, icon, 0, y + Math.round((groupH - ICON) / 2), 2);
    drawDots(g, value, VALUE_X, y + Math.round((groupH - valueH) / 2), dot);
    return groupH;
  };

  const topH = group(SHIRT, top, 0);
  group(PANTS, btm, Math.max(52, topH + 11));
  drawStat(g, stat);

  return grayPng(HERO_W, HERO_H, g.pix);
}

function drawStat(g: Gray, stat: string) {
  // The stat band: split the figure from its unit at the last space, draw
  // the figure at dot 3 and the unit at dot 2, dim, sharing the baseline.
  const s = String(stat || "").toUpperCase().trim();
  if (s) {
    const at = s.lastIndexOf(" ");
    const value = at > 0 ? s.slice(0, at) : s;
    const unit = at > 0 ? s.slice(at + 1) : "";
    const y = 108;
    const dot = dotFit(value, unit ? HERO_W - dotTextWidth(unit, 2) - 8 : HERO_W, 3);
    drawDots(g, value, 0, y + dotTextHeight(3) - dotTextHeight(dot), dot);
    if (unit) {
      drawDots(g, unit, dotTextWidth(value, dot) + 8,
               y + dotTextHeight(3) - dotTextHeight(2), 2, INK_DIM);
    }
  }
}

/**
 * The idle clock, in dot type at twice the hero's size — the Simple HUD
 * move. The lens's first impression is the idle screen, and a display whose
 * resting state is three rows of 26px text reads as a terminal; a display
 * resting on a 48px dotted clock reads as an instrument.
 *
 * Fixed size (the dot face is monospaced, and the clock is always five
 * glyphs), so the container never changes shape with the minutes.
 */
const CLOCK_DOT = 6;
export const CLOCK_HERO_W = dotTextWidth("88·88", CLOCK_DOT);
export const CLOCK_HERO_H = dotTextHeight(CLOCK_DOT);

export function heroClock(clock: string): Uint8Array {
  const g = new Gray(CLOCK_HERO_W, CLOCK_HERO_H);
  const text = [...String(clock || "").toUpperCase()].slice(0, 5).join("");
  drawDots(g, text, Math.max(0, Math.round((CLOCK_HERO_W - dotTextWidth(text, CLOCK_DOT)) / 2)),
           0, CLOCK_DOT);
  return grayPng(CLOCK_HERO_W, CLOCK_HERO_H, g.pix);
}
