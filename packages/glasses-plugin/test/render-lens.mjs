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
 *
 * Image containers carry their actual pixels: the hero rail is rendered here
 * through the same `heroRail` the phone runs, and shipped to the drawing as
 * base64 — so the preview's dot type and garment icons are the real bytes,
 * not an artist's impression of them.
 */
import { getTextWidth } from "@evenrealities/pretext";
import { buildCue, IDLE_CUE } from "../dist-test/layout.mjs";
import { heroClock, heroRail } from "../dist-test/hero.mjs";

const NAME = "MAYA OKAFOR";
const FACTS = ["ICON", "4200 PTS", "TOP M", "BTM 28X30"];

const pages = {
  idle: buildCue({
    ...IDLE_CUE,
    heroClock: true, cardTitle: "AWAITING GUEST SIGNAL", lines: [],
    meta: ["V0·3·0", "GAP · DEMO", "PRESS TO ASK", "2X EXIT"],
    logo: true, clock: "14·32", mic: "closed",
  }),
  guest: buildCue({
    lines: ["IN CART MID RISE VINTAGE SLIM", "OFFER IT IN SIZE M", "THEN CASHSOFT CREW"],
    name: NAME, facts: FACTS, hero: true,
    meta: ["DENIM WALL"], cardTitle: "CUE · 1/7",
    logo: true, clock: "14·32", mic: "closed", unread: 2,
  }, 1180),
  "cart, clicked in": buildCue({
    lines: ["MID RISE VINTAGE SLIM $128", "CASHSOFT CREW SWEATER $89", "RELAXED CHINO $98"],
    name: NAME, facts: FACTS, hero: true,
    meta: ["$412 · ONLINE"], cardTitle: "CART · 2-4/6", focused: true,
    logo: true, clock: "14·32", mic: "closed", unread: 2, battery: 18,
  }),
  "text rail fallback": buildCue({
    lines: ["HIGH RISE BARREL JEANS", "DENIM WALL BAY 3", "9 ON HAND IN 28X30"],
    name: NAME, facts: FACTS,
    meta: ["$90"], cardTitle: "PICK · 5/7",
    logo: true, clock: "14·32", mic: "open",
  }),
};

/** The hero pixels each page's image containers need, keyed by page then
 *  container name. The mark is pasted by the drawing from its own source. */
const images = {};
for (const [name, page] of Object.entries(pages)) {
  for (const c of page.imageObject || []) {
    const png = c.containerName === "cue-hero" ? heroRail("M", "28X30", "4200 PTS")
      : c.containerName === "cue-idle-clock" ? heroClock("14·32")
      : null;
    if (!png) continue;
    images[name] = images[name] || {};
    images[name][c.containerName] = Buffer.from(png).toString("base64");
  }
}

/**
 * The fit, measured rather than drawn.
 *
 * The verdict comes from Even's own font tables: exactly what the firmware
 * will lay out for these strings, in these boxes. The picture is still a
 * picture; the pass/fail is a measurement.
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

console.log(JSON.stringify({ pages, images, overruns }, null, 2));
