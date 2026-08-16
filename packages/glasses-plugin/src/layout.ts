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
 */
import type { ImageContainer, ListContainer, PageSpec, TextContainer } from "./bridge";
import { MARK_H, MARK_W } from "./mark";

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
 * Six is what the rail has to *say* — name, unread count, tier, points, and
 * the two sizes. A seventh row fits at 288 and there is no seventh fact, so
 * this is a cap on content, not on space. How many of the six actually fit is
 * a question about the frame, and `createGeometry` answers it: on a short
 * surface `FACT_SLOTS` comes back smaller than this, because a row that would
 * land on the footer is worse than a fact that isn't shown.
 */
const FACT_SLOTS_MAX = 6;
/**
 * Same idea for the floor menu: six rows is the design, fewer if they don't
 * fit. Longer lists window around the selection rather than scrolling the
 * container, so whatever this comes out as, the selected row is on the glass.
 */
const MENU_ROWS_MAX = 6;

/**
 * Glyph advance as a fraction of container height.
 *
 * Every character budget in this file used to be a number somebody chose: 60
 * per line, 42 with a rail, 17 per fact. They were chosen when the containers
 * were 38 and 44 pixels tall. Once height became the type control those
 * numbers meant nothing, and the rail quietly shipped rows needing 178px in a
 * 148px box — which the glass renders by clipping, which is what "font is cut
 * off" was.
 *
 * So the budgets are derived instead, from the one ratio that governs them.
 * 0.60 is the widest advance the preview render measures — 0.57 at 24px and
 * 0.60 at 28px, so it is taken at the worst case rather than the average,
 * because being one character optimistic here means a clipped word on a
 * customer's face. It is measured off the preview font, not off the G2, and
 * the G2's is very likely narrower. Calibrating it on glass is a one-line
 * change here and every budget in the file moves with it.
 */
const CHAR_ASPECT = 0.60;

/** How many characters fit a box, given the host scales glyphs to its height. */
export function fitChars(width: number, height: number): number {
  return Math.max(1, Math.floor((width - PAD * 2 - 4) / (height * CHAR_ASPECT)));
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
 * price of this layout and the thing to judge on the glass; `cue.py` shortens
 * the evidence line to `RAIL_LINE_CHARS` to suit.
 *
 * 168 at 576 rather than 148 because at 148 the rail could not hold "BOTTOMS
 * 28X30" — the sizes are the reason the rail exists, and a rail that clips the
 * sizes is a rail that costs the sentence a third of its width for nothing.
 * That measurement is what fixes the fraction: 168/576 = 0.2917 of the frame.
 *
 * **The "168/10 vs 188/12" discrepancy, since it has been logged twice.**
 * They were never two rails. 0.2917 of 640 is 187 — the site's 188 is the same
 * rail to within a pixel of rounding, so the *width* is one fraction at two
 * frames and there is nothing to reconcile.
 *
 * The character counts are a different matter, and this is the half that was
 * actually wrong. `fitChars` subtracts the padding and margin before it
 * divides; 188/12 does not — 188 ÷ (26 × 0.60) = 12.05, which is the count you
 * get by dividing the raw box width by the glyph advance and forgetting that
 * two paddings and a safety margin are not available to draw in. At 576 the
 * two methods agree by luck (168 gives 10 either way), which is why this went
 * unnoticed. At 640 they do not: the honest budget is **11**, not 12. Do not
 * "restore" 12 without moving `CHAR_ASPECT` or `PAD` and saying why.
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
 *  Boxes get a margin, not an exact fit: the clock sat in 90px, which holds
 *  exactly five characters at this row height, and "14·32" is exactly five. */
const LABEL_W = 64;
const CLOCK_W = 104;

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
  /** What each region can hold, in characters. */
  LINE_CHARS: number;
  RAIL_LINE_CHARS: number;
  FACT_CHARS: number;
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
  const BODY_BOTTOM = BODY_TOP + (CUE_LINES - 1) * LINE_STEP + LINE_H;
  /** The bottom row, split on the same two-column grid as the body: meta under
   *  the rail, the module indicator under the module. They used to share the
   *  full width and sat on top of each other whenever a cue had no rail. */
  const FOOT_Y = height - ROW_H - ROW_GAP;
  /** The menu title sits a hair tighter under the header than the cue body
   *  does — 50 against 52. The two pages were tuned separately on glass and
   *  neither complaint was about this, so it is preserved rather than tidied
   *  into agreement. */
  const MENU_TITLE_Y = HEADER_Y + HEADER_H + 12;
  const MENU_TOP = MENU_TITLE_Y + ROW_H + ROW_GAP;

  const rowsBetween = (top: number, bottom: number, cap: number) =>
    Math.max(0, Math.min(cap, Math.floor((bottom - top) / ROW_H)));

  return {
    DISPLAY_W: width, DISPLAY_H: height,
    X, W,
    RAIL_W, GUTTER, MODULE_X, MODULE_W,
    ROW_H, HEADER_H, LINE_H, LINE_STEP, RAIL_ROW, META_H, PAD,
    LABEL_W, CLOCK_W,
    HEADER_Y, BODY_TOP, BODY_BOTTOM, FOOT_Y, MENU_TITLE_Y, MENU_TOP,
    /**
     * What each region can actually hold, derived rather than chosen.
     *
     * `cue.py` writes to these: `LINE_CHARS` across the full frame, and
     * `RAIL_LINE_CHARS` — the one that matters, because a guest cue always has
     * a rail beside it.
     */
    LINE_CHARS: fitChars(W, LINE_H),
    RAIL_LINE_CHARS: fitChars(MODULE_W, LINE_H),
    /** The rail is a short label and a value, and not much of either. */
    FACT_CHARS: fitChars(RAIL_W, RAIL_ROW),
    /** Rows in the fact rail, between the header and the meta strip. */
    FACT_SLOTS: rowsBetween(BODY_TOP, FOOT_Y, FACT_SLOTS_MAX),
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
  LINE_CHARS, RAIL_LINE_CHARS, FACT_CHARS,
  FACT_SLOTS,
} = DEFAULT_GEOMETRY;

const { W, RAIL_W, MODULE_X, MODULE_W, BODY_TOP, FOOT_Y,
        MENU_TITLE_Y, MENU_TOP } = DEFAULT_GEOMETRY;

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
}

/**
 * Strip anything the glass shouldn't render.
 *
 * The service already writes in glass grammar, so this is a backstop for
 * anything that reaches the lens from an older path — an icon marker, a
 * stray comma, lowercase.
 */
export function toDisplayText(line: string): string {
  return String(line ?? "")
    .replace(/\[ICON:\w+\]\s*/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ·%$£€/+-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LINE_CHARS);
}

/**
 * Build the page.
 *
 * `latency` is rendered because the brand makes it a claim rather than a
 * diagnostic: the associate can see the cue is live.
 */
/** HH:MM, zero-padded. The glass charset has no colon, so the interpunct
 *  stands in — it is the one separator the brand allows anyway. */
function clockLabel(now = new Date()): string {
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  return `${h}·${m}`;
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
 */
function fit(text: string, width: number, height: number, keep = ""): string {
  const budget = fitChars(width, height);
  const parts = String(text).split(" · ").filter(Boolean);
  while (parts.length) {
    const joined = [...parts, keep].filter(Boolean).join(" · ");
    if (joined.length <= budget) return joined;
    parts.pop();
  }
  return keep.slice(0, budget);
}

export function buildCue(cue: Cue, latencyMs?: number): PageSpec {
  const railed = (cue.facts || []).length > 0;
  // With a rail beside it the sentence has a third less room, so it is cut to
  // that budget here. A clipped word at this size reads as a fault in the
  // hardware; an ellipsis reads as "there was more".
  const lines = (cue.lines || [])
    .map((l) => {
      const s = toDisplayText(l);
      return railed && s.length > RAIL_LINE_CHARS
        ? s.slice(0, RAIL_LINE_CHARS - 1).trimEnd() + "+"
        : s;
    })
    .filter(Boolean)
    .slice(0, CUE_LINES);
  const meta = (cue.meta || []).map(toDisplayText).filter(Boolean).slice(0, 3);
  const facts = (cue.facts || [])
    .map((f) => toDisplayText(f).slice(0, FACT_CHARS))
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
    // The clock, not the latency. An associate mid-shift wants the time far
    // more often than a round-trip figure; latency moved to the meta strip
    // where it stays a visible claim without owning the corner.
    content: cue.clock ?? clockLabel(),
    // The page's single gesture receiver. It used to be the header, but an
    // image container has no `isEventCapture` field at all — swapping the
    // wordmark for the mark would have taken the page's only receiver with it.
    // The clock is the right home anyway: it is the one element that is never
    // part of the cue, so the sentence still carries no affordance of its own.
    isEventCapture: 1,
  });

  // The module — the three lines, still the only peak-brightness element on
  // the display. It takes the right-hand region when there is a rail beside
  // it, and the full frame when there isn't.
  //
  // That fallback is load-bearing, not defensive: the rail is only half built,
  // and nothing populates `facts` yet. Without this, a build from `main` would
  // indent the sentence into a column with nothing next to it — a worse lens
  // than the one shipping today, for a feature that isn't finished.
  const hasRail = facts.length > 0;
  const lineX = hasRail ? MODULE_X : X;
  const lineW = hasRail ? MODULE_W : W;
  // Always three line containers, empty ones included. Their *contents* change
  // constantly — every scroll, every answer — and a container that comes and
  // goes changes the page shape, which forces a full rebuild instead of a text
  // update. An empty container draws nothing and costs nothing; a rebuild on
  // every scroll costs a redraw of the whole glass.
  Array.from({ length: CUE_LINES }, (_, i) => lines[i] || "").forEach((content, i) => {
    textObject.push({
      xPosition: lineX, yPosition: BODY_TOP + i * LINE_STEP,
      width: lineW, height: LINE_H,
      paddingLength: PAD,
      containerID: 3 + i, containerName: `cue-line-${i + 1}`, zOrderIndex: 3 + i,
      content,
      isEventCapture: 0,
    });
  });

  // The bottom row, on the same two columns as the body: the meta strip under
  // the rail, the module indicator under the module. They used to be given the
  // full width each, which is invisible while every cue has a rail and an
  // exact overlap the moment one doesn't.
  // Which module the region is showing. Only when there is more than one — a
  // position indicator for a single page is chrome, and chrome is the thing
  // this surface spends its budget not having.
  const showModules = Boolean(cue.moduleCount && cue.moduleCount > 1);
  // The meta strip takes the whole bottom row when nothing is sharing it.
  // Idle is that case, and idle is the one screen whose meta strip is load
  // bearing: it carries the two gestures, one of which quits the app. Held to
  // a rail's width it fitted the build number and dropped both of them.
  // The footer's left cell runs to where the module column starts, not to
  // where the rail's border does — the gutter above it is dead space, and at
  // this type size the strip is nine characters against ten. "DENIM WALL" is
  // exactly the fact that falls off the end of it.
  const metaW = hasRail || showModules ? MODULE_X - X : W;
  const footRight = latencyMs ? `${(latencyMs / 1000).toFixed(1)}S` : "";
  if (showModules) {
    // "2/3", not dots. The glass charset is [A-Z0-9 ·%$£€/+-] — a filled dot
    // is stripped on the way out, which rendered the *active* module as a gap.
    // And at this size on a monochrome display, counting dots is work; a
    // fraction is read, not counted.
    const position = `${(cue.moduleIndex || 0) + 1}/${cue.moduleCount}`;
    textObject.push({
      xPosition: lineX, yPosition: FOOT_Y,
      width: lineW, height: META_H,
      paddingLength: PAD,
      containerID: 8, containerName: "cue-modules", zOrderIndex: 8,
      // Latency rides here rather than in the meta strip. It is a claim the
      // brand wants visible, and this is the only row on a railed page with
      // room for it — the meta strip is a rail's width and cannot hold
      // "DENIM WALL · 1.2S" without clipping the S off the end of it.
      content: fit(`${cue.moduleName || ""} ${position}`, lineW, META_H, footRight),
      isEventCapture: 0,
    });
  }

  // Left rail — facts that stay put while the right side changes.
  //
  // A list container, not four text containers, and not by preference: the
  // host caps `Text_Object` at 8 and the railed guest page needed 11. Over
  // budget, the page does not render *and nothing says so* — which is exactly
  // how the rail shipped twice and appeared neither time. One list holds all
  // five rows and costs one container.
  const listObject: ListContainer[] = [];
  if (facts.length) {
    listObject.push({
      xPosition: X, yPosition: BODY_TOP,
      width: RAIL_W, height: RAIL_ROW * facts.length,
      containerID: 9, containerName: "cue-rail", zOrderIndex: 9,
      // A hairline down the rail's edge. The brand bans chrome, and this is
      // structure rather than decoration: it says where the fixed column ends
      // and the module begins, which is the whole point of the layout.
      borderWidth: 1,
      borderRadius: 2,
      paddingLength: PAD + 2,
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

  // Meta strip, bottom left. Interpunct-separated, never four facts, and
  // dropped from the right rather than clipped: a strip that ends mid-word
  // reads as broken hardware, and the last fact is the least important one.
  textObject.push({
    xPosition: X, yPosition: FOOT_Y,
    width: metaW, height: META_H,
    paddingLength: PAD,
    containerID: 7, containerName: "cue-meta", zOrderIndex: 7,
    // When there is no module row, latency has nowhere else to go.
    content: fit(meta.join(" · "), metaW, META_H, showModules ? "" : footRight),
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
/** Marks the row a press will act on. The glass charset is
 *  [A-Z0-9 ·%$£€/+-], so this is one of very few characters available, and
 *  unselected rows are padded to match so the text does not jump sideways. */
const MENU_CURSOR = "· ";

export function buildMenu(
  title: string, items: string[], selected: number,
  opts: { clock?: string; logo?: boolean; footer?: string } = {},
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
    content: opts.clock ?? clockLabel(), isEventCapture: 1,
  });
  textObject.push({
    xPosition: X, yPosition: MENU_TITLE_Y, width: W, height: ROW_H, paddingLength: PAD,
    containerID: 3, containerName: "menu-title", zOrderIndex: 3,
    content: toDisplayText(title), isEventCapture: 0,
  });

  // Window the list so the selection is always visible.
  const n = items.length;
  const start = n <= MENU_ROWS
    ? 0
    : Math.min(Math.max(0, selected - Math.floor(MENU_ROWS / 2)), n - MENU_ROWS);
  const rows = items.slice(start, start + MENU_ROWS).map((label, i) => {
    const isSel = start + i === selected;
    const budget = fitChars(W, ROW_H) - MENU_CURSOR.length;
    return (isSel ? MENU_CURSOR : "  ") + toDisplayText(label).slice(0, budget);
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

  textObject.push({
    xPosition: X, yPosition: FOOT_Y, width: W, height: ROW_H, paddingLength: PAD,
    containerID: 7, containerName: "menu-foot", zOrderIndex: 7,
    content: fit(opts.footer ?? "PRESS TO SEND · 2X BACK", W, ROW_H),
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
