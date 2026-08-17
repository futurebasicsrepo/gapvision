/**
 * Input on Meta Ray-Ban Display arrives as keyboard events: the Neural Band
 * and the captouch temple strip both surface as D-pad arrows, Enter (select)
 * and Escape (back). That means the browser preview IS the gesture simulator —
 * the same arrow keys on a laptop drive the same handlers on glass.
 */
export type LensGesture = "prev" | "next" | "up" | "down" | "select" | "back";

const MAP: Record<string, LensGesture> = {
  ArrowLeft: "prev",
  ArrowRight: "next",
  ArrowUp: "up",
  ArrowDown: "down",
  Enter: "select",
  Escape: "back",
};

export function onGesture(handler: (g: LensGesture) => void): () => void {
  const listener = (e: KeyboardEvent) => {
    const g = MAP[e.key];
    if (!g) return;
    e.preventDefault();
    handler(g);
  };
  document.addEventListener("keydown", listener);
  return () => document.removeEventListener("keydown", listener);
}
