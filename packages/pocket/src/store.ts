/**
 * What may be written down, and what may only be remembered.
 *
 * A phone on a shop floor holds two very different kinds of thing:
 *
 *   **Its own identity and its unsent work** — the mode, a session, the
 *   outbound queue, a display preference. These have to survive the app being
 *   swiped away, a battery dying and a shift ending, or the product does not
 *   work.
 *
 *   **Somebody else's customer** — a name, a cart, a purchase history, sizes.
 *   These must survive exactly as long as the engagement and not one second
 *   longer.
 *
 * So durable storage takes a **whitelist**, not a blacklist. Every key that
 * may be written is named here; anything else is refused. The failure this
 * prevents is the ordinary one — a later change caches "just the guest card,
 * to make reconnects faster" and a year of customers is sitting in localStorage
 * on a handset that gets sold on eBay.
 *
 * The rule is universal rather than per-mode. A store-owned handheld has no
 * more business keeping last night's guest than a personal phone does; the
 * mode question is about *credentials* (see `identity.ts`), not about records.
 */

const PREFIX = "cue.pocket.";

/**
 * Everything that may be written to disk, and why it earns it.
 *
 * Adding a key here is a deliberate act. If a new key is about a guest, the
 * answer is no — put it in `ephemeral` and let it die with the engagement.
 */
export const DURABLE_KEYS = {
  /** managed | personal. Sticky; see identity.ts. */
  mode: "the decision that keeps a store credential off a personal phone",
  /** Provision token. Managed handsets only — enforced at the call site. */
  store_token: "this handheld's identity as the store",
  /** The signed-in person's session token. */
  session: "who is holding the phone, so a sale can be attributed",
  /** Their display name, so the app can greet before the network answers. */
  who: "the name shown before the first round trip completes",
  /** Tenant slug, for the socket handshake. */
  tenant: "which shop to register with",
  /** classic | meta — a rendering preference, not a record. */
  lens_mode: "how this associate likes the cards drawn",
  /** Outbound actions taken while offline. Ids and verbs, never PII. */
  queue: "work done on a dead network that must not be lost",
  /** Whether the add-to-home-screen coaching has been dismissed. */
  installed_hint: "so the install nudge is shown once, not every shift",
} as const;

export type DurableKey = keyof typeof DURABLE_KEYS;

/** Refused writes, kept so a test (and a developer) can see them. */
const refusals: string[] = [];

export function refusedWrites(): string[] {
  return [...refusals];
}

/**
 * `true` if this key is one we have decided may be written down.
 *
 * Exported and pure so the policy is testable without a browser — the point of
 * a whitelist is undermined by a whitelist nobody checks.
 */
export function isDurable(key: string): key is DurableKey {
  return Object.prototype.hasOwnProperty.call(DURABLE_KEYS, key);
}

type Backing = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function backing(): Backing | null {
  try {
    // Private-mode Safari has historically thrown on write rather than on
    // access, so this is a probe, not a presence check.
    const s = globalThis.localStorage;
    const probe = `${PREFIX}__probe`;
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

/**
 * Durable storage, whitelisted.
 *
 * When there is no usable localStorage — private browsing, a locked-down
 * kiosk profile — every method degrades to a no-op and the app runs as a
 * personal phone that forgets everything on close. Degraded, but not broken,
 * and never silently *more* permissive.
 */
export const durable = {
  get(key: DurableKey): string | null {
    const s = backing();
    return s ? s.getItem(PREFIX + key) : null;
  },
  set(key: string, value: string): boolean {
    if (!isDurable(key)) {
      // Loud in development, silent-but-recorded in production. A thrown
      // exception here would take down a lens mid-engagement over a caching
      // mistake, which is a worse outcome than the mistake.
      refusals.push(key);
      console.warn(
        `[pocket] refused to persist "${key}" — not on the durable whitelist. ` +
        `If this is about a guest, it belongs in memory (see store.ts).`,
      );
      return false;
    }
    const s = backing();
    if (!s) return false;
    try {
      s.setItem(PREFIX + key, value);
      return true;
    } catch {
      return false; // quota, or a profile that lied about being writable
    }
  },
  remove(key: DurableKey): void {
    backing()?.removeItem(PREFIX + key);
  },
  /**
   * Every `cue.pocket.` key, gone.
   *
   * Iterated over a snapshot of the key list because removing during
   * enumeration reindexes `Storage`, which is how a "wipe" quietly leaves
   * every other key behind.
   */
  clearAll(): void {
    const s = backing();
    if (!s) return;
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(PREFIX)) keys.push(k);
    }
    for (const k of keys) s.removeItem(k);
  },
};

/**
 * Memory only. Where every guest lives.
 *
 * No serialisation, no persistence, no export. Closing the app is the same
 * event as forgetting, which is the behaviour the privacy claim in the deck
 * describes and this is the code that makes it true on a phone.
 */
class Ephemeral {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.map.get(key) as T | undefined; }
  set<T>(key: string, value: T): void { this.map.set(key, value); }
  drop(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
  get size(): number { return this.map.size; }
}

export const ephemeral = new Ephemeral();

/**
 * Destroy everything this app has on this device.
 *
 * Storage, memory, and — because a service worker cache holding a rendered
 * guest card would make the rest of this theatre — the Cache Storage entries
 * too. Best-effort by necessity: `caches` does not exist on every platform,
 * and a wipe that threw halfway would leave more behind than one that did not.
 */
export async function wipeEverything(opts: { caches?: boolean } = {}): Promise<void> {
  durable.clearAll();
  ephemeral.clear();
  if (opts.caches !== false && typeof caches !== "undefined") {
    try {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    } catch {
      /* a wipe that cannot clear a cache still clears everything else */
    }
  }
}
