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
import { buildCue, IDLE_CUE } from "../dist-test/layout.mjs";

const RAIL = ["SARAH C", "ICON", "4200 PTS", "TOP M", "BTM 28X30"];

const pages = {
  idle: buildCue({
    ...IDLE_CUE,
    lines: ["CUESEA READY", "GAP · DEMO", "AWAITING GUEST SIGNAL"],
    meta: ["V0·1·8", "PRESS TO ASK", "2X EXIT", "UP FOR RULER"],
    logo: true,
    clock: "14·32",
  }),
  guest: buildCue({
    lines: ["IN CART CASHSOFT CREW", "BOUGHT BARREL JEANS TWICE", "OFFER IT IN SIZE M"],
    facts: RAIL, meta: ["DENIM WALL"],
    moduleIndex: 0, moduleCount: 4, moduleName: "CUE",
    logo: true, clock: "14·32",
  }, 1180),
  pick: buildCue({
    lines: ["HIGH RISE BARREL JEANS", "DENIM WALL BAY 3", "9 ON HAND IN 28X30"],
    facts: RAIL, meta: ["$90"],
    moduleIndex: 1, moduleCount: 4, moduleName: "PICK",
    logo: true, clock: "14·32",
  }),
};

console.log(JSON.stringify(pages, null, 2));
