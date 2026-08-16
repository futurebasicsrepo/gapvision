import { useEffect, useState } from "react";
import { CueBracket } from "./Mark.jsx";

/**
 * The Cue Lens, drawn.
 *
 * This is the one place a retailer sees what their staff see, so it is the
 * real geometry rather than an impression of it: 640 × 350, every vertical
 * measure a multiple of the 26/350 row, one type size throughout, opaque
 * black, monochrome green. It is a *display* — never a card, never blurred,
 * never rounded like a control. It sits inside a card; it is not one.
 *
 * `claude/lens-hud.md` is the authority for everything below, and the
 * geometry here mirrors `packages/glasses-plugin/src/layout.ts` with one
 * substitution: the plugin's 576 × 288 is the G2's panel, the brand's drawn
 * lens is 640 × 350, and the grammar is identical either way.
 *
 * Doto is a *simulation* of the glass — the dot-matrix face that stands in
 * for the G2's monochrome grid. On real hardware the display renders its own
 * face, and Doto belongs in a lens and nowhere else.
 */

/* ---- geometry --------------------------------------------------------- */
/* Kept as pixels of the 640 × 350 reference frame. The CSS expresses the
   same numbers as container-query percentages, so the two cannot drift:
   change one, change the other, and `--rail` / `--gutter` / `--pad` in
   index.css carry the comment that says so. */
const DISPLAY_W = 640;
const ROW = 26;                 // the row unit — 26/350 of the height, 7.4286cqh
const PAD = 20;                 // 3.125% — the screen's own inset
const RAIL_W = 188;             // 29.375% — twelve characters
const GUTTER = 14;              // 2.1875%
const MODULE_X = PAD + RAIL_W + GUTTER;         // 222
const MODULE_W = DISPLAY_W - MODULE_X - PAD;    // 398
const LINE_W = DISPLAY_W - PAD * 2;             // 600

/** Three lines is the contract. A fourth is a bug, not an overflow. */
const CUE_LINES = 3;
/** Rows in the fact rail, between the header and the footer. */
const FACT_SLOTS = 6;

/**
 * Glyph advance as a fraction of the row.
 *
 * Every budget below is derived from this one ratio rather than chosen,
 * because chosen counts are how the plugin's budgets quietly stopped being
 * true the moment the row height moved. 0.60 is the widest advance measured
 * on the preview render — taken at the worst case, not the average, since one
 * optimistic character is a clipped word on a customer's face.
 *
 * The CSS holds the same number: `--adv: calc(var(--row) * .6)`, reached by
 * letter-spacing Doto out to it. So "twelve characters" is not an assertion
 * about this file — it is what the rail measurably holds on screen.
 */
const CHAR_ASPECT = 0.6;

/** How many characters fit a box of this width, at the one type size. */
function fitChars(width) {
  return Math.max(1, Math.floor(width / (ROW * CHAR_ASPECT)));
}

const LINE_CHARS = fitChars(LINE_W);            // 38 — full-width sentence
const RAIL_LINE_CHARS = fitChars(MODULE_W);     // 25 — sentence beside a rail
const FACT_CHARS = fitChars(RAIL_W);            // 12 — "MAYA OKAFOR" is 11
const STRIP_CHARS = fitChars(MODULE_X - PAD);   // 12 — "DENIM WALL" is 10
const STRIP_WIDE_CHARS = fitChars(LINE_W);      // 38 — idle, nothing sharing

/* ---- the charset ------------------------------------------------------ */
/**
 * Strip anything the glass could not draw.
 *
 * The charset is `[A-Z0-9 ·%$£€/+-]`. A character outside it is dropped by
 * the host silently, so a simulation that shows one is lying about the
 * hardware in the direction that costs the most: it promises a retailer
 * something their staff will never see.
 *
 * Accents are transliterated rather than dropped — "MÜLLER" becoming "MULLER"
 * is a shortened name, "M LLER" is a broken display, and the difference
 * matters on a name.
 */
function toGlass(text) {
  return String(text ?? "")
    // The server's own marker. The G2 has no glyph for any of the icons it
    // names, so the marker is removed and its line kept — which is exactly
    // what `toDisplayText` in the plugin does before the same text reaches
    // the glass.
    .replace(/\[ICON:\w+\]\s*/g, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036F]/g, "")
    .replace(/[\u2018\u2019\u201C\u201D]/g, "")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u2022\u2027]/g, "\u00B7")
    .toUpperCase()
    .replace(/[^A-Z0-9 ·%$£€/+-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cut to a budget with a "+", never mid-word silence. A clipped word reads
 *  as a fault in the hardware; the "+" reads as "there was more". */
function clamp(text, budget) {
  const s = toGlass(text);
  return s.length <= budget ? s : `${s.slice(0, budget - 1).trimEnd()}+`;
}

/**
 * Fit an interpunct strip by dropping facts, not characters.
 *
 * The strip is a list and degrades like one — the rightmost fact goes, then
 * the next. `keep` is pinned to the end and never dropped: it is the latency,
 * and the point of showing latency is that it is always there.
 */
function fitStrip(parts, budget, keep = "") {
  const items = parts.map(toGlass).filter(Boolean);
  while (items.length > 1) {
    const joined = [...items, keep].filter(Boolean).join(" · ");
    if (joined.length <= budget) return joined;
    items.pop();
  }
  // One fact left and it still does not fit — there is nothing further to
  // drop, so it is clamped rather than dropped. Dropping here empties the
  // row, and a zone that vanishes because it is called "DENIM WALL NORTH
  // ANNEXE" reads as a fault; "DENIM WALL +" reads as a long name.
  const last = [...items, keep].filter(Boolean).join(" · ");
  return last.length <= budget ? last : clamp(last, budget);
}

/**
 * The name, adapted to the rail rather than always shortened.
 *
 * Twelve characters fit: "MAYA OKAFOR" keeps her surname, "ALEXANDER
 * OKONKWO" becomes "ALEXANDER O". The middle case is the one to avoid —
 * "ALEXANDER OK" reads as a broken display, not as a shortened name.
 */
function railName(name) {
  const full = toGlass(name);
  if (!full) return "";
  if (full.length <= FACT_CHARS) return full;
  const parts = full.split(" ");
  if (parts.length < 2) return full.slice(0, FACT_CHARS);
  const short = `${parts[0]} ${parts[parts.length - 1][0]}`;
  return short.length <= FACT_CHARS ? short : parts[0].slice(0, FACT_CHARS);
}

/** HH·MM. The glass charset has no colon, so the interpunct stands in — it is
 *  the one separator the brand allows anyway. */
function clockLabel(now = new Date()) {
  return `${String(now.getHours()).padStart(2, "0")}·${String(now.getMinutes()).padStart(2, "0")}`;
}

/** A live clock, to the minute. Not motion — it is the thing an associate
 *  mid-shift looks up more often than anything else on the glass. */
function useClock(fixed) {
  const [now, setNow] = useState(() => clockLabel());
  useEffect(() => {
    if (fixed) return undefined;
    const id = setInterval(() => setNow(clockLabel()), 15000);
    return () => clearInterval(id);
  }, [fixed]);
  return fixed ? toGlass(fixed) : now;
}

export default function GlassesDisplay({
  /* The shape `AssociateView` has always passed, straight off the socket. */
  lines,
  /* Everything the richer `glasses:display` payload also carries. All
     optional, and absent means absent: with only `lines` the rail renders
     empty rather than inventing a guest, because a fabricated name in a
     simulator a retailer is watching is worse than a blank column. */
  name,
  facts,
  zone,
  meta,
  clock,
  cycle,
  idleText,
}) {
  const clockText = useClock(clock);

  const source =
    lines && lines.length > 0
      ? lines
      : [idleText || "CUESEA READY", "", "AWAITING GUEST SIGNAL"];
  const idle = !(lines && lines.length > 0);

  // Name first in the rail: it is the one fact needed continuously, and the
  // one the sentence stops showing the moment a voice answer replaces it.
  const rail = [railName(name), ...(facts || []).map((f) => clamp(f, FACT_CHARS))]
    .filter(Boolean)
    .slice(0, FACT_SLOTS);
  const railed = rail.length > 0;

  // Beside a rail the sentence has a third less room, so it is cut to that
  // budget rather than left to the box to clip.
  const body = Array.from({ length: CUE_LINES }, (_, i) =>
    clamp(source[i] || "", railed ? RAIL_LINE_CHARS : LINE_CHARS)
  );

  // Only when there is more than one. A position indicator for a single
  // module is chrome, and chrome is what this surface spends its budget on
  // not having.
  const cycling = Boolean(cycle && cycle.count > 1);
  const latency =
    cycle && typeof cycle.latencyMs === "number"
      ? `${(cycle.latencyMs / 1000).toFixed(1)}S`
      : "";
  const moduleText = cycling
    ? fitStrip(
        [`${cycle.label || "CUE"} ${(cycle.index || 0) + 1}/${cycle.count}`],
        RAIL_LINE_CHARS,
        latency
      )
    : "";

  // The footer's left cell runs to where the module column starts, not to the
  // rail's border — the gutter above it is dead space, and at this type size
  // that one extra column is the difference between "DENIM WALL" and nothing.
  // When nothing shares the row it takes the whole width, and idle is that
  // case: idle's strip is the one that is load-bearing.
  const stripParts =
    meta && meta.length ? meta : idle ? ["PRESS TO ASK", "2X EXIT"] : zone ? [zone] : [];
  const shares = railed || cycling;
  const strip = fitStrip(stripParts, shares ? STRIP_CHARS : STRIP_WIDE_CHARS);

  return (
    <div className="lens-block">
      <div className="lens">
        <div className="lens-screen">
          <div className="lens-row lens-head">
            {/* The one piece of brand on the glass, and monochrome here
                because the host quantises it to four greys anyway — the
                flame cue is a colour this display does not have. */}
            <CueBracket size={26} arc="currentColor" />
            <span className="lens-clock">{clockText}</span>
          </div>

          {/* Without a rail the sentence takes the whole frame, exactly as it
              does on the glass — an unrailed page indented to where the rail
              would have been is the rail's cost with none of its benefit. */}
          <div className="lens-body" data-railed={railed ? "yes" : "no"}>
            {/* A hairline down the rail's edge. Not chrome — structure: it
                says where the fixed column ends and the module begins, which
                is the whole point of the layout. */}
            {railed && (
              <div className="lens-rail">
                {rail.map((fact, i) => (
                  <div className="lens-row lens-fact" key={i}>
                    {fact}
                  </div>
                ))}
              </div>
            )}
            {/* Line rows always exist, empty ones included: on the glass a
                container that comes and goes changes the page shape and
                forces a full rebuild. Here it keeps the sentence from
                shifting up the frame as a cue loses a line. */}
            <div className="lens-lines">
              {body.map((line, i) => (
                <div className="lens-row lens-line" key={i}>
                  {line || " "}
                </div>
              ))}
            </div>
          </div>

          <div className="lens-foot" data-shares={shares ? "yes" : "no"}>
            <div className="lens-row lens-strip">{strip || " "}</div>
            {shares && <div className="lens-row lens-module">{moduleText || " "}</div>}
          </div>
        </div>
        {/* Boot sweep. Once, then never again — and under reduced motion it
            never runs at all; the lens is simply already there. */}
        <span className="lens-scan" aria-hidden="true" />
      </div>
      {/* A person wrote this line. Everything above it is the machine. */}
      <p className="lens-caption">
        The Cue Lens, as the glass draws it — 640 × 350, one type size, monochrome.
      </p>
    </div>
  );
}
