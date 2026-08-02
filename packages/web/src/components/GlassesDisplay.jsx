/**
 * Pixel-faithful simulation of the Even Realities G2 display:
 * 576x288 (2:1), monochrome green, text + simple icon markers only.
 * This component is the piece that later becomes the Even Hub plugin view.
 */
const ICONS = {
  USER: "●", // ●
  STAR: "★", // ★
  TAG: "■",  // ■
  CART: "▸", // ▸
  ARROW: "→",// →
  CHAT: "❝", // ❝
  WARN: "⚠", // ⚠
  RADIO: "◉",// ◉
};

function renderLine(line, i) {
  const match = line.match(/^\[ICON:(\w+)\]\s?(.*)$/);
  if (match) {
    const glyph = ICONS[match[1]] || "▪";
    return (
      <div className="glasses-line" key={i}>
        <span className="icon">{glyph} </span>
        {match[2]}
      </div>
    );
  }
  return (
    <div className="glasses-line" key={i}>
      {line}
    </div>
  );
}

export default function GlassesDisplay({ lines, idleText }) {
  const content =
    lines && lines.length > 0
      ? lines
      : [idleText || "GAPVISION READY", "", "Awaiting guest signal..."];

  return (
    <div>
      <div className="glasses-frame">
        {content.map(renderLine)}
        <div className="glasses-hud">576×288 · MONO-G · BLE OK</div>
        <div className="scanline" />
      </div>
      <div className="glasses-caption">
        Simulated G2 display — monochrome green, text &amp; icon markers only
      </div>
    </div>
  );
}
