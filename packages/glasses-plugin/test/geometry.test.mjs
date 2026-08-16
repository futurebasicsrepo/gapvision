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
  LABEL_W: 64, CLOCK_W: 104,                // width: 64 / width: 104 in the header
  HEADER_Y: 12, BODY_TOP: 52,               // const HEADER_Y = 12; const BODY_TOP = 52
  FOOT_Y: 254,                              // DISPLAY_H - 34
  MENU_TITLE_Y: 50, MENU_TOP: 84,           // yPosition: 50 / yPosition: 84 in buildMenu
  LINE_CHARS: 33,                           // fitChars(536, 26)
  RAIL_LINE_CHARS: 21,                      // fitChars(354, 26)
  FACT_CHARS: 10,                           // fitChars(168, 26)
  FACT_SLOTS: 6,                            // export const FACT_SLOTS = 6
  MENU_ROWS: 6,                             // export const MENU_ROWS = 6
};

const D = L.createGeometry(576, 288);
for (const [k, v] of Object.entries(OLD)) eq(`default geometry: ${k}`, D[k], v);

// The budgets have to come out of `fitChars` and not out of a table, or the
// next `CHAR_ASPECT` calibration moves the rule and leaves the numbers behind.
eq("LINE_CHARS is fitChars(W, LINE_H)", D.LINE_CHARS, L.fitChars(OLD.W, OLD.LINE_H));
eq("RAIL_LINE_CHARS is fitChars(MODULE_W, LINE_H)",
   D.RAIL_LINE_CHARS, L.fitChars(OLD.MODULE_W, OLD.LINE_H));
eq("FACT_CHARS is fitChars(RAIL_W, RAIL_ROW)",
   D.FACT_CHARS, L.fitChars(OLD.RAIL_W, OLD.RAIL_ROW));

// --- 2. the named exports are still the default geometry ----------------------
// `cards.ts`, `main.ts`, `cue.py`'s contract and four test files import these
// by name. Adding the seam was the job; migrating every call site was not.
for (const k of ["DISPLAY_W", "DISPLAY_H", "LINE_CHARS", "RAIL_LINE_CHARS",
                 "FACT_CHARS", "FACT_SLOTS", "MENU_ROWS"]) {
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

  const railBottom = g.BODY_TOP + g.FACT_SLOTS * g.RAIL_ROW;
  check(`${tag}: a full rail clears the footer`,
    railBottom <= g.FOOT_Y,
    `${g.FACT_SLOTS} rows end ${railBottom}, footer at ${g.FOOT_Y}`);

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

  // The character counts are where the two records actually differed, and the
  // site's is the wrong one: 188 ÷ (26 × 0.60) = 12.05 only if you spend the
  // padding on glyphs. `fitChars` does not, so the honest budget at 640 is 11.
  // Ten at 576 is unchanged because there the two methods happen to agree.
  eq("10 rail characters at 576", a.FACT_CHARS, 10);
  eq("11 rail characters at 640 — not 12, which spends the padding",
    b.FACT_CHARS, 11);
  check("the rail budget grows with the frame and never shrinks",
    b.FACT_CHARS > a.FACT_CHARS, `${a.FACT_CHARS} -> ${b.FACT_CHARS}`);
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
  check("the same width gives the same character budgets on both",
    short.LINE_CHARS === tall.LINE_CHARS && short.FACT_CHARS === tall.FACT_CHARS,
    `${short.LINE_CHARS}/${short.FACT_CHARS} vs ${tall.LINE_CHARS}/${tall.FACT_CHARS}`);
  // 640 × 200: header 12–38, three lines 52–142, footer 166–192, rail 4 rows
  // 52–156. The grammar fits; the sixth and fifth facts do not.
  eq("640x200 holds four rail rows", short.FACT_SLOTS, 4);
  eq("640x200 holds three menu rows", short.MENU_ROWS, 3);
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
