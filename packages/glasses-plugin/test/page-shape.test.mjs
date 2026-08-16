/**
 * Page shape — when the glass needs a rebuild rather than a text update.
 *
 *   node packages/glasses-plugin/test/page-shape.test.mjs
 *
 * `renderCue` has a cheap path: if the page shape is unchanged it sends
 * `textContainerUpgrade` per container instead of rebuilding. That call
 * updates a container by id — it cannot create one.
 *
 * The check used to compare the *number of lines*. Idle has three; a guest cue
 * has three; so when the fact rail shipped, the guest page's five new
 * containers (the rail and the module indicator) were never created and never
 * drawn. On the glasses the HUD simply looked unchanged, with nothing in any
 * log to say why.
 *
 * So the invariant this file defends: any two cues that need different
 * containers must not be considered the same shape.
 */
import { assertBudget, buildCue, buildMenu, buildRuler, MENU_ROWS,
         RULER_HEIGHTS } from "../dist-test/layout.mjs";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/** Exactly what `renderCue` compares — every container kind, tagged so a text
 *  id and a list id cannot collide. */
const shapeOf = (cue) => {
  const p = buildCue(cue);
  return [
    ...p.textObject.map((c) => `t${c.containerID}`),
    ...(p.listObject || []).map(
      (c) => `l${c.containerID}:${(c.itemContainer?.itemName || []).join("|")}`,
    ),
    ...(p.imageObject || []).map((c) => `i${c.containerID}`),
  ].join(",");
};

const IDLE = { lines: ["CUESEA READY", "GAP · DEMO", "AWAITING GUEST SIGNAL"],
               meta: ["PRESS TO ASK", "2X EXIT"] };
const RAIL = ["ICON", "4200 PTS", "TOPS M", "BOTTOMS 28X30"];
const GUEST = { lines: ["SARAH CHEN", "IN CART CASHSOFT CREW", "OFFER IT IN SIZE M"],
                facts: RAIL, meta: ["DENIM WALL"],
                moduleIndex: 0, moduleCount: 4, moduleName: "CUE" };
const PICK = { lines: ["HIGH RISE BARREL JEANS", "DENIM WALL", ""],
               facts: RAIL, meta: ["$90", "9 ON HAND"],
               moduleIndex: 1, moduleCount: 4, moduleName: "PICK" };

// The exact regression: both have three lines, so the old check called them
// identical and the rail was never built.
check("idle and a railed guest cue are different shapes",
  shapeOf(IDLE) !== shapeOf(GUEST),
  `idle=${shapeOf(IDLE)}  guest=${shapeOf(GUEST)}`);

check("the rail is one list container, not four text containers",
  buildCue(GUEST).listObject?.length === 1 &&
  buildCue(GUEST).listObject[0].itemContainer.itemName.length === RAIL.length,
  JSON.stringify(buildCue(GUEST).listObject?.[0]?.itemContainer?.itemName));

// The budget that made the rail invisible twice: text max 8, total max 12.
for (const [name, cue] of Object.entries({ idle: IDLE, guest: GUEST, pick: PICK })) {
  const p = buildCue(cue);
  const total = p.textObject.length + (p.listObject?.length || 0);
  check(`${name} page is inside the host budget`,
    p.textObject.length <= 8 && total <= 12,
    `${p.textObject.length} text, ${total} total`);
}

{
  // Hand `assertBudget` a page the host would drop, and require a throw.
  let threw = false;
  try {
    assertBudget({
      containerTotalNum: 9,
      textObject: Array.from({ length: 9 }, (_, i) => ({ containerID: i })),
    });
  } catch { threw = true; }
  check("an over-budget page throws instead of failing silently", threw);
}

check("a cue with no rail keeps the original container set",
  shapeOf(IDLE) === "t1,t2,t3,t4,t5,t7", shapeOf(IDLE));

// Scrolling between modules must NOT force a rebuild — same containers, only
// text changes. That is the whole point of the cheap path.
check("scrolling from the cue to a pick is the same shape",
  shapeOf(GUEST) === shapeOf(PICK),
  `${shapeOf(GUEST)} vs ${shapeOf(PICK)}`);

// Losing the rail (guest dismissed) has to rebuild, or stale facts stay lit.
check("dropping the rail is a shape change",
  shapeOf({ ...GUEST, facts: [], moduleCount: 0 }) !== shapeOf(GUEST));

// Line containers are now always present, empty ones included, so a shorter
// cue is a text update rather than a rebuild — the third container is simply
// blanked. Assert both halves: same shape, and the empty line really is empty.
check("a two-line cue is the same shape as a three-line cue",
  shapeOf({ lines: ["A", "B"] }) === shapeOf({ lines: ["A", "B", "C"] }));

{
  const two = buildCue({ lines: ["A", "B"] });
  const third = two.textObject.find((c) => c.containerName === "cue-line-3");
  check("the unused line container is built and blank",
    third !== undefined && third.content === "",
    third ? JSON.stringify(third.content) : "missing");
}

// --- the mark ----------------------------------------------------------------
// The logo is an image container, and an image container is a different
// container from the text one it replaces. If these compared equal, the
// fallback from mark to wordmark would take the cheap path and upgrade a text
// container that the page never built — the rail bug again, in the corner
// where the brand is.
check("the mark and the wordmark are different shapes",
  shapeOf({ ...GUEST, logo: true }) !== shapeOf(GUEST),
  `${shapeOf({ ...GUEST, logo: true })} vs ${shapeOf(GUEST)}`);

{
  const p = buildCue({ ...GUEST, logo: true });
  check("the mark replaces the wordmark rather than joining it",
    p.imageObject?.length === 1 &&
    !p.textObject.some((c) => c.containerName === "cue-label"),
    `${p.imageObject?.length} image, label present: ${p.textObject.some((c) => c.containerName === "cue-label")}`);

  // ImageContainerProperty has no isEventCapture field, so a page that swaps
  // the header for a mark loses its receiver unless the capture moved first.
  // Without one, a container tap reaches nothing and the HUD goes inert.
  const captures = p.textObject.filter((c) => c.isEventCapture === 1);
  check("a page with the mark still has exactly one gesture receiver",
    captures.length === 1, captures.map((c) => c.containerName).join(",") || "none");

  const total = p.textObject.length + (p.listObject?.length || 0) + p.imageObject.length;
  check("the marked, railed page is inside the host budget",
    p.textObject.length <= 8 && p.imageObject.length <= 4 && total <= 12,
    `${p.textObject.length} text, ${p.imageObject.length} image, ${total} total`);
}

{
  // Five image containers is one past Image_Object's max_count of 4 — the
  // budget nobody has hit yet, asserted before somebody does.
  let threw = false;
  try {
    assertBudget({
      containerTotalNum: 6,
      textObject: [{ containerID: 1 }],
      imageObject: Array.from({ length: 5 }, (_, i) => ({ containerID: 10 + i })),
    });
  } catch { threw = true; }
  check("too many image containers throws", threw);
}

// --- the rows that were cut off on glass -------------------------------------
// Kyle read the bottom row as "cut off" and the header as "too large for the
// container". Both were boxes under 20px: the host will not draw a glyph
// smaller than its floor, so the text overflowed the box and the box clipped
// it. Every row on the page has to clear that floor.
{
  const p = buildCue({ ...GUEST, logo: true });
  const rows = [
    ...p.textObject.map((c) => [c.containerName, c.height]),
    ...(p.listObject || []).map((c) => [c.containerName,
      c.height / c.itemContainer.itemCount]),
  ];
  // No longer a guess. `buildRuler()` put five heights on the glass and Kyle
  // read them: 20 and 24 clip, 26 and up are whole. If a firmware update moves
  // this, the ruler is still in the build — re-run it rather than re-deriving.
  const FLOOR = 26;   // measured on glass: 24 clips, 26 is whole
  const short = rows.filter(([, h]) => h < FLOOR);
  check(`no row is under the host's observed legible floor of ${FLOOR}px`,
    short.length === 0, short.map(([n, h]) => `${n}=${h}`).join(", ") || "all clear");

  const bottom = Math.max(...p.textObject.map((c) => c.yPosition + c.height));
  check("nothing is drawn past the bottom of the display",
    bottom <= 288, `lowest edge ${bottom}`);
}

// --- the ruler ---------------------------------------------------------------
// The diagnostic page that is supposed to end the guessing. If it were itself
// over budget it would render as nothing at all, and we would read that as
// "the ruler doesn't work" rather than "the page was dropped" — the exact
// confusion it exists to remove.
{
  const p = buildRuler();
  check("the ruler is inside the host budget",
    p.textObject.length <= 8 && p.textObject.length === RULER_HEIGHTS.length + 1,
    `${p.textObject.length} text for ${RULER_HEIGHTS.length} heights`);

  check("the ruler brackets the current row height",
    Math.min(...RULER_HEIGHTS) < 26 && Math.max(...RULER_HEIGHTS) > 26,
    RULER_HEIGHTS.join(", "));

  const bottom = Math.max(...p.textObject.map((c) => c.yPosition + c.height));
  check("the ruler fits on the display", bottom <= 288, `lowest edge ${bottom}`);

  // Rows must not overlap, or "is this row clipped" becomes unanswerable.
  const sorted = [...p.textObject].sort((a, b) => a.yPosition - b.yPosition);
  const overlaps = sorted.filter((c, i) =>
    i > 0 && c.yPosition < sorted[i - 1].yPosition + sorted[i - 1].height);
  check("no two ruler rows overlap", overlaps.length === 0,
    overlaps.map((c) => c.containerName).join(", ") || "all clear");

  check("the ruler has exactly one gesture receiver",
    p.textObject.filter((c) => c.isEventCapture === 1).length === 1);
}

// --- the floor menu ----------------------------------------------------------
// Floor comms shares the frame with everything else, and the budget has
// silently eaten two features already. Assert it before it eats a third.
{
  const PHRASES = ["NEED BACKUP", "ON MY WAY", "SIZE CHECK",
                   "COVERING YOUR GUEST", "FITTING ROOM OPEN",
                   "TILL QUEUE BUILDING", "BREAK?"];
  const p = buildMenu("FLOOR · 2 WAITING", PHRASES, 0, { logo: true });
  const total = p.textObject.length + (p.listObject?.length || 0)
              + (p.imageObject?.length || 0);
  check("the floor menu is inside the host budget",
    p.textObject.length <= 8 && total <= 12,
    `${p.textObject.length} text, ${total} total`);

  check("the menu is one list container, not a row of text containers",
    p.listObject?.length === 1);

  check("the menu has exactly one gesture receiver",
    p.textObject.filter((c) => c.isEventCapture === 1).length === 1);

  const bottom = Math.max(...p.textObject.map((c) => c.yPosition + c.height));
  const listBottom = p.listObject[0].yPosition + p.listObject[0].height;
  check("the menu fits on the display",
    bottom <= 288 && listBottom <= 288, `text ${bottom}, list ${listBottom}`);

  // The list sits between the title and the footer; overlapping either makes
  // the selected row unreadable exactly when someone is choosing with it.
  const foot = p.textObject.find((c) => c.containerName === "menu-foot");
  check("the list does not run into the footer",
    listBottom <= foot.yPosition, `list ends ${listBottom}, footer at ${foot.yPosition}`);
}

{
  // More items than rows: the selection must stay on the glass, or scrolling
  // past row six moves an invisible cursor.
  const many = Array.from({ length: 14 }, (_, i) => `ITEM ${i}`);
  for (const sel of [0, 7, 13]) {
    const p = buildMenu("FLOOR", many, sel, {});
    const rows = p.listObject[0].itemContainer.itemName;
    const cursored = rows.filter((r) => r.startsWith("· "));
    check(`selection ${sel} of ${many.length} is visible`,
      rows.length === MENU_ROWS && cursored.length === 1,
      `${rows.length} rows, ${cursored.length} cursored: ${JSON.stringify(cursored)}`);
  }
}

{
  // A cursor that shifts the text sideways makes the whole list twitch as you
  // scroll — every unselected row is padded to the cursor's width.
  const p = buildMenu("FLOOR", ["ALPHA", "BETA"], 0, {});
  const rows = p.listObject[0].itemContainer.itemName;
  check("unselected rows are padded to match the cursor",
    rows.every((r) => r.length >= 2) && rows[1].startsWith("  "),
    JSON.stringify(rows));
}

{
  const p = buildMenu("FLOOR", [], 0, {});
  check("an empty floor says so rather than rendering a blank list",
    p.listObject[0].itemContainer.itemName.length === 1,
    JSON.stringify(p.listObject[0].itemContainer.itemName));
}

// The rail carries the unread count as a sixth row — the thing that makes the
// priority tier free. If FACT_SLOTS ever drops below six this silently stops
// appearing, which is the failure mode worth a test.
{
  const railed = buildCue({
    lines: ["A", "B", "C"],
    facts: ["SARAH CHEN", "2 MSG", "ICON", "4200 PTS", "TOP M", "BTM 28X30"],
    meta: ["DENIM WALL"], moduleIndex: 0, moduleCount: 4, logo: true,
  });
  const rail = railed.listObject[0];
  check("a six-row rail still fits above the footer and inside budget",
    rail.itemContainer.itemName.length === 6
    && rail.yPosition + rail.height <= 288 - 34
    && railed.textObject.length <= 8,
    `rail ends ${rail.yPosition + rail.height}, ${railed.textObject.length} text`);
}

const failed = results.filter((r) => !r).length;

// --- the bug this key exists to prevent -----------------------------------
//
// Found while building the preferences card, in code that had already
// shipped. The key used to be container ids only, and the cheap path sends
// `textContainerUpgrade` per *text* container — there is no list equivalent
// in the SDK. So a rail whose rows changed while its id did not never
// reached the glass.
//
// Two guests both with full rails produced an identical key, which means the
// second customer was shown the first one's name, tier and sizes. That is the
// worst thing this product can do: the whole promise is that the sentence in
// the glass is about the person standing in front of you.

const GUEST_A = {
  lines: ["IN CART SLIM JEAN", "OFFER IT IN SIZE M", ""],
  facts: ["MAYA OKAFOR", "ICON", "TOP M", "BTM 28X30"],
  meta: ["DENIM WALL"], moduleCount: 0,
};
const GUEST_B = {
  ...GUEST_A,
  facts: ["DEVIN YATES", "CORE", "TOP L", "BTM 32X32"],
};

check("two different guests are not the same shape",
  shapeOf(GUEST_A) !== shapeOf(GUEST_B),
  `A=${shapeOf(GUEST_A)}  B=${shapeOf(GUEST_B)}`);

check("an unread count arriving changes the shape",
  shapeOf(GUEST_A) !== shapeOf({ ...GUEST_A, facts: [...GUEST_A.facts, "2 MSG"] }),
  "the unread count lives in the rail and only ever appeared on a rebuild");

check("the same guest twice is still the cheap path",
  shapeOf(GUEST_A) === shapeOf({ ...GUEST_A }),
  "an unchanged rail must not force a rebuild");

check("cue lines changing under an unchanged rail is the cheap path",
  shapeOf(GUEST_A) === shapeOf({ ...GUEST_A, lines: ["SHOW THE CREW", "AT KNITWEAR", ""] }),
  "this is the hot path — every card scroll and every voice answer");

console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
