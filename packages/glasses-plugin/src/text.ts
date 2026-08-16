/**
 * What the G2 will actually draw, and how wide it will be.
 *
 * This module exists because every character budget in this plugin used to be
 * a guess, and the guess had a specific shape: one ratio, `CHAR_ASPECT = 0.60`,
 * "glyph advance as a fraction of container height", multiplied by a character
 * count. That model has exactly one thing wrong with it and it is fatal —
 * **the G2's font is proportional.** Measured through Even's own font tables:
 *
 *     MAYA OKAFOR   127px   11 characters
 *     IIIIIIIIIII    56px   11 characters
 *     WWWWWWWWWWW   176px   11 characters
 *
 * An eleven-character string spans 56–176px, a 3.1× range, and a character
 * budget calls all three of those the same size. It is simultaneously far too
 * generous for a wide string — which is the "font is cut off" fault three
 * releases chased, because the host does not shrink text that overflows its
 * box, it clips it — and far too mean for an ordinary name, which is why
 * `MAYA OKAFOR` was being shortened to `MAYA O` beside a rail it fits inside
 * with 29px to spare.
 *
 * So nothing here estimates. `@evenrealities/pretext` is Even Realities' own
 * measurement package (MIT, zero dependencies, one file): it carries the
 * metrics extracted from the LVGL fonts in the G2 firmware, follows EvenHub's
 * real fallback chain, and mirrors LVGL's per-glyph rounding and kerning. When
 * it says a string is 127px wide, that is the number the firmware will lay out.
 *
 * **What is still unmeasured, and must stay stated:** pretext describes one
 * font at one size. It has no opinion about container height, and neither this
 * module nor `layout.ts` has any way to ask what the host does when a box is
 * smaller than a glyph. `ROW_H = 26` remains what it always was — read off the
 * glass by a person, on the ruler page. See `layout.ts`.
 */
import { getAdvW, getTextWidth } from "@evenrealities/pretext";

/**
 * The glyphs the lens is allowed to draw — as candidates, not as an answer.
 *
 * The list below is what we would *like* to use. What is actually permitted is
 * whatever survives `deriveCharset()`, which asks the font tables for each
 * one's advance width and drops anything the firmware has no glyph for. That
 * indirection is the entire point of having a charset: a hand-maintained
 * literal is a promise about a font nobody re-checks, and the failure it hides
 * is a lit hole in the middle of a word on somebody's face.
 *
 * Grouped by what each group is for, because the groups have different rules:
 * the first three are the cue's own vocabulary and the brand governs them; the
 * last two are structure and state, and they exist because the font turned out
 * to have them.
 */
export const CANDIDATE_GLYPHS = {
  /** The sentence. Uppercase only — dot-matrix lowercase loses legibility at
   *  this resolution, which is a brand rule and not a font limitation. */
  letters: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  digits: "0123456789",
  /**
   * Space, money, and the interpunct.
   *
   * The interpunct is the only separator the identity system allows: commas
   * and full stops eat pixels and read as artefacts. Note that this is a
   * *brand* rule — the font has a comma, a full stop and a colon, all three
   * with real advances. We decline them; they are not missing.
   */
  punctuation: " ·%$£€/+-",
  /**
   * Box drawing, for structure.
   *
   * Verified present at 20px advance (320 sixteenths). These are what let the
   * rail/module split and the footer be a drawn rule rather than an absence of
   * pixels — see `buildRule` in `layout.ts`. `┬ ┴ ┼` are here because a rule
   * that meets a column boundary should say so with a junction glyph, which is
   * what box drawing is for.
   */
  rules: "─│┌┐└┘├┤┬┴┼━┃═",
  /**
   * Blocks and marks, for state.
   *
   * `█` and `▒` are the voice indicator's two states and the level meter's
   * filled and empty cells — both 20px, so a meter drawn from them has a fixed
   * width and a state light drawn from them never moves the clock beside it.
   * `→ · •` carry direction and separation.
   */
  marks: "█▌▒■★→•",
} as const;

/**
 * Glyphs asked for and refused by the firmware font, if any.
 *
 * Empty today. It is exported so a test can assert it stays empty rather than
 * discovering the loss on hardware: a glyph that vanishes from a future font
 * build should fail a suite here, not render as a gap in a cue.
 *
 * Known-absent glyphs — `║ ░ ▸ ✓ ▮`, all advance 0 — are deliberately not in
 * the candidate list. They are recorded in the charset test instead, so that
 * "we checked and it isn't there" is written down somewhere rather than
 * rediscovered by someone reaching for a tick mark.
 */
export const MISSING_GLYPHS: string[] = [];

/**
 * Ask the font which of the candidates it has.
 *
 * `getAdvW` returns the raw advance in 1/16px straight out of the extracted
 * font tables, and a codepoint with no glyph anywhere in the fallback chain
 * comes back 0. That is the test, and it is a fact about the firmware rather
 * than about our intentions.
 */
function deriveCharset(): string {
  const out: string[] = [];
  for (const group of Object.values(CANDIDATE_GLYPHS)) {
    for (const ch of group) {
      if (getAdvW(ch.codePointAt(0)!) > 0) out.push(ch);
      else MISSING_GLYPHS.push(ch);
    }
  }
  return out.join("");
}

/** Every character the lens may put on the glass, measured. */
export const GLASS_CHARS = deriveCharset();

/** Matches anything `GLASS_CHARS` does not contain. Built from the derived
 *  set, so it narrows by itself if the font ever loses a glyph. */
export const NOT_GLASS = new RegExp(
  `[^${GLASS_CHARS.replace(/[\\\]^-]/g, "\\$&")}]`,
  "g",
);

/** Advance width in whole pixels, with kerning — what the firmware will lay
 *  out for this exact string. */
export function textWidth(text: string): number {
  return getTextWidth(String(text ?? ""));
}

export function fitsPx(text: string, maxPx: number): boolean {
  return textWidth(text) <= maxPx;
}

/**
 * The marker a truncated line ends with.
 *
 * `+`, not `…` and not `...`. The ellipsis is not in the font, and a full stop
 * is not in the charset — `pxTruncate` from pretext appends `'...'`, which
 * would be filtered back out on the way to the glass and leave a line that
 * looks complete and is not. So the fitting is ours, the metrics are theirs.
 */
export const TRUNCATION_MARK = "+";

/**
 * The longest prefix of `text` that fits `maxPx`, marked if anything was lost.
 *
 * Binary search over codepoints, measuring each candidate, because the
 * relationship between characters and pixels is exactly the thing this module
 * exists to stop anyone assuming. Trailing space is trimmed before the mark so
 * a cut at a word boundary does not read as a gap.
 */
export function truncatePx(text: string, maxPx: number, mark = TRUNCATION_MARK): string {
  const s = String(text ?? "");
  if (fitsPx(s, maxPx)) return s;
  const chars = [...s];
  const markPx = textWidth(mark);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(chars.slice(0, mid).join("").trimEnd()) + markPx <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  const kept = chars.slice(0, lo).join("").trimEnd();
  // A box too narrow for one character and a mark is a layout fault, not a
  // string to solve: return the mark alone rather than an empty row that says
  // nothing about why.
  if (!kept) return mark;
  // Never two marks. A line can pass through a fit twice — once written to the
  // full frame, once to the module column beside a rail — and `WORD++` reads
  // as a rendering fault rather than as "there was more".
  return kept.endsWith(mark) ? kept : kept + mark;
}

/**
 * Hard-wrap to as many lines as it takes, by measurement.
 *
 * Used where truncation would be *wrong* rather than short — a postcode, an
 * email address. See `cards.ts` for why that distinction decides the shape of
 * a card.
 */
export function wrapPx(text: string, maxPx: number): string[] {
  const s = String(text ?? "");
  if (!s) return [];
  if (fitsPx(s, maxPx)) return [s];
  const chars = [...s];
  const out: string[] = [];
  let line = "";
  for (const ch of chars) {
    if (line && !fitsPx(line + ch, maxPx)) {
      out.push(line);
      line = "";
    }
    line += ch;
  }
  if (line) out.push(line);
  return out;
}

/**
 * Wrap on word boundaries where there is one, and hard-wrap where there isn't.
 *
 * The difference matters for anything a person reads aloud: a street address
 * broken mid-word reads as a fault, while an email address has no word
 * boundaries to respect and must break wherever it must.
 */
export function wrapWordsPx(text: string, maxPx: number): string[] {
  const words = String(text ?? "").split(" ").filter(Boolean);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (fitsPx(candidate, maxPx)) { line = candidate; continue; }
    if (line) { out.push(line); line = ""; }
    if (fitsPx(w, maxPx)) { line = w; continue; }
    const parts = wrapPx(w, maxPx);
    out.push(...parts.slice(0, -1));
    line = parts[parts.length - 1] ?? "";
  }
  if (line) out.push(line);
  return out;
}

/**
 * A run of one glyph, as wide as it can be without passing `maxPx`.
 *
 * The rule glyphs are all 20px, so this could be division — it is measurement
 * anyway, because "all the box-drawing glyphs are one width" is exactly the
 * kind of true-today fact that this whole module exists because of.
 */
export function repeatToWidth(glyph: string, maxPx: number): string {
  const unit = textWidth(glyph);
  if (unit <= 0) return "";
  let n = Math.floor(maxPx / unit);
  while (n > 0 && !fitsPx(glyph.repeat(n), maxPx)) n--;
  return glyph.repeat(Math.max(0, n));
}
