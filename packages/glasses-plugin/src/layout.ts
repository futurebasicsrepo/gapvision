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
/** Under 60 characters per line — the edge of the frame at this FOV. */
export const LINE_CHARS = 60;

const X = 20;
const W = DISPLAY_W - X * 2;

export interface Cue {
  lines: string[];
  meta?: string[];
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

  // The three lines. Peak brightness, nothing else on the display shares it.
  const top = 70;
  const step = 44;
  lines.forEach((content, i) => {
    textObject.push({
      xPosition: X, yPosition: top + i * step, width: W, height: 38,
      containerID: 3 + i, containerName: `cue-line-${i + 1}`, zOrderIndex: 3 + i,
      content,
      isEventCapture: 0,
    });
  });

  // Meta strip, bottom left. Interpunct-separated, never four facts.
  textObject.push({
    xPosition: X, yPosition: DISPLAY_H - 42, width: W, height: 22,
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
