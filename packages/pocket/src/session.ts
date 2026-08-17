/**
 * Signing in as a person, on a phone that belongs to a person.
 *
 * This is the half of Pocket that a store handheld does not strictly need and
 * a personal phone cannot work without. It reuses the control plane's ordinary
 * session — the same `POST /auth/login`, the same opaque bearer token, the
 * same instant server-side revocation Console already relies on. No second
 * credential system, because a second credential system is a second thing to
 * revoke and a second thing somebody forgets to revoke.
 *
 * ── Two properties that matter here more than in Studio ──────────────────
 *
 * **The session expires on its own.** `CUE_SESSION_HOURS` is 12 by default,
 * which is roughly a shift. On a personal handset that is not an inconvenience
 * to be engineered around with a refresh token — it is the feature. A phone
 * that has been in a drawer since Friday holds nothing usable on Monday, and
 * nobody had to remember to do anything.
 *
 * **Signing out wipes.** See `identity.wipePlan`. On a personal device the
 * only guarantee available when somebody walks out is that the phone stops
 * holding anything, so sign-out is a wipe rather than a token deletion.
 */

export interface Person {
  id: string;
  name: string;
  email: string;
  role: string;
  tenant_slug: string | null;
}

export interface SignInResult {
  token: string;
  expires_at: string;
  user: Person;
}

import { SERVER_URL } from "./config.js";

export class SignInError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

export async function signIn(email: string, password: string): Promise<SignInResult> {
  let res: Response;
  try {
    res = await fetch(`${SERVER_URL}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    // Distinguished from a rejection on purpose. "Wrong password" and "this
    // corner of the shop has no signal" send an associate to two completely
    // different next actions, and the second one is by far the more common.
    throw new SignInError("No connection. Move somewhere with signal and try again.", true);
  }

  if (res.status === 401) {
    throw new SignInError("Email or password is incorrect.", false);
  }
  if (res.status === 429) {
    throw new SignInError("Too many attempts. Wait a minute and try again.", true);
  }
  if (!res.ok) {
    throw new SignInError("Sign-in is unavailable right now.", true);
  }
  return (await res.json()) as SignInResult;
}

/**
 * End the session at the server, then forget it here.
 *
 * The server call is best-effort and the local wipe is not. If the network is
 * down, "I signed out" must still mean the phone is empty — a sign-out that
 * failed because of wifi is the exact moment somebody is handing the device
 * back or leaving the building.
 */
export async function signOut(token: string | null): Promise<void> {
  if (!token) return;
  try {
    await fetch(`${SERVER_URL}/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    /* the local wipe is the part that matters, and it is the caller's */
  }
}

/**
 * Is this session still good?
 *
 * Called at boot. A token in storage is not a session: it may have expired
 * overnight, or an admin may have disabled the account this morning — which is
 * the whole reason the control plane uses revocable opaque tokens rather than
 * JWTs. `null` means sign in again; a thrown error means we could not ask.
 */
export async function whoAmI(token: string): Promise<Person | null> {
  const res = await fetch(`${SERVER_URL}/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new Error(`auth/me → ${res.status}`);
  const body = (await res.json()) as { user: Person };
  return body.user;
}
