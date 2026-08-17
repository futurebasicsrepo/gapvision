/**
 * What this particular phone can actually do.
 *
 * "Cross-platform" in retail does not mean two browsers. It means an
 * associate's iPhone, an associate's mid-range Android, a store-owned iPad at
 * the till, and a Zebra or Honeywell handheld running an old Chromium build
 * that the IT department will not update this year. All four are in scope and
 * only one of them is pleasant.
 *
 * The design rule that follows: **nothing in the critical path may depend on a
 * capability that is not universal.** Cards, gestures, claiming a request and
 * sending a floor message use Pointer Events, `fetch` and a WebSocket, and
 * nothing else. Everything below is an *upgrade*, detected rather than assumed,
 * and its absence is stated in words rather than discovered as a dead button.
 *
 * The second rule: **detect features, never user agents.** The exception is
 * `isIOS`, and it is a real exception rather than laziness — iOS has no
 * `beforeinstallprompt` event to detect, so "can this device install?" cannot
 * be answered by feature detection. Coaching somebody through Share → Add to
 * Home Screen requires knowing they are on iOS. That is a UI string, not a
 * behaviour switch, which is the only kind of sniffing worth doing.
 */

export interface Capabilities {
  /** Running from the home screen rather than in a browser tab. */
  standalone: boolean;
  /** Screen Wake Lock — Chrome, and Safari from 16.4. */
  wakeLock: boolean;
  /** Web Push. On iOS this is *installed-only*, which `pushReady` accounts for. */
  push: boolean;
  /** Push that will actually work here and now, install state included. */
  pushReady: boolean;
  /** `BarcodeDetector` — Chromium only. Safari has no equivalent. */
  barcode: boolean;
  /** Service worker: no offline queue replay on reconnect without it. */
  serviceWorker: boolean;
  /** Vibration, for a request arriving while the phone is in a pocket. */
  vibrate: boolean;
  /** iOS/iPadOS. Used for install coaching only — see the note above. */
  isIOS: boolean;
  /** Chromium's install prompt is available to be captured. */
  installPrompt: boolean;
}

export function detect(): Capabilities {
  const nav = globalThis.navigator as Navigator | undefined;
  const standalone = isStandalone();
  const push = typeof PushManager !== "undefined" && "serviceWorker" in (nav || {});
  const isIOS = detectIOS();

  return {
    standalone,
    wakeLock: !!nav && "wakeLock" in nav,
    push,
    // iOS delivers Web Push only to a PWA on the home screen. Reporting `push`
    // as available in a Safari tab would produce a permission prompt that can
    // never result in a notification — the worst of both.
    pushReady: push && (!isIOS || standalone),
    barcode: "BarcodeDetector" in globalThis,
    serviceWorker: !!nav && "serviceWorker" in nav,
    vibrate: !!nav && "vibrate" in nav,
    isIOS,
    installPrompt: "onbeforeinstallprompt" in globalThis,
  };
}

/**
 * Installed, by either of the two ways a browser says so.
 *
 * `display-mode: standalone` is the standard; `navigator.standalone` is
 * Safari's own, older, and still the only reliable answer on iPadOS.
 */
export function isStandalone(): boolean {
  try {
    if (globalThis.matchMedia?.("(display-mode: standalone)").matches) return true;
    if (globalThis.matchMedia?.("(display-mode: fullscreen)").matches) return true;
  } catch { /* no matchMedia: assume a tab */ }
  return (globalThis.navigator as { standalone?: boolean } | undefined)?.standalone === true;
}

function detectIOS(): boolean {
  const nav = globalThis.navigator;
  if (!nav) return false;
  // iPadOS 13+ reports itself as a Mac. The touch-point count is what still
  // tells them apart, and it is the standard workaround rather than a trick.
  const mac = /Mac/.test(nav.platform || "") && (nav.maxTouchPoints || 0) > 1;
  return /iPad|iPhone|iPod/.test(nav.platform || nav.userAgent || "") || mac;
}

/**
 * What is missing, in words an associate could read.
 *
 * Deliberately not a list of API names. "Requests will not buzz this phone
 * until you add it to your home screen" is actionable; "PushManager
 * unavailable" is a support ticket.
 */
export function gaps(c: Capabilities): string[] {
  const out: string[] = [];
  if (!c.standalone) {
    out.push(c.isIOS
      ? "Add this to your home screen (Share → Add to Home Screen) so requests can buzz your phone."
      : "Install this app so requests can reach you when it is closed.");
  }
  if (!c.serviceWorker) {
    out.push("This browser cannot hold work while you are offline — stay on wifi.");
  }
  if (!c.wakeLock) {
    out.push("Your screen may sleep during a conversation. Tap to wake it.");
  }
  if (!c.barcode) {
    out.push("Scanning a tag is not supported on this browser — type the code instead.");
  }
  return out;
}
