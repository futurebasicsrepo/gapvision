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
import { assertBudget, buildCue } from "../dist-test/layout.mjs";

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
    ...(p.listObject || []).map((c) => `l${c.containerID}`),
  ].join(",");
};

const IDLE = { lines: ["CUESEA READY", "GAP · DEMO", "AWAITING GUEST SIGNAL"],
               meta: ["PRESS TO ASK", "DOUBLE PRESS EXITS"] };
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

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
