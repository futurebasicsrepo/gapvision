/**
 * Cue Pocket — the associate's phone.
 *
 * The same card deck as the glasses (`@cue/lens-core`), driven by a thumb
 * instead of a Neural Band, in a page that installs to a home screen and keeps
 * working when the wifi does not.
 *
 * ── What this file is responsible for ────────────────────────────────────
 *
 * Only the wiring. Every decision with a consequence lives in a module that
 * can be tested without a browser:
 *
 *   identity.ts   which kind of phone this is, and what it may hold
 *   store.ts      what may be written to disk (a whitelist) and what may not
 *   queue.ts      work taken on a dead network, and its ordering
 *   touch.ts      a thumb, as one of the six gestures every lens speaks
 *   platform.ts   what this particular handset can actually do
 *
 * That split is the point. The rule that keeps a store credential off an
 * employee's own phone is a pure function with a suite, not a branch buried in
 * a boot sequence.
 */
import { io, type Socket } from "socket.io-client";
import {
  type DeckState, type DisplayPayload,
  back, deckOf, move, select,
} from "@cue/lens-core";
import { decideBoot, mayHoldStoreToken, wipePlan, type PocketMode } from "./identity.js";
import { durable, ephemeral, wipeEverything } from "./store.js";
import { ActionQueue, type QueuedAction } from "./queue.js";
import { onTouchGesture } from "./touch.js";
import type { LensGesture } from "./gestures.js";
import { detect } from "./platform.js";
import { installHint, watchForInstall } from "./install.js";
import { ScreenWake } from "./wake.js";
import * as session from "./session.js";
import { SERVER_URL } from "./config.js";
import {
  type Chrome, deckScreen, idleScreen, notice, paint, settingsScreen, signInScreen, strip,
} from "./render.js";

const APP_VERSION = "0.1.0";
const SURFACE = "phone";


/**
 * What the server said, in words an associate can act on.
 *
 * Three refusals that a single "not recognised" would flatten into one, and
 * they send somebody to three different next actions: find an admin, sign in
 * again, or stop trying to make a personal phone into a store device. The
 * realtime server names them separately for exactly this reason.
 */
const REFUSALS: Record<string, string> = {
  not_provisioned:
    "This device is not recognised by the store. Ask an admin to issue it a new code.",
  session_invalid:
    "Your sign-in is no longer valid — it may have expired, or an admin may have changed your access. Sign in again.",
  conflicting_identity:
    "This phone is signed in as you, so a store setup link does not apply to it. Ask an admin for a store device if you need one.",
};

const root = document.getElementById("app")!;
const caps = detect();
const wake = new ScreenWake();

// --- boot: which phone is this? ----------------------------------------------

const params = new URLSearchParams(location.search);
const decision = decideBoot({
  storedMode: (durable.get("mode") as PocketMode | null) || null,
  urlToken: params.get("t"),
  urlTenant: params.get("tenant"),
});

let mode: PocketMode = decision.mode;
durable.set("mode", mode);

if (decision.storeToken) {
  // Belt and braces: `decideBoot` will not hand back a token for a personal
  // phone, and this refuses to write one anyway. The invariant is worth two
  // checks — it is the one Kyle named.
  if (mayHoldStoreToken(mode)) durable.set("store_token", decision.storeToken);
}
if (decision.tenantHint) durable.set("tenant", decision.tenantHint);

// The token is spent the moment it is stored. Leaving it in the address bar
// leaves a store credential in the browser's history, in the recents list, and
// in whatever the associate pastes into a group chat when they mean to share
// the app with a colleague.
if (params.has("t")) {
  params.delete("t");
  history.replaceState({}, "", location.pathname + (params.toString() ? `?${params}` : ""));
}

const storeToken = mayHoldStoreToken(mode) ? durable.get("store_token") : null;
const queue = new ActionQueue({
  read: () => durable.get("queue"),
  write: (v) => { durable.set("queue", v); },
});

// --- state -------------------------------------------------------------------

type Screen = "signin" | "idle" | "deck" | "settings";

const state = {
  screen: "signin" as Screen,
  connected: false,
  refused: false,
  refusedReason: null as string | null,
  // A refusal decided locally, at boot, before any socket exists. Kept apart
  // from `refusedReason` (which the server sends) because this one does not
  // stop the app working — the phone carries on as somebody's own phone, and
  // the only thing owed is an explanation of why the link they tapped did
  // nothing. Without it the app looks broken at the exact moment it is
  // working correctly.
  bootRefusal: decision.reason === "refused-token-on-personal",
  who: durable.get("who"),
  sessionToken: durable.get("session"),
  tenant: durable.get("tenant") || "gap",
  zone: params.get("zone") || "Floor",
  deck: null as DeckState | null,
  engagementId: null as string | null,
  error: null as string | null,
  busy: false,
  message: null as string | null,
};

let socket: Socket | null = null;

function chrome(): Chrome {
  return {
    connected: state.connected,
    pending: queue.length,
    zone: state.zone,
    tenantLabel: state.tenant.toUpperCase(),
  };
}

// --- painting ----------------------------------------------------------------

function render(): void {
  const hint = state.screen === "idle" ? installHint({ isIOS: caps.isIOS }) : null;
  const banner = state.refused
    ? notice(REFUSALS[state.refusedReason || "not_provisioned"] || REFUSALS.not_provisioned)
    : state.bootRefusal
      ? notice(REFUSALS.conflicting_identity,
               { onDismiss: () => { state.bootRefusal = false; render(); } })
    : state.message
      ? notice(state.message, { calm: true, onDismiss: () => { state.message = null; render(); } })
      : hint && !durable.get("installed_hint")
        ? notice(hint, {
            calm: true,
            onDismiss: () => { durable.set("installed_hint", "1"); render(); },
          })
        : null;

  const body = (() => {
    switch (state.screen) {
      case "signin":
        return signInScreen({
          error: state.error, busy: state.busy,
          onSubmit: (email, password) => void doSignIn(email, password),
        });
      case "settings":
        return settingsScreen({
          mode, caps, who: state.who,
          onSignOut: () => void doSignOut(),
          onClose: () => { state.screen = state.deck ? "deck" : "idle"; render(); },
        });
      case "deck":
        return state.deck
          ? deckScreen(state.deck, chrome(), {
              onSelect: () => onGesture("select"),
              onBack: () => onGesture("back"),
              onEnd: () => endEngagement(),
            })
          : idleScreen(chrome(), { greeting: firstName(state.who) });
      default:
        return idleScreen(chrome(), { greeting: firstName(state.who) });
    }
  })();

  const bar = strip(chrome());
  // The status strip doubles as the way into settings. A gear icon in a corner
  // is a two-handed reach on a large phone; the strip runs the full width.
  bar.addEventListener("click", () => {
    if (state.screen !== "settings") { state.screen = "settings"; render(); }
  });

  paint(root, bar, banner, body);
}

const firstName = (n: string | null) => (n ? n.split(" ")[0] : null);

// --- gestures ----------------------------------------------------------------

function onGesture(g: LensGesture): void {
  if (!state.deck) return;
  if (g === "prev") state.deck = move(state.deck, -1);
  else if (g === "next") state.deck = move(state.deck, 1);
  else if (g === "up") state.deck = move(state.deck, -1);
  else if (g === "down") state.deck = move(state.deck, 1);
  else if (g === "back") state.deck = back(state.deck);
  else if (g === "select") {
    const r = select(state.deck);
    state.deck = r.state;
    if (r.action === "end-engagement") return endEngagement();
    if (r.action === "open-floor") { state.message = "Floor channel is on the way."; }
  }
  render();
}

onTouchGesture(root, onGesture);

// Android's system back gesture, and a keyboard for anyone testing on a
// laptop. Escape is `back` on every other lens surface; keeping it here means
// the browser preview is a usable rehearsal for the phone.
addEventListener("keydown", (e) => {
  if (e.key === "Escape") onGesture("back");
  if (e.key === "Enter") onGesture("select");
  if (e.key === "ArrowLeft") onGesture("prev");
  if (e.key === "ArrowRight") onGesture("next");
});
history.pushState({ pocket: true }, "");
addEventListener("popstate", () => {
  history.pushState({ pocket: true }, "");
  if (state.screen === "settings") { state.screen = state.deck ? "deck" : "idle"; render(); }
  else onGesture("back");
});

// --- engagement --------------------------------------------------------------

function openEngagement(payload: DisplayPayload): void {
  // The guest goes in memory and nowhere else. `store.ts` refuses to persist
  // it even if a later change tries; this is the call site keeping its side of
  // the bargain rather than relying on that refusal.
  ephemeral.set("payload", payload);
  const lensMode = durable.get("lens_mode") === "classic" ? "classic" : "meta";
  state.deck = deckOf(payload, lensMode);
  state.screen = "deck";
  void wake.acquire();
  if (caps.vibrate) navigator.vibrate?.(30);
  render();
}

function endEngagement(): void {
  if (state.engagementId) queue.push("end", { engagementId: state.engagementId });
  state.deck = null;
  state.engagementId = null;
  ephemeral.drop("payload");
  state.screen = "idle";
  void wake.release();
  send();
  render();
}

// --- the socket --------------------------------------------------------------

function connect(): void {
  // Exactly one credential goes on this handshake, and which one depends on
  // what kind of phone this is. A managed handheld presents the store's
  // provision token; a personal phone presents the *person's* session. The
  // realtime server refuses a socket that offers both — see packages/server —
  // because "the store on somebody's own phone" is precisely the state this
  // whole design exists to make unreachable.
  const auth: Record<string, string | undefined> = {
    tenant: state.tenant,
    surface: SURFACE,
    app_version: APP_VERSION,
  };
  if (mode === "managed" && storeToken) auth.token = storeToken;
  else if (state.sessionToken) auth.session = state.sessionToken;

  socket = io(SERVER_URL, { auth, transports: ["websocket", "polling"] });

  socket.on("connect", () => {
    state.connected = true;
    state.refused = false;
    state.refusedReason = null;
    socket!.emit("register", {
      role: "associate",
      name: state.who || "Associate",
      zone: state.zone,
      tenant: state.tenant,
      appVersion: APP_VERSION,
      surface: SURFACE,
    });
    send();
    render();
  });

  socket.on("register:refused", ({ reason }: { reason?: string } = {}) => {
    state.refused = true;
    state.refusedReason = reason || null;
    state.connected = false;
    render();
  });

  socket.on("disconnect", () => { state.connected = false; render(); });
  socket.on("glasses:display", (payload: DisplayPayload) => openEngagement(payload));
  socket.on("request:taken", () => { state.message = "Someone else took that one."; render(); });
  socket.on("roster:you", ({ name }: { name?: string }) => {
    if (name && !state.who) { state.who = name; render(); }
  });
}

/**
 * Drain the queue.
 *
 * Socket.io buffers emits while disconnected and replays them on reconnect,
 * which sounds like it makes this redundant and does not: that buffer is in
 * memory, so it dies when the app is swiped away or the phone runs out of
 * battery — which is exactly when an associate is most likely to have taken an
 * action they believe happened.
 */
function send(): void {
  if (!socket?.connected) return;
  void queue.flush(async (a: QueuedAction) => {
    switch (a.type) {
      case "claim": socket!.emit("request:claim", { requestId: a.payload.requestId }); return true;
      case "end": socket!.emit("session:end", {}); return true;
      case "floor:message":
        socket!.emit("radio:send", { message: a.payload.text, to: a.payload.to || undefined });
        return true;
      case "mark": socket!.emit("client:gesture", { kind: a.payload.kind, sku: a.payload.sku }); return true;
      default: return true;    // an action type this build does not know: drop it rather than jam
    }
  }).then(() => render());
}

// --- sign in / out -----------------------------------------------------------

async function doSignIn(email: string, password: string): Promise<void> {
  state.busy = true; state.error = null; render();
  try {
    const result = await session.signIn(email, password);
    durable.set("session", result.token);
    durable.set("who", result.user.name);
    if (result.user.tenant_slug) {
      state.tenant = result.user.tenant_slug;
      durable.set("tenant", result.user.tenant_slug);
    }
    state.sessionToken = result.token;
    state.who = result.user.name;
    state.screen = "idle";
    connect();
  } catch (err) {
    state.error = err instanceof session.SignInError ? err.message : "Sign-in failed.";
  } finally {
    state.busy = false;
    render();
  }
}

/**
 * The other half of "the store does not walk out on an employee's phone".
 *
 * The server call is best-effort; the local destruction is not. An associate
 * signing out is very often standing at the door, and a wipe that was skipped
 * because the wifi dropped would be the exact failure this app promises does
 * not happen.
 */
async function doSignOut(): Promise<void> {
  const plan = wipePlan(mode);
  const token = state.sessionToken;
  socket?.disconnect();
  await session.signOut(token);

  if (plan.storeToken || plan.caches) {
    await wipeEverything({ caches: plan.caches });
    // Everything is gone — and then one fact is written straight back.
    //
    // `mode` is not the store's and not the person's; it is a fact about this
    // handset. A wiped phone with no stored mode is indistinguishable from a
    // brand-new one, so the next provisioning link tapped on it would be
    // honoured and the handset would become the store. That is the exact
    // attack the sticky rule exists to stop, arriving through the front door
    // of the feature that was supposed to make the phone safe.
    //
    // So: erasing a personal phone leaves it erased *and still personal*.
    durable.set("mode", mode);
    if (caps.serviceWorker) {
      // The registration itself goes too. A worker left behind on a personal
      // phone is code from a former employer still running on it.
      const regs = await navigator.serviceWorker.getRegistrations().catch(() => []);
      await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
    }
    location.replace(location.pathname);
    return;
  }

  // A handheld: the person leaves, the device stays provisioned so the next
  // associate on shift finds something that works rather than a QR they cannot
  // mint themselves.
  durable.remove("session");
  durable.remove("who");
  state.sessionToken = null;
  state.who = null;
  state.screen = "signin";
  render();
}

// --- service worker ----------------------------------------------------------

if (caps.serviceWorker && location.protocol === "https:") {
  navigator.serviceWorker.register("./sw.js").then((reg) => {
    reg.addEventListener("updatefound", () => {
      const next = reg.installing;
      next?.addEventListener("statechange", () => {
        // A new build is cached and waiting. Offered rather than forced: a
        // reload during an engagement would drop the card an associate is
        // reading to a guest.
        if (next.state === "installed" && navigator.serviceWorker.controller) {
          state.message = "A new version is ready — reopen cue when you have a moment.";
          render();
        }
      });
    });
  }).catch(() => { /* http, or a browser without one: the app still works */ });

  navigator.serviceWorker.addEventListener("message", (e) => {
    const data = e.data as { kind?: string; action?: string; requestId?: string };
    if (data?.kind !== "notification" || !data.requestId) return;
    if (data.action === "claim") { queue.push("claim", { requestId: data.requestId }); send(); }
    render();
  });
}

// A claim tapped on a notification while the app was closed arrives as a
// parameter rather than a message, because there was no page to message.
if (params.get("act") === "claim" && params.get("req")) {
  queue.push("claim", { requestId: params.get("req")! });
}

watchForInstall(() => render());

// --- start -------------------------------------------------------------------

(async function start() {
  if (mode === "managed" && storeToken) {
    // A handheld works before anybody signs in: the device is the store, and a
    // shop that cannot answer its floor because nobody has logged in yet is a
    // shop the product has failed.
    state.screen = "idle";
    connect();
    render();
    if (state.sessionToken) void confirmSession();
    return;
  }

  if (state.sessionToken) {
    state.screen = "idle";
    render();
    const ok = await confirmSession();
    if (ok) connect();
    return;
  }

  state.screen = "signin";
  render();
})();

/**
 * Is the stored session still real?
 *
 * A token in storage is not a session. It may have expired overnight — twelve
 * hours by default, which is roughly a shift and deliberately not longer on a
 * personal handset — or an admin may have disabled the account this morning.
 * A network failure is *not* an answer: we keep the session and try again,
 * because signing somebody out because a shop's wifi blinked is its own
 * outage.
 */
async function confirmSession(): Promise<boolean> {
  try {
    const person = await session.whoAmI(state.sessionToken!);
    if (person) {
      state.who = person.name;
      durable.set("who", person.name);
      if (person.tenant_slug) { state.tenant = person.tenant_slug; durable.set("tenant", person.tenant_slug); }
      render();
      return true;
    }
    // Answered, and the answer was no.
    await doSignOut();
    return false;
  } catch {
    return true;
  }
}
