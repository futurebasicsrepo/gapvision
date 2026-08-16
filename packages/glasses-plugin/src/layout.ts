/**
 * CueSea Lens — the cue, as the glass renders it.
 *
 * The identity system specifies this surface tighter than anything else in
 * the product, and the constraint is the point:
 *
 *   Mark + clock    hud-300, the header row. The mark is the one piece of
 *                   brand on the glass; the clock is what an associate
 *                   mid-shift actually looks up. Latency moved to the footer,
 *                   where it stays a visible claim without owning a corner.
 *   Three lines     hud-500 at full brightness. The only peak-brightness
 *                   element on the display. Name, evidence, reason to speak.
 *   Fact rail       hud-300, fixed on the left while the module scrolls on
 *                   the right — the shape Even's own dashboard uses.
 *   Meta strip      hud-300. Three facts that support the sentence and never
 *                   compete with it.
 *   Absent          no buttons, no chrome, no icons. Confirmation is a temple
 *                   tap; dismissal is a look away.
 *
 * The G2's geometry is not one number, and this file used to assume it was.
 * From Even's own hardware tables: **576 × 288 per eye** is the physical
 * display — the real render target, and the default here — while the ~640 ×
 * 200 in the marketing specs is the optical panel configuration. The native
 * dashboard is a *fixed-size context canvas per surface view*, not a pixel
 * space that varies as you go: each surface has a size, and there are several
 * surfaces at once.
 *
 * So the geometry is a function, not a constant. `createGeometry(w, h)` takes
 * a frame and returns everything derived from it; every named export below is
 * that function applied to 576 × 288. The grammar is identical on any of them
 * — only the numbers change — which is what makes 640 × 200 an argument rather
 * than an edit to this file.
 *
 * The split that makes it work, and the thing to preserve if you touch this:
 * **positions and widths are fractions of the frame; row height, padding and
 * the type floor are absolute pixels.** The rows are absolute because the host
 * has a floor under how small it will draw a glyph (see `ROW_H`), and a frame
 * being shorter does not move that floor — it just means fewer rows fit.
 *
 * **And the horizontal half is now measured rather than modelled.** Every
 * budget below is a number of pixels, and whether a string fits one is asked
 * of Even's own font tables through `text.ts` — never of a character count.
 * The font is proportional; a character count cannot describe it. That change
 * is the reason several of the comments in this file read as corrections.
 */
import type { ImageContainer, ListContainer, PageSpec, TextContainer } from "./bridge";
import { CLOCK_HERO_H, CLOCK_HERO_W, HERO_H, HERO_W } from "./hero";
import { MARK_H, MARK_W } from "./mark";
import { NOT_GLASS, fitsPx, textWidth, truncatePx } from "./text";

/**
 * What the glass may draw, re-exported from where it is measured.
 *
 * This module is what everything else imports to put something on the display,
 * so the charset belongs on its surface even though the derivation lives in
 * `text.ts` — and `geometry.test.mjs` asserts against these rather than
 * against a copy of the list.
 */
export { GLASS_CHARS, MISSING_GLYPHS } from "./text";

/**
 * The host's hard budgets, kept beside the code that has to respect them.
 *
 * From the SDK: `Text_Object` max_count 8, `Image_Object` max_count 4,
 * `ContainerTotalNum` 1–12 across all kinds. Exceeding any of them does not
 * error — the page simply never renders, and nothing says why.
 */
export const MAX_TEXT_CONTAINERS = 8;
export const MAX_IMAGE_CONTAINERS = 4;
export const MAX_TOTAL_CONTAINERS = 12;

/**
 * The default frame: the G2's physical display, 576 × 288 per eye.
 *
 * This is the render target, not the only one — see `createGeometry`. It is
 * the default because it is the surface the glasses actually draw, and every
 * number in this file was measured on it.
 */
export const DEFAULT_FRAME_W = 576;
export const DEFAULT_FRAME_H = 288;

/** Three lines is the contract. A fourth is a bug, not an overflow. */
export const CUE_LINES = 3;
/**
 * The most rows the fact rail will ever draw, however tall the frame is.
 *
 * Five now, not six: the guest's name left the rail for its own container
 * (`cue-name`), because the rail's usual form is the hero image and a name
 * belongs in the proportional text face, not the dot face. What remains for
 * the *text* rail — the fallback when the host refuses images — is tier,
 * the two sizes, points and the unread count. This stays a cap on content,
 * not on space; `FACT_SLOTS` still answers what actually fits.
 */
const FACT_SLOTS_MAX = 5;
/**
 * Same idea for the floor menu: six rows is the design, fewer if they don't
 * fit. Longer lists window around the selection rather than scrolling the
 * container, so whatever this comes out as, the selected row is on the glass.
 */
const MENU_ROWS_MAX = 6;

/**
 * Budgets are pixels, and fitting is measurement. Here is what that replaced.
 *
 * **First generation — chosen numbers.** 60 characters per line, 42 with a
 * rail, 17 per fact. They were chosen when the containers were 38 and 44
 * pixels tall, and once height became the type control they meant nothing: the
 * rail shipped rows needing 178px in a 148px box, and the glass renders that
 * by clipping. "Font is cut off" was this.
 *
 * **Second generation — one ratio, `CHAR_ASPECT = 0.60`.** Glyph advance as a
 * fraction of container height, measured off the *preview* render (0.57 at
 * 24px, 0.60 at 28px, taken at the worst case), with `fitChars(width, height)`
 * turning a box into a character count. It was a real improvement — the
 * budgets moved together and stopped being folklore — and it was still wrong
 * in a way no amount of calibrating it could fix.
 *
 * **The G2's font is proportional.** From Even's own font-metric package:
 *
 *     MAYA OKAFOR   127px   11 chars      the 0.60 model budgets 172px
 *     IIIIIIIIIII    56px   11 chars
 *     WWWWWWWWWWW   176px   11 chars      the 0.60 model says this fits 156px
 *
 * Eleven characters is anywhere between 56 and 176 pixels, a 3.1× range, and a
 * character budget calls all three identical. So the ratio was simultaneously
 * far too generous for a wide string — still clipping words, which is the
 * fault it was introduced to end — and far too mean for an ordinary name:
 * `MAYA OKAFOR` fits the 168px rail with 29px to spare and was being shortened
 * to `MAYA O` for nothing. It also settles the "10 versus 12 characters" rail
 * argument by dissolving it; see `RAIL_FRACTION`.
 *
 * So there is no ratio any more. Each region carries the **pixel width it has
 * to draw in**, and `text.ts` asks the firmware's own metrics whether a given
 * string fits it. `fitChars` is gone with `CHAR_ASPECT`: nothing in this
 * codebase needs a character estimate now that a string can be measured, and
 * anything reintroducing one would be reintroducing the same fault.
 *
 * What has *not* changed is the vertical half. `ROW_H` is still 26 because a
 * person read it off the glass, and the font tables have nothing to say about
 * what the host does with a box shorter than a glyph.
 */

/**
 * The drawable width inside a container: its box, less the padding on both
 * sides, less any border.
 *
 * The old `fitChars` also subtracted a 4px safety margin, which was there to
 * absorb the error in the ratio. There is no error left to absorb — pretext
 * mirrors LVGL's per-glyph rounding and kerning — so the margin is gone and
 * the budget is the real number. That is where most of the extra room for
 * names came from.
 */
export function textBudget(width: number, padding = PAD, border = 0): number {
  return Math.max(0, width - (padding + border) * 2);
}

/**
 * The margin the whole frame sits inside, and the gap between the two columns.
 *
 * Absolute, like the padding and for the same reason: they are breathing room
 * around type whose size cannot change, so scaling them with the frame would
 * make them wrong on every frame but one.
 */
const X = 20;
const GUTTER = 14;

/**
 * Two regions, after the Even dashboard: a fact rail on the left that stays
 * put, and a module on the right that scrolling moves between.
 *
 * The rail costs the sentence about a third of its width. That is the real
 * price of this layout and the thing to judge on the glass. `cue.py` writes
 * the evidence line short to suit — but it no longer writes it to a budget,
 * because the service is Python and the font tables are JavaScript, so the
 * server cannot measure what it is writing. The contract is now "the server
 * writes short, the glass fits exactly", and the exact fitting happens here.
 *
 * 168 at 576 rather than 148 because at 148 the rail could not hold "BOTTOMS
 * 28X30" — the sizes are the reason the rail exists, and a rail that clips the
 * sizes is a rail that costs the sentence a third of its width for nothing.
 * That measurement is what fixes the fraction: 168/576 = 0.2917 of the frame.
 *
 * **The "168/10 vs 188/12" discrepancy, since it has been logged twice and is
 * now closed.** They were never two rails. 0.2917 of 640 is 187 — the site's
 * 188 is the same rail to within a pixel of rounding, so the *width* is one
 * fraction at two frames and there was never anything to reconcile there.
 *
 * The character counts were the half that was actually being argued about, and
 * the answer is that **both numbers were answering a question the font does
 * not have.** 10 and 12 are two ways of dividing a box by an average glyph;
 * the rail draws real names, and real names are 56–176px per eleven
 * characters. Measured, the rail's 156px of drawable width holds `MAYA OKAFOR`
 * (127px) whole with room left, and refuses `WWWWWWWWWWW` (176px) — which the
 * 12-character budget would have accepted and the glass would have clipped.
 * Nobody needed to widen anything; the rail was never the problem.
 *
 * The width stays 168 at 576 for the reason it was measured: the sizes are why
 * the rail exists, and `BOTTOMS 28X30` — 147px — has to arrive whole.
 */
const RAIL_FRACTION = 168 / DEFAULT_FRAME_W;

/**
 * Type size, such as it is.
 *
 * There is no font field. The complete container vocabulary the SDK
 * serialises is position, size, border, padding and content — nothing else.
 * Apps that appear to use different type sizes are using different container
 * heights: the host scales glyphs to the box. So `height` *is* the font
 * control, and everything below is one block because tuning it is going to
 * take a pass or two on real glass.
 *
 * Was 38/44 and unreadably large. Then 16 and 18, which Kyle read as "too
 * large for its container" and "cut off" — opposite descriptions of one
 * thing: **the host has a floor under how small it will draw a glyph, and a
 * box below that floor does not shrink the text, it clips it.** Then 24, and
 * the clock still lost its bottom edge.
 *
 * That was three builds of inferring a number from a sentence of feedback,
 * and two of the three inferences were wrong. So 0.1.8 shipped `buildRuler()`
 * — the same word at 20/24/26/28/32 on one screen — and Kyle read it off the
 * glass: **20 and 24 clip. 26, 28 and 32 are whole.**
 *
 * So the floor is 26, and 26 is where every row sits. Not 28: the standing
 * complaint has been that the supporting rows are too large, and 26 is the
 * smallest this display will draw whole. There is nothing below it to try.
 *
 * Which settles a design question too, and it is worth stating plainly rather
 * than discovering again: **the supporting rows cannot be smaller than the
 * sentence, because the sentence is already at the floor.** The type
 * hierarchy the brand asks for is not available on this hardware. Every row
 * is one size. What is still ours to choose is what earns a row at all.
 *
 * `buildRuler()` stays in the build. It cost one screen, it answered a
 * question three releases could not, and the next firmware may move the floor.
 *
 * **What the font tables added to this, 2026-08-16.** Even's own metrics
 * package describes *one* font at one size, with a fixed 27px line height —
 * there is no scale factor anywhere in it. That is evidence for a different
 * reading of the same measurement: the host may not be scaling glyphs to the
 * box at all. It may simply draw one size and clip whatever the box cannot
 * hold, which fits every observation in the table above exactly — 20 and 24
 * are under the glyph and clip; 26, 28 and 32 are over it and are whole, with
 * 28 and 32 differing only in leading. Nothing in that changes what to do:
 * **26 is still the floor and every row still sits on it.** It is written down
 * because the next person to reach for "make this row smaller" should know
 * that the lever may not exist rather than assuming it does, and because it
 * would take one screen on real glass to settle — the ruler already draws it.
 *
 * **And this is why `ROW_H` is not a fraction of anything.** Everything else
 * in this file scales with the frame; the row does not, because the floor it
 * sits on belongs to the host's renderer and not to the display. A row
 * computed as a fraction of a shorter frame would fall under 26 and the glass
 * would clip it, which is the exact fault this number was measured to end. A
 * shorter surface gets *fewer rows*, never smaller ones — see `FACT_SLOTS`.
 */
const ROW_H = 26;         // measured on glass, 2026-08-15
const HEADER_H = ROW_H;
const LINE_H = ROW_H;
const LINE_STEP = 32;     // baseline-to-baseline
const RAIL_ROW = ROW_H;
const META_H = ROW_H;
const PAD = 4;            // breathing room inside every box
/** The gap under a row: the footer's clearance from the bottom edge, and the
 *  menu title's from its list. Absolute, because it separates absolute rows. */
const ROW_GAP = 8;

/**
 * Vertical positions are absolute from the top, and that is a consequence
 * rather than a choice: the rows are absolute, so stacking them from the top
 * gives the same answer on every frame. Only the footer is anchored to the
 * bottom edge, so it is the one position that moves with the frame's height.
 */
const HEADER_Y = 12;

/** The header wordmark and the clock. Content-sized, so absolute — but the
 *  clock is *placed* against the right edge, which is not.
 *
 *  Boxes get a margin, not an exact fit. The clock sat in 90px when that was
 *  believed to be five characters' worth; measured, "14·32" is 47px and the
 *  box has 96px to draw in, which is what makes room for the voice indicator
 *  to share this container rather than cost a new one — see `headerStatus`. */
const LABEL_W = 64;
/**
 * Was 104, when this container held a mic glyph and the time. It is now the
 * status cluster — mic, unread count, low battery, clock — and the worst case
 * (`█ •9 18% 14·32`) measures ~150px. 176 gives it a margin, not an exact
 * fit. The content is right-aligned by measured space-padding (see
 * `headerStatus`), so the clock stays flush to the display's right edge and
 * never moves when a status glyph appears in front of it.
 */
const CLOCK_W = 176;

/**
 * The rail's hairline, and the padding inside it.
 *
 * `borderWidth` is a single scalar in the SDK — there is no per-edge control —
 * so what it draws is a rounded rectangle around the whole rail, which is a
 * panel, and a panel is chrome. The structure this layout actually wants is
 * one line saying where the fixed column ends, and that is drawn as a rule
 * (see `buildRule`). So the border is 0 and the rail keeps only its padding.
 */
const RAIL_BORDER = 0;
const RAIL_PAD = PAD + 2;

/**
 * The card frame.
 *
 * This is the reversal of an earlier ruling, and the ruling is worth keeping
 * next to its reversal. The rail's `borderWidth` was removed because what the
 * SDK draws — one scalar, a radius, no per-edge control — is a rounded
 * rectangle around the whole container: a panel, which on the *rail* is
 * chrome. On the module it is not chrome, it is the object itself. The right
 * side of this display is a deck of cards an associate scrolls through and
 * clicks into, and a card that is not visibly a contained thing is not a
 * card — it is three floating lines, which is exactly what read weak next to
 * Chesly and the other Even Hub apps that box their content.
 *
 * One drawn rectangle, on the region that moves; the rail stays unboxed. The
 * frame's border is 1 at rest and 3 when the associate has clicked in — the
 * community-standard selection idiom on this hardware, because border width
 * is the only per-container emphasis the SDK has.
 */
const CARD_BORDER = 1;
const CARD_BORDER_FOCUS = 3;
const CARD_RADIUS = 8;
/** Air between the frame and the display edge / rail column beside it. */
const CARD_INSET = 6;

/** Everything `createGeometry` works out for one frame. */
export interface Geometry {
  /** The frame this geometry describes. */
  DISPLAY_W: number;
  DISPLAY_H: number;
  /** The margin, and the content width inside it. */
  X: number;
  W: number;
  /** The two columns. */
  RAIL_W: number;
  GUTTER: number;
  MODULE_X: number;
  MODULE_W: number;
  /** The absolute half: one row height, everywhere, on every frame. */
  ROW_H: number;
  HEADER_H: number;
  LINE_H: number;
  LINE_STEP: number;
  RAIL_ROW: number;
  META_H: number;
  PAD: number;
  LABEL_W: number;
  CLOCK_W: number;
  /** Vertical stops. */
  HEADER_Y: number;
  BODY_TOP: number;
  /** The lowest edge the three cue lines reach — what the rail and the footer
   *  have to clear. */
  BODY_BOTTOM: number;
  FOOT_Y: number;
  MENU_TITLE_Y: number;
  MENU_TOP: number;
  /**
   * The card frame: where it starts, how tall it is, and where its body rows
   * begin. The frame holds its own title row (the frame container's content),
   * then the three cue lines as separate containers inside it — separate so
   * the hot path stays a per-line text upgrade.
   */
  CARD_Y: number;
  CARD_H: number;
  CARD_BODY_TOP: number;
  /** Whether this frame affords the card a title row. A 200px surface does
   *  not — the title is the first thing a short surface gives up. */
  CARD_TITLED: boolean;
  /** The left column's stops: the guest's name row, and the hero rail below. */
  NAME_Y: number;
  HERO_Y: number;
  /**
   * What each region can hold, **in pixels of drawable width**. These were
   * `LINE_CHARS`, `RAIL_LINE_CHARS` and `FACT_CHARS`, and they were character
   * counts derived from a ratio; the font is proportional, so a count could
   * never have been right. Whether a given string fits one of these is asked
   * of the font tables — see `text.ts`.
   */
  LINE_PX: number;
  RAIL_LINE_PX: number;
  FACT_PX: number;
  /** The footer's two cells, and the header's clock cluster. */
  META_PX: number;
  CLOCK_PX: number;
  /** What each region can hold, in rows. */
  FACT_SLOTS: number;
  MENU_ROWS: number;
}

/**
 * The geometry for one frame.
 *
 * This is the seam the file was missing. It used to hard-code 576 × 288 and
 * derive everything at module scope, with a header comment calling itself "the
 * single place that has to move when the hardware does" — written assuming the
 * hardware moves once. It doesn't. There are several surfaces at once, each a
 * fixed-size context canvas, so the frame is an argument.
 *
 * Widths and positions come out of `width`; heights come out of `ROW_H`, which
 * comes out of the glass. On a shorter frame that asymmetry shows up as fewer
 * rows — `FACT_SLOTS` and `MENU_ROWS` are clamped to what actually fits above
 * the footer, rather than a smaller row being invented to make six of them
 * fit. Inventing one is the single thing the calibration forbids.
 */
export function createGeometry(width: number, height: number): Geometry {
  const W = width - X * 2;
  const RAIL_W = Math.round(width * RAIL_FRACTION);
  const MODULE_X = X + RAIL_W + GUTTER;
  const MODULE_W = width - MODULE_X - X;

  const BODY_TOP = HEADER_Y + HEADER_H + GUTTER;
  /**
   * The card: title row first, then the three lines. The frame starts a
   * breath above the title so the border does not sit on the header, and the
   * body rows start a full row below the title so the two never share pixels.
   */
  const CARD_Y = BODY_TOP - CARD_INSET;
  /** The bottom row. Anchored to the bottom edge, so it is the one position
   *  that moves with the frame's height. */
  const FOOT_Y = height - ROW_H - ROW_GAP;
  const bodyBottomFrom = (top: number) => top + (CUE_LINES - 1) * LINE_STEP + LINE_H;
  /**
   * The title row is the first thing a short surface gives up — the same
   * trade the structural rule used to make. At 200px tall, three lines under
   * a title row run into the footer; the lines are the cue and the title is
   * furniture, so the title goes and the frame hugs the lines.
   */
  let CARD_BODY_TOP = BODY_TOP + ROW_H + CARD_INSET;
  if (bodyBottomFrom(CARD_BODY_TOP) + CARD_INSET + PAD > FOOT_Y) {
    CARD_BODY_TOP = BODY_TOP;
  }
  const CARD_TITLED = CARD_BODY_TOP !== BODY_TOP;
  const BODY_BOTTOM = bodyBottomFrom(CARD_BODY_TOP);
  const CARD_H = BODY_BOTTOM + CARD_INSET + PAD - CARD_Y;
  /** Name first, then the hero. The hero's own height is fixed by `hero.ts`
   *  (an image whose size followed its content would change the page shape on
   *  every guest); what the geometry owns is where it starts. */
  const NAME_Y = BODY_TOP;
  const HERO_Y = BODY_TOP + ROW_H + ROW_GAP;
  /** The menu title sits a hair tighter under the header than the cue body
   *  does — 50 against 52. The two pages were tuned separately on glass and
   *  neither complaint was about this, so it is preserved rather than tidied
   *  into agreement. */
  const MENU_TITLE_Y = HEADER_Y + HEADER_H + 12;
  const MENU_TOP = MENU_TITLE_Y + ROW_H + ROW_GAP;

  const rowsBetween = (top: number, bottom: number, cap: number) =>
    Math.max(0, Math.min(cap, Math.floor((bottom - top) / ROW_H)));

  /** The text rail sits under the name row, where the hero would be. */
  const FACT_SLOTS = rowsBetween(HERO_Y, FOOT_Y, FACT_SLOTS_MAX);

  return {
    DISPLAY_W: width, DISPLAY_H: height,
    X, W,
    RAIL_W, GUTTER, MODULE_X, MODULE_W,
    ROW_H, HEADER_H, LINE_H, LINE_STEP, RAIL_ROW, META_H, PAD,
    LABEL_W, CLOCK_W,
    HEADER_Y, BODY_TOP, BODY_BOTTOM, FOOT_Y, MENU_TITLE_Y, MENU_TOP,
    CARD_Y, CARD_H, CARD_BODY_TOP, CARD_TITLED, NAME_Y, HERO_Y,
    /**
     * What each region can actually draw in, in pixels.
     *
     * `cue.py` used to be written to the character forms of these, and can no
     * longer be: the service is Python and the font tables are JavaScript, so
     * the server cannot measure anything. It writes short and the glass fits
     * exactly — see the note on `RAIL_LINE_PX`.
     */
    LINE_PX: textBudget(W),
    /**
     * The one that matters, because a guest cue always has a rail beside it.
     * 346px at 576 — which is `IN CART CASHSOFT CREW` (224px) with room to
     * spare, and was a 21-character budget that had no way to know that.
     */
    RAIL_LINE_PX: textBudget(MODULE_W),
    /** The rail is a short label and a value, and not much of either — but its
     *  156px holds `BOTTOMS 28X30` (147px) whole, which ten characters did not,
     *  and `MAYA OKAFOR` (127px), which is the name that started this. */
    FACT_PX: textBudget(RAIL_W, RAIL_PAD, RAIL_BORDER),
    META_PX: textBudget(MODULE_X - X),
    CLOCK_PX: textBudget(CLOCK_W),
    /** Rows in the fact rail, between the header and the meta strip. */
    FACT_SLOTS,
    /** Rows in the floor menu, between the title and the footer. */
    MENU_ROWS: rowsBetween(MENU_TOP, FOOT_Y, MENU_ROWS_MAX),
  };
}

/**
 * The geometry everything in this file is still built against.
 *
 * Every named export below is this object's field of the same name, so
 * `cards.ts`, `main.ts` and the tests keep importing exactly what they did
 * before the frame became an argument. Adding the seam is the change; moving
 * every call site through it is not, and does not have to happen at once.
 */
export const DEFAULT_GEOMETRY = createGeometry(DEFAULT_FRAME_W, DEFAULT_FRAME_H);

export const {
  DISPLAY_W, DISPLAY_H,
  LINE_PX, RAIL_LINE_PX, FACT_PX,
  FACT_SLOTS,
} = DEFAULT_GEOMETRY;

const { W, RAIL_W, MODULE_X, MODULE_W, BODY_TOP, FOOT_Y,
        MENU_TITLE_Y, MENU_TOP, META_PX, CLOCK_PX,
        CARD_Y, CARD_H, CARD_BODY_TOP, CARD_TITLED, NAME_Y, HERO_Y } = DEFAULT_GEOMETRY;

export interface Cue {
  lines: string[];
  meta?: string[];
  /**
   * Supporting detail, two columns below the sentence.
   *
   * Kyle asked for more on one screen after using it on a floor. The 576×288
   * frame had ~50px of dead space between the third line and the meta strip,
   * so this fills it rather than compressing the sentence: the three lines
   * keep their size, their spacing and their sole claim on peak brightness,
   * and the facts sit visibly below them.
   *
   * Four is the cap. Two columns of two — a fifth would need a third row, and
   * a third row is where the frame stops being glanceable and starts being a
   * screen you read.
   */
  facts?: string[];
  /** Which module the right-hand region is showing, and how many exist. */
  moduleIndex?: number;
  moduleCount?: number;
  moduleName?: string;
  /**
   * The card's title row, drawn inside the frame above the lines. When unset
   * it is composed from the module fields: `CUE · 1/6`. A focused card says
   * where its window is instead: `CART · 2-4/9`.
   */
  cardTitle?: string;
  /** The associate has clicked into this card: the frame's border thickens
   *  and scrolling moves the card's content instead of the deck. */
  focused?: boolean;
  /**
   * The guest's name, in its own row at the top of the left column.
   *
   * Out of the rail and into the proportional face on purpose: the dot face
   * is for values, and a name is the one rail fact that is *read aloud* — it
   * earns the text face and a fixed position that never moves while the hero
   * below it changes.
   */
  name?: string;
  /**
   * Declare the hero rail image container (the pixels arrive separately, like
   * the mark). False falls back to the text rail built from `facts` — which
   * is also what `main.ts` re-renders with when the host refuses the image.
   */
  hero?: boolean;
  /**
   * Draw the clock huge, in dot type, in the card's body — the idle screen's
   * hero. Only honoured on an unrailed cue: a guest owns that space.
   * The image's pixels arrive separately, like every image on this display.
   */
  heroClock?: boolean;
  /** Unread floor messages, for the header cluster. */
  unread?: number;
  /** Glasses battery percent, or null when the host has not said. Only shows
   *  in the header at 20% and under — a full battery is not information. */
  battery?: number | null;
  /** Override the clock, for tests and renders. */
  clock?: string;
  /**
   * Draw the Cue mark top-left instead of the word CUE.
   *
   * Off by default, and deliberately: the pixels do not travel with the page.
   * The host has to accept a separate `updateImageRawData` call, and if it
   * doesn't, this container is an empty box where the brand should be — worse
   * than the wordmark it replaced. `main.ts` turns this on only after the host
   * has said `success` once, so the failure mode is a wordmark, not a hole.
   */
  logo?: boolean;
  /**
   * Whether the mic is open, closed, or not a thing this associate has.
   *
   * Rendered in the header beside the clock — see `headerStatus`. It is on the
   * `Cue` rather than held in this module because voice state belongs to
   * `main.ts`, and a layout that remembered it would be a layout with a
   * lifecycle.
   */
  mic?: MicState;
}

/**
 * The mic, as the glass shows it.
 *
 * `off` is not "closed" — it is voice switched off in preferences or declined
 * by the store, and it renders as nothing at all. A state light for a feature
 * that does not exist is a lie, and the idle strip has already stopped naming
 * the gesture in that case.
 */
export type MicState = "open" | "closed" | "off";

/**
 * Strip anything the glass shouldn't render.
 *
 * The service already writes in glass grammar, so this is a backstop for
 * anything that reaches the lens from an older path — an icon marker, a
 * stray comma, lowercase.
 *
 * **The charset is derived from the font's own tables** (see `text.ts`), not
 * written out here. It used to be the literal `[A-Z0-9 ·%$£€/+-]`, which
 * banned glyphs the G2 renders perfectly — box drawing, blocks, the arrow —
 * and among the casualties was the voice level meter, which is drawn from `█`
 * and had every block silently replaced with a space for as long as it has
 * existed. A literal cannot notice that, in either direction.
 *
 * `maxPx` is a pixel budget and the fitting is a measurement. It defaults to
 * the full frame, which is a backstop rather than a layout decision: every
 * call site that knows its box passes that box's width.
 */
export function toDisplayText(line: string, maxPx: number = LINE_PX): string {
  const clean = String(line ?? "")
    .replace(/\[ICON:\w+\]\s*/g, "")
    .toUpperCase()
    .replace(NOT_GLASS, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncatePx(clean, maxPx);
}

/**
 * Build the page.
 *
 * `latency` is rendered because the brand makes it a claim rather than a
 * diagnostic: the associate can see the cue is live.
 */
/** HH:MM, zero-padded, with the interpunct for a separator.
 *
 *  Not because the font has no colon — it has one, 4px wide, and an earlier
 *  comment here said otherwise. The interpunct is a brand rule: it is the only
 *  separator the identity system allows, and the charset declines the colon
 *  along with the comma and the full stop. Declined, not missing. */
export function clockLabel(now = new Date()): string {
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  return `${h}·${m}`;
}

/**
 * The header's right-hand cluster: the mic, then the time.
 *
 * **The voice indicator shares the clock's container rather than taking one of
 * its own,** and that is a budget decision with a real edge case behind it. A
 * railed guest page with the wordmark fallback already needs eight text
 * containers, which is the host's entire allowance; a ninth renders *nothing*
 * and reports nothing. So the two header facts share a box, and the container
 * freed by doing that is spent on the structural rule.
 *
 * The two mic glyphs are `█` and `▒`, and they are the same 20px advance —
 * verified from the font tables, not assumed — so the time does not move when
 * the mic opens. A clock that jumped sideways every time somebody spoke would
 * be the most distracting thing on the display.
 *
 * `off` draws the time alone.
 */
export const MIC_OPEN = "█";
export const MIC_CLOSED = "▒";
/** Unread floor messages: a filled dot and the count. The dot is 9px and in
 *  the font — it was banned by the hand-written charset for as long as that
 *  literal existed, which is why nothing used it until now. */
export const UNREAD_MARK = "•";

/**
 * The header's right-hand cluster: mic, unread, low battery, then the time.
 *
 * Three rules hold it together:
 *
 * - **State lights only.** The mic draws when voice exists; the unread count
 *   draws when something is unread; the battery draws at 20% and under. A
 *   full battery and an empty inbox draw nothing — the resting header is the
 *   mark and the clock, exactly as before.
 * - **The battery is `18%`, not a pictograph.** The font has no battery glyph
 *   and a half-block reads as a rendering fault; a percentage is read. It
 *   only ever appears when it is the associate's problem.
 * - **Right-aligned by measurement.** Text containers draw from the left, so
 *   the cluster is padded with leading spaces — measured, the space is a 5px
 *   advance — until the clock sits against the same right edge regardless of
 *   which lights are on. A clock that moved when the mic opened would be the
 *   most distracting thing on the display.
 */
export function headerStatus(
  clock: string, mic: MicState = "off", unread = 0, battery: number | null = null,
): string {
  const parts = [
    mic === "open" ? MIC_OPEN : mic === "closed" ? MIC_CLOSED : "",
    unread > 0 ? `${UNREAD_MARK}${Math.min(unread, 9)}` : "",
    battery !== null && battery <= 20 ? `${battery}%` : "",
    clock,
  ].filter(Boolean);
  const joined = truncatePx(parts.join(" "), CLOCK_PX);
  const spacePx = textWidth(" ");
  const pad = Math.max(0, Math.floor((CLOCK_PX - textWidth(joined)) / spacePx));
  return " ".repeat(pad) + joined;
}

/**
 * Fit an interpunct-separated strip to its box, dropping facts rather than
 * characters.
 *
 * The strip is a list, so it degrades like one: the rightmost fact goes, then
 * the next, until what's left fits. Slicing mid-word instead — which is what
 * the glass does on its own — produces "DENIM WALL · 1." and reads as a
 * hardware fault rather than an omission.
 *
 * `keep` is pinned to the end and never dropped. It is the latency, and the
 * point of showing latency is that it is always there.
 *
 * The budget is now the box's drawable width and the test is a measurement, so
 * the strip keeps as many facts as will *actually* fit rather than as many as
 * an average glyph width predicted.
 */
function fit(text: string, maxPx: number, keep = ""): string {
  const parts = String(text).split(" · ").filter(Boolean);
  while (parts.length) {
    const joined = [...parts, keep].filter(Boolean).join(" · ");
    if (fitsPx(joined, maxPx)) return joined;
    parts.pop();
  }
  return truncatePx(keep, maxPx);
}

export function buildCue(cue: Cue, latencyMs?: number): PageSpec {
  /**
   * Railed means the left column exists at all — a name, a hero, or text
   * facts. The full-frame fallback stays load-bearing: urgent messages, guest
   * requests and the idle screen all draw with nothing on the left, and their
   * card takes the whole width.
   */
  const railed = Boolean(cue.name) || (cue.facts || []).length > 0 || cue.hero === true;
  // With a rail beside it the sentence has a third less room, so it is fitted
  // to that box here — and "fits" is now the font's answer about this exact
  // string, not a character count that treats `IIIIIIIIIII` and `WWWWWWWWWWW`
  // as the same width. A clipped word at this size reads as a fault in the
  // hardware; the `+` reads as "there was more".
  const lines = (cue.lines || [])
    .map((l) => toDisplayText(l, railed ? RAIL_LINE_PX : LINE_PX))
    .filter(Boolean)
    .slice(0, CUE_LINES);
  const meta = (cue.meta || []).map((m) => toDisplayText(m, META_PX))
    .filter(Boolean).slice(0, 3);
  const facts = (cue.facts || [])
    .map((f) => toDisplayText(f, FACT_PX))
    .filter(Boolean)
    .slice(0, FACT_SLOTS);

  const textObject: TextContainer[] = [];
  const imageObject: ImageContainer[] = [];

  // Header, left — the mark if the host will draw it, the wordmark if not.
  //
  // The wordmark used to be 160 wide for three characters. On a display that
  // scales glyphs to the box that is not a generous margin, it is an
  // instruction to draw CUE enormous, which is what the glass did.
  if (cue.logo) {
    imageObject.push({
      // Centred against the header text row beside it.
      xPosition: X, yPosition: HEADER_Y - Math.round((MARK_H - HEADER_H) / 2),
      width: MARK_W, height: MARK_H,
      containerID: 10, containerName: "cue-mark", zOrderIndex: 1,
    });
  } else {
    textObject.push({
      xPosition: X, yPosition: HEADER_Y, width: LABEL_W, height: HEADER_H,
      paddingLength: PAD,
      containerID: 1, containerName: "cue-label", zOrderIndex: 1,
      content: "CUE",
      isEventCapture: 0,
    });
  }
  textObject.push({
    xPosition: DISPLAY_W - X - CLOCK_W, yPosition: HEADER_Y, width: CLOCK_W, height: HEADER_H,
    paddingLength: PAD,
    containerID: 2, containerName: "cue-clock", zOrderIndex: 2,
    // The status cluster: mic, unread, low battery, clock — state lights the
    // associate needs and nothing else, right-aligned so the clock never
    // moves. See `headerStatus` for the three rules that keep it honest.
    content: headerStatus(cue.clock ?? clockLabel(), cue.mic, cue.unread ?? 0,
                          cue.battery ?? null),
    // The page's single gesture receiver. It used to be the header, but an
    // image container has no `isEventCapture` field at all — swapping the
    // wordmark for the mark would have taken the page's only receiver with it.
    // The clock is the right home anyway: it is the one element that is never
    // part of the cue, so the sentence still carries no affordance of its own.
    isEventCapture: 1,
  });

  // The card — the region that moves, now visibly one contained thing.
  //
  // The frame is a text container of its own: its border draws the rounded
  // rectangle, its content is the card's title row (`CUE · 1/6`), and the
  // three lines sit inside it as separate containers so the hot path — every
  // deck scroll, every voice answer — stays a per-line text upgrade rather
  // than a rebuild. The border width is the focus state: 1 at rest, 3 when
  // the associate has clicked in. That change *does* force a rebuild, and it
  // is the right price — focus changes on a deliberate gesture, not per frame.
  const lineX = railed ? MODULE_X : X;
  const lineW = railed ? MODULE_W : W;
  textObject.push({
    xPosition: lineX - CARD_INSET, yPosition: CARD_Y,
    width: lineW + CARD_INSET * 2, height: CARD_H,
    borderWidth: cue.focused ? CARD_BORDER_FOCUS : CARD_BORDER,
    borderRadius: CARD_RADIUS,
    paddingLength: PAD + CARD_INSET,
    containerID: 6, containerName: "cue-card", zOrderIndex: 3,
    content: !CARD_TITLED ? "" : toDisplayText(cue.cardTitle
      ?? (cue.moduleCount && cue.moduleCount > 1
        ? `${cue.moduleName || "CUE"} · ${(cue.moduleIndex || 0) + 1}/${cue.moduleCount}`
        : cue.moduleName || ""), textBudget(lineW)),
    isEventCapture: 0,
  });
  // Always three line containers, empty ones included. Their *contents* change
  // constantly — every scroll, every answer — and a container that comes and
  // goes changes the page shape, which forces a full rebuild instead of a text
  // update. An empty container draws nothing and costs nothing; a rebuild on
  // every scroll costs a redraw of the whole glass.
  Array.from({ length: CUE_LINES }, (_, i) => lines[i] || "").forEach((content, i) => {
    textObject.push({
      xPosition: lineX, yPosition: CARD_BODY_TOP + i * LINE_STEP,
      width: lineW, height: LINE_H,
      paddingLength: PAD,
      containerID: 3 + i, containerName: `cue-line-${i + 1}`, zOrderIndex: 4 + i,
      content,
      isEventCapture: 0,
    });
  });

  // The idle clock hero — a 48px dotted clock centred in the card's body,
  // where the cue lines would be. The resting screen is the lens's first
  // impression, and it should read as an instrument, not a terminal.
  if (!railed && cue.heroClock) {
    const bodyBottom = CARD_Y + CARD_H - (CARD_INSET + PAD);
    imageObject.push({
      xPosition: Math.round((DISPLAY_W - CLOCK_HERO_W) / 2),
      yPosition: CARD_BODY_TOP
        + Math.max(0, Math.round((bodyBottom - CARD_BODY_TOP - CLOCK_HERO_H) / 2)),
      width: CLOCK_HERO_W, height: CLOCK_HERO_H,
      containerID: 12, containerName: "cue-idle-clock", zOrderIndex: 10,
    });
  }

  // The guest's name — the left column's fixed fact, in the text face.
  if (cue.name) {
    textObject.push({
      xPosition: X, yPosition: NAME_Y, width: RAIL_W, height: ROW_H,
      paddingLength: PAD,
      containerID: 8, containerName: "cue-name", zOrderIndex: 8,
      content: toDisplayText(cue.name, textBudget(RAIL_W)),
      isEventCapture: 0,
    });
  }

  // The hero rail: an image container the pixels arrive into separately,
  // exactly like the mark — and with the same failure discipline. `main.ts`
  // latches `useHeroRail` off the first time the host refuses, and re-renders
  // with `hero: false`, which builds the text rail below instead.
  if (railed && cue.hero) {
    imageObject.push({
      xPosition: X, yPosition: HERO_Y,
      width: HERO_W, height: HERO_H,
      containerID: 11, containerName: "cue-hero", zOrderIndex: 9,
    });
  }

  // Text rail — the fallback left column, when the host refuses images or a
  // payload has facts and no sizes worth a hero.
  //
  // A list container, not four text containers, and not by preference: the
  // host caps `Text_Object` at 8 and the railed guest page needed 11. Over
  // budget, the page does not render *and nothing says so* — which is exactly
  // how the rail shipped twice and appeared neither time.
  const listObject: ListContainer[] = [];
  if (railed && !cue.hero && facts.length) {
    listObject.push({
      xPosition: X, yPosition: HERO_Y,
      width: RAIL_W, height: RAIL_ROW * facts.length,
      containerID: 9, containerName: "cue-rail", zOrderIndex: 9,
      // No border: one frame on this display, and it is the card's. Two boxes
      // side by side stop reading as "the thing you can act on" and start
      // reading as a table.
      borderWidth: RAIL_BORDER,
      paddingLength: RAIL_PAD,
      isEventCapture: 0,
      itemContainer: {
        itemCount: facts.length,
        itemWidth: RAIL_W,
        itemName: facts,
        // No selection border: the rail is read, never chosen.
        isItemSelectBorderEn: 0,
      },
    });
  }

  // Meta strip, the bottom row entire. The module indicator that used to
  // share it moved into the card's title, so the strip has the full width —
  // and idle needs it: the strip is where the two gestures nobody discovers
  // by accident are named, and one of them exits the app.
  //
  // Interpunct-separated, dropped from the right rather than clipped: a strip
  // that ends mid-word reads as broken hardware. Latency is the pinned tail —
  // the point of showing latency is that it is always there.
  const footRight = latencyMs ? `${(latencyMs / 1000).toFixed(1)}S` : "";
  textObject.push({
    xPosition: X, yPosition: FOOT_Y,
    width: W, height: META_H,
    paddingLength: PAD,
    containerID: 7, containerName: "cue-meta", zOrderIndex: 7,
    content: fit(meta.join(" · "), textBudget(W), footRight),
    isEventCapture: 0,
  });

  return assertBudget({
    containerTotalNum: textObject.length + listObject.length + imageObject.length,
    textObject,
    ...(listObject.length ? { listObject } : {}),
    ...(imageObject.length ? { imageObject } : {}),
  });
}

/**
 * The floor menu — unread messages first, then what you can say back.
 *
 * One screen for both directions of floor comms, because they are the same
 * gesture: an associate who has just read "need backup in fitting rooms"
 * wants to answer it without navigating anywhere. Unread messages sit above
 * the canned phrases in one list, newest first.
 *
 * Selection is rendered in the row text, not with the host's select border.
 * `ListItemContainerProperty` has `isItemSelectBorderEn` but no settable
 * index — the host decides what is selected, and our scrolling is decoded
 * from ring gestures on this side. A border highlighting a different row from
 * the one a press would act on is worse than no border at all.
 *
 * Six rows fit between the title and the footer at 576 × 288, and that is now
 * a measurement rather than a number: `createGeometry` divides the space
 * between `MENU_TOP` and `FOOT_Y` by the row height and caps it at six. On
 * this frame it still comes out as six. On a shorter one it comes out smaller,
 * which is the honest answer — the rows cannot get shorter. Longer lists
 * window around the selection rather than scrolling the container, so however
 * many rows there are, the selected one is on the glass.
 */
export const { MENU_ROWS } = DEFAULT_GEOMETRY;
/**
 * Marks the row a press will act on, with unselected rows padded to match so
 * the text does not jump sideways as the cursor moves.
 *
 * That padding is exact rather than approximate, and now demonstrably so: the
 * interpunct and the space are both 5px advances in this font, so `"· "` and
 * `"  "` are both 10px. It was a reasonable hope when the charset was a
 * literal and every glyph was assumed to be one width; it is a measurement
 * now, and `geometry.test.mjs` asserts it rather than trusting it.
 */
const MENU_CURSOR = "· ";
const MENU_CURSOR_PAD = "  ";

export function buildMenu(
  title: string, items: string[], selected: number,
  opts: { clock?: string; logo?: boolean; footer?: string; mic?: MicState } = {},
): PageSpec {
  const textObject: TextContainer[] = [];
  const imageObject: ImageContainer[] = [];

  if (opts.logo) {
    imageObject.push({
      xPosition: X, yPosition: HEADER_Y - Math.round((MARK_H - HEADER_H) / 2),
      width: MARK_W, height: MARK_H,
      containerID: 10, containerName: "cue-mark", zOrderIndex: 1,
    });
  } else {
    textObject.push({
      xPosition: X, yPosition: HEADER_Y, width: LABEL_W, height: HEADER_H,
      paddingLength: PAD, containerID: 1, containerName: "cue-label",
      zOrderIndex: 1, content: "CUE", isEventCapture: 0,
    });
  }
  textObject.push({
    xPosition: DISPLAY_W - X - CLOCK_W, yPosition: HEADER_Y, width: CLOCK_W,
    height: HEADER_H, paddingLength: PAD,
    containerID: 2, containerName: "cue-clock", zOrderIndex: 2,
    content: headerStatus(opts.clock ?? clockLabel(), opts.mic), isEventCapture: 1,
  });
  textObject.push({
    xPosition: X, yPosition: MENU_TITLE_Y, width: W, height: ROW_H, paddingLength: PAD,
    containerID: 3, containerName: "menu-title", zOrderIndex: 3,
    content: toDisplayText(title, textBudget(W)), isEventCapture: 0,
  });

  // Window the list so the selection is always visible.
  const n = items.length;
  const start = n <= MENU_ROWS
    ? 0
    : Math.min(Math.max(0, selected - Math.floor(MENU_ROWS / 2)), n - MENU_ROWS);
  // The row's budget is the list's drawable width less whatever the cursor
  // column costs — measured, because "a cursor is two characters" is the kind
  // of statement this whole change exists to stop anyone making.
  const rowPx = textBudget(W) - textWidth(MENU_CURSOR);
  const rows = items.slice(start, start + MENU_ROWS).map((label, i) => {
    const isSel = start + i === selected;
    return (isSel ? MENU_CURSOR : MENU_CURSOR_PAD) + toDisplayText(label, rowPx);
  });

  const listObject: ListContainer[] = [{
    xPosition: X, yPosition: MENU_TOP, width: W, height: ROW_H * Math.max(1, rows.length),
    containerID: 9, containerName: "menu-list", zOrderIndex: 9,
    paddingLength: PAD, isEventCapture: 0,
    itemContainer: {
      itemCount: Math.max(1, rows.length),
      itemWidth: W,
      itemName: rows.length ? rows : ["NOTHING ON THE FLOOR"],
      isItemSelectBorderEn: 0,
    },
  }];

  // **No rule on this page, and the reason is a row of floor comms.**
  //
  // The cue page has ~46px of dead space above its footer and the rule lives
  // there. The menu does not: six rows of list run to 240 and the footer
  // starts at 254, so a rule would have to be paid for out of `MENU_ROWS`,
  // and five rows of "what is waiting and what you can say back" is a worse
  // trade than an implied boundary. The list is also the one page on this
  // display that is already structured — rows of equal height *are* the
  // structure, which is exactly what the cue page lacks and why it needed a
  // line drawn.
  textObject.push({
    xPosition: X, yPosition: FOOT_Y, width: W, height: ROW_H, paddingLength: PAD,
    containerID: 7, containerName: "menu-foot", zOrderIndex: 7,
    content: fit(opts.footer ?? "PRESS TO SEND · 2X BACK", textBudget(W)),
    isEventCapture: 0,
  });

  return assertBudget({
    containerTotalNum: textObject.length + listObject.length + imageObject.length,
    textObject, listObject,
    ...(imageObject.length ? { imageObject } : {}),
  });
}

/**
 * The ruler — the same word at five container heights, labelled.
 *
 * Three builds have now gone out with the type size set by inference from a
 * sentence of feedback, and two of them were wrong. The variable is a single
 * number and the hardware is the only instrument that can read it, so this
 * puts all five candidates on the glass at once and asks one question:
 * **which of these rows is whole, and which is clipped?**
 *
 * The label is inside the row it measures, deliberately — a legend in a
 * different box would be rendered at a different size and would be the thing
 * under test. Each row says its own height in its own type.
 *
 * Reachable by scrolling up at idle, which is otherwise a no-op. It is not
 * hidden and does not need to be: an associate who finds it sees a screen of
 * numbers and presses to leave.
 */
export const RULER_HEIGHTS = [20, 24, 26, 28, 32];

export function buildRuler(): PageSpec {
  let y = 16;
  const textObject: TextContainer[] = RULER_HEIGHTS.map((h, i) => {
    const row = {
      xPosition: X, yPosition: y, width: W, height: h,
      paddingLength: PAD,
      containerID: 1 + i, containerName: `ruler-${h}`, zOrderIndex: 1 + i,
      // Digits, caps and a descender-free word: if the bottom edge is missing
      // it is the box clipping, not the glyph having nothing down there.
      content: `${h} SIZE 28X30 WHOLE`,
      // One receiver, so a tap leaves the way every other page leaves.
      isEventCapture: (i === 0 ? 1 : 0) as 0 | 1,
    };
    y += h + 8;
    return row;
  });

  textObject.push({
    xPosition: X, yPosition: DISPLAY_H - 30, width: W, height: 26,
    paddingLength: PAD,
    containerID: 8, containerName: "ruler-exit", zOrderIndex: 8,
    content: "PRESS TO GO BACK",
    isEventCapture: 0,
  });

  return assertBudget({ containerTotalNum: textObject.length, textObject });
}

/**
 * Refuse to hand the host a page it will silently drop.
 *
 * The budgets are the host's, not ours: 8 text containers, 12 in total. Going
 * over does not error — the page simply never appears, which cost two uploads
 * and an evening. Failing loudly here turns that into a caught mistake at the
 * one place every page is built.
 */
export function assertBudget(page: PageSpec): PageSpec {
  const texts = page.textObject.length;
  const images = page.imageObject?.length ?? 0;
  const total = texts + images + (page.listObject?.length ?? 0);
  if (texts > MAX_TEXT_CONTAINERS || images > MAX_IMAGE_CONTAINERS ||
      total > MAX_TOTAL_CONTAINERS) {
    throw new Error(
      `Page over the host's container budget: ${texts} text (max ` +
      `${MAX_TEXT_CONTAINERS}), ${images} image (max ${MAX_IMAGE_CONTAINERS}), ` +
      `${total} total (max ${MAX_TOTAL_CONTAINERS}). ` +
      `The host drops an over-budget page without reporting it.`,
    );
  }
  return page;
}

/** Nothing to say yet. Even the idle state obeys the grammar. */
export const IDLE_CUE: Cue = {
  lines: ["CUESEA READY", "", "AWAITING GUEST SIGNAL"],
  // The only screen that spends space on controls. Everywhere else the
  // gestures follow from what's on the glass; here they don't, and one of
  // them exits the app.
  meta: ["PRESS TO ASK", "2X EXIT"],
};
