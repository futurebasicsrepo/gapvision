import Decode from "./Decode.jsx";

/**
 * Chart primitives.
 *
 * Palette follows the brand's chart rule: the depth ramp carries the ordered
 * series, and flame marks the one that matters. Never a rainbow.
 *
 * Here the series that matters is assists — the whole reason this leaderboard
 * is weighted the way it is — so it takes the flame, and sales and guests
 * ride two steps of the sea ramp.
 *
 * Validated as an ordinal construction rather than a flat categorical set:
 *   · the two sea steps as a ramp — monotone lightness, ΔL ≥ 0.06, single hue
 *     (11° spread). All pass.
 *   · flame against each sea step — CVD ΔE 22.8 / 24.2, normal-vision 29.2 /
 *     34.9, contrast ≥ 3:1. All pass.
 *
 * Re-measured against the slate row the bars now sit on (slate-800 #1A2029,
 * inset one plane below the card): sea-400 3.95:1, sea-200 9.04:1, flame
 * 5.76:1 — all clear the 3:1 floor for a graphic. Against the card itself
 * (slate-700, the worst ground in the app) the same three are 3.57 / 8.17 /
 * 5.21:1.
 *
 * sea-200 is low-chroma and reads grey under severe CVD, so identity leans on
 * the legend and the written detail line beneath each bar, never on hue alone.
 *
 * hud green is deliberately absent: it belongs inside the glass, and the
 * brand forbids it as a chart series. Flame appears exactly twice on the floor
 * view — the assists series here, and a genuinely missed question. Not more.
 */
export const SERIES = {
  sales: { color: "#2E7FD0", label: "Sales" },          /* sea-400 */
  engagements: { color: "#8FC7F0", label: "Guests helped" }, /* sea-200 */
  assists: { color: "#FF6B2C", label: "Assists" },      /* flame — the cue */
};

const SURFACE = "#1A2029";   /* slate-800 — the row the bar sits on */

export function StatTile({ label, value, sub, span = 3 }) {
  return (
    <div className={`card stat span-${span}`}>
      <div className="stat-label">{label}</div>
      {/* Decodes on first paint and never again. The socket re-loads this
          panel whenever the floor does anything, and a number that
          re-scrambles on every refresh is unreadable on a monitor somebody
          leaves open all shift. Mono, so the glyphs hold their width while
          they resolve. */}
      <div className="stat-value"><Decode text={String(value ?? "")} /></div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Legend({ keys }) {
  return (
    <div className="legend">
      {keys.map((k) => (
        <span className="legend-item" key={k}>
          <i style={{ background: SERIES[k].color }} />
          {SERIES[k].label}
        </span>
      ))}
    </div>
  );
}

/**
 * One associate's score, decomposed.
 *
 * A single number nobody can explain is what makes a leaderboard feel rigged,
 * so the bar shows which parts of the work produced it. Segments are separated
 * by a 2px gap in the surface colour rather than a stroke; the total is the
 * only direct label.
 */
export function ScoreBar({ parts, max, total }) {
  const keys = ["sales", "engagements", "assists"];
  const width = (v) => (max > 0 ? Math.max(0, (v / max) * 100) : 0);
  const drawn = keys.filter((k) => parts[k] > 0);

  return (
    <div className="scorebar-row">
      <div className="scorebar" role="img"
           aria-label={keys.map((k) => `${SERIES[k].label} ${Math.round(parts[k])}`).join(", ")}>
        {drawn.map((k, i) => (
          <span
            key={k}
            className="scoreseg"
            style={{
              width: `${width(parts[k])}%`,
              background: SERIES[k].color,
              // Square where it meets the baseline, rounded at the data end.
              borderRadius: i === drawn.length - 1 ? "0 4px 4px 0" : 0,
              marginRight: i === drawn.length - 1 ? 0 : 2,
              boxShadow: `0 0 0 0 ${SURFACE}`,
            }}
          />
        ))}
      </div>
      <span className="scorebar-total">{Math.round(total).toLocaleString()}</span>
    </div>
  );
}

/** Empty states say why there's nothing, not just that there's nothing. */
export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}
