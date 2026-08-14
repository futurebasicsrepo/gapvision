/**
 * Chart primitives.
 *
 * Palette: categorical slots 1–3, dark steps, validated against this app's
 * card surface (#0b1b2e) — lightness band, chroma floor, CVD separation
 * (worst adjacent ΔE 9.4 deutan), normal-vision floor (26.5) and 3:1 contrast
 * all pass. Colours are assigned to a fixed meaning and never cycled, so a
 * filter that drops a series can't repaint the others.
 *
 * Text never wears the series colour — identity comes from the swatch beside
 * it. Values sit in text tokens so they stay legible on the card.
 */
export const SERIES = {
  sales: { color: "#3987e5", label: "Sales" },
  engagements: { color: "#d95926", label: "Guests helped" },
  assists: { color: "#199e70", label: "Assists" },
};

const SURFACE = "#0b1b2e";

export function StatTile({ label, value, sub, span = 3 }) {
  return (
    <div className={`card stat span-${span}`}>
      <div className="stat-label">{label}</div>
      {/* Proportional figures: tabular-nums makes a large standalone number
          look loose. Tabular is for columns that must align. */}
      <div className="stat-value">{value}</div>
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
