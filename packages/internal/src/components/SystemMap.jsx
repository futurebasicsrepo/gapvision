/**
 * SystemMap — the architecture, drawn.
 *
 * An inline SVG rather than an image: it inherits the brand tokens, it stays
 * legible at any zoom, it costs no request, and — the actual reason — a
 * diagram that lives in the repo gets updated when the repo does. Every
 * exported PNG of this system so far has gone stale within a fortnight.
 *
 * What it is trying to show, in priority order:
 *
 *   1. The trust boundary. The realtime server holds the service key; no
 *      browser and no pair of glasses ever does. That is the single most
 *      misunderstood thing about this architecture and it is drawn as a
 *      literal line.
 *   2. That guest data is referenced, never copied — the arrow into Postgres
 *      carries an id, and the arrow out to the retailer's CRM is where the
 *      customer actually lives.
 *   3. Everything else.
 */

const NODE = { w: 148, h: 62, r: 8 };

/** One box. `tone` picks the visual weight, not the colour of the week. */
function Node({ x, y, name, sub, tone = "core", w = NODE.w, h = NODE.h }) {
  const fill = {
    core: "var(--sea-800)",
    edge: "rgba(4,18,46,0.55)",
    ext: "transparent",
  }[tone];
  const stroke = {
    core: "rgba(143,199,240,0.30)",
    edge: "rgba(143,199,240,0.18)",
    // Dashed, outside our walls — a service we call but do not run.
    ext: "rgba(143,199,240,0.28)",
  }[tone];
  return (
    <g>
      <rect
        x={x} y={y} width={w} height={h} rx={NODE.r}
        fill={fill} stroke={stroke} strokeWidth="1"
        strokeDasharray={tone === "ext" ? "4 3" : undefined}
      />
      <text x={x + w / 2} y={y + (sub ? 26 : h / 2 + 4)} textAnchor="middle"
            fill="var(--paper)" fontSize="13" fontWeight="500"
            fontFamily="var(--sans)">{name}</text>
      {sub && (
        <text x={x + w / 2} y={y + 43} textAnchor="middle"
              fill="var(--sea-200)" fontSize="10.5"
              fontFamily="var(--mono)" letterSpacing="0.03em">{sub}</text>
      )}
    </g>
  );
}

/** An arrow. `label` sits above the line; `dashed` means "not the hot path". */
function Arrow({ from, to, label, dashed, bend = 0, color = "rgba(143,199,240,0.45)" }) {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const d = bend
    ? `M ${x1} ${y1} C ${x1 + (x2 - x1) / 2} ${y1 + bend}, ${x1 + (x2 - x1) / 2} ${y2 + bend}, ${x2} ${y2}`
    : `M ${x1} ${y1} L ${x2} ${y2}`;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2 + (bend ? bend * 0.75 : 0);
  return (
    <g>
      <path d={d} fill="none" stroke={color} strokeWidth="1.25"
            strokeDasharray={dashed ? "5 4" : undefined}
            markerEnd="url(#arrowhead)" />
      {label && (
        <text x={mx} y={my - 7} textAnchor="middle" fill="var(--sea-200)"
              fontSize="10" fontFamily="var(--mono)" letterSpacing="0.03em">
          {label}
        </text>
      )}
    </g>
  );
}

export default function SystemMap() {
  return (
    <div className="sysmap">
      <svg viewBox="0 0 1180 560" role="img"
           aria-label="CueSea system architecture: guest signal through the glasses and phone to the realtime server, the AI service, Postgres and the retailer's CRM."
           style={{ width: "100%", height: "auto", display: "block" }}>
        <defs>
          <marker id="arrowhead" markerWidth="7" markerHeight="7"
                  refX="6.4" refY="2.6" orient="auto">
            <path d="M0,0 L0,5.2 L6.4,2.6 z" fill="rgba(143,199,240,0.55)" />
          </marker>
        </defs>

        {/* ---- the trust boundary, drawn first so everything sits on top ---- */}
        <rect x="452" y="26" width="716" height="508" rx="12"
              fill="rgba(15,63,128,0.10)" stroke="rgba(143,199,240,0.20)"
              strokeWidth="1" strokeDasharray="6 5" />
        {/* Bottom edge, not the top: the top-right corner belongs to the
            "NOT OURS" column header and the two collided there. */}
        <text x="1152" y="522" textAnchor="end" fill="var(--sea-200)"
              fontSize="10.5" fontFamily="var(--mono)" letterSpacing="0.08em">
          SERVICE KEY LIVES INSIDE THIS LINE
        </text>

        {/* ---- on the floor ------------------------------------------------ */}
        <text x="16" y="44" fill="var(--sea-200)" fontSize="10.5"
              fontFamily="var(--mono)" letterSpacing="0.08em">ON THE FLOOR</text>

        <Node x={16} y={92} name="Guest signal" sub="opt-in only" tone="edge" />
        <Node x={16} y={214} name="Lens" sub="G2 · 576×288" />
        <Node x={16} y={336} name="Even App" sub="phone · WebView" tone="edge" />

        <Arrow from={[90, 154]} to={[90, 210]} />
        <Arrow from={[90, 276]} to={[90, 332]} label="BLE" />

        {/* ---- the browsers ------------------------------------------------- */}
        <text x={232} y={44} fill="var(--sea-200)" fontSize="10.5"
              fontFamily="var(--mono)" letterSpacing="0.08em">BROWSERS</text>
        <Node x={232} y={92} name="Studio" sub="retailer" tone="edge" />
        <Node x={232} y={214} name="Console" sub="cuesea staff" tone="edge" />

        {/* ---- our services -------------------------------------------------- */}
        <Node x={480} y={214} name="Realtime" sub="socket.io + proxy" w={168} />
        <Node x={716} y={214} name="Depth" sub="FastAPI" w={168} />
        <Node x={716} y={402} name="Postgres" sub="control plane" w={168} />

        {/* phone -> realtime, the hot path */}
        {/* Routed *under* the browser column rather than over it — bending
            the other way put this line straight through the Console box
            and dropped its label on top of the console's own. */}
        <Arrow from={[164, 367]} to={[476, 268]} label="socket" bend={62} />
        {/* browsers -> realtime proxy: they never hold the key */}
        <Arrow from={[380, 123]} to={[476, 232]} label="bearer" dashed />
        <Arrow from={[380, 245]} to={[476, 245]} label="bearer" dashed />

        <Arrow from={[652, 245]} to={[712, 245]} label="x-gapvision-key" />
        <Arrow from={[800, 280]} to={[800, 398]} label="guest id only" />

        {/* ---- outside ------------------------------------------------------- */}
        <text x={952} y={44} fill="var(--sea-200)" fontSize="10.5"
              fontFamily="var(--mono)" letterSpacing="0.08em">NOT OURS</text>
        <Node x={952} y={92} name="Retailer CRM" sub="Shopify Admin" tone="ext" />
        <Node x={952} y={214} name="Deepgram" sub="speech → text" tone="ext" />
        <Node x={952} y={336} name="Grok" sub="answers · scripts" tone="ext" />

        <Arrow from={[888, 232]} to={[948, 140]} label="sealed creds" />
        <Arrow from={[888, 245]} to={[948, 245]} />
        <Arrow from={[888, 258]} to={[948, 352]} />

        {/* The one thing the diagram exists to say, said in words too. */}
        <text x={952} y={452} fill="var(--sea-200)" fontSize="11"
              fontFamily="var(--sans)">
          <tspan x={952} dy="0">The customer record lives</tspan>
          <tspan x={952} dy="15">in the retailer&apos;s CRM.</tspan>
          <tspan x={952} dy="15" fill="var(--flame-300)">We store a pointer.</tspan>
        </text>

        {/* CueSea's own mark, small, bottom-left — the only flame on the page. */}
        <circle cx={30} cy={470} r="4" fill="var(--flame)" />
        <text x={44} y={474} fill="var(--sea-200)" fontSize="11"
              fontFamily="var(--mono)" letterSpacing="0.04em">
          three lines, one at a time
        </text>
      </svg>

      <div className="sysmap-key">
        <span><i className="k-solid" /> hot path — a cue, or a spoken question</span>
        <span><i className="k-dashed" /> signed-in browser, no service key</span>
        <span><i className="k-box" /> outside our walls</span>
      </div>
    </div>
  );
}
