/**
 * The Cue Bracket — an open C holding a single cue at its centre.
 *
 * Drawn from the construction spec rather than traced from an export, so it
 * stays exact at any size:
 *
 *   grid 32 × 32 · arc centre (16,16) · radius 11 · stroke 4.0 · round caps
 *   gap 70° total, centred on the 3 o'clock axis
 *   cue: solid circle, radius 2.9, at exact optical centre
 *   clear space: one cue diameter (5.8 units) on all four sides
 *
 * Optical compensation: as size falls, stroke and cue grow together so the
 * opening never closes — 4.0/2.9 at 42px+, 4.4/3.1 at 24px, 4.9/3.5 at 16px.
 *
 * The cue is always flame. The arc changes with the ground — ink on light,
 * paper on dark — the cue never does. It is the one constant in the system,
 * and a low-chroma dot inside an open C would read as a copyright glyph.
 */
const R = 11;
const C = 16;

function compensation(size) {
  if (size >= 42) return { stroke: 4.0, cue: 2.9 };
  if (size >= 24) return { stroke: 4.4, cue: 3.1 };
  return { stroke: 4.9, cue: 3.5 };
}

/** Arc path for a 70° gap centred on the 3 o'clock axis (0°), i.e. the stroke
 *  runs from +35° round to −35°. */
function arcPath() {
  const start = 35 * (Math.PI / 180);
  const end = -35 * (Math.PI / 180);
  // SVG y grows downward, so the sign on sin is flipped.
  const x1 = C + R * Math.cos(start);
  const y1 = C - R * Math.sin(start);
  const x2 = C + R * Math.cos(end);
  const y2 = C - R * Math.sin(end);
  // large-arc-flag 1 (290° of sweep), sweep-flag 0 (counter-clockwise in
  // screen coordinates) so the opening lands on the right.
  return `M ${x1} ${y1} A ${R} ${R} 0 1 0 ${x2} ${y2}`;
}

export function CueBracket({ size = 24, arc = "currentColor", title }) {
  const { stroke, cue } = compensation(size);
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32"
      role={title ? "img" : "presentation"} aria-label={title} focusable="false"
    >
      {title && <title>{title}</title>}
      <path d={arcPath()} fill="none" stroke={arc} strokeWidth={stroke} strokeLinecap="round" />
      <circle cx={C} cy={C} r={cue} fill="var(--flame)" />
    </svg>
  );
}

/**
 * The lockup. Always lowercase, always one word, two-tone — the two-tone
 * split is what keeps "cuesea" from slurring into "queasy" when it's read
 * fast. Never set in the serif; never with ".ai" attached.
 */
export function Wordmark({ size = 22, onDark = true }) {
  return (
    <span className="wordmark" style={{ gap: size * 0.42 }}>
      <CueBracket size={size * 1.15} arc={onDark ? "var(--paper)" : "var(--ink-900)"}
                  title="cuesea" />
      <span className="wordmark-text" style={{ fontSize: size }}>
        <span style={{ color: onDark ? "var(--paper)" : "var(--ink-900)" }}>cue</span>
        <span style={{ color: onDark ? "var(--sea-300)" : "var(--sea-500)" }}>sea</span>
      </span>
    </span>
  );
}
