/**
 * Cue Lens — the cue, as the glass renders it.
 *
 * The identity system specifies this surface tighter than anything else in
 * the product, and the constraint is the point:
 *
 *   CUE + latency   hud-300, small, tracked wide. Establishes this is live,
 *                   not cached, and makes latency a visible product claim.
 *   Three lines     hud-500 at full brightness. The only peak-brightness
 *                   element on the display. Name, evidence, reason to speak.
 *   Meta strip      hud-300. Three facts that support the sentence and never
 *                   compete with it.
 *   Absent          no buttons, no chrome, no logo, no icons. Confirmation is
 *                   a temple tap; dismissal is a look away.
 *
 * The G2 renders 576 × 288 per eye; the brand doc specs 640 × 200 for the
 * display it anticipates. The grammar is identical either way — only the
 * geometry below changes — so this file is the single place that has to move
 * when the hardware does.
 */
import type { PageSpec, TextContainer } from "./bridge";

export const DISPLAY_W = 576;
export const DISPLAY_H = 288;

/** Three lines is the contract. A fourth is a bug, not an overflow. */
export const CUE_LINES = 3;
/**
 * Characters per line. 60 across the full frame; the rail takes about a third,
 * so a cue built with one has to be written shorter. `RAIL_LINE_CHARS` is what
 * `cue.py` should target once the rail is populated.
 */
export const LINE_CHARS = 60;
export const RAIL_LINE_CHARS = 42;
/** Rows in the fact rail, between the header and the meta strip. */
export const FACT_SLOTS = 5;
/** The rail is a quarter of the frame — a short label and a value. */
export const FACT_CHARS = 17;

const X = 20;
const W = DISPLAY_W - X * 2;

/**
 * Two regions, after the Even dashboard: a fact rail on the left that stays
 * put, and a module on the right that scrolling moves between.
 *
 * The rail costs the sentence about a third of its width — 60 characters
 * becomes 42. That is the real price of this layout and the thing to judge on
 * the glass; `cue.py` shortens the evidence line to suit.
 */
const RAIL_W = 148;
const GUTTER = 16;
const MODULE_X = X + RAIL_W + GUTTER;
const MODULE_W = DISPLAY_W - MODULE_X - X;
const BODY_TOP = 70;
const RAIL_ROW = 26;

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
export function buildCue(cue: Cue, latencyMs?: number): PageSpec {
  const lines = (cue.lines || []).map(toDisplayText).filter(Boolean).slice(0, CUE_LINES);
  const meta = (cue.meta || []).map(toDisplayText).filter(Boolean).slice(0, 3);
  const facts = (cue.facts || [])
    .map((f) => toDisplayText(f).slice(0, FACT_CHARS))
    .filter(Boolean)
    .slice(0, FACT_SLOTS);

  const textObject: TextContainer[] = [];

  // Header — the word CUE, and how fresh this is.
  textObject.push({
    xPosition: X, yPosition: 16, width: 200, height: 20,
    containerID: 1, containerName: "cue-label", zOrderIndex: 1,
    content: "CUE",
    // The single gesture receiver for the page. It is the header rather than
    // a line of the cue so the sentence carries no affordance of its own.
    isEventCapture: 1,
  });
  textObject.push({
    xPosition: DISPLAY_W - X - 120, yPosition: 16, width: 120, height: 20,
    containerID: 2, containerName: "cue-latency", zOrderIndex: 2,
    content: latencyMs ? `${(latencyMs / 1000).toFixed(1)}S` : "",
    isEventCapture: 0,
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
  lines.forEach((content, i) => {
    textObject.push({
      xPosition: lineX, yPosition: BODY_TOP + i * 44,
      width: lineW, height: 38,
      containerID: 3 + i, containerName: `cue-line-${i + 1}`, zOrderIndex: 3 + i,
      content,
      isEventCapture: 0,
    });
  });

  // Which module the region is showing. Only when there is more than one — a
  // position indicator for a single page is chrome, and chrome is the thing
  // this surface spends its budget not having.
  if (cue.moduleCount && cue.moduleCount > 1) {
    // "2/3", not dots. The glass charset is [A-Z0-9 ·%$£€/+-] — a filled dot
    // is stripped on the way out, which rendered the *active* module as a gap.
    // And at this size on a monochrome display, counting dots is work; a
    // fraction is read, not counted.
    const position = `${(cue.moduleIndex || 0) + 1}/${cue.moduleCount}`;
    textObject.push({
      xPosition: lineX, yPosition: DISPLAY_H - 42,
      width: lineW, height: 20,
      containerID: 8, containerName: "cue-modules", zOrderIndex: 8,
      content: toDisplayText(`${cue.moduleName || ""} ${position}`),
      isEventCapture: 0,
    });
  }

  // Left rail — facts that stay put while the right side changes.
  //
  // Modelled on the Even dashboard: persistent detail down the left, modules
  // you scroll through on the right. The rail is what an associate glances at
  // mid-sentence (her size, her tier), so it must not move underneath them.
  facts.forEach((content, i) => {
    textObject.push({
      xPosition: X, yPosition: BODY_TOP + i * RAIL_ROW,
      width: RAIL_W, height: 20,
      containerID: 10 + i, containerName: `cue-fact-${i + 1}`, zOrderIndex: 10 + i,
      content,
      isEventCapture: 0,
    });
  });

  // Meta strip, bottom left. Interpunct-separated, never four facts.
  textObject.push({
    xPosition: X, yPosition: DISPLAY_H - 42,
    width: hasRail ? RAIL_W : W, height: 22,
    containerID: 7, containerName: "cue-meta", zOrderIndex: 7,
    content: meta.join(" · "),
    isEventCapture: 0,
  });

  return { containerTotalNum: textObject.length, textObject };
}

/** Nothing to say yet. Even the idle state obeys the grammar. */
export const IDLE_CUE: Cue = {
  lines: ["CUESEA READY", "", "AWAITING GUEST SIGNAL"],
  // The only screen that spends space on controls. Everywhere else the
  // gestures follow from what's on the glass; here they don't, and one of
  // them exits the app.
  meta: ["PRESS TO ASK", "DOUBLE PRESS EXITS"],
};
