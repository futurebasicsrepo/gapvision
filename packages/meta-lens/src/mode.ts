/**
 * The classic ↔ meta toggle. Classic is the G2 lens 1:1 — the cross-platform
 * constant an associate can trust on any glass. Meta is this hardware's
 * showcase. The choice persists per device (localStorage), can be forced by
 * launch URL (`?mode=meta`), and flips from the idle screen with up/down —
 * never mid-engagement, so a guest interaction always keeps one visual state.
 */
import type { LensMode } from "./types.js";

const KEY = "cue.mode";
const DEFAULT_MODE: LensMode = "meta";

export function initialMode(params: URLSearchParams): LensMode {
  const fromUrl = params.get("mode");
  if (fromUrl === "classic" || fromUrl === "meta") {
    localStorage.setItem(KEY, fromUrl);
    return fromUrl;
  }
  const stored = localStorage.getItem(KEY);
  return stored === "classic" || stored === "meta" ? stored : DEFAULT_MODE;
}

export function toggleMode(m: LensMode): LensMode {
  const next: LensMode = m === "classic" ? "meta" : "classic";
  localStorage.setItem(KEY, next);
  return next;
}
