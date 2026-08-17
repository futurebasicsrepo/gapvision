/**
 * Which phone this is, and what it is therefore allowed to hold.
 *
 * ── The rule this module exists to enforce ────────────────────────────────
 *
 * **The store must not walk out on an employee's personal phone.**
 *
 * Two things could walk out, and they need different defences:
 *
 *   1. **A credential that authenticates as the store.** A provision token is
 *      not a login — it *is* the store's identity on that device. Whoever
 *      holds it registers as this shop, sees its floor, and hears its comms.
 *      On a personal phone that is a store credential in a stranger's pocket
 *      the day someone quits, and the only record of it is a row labelled
 *      "Sam's iPhone".
 *   2. **Customer data at rest.** Names, carts, purchase history. See
 *      `store.ts` — that one is handled universally rather than per-mode,
 *      because last night's guest has no business sitting in a store
 *      handheld's localStorage either.
 *
 * So this module decides (1): two modes, and one forbidden combination.
 *
 *   **managed**   a store-owned handheld. An admin minted it in Console and
 *                 scanned the QR into it. It holds a provision token. It *is*
 *                 the store. A person may additionally sign in on top, and
 *                 normally should — that is what attributes a sale.
 *
 *   **personal**  an associate's own phone. It holds a session that belongs to
 *                 *them*, expiring at `CUE_SESSION_HOURS` (12 by default —
 *                 roughly a shift). It never holds a provision token. Revoking
 *                 their access is disabling the person in Console; nobody has
 *                 to chase a handset.
 *
 * ── Why the mode is sticky ───────────────────────────────────────────────
 *
 * First boot decides, and it cannot be changed by a later URL. Otherwise the
 * attack is a text message: send an associate a provisioning link, they tap
 * it, and their personal phone silently becomes the store. A launch URL is not
 * a decision an admin made about *this handset* — it is a string that arrived.
 *
 * Changing mode requires `wipe()`, which is deliberately the same door as
 * signing out: there is no path from personal to managed that does not first
 * destroy everything the personal session held.
 */

export type PocketMode = "managed" | "personal";

/** What the app knows at boot, before it decides anything. */
export interface BootClaim {
  /** The mode this install already settled on, if it has booted before. */
  storedMode: PocketMode | null;
  /** `?t=` on the launch URL — a provision token somebody is presenting. */
  urlToken: string | null;
  /** `?tenant=` — a hint, never an authorisation. The server resolves the
   *  real tenant from the token and refuses a mismatch. */
  urlTenant: string | null;
}

export type BootDecision =
  /** First boot with a provision token: this becomes a store handheld. */
  | { mode: "managed"; storeToken: string; tenantHint: string | null; reason: "provisioned" }
  /** A store handheld starting up again. */
  | { mode: "managed"; storeToken: null; tenantHint: string | null; reason: "already-managed" }
  /** No token, no history: an associate's own phone, which must sign in. */
  | { mode: "personal"; storeToken: null; tenantHint: string | null; reason: "no-token" }
  /** A personal phone that was handed a provision link. Refused, loudly. */
  | { mode: "personal"; storeToken: null; tenantHint: string | null; reason: "refused-token-on-personal" };

/**
 * The whole policy, as one pure function.
 *
 * Pure on purpose: this is the decision that keeps a store credential off a
 * personal handset, and a decision that can only be tested by driving a
 * browser is a decision that gets tested once.
 */
export function decideBoot(claim: BootClaim): BootDecision {
  const token = (claim.urlToken || "").trim() || null;
  const tenantHint = (claim.urlTenant || "").trim().toLowerCase() || null;

  if (claim.storedMode === "personal") {
    // The sticky rule. A provision token arriving at a phone that already
    // decided it was somebody's own is refused — and named as refused, so the
    // UI can say what happened rather than appearing to ignore the link.
    return token
      ? { mode: "personal", storeToken: null, tenantHint, reason: "refused-token-on-personal" }
      : { mode: "personal", storeToken: null, tenantHint, reason: "no-token" };
  }

  if (claim.storedMode === "managed") {
    // Already a handheld. A fresh token on the URL is a reissue, which is a
    // legitimate thing an admin does; the stored one is replaced.
    return token
      ? { mode: "managed", storeToken: token, tenantHint, reason: "provisioned" }
      : { mode: "managed", storeToken: null, tenantHint, reason: "already-managed" };
  }

  // First boot.
  return token
    ? { mode: "managed", storeToken: token, tenantHint, reason: "provisioned" }
    : { mode: "personal", storeToken: null, tenantHint, reason: "no-token" };
}

/**
 * May this mode hold a provision token at all?
 *
 * The invariant, stated once so both the boot path and any later write can be
 * checked against the same sentence. The client enforcing it is the polite
 * half; `packages/server` refuses a socket that presents both a provision
 * token and a personal session, because a client is not a place to keep a
 * security rule.
 */
export function mayHoldStoreToken(mode: PocketMode): boolean {
  return mode === "managed";
}

/**
 * What signing out has to destroy, by mode.
 *
 * On a personal phone this is not tidying — it is the point. An associate who
 * signs out at the end of a shift has handed nothing back, so the only
 * guarantee available is that the phone stops holding anything.
 *
 * On a handheld, signing out ends the *person's* session and deliberately
 * keeps the device identity: the handset stays provisioned so the next
 * associate on shift finds a working device rather than a QR they cannot mint.
 */
export function wipePlan(mode: PocketMode): {
  session: boolean; storeToken: boolean; queue: boolean; caches: boolean; push: boolean;
} {
  return {
    session: true,
    storeToken: mode === "personal", // there is never one, and it stays that way
    queue: mode === "personal",      // a handheld's unsent work survives a shift change
    caches: mode === "personal",
    push: true,                      // a push subscription outliving a session is a leak
  };
}

/**
 * The one-line answer to "what does this phone hold?", for the associate.
 *
 * Shown in Pocket's own settings, in plain words, because the person whose
 * phone it is has the strongest possible claim to know — and because a promise
 * the product makes to a security reviewer that the product will not repeat to
 * the employee is a promise worth doubting.
 */
export function holdsSummary(mode: PocketMode): string {
  return mode === "managed"
    ? "This is a store device. It carries the store's identity and stays signed in to the shop between shifts."
    : "This is your phone. It carries your sign-in and nothing belonging to the store — no store identity, no customer records. Signing out leaves nothing behind.";
}
