/**
 * Keep the screen on while there is a guest in front of somebody.
 *
 * The failure this prevents is small and lethal: an associate is mid-sentence,
 * looks down for the size, and the phone has locked. On glass this problem
 * does not exist, which is exactly why it is easy to ship a phone app without
 * noticing it.
 *
 * Held only during an engagement, never at idle — a wake lock across an eight
 * hour shift is a flat battery at four, and a flat phone is a worse outcome
 * than a locked one.
 *
 * The re-acquire is the part people miss. Every browser drops a wake lock when
 * the page is hidden and does not restore it when the page comes back, so
 * without the `visibilitychange` listener the lock survives exactly one glance
 * at a notification.
 */

interface Sentinel { released: boolean; release(): Promise<void>; }

export class ScreenWake {
  private sentinel: Sentinel | null = null;
  private wanted = false;
  private bound = false;

  /** `false` when the platform has no Wake Lock — Safari before 16.4, and
   *  some vendor Chromium builds on handhelds. Reported, not worked around:
   *  the honest answer is a line telling the associate their screen may sleep. */
  readonly supported: boolean = !!(globalThis.navigator && "wakeLock" in globalThis.navigator);

  async acquire(): Promise<boolean> {
    this.wanted = true;
    this.bind();
    return this.request();
  }

  async release(): Promise<void> {
    this.wanted = false;
    const s = this.sentinel;
    this.sentinel = null;
    try { await s?.release(); } catch { /* already gone */ }
  }

  get held(): boolean {
    return !!this.sentinel && !this.sentinel.released;
  }

  private async request(): Promise<boolean> {
    if (!this.supported || !this.wanted || this.held) return this.held;
    try {
      const wl = (globalThis.navigator as unknown as {
        wakeLock: { request(type: "screen"): Promise<Sentinel> };
      }).wakeLock;
      this.sentinel = await wl.request("screen");
      return true;
    } catch {
      // Denied by policy, or the battery saver has taken over. Not an error
      // worth surfacing — the associate can still tap the screen.
      this.sentinel = null;
      return false;
    }
  }

  private bind(): void {
    if (this.bound || typeof document === "undefined") return;
    this.bound = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.wanted) void this.request();
    });
  }
}
