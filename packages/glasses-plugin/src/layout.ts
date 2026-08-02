/**
 * Maps GapVision `glasses_lines` (the AI service's pre-formatted display
 * payload) onto Even Hub page containers.
 *
 * Display: 576 x 288, monochrome green. SDK rules honored here:
 *  - containerTotalNum 1..12, max 8 text containers
 *  - exactly one container carries isEventCapture: 1
 *  - zOrderIndex: all-or-none per page, unique when present
 */
import type { PageSpec, TextContainer } from "./bridge";

export const MAX_LINES = 7; // + 1 status row = 8 text containers (SDK max)

const LINE_X = 16;
const LINE_W = 544;
const LINE_H = 32;
const LINE_Y0 = 12;
const LINE_STEP = 34;

/** Strip [ICON:*] markers to plain glyphs the monochrome renderer can show. */
export function toDisplayText(line: string): string {
  const ICONS: Record<string, string> = {
    USER: "●", STAR: "★", TAG: "■", CART: "▸",
    ARROW: "→", CHAT: "❝", WARN: "⚠", RADIO: "◉",
  };
  return line.replace(/\[ICON:(\w+)\]\s?/, (_, k) => `${ICONS[k] ?? "▪"} `);
}

export function buildPage(lines: string[], statusText: string): PageSpec {
  const shown = lines.slice(0, MAX_LINES).map(toDisplayText);

  const textObject: TextContainer[] = shown.map((content, i) => ({
    xPosition: LINE_X,
    yPosition: LINE_Y0 + i * LINE_STEP,
    width: LINE_W,
    height: LINE_H,
    containerID: i + 1,
    containerName: `line-${i + 1}`,
    zOrderIndex: i + 1,
    content,
    // First container is the page's single gesture receiver.
    isEventCapture: i === 0 ? 1 : 0,
  }));

  // Status row (bottom-right): session state / radio hints.
  textObject.push({
    xPosition: 296,
    yPosition: 262,
    width: 264,
    height: 24,
    containerID: 9,
    containerName: "status",
    zOrderIndex: 9,
    content: statusText,
    isEventCapture: 0,
  });

  return { containerTotalNum: textObject.length, textObject };
}

export const IDLE_LINES = ["GAPVISION READY", "", "Awaiting guest signal..."];
