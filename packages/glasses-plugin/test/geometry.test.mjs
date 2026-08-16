/**
 * The geometry factory's own contract.
 *
 *   node packages/glasses-plugin/test/geometry.test.mjs
 *
 * `layout.ts` used to hard-code 576 × 288 and derive every position, width and
 * character budget from those two numbers at module scope. It is now
 * `createGeometry(width, height)`, because the G2 is not one frame: 576 × 288
 * is the physical display per eye, ~640 × 200 is the optical panel
 * configuration in the specs, and the native dashboard is a fixed-size context
 * canvas *per surface view* — several surfaces, each with a size.
 *
 * Two things this file exists to hold down.
 *
 * **One: the refactor is behaviour-preserving.** Every number the module
 * exported before the change is transcribed below as a literal, read off the
 * pre-refactor source, and asserted against the factory at 576 × 288. If a
 * later tidy-up moves a fraction or a rounding, this fails rather than the
 * glass quietly moving under an associate.
 *
 * **Two: the asymmetry survives.** Positions and widths scale with the frame;
 * `ROW_H`, the paddings and the type floor do not, because the floor belongs
 * to the host's renderer and not to the display — a box under it is not
 * smaller text, it is clipped text. So a shorter frame gets *fewer rows*, and
 * this file asserts that the rows it does get do not land on each other.
 */
import { getAdvW, getTextWidth } from "@evenrealities/pretext";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "dist-test", "layout.mjs");
await build({
  entryPoints: [join(here, "..", "src", "layout.ts")],
  bundle: true, format: "esm", external: ["./bridge"], outfile: out, logLevel: "silent",
});
const L = await import(`file://${out}`);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const eq = (name, actual, expected) =>
  check(name, actual === expected, `got ${actual}, expected ${expected}`);

// --- 1. the default frame reproduces the module as it was ---------------------
// Transcribed from layout.ts before the refactor. These are literals on
// purpose: deriving them here from the same code under test would assert
// nothing at all.
const OLD = {
  DISPLAY_W: 576, DISPLAY_H: 288,           // export const DISPLAY_W = 576
  X: 20, W: 536,                            // const X = 20; W = DISPLAY_W - X * 2
  RAIL_W: 168, GUTTER: 14,                  // const RAIL_W = 168 ("BOTTOMS 28X30")
  MODULE_X: 202, MODULE_W: 354,             // X + RAIL_W + GUTTER; DISPLAY_W - MODULE_X - X
  ROW_H: 26, HEADER_H: 26, LINE_H: 26,      // measured on glass: 24 clips, 26 is whole
  RAIL_ROW: 26, META_H: 26,
  LINE_STEP: 32, PAD: 4,
  // 176, was 104: the clock container became the status cluster — mic,
  // unread, low battery, time — and the worst case measures ~150px.
  LABEL_W: 64, CLOCK_W: 176,
  HEADER_Y: 12, BODY_TOP: 52,               // const HEADER_Y = 12; const BODY_TOP = 52
  FOOT_Y: 254,                              // DISPLAY_H - 34
  MENU_TITLE_Y: 50, MENU_TOP: 84,           // yPosition: 50 / yPosition: 84 in buildMenu
  // 5, was 6: the guest's name left the rail for its own container, and the
  // text rail is the hero's fallback, starting a name-row lower (HERO_Y).
  FACT_SLOTS: 5,
  MENU_ROWS: 6,                             // export const MENU_ROWS = 6
};

const D = L.createGeometry(576, 288);
for (const [k, v] of Object.entries(OLD)) eq(`default geometry: ${k}`, D[k], v);

// --- 1b. the budgets are pixels, and they are the box minus its padding ------
//
// `LINE_CHARS`, `RAIL_LINE_CHARS` and `FACT_CHARS` are gone with `fitChars`
// and `CHAR_ASPECT`. They were character counts derived from one ratio — glyph
// advance as a fraction of container height — and the G2's font is
// proportional, so no single count could have described it. What replaced them
// is the drawable width of each box; whether a string fits is a question for
// the font tables.
eq("LINE_PX is the content width less its padding", D.LINE_PX, OLD.W - OLD.PAD * 2);
eq("RAIL_LINE_PX is the module column less its padding",
   D.RAIL_LINE_PX, OLD.MODULE_W - OLD.PAD * 2);
// The rail keeps its extra 2px of inset, and no longer pays for a border it
// was never drawing as a rule — see `RAIL_BORDER` in layout.ts.
eq("FACT_PX is the rail less its padding", D.FACT_PX, OLD.RAIL_W - (OLD.PAD + 2) * 2);
check("no character budget survives the change",
  L.LINE_CHARS === undefined && L.RAIL_LINE_CHARS === undefined
  && L.FACT_CHARS === undefined && L.fitChars === undefined,
  "a count is the fault, not the fix");

// --- 2. the named exports are still the default geometry ----------------------
// `cards.ts`, `main.ts`, `cue.py`'s contract and four test files import these
// by name. Adding the seam was the job; migrating every call site was not.
for (const k of ["DISPLAY_W", "DISPLAY_H", "LINE_PX", "RAIL_LINE_PX",
                 "FACT_PX", "FACT_SLOTS", "MENU_ROWS"]) {
  check(`export ${k} is bound to the default geometry`,
    L[k] === D[k] && L[k] === L.DEFAULT_GEOMETRY[k], `${L[k]} vs ${D[k]}`);
}
eq("CUE_LINES is still the contract", L.CUE_LINES, 3);
// Host limits, not geometry — they do not belong to a frame and must not move
// with one.
eq("MAX_TEXT_CONTAINERS", L.MAX_TEXT_CONTAINERS, 8);
eq("MAX_IMAGE_CONTAINERS", L.MAX_IMAGE_CONTAINERS, 4);
eq("MAX_TOTAL_CONTAINERS", L.MAX_TOTAL_CONTAINERS, 12);
check("RULER_HEIGHTS is untouched",
  L.RULER_HEIGHTS.join(",") === "20,24,26,28,32", L.RULER_HEIGHTS.join(","));

// --- 3. every frame: the grammar has to fit ----------------------------------
// Header, three cue lines, the rail, the footer. Anything that overlaps here
// would be drawn on top of something else on the glass with nothing in any log
// to say so — the failure mode this whole file is written against.
const FRAMES = [[576, 288], [640, 200], [640, 288], [576, 200]];
for (const [w, h] of FRAMES) {
  const g = L.createGeometry(w, h);
  const tag = `${w}x${h}`;

  check(`${tag}: the row height is the measured floor, not a fraction`,
    g.ROW_H === 26 && g.LINE_H === 26 && g.RAIL_ROW === 26 && g.PAD === 4,
    `row ${g.ROW_H}, pad ${g.PAD}`);

  check(`${tag}: the columns add up to the frame`,
    g.X + g.RAIL_W + g.GUTTER + g.MODULE_W + g.X === w,
    `${g.X}+${g.RAIL_W}+${g.GUTTER}+${g.MODULE_W}+${g.X} vs ${w}`);

  check(`${tag}: the header clears the body`,
    g.HEADER_Y + g.HEADER_H <= g.BODY_TOP,
    `header ends ${g.HEADER_Y + g.HEADER_H}, body starts ${g.BODY_TOP}`);

  check(`${tag}: three cue lines clear the footer`,
    g.BODY_BOTTOM <= g.FOOT_Y,
    `lines end ${g.BODY_BOTTOM}, footer at ${g.FOOT_Y}`);

  // The left column: name row, then the rail (hero image or text rows).
  const railBottom = g.HERO_Y + g.FACT_SLOTS * g.RAIL_ROW;
  check(`${tag}: a name row and a full rail clear the footer`,
    g.NAME_Y + g.ROW_H <= g.HERO_Y && railBottom <= g.FOOT_Y,
    `${g.FACT_SLOTS} rows end ${railBottom}, footer at ${g.FOOT_Y}`);

  check(`${tag}: the card frame sits between the header and the footer`,
    g.CARD_Y >= g.HEADER_Y + g.HEADER_H
    && g.CARD_Y + g.CARD_H <= g.FOOT_Y
    && g.CARD_BODY_TOP > g.CARD_Y
    && g.BODY_BOTTOM < g.CARD_Y + g.CARD_H,
    `card ${g.CARD_Y}..${g.CARD_Y + g.CARD_H}, footer at ${g.FOOT_Y}`);

  check(`${tag}: the footer is on the display`,
    g.FOOT_Y + g.META_H <= h, `footer ends ${g.FOOT_Y + g.META_H} of ${h}`);

  const menuBottom = g.MENU_TOP + g.MENU_ROWS * g.ROW_H;
  check(`${tag}: the floor menu clears its own footer`,
    g.MENU_TITLE_Y + g.ROW_H <= g.MENU_TOP && menuBottom <= g.FOOT_Y,
    `${g.MENU_ROWS} rows end ${menuBottom}, footer at ${g.FOOT_Y}`);

  check(`${tag}: the clock box is inside the frame`,
    w - g.X - g.CLOCK_W >= g.X + g.LABEL_W,
    `label ends ${g.X + g.LABEL_W}, clock starts ${w - g.X - g.CLOCK_W}`);
}

// --- 4. the rail, at both widths ---------------------------------------------
// The long-standing "the rail is 168/10 but the site says 188/12". One
// fraction, two frames: 168/576 = 0.2917, and 0.2917 of 640 is 187 — the
// site's 188 to within a pixel of rounding. The *widths* were never in
// conflict.
{
  const a = L.createGeometry(576, 288);
  const b = L.createGeometry(640, 288);
  eq("the rail is 168 at 576", a.RAIL_W, 168);
  check("the rail is the site's 188 at 640, within a pixel of rounding",
    Math.abs(b.RAIL_W - 188) <= 1, `${b.RAIL_W}`);
  check("the rail is the same fraction of both frames",
    Math.abs(a.RAIL_W / 576 - b.RAIL_W / 640) < 0.002,
    `${(a.RAIL_W / 576).toFixed(4)} vs ${(b.RAIL_W / 640).toFixed(4)}`);

  // The character counts were where the two records differed, and neither of
  // them was answerable: 10 and 12 are two ways of dividing a box by an
  // average glyph, and the rail draws names. What the rail actually holds is a
  // question about a string, and it has an exact answer.
  eq("156px of rail at 576", a.FACT_PX, 156);
  check("MAYA OKAFOR fits the 576 rail whole — the name that started this",
    getTextWidth("MAYA OKAFOR") <= a.FACT_PX,
    `${getTextWidth("MAYA OKAFOR")}px in ${a.FACT_PX}px`);
  check("eleven wide characters do not, and the 12-char budget said they would",
    getTextWidth("WWWWWWWWWWW") > a.FACT_PX,
    `${getTextWidth("WWWWWWWWWWW")}px in ${a.FACT_PX}px`);
  check("BOTTOMS 28X30 fits, which is why the rail is 168 and not 148",
    getTextWidth("BOTTOMS 28X30") <= a.FACT_PX,
    `${getTextWidth("BOTTOMS 28X30")}px in ${a.FACT_PX}px`);
  check("the rail budget grows with the frame and never shrinks",
    b.FACT_PX > a.FACT_PX, `${a.FACT_PX} -> ${b.FACT_PX}`);
}

// --- 5. a short frame loses rows, never row height ---------------------------
// The one thing the calibration forbids is inventing a smaller row to make six
// facts fit on a 200px frame. 26 is the smallest this display draws whole and
// there is nothing below it to try.
{
  const tall = L.createGeometry(640, 288);
  const short = L.createGeometry(640, 200);
  eq("a short frame keeps the row height", short.ROW_H, tall.ROW_H);
  check("a short frame gives up rows instead",
    short.FACT_SLOTS < tall.FACT_SLOTS && short.MENU_ROWS < tall.MENU_ROWS,
    `facts ${tall.FACT_SLOTS}->${short.FACT_SLOTS}, menu ${tall.MENU_ROWS}->${short.MENU_ROWS}`);
  check("the same width gives the same pixel budgets on both",
    short.LINE_PX === tall.LINE_PX && short.FACT_PX === tall.FACT_PX,
    `${short.LINE_PX}/${short.FACT_PX} vs ${tall.LINE_PX}/${tall.FACT_PX}`);
  // 640 × 200: header 12–38, footer 166–192, and the rail starts under the
  // name row at 86 — three rows fit; the fourth and fifth do not.
  eq("640x200 holds three rail rows", short.FACT_SLOTS, 3);
  eq("640x200 holds three menu rows", short.MENU_ROWS, 3);
}


// --- 6. the charset is what the font has, not what somebody typed ------------
//
// The charset used to be the literal `[A-Z0-9 ·%$£€/+-]` written into two
// files and three comments. It banned glyphs the G2 renders perfectly — every
// box-drawing character, the blocks, the arrow — and one of the casualties was
// the voice level meter, which is drawn from `█` and has therefore never once
// appeared on the glass: every block was replaced with a space on the way out.
//
// So it is derived: `text.ts` asks the font tables for each candidate's
// advance and keeps what exists. These assertions are the other half of that.
// If a firmware font drops a glyph, this suite fails; the alternative is
// finding out from a hole in the middle of a word on somebody's face.
{
  check("nothing we ask for is missing from the font",
    L.MISSING_GLYPHS.length === 0, L.MISSING_GLYPHS.join(" ") || "all present");

  // Verified present at 20px (320/16), and the reason the rule and the state
  // light are possible at all.
  const STRUCTURE = "─│┌┐└┘├┤┬┴┼━┃═█▌▒■★";
  const banned = [...STRUCTURE].filter((c) => !L.GLASS_CHARS.includes(c));
  check("the box-drawing and block glyphs are admitted",
    banned.length === 0, banned.join(" ") || "all admitted");

  check("the arrow and the two dots are admitted",
    ["→", "·", "•"].every((c) => L.GLASS_CHARS.includes(c)));

  // The other half of a derived charset: glyphs that are *not* there. All five
  // measure 0 advance, and this is written down so the next person reaching
  // for a tick mark does not have to rediscover it on hardware.
  const ABSENT = "║░▸✓▮";
  const present = [...ABSENT].filter((c) => getAdvW(c.codePointAt(0)) !== 0);
  check("the glyphs the font does not have are still missing", present.length === 0,
    present.join(" ") || "║ ░ ▸ ✓ ▮ all absent, as measured");
  check("and none of them can reach the glass",
    [...ABSENT].every((c) => !L.GLASS_CHARS.includes(c)));

  // Lowercase and ordinary punctuation are *declined*, not absent — the font
  // has all of them. That distinction is the reason the charset is a brand
  // rule applied to a measured set, rather than a measured set on its own.
  check("the font has a full stop and a colon; the charset declines them",
    getAdvW(".".codePointAt(0)) > 0 && getAdvW(":".codePointAt(0)) > 0
    && !L.GLASS_CHARS.includes(".") && !L.GLASS_CHARS.includes(":"));

  check("a comma still becomes a space on the way to the glass",
    L.toDisplayText("SIZE M, TOP") === "SIZE M TOP",
    JSON.stringify(L.toDisplayText("SIZE M, TOP")));

  check("the level meter's blocks now survive the filter",
    L.toDisplayText("███▒▒▒") === "███▒▒▒",
    JSON.stringify(L.toDisplayText("███▒▒▒")));
}

// --- 7. the strings the old model got wrong, in both directions -------------
//
// One eleven-character string is 56px, another is 176px, and a character
// budget calls them the same. For plain uppercase Latin the 0.60 ratio landed
// close at the wide end almost by luck — the widest letter is 16px against the
// 15.6px it assumed — and badly wrong at the narrow end, which is why real
// names were being shortened for nothing. Where it broke outright is the
// rail's ten-character rows, and anything drawn from the glyphs the old
// hand-written charset banned: every box-drawing and block glyph is 20px, a
// third wider than the ratio ever allowed for.
{
  const RAIL = ["MAYA OKAFOR", "ICON", "TOP M", "BTM 28X30"];

  // Too wide, and it used to "fit": ten characters was exactly the rail's old
  // budget, and ten of the widest letters is 160px in a 156px column. The
  // glass renders that by clipping, silently, which is the whole "font is cut
  // off" complaint.
  const WIDE = "WWWWWWWWWW";   // 10 characters — the old budget, to the letter
  const wide = L.buildCue({ lines: ["A"], facts: [WIDE], moduleCount: 0 });
  const wideRow = wide.listObject[0].itemContainer.itemName[0];
  check("a ten-character rail row that used to pass now truncates",
    WIDE.length === 10 && getTextWidth(WIDE) > D.FACT_PX
    && wideRow.endsWith("+") && getTextWidth(wideRow) <= D.FACT_PX,
    `${getTextWidth(WIDE)}px into ${D.FACT_PX}px → ${JSON.stringify(wideRow)}`);

  // The same fault, larger, on the glyphs the widened charset admits: twenty
  // blocks is twenty characters against a 21-character budget, and 400px
  // against a 346px box. A count would have waved this straight through — and
  // this is not a hypothetical string, it is the shape of the level meter.
  const BLOCKS = "█".repeat(20);
  const blocks = L.buildCue({ lines: [BLOCKS], facts: RAIL, meta: [], moduleCount: 0 });
  const blockLine = blocks.textObject.find((c) => c.containerName === "cue-line-1").content;
  check("twenty block glyphs are 400px, not twenty characters' worth",
    getTextWidth(BLOCKS) > D.RAIL_LINE_PX && getTextWidth(blockLine) <= D.RAIL_LINE_PX,
    `${getTextWidth(BLOCKS)}px into ${D.RAIL_LINE_PX}px → ${blockLine.length} glyphs`);

  // Too narrow to have been truncated, and it was. 24 characters against a
  // 21-character budget, and 189px against a 346px box.
  const NARROW = "IN LIST TILL TILL TILL 1";   // 24 characters
  const narrow = L.buildCue({ lines: [NARROW], facts: RAIL, meta: [], moduleCount: 0 });
  const narrowLine = narrow.textObject.find((c) => c.containerName === "cue-line-1").content;
  check("a narrow 24-character line that used to truncate now arrives whole",
    NARROW.length > 21 && narrowLine === NARROW
    && getTextWidth(NARROW) <= D.RAIL_LINE_PX,
    `${getTextWidth(NARROW)}px into ${D.RAIL_LINE_PX}px → ${JSON.stringify(narrowLine)}`);

  // The narrow case where it actually cost something: eleven characters was
  // over the rail's old ten, so `MAYA OKAFOR` was being shortened to `MAYA O`
  // beside a column it fits inside with 29px to spare.
  const rail = narrow.listObject[0].itemContainer.itemName;
  check("MAYA OKAFOR reaches the rail whole",
    rail[0] === "MAYA OKAFOR" && getTextWidth(rail[0]) <= D.FACT_PX,
    `${JSON.stringify(rail[0])} at ${getTextWidth(rail[0])}px in ${D.FACT_PX}px`);

  // Nothing on any page may exceed the box it was given. This is the assertion
  // the whole change exists to make possible: before, it could not be written,
  // because there was no way to ask how wide a string was.
  const pages = {
    idle: L.buildCue({ lines: ["CUESEA READY", "GAP · DEMO", "AWAITING GUEST SIGNAL"],
                       meta: ["V0·1·15", "PRESS TO ASK", "2X EXIT"], mic: "closed" }),
    guest: L.buildCue({ lines: ["IN CART CASHSOFT CREW", "BOUGHT BARREL JEANS TWICE",
                                "OFFER IT IN SIZE M"],
                        facts: RAIL, meta: ["DENIM WALL"], moduleCount: 4,
                        moduleName: "CUE", mic: "open" }, 1180),
    menu: L.buildMenu("FLOOR · 2 WAITING",
                      ["MARCUS NEED BACKUP IN THE FITTING ROOMS", "ON MY WAY"], 0,
                      { mic: "closed" }),
  };
  const over = [];
  for (const [name, page] of Object.entries(pages)) {
    for (const c of page.textObject) {
      const budget = c.width - (c.paddingLength ?? 0) * 2;
      if (getTextWidth(c.content) > budget) {
        over.push(`${name}/${c.containerName}: ${getTextWidth(c.content)}px in ${budget}px`);
      }
    }
    for (const l of page.listObject || []) {
      const budget = l.width - (l.paddingLength ?? 0) * 2;
      for (const row of l.itemContainer.itemName) {
        if (getTextWidth(row) > budget) {
          over.push(`${name}/${l.containerName}: ${JSON.stringify(row)} ${getTextWidth(row)}px in ${budget}px`);
        }
      }
    }
  }
  check("every row on every page fits the box it was given", over.length === 0,
    over.join("; ") || "measured against the firmware's own metrics");
}

// --- 8. the voice indicator --------------------------------------------------
//
// There was no way to see whether the mic was open. It shares the clock's
// container rather than taking one of its own, because a railed guest page
// with the wordmark fallback already spends all eight text containers the host
// allows — and the container that buys is spent on the rule.
{
  const clockOf = (mic) =>
    L.buildCue({ lines: ["A"], clock: "14·32", mic }).textObject
      .find((c) => c.containerName === "cue-clock").content;

  check("mic open and mic closed are visibly different",
    clockOf("open") !== clockOf("closed"),
    `${JSON.stringify(clockOf("open"))} vs ${JSON.stringify(clockOf("closed"))}`);

  check("neither state can be mistaken for a cue — it is one glyph and the time",
    clockOf("open").trim() === "█ 14·32" && clockOf("closed").trim() === "▒ 14·32",
    `${clockOf("open").trim()} / ${clockOf("closed").trim()}`);

  // The property that keeps it from being a distraction: both glyphs are the
  // same advance, so the time does not move when the mic opens. The cluster
  // is right-aligned by measured leading spaces, so "does not move" is now a
  // fact about the *padded* width — asserted to within one space glyph.
  check("the clock does not shift sideways when the mic opens",
    Math.abs(getTextWidth(clockOf("open")) - getTextWidth(clockOf("closed")))
      < getTextWidth(" "),
    `${getTextWidth(clockOf("open"))}px vs ${getTextWidth(clockOf("closed"))}px`);

  check("voice switched off draws no state light at all",
    clockOf("off").trim() === "14·32", JSON.stringify(clockOf("off").trim()));

  check("the cluster fits the clock box",
    getTextWidth(clockOf("open")) <= D.CLOCK_PX,
    `${getTextWidth(clockOf("open"))}px in ${D.CLOCK_PX}px`);

  // The rest of the cluster: unread and low battery are state lights on the
  // same rules — drawn when they are information, absent when they are not.
  const cluster = (cue) =>
    L.buildCue({ lines: ["A"], clock: "14·32", ...cue }).textObject
      .find((c) => c.containerName === "cue-clock").content.trim();
  check("an unread message is a dot and a count ahead of the clock",
    cluster({ mic: "closed", unread: 2 }) === "▒ •2 14·32",
    JSON.stringify(cluster({ mic: "closed", unread: 2 })));
  check("a battery at or under 20 shows itself as a percentage",
    cluster({ mic: "off", battery: 18 }) === "18% 14·32",
    JSON.stringify(cluster({ mic: "off", battery: 18 })));
  check("a healthy battery and an empty inbox draw nothing",
    cluster({ mic: "off", battery: 80, unread: 0 }) === "14·32",
    JSON.stringify(cluster({ mic: "off", battery: 80, unread: 0 })));
  check("the whole cluster lit still fits the box",
    getTextWidth(cluster({ mic: "open", unread: 9, battery: 18 })) <= D.CLOCK_PX,
    `${getTextWidth(cluster({ mic: "open", unread: 9, battery: 18 }))}px in ${D.CLOCK_PX}px`);

  // The state light lives in the container the cheap path can update, so the
  // mic opening is a text upgrade rather than a page rebuild.
  const shape = (mic) => L.buildCue({ lines: ["A"], mic }).textObject
    .map((c) => c.containerID).join(",");
  check("opening the mic does not change the page shape",
    shape("open") === shape("closed") && shape("closed") === shape("off"));
}

// --- 9. the card frame -------------------------------------------------------
//
// The structural rule is gone; the card frame replaced it. The module region
// is a visibly contained card now — one bordered container whose content is
// the title row, with the three lines inside it. The frame's border is the
// focus state: 1 browsing the deck, 3 clicked in.
{
  const railed = L.buildCue({ lines: ["A"], name: "MAYA OKAFOR",
                              facts: ["ICON", "TOP M"],
                              meta: ["DENIM WALL"], moduleCount: 4,
                              moduleName: "CUE", moduleIndex: 0 });
  const frame = railed.textObject.find((c) => c.containerName === "cue-card");
  check("a cue draws the card frame", frame !== undefined,
    frame ? JSON.stringify(frame.content) : "missing");

  check("the frame is a border, not a panel of text",
    frame.borderWidth === 1 && frame.borderRadius > 0,
    `border ${frame.borderWidth}, radius ${frame.borderRadius}`);

  check("the frame carries the card title and the deck position",
    frame.content === "CUE · 1/4", JSON.stringify(frame.content));

  check("the frame sits on the geometry's card stops",
    frame.yPosition === D.CARD_Y && frame.height === D.CARD_H,
    `${frame.yPosition}+${frame.height} vs ${D.CARD_Y}+${D.CARD_H}`);

  // The lines live inside the frame, under the title.
  const lines = railed.textObject.filter((c) => /^cue-line/.test(c.containerName));
  check("the three lines sit inside the frame, under its title",
    lines.every((c) => c.yPosition >= D.CARD_BODY_TOP
      && c.yPosition + c.height <= D.CARD_Y + D.CARD_H
      && c.xPosition >= frame.xPosition),
    lines.map((c) => `${c.containerName}@${c.yPosition}`).join(","));

  check("clicking in thickens the border",
    L.buildCue({ lines: ["A"], focused: true }).textObject
      .find((c) => c.containerName === "cue-card").borderWidth === 3);

  check("the name row sits above the rail in its own container",
    railed.textObject.some((c) => c.containerName === "cue-name"
      && c.yPosition === D.NAME_Y && c.content === "MAYA OKAFOR"));

  // One frame on this display: the rail stays borderless.
  check("the rail no longer asks for a border box",
    (railed.listObject[0].borderWidth ?? 0) === 0
    && railed.listObject[0].borderRadius === undefined,
    `border ${railed.listObject[0].borderWidth}`);

  // A short surface gives up the card's title row the way it gives up rail
  // rows — the lines are the cue; the title is furniture.
  const short = L.createGeometry(640, 200);
  check("a 200px frame drops the title row and keeps three whole lines",
    short.CARD_TITLED === false && short.CARD_BODY_TOP === short.BODY_TOP
    && short.CARD_Y + short.CARD_H <= short.FOOT_Y,
    `card ${short.CARD_Y}..${short.CARD_Y + short.CARD_H}, footer ${short.FOOT_Y}`);
  check("the 576x288 frame affords the title", D.CARD_TITLED === true);

  // The floor menu deliberately has no frame — a list of equal rows is
  // already structure, and a frame would cost a row of floor comms.
  const menu = L.buildMenu("FLOOR", ["ON MY WAY"], 0, {});
  check("the floor menu spends the space on rows instead of a frame",
    !menu.textObject.some((c) => c.borderWidth) && D.MENU_ROWS === 6);
}

// --- 10. the menu cursor, measured ------------------------------------------
// Unselected rows are padded so the text does not jump sideways as the cursor
// moves. That worked by luck of a hoped-for uniform glyph width; it works by
// measurement now, and the measurement says the two are exactly equal.
check("the cursor and its padding are the same width",
  getTextWidth("· ") === getTextWidth("  "),
  `${getTextWidth("· ")}px vs ${getTextWidth("  ")}px`);

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
