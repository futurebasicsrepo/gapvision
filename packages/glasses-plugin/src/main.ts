/**
 * CueSea — Even Hub plugin entry.
 *
 * Runs in the Even App WebView on the associate's phone. Connects to the
 * CueSea realtime server, renders guest context to the glasses via the
 * Even Hub bridge, and maps ring and temple gestures to session actions.
 *
 * Control scheme is ring-first. An associate standing in front of a customer
 * can turn a ring on their finger invisibly; reaching up to tap their temple
 * is a visible tell that they're consulting something. The temple mirrors
 * every ring action as a fallback.
 *
 *   click        dismiss what's on the lens / end the engagement
 *   double-click open the mic and ask
 *   scroll       cycle the recommendations — and whatever is showing becomes
 *                the thing "these" refers to in the next voice question
 *
 * In a plain browser this same file runs against the MockBridge and renders
 * to the on-page virtual lens — the full flow is testable with zero hardware.
 */
import { io, type Socket } from "socket.io-client";
import { getBridge, type GlassesBridge } from "./bridge";
import { decodeGesture, describeGesture, type DecodedGesture } from "./gestures";
import { buildCue, buildMenu, buildRuler, CUE_LINES, FACT_CHARS, IDLE_CUE,
         RULER_HEIGHTS, toDisplayText, type Cue } from "./layout";
import { cardsFor, cueOf, money, type Card, type DisplayPayload,
         type Recommendation } from "./cards";
import { markBytes } from "./mark";
import { VoiceController, type VoiceResult, type VoiceState } from "./voice";
import { captureControls, fetchCapabilities, NO_CAPABILITIES, VisionController,
         type Capabilities, type VisionKind, type VisionState } from "./vision";
import { defaultPrefs, effectivePrefs, loadPrefs, normaliseZone, savePref,
         visiblePrefs, MAX_ZONE_CHARS, type FloorComms, type PrefKey,
         type Prefs } from "./prefs";

/**
 * Everything goes through the realtime server. The plugin is a static bundle,
 * so it cannot hold the AI service key — the server holds it and proxies.
 * There is deliberately no VITE_AI_URL any more: a build flag that points the
 * plugin straight at the AI service would quietly undo that.
 *
 * Defaulted from the manifest's own network whitelist (see vite.config.ts), not
 * from an environment variable. `VITE_SERVER_URL` still overrides for local
 * work against a server on this machine — but a missing `.env` now costs you
 * nothing, where it used to cost an upload: the packed plugin dialled
 * localhost from a phone, installed clean, rendered the HUD correctly, and
 * silently had no socket at all.
 */
const SERVER_URL = import.meta.env.VITE_SERVER_URL || __REALTIME_URL__;

/** Tenant = which retail world this launch belongs to ("gap" demo | "shopify"
 *  live). Carried by the launch URL, i.e. the QR code that opened us. */
const TENANT =
  new URLSearchParams(window.location.search).get("tenant")?.toLowerCase() || "gap";
const TENANT_LABEL = TENANT === "shopify" ? "FUTURE BASICS · LIVE" : "GAP · DEMO";

/**
 * This associate's preferences.
 *
 * `stored` is what is in the host's key-value store; `prefs` is what is in
 * force, which is `stored` with anything the store does not permit resolved
 * back to its default. See `prefs.ts` — capability and preference are different
 * questions and this is the only place they meet.
 *
 * The zone used to be `const ZONE = TENANT === "shopify" ? ...`, a per-tenant
 * constant carried into `register` and every `beacon:guest-enter`. It was the
 * most obviously wrong thing on the page: an associate works a section of a
 * floor, not the section their tenant's demo data was written around. It is now
 * the default and nothing more.
 */
let stored: Prefs = defaultPrefs(TENANT);
let prefs: Prefs = { ...stored };

const ui = {
  bridgeStatus: document.getElementById("bridge-status")!,
  serverStatus: document.getElementById("server-status")!,
  voiceStatus: document.getElementById("voice-status")!,
  ringStatus: document.getElementById("ring-status"),
  sessionInfo: document.getElementById("session-info")!,
  log: document.getElementById("event-log")!,
  inspector: document.getElementById("event-inspector"),
};

function log(msg: string) {
  const row = document.createElement("div");
  row.textContent = `${new Date().toLocaleTimeString()} — ${msg}`;
  ui.log.prepend(row);
  while (ui.log.childElementCount > 40) ui.log.lastElementChild?.remove();
}

let bridge: GlassesBridge;
let socket: Socket;
let voice: VoiceController;
let vision: VisionController;
/** Send the associate record — name, tenant, device and zone — to the server.
 *  Assigned in `main()` once the socket and the user info exist. */
let registerAssociate: () => void = () => {};
/**
 * A zone change that is waiting for the current engagement to end.
 *
 * The server rebuilds its associate record from `register`, which resets
 * `status` to "available" and clears the gesture list. Doing that mid
 * engagement would show a busy associate as free on the manager dashboard, and
 * there is no other message that carries a zone — `beacon:guest-enter` carries
 * one, but re-sending it would open a second engagement and count the guest
 * twice. So a zone changed during an engagement is applied locally at once (it
 * is on the next guest-enter either way) and re-registered the moment the
 * engagement ends, which is also the moment the associate is actually standing
 * in the new zone.
 */
let zoneRegisterPending = false;

/**
 * What this store has turned on, fetched at boot.
 *
 * Starts as everything-off and stays that way if the fetch fails, times out or
 * comes back malformed. That default is the whole design of the gate: the
 * capture card is built from this object, so a tenant that declined the camera
 * and a server we could not reach produce the same page — one with no camera
 * control on it. Failing the other way would put a camera control in front of
 * an associate whose store said no, which is not a bug you find in testing, it
 * is one a customer finds.
 *
 * Only `camera_capture` is enforced today. `voice` and `floor_comms` are read
 * and reported so the server side has somewhere to land, but nothing is gated
 * on them yet: those features shipped before this endpoint existed, and
 * switching them off on the first failed fetch would break every tenant to
 * protect a permission none of them have set. The camera is different — it is
 * new, so there is no working behaviour to lose, and it is the one where the
 * failure of showing it wrongly is worse than the failure of hiding it.
 */
let capabilities: Capabilities = { ...NO_CAPABILITIES };
/** The set of containers currently built on the glass, as a comparable key.
 *  Not the line count — see `renderCue`. */
let currentShape = "";
let pageBuilt = false;
/**
 * Whether to ask for the mark instead of the word CUE.
 *
 * Starts true — try it — and latches false the first time the host declines.
 * It never latches back: a host that cannot take an image is not going to
 * start mid-shift, and retrying on every render would mean a container that
 * flickers between a mark and a wordmark on a customer's face.
 *
 * The pixels do not survive a page rebuild. The container is re-declared
 * empty every time, so `pushMark` runs after every build, not just the first.
 */
let useMark = true;
/** On the type ruler — a diagnostic page that is not a cue and must not be
 *  treated as one. See showRuler(). */
let onRuler = false;

/**
 * Floor comms.
 *
 * `inbox` holds messages that arrived and have not been acted on. Urgent ones
 * never land here — they take the frame the moment they arrive and are dealt
 * with there. Everything else waits, because interrupting an associate
 * mid-sentence in front of a customer to tell them the till queue is building
 * is worse than the till queue building.
 *
 * Kyle's decision, 2026-08-15: a priority tier. Silently queueing everything
 * means backup requests get missed; interrupting on everything means the
 * guest card vanishes at the worst possible moment.
 */
type RadioMessage = {
  id?: string; fromId?: string; from: string; message: string;
  priority?: "urgent" | "normal"; at?: string;
};
let inbox: RadioMessage[] = [];

/**
 * A guest asking for something, from their own phone.
 *
 * The one thing on this display that a customer wrote. It takes the frame on
 * the same rule urgent floor traffic does — a person standing in a fitting
 * room in one shoe is the most time-sensitive thing in the building, and a
 * request that waits for someone to next open a menu is a request that did
 * not arrive.
 *
 * `line` is composed server-side with the size first, deliberately: it is the
 * part that must survive truncation on a 21-character row. A clipped product
 * name still names the jean. A clipped size is a wrong answer.
 */
type GuestRequest = {
  request_id: string; zone?: string; line: string;
  need?: string; product?: string; size?: string; note?: string; at?: string;
};
/** The request currently holding the frame, if any. */
let onRequest: GuestRequest | null = null;
/** The urgent message currently holding the frame, if any. Held rather than
 *  flagged so a press can act on the right one when two arrive together. */
let onUrgent: RadioMessage | null = null;
/** Where the floor menu is, when it is open. -1 = closed. */
let menuIndex = -1;
let menuItems: { label: string; send?: string; urgent?: boolean; msg?: RadioMessage }[] = [];

/**
 * What an associate can say back, without a keyboard and without speaking.
 *
 * Written to 21 characters, which is what a row holds beside the fact rail —
 * the tightest place any of these can land. The vocabulary is a real product
 * decision and should come from watching a floor; this is the starting guess
 * from `claude/floor-comms.md`.
 *
 * Only the first is urgent. If everything is urgent then nothing is, and the
 * tier stops meaning anything within a shift.
 */
const PHRASES: { label: string; urgent?: boolean }[] = [
  { label: "NEED BACKUP", urgent: true },
  { label: "ON MY WAY" },
  { label: "SIZE CHECK" },
  { label: "COVERING YOUR GUEST" },
  { label: "FITTING ROOM OPEN" },
  { label: "TILL QUEUE BUILDING" },
  { label: "BREAK?" },
];
let engaged = false;

/** What the associate is currently looking at — the context a voice question
 *  like "do we have these in a 32" needs in order to mean anything. */
let engagedGuestId: string | null = null;
let focusSku: string | null = null;
let lastDisplay: DisplayPayload | null = null;

let recommendations: Recommendation[] = [];

/**
 * The card stack, and where in it we are. The stack itself is built by
 * `cardsFor` in cards.ts — pure, and tested there. What lives here is the
 * *state*: which stack is on the glass and which card of it, because that is
 * session state and not a function of the payload.
 *
 * 0 is always the cue. This was `recIndex`, which stopped being true the
 * moment the stack held anything but recommendations.
 */
let cards: Card[] = [];
let cardIndex = 0;

function modulePosition() { return cardIndex; }
function moduleTotal() { return engaged ? cards.length : 0; }
function moduleLabel() { return cards[cardIndex]?.kind || "CUE"; }

/**
 * The fact rail — persistent detail down the left, unchanged while scrolling
 * moves the module on the right. Kyle's shape, from Even's own dashboard.
 *
 * Set once when a guest is identified and left alone after that: the whole
 * value of a rail is that it does not move underneath someone reading it
 * mid-sentence. Cleared on idle, because facts about nobody are noise.
 */
let railFacts: string[] = [];

/**
 * Session state that has to outlive a foreground transition.
 *
 * Gesture telemetry from the G2 showed `foreground-exit` / `foreground-enter`
 * pairs with `engaged=false` on every gesture afterwards, while the server
 * still had a live engagement. The WebView is being torn down and reloaded,
 * and module state goes with it — so scrolling silently did nothing
 * (`cycleCards` returns early on `!engaged`) and the rail had no
 * guest to draw.
 *
 * sessionStorage, not localStorage: this should survive a reload, not a shift.
 */
const RESUME_KEY = "cue.session";

function rememberSession() {
  try {
    sessionStorage.setItem(RESUME_KEY, JSON.stringify({
      guestId: engagedGuestId, focusSku, tenant: TENANT,
    }));
  } catch { /* private mode — we just come back blank, as before */ }
}

function forgetSession() {
  try { sessionStorage.removeItem(RESUME_KEY); } catch { /* nothing to clear */ }
}

/** Re-ask the server for the guest we were on. The card is rebuilt from the
 *  CRM rather than restored from a stale copy, so nothing goes out of date. */
function resumeSession() {
  let saved: { guestId?: string; focusSku?: string } | null = null;
  try { saved = JSON.parse(sessionStorage.getItem(RESUME_KEY) || "null"); } catch { saved = null; }
  if (!saved?.guestId) return false;
  focusSku = saved.focusSku ?? null;
  log(`resuming session for ${saved.guestId}`);
  socket?.emit("beacon:guest-enter", { guestId: saved.guestId, zone: prefs.zone, tenant: TENANT });
  return true;
}

/** Render a cue. `status` is gone: the glass shows nothing it doesn't have to,
 *  and a hint row is chrome. */
async function renderCue(cue: Cue, latencyMs?: number) {
  // Every surface — guest card, recommendation, voice answer — gets the rail
  // and the module position from here, rather than each call site remembering.
  const page = buildCue(
    {
      ...cue,
      logo: useMark,
      facts: cue.facts ?? railFacts,
      moduleIndex: cue.moduleIndex ?? modulePosition(),
      moduleCount: cue.moduleCount ?? moduleTotal(),
      moduleName: cue.moduleName ?? moduleLabel(),
    },
    latencyMs,
  );
  // "Same shape" means *the same containers exist*, not the same number of
  // lines. The cheap path below upgrades containers by id; it cannot create
  // one. When the fact rail arrived, the guest page needed five containers the
  // idle page had never built (the rail and the module indicator) — and since
  // both pages have three lines, the old check said "same shape", took the
  // cheap path, and silently drew none of them. The HUD looked unchanged
  // because it was unchanged.
  // Every container kind, not just text: the fact rail is a list container,
  // and a rail appearing or vanishing has to force a rebuild like anything
  // else. Keyed by kind so a text and a list id can never collide.
  //
  // A list is keyed by its **contents**, not just its id, and that is not
  // symmetry for its own sake. The cheap path sends `textContainerUpgrade`
  // per text container and there is no list equivalent in the SDK — so a
  // rail whose rows changed while its id did not is a rail that never
  // reaches the glass. Two guests both with full rails produce an identical
  // id-only key, which means the second customer would have been shown the
  // first one's name, tier and sizes. The unread count had the same bug more
  // quietly: it lives in the rail, so it only ever appeared on a rebuild.
  //
  // The cost is a rebuild whenever rail rows change. That is the right trade:
  // rail contents change on a new guest, an unread message and a preference
  // toggle, none of which are hot, while the actual hot path — three cue
  // lines changing under an unchanged rail, which is every card scroll and
  // every voice answer — still takes the cheap path.
  const shape = [
    ...page.textObject.map((c) => `t${c.containerID}`),
    ...(page.listObject || []).map(
      (c) => `l${c.containerID}:${(c.itemContainer?.itemName || []).join("|")}`,
    ),
  ].join(",");
  const sameShape = pageBuilt && shape === currentShape;

  if (!pageBuilt) {
    await bridge.createStartUpPageContainer(page);
    pageBuilt = true;
    if (!(await pushMark(page))) return renderCue(cue, latencyMs);
  } else if (sameShape) {
    // Cheap path: text-only updates, no page rebuild.
    for (const c of page.textObject) {
      await bridge.textContainerUpgrade({
        containerID: c.containerID,
        containerName: c.containerName,
        content: c.content,
      });
    }
  } else {
    await bridge.rebuildPageContainer(page);
    if (!(await pushMark(page))) return renderCue(cue, latencyMs);
  }
  currentShape = shape;
}

/**
 * Make the next `renderCue` rebuild the page rather than take the cheap path.
 *
 * The cheap path sends `textContainerUpgrade` per **text** container, so a
 * change that lives in the fact rail — a list container — is not sent at all
 * when the shape key is unchanged. The key is the set of container ids, and the
 * rail keeps id 9 whether it holds four rows or six, so dropping the points row
 * or gaining an unread count reads as "same shape" and never reaches the glass.
 *
 * Clearing the key here is the narrow fix: the callers that change the rail's
 * *contents* say so, and everything else keeps the cheap path it was written
 * for. Widening the key to cover list contents would fix the same thing more
 * generally and is the better change; it belongs with `page-shape.test.mjs`,
 * which carries its own copy of this comparison, rather than in a settings
 * pass.
 */
function rebuildNext() {
  currentShape = "";
}

/**
 * Send the mark's pixels for whatever image containers this page declared.
 *
 * Returns false when the host refused, having already latched `useMark` off —
 * the caller re-renders, which builds the wordmark page instead. That retry
 * happens at most once in the life of the app, and it is the difference
 * between a brand mark and an empty rectangle in the corner of someone's
 * vision.
 */
async function pushMark(page: ReturnType<typeof buildCue>): Promise<boolean> {
  for (const c of page.imageObject || []) {
    const result = await bridge.updateImageRawData({
      containerID: c.containerID,
      containerName: c.containerName,
      imageData: markBytes(),
    });
    if (result !== "success") {
      log(`mark rejected by host (${result}) — falling back to the wordmark`);
      useMark = false;
      // The shape is about to change, and the page we just built is the one
      // being replaced. Clear it so the re-render cannot take the cheap path.
      currentShape = "";
      return false;
    }
  }
  return true;
}

/** Where scrolling has got to: 0 is the cue, 1..n the recommendations. */
/**
 * The rail: what an associate glances at while already talking.
 *
 * Chosen from what Kyle actually asked the glasses on the floor tonight —
 * six questions, and three of them were about a size or a colour. So sizes
 * lead, and tier and points follow because they change how you open.
 */
/**
 * The full name when it fits, first name plus an initial when it doesn't.
 *
 * The rail is ten characters wide at the measured row height. "SARAH CHEN" is
 * exactly ten and keeps her surname; "MARCUS WEBB" is eleven and becomes
 * "MARCUS W". What must never happen is the middle case — "MARCUS WEB" reads
 * as a broken display rather than a shortened name, and the surname is the
 * droppable half anyway, since the associate is about to say the first name
 * out loud and the full name is on the guest card when they arrive.
 *
 * Asking `FACT_CHARS` rather than hardcoding ten means this follows the row
 * height and the glyph ratio automatically, instead of becoming another
 * constant that quietly stops being true.
 */
function railName(name?: string): string {
  const full = String(name || "").trim().replace(/\s+/g, " ");
  if (full.length <= FACT_CHARS) return full;
  const parts = full.split(" ");
  if (parts.length < 2) return full;   // one long word — let the rail slice it
  const short = `${parts[0]} ${parts[parts.length - 1][0]}`;
  return short.length <= FACT_CHARS ? short : parts[0];
}

function railFor(payload: DisplayPayload): string[] {
  const g = payload.guest as any;
  if (!g) return [];
  const sizes = g.sizes || {};
  // Name first, then who they are to us, then what fits them. Kyle asked for
  // the customer's name to stay put on the left: it is the one fact he needs
  // continuously and the one the sentence stops showing the moment a voice
  // answer replaces it.
  // TOP/BTM, not TOPS/BOTTOMS. The rail holds about eleven characters at this
  // type size, and "BOTTOMS 28X30" is thirteen — it clipped to "BOTTOMS 28X",
  // losing the inseam, which is the half of that fact worth having. Abbreviate
  // the label and the value survives.
  // Ordered by what survives a short frame, not by importance in the abstract.
  //
  // `FACT_SLOTS` is a fit capacity now, so on a 640x200 surface the rail holds
  // four rows and the last two fall off the end. It used to be the sizes that
  // fell off — which is the half of the rail worth having, and the reason the
  // rail costs the sentence a third of its width in the first place. A rail
  // that drops the sizes is a rail that is not paying for itself.
  //
  // So: who they are, then what fits them, then the things that are merely
  // nice. Points are a number nobody acts on mid-conversation, and unread
  // floor traffic has its own arrival behaviour — an urgent message takes the
  // whole frame rather than waiting politely in row five.
  //
  // Which is also the argument for making points a preference rather than a
  // decision taken for everybody: it is the row with the weakest claim, on the
  // scarcest rows in the product.
  return [
    railName(g.name),
    g.tier || "",
    sizes.tops ? `TOP ${sizes.tops}` : "",
    sizes.bottoms ? `BTM ${sizes.bottoms}` : "",
    prefs.railPoints && typeof g.points === "number" ? `${g.points} PTS` : "",
    // Unread floor traffic, as a sixth rail row. The rail is a single list
    // container with six slots, so this is free: no new container, no
    // page-shape change, no rebuild. That is the whole reason the priority
    // tier fits inside the host's budget at all.
    inbox.length ? `${inbox.length} MSG` : "",
  ].filter(Boolean);
}

/**
 * Put the type ruler on the glass.
 *
 * Deliberately bypasses `renderCue` — no rail, no clock, no mark, nothing
 * that could be mistaken for the row under test. It rebuilds unconditionally
 * because its shape shares no container ids with any cue page, and the cheap
 * path cannot create containers.
 */
/**
 * An urgent message takes the whole frame.
 *
 * Built with no rail on purpose — `renderCue({ facts: [] })` already produces
 * a full-frame three-line page, so the interrupt costs zero new containers.
 * The guest card is not lost: `lastDisplay` still holds it and a press
 * restores it.
 */
async function showUrgent(m: RadioMessage) {
  onUrgent = m;
  await renderCue({
    lines: [toDisplayText(m.from), toDisplayText(m.message), "PRESS TO TAKE IT"],
    facts: [], meta: [], moduleCount: 0,
  });
}

/**
 * A guest request takes the whole frame.
 *
 * Same shape as an urgent message and for the same reason — no rail means no
 * new containers, so the interrupt is free inside the host's budget. The zone
 * leads, because the first thing an associate needs is where to walk.
 */
async function showRequest(r: GuestRequest) {
  onRequest = r;
  await renderCue({
    lines: [
      toDisplayText(r.zone || "FLOOR").toUpperCase(),
      toDisplayText(r.line),
      "PRESS TO TAKE IT",
    ],
    facts: [], meta: [], moduleCount: 0,
  });
}

/** Back to whatever was underneath — the guest card if there is one, idle if
 *  not. Used by every path that ends an interrupt. */
async function restoreFrame() {
  if (engaged && lastDisplay) await renderCue(cueOf(lastDisplay));
  else await showIdle();
}

/**
 * The floor menu: what is waiting, then what you can say back.
 *
 * One screen for both, because they are the same gesture — someone who has
 * just read "need backup in fitting rooms" wants to answer without navigating
 * anywhere. Unread first, newest at the top, then the phrases.
 *
 * Nothing else lives here. The camera briefly did, and it was the wrong
 * surface: aiming a camera is a hands-and-eyes task you cannot finish without
 * the phone, so an affordance in the glass only added a step. It is on the
 * phone page now — see `mountCaptureCard`.
 */
function buildMenuItems() {
  menuItems = [
    ...[...inbox].reverse().map((m) => ({
      label: `${m.from} ${m.message}`, send: "ON MY WAY", msg: m,
    })),
    ...PHRASES.map((p) => ({ label: p.label, send: p.label, urgent: p.urgent })),
  ];
}

async function showFloorMenu(index = 0) {
  buildMenuItems();
  menuIndex = Math.max(0, Math.min(index, menuItems.length - 1));
  onRuler = false;
  const unread = inbox.length;
  const page = buildMenu(
    unread ? `FLOOR · ${unread} WAITING` : "FLOOR",
    menuItems.map((i) => i.label),
    menuIndex,
    { logo: useMark, footer: menuItems[menuIndex]?.msg
        ? "PRESS TO REPLY ON MY WAY · 2X BACK"
        : "PRESS TO SEND · 2X BACK" },
  );
  await paint(page);
}

/** Send whatever the menu cursor is on, then leave. */
async function sendFromMenu() {
  const item = menuItems[menuIndex];
  if (!item) return void showIdle();
  socket?.emit("radio:send", {
    message: item.send ?? item.label,
    priority: item.urgent ? "urgent" : "normal",
    tenant: TENANT,
  });
  log(`radio → ${item.send ?? item.label}`);
  // Replying to a message clears it: it has been dealt with, and an inbox
  // that keeps what you already answered stops being an inbox.
  if (item.msg) inbox = inbox.filter((m) => m !== item.msg);
  menuIndex = -1;
  if (engaged && lastDisplay) await renderCue(cueOf(lastDisplay));
  else await showIdle();
}

/**
 * Push a prebuilt page, handling the mark and the shape bookkeeping the same
 * way `renderCue` does. Extracted because the menu and the ruler are pages
 * that are not cues, and both were otherwise duplicating this.
 */
async function paint(page: ReturnType<typeof buildMenu>) {
  if (!pageBuilt) { await bridge.createStartUpPageContainer(page); pageBuilt = true; }
  else await bridge.rebuildPageContainer(page);
  if (!(await pushMark(page))) {
    // The host refused the image; `useMark` has latched off. Rebuild without.
    return;
  }
  currentShape = "";   // never take the cheap path back out of a non-cue page
}

async function showRuler() {
  onRuler = true;
  const page = buildRuler();
  if (!pageBuilt) { await bridge.createStartUpPageContainer(page); pageBuilt = true; }
  else await bridge.rebuildPageContainer(page);
  currentShape = "";   // force a rebuild on the way back out
  log(`ruler: rows at ${RULER_HEIGHTS.join(", ")}px — which are whole?`);
}

async function showIdle() {
  onRuler = false;
  menuIndex = -1;
  onUrgent = null;
  onRequest = null;
  cards = [];
  cardIndex = 0;
  engaged = false;
  engagedGuestId = null;
  focusSku = null;
  lastDisplay = null;
  railFacts = [];
  forgetSession();
  // The engagement is over, so a zone change that was waiting for it can go.
  flushZoneRegistration();
  await renderCue({
    ...IDLE_CUE,
    lines: ["CUESEA READY", TENANT_LABEL, "AWAITING GUEST SIGNAL"],
    // The build, on the glass. An install that silently did not roll over is
    // indistinguishable from a fix that did not work, and we burned two
    // uploads on exactly that ambiguity.
    // Abbreviated to the bone. The strip holds 31 characters at this row
    // height and the long forms ran to 46, so the exit hint — the one gesture
    // nobody discovers by accident — was what fell off the end. The version
    // stays because an install that silently did not roll over has cost more
    // evenings than any single bug.
    //
    // "PRESS TO ASK" only when a press does ask. With voice switched off the
    // hint is a lie, and the glass naming a gesture that does nothing is worse
    // than the glass saying less — the strip is where an associate learns the
    // two gestures nobody discovers by accident.
    meta: [
      `V${__APP_VERSION__.replace(/\./g, "·")}`,
      ...(prefs.voice ? ["PRESS TO ASK"] : []),
      "2X EXIT",
    ],
  });
  ui.sessionInfo.textContent = "No active session";
}

async function onDisplay(payload: DisplayPayload) {
  engaged = true;
  lastDisplay = payload;
  engagedGuestId = payload.guest?.guest_id ?? engagedGuestId;
  recommendations = payload.recommendations ?? [];
  // Build the stack once per guest, not per render. The whole value of a card
  // stack is that it does not reorder underneath somebody who is scrolling
  // through it looking for the address.
  cards = cardsFor(payload);
  cardIndex = 0;
  railFacts = railFor(payload);
  focusSku = recommendations[0]?.sku ?? focusSku;
  rememberSession();
  await showCard(0);
  ui.sessionInfo.textContent = payload.guest
    ? `Engaged: ${payload.guest.name} (${payload.guest.tier})`
    : "Engaged";
  log(`display ← ${payload.guest?.name ?? "server"} (${payload.lines.length} lines)`);
}

/** Restore whatever was on the lens before a voice interaction took it over. */
async function restoreView() {
  if (!engaged || !lastDisplay) return showIdle();
  if (cardIndex > 0 && cards[cardIndex]) return showCard(cardIndex);
  await renderCue(cueOf(lastDisplay));
}

/** The service writes in glass grammar. `lines` is the flat form kept for the
 *  manager view and older payloads; fall back to it only if `cue` is absent. */
/**
 * Put card `index` on the glass.
 *
 * Scrolling to a PICK also makes it `focusSku`, so an associate can scroll to
 * an item and immediately ask "do we have these in a 32" without naming it.
 * Scrolling to anything else clears it back to the guest's first pick, because
 * "these" pointing at a shipping address is worse than "these" pointing at
 * nothing.
 */
async function showCard(index: number) {
  const card = cards[index];
  if (!card) return;
  cardIndex = index;
  focusSku = card.sku ?? cards.find((c) => c.sku)?.sku ?? null;
  await renderCue({ lines: card.lines, meta: card.meta || [] });
  log(`card ${index + 1}/${cards.length}: ${card.kind}`);
}

async function cycleCards(step: 1 | -1) {
  if (!engaged || cards.length <= 1) return;
  // Wrap. With a stack this long, walking off the end and stopping means an
  // associate scrolling for the address discovers the list has an end rather
  // than a shape — and the cue is one step backwards from the last card,
  // which is where you most often want it.
  const next = (cardIndex + step + cards.length) % cards.length;
  await showCard(next);
}

function onRootPage(): boolean {
  // Root means genuinely nothing on the glass. A saved session counts as not
  // root even before the card comes back: after a foreground transition the
  // resume is in flight for a moment, and a double-tap landing in that window
  // used to quit the app out from under a live engagement.
  let resumable = false;
  try { resumable = !!JSON.parse(sessionStorage.getItem(RESUME_KEY) || "null")?.guestId; }
  catch { resumable = false; }
  // The floor menu, an urgent message, a guest request and the ruler are all
  // pages: a double press on any of them means "back", never "quit the app".
  // Getting this wrong is how double-tap once closed CueSea instead of stopping
  // the mic — and a request is the worst place to get it wrong, because the
  // app would quit while a customer stands in a fitting room waiting.
  //
  // A capture in flight counts too, and it was nearly lost when the trigger
  // moved to the phone: this clause looked like menu scaffolding and is not.
  // The window it guards is real and is the *worst* moment in the flow — the
  // shutter has fired, the round trip is running, and the associate has just
  // looked up at the glass to wait for the answer. A double press there would
  // take down the app holding the photo. Their hand being on the phone makes
  // that less likely than it was, which is not the same as it not happening.
  return !engaged && !resumable && cardIndex === 0 && voice.current === "idle"
    && vision.current === "idle"
    && menuIndex < 0 && !onUrgent && !onRequest && !onRuler;
}

/**
 * Ring and temple gestures → session actions.
 *
 * Both devices drive the same actions; the source is recorded for the event
 * inspector and the log, not branched on. An associate who prefers the temple
 * shouldn't have a different mental model than one wearing the ring.
 */
function onGesture(g: DecodedGesture) {
  log(`gesture: ${describeGesture(g)}`);
  pushInspector(g);
  // Mirrored to the server so a gesture problem can be diagnosed without
  // reading a phone screen over someone's shoulder. Whether a temple double
  // tap arrives as one DOUBLE_CLICK or two CLICKs is not answerable from here.
  socket?.emit("client:gesture", {
    action: g.action, source: g.source, kind: g.kind,
    voice: voice?.current, engaged, cardIndex,
  });
  if (g.source === "ring" && ui.ringStatus) {
    ui.ringStatus.textContent = "ring active";
    ui.ringStatus.className = "pill live";
  }

  switch (g.action) {
    case "click":
      // An urgent message owns the frame until it is acknowledged. Taking it
      // replies and restores whatever was underneath.
      if (onUrgent) {
        socket?.emit("radio:send", { message: "ON MY WAY", tenant: TENANT });
        log(`radio → ON MY WAY (to ${onUrgent.from})`);
        onUrgent = null;
        void restoreFrame();
        return;
      }
      // Taking a guest request. The claim is settled server-side — the frame
      // clears here on the optimistic assumption it worked, and `request:taken`
      // is what actually decides. Waiting for the round trip would leave an
      // associate pressing a button that appears to do nothing.
      if (onRequest) {
        socket?.emit("request:claim", { requestId: onRequest.request_id });
        log(`request → taking ${onRequest.line}`);
        onRequest = null;
        void restoreFrame();
        return;
      }
      // In the floor menu, a press sends what the cursor is on.
      if (menuIndex >= 0) { void sendFromMenu(); return; }
      // The ruler is a dead end by design: it eats one press to leave, so
      // nobody can start a voice query from a diagnostic screen by accident.
      if (onRuler) { onRuler = false; void showIdle(); return; }
      // A click first dismisses whatever voice put on the lens; only then does
      // it mean "I'm done with this guest".
      if (voice.dismiss()) return;
      // Same for a scan's progress or its answer. It cannot recall a camera
      // the phone has already opened — but it can stop the answer from waiting
      // out its dwell, which is what a press means everywhere else.
      if (vision.dismiss()) return;
      // Kyle's rule: press takes you home from anywhere, and only ends the
      // engagement once you are already home. Learnable in a shift, and it
      // means you can never end a live session by accident from card seven —
      // which is the mistake that happens in front of a customer.
      if (cardIndex > 0) { void showCard(0); return; }
      if (engaged) {
        socket.emit("session:end");
        void showIdle();
        return;
      }
      // Nothing engaged: press is how you ask a question from the idle screen,
      // because double-press is spoken for there. See onRootPage() below.
      // Unless voice is switched off, in which case a press at idle does
      // nothing at all — the idle strip has already stopped offering it.
      if (!prefs.voice) return;
      void voice.toggle({ tenant: TENANT, guestId: null, focusSku: null });
      return;

    case "double-click":
      // Even Hub requires the root page's double-tap to raise the *system*
      // exit dialog — shutDownPageContainer(1). Reviewers check it explicitly
      // and reject apps that exit silently, exit with mode 0, or substitute
      // their own confirmation UI. There is only ever one page container, so
      // "root page" is ours to define: it is the idle screen, and anything
      // with a guest on it counts as an internal page.
      //
      // That costs us double-press-to-talk at idle, which is why a plain press
      // means "ask" there instead.
      // Backing out of the floor menu, not exiting the app. `onRootPage()`
      // already excludes it, but saying so here keeps the two readings of
      // "double press" next to each other.
      if (menuIndex >= 0) {
        menuIndex = -1;
        if (engaged && lastDisplay) void renderCue(cueOf(lastDisplay));
        else void showIdle();
        return;
      }
      if (onRootPage()) {
        void bridge.shutDownPageContainer(1);
        return;
      }
      // With voice off there is nothing left for a double press to mean here.
      // It must not fall through to the exit dialog: this is not the root page,
      // and quitting the app in front of a customer because the mic is off
      // would be the worst possible reading of the gesture.
      if (!prefs.voice) return;
      void voice.toggle({ tenant: TENANT, guestId: engagedGuestId, focusSku });
      return;

    case "foreground-enter":
      // Back from the background. Anything we knew is gone with the WebView,
      // so ask the server to rebuild the card we were on.
      if (!engaged) resumeSession();
      return;

    case "foreground-exit":
      // Nothing to do, but do not fall through to the default and log it as
      // unhandled — it is expected, not a surprise.
      //
      // An open question, and deliberately left open. A later edit added
      // `foreground-exit` to the `exit` case below so backgrounding would end
      // the session — unreachable, because this case catches it first, which
      // is how it survived two releases without anyone noticing it did
      // nothing. The compiler finally said so.
      //
      // Ending the session here is only right if the host backgrounds the
      // WebView when the *phone* goes away. If it also backgrounds it during
      // ordinary glasses use, this would end a session every time an
      // associate put their phone in their pocket mid-conversation — the
      // failure that matters, versus a phantom "engaged" row on the manager
      // dashboard, which is the one we have. The locked-phone test answers
      // it; until it has been run, the cheaper mistake stays.
      return;

    case "scroll-up":
      if (menuIndex >= 0) { void showFloorMenu(menuIndex - 1); return; }
      // Scrolling up at idle has never done anything — there is no carousel
      // until a guest arrives. So it is where the type ruler lives: the one
      // screen that answers, on the hardware, how small this display will
      // actually draw a row. See buildRuler() in layout.ts.
      if (!engaged && voice.current === "idle") { void showRuler(); return; }
      void cycleCards(-1);
      return;

    case "scroll-down":
      if (menuIndex >= 0) { void showFloorMenu(menuIndex + 1); return; }
      // Down opens the floor: what is waiting, and what you can say back.
      // Available engaged as well as idle — the whole point of a queue is
      // that you read it when you choose, and mid-engagement is exactly when
      // "covering your guest" needs answering.
      if (voice.current === "idle" && !onRuler) { void showFloorMenu(); return; }
      void cycleCards(1);
      return;

    case "exit":
      // The OS is taking the page away; drop the session cleanly rather than
      // leaving an associate "engaged" on the manager dashboard forever.
      if (engaged) socket.emit("session:end");
      return;

    default:
      return;
  }
}

/**
 * Raw event inspector.
 *
 * The decoder is written from the SDK's protobuf enums rather than from
 * observed hardware, so the one thing that matters on a real device is
 * seeing anything it *didn't* understand. Every event lands here with its
 * decode result and its raw payload.
 */
function pushInspector(g: DecodedGesture | undefined, raw?: unknown) {
  if (!ui.inspector) return;
  const row = document.createElement("div");
  row.className = g ? "insp ok" : "insp unknown";
  const head = g ? `${g.action} · ${g.source} · ${g.kind}` : "UNDECODED";
  row.textContent = `${new Date().toLocaleTimeString()}  ${head}\n${JSON.stringify(
    g?.raw ?? raw,
  )}`;
  ui.inspector.prepend(row);
  while (ui.inspector.childElementCount > 25) ui.inspector.lastElementChild?.remove();
}

// ---------------------------------------------------------------------------
// Preferences — the associate's half of this page.
// ---------------------------------------------------------------------------

/**
 * Put a changed preference into effect.
 *
 * Called only after the write succeeded. A setting that is in force but not
 * stored would be back to its old value on the next foreground transition, and
 * an associate who watched the glass change has no reason to check again.
 */
function applyPrefEffect(key: PrefKey) {
  switch (key) {
    case "zone":
      applyZone();
      return;
    case "railPoints":
      refreshRail();
      return;
    case "voice":
      // Switching voice off closes anything the mic already had open, rather
      // than leaving a level meter on the glass that no gesture can now clear.
      if (!prefs.voice) voice.dismiss();
      updateVoicePill();
      // The idle strip names the gestures, and one of them just stopped
      // existing. Only redraw when idle owns the frame.
      if (!engaged && !onUrgent && !onRequest && menuIndex < 0 && !onRuler
          && voice.current === "idle" && vision.current === "idle") {
        void showIdle();
      }
      return;
    case "floorComms":
      // Nothing to redraw: it decides what the *next* message does. Anything
      // already on the glass was put there under the old setting and an
      // associate reading an urgent message does not want it pulled away.
      return;
  }
}

/**
 * The zone reaches the server on `register`, and nowhere else that is safe to
 * repeat. See `zoneRegisterPending` — mid-engagement the re-register waits,
 * because rebuilding the associate record would report a busy associate as
 * available on the manager dashboard.
 */
function applyZone() {
  if (!socket?.connected) return;   // the connect handler sends the current zone
  if (engaged) {
    zoneRegisterPending = true;
    log(`zone → ${prefs.zone} (registering when this engagement ends)`);
    return;
  }
  registerAssociate();
  log(`zone → ${prefs.zone}`);
}

function flushZoneRegistration() {
  if (!zoneRegisterPending) return;
  zoneRegisterPending = false;
  if (socket?.connected) {
    registerAssociate();
    log(`zone → ${prefs.zone}`);
  }
}

/** Rebuild the rail from the guest we are on, and repaint whatever the
 *  associate is currently looking at — not the cue, if they scrolled away. */
function refreshRail() {
  if (!engaged || !lastDisplay) return;
  railFacts = railFor(lastDisplay);
  rebuildNext();
  if (onUrgent || onRequest || menuIndex >= 0 || onRuler) return;
  if (voice.current !== "idle" || vision.current !== "idle") return;
  void restoreView();
}

function updateVoicePill() {
  if (voice?.current !== "idle" || vision?.current !== "idle") return;
  ui.voiceStatus.textContent = prefs.voice ? "voice ready" : "voice off";
  ui.voiceStatus.className = "pill";
}

/** What the machine says about the last write. Mono, because it is the machine
 *  speaking, and `role="status"` so it is announced without stealing focus. */
function prefStatus(message: string, failed = false) {
  const el = document.getElementById("prefs-state");
  if (!el) return;
  el.textContent = message;
  el.className = failed ? "pref-state failed" : "pref-state";
}

/**
 * Write one preference and, only if the phone took it, put it into effect.
 *
 * `setLocalStorage` answers a boolean and this is where it is honoured. On a
 * refusal the control is put back where it was and the card says so: a toggle
 * that stays flipped after a failed write is a setting an associate believes
 * they have, and they will not find out otherwise until the shift where the
 * glasses behave the way they thought they had changed.
 */
async function setPref<K extends PrefKey>(
  key: K, value: Prefs[K], label: string, revert: () => void,
): Promise<boolean> {
  prefStatus(`SAVING ${label}`);
  const ok = await savePref(bridge, key, value);
  if (!ok) {
    revert();
    prefStatus(`NOT SAVED · ${label} · THE PHONE REFUSED THE WRITE`, true);
    log(`preference ${key} was refused by the phone — not saved, not applied`);
    return false;
  }
  (stored as any)[key] = value;
  prefs = effectivePrefs(stored, capabilities, TENANT);
  applyPrefEffect(key);
  prefStatus(`SAVED · ${label}`);
  log(`preference ${key} = ${String(value)}`);
  return true;
}

/** Label above a control, and the sentence under it. Sans: a person wrote it. */
function prefRow(title: string, note: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "pref";
  const h = document.createElement("div");
  h.className = "pref-label";
  h.textContent = title;
  const p = document.createElement("p");
  p.className = "pref-note";
  p.textContent = note;
  row.append(h, p);
  return row;
}

/** A two-state control. `role="switch"` rather than a checkbox: the state word
 *  is read out and is visible, which a styled checkbox loses. */
function switchControl(
  key: "voice" | "railPoints", label: string, initial: boolean,
): HTMLElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "pref-switch";
  b.setAttribute("role", "switch");
  const paint = (on: boolean) => {
    b.setAttribute("aria-checked", String(on));
    b.dataset.on = on ? "1" : "0";
    b.textContent = on ? "ON" : "OFF";
  };
  paint(initial);
  b.addEventListener("click", () => {
    const was = b.dataset.on === "1";
    const next = !was;
    paint(next);                       // flip now; put back if the write fails
    void setPref(key, next, label, () => paint(was));
  });
  return b;
}

/** Three exclusive options, as one row of 44px targets. */
function segmentedControl(
  options: { value: FloorComms; label: string }[], initial: FloorComms, label: string,
): HTMLElement {
  const group = document.createElement("div");
  group.className = "pref-seg";
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", label);
  const buttons: HTMLButtonElement[] = [];
  const paint = (value: FloorComms) => {
    buttons.forEach((b) => {
      const on = b.dataset.value === value;
      b.setAttribute("aria-checked", String(on));
      b.dataset.on = on ? "1" : "0";
    });
  };
  options.forEach((o) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pref-seg-item";
    b.setAttribute("role", "radio");
    b.dataset.value = o.value;
    b.textContent = o.label;
    b.addEventListener("click", () => {
      const was = (buttons.find((x) => x.dataset.on === "1")?.dataset.value
        || "everything") as FloorComms;
      if (was === o.value) return;
      paint(o.value);
      void setPref("floorComms", o.value, label, () => paint(was));
    });
    buttons.push(b);
    group.appendChild(b);
  });
  paint(initial);
  return group;
}

/**
 * The preferences card.
 *
 * Built rather than written into `index.html` for the same reason the capture
 * card is: which controls exist is a question about what the store permits, and
 * a control that exists in the document is a control a stylesheet failure can
 * reveal. `visiblePrefs` answers it, and a preference whose capability is false
 * is simply never constructed.
 *
 * Mounted once the capability answer is in, like the capture card, so nothing
 * moves under a finger a second after the page opens.
 */
function mountPrefsCard(caps: Capabilities) {
  const mount = document.getElementById("prefs-mount");
  if (!mount) return;
  mount.replaceChildren();

  const card = document.createElement("section");
  card.className = "card prefs";
  const title = document.createElement("h3");
  title.textContent = "Your settings";
  card.appendChild(title);

  const visible = visiblePrefs(caps);

  if (visible.includes("zone")) {
    const row = prefRow("Zone", "The part of the floor you're working. It rides with every guest you're cued on.");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "pref-input";
    input.id = "pref-zone";
    input.value = stored.zone;
    input.maxLength = MAX_ZONE_CHARS;
    input.autocomplete = "off";
    input.setAttribute("aria-label", "Zone");
    let last = stored.zone;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const commit = () => {
      if (debounce) { clearTimeout(debounce); debounce = null; }
      const next = normaliseZone(input.value, TENANT);
      // Normalising can rewrite what they typed — an empty box is the tenant
      // default, not an empty zone, and the server would read "" as "Floor".
      if (input.value !== next) input.value = next;
      if (next === last) return;
      const was = last;
      last = next;
      void setPref("zone", next, "ZONE", () => {
        last = was;
        input.value = was;
      });
    };
    // No Save button anywhere on this card. Typing saves once the associate
    // stops — a phone keyboard has no reliable "done", and a zone that needed
    // one is a zone half the floor would be wrong about.
    input.addEventListener("input", () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(commit, 700);
    });
    input.addEventListener("change", commit);
    input.addEventListener("blur", commit);
    row.appendChild(input);
    card.appendChild(row);
  }

  if (visible.includes("floorComms")) {
    const row = prefRow("Floor messages",
      "Urgent messages always take the glass. Everything else waits behind the unread count — nothing is dropped.");
    row.appendChild(segmentedControl(
      [
        { value: "everything", label: "Everything" },
        { value: "urgent", label: "Urgent only" },
        { value: "off", label: "Off" },
      ],
      stored.floorComms,
      "FLOOR MESSAGES",
    ));
    card.appendChild(row);
  }

  if (visible.includes("voice")) {
    const row = prefRow("Voice", "A press opens the mic so you can ask a question hands-free.");
    row.appendChild(switchControl("voice", "VOICE", stored.voice));
    row.classList.add("pref-inline");
    card.appendChild(row);
  }

  if (visible.includes("railPoints")) {
    const row = prefRow("Points on the rail",
      "The loyalty points row on the left of the glass. Turn it off to free a row for a size.");
    row.appendChild(switchControl("railPoints", "POINTS", stored.railPoints));
    row.classList.add("pref-inline");
    card.appendChild(row);
  }

  const state = document.createElement("div");
  state.className = "pref-state";
  state.id = "prefs-state";
  state.setAttribute("role", "status");
  state.textContent = "SAVED ON THIS PHONE AS YOU CHANGE THEM";
  card.appendChild(state);

  mount.appendChild(card);
}

/**
 * The capture card — the phone-page trigger for a scan.
 *
 * **Built only when the store has the camera on, and not built at all
 * otherwise.** The card is constructed here rather than sitting in
 * `index.html` behind a `hidden` attribute for one reason: a control that
 * exists in the document is a control a stylesheet failure, a devtools poke or
 * a future refactor can reveal. `captureControls` returns an empty list for a
 * tenant with the camera off, for a fetch that timed out and for a body that
 * came back malformed — all three produce the same page, one with no camera
 * control on it.
 *
 * The trigger is here and the readout is in the glass, on purpose. Framing a
 * swing tag is a hands-and-eyes job you cannot finish without the phone, so
 * eyes go down to shoot; the answer goes up to the lens, where it can be read
 * while still facing the customer. Nothing renders the answer to this page
 * except the virtual lens, which is the glass in dev and not a second display.
 */
function mountCaptureCard(caps: Capabilities) {
  const mount = document.getElementById("capture-mount");
  if (!mount) return;
  mount.replaceChildren();
  const controls = captureControls(caps);
  if (!controls.length) return;

  const card = document.createElement("section");
  card.className = "card capture";

  const title = document.createElement("h3");
  title.textContent = "Camera";
  card.appendChild(title);

  // Sans: a person wrote this sentence, and it is the one thing on the card
  // that says where the answer will appear.
  const blurb = document.createElement("p");
  blurb.className = "capture-note";
  blurb.textContent =
    "Photograph a product tag or a part. The answer appears in the glasses — " +
    "look down to shoot, up to read it.";
  card.appendChild(blurb);

  const row = document.createElement("div");
  row.className = "capture-row";
  controls.forEach((c, i) => {
    const b = document.createElement("button");
    b.type = "button";
    // Sea for the primary control; the second is a hairline ghost. Two filled
    // buttons side by side say neither one is the usual answer, and reading a
    // tag is what an associate does twenty times a shift.
    b.className = i === 0 ? "btn btn-primary" : "btn btn-ghost";
    b.textContent = c.label;
    b.addEventListener("click", () => void startCapture(c.kind));
    row.appendChild(b);
  });
  card.appendChild(row);

  // What the machine is doing, in the machine's face. `role="status"` so a
  // screen reader hears the stage change without the focus moving.
  const state = document.createElement("div");
  state.className = "capture-state";
  state.id = "capture-state";
  state.setAttribute("role", "status");
  state.textContent = CAPTURE_STATE.idle;
  card.appendChild(state);

  mount.appendChild(card);
}

/** The stage, said on the phone in the same words the glass is using. */
const CAPTURE_STATE: Record<VisionState, string> = {
  idle: "READY",
  capturing: "CAMERA OPEN",
  analysing: "READING · WATCH THE GLASSES",
  answering: "ANSWER IN THE GLASSES",
};

function captureState(state: VisionState) {
  const el = document.getElementById("capture-state");
  if (el) el.textContent = CAPTURE_STATE[state];
}

/**
 * Start a scan from the phone.
 *
 * Voice is ended first. The two used to be mutually exclusive by structure —
 * the floor menu only opened while voice was idle — and moving the trigger to
 * a button that is always tappable removes that guarantee. Two controllers
 * repainting the same three lines on their own timers is a glass that flickers
 * between a level meter and a camera prompt, which is worse than either.
 */
async function startCapture(kind: VisionKind) {
  voice.dismiss();
  await vision.scan(kind);
}

async function main() {
  bridge = await getBridge();
  ui.bridgeStatus.textContent =
    bridge.kind === "even-app" ? "Even App bridge (native)" : "Mock bridge (virtual lens)";
  ui.bridgeStatus.className = bridge.kind === "even-app" ? "pill ok" : "pill dev";

  const user = (await bridge.getUserInfo()) ?? {};
  // Attribution rides on this. If the Even App won't tell us, everything
  // still works — it just lands unattributed, and the console says so.
  const device = (await bridge.getDeviceInfo()) ?? {};

  // Preferences before the socket, so the very first `register` carries this
  // associate's zone rather than the tenant's default and then corrects itself.
  // A store that cannot be read is an associate on defaults — the page they had
  // before any of this existed.
  stored = await loadPrefs(bridge, TENANT);
  prefs = effectivePrefs(stored, null, TENANT);
  log(`preferences: zone=${prefs.zone} comms=${prefs.floorComms} ` +
      `voice=${prefs.voice ? "on" : "off"} points=${prefs.railPoints ? "on" : "off"}`);

  voice = new VoiceController({
    bridge,
    emit: (event, payload) => socket?.emit(event, payload),
    render: (lines, meta) => renderCue({ lines, meta }),
    log,
    onState: (state: VoiceState) => {
      ui.voiceStatus.textContent =
        state !== "idle" ? `voice: ${state}` : prefs.voice ? "voice ready" : "voice off";
      ui.voiceStatus.className =
        state === "listening" ? "pill live" : state === "idle" ? "pill" : "pill dev";
    },
    onDone: () => void restoreView(),
  });

  // Started here and awaited after the HUD is up: the capability answer is
  // only needed by the time the capture card would be built, and blocking the
  // first frame on a store's network would trade a visible HUD for a flag.
  const capabilitiesReady = fetchCapabilities(SERVER_URL, TENANT);

  vision = new VisionController({
    bridge,
    serverUrl: SERVER_URL,
    tenant: TENANT,
    render: (lines, meta) => renderCue({ lines, meta }),
    log,
    // Shares the voice pill on the phone page rather than adding a second one:
    // the two are never in flight at once (`startCapture` ends a voice
    // interaction before it opens the camera), and one row that says what the
    // glasses are doing beats two rows that each say nothing most of the time.
    // On the way back to idle it defers to voice rather than asserting "ready"
    // over it. The capture card carries the same state in its own words.
    onState: (state: VisionState) => {
      captureState(state);
      if (state === "idle") {
        if (voice.current !== "idle") return;
        ui.voiceStatus.textContent = prefs.voice ? "voice ready" : "voice off";
        ui.voiceStatus.className = "pill";
        return;
      }
      ui.voiceStatus.textContent = `scan: ${state}`;
      ui.voiceStatus.className = "pill dev";
    },
    onDone: () => void restoreView(),
  });

  bridge.onEvenHubEvent((event: any) => {
    if (event?.audioEvent) return voice.onAudioChunk(event.audioEvent.audioPcm);

    const gesture = decodeGesture(event);
    if (gesture) return onGesture(gesture);

    // Not a gesture we recognise. IMU reports are expected noise; anything
    // else is exactly what the inspector exists to surface.
    if (event?.sysEvent?.imuData) return;
    pushInspector(undefined, event);
  });

  socket = io(SERVER_URL);
  // Extracted so a zone change can send it again. `register` is the only
  // message that carries the zone to the roster, and the server rebuilds the
  // associate record from it — see `applyZone`.
  registerAssociate = () => {
    socket.emit("register", {
      role: "associate",
      appVersion: __APP_VERSION__,
      // The tenant decides which floor's radio and roster this pair of glasses
      // joins, so it is sent at register rather than waiting for the first
      // guest. An associate who never engages anyone still belongs to a store.
      tenant: TENANT,
      name: `${(user as any).name || "G2 Associate"} [${TENANT}]`,
      zone: prefs.zone,
      deviceSerial: (device as any).sn || null,
      deviceModel: (device as any).model || null,
    });
  };
  socket.on("connect", () => {
    ui.serverStatus.textContent = "Realtime linked";
    ui.serverStatus.className = "pill ok";
    // A reconnect re-registers with whatever the zone is *now*, not with the
    // one this page booted on.
    registerAssociate();
    zoneRegisterPending = false;
  });
  socket.on("disconnect", () => {
    ui.serverStatus.textContent = "Server offline";
    ui.serverStatus.className = "pill warn";
  });
  socket.on("glasses:display", (payload: DisplayPayload) => void onDisplay(payload));
  socket.on("voice:result", (result: VoiceResult) => void voice.onResult(result));
  socket.on("voice:state", (s: { state: string }) => log(`voice state ← ${s.state}`));
  socket.on("request:new", (r: GuestRequest) => {
    log(`request ← ${r.zone || "floor"}: ${r.line}`);
    void showRequest(r);
  });

  socket.on("request:taken", ({ requestId, by }: { requestId?: string; by?: string }) => {
    // Somebody else got there first — or the claim failed. Either way the
    // frame must stop offering it, and only if it is the one being shown:
    // clearing on any request would wipe a different one that just landed.
    if (!onRequest || onRequest.request_id !== requestId) return;
    log(`request ← taken${by ? ` by ${by}` : ""}`);
    onRequest = null;
    void restoreFrame();
  });

  socket.on("request:cleared", () => {
    // The guest withdrew. Nobody should walk anywhere.
    if (!onRequest) return;
    log("request ← guest cancelled");
    onRequest = null;
    void restoreFrame();
  });

  socket.on("radio:message", (m: RadioMessage) => {
    // Our own message, echoed back so the dashboard and the web harness get
    // the full log. Nobody needs to read on their own glass the thing they
    // just sent.
    if (m.fromId && m.fromId === socket.id) return;
    log(`radio ← ${m.from}: ${m.message}${m.priority === "urgent" ? " (urgent)" : ""}`);

    // How much of this is allowed to interrupt is the associate's to decide.
    // What is never theirs to lose is the message itself: every priority at
    // every setting still lands in the inbox, so "do not interrupt me" cannot
    // quietly become "do not tell me somebody needs backup".
    if (m.priority === "urgent" && prefs.floorComms !== "off") {
      // Takes the frame, engaged or not. This is the tier's whole purpose:
      // "need backup in fitting rooms" that waits until someone next looks at
      // a menu is a message that did not arrive.
      void showUrgent(m);
      return;
    }

    inbox.push(m);
    if (inbox.length > 20) inbox.shift();
    if (engaged) {
      // Do not touch the frame. The rail picks up the unread count on its
      // next render, and the associate reads it when they choose.
      if (lastDisplay) { railFacts = railFor(lastDisplay); rebuildNext(); void renderCue(cueOf(lastDisplay)); }
    } else if (prefs.floorComms === "everything") {
      void showFloorMenu();
    }
    // At "urgent only" and "off" an ordinary message never opens anything. It
    // waits behind the unread count — on the rail while engaged, in the menu
    // title when the associate scrolls down to it, which they can do at any
    // time. That is the whole difference between queueing and losing.
  });

  await showIdle();

  capabilities = await capabilitiesReady;
  // Logged as what it is — a gate, and which way it fell. When the capture
  // card is missing from the page this line is the only thing that says
  // whether the store turned it off or the fetch never answered.
  log(`capabilities: camera=${capabilities.camera_capture ? "on" : "off"} ` +
      `voice=${capabilities.voice} floor=${capabilities.floor_comms}`);
  mountCaptureCard(capabilities);

  // Now that the store has answered, anything it does not permit falls back to
  // its default and its control is never built. The two unenforced capabilities
  // are why this resolves to the *default* rather than to off: see prefs.ts.
  const wasVoice = prefs.voice;
  prefs = effectivePrefs(stored, capabilities, TENANT);
  mountPrefsCard(capabilities);
  updateVoicePill();
  // A stored preference the store does not permit was in force for the length
  // of the capability fetch, so the glass may be offering a gesture that has
  // just stopped existing. Voice is the only one of the two that shows on the
  // glass, and idle is the only screen that names it.
  if (wasVoice !== prefs.voice && !engaged) await showIdle();

  // Tenant badge on the phone page
  const badge = document.getElementById("tenant-badge");
  if (badge) {
    badge.textContent = TENANT_LABEL;
    badge.className = TENANT === "shopify" ? "pill live" : "pill dev";
  }

  // Beacon roster: fetched live for this tenant (demo guests for gap,
  // real store customers for shopify).
  const rosterEl = document.getElementById("beacon-roster");
  if (rosterEl) {
    try {
      const res = await fetch(`${SERVER_URL}/api/guests?tenant=${TENANT}`);
      if (!res.ok) throw new Error(`${res.status}`);
      const guests: { guest_id: string; name: string; loyalty_tier: string }[] =
        await res.json();
      rosterEl.innerHTML = "";
      guests.slice(0, 8).forEach((g) => {
        const b = document.createElement("button");
        b.textContent = `${g.name} · ${g.loyalty_tier}`;
        b.addEventListener("click", () => {
          socket.emit("beacon:guest-enter", { guestId: g.guest_id, zone: prefs.zone, tenant: TENANT });
          log(`beacon → ${g.name}`);
        });
        rosterEl.appendChild(b);
      });
    } catch (e) {
      rosterEl.innerHTML = `<span style="color:#f59e0b;font-size:12px">Roster unavailable (${String(e)}). Is the '${TENANT}' tenant configured on the server?</span>`;
    }
  }
}

void main();
