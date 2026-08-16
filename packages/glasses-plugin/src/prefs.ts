/**
 * What this associate wants, as distinct from what their store permits.
 *
 * The phone page started as a developer console and is now the only settings
 * surface this plugin has: Even provides no declarative panel for a plugin, and
 * the SDK's whole offer is `setLocalStorage` / `getLocalStorage`. So the four
 * preferences below live in the host's key-value store, one key each, and the
 * page is where they are set.
 *
 * ## Capability is not preference
 *
 * `Capabilities` comes from the server and says what the **store permits**. A
 * preference says what **this associate wants inside that**. They are two
 * different questions and conflating them is how a setting ends up either
 * lying to an associate or quietly overriding a store's decision. So:
 *
 *   - A preference whose capability is false is **not shown at all**. Not
 *     disabled, not explained — absent, the same rule the camera control
 *     follows. A control an associate cannot have is a support call.
 *   - A preference can never turn *on* something the capability turned off.
 *   - A hidden preference falls back to its **default**, which is the behaviour
 *     shipping today, rather than to whatever happens to be in storage. That
 *     matters because `voice` and `floor_comms` are deliberately *not* enforced
 *     (see the `capabilities` declaration in `main.ts`): every tenant reads
 *     false today, either because they never set the flag or because the fetch
 *     failed, and resolving a hidden preference to "off" would switch voice off
 *     for all of them to honour a flag none of them have set. It would also
 *     strand an associate with a stored "off" and no control to undo it.
 *
 * The one capability that *is* enforced — `camera_capture` — has no preference
 * here on purpose. It is the store's answer, and there is nothing left for an
 * associate to want inside "no".
 *
 * ## One key per preference
 *
 * Not one JSON blob. `setLocalStorage` reports success per call, and a failed
 * write of the zone should not be able to take the voice setting with it. It
 * also means an unreadable value costs exactly one preference, which falls back
 * to its default, rather than all four.
 */
import type { GlassesBridge } from "./bridge";
import type { Capabilities } from "./vision";

/**
 * How much floor traffic is allowed to interrupt.
 *
 *   everything  — today's behaviour. Urgent takes the frame; everything else
 *                 queues, and the floor menu opens on arrival when idle.
 *   urgent      — urgent still takes the frame; nothing else ever opens
 *                 anything. The rest queue behind the unread count.
 *   off         — nothing takes the frame, urgent included. It still queues:
 *                 an associate who asked not to be interrupted did not ask to
 *                 lose a backup request, and the whole point of the tier is
 *                 that the message survives to be read.
 */
export type FloorComms = "everything" | "urgent" | "off";

export interface Prefs {
  /** The section of the floor this associate is working. */
  zone: string;
  floorComms: FloorComms;
  /** Whether a press opens the microphone at all. */
  voice: boolean;
  /** Whether the loyalty points row is spent on the fact rail. */
  railPoints: boolean;
}

export type PrefKey = keyof Prefs;

export const PREF_KEYS: PrefKey[] = ["zone", "floorComms", "voice", "railPoints"];

/** Namespaced so `cue.session` (the sessionStorage resume key) and anything the
 *  host itself keeps can never collide with a preference. */
export const STORAGE_PREFIX = "cue.pref.";

export function storageKey(key: PrefKey): string {
  return `${STORAGE_PREFIX}${key}`;
}

/**
 * The zone an associate gets before they have said otherwise.
 *
 * It is the tenant's demo zone, which is the right *default* and was never a
 * defensible constant: an associate does not work the section their tenant's
 * sample data happens to be written around.
 */
export function defaultZone(tenant: string): string {
  return tenant === "shopify" ? "Front Table" : "Denim Wall";
}

export function defaultPrefs(tenant: string): Prefs {
  return {
    zone: defaultZone(tenant),
    // Everything, because that is what shipped and because the associate who
    // has not opened this page has not asked for less.
    floorComms: "everything",
    voice: true,
    railPoints: true,
  };
}

/**
 * The zone travels to the server, onto the manager dashboard and into the
 * glass footer, which holds about ten characters at the measured row height.
 * Long names are the caller's to shorten; this caps the storage rather than the
 * display, so nothing unbounded is ever written or emitted.
 */
export const MAX_ZONE_CHARS = 24;

/** Trim, collapse runs of space, cap — and fall back to the default rather than
 *  storing an empty zone, because "" would reach the server as `Floor`. */
export function normaliseZone(raw: unknown, tenant: string): string {
  const zone = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_ZONE_CHARS);
  return zone || defaultZone(tenant);
}

/** Which server capability, if any, a preference sits behind. */
export const PREF_CAPABILITY: Partial<Record<PrefKey, keyof Capabilities>> = {
  floorComms: "floor_comms",
  voice: "voice",
};

/**
 * Whether this preference may be put on the page.
 *
 * Unknown is not a yes: with no capabilities object — the fetch has not
 * answered, or failed — a gated preference is not shown. The page is built once
 * the answer is in, exactly like the capture card, so this is the boot window
 * rather than a steady state.
 */
export function isPrefVisible(key: PrefKey, caps: Capabilities | null | undefined): boolean {
  const cap = PREF_CAPABILITY[key];
  if (!cap) return true;
  return caps?.[cap] === true;
}

export function visiblePrefs(caps: Capabilities | null | undefined): PrefKey[] {
  return PREF_KEYS.filter((k) => isPrefVisible(k, caps));
}

/**
 * What actually takes effect: stored values for anything the store permits,
 * defaults for anything it doesn't.
 *
 * `caps === null` means the answer has not arrived yet. Stored values apply
 * during that window — a preference that only takes hold two seconds after the
 * page opens is a preference that did not survive the reload, which is the one
 * thing it has to do.
 */
export function effectivePrefs(
  stored: Prefs, caps: Capabilities | null | undefined, tenant: string,
): Prefs {
  const fallback = defaultPrefs(tenant);
  const out = { ...stored };
  for (const key of PREF_KEYS) {
    const cap = PREF_CAPABILITY[key];
    if (!cap || caps == null) continue;
    if (caps[cap] !== true) (out as any)[key] = fallback[key];
  }
  return out;
}

/** Booleans are written as words. `on`/`off` reads correctly in a host store
 *  someone may one day inspect, and "true"/"1"/"" do not all agree on what
 *  empty means. */
export function encodePref<K extends PrefKey>(key: K, value: Prefs[K]): string {
  if (key === "zone") return String(value);
  if (key === "floorComms") return String(value);
  return value ? "on" : "off";
}

/**
 * Read one stored string back.
 *
 * Anything unrecognised resolves to the default rather than to off: a value the
 * host garbled, or one written by a build that spelled it differently, is not a
 * decision anybody made.
 */
export function decodePref<K extends PrefKey>(
  key: K, raw: string | null | undefined, tenant: string,
): Prefs[K] {
  const fallback = defaultPrefs(tenant);
  if (raw == null || raw === "") return fallback[key];
  if (key === "zone") return normaliseZone(raw, tenant) as Prefs[K];
  if (key === "floorComms") {
    return (raw === "everything" || raw === "urgent" || raw === "off"
      ? raw
      : fallback.floorComms) as Prefs[K];
  }
  if (raw === "on") return true as Prefs[K];
  if (raw === "off") return false as Prefs[K];
  return fallback[key];
}

/**
 * Load every preference. Never rejects: a store that cannot be read is an
 * associate on defaults, which is the page they had before any of this.
 */
export async function loadPrefs(bridge: GlassesBridge, tenant: string): Promise<Prefs> {
  const out = defaultPrefs(tenant);
  await Promise.all(PREF_KEYS.map(async (key) => {
    let raw: string | null = null;
    try {
      raw = await bridge.getLocalStorage(storageKey(key));
    } catch {
      raw = null;
    }
    (out as any)[key] = decodePref(key, raw, tenant);
  }));
  return out;
}

/**
 * Write one preference, and say whether it landed.
 *
 * The boolean is passed straight through. Every caller has to decide what to do
 * with a refusal, and the only acceptable answer is to say so — a preference
 * that silently did not persist is worse than one that refused to change.
 */
export async function savePref<K extends PrefKey>(
  bridge: GlassesBridge, key: K, value: Prefs[K],
): Promise<boolean> {
  try {
    return await bridge.setLocalStorage(storageKey(key), encodePref(key, value));
  } catch {
    return false;
  }
}
