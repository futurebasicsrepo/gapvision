/**
 * Getting the app onto the home screen — which is not decoration.
 *
 * Two things depend on being installed rather than being a tab:
 *
 *   1. **Web Push on iOS.** Safari delivers push only to a web app added to
 *      the home screen. Not "works better installed" — does not exist
 *      otherwise. Since a request arriving on the lock screen is the entire
 *      product claim on a phone, install *is* the feature.
 *   2. **Whether it reads as a tool.** A store handheld showing a URL bar
 *      reads as "a link somebody sent us" to every district manager who walks
 *      past, and that perception decides renewals more than it should.
 *
 * The two platforms need opposite handling, which is why this file exists
 * instead of a one-line prompt:
 *
 *   **Chromium** fires `beforeinstallprompt`, which must be captured and can
 *   be replayed exactly once, later, from a user gesture. Not capturing it
 *   means the browser shows its own mini-infobar and then never mentions it
 *   again.
 *
 *   **iOS** fires nothing and offers no API. The only route is Share → Add to
 *   Home Screen, performed by hand, which means the app has to *ask* — and ask
 *   in the words of the actual menu, because "install this PWA" is not a
 *   sentence anybody can act on.
 */
import { isStandalone } from "./platform.js";

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPrompt | null = null;

/**
 * Start listening. Call once, as early as possible — the event fires during
 * load and a listener attached afterwards misses it for the whole session.
 */
export function watchForInstall(onAvailable: () => void): void {
  globalThis.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();          // suppress the mini-infobar; we ask in context
    deferred = e as InstallPrompt;
    onAvailable();
  });
  globalThis.addEventListener("appinstalled", () => { deferred = null; });
}

export function canPrompt(): boolean {
  return deferred !== null;
}

/** Replay the captured prompt. One shot: the event cannot be reused. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  if (!deferred) return "unavailable";
  const e = deferred;
  deferred = null;
  try {
    await e.prompt();
    const { outcome } = await e.userChoice;
    return outcome;
  } catch {
    return "dismissed";
  }
}

/**
 * The one line to show, or `null` when there is nothing worth saying.
 *
 * Returns `null` when installed, because an installed app nagging about
 * installing is how a nudge becomes noise and gets dismissed permanently on
 * the day it would have mattered.
 */
export function installHint(opts: { isIOS: boolean }): string | null {
  if (isStandalone()) return null;
  if (opts.isIOS) {
    // The words from the actual menu. "Add to Home Screen" is findable;
    // "install" is not a thing iOS Safari says anywhere.
    return "Add cue to your home screen — tap Share, then Add to Home Screen. Requests can only buzz your phone once it is there.";
  }
  if (canPrompt()) return "Install cue so requests reach you when the app is closed.";
  return null;
}
