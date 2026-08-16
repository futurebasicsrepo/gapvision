/**
 * Dump the real pages as JSON, so a preview can be drawn from the same
 * `buildCue` the glasses run rather than from a mockup of it.
 *
 *   npm run render:lens
 *
 * The point of this file is that it is not a drawing. Every number in the
 * output came out of layout.ts. If the preview looks wrong, the glass is
 * wrong too — which is the whole reason to have it, given that the last three
 * layout faults were only visible on hardware.
 */
import { getTextWidth } from "@evenrealities/pretext";
import { buildCue, IDLE_CUE } from "../dist-test/layout.mjs";

const RAIL = ["SARAH CHEN", "ICON", "4200 PTS", "TOP M", "BTM 28X30"];

const pages = {
  idle: buildCue({
    ...IDLE_CUE,
    lines: ["CUESEA READY", "GAP · DEMO", "AWAITING GUEST SIGNAL"],
    meta: ["V0·1·15", "PRESS TO ASK", "2X EXIT", "UP FOR RULER"],
    logo: true,
    clock: "14·32", mic: "closed",
  }),
  guest: buildCue({
    lines: ["IN CART CASHSOFT CREW", "BOUGHT BARREL JEANS TWICE", "OFFER IT IN SIZE M"],
    facts: RAIL, meta: ["DENIM WALL"],
    moduleIndex: 0, moduleCount: 4, moduleName: "CUE",
    logo: true, clock: "14·32", mic: "closed",
  }, 1180),
  pick: buildCue({
    lines: ["HIGH RISE BARREL JEANS", "DENIM WALL BAY 3", "9 ON HAND IN 28X30"],
    facts: RAIL, meta: ["$90"],
    moduleIndex: 1, moduleCount: 4, moduleName: "PICK",
    logo: true, clock: "14·32", mic: "closed",
  }),
  listening: buildCue({
    lines: ["LISTENING", "███████▒▒▒▒▒", ""],
    facts: RAIL, meta: ["1·4S"],
    moduleIndex: 0, moduleCount: 4, moduleName: "CUE",
    logo: true, clock: "14·32", mic: "open",
  }),
};

/**
 * The fit, measured rather than drawn.
 *
 * This file used to hand the drawing to `render-lens.py`, which approximated
 * the fit with a desktop font scaled to the box — an approximation of an
 * approximation, and the second one (that the host scales glyphs to the
 * container) may not even be true. The verdict now comes from Even's own font
 * tables: exactly what the firmware will lay out for these strings, in these
 * boxes. The picture is still a picture; the pass/fail is a measurement.
 */
const overruns = [];
for (const [name, page] of Object.entries(pages)) {
  const over = (label, text, box, pad) => {
    const budget = box - pad * 2;
    const px = getTextWidth(text);
    if (px > budget) overruns.push(`${name}/${label}: ${JSON.stringify(text)} needs ${px}px in ${budget}px`);
  };
  for (const c of page.textObject) {
    over(c.containerName, c.content, c.width, c.paddingLength ?? 0);
  }
  for (const l of page.listObject || []) {
    for (const row of l.itemContainer.itemName) {
      over(l.containerName, row, l.width, l.paddingLength ?? 0);
    }
  }
}

console.log(JSON.stringify({ pages, overruns }, null, 2));
