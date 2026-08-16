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
import { buildCue, buildMenu, buildRuler, clockLabel, CUE_LINES, FACT_PX, IDLE_CUE,
         RULER_HEIGHTS, toDisplayText, type Cue, type MicState } from "./layout";
import { fitsPx } from "./text";
import { allLines, cardsFor, cueOf, money, type Card, type DisplayPayload,
         type Recommendation } from "./cards";
import { heroClock, heroRail } from "./hero";
import { markBytes } from "./mark";
import { VoiceController, type VoiceResult, type VoiceState } from "./voice";
import { captureControls, fetchCapabilities, NO_CAPABILITIES, VisionController,
         type Capabilities, type VisionKind, type VisionState } from "./vision";
import { defaultPrefs, effectivePrefs, loadPrefs, normaliseZone, savePref,
         visiblePrefs, MAX_ZONE_CHARS, type FloorComms, type PrefKey,
         type Prefs } from "./prefs";
import { ShiftController, TELEMETRY_NOTICE } from "./shift";

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

/**
 * Tenant = which retail world this launch belongs to.
 *
 * Resolution order: the launch URL, then the phone's own stored choice, then
 * the demo. The stored choice is the fix for the bug that made camera capture
 * look broken for a month: **Even Hub gives no way to put a query parameter
 * on the launch URL**, so on a real phone the tenant was always `gap` — and
 * a store whose live slug is `cuesea` read as a store with the camera
 * switched off. The selector card writes the choice and reloads; see
 * `mountTenantCard`.
 */
const TENANT_KEY = "cue.tenant";
const KNOWN_TENANTS: { slug: string; label: string }[] = [
  { slug: "gap", label: "GAP · DEMO" },
  { slug: "cuesea", label: "CUESEA · LIVE" },
  { slug: "shopify", label: "FUTURE BASICS · LIVE" },
];
let TENANT =
  new URLSearchParams(window.location.search).get("tenant")?.toLowerCase()
  || (() => { try { return window.localStorage.getItem(TENANT_KEY) || ""; } catch { return ""; } })()
  || "gap";
let TENANT_LABEL =
  KNOWN_TENANTS.find((t) => t.slug === TENANT)?.label || `${TENANT.toUpperCase()} · LIVE`;

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
  whoName: document.getElementById("whoami-name"),
  whoMeta: document.getElementById("whoami-meta"),
  whoTenant: document.getElementById("whoami-tenant"),
  whoTelemetry: document.getElementById("whoami-telemetry"),
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
/**
 * Shift boundaries, glasses battery, and the offline buffer.
 *
 * Constructed unconditionally so nothing has to null-check it, and never
 * *opened* unless the tenant's `shift_telemetry` capability came back true.
 * A controller that exists but has been told nothing sends nothing — the same
 * shape as the capture card, where the gate decides whether the thing is ever
 * asked to do anything rather than whether it exists.
 */
let shift: ShiftController;
/** Whether this store measures its staff. Read once, after the capability
 *  answer arrives, and used to decide what is sent and what the page says. */
let telemetryOn = false;
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
/**
 * Whether to draw the left column as the hero rail — garment icons and the
 * guest's sizes in dot type — instead of text rows.
 *
 * Same latch discipline as `useMark`, same reason: the first non-`success`
 * from the host turns it off for the life of the app and the next render
 * builds the text rail, so the failure mode is the 0.2.0 lens rather than an
 * empty box where the sizes should be.
 */
let useHeroRail = true;
/** What pixels each drawn image container currently shows, as comparable
 *  keys — pushed again whenever the values change or a rebuild wipes the
 *  container. Cleared by every build; pixels never survive one. */
const imagesShown = new Map<string, string>();
/** Which value the shirt slot is showing: 0 = tops, 1 = outerwear. The
 *  associate cycles this by scrolling on the focused SIZES card. */
let railVariant = 0;
/** Glasses battery, from the host's own status push. Null until it says. */
let battery: number | null = null;
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
  /** Set when the message was addressed rather than broadcast — the socket id
   *  it was sent to, and that person's name. */
  to?: string; toName?: string;
};
let inbox: RadioMessage[] = [];

/**
 * This lens's own roster id, handed back at register.
 *
 * Needed to answer one question: was that message sent to *me*, or to the
 * room? Both arrive on the same event, which is the point of the design —
 * one channel with addressing — so the distinction has to be drawn here.
 */
let myRosterId: string | null = null;

/**
 * Every id this lens has had, not just the current one.
 *
 * A socket id changes on every reconnect, and shop wifi reconnects. Messages
 * already sitting in the inbox carry the id they were addressed to — so with
 * only the newest id, a drop mid-shift would quietly un-mark every message
 * somebody had sent *you*, and a reply to one would go to the whole floor
 * instead of back to the person who asked. Cheap to keep; the alternative is
 * a silent wrong answer at the worst moment.
 */
const myRosterIds = new Set<string>();

/** Who else is on the floor. Pushed on every membership change; used by the
 *  phone's composer, never drawn on the glass. */
let roster: { id: string; name: string; zone?: string }[] = [];

/** Was this message addressed to the person wearing these glasses — under any
 *  id this lens has held this session? */
function addressedToMe(m: RadioMessage): boolean {
  return Boolean(m.to && myRosterIds.has(m.to));
}

/** Remember an id as ours. Called wherever the server tells us one. */
function claimRosterId(id: string | null | undefined) {
  if (!id) return;
  myRosterId = id;
  myRosterIds.add(id);
}

/**
 * The mark that says a message is for you and not for the room.
 *
 * `→` is in the derived glass charset (see text.ts), so this survives
 * `toDisplayText` rather than being replaced by a space.
 */
const ADDRESSED_MARK = "→ YOU";

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
 * part that must survive truncation in a narrow box. A clipped product name
 * still names the jean. A clipped size is a wrong answer.
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
 * Written short enough for the narrowest row any of them can land in. Not to a
 * character count: the font is proportional and the glass does the fitting
 * against the real box. The vocabulary is a real product decision and should
 * come from watching a floor; this is the starting guess from
 * `claude/floor-comms.md`.
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
/**
 * Clicked into the card, or browsing the deck.
 *
 * The deck has two levels now, and one gesture moves between them: a press
 * enters the card under the cursor, a press inside leaves it. Focused, the
 * frame's border thickens and scrolling moves the card's *content* — the
 * fourth cart item, the older orders — instead of the deck. Unfocused,
 * scrolling is the deck, exactly as it always was.
 */
let cardFocus = false;
/** Where the focused card's window starts. */
let cardScroll = 0;

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
/** The guest's name, for its own row above the rail. */
let railGuestName = "";

/**
 * What the hero rail's two slots show for the current guest.
 *
 * The shirt slot is tops — or outerwear, when the associate has cycled the
 * rail from the focused SIZES card. The trousers slot is bottoms, always;
 * there is nothing else trousers-shaped to switch to.
 */
function heroValues(): [string, string] {
  const sizes = (lastDisplay?.guest as any)?.sizes || {};
  const shirt = railVariant === 1 && sizes.outerwear ? sizes.outerwear : sizes.tops;
  return [String(shirt || ""), String(sizes.bottoms || "")];
}

/** The hero's stat band — the figure under the sizes, Weather-dashboard
 *  style. Points, respecting the same preference the text rail honours;
 *  empty leaves the band dark. */
function heroStat(): string {
  const g = lastDisplay?.guest as any;
  return prefs.railPoints && typeof g?.points === "number" ? `${g.points} PTS` : "";
}

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

/**
 * Whether the glass should show the mic as open, closed, or not there at all.
 *
 * There was no answer to "is the mic open" anywhere on the display. The level
 * meter said so while it was the thing on the glass, and stopped saying so the
 * moment an answer, a card or a guest cue replaced it — which is exactly when
 * an associate standing in front of a customer would want to know. It is one
 * glyph in the header now; see `headerStatus` in layout.ts.
 *
 * "off" is voice switched off in preferences or declined by the store, and it
 * draws nothing. A state light for a feature that does not exist is a lie, and
 * the idle strip has already stopped offering the gesture in that case.
 */
function micState(): MicState {
  if (!prefs.voice) return "off";
  return voice?.current === "listening" ? "open" : "closed";
}

/** Render a cue. `status` is gone: the glass shows nothing it doesn't have to,
 *  and a hint row is chrome. */
async function renderCue(cue: Cue, latencyMs?: number) {
  // Every surface — guest card, recommendation, voice answer — gets the rail
  // and the header state from here, rather than each call site remembering.
  //
  // A cue that says nothing about its left column gets the guest's: name row,
  // hero if the host takes images, text facts if not. A cue that *sets*
  // `facts` — the urgent interrupt, a guest request, idle — is asking for
  // exactly that column and nothing is added to it.
  const defaultRail = cue.facts === undefined && cue.name === undefined;
  const [heroTop, heroBtm] = heroValues();
  const wantHero = useHeroRail && Boolean(heroTop || heroBtm);
  const page = buildCue(
    {
      ...cue,
      logo: useMark,
      mic: cue.mic ?? micState(),
      unread: cue.unread ?? inbox.length,
      battery: cue.battery ?? battery,
      ...(defaultRail
        ? { name: railGuestName || undefined, facts: railFacts,
            hero: engaged && wantHero }
        : { hero: cue.hero ?? false }),
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
  // Border width rides in the key so entering and leaving a card — the one
  // change that lives in a property the cheap path cannot send — rebuilds by
  // construction rather than by every caller remembering to say so. Image
  // containers ride in it for the reason the mark once regressed: an image
  // appearing or vanishing is a different page.
  const shape = [
    ...page.textObject.map(
      (c) => `t${c.containerID}${c.borderWidth ? `b${c.borderWidth}` : ""}`),
    ...(page.listObject || []).map(
      (c) => `l${c.containerID}:${(c.itemContainer?.itemName || []).join("|")}`,
    ),
    ...(page.imageObject || []).map((c) => `i${c.containerID}`),
  ].join(",");
  const sameShape = pageBuilt && shape === currentShape;

  if (!pageBuilt) {
    await bridge.createStartUpPageContainer(page);
    pageBuilt = true;
    imagesShown.clear();   // pixels never survive a build
    if (!(await pushImages(page))) return renderCue(cue, latencyMs);
  } else if (sameShape) {
    // Cheap path: text-only updates, no page rebuild.
    for (const c of page.textObject) {
      await bridge.textContainerUpgrade({
        containerID: c.containerID,
        containerName: c.containerName,
        content: c.content,
      });
    }
    // The hero container survived, but the guest may have changed under it —
    // same shape, different sizes. Push only when the values moved.
    if (!(await pushImages(page, true))) return renderCue(cue, latencyMs);
  } else {
    await bridge.rebuildPageContainer(page);
    imagesShown.clear();
    if (!(await pushImages(page))) return renderCue(cue, latencyMs);
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
  return pushImages(page);
}

/**
 * Send pixels for whatever image containers this page declared — the mark
 * gets the mark's bytes, the hero rail gets *this guest's* sizes drawn fresh.
 *
 * `onlyChanged` is the cheap path's version: containers already have pixels,
 * so nothing is sent unless the hero's values moved. `imagesShown` holds the keys,
 * and it is cleared by every build because the container comes back empty.
 */
async function pushImages(
  page: ReturnType<typeof buildCue>, onlyChanged = false,
): Promise<boolean> {
  for (const c of page.imageObject || []) {
    let data: Uint8Array;
    let heroKey = "";
    if (c.containerName === "cue-hero") {
      const [top, btm] = heroValues();
      heroKey = `${top}|${btm}|${heroStat()}`;
      if (onlyChanged && heroKey === imagesShown.get(c.containerName)) continue;
      data = heroRail(top, btm, heroStat());
    } else if (c.containerName === "cue-idle-clock") {
      // The big dotted clock. Keyed on the minute, so an idle repaint that
      // crossed no minute boundary sends nothing.
      heroKey = clockLabel();
      if (onlyChanged && heroKey === imagesShown.get(c.containerName)) continue;
      data = heroClock(heroKey);
    } else {
      if (onlyChanged) continue;   // the mark's pixels never change
      data = markBytes();
    }
    const result = await bridge.updateImageRawData({
      containerID: c.containerID,
      containerName: c.containerName,
      imageData: data,
    });
    if (result !== "success") {
      // Latch off whichever image the host refused and rebuild without it.
      // The failure mode is the wordmark and the text rail — the 0.2.0 lens —
      // never an empty box on somebody's face.
      if (c.containerName === "cue-hero") {
        log(`hero rail rejected by host (${result}) — falling back to the text rail`);
        useHeroRail = false;
      } else {
        log(`mark rejected by host (${result}) — falling back to the wordmark`);
        useMark = false;
      }
      // The shape is about to change, and the page we just built is the one
      // being replaced. Clear it so the re-render cannot take the cheap path.
      currentShape = "";
      return false;
    }
    if (heroKey) imagesShown.set(c.containerName, heroKey);
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
 * What must never happen is the middle case — "MARCUS WEB" reads as a broken
 * display rather than a shortened name, and the surname is the droppable half
 * anyway, since the associate is about to say the first name out loud and the
 * full name is on the guest card when they arrive.
 *
 * **Which names fit is now a measurement, and it changes the answer.** The
 * rail was described as "ten characters wide", so `MAYA OKAFOR` — eleven —
 * was being shortened to `MAYA O`. It is 127px in a 156px column: it fits, and
 * fits comfortably. `SARAH CHEN` was never in question. What still shortens is
 * a genuinely wide name, and now for a genuine reason rather than a count.
 */
function railName(name?: string): string {
  const full = String(name || "").trim().replace(/\s+/g, " ");
  if (fitsPx(full, FACT_PX)) return full;
  const parts = full.split(" ");
  if (parts.length < 2) return full;   // one long word — let the rail fit it
  const short = `${parts[0]} ${parts[parts.length - 1][0]}`;
  return fitsPx(short, FACT_PX) ? short : parts[0];
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
  // The name is no longer a rail row — it has its own container above the
  // rail (`cue-name`), where it stays whichever form the rail below takes.
  // These rows are the *text* fallback for a host that refuses the hero, so
  // the sizes still lead. The unread count left the rail for the header
  // cluster, where it shows on every page instead of only railed ones.
  return [
    g.tier || "",
    sizes.tops ? `TOP ${sizes.tops}` : "",
    sizes.bottoms ? `BTM ${sizes.bottoms}` : "",
    sizes.outerwear ? `OUT ${sizes.outerwear}` : "",
    prefs.railPoints && typeof g.points === "number" ? `${g.points} PTS` : "",
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
    // The one difference between a message to the room and a message to you.
    // It goes in the meta rather than in a line because all three lines are
    // already carrying the message itself, and losing a word of "need backup
    // in fitting rooms" to a marker would be a bad trade.
    facts: [], meta: addressedToMe(m) ? [ADDRESSED_MARK] : [], moduleCount: 0,
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
    // An addressed message leads with the mark, because in a list of ten
    // things the room said, the one somebody asked *you* for is the one that
    // needs answering. A reply to it goes back to that person alone.
    ...[...inbox].reverse().map((m) => ({
      label: addressedToMe(m)
        ? `${ADDRESSED_MARK} ${m.from} ${m.message}`
        : `${m.from} ${m.message}`,
      send: "ON MY WAY",
      msg: m,
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
    { logo: useMark, mic: micState(), footer: menuItems[menuIndex]?.msg
        ? "PRESS TO REPLY ON MY WAY · 2X BACK"
        : "PRESS TO SEND · 2X BACK" },
  );
  await paint(page);
}

/** Send whatever the menu cursor is on, then leave. */
async function sendFromMenu() {
  const item = menuItems[menuIndex];
  if (!item) return void showIdle();
  // Answering a message that was addressed to you goes back to the person who
  // sent it, not to the room. Anything else — a reply to the room, or a
  // phrase sent cold — is a broadcast, exactly as before.
  const replyTo = item.msg && addressedToMe(item.msg) ? item.msg.fromId : undefined;
  socket?.emit("radio:send", {
    message: item.send ?? item.label,
    priority: item.urgent ? "urgent" : "normal",
    tenant: TENANT,
    ...(replyTo ? { to: replyTo } : {}),
  });
  log(`radio → ${item.send ?? item.label}${replyTo ? ` (to ${item.msg?.from})` : ""}`);
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
  cardFocus = false;
  cardScroll = 0;
  railVariant = 0;
  engaged = false;
  engagedGuestId = null;
  focusSku = null;
  lastDisplay = null;
  railFacts = [];
  railGuestName = "";
  forgetSession();
  // The engagement is over, so a zone change that was waiting for it can go.
  flushZoneRegistration();
  await renderCue({
    ...IDLE_CUE,
    // The resting screen: a 48px dotted clock in the card, with the state
    // in the card's title. The lens's first impression should read as an
    // instrument, not a terminal — see `heroClock` in hero.ts. When the
    // host has refused images the lines carry the words instead, exactly
    // as before.
    heroClock: useHeroRail,
    cardTitle: "AWAITING GUEST SIGNAL",
    lines: useHeroRail ? [] : ["CUESEA READY", TENANT_LABEL, "AWAITING GUEST SIGNAL"],
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
      // The tenant moved here from the second line — the clock owns the card
      // now. Last, because `fit` drops from the right and the exit hint is
      // the one fact an associate cannot discover by accident; the tenant is
      // on the phone page too.
      ...(useHeroRail ? [TENANT_LABEL] : []),
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
  // The floor rides at the end of the deck: scrolling to it shows what is
  // waiting, clicking it opens the menu. Mid-engagement is exactly when
  // "covering your guest" needs answering, and this is how it is reached now
  // that scrolling down means "next card" — see onGesture.
  cards = [...cardsFor(payload), { kind: "FLOOR", lines: [] }];
  cardIndex = 0;
  cardFocus = false;
  cardScroll = 0;
  railVariant = 0;
  railFacts = railFor(payload);
  railGuestName = railName((payload.guest as any)?.name);
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
  if (cards[cardIndex]) return showCard(cardIndex);
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

  // The floor card's face is live — it says what is waiting *now*, so it is
  // composed at show time rather than frozen into the deck at guest arrival.
  const newest = inbox[inbox.length - 1];
  const lines = card.kind === "FLOOR"
    ? [inbox.length ? `${inbox.length} WAITING` : "FLOOR QUIET",
       newest ? toDisplayText(`${newest.from} ${newest.message}`) : "",
       "PRESS TO OPEN"]
    : card.lines;
  // A card face carries no meta of its own, so the addressed mark can use it:
  // the newest message being *for you* is the reason to open the card now
  // rather than at the end of the conversation.
  const cardMeta = card.kind === "FLOOR" && newest && addressedToMe(newest)
    ? [ADDRESSED_MARK]
    : card.meta || [];

  if (cardFocus && card.kind !== "FLOOR") {
    // Clicked in: the frame thickens and the window scrolls the whole card.
    // The title carries the window — `CART · 2-4/9` — because the font has no
    // scrollbar and a fraction is read rather than counted.
    const all = allLines(card);
    const max = Math.max(0, all.length - CUE_LINES);
    cardScroll = Math.max(0, Math.min(cardScroll, max));
    const win = all.slice(cardScroll, cardScroll + CUE_LINES);
    const title = all.length > CUE_LINES
      ? `${card.kind} · ${cardScroll + 1}-${cardScroll + win.length}/${all.length}`
      : card.kind;
    await renderCue({
      lines: win, meta: card.meta || [], cardTitle: title, focused: true,
    });
  } else {
    await renderCue({
      lines, meta: cardMeta,
      cardTitle: `${card.kind} · ${index + 1}/${cards.length}`,
    });
  }
  log(`card ${index + 1}/${cards.length}: ${card.kind}${cardFocus ? ` (in, at ${cardScroll})` : ""}`);
}

async function cycleCards(step: 1 | -1) {
  if (!engaged || cards.length <= 1) return;
  // Wrap. With a stack this long, walking off the end and stopping means an
  // associate scrolling for the address discovers the list has an end rather
  // than a shape — and the cue is one step backwards from the last card,
  // which is where you most often want it.
  const next = (cardIndex + step + cards.length) % cards.length;
  cardFocus = false;
  cardScroll = 0;
  await showCard(next);
}

/**
 * Scroll inside the focused card.
 *
 * On the SIZES card this is the value switch instead: the card *is* the
 * sizes, so scrolling it cycles which value the hero's shirt slot shows —
 * tops, then outerwear where the guest has one. Everything else windows.
 */
async function scrollFocusedCard(step: 1 | -1) {
  const card = cards[cardIndex];
  if (!card) return;
  if (card.kind === "SIZES") {
    const sizes = (lastDisplay?.guest as any)?.sizes || {};
    if (sizes.outerwear) {
      railVariant = railVariant === 0 ? 1 : 0;
      rebuildNext();   // the change lives in image pixels and rail rows
      railFacts = lastDisplay ? railFor(lastDisplay) : railFacts;
    }
    await showCard(cardIndex);
    return;
  }
  cardScroll += step;
  await showCard(cardIndex);
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
        // The log line always said "to <name>" here. Now it can be true: an
        // urgent call addressed to this person is answered back to them, and
        // one sent to the room is answered to the room.
        const backTo = addressedToMe(onUrgent) ? onUrgent.fromId : undefined;
        socket?.emit("radio:send", {
          message: "ON MY WAY", tenant: TENANT, ...(backTo ? { to: backTo } : {}),
        });
        log(`radio → ON MY WAY (to ${backTo ? onUrgent.from : "the floor"})`);
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
      // it mean anything about the deck.
      if (voice.dismiss()) return;
      // Same for a scan's progress or its answer. It cannot recall a camera
      // the phone has already opened — but it can stop the answer from waiting
      // out its dwell, which is what a press means everywhere else.
      if (vision.dismiss()) return;
      // The deck's press, and it is one rule at two levels: **a press goes
      // into the thing in front of you, and a press inside comes back out.**
      //
      //   on a card        press clicks in — border thickens, scroll now
      //                    moves the card's own content
      //   inside a card    press clicks out, back to the deck
      //   on FLOOR         press opens the floor menu (its "inside")
      //   on the cue       press ends the engagement — the cue is home, and
      //                    ending a session stays a deliberate act you can
      //                    only do from home, never from card seven by
      //                    accident in front of a customer
      if (engaged) {
        if (cardFocus) {
          cardFocus = false;
          cardScroll = 0;
          void showCard(cardIndex);
          return;
        }
        if (cards[cardIndex]?.kind === "FLOOR") { void showFloorMenu(); return; }
        if (cardIndex > 0) {
          cardFocus = true;
          cardScroll = 0;
          void showCard(cardIndex);
          return;
        }
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
      if (engaged && cardFocus) { void scrollFocusedCard(-1); return; }
      void cycleCards(-1);
      return;

    case "scroll-down":
      if (menuIndex >= 0) { void showFloorMenu(menuIndex + 1); return; }
      // Inside a card, down scrolls the card. On the deck, down is the next
      // card — both directions cycle now, which "down opens the floor" used
      // to shadow. The floor still opens from anywhere it is needed: the
      // FLOOR card while engaged, and scroll-down at idle.
      if (engaged && cardFocus) { void scrollFocusedCard(1); return; }
      if (engaged) { void cycleCards(1); return; }
      if (voice.current === "idle" && !onRuler) { void showFloorMenu(); return; }
      return;

    case "exit":
      // The OS is taking the page away; drop the session cleanly rather than
      // leaving an associate "engaged" on the manager dashboard forever.
      if (engaged) socket.emit("session:end");
      // And close the shift the same way. If the socket has already gone this
      // is buffered with the time it happened, so a shift that ended at 17:58
      // is not recorded as ending whenever the app is next opened.
      if (telemetryOn) void shift.close("app_closed");
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
 * The store selector — which tenant this phone belongs to.
 *
 * The highest-value small fix in the handoff, shipped at last: Even Hub
 * offers no way to set a launch parameter, so without this card a real phone
 * is forever the demo tenant — wrong roster, wrong store, and a camera flag
 * that never matches the store that actually enabled it. The choice persists
 * on the phone and the page relaunches into it, so every boot-time decision
 * (capabilities, socket registration, roster) is made against the right
 * world rather than patched afterwards.
 */
function mountTenantCard() {
  const mount = document.getElementById("prefs-mount");
  if (!mount) return;

  const card = document.createElement("section");
  card.className = "card prefs";
  const title = document.createElement("h3");
  title.textContent = "Store";
  card.appendChild(title);

  const row = prefRow("This phone works at",
    "Changing it reloads the plugin into that store's world — roster, camera and floor settings included.");
  const group = document.createElement("div");
  group.className = "pref-seg";
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", "STORE");
  for (const t of KNOWN_TENANTS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pref-seg-item";
    b.dataset.value = t.slug;
    b.dataset.on = t.slug === TENANT ? "1" : "0";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(t.slug === TENANT));
    b.textContent = t.label;
    b.addEventListener("click", () => {
      if (t.slug === TENANT) return;
      // Both halves matter: the store survives a cold launch (Even Hub's URL
      // carries no parameter), the URL makes this launch pick it up now.
      try { window.localStorage.setItem(TENANT_KEY, t.slug); } catch { /* private mode */ }
      void bridge?.setLocalStorage(TENANT_KEY, t.slug);
      const url = new URL(window.location.href);
      url.searchParams.set("tenant", t.slug);
      window.location.href = url.toString();
    });
    group.appendChild(b);
  }
  row.appendChild(group);
  card.appendChild(row);
  mount.appendChild(card);
}

/**
 * The Floor card — the phone half of floor comms.
 *
 * The glass can say seven canned phrases with a ring, and that is right for
 * "on my way" mid-conversation. It cannot say "the 32s are in the back on the
 * left of the stockroom door", and a floor that can only speak in seven
 * sentences routes around the product to a group chat. So the typing lives
 * here, where there is a keyboard, and the reading stays on the glass, where
 * an associate can do it without breaking eye contact — the same split the
 * capture card uses for the camera.
 *
 * Selecting a person addresses the message to them; selecting nobody sends it
 * to the whole floor. One control, because it is one channel.
 */
let floorTarget: string | null = null;

function setFloorStatus(text: string, tone: "ok" | "warn" | "" = "") {
  const el = document.getElementById("floor-status");
  if (!el) return;
  el.textContent = text;
  el.className = tone ? `floor-status ${tone}` : "floor-status";
}

/**
 * The "Sending…" line has to end, receipt or no receipt.
 *
 * A phone can be newer than the server it is talking to: this build's
 * broadcast receipt arrives from a server that knows how to count the floor,
 * and a deployment that predates it answers a broadcast with nothing at all.
 * Left alone, the composer would sit mid-sentence forever and read as a hang —
 * a worse failure than the missing count, and one caused entirely by shipping
 * the two halves at different times.
 *
 * So the status degrades to what an older server's behaviour actually
 * justifies: the message was sent, and we cannot say who got it.
 */
let floorReceiptTimer: ReturnType<typeof setTimeout> | null = null;

function awaitFloorReceipt(fallback: string) {
  if (floorReceiptTimer) clearTimeout(floorReceiptTimer);
  floorReceiptTimer = setTimeout(() => {
    floorReceiptTimer = null;
    setFloorStatus(fallback, "");
  }, 4000);
}

/** A receipt landed — whatever it said, the wait is over. */
function floorReceiptArrived() {
  if (floorReceiptTimer) clearTimeout(floorReceiptTimer);
  floorReceiptTimer = null;
}

/** Redraw just the people, on every roster push. Rebuilding the whole card
 *  would take the keyboard away mid-sentence. */
function renderFloorRoster() {
  const list = document.getElementById("floor-roster");
  if (!list) return;
  // Never offer yourself: a message to your own glasses is not a thing anyone
  // means to send, and it would occupy the top of the list on every floor.
  const others = roster.filter((r) => !myRosterIds.has(r.id));
  // A target who walked off the floor stops being a target. Without this the
  // picker shows no selection at all — not even "Everyone" — while the next
  // send still goes to a socket id that no longer resolves, which the server
  // correctly refuses and the associate cannot see coming.
  if (floorTarget && !roster.some((r) => r.id === floorTarget)) floorTarget = null;
  list.replaceChildren();

  const everyone = document.createElement("button");
  everyone.type = "button";
  everyone.className = floorTarget === null ? "floor-pick selected" : "floor-pick";
  everyone.textContent = "Everyone";
  everyone.setAttribute("aria-pressed", String(floorTarget === null));
  everyone.addEventListener("click", () => { floorTarget = null; renderFloorRoster(); });
  list.appendChild(everyone);

  for (const person of others) {
    const b = document.createElement("button");
    b.type = "button";
    const on = floorTarget === person.id;
    b.className = on ? "floor-pick selected" : "floor-pick";
    b.setAttribute("aria-pressed", String(on));
    b.textContent = person.name;
    if (person.zone) {
      const zone = document.createElement("span");
      zone.className = "meta";
      zone.textContent = ` · ${person.zone}`;
      b.appendChild(zone);
    }
    // Tapping the selected person clears the address rather than trapping the
    // composer in a DM — the way back to the room should not need a reload.
    b.addEventListener("click", () => {
      floorTarget = on ? null : person.id;
      renderFloorRoster();
    });
    list.appendChild(b);
  }

  if (others.length === 0) {
    const empty = document.createElement("p");
    empty.className = "floor-empty";
    empty.textContent = "Nobody else is on the floor right now.";
    list.appendChild(empty);
  }
}

/**
 * Built unless the store is *known* to have floor comms off.
 *
 * Deliberately not the capture card's rule. The camera fails closed because it
 * is new and there is no working behaviour to lose, so hiding it wrongly costs
 * nothing. Floor comms is the opposite case and this file already says so:
 * `floor_comms` is unenforced precisely because "switching it off on the first
 * failed fetch would break every tenant to protect a permission none of them
 * have set". A 2.5s timeout on a shop's wifi must not silently remove typed
 * messaging for the rest of the shift — so the card goes when the store said
 * no, and stays when we could not ask.
 */
function mountFloorCard(caps: Capabilities) {
  const mount = document.getElementById("floor-mount");
  if (!mount) return;
  mount.replaceChildren();
  if (caps.known && caps.floor_comms === false) return;

  const card = document.createElement("section");
  card.className = "card floor";

  const title = document.createElement("h3");
  title.textContent = "Floor";
  card.appendChild(title);

  const blurb = document.createElement("p");
  blurb.className = "capture-note";
  blurb.textContent =
    "Type to the whole floor, or pick one person to reach only them. "
    + "It arrives in their glasses — they can reply with a phrase from the ring.";
  card.appendChild(blurb);

  const list = document.createElement("div");
  list.className = "floor-roster";
  list.id = "floor-roster";
  card.appendChild(list);

  const row = document.createElement("div");
  row.className = "floor-compose";

  const input = document.createElement("input");
  input.type = "text";
  input.id = "floor-input";
  input.className = "floor-input";
  // The server truncates at 140 and the glass truncates by pixel; saying so
  // here means a long message is short before it is sent rather than clipped
  // after, where the sender cannot see what was lost.
  input.maxLength = 140;
  input.placeholder = "Say something to the floor";
  input.autocomplete = "off";
  row.appendChild(input);

  const send = document.createElement("button");
  send.type = "button";
  send.className = "btn btn-primary";
  send.textContent = "Send";
  row.appendChild(send);
  card.appendChild(row);

  const status = document.createElement("div");
  status.className = "floor-status";
  status.id = "floor-status";
  status.setAttribute("role", "status");
  card.appendChild(status);

  const submit = () => {
    const text = input.value.trim();
    if (!text) return;
    if (!socket?.connected) {
      setFloorStatus("No connection to the floor — nothing was sent.", "warn");
      return;
    }
    // Never `priority: urgent` from here. Kyle's call: the tier belongs to the
    // canned backup call, which is a press on the ring — not something a
    // keyboard can reach for. The server enforces this too; this is just the
    // client agreeing with it.
    socket.emit("radio:send", {
      message: text, tenant: TENANT,
      ...(floorTarget ? { to: floorTarget } : {}),
    });
    const to = floorTarget
      ? roster.find((r) => r.id === floorTarget)?.name || "them"
      : "the floor";
    log(`radio → ${text} (to ${to})`);
    // Said immediately, and replaced by the receipt when the server answers.
    // A composer that clears with no acknowledgement at all is one an
    // associate stops trusting after the first message that goes missing.
    // Deliberately "Sending", not "Sent": this line is written before anything
    // has been delivered, and only the receipt knows whether it was.
    setFloorStatus(`Sending to ${to}…`, "");
    awaitFloorReceipt(floorTarget ? `Sent to ${to}.` : "Sent to the floor.");
    input.value = "";
  };

  send.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
  });

  mount.appendChild(card);
  renderFloorRoster();
  // A phone that opens into a quiet store would otherwise wait for somebody
  // else to arrive before it could address anyone.
  socket?.emit("roster:list");
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

/**
 * Tell the associate what their store is measuring about them.
 *
 * On the identity line, beside their own name and their serial — not in the
 * collapsed diagnostics drawer, and not in a settings card they have no
 * control on. Somebody being measured should not have to read a schema to find
 * out, and "next to your own name" is the only place on this page that is
 * reliably true of.
 *
 * Built rather than written into `index.html`, exactly like the capture card
 * and for the same reason in reverse: the sentence must not be able to appear
 * on a page for a store that has this switched off. `NO_CAPABILITIES` is
 * everything-off, so a failed fetch renders nothing and claims nothing.
 */
function mountTelemetryNotice(caps: Capabilities) {
  const el = ui.whoTelemetry;
  if (!el) return;
  el.textContent = caps.shift_telemetry ? TELEMETRY_NOTICE : "";
  el.className = caps.shift_telemetry ? "whoami-notice" : "";
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

/**
 * Begin measuring — only ever reached when the store has said to.
 *
 * Three subscriptions, and each one is a way a shift can end honestly:
 *
 *   · the socket, which opens the shift and flushes whatever the outage held;
 *   · `DeviceStatus`, which is the only thing that can say the glasses went
 *     flat rather than the associate going quiet;
 *   · `pagehide`, which is this host's real teardown signal — the WebView is
 *     taken away every time the phone goes in a pocket, and an end fired there
 *     is usually *buffered* rather than sent, which is exactly why it carries
 *     the time it happened.
 *
 * What is deliberately not here is a `beforeunload`. It does not fire reliably
 * on mobile WebViews, and a teardown path that works on a laptop and not on
 * the device this ships to is worse than none: it would look tested.
 */
function startTelemetry() {
  bridge.onDeviceStatus((status) => void shift.onStatus(status));
  window.addEventListener("pagehide", () => { void shift.close("app_closed"); });
  if (socket?.connected) void shift.onConnect();
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

  // Say who the glasses think this is, and on what hardware.
  //
  // Both were already fetched for `register` and displayed nowhere. An
  // associate had no way to tell whether their shift was landing on their own
  // name or on nobody's — and an unassigned pair records activity that never
  // reaches the leaderboard, which is exactly the confusion the Health panel
  // flags for managers and the floor could never see for itself.
  if (ui.whoName) {
    ui.whoName.textContent = user.name || "NOT SIGNED IN";
    ui.whoName.className = user.name ? "whoami-name" : "whoami-name unknown";
  }
  if (ui.whoMeta) {
    ui.whoMeta.textContent = device.sn
      ? `${device.model || "GLASSES"} · ${device.sn}`
      : "NO GLASSES PAIRED";
    ui.whoMeta.className = device.sn ? "whoami-meta" : "whoami-meta unknown";
  }

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
    render: (lines, meta) => renderCue({ lines, meta, cardTitle: "ASK" }),
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
    zone: () => prefs.zone,
    render: (lines, meta) => renderCue({ lines, meta, cardTitle: "SCAN" }),
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

  // The glasses' own battery, for the header cluster. Subscribed regardless
  // of the telemetry gate: this is the associate's battery shown to the
  // associate on their own face, which is not measurement — nothing here is
  // sent anywhere. It redraws the frame only when the 20% light changes what
  // it says, and only when the frame is ours to redraw.
  bridge.onDeviceStatus((status) => {
    if (typeof status.batteryPercent !== "number") return;
    const was = battery;
    battery = status.batteryPercent;
    const lit = (v: number | null) => v !== null && v <= 20;
    const changed = lit(was) !== lit(battery) || (lit(battery) && was !== battery);
    const ownFrame = !onUrgent && !onRequest && menuIndex < 0 && !onRuler
      && voice.current === "idle" && vision.current === "idle";
    if (changed && pageBuilt && ownFrame) {
      if (engaged) void restoreView();
      else void showIdle();
    }
  });

  // The idle clock has to tick. Nothing else ever repainted the resting
  // screen, so before this the clock — text or hero — was only as fresh as
  // the last event that happened to arrive. Repaint only when the minute
  // actually changed, and only when idle truly owns the frame, so the wire
  // carries three updates an hour and never interrupts anything.
  let idleMinute = clockLabel();
  setInterval(() => {
    if (clockLabel() === idleMinute) return;
    idleMinute = clockLabel();
    if (pageBuilt && onRootPage()) void showIdle();
  }, 5_000);

  bridge.onEvenHubEvent((event: any) => {
    if (event?.audioEvent) return voice.onAudioChunk(event.audioEvent.audioPcm);

    const gesture = decodeGesture(event);
    if (gesture) return onGesture(gesture);

    // Not a gesture we recognise. IMU reports are expected noise; anything
    // else is exactly what the inspector exists to surface.
    if (event?.sysEvent?.imuData) return;
    pushInspector(undefined, event);
  });

  // Built now so the socket handlers below can refer to it, and deliberately
  // not started: nothing is sent until the store's capability answer arrives
  // and says this floor measures its staff.
  shift = new ShiftController({
    emit: (event, payload) => socket?.emit(event, payload),
    connected: () => socket?.connected === true,
    store: {
      get: (key) => bridge.getLocalStorage(key),
      set: (key, value) => bridge.setLocalStorage(key, value),
    },
    serial: (device as any).sn || null,
    model: (device as any).model || null,
    zone: () => prefs.zone,
    log,
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
    // The roster is keyed by socket id, so this lens already knows its own
    // address the moment it has a socket — no round trip, and no window in
    // which the composer offers you yourself because the answer hasn't come
    // back yet. `roster:you` still arrives and confirms it; this is the same
    // fact known earlier, not a second source of truth.
    claimRosterId(socket.id);
    // A reconnect re-registers with whatever the zone is *now*, not with the
    // one this page booted on.
    registerAssociate();
    zoneRegisterPending = false;
    // Buffered events first, then the shift. A reconnect is the only moment
    // anything that happened during the outage can be delivered, and the
    // controller is a no-op until the store has said it wants this.
    if (telemetryOn) void shift.onConnect();
  });
  socket.on("disconnect", () => {
    ui.serverStatus.textContent = "Server offline";
    ui.serverStatus.className = "pill warn";
    // Nothing is closed here. A dropped socket and a finished shift are
    // different things, and the phone cannot tell them apart either — the
    // server closes the shift at its last heartbeat once the gap passes, and a
    // reconnect inside the gap continues the same one. What the controller
    // does from here is buffer, which is the whole reason it exists.
  });

  // The server's answer about which shift this phone is on — or that the store
  // has this switched off after all, in which case the controller stops rather
  // than re-queueing records the retailer has declined.
  socket.on("shift:state", (state: any) => void shift.onState(state));
  socket.on("telemetry:replayed", ({ accepted }: { accepted?: number }) =>
    void shift.onReplayed(Number(accepted) || 0));
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

  socket.on("roster:you", ({ id }: { id?: string }) => {
    claimRosterId(id);
    renderFloorRoster();
  });

  socket.on("roster:update", ({ roster: rows }: { roster?: typeof roster }) => {
    roster = rows || [];
    renderFloorRoster();
  });

  // Both receipts are the sender's own business and stay on the phone: the
  // glass is for what other people said, not for confirmations of what you
  // said. The failure is the one that matters — see `radio:undelivered`.
  socket.on("radio:delivered", ({ toName, reach }: { toName?: string; reach?: number }) => {
    floorReceiptArrived();
    if (toName) {
      setFloorStatus(`Delivered to ${toName}.`, "ok");
      log(`radio → delivered to ${toName}`);
      return;
    }
    // A broadcast, and the count is the answer to the question the sender is
    // actually asking. Nobody on the floor is the case worth colouring: it
    // reads as success otherwise, and a message that reached no glasses is
    // not a success — it is the broadcast version of "they left".
    if (reach === 0) {
      setFloorStatus("Nobody else is on the floor — nothing received it.", "warn");
      log("radio → reached nobody");
      return;
    }
    if (typeof reach === "number") {
      setFloorStatus(`Sent to ${reach} on the floor.`, "ok");
      log(`radio → reached ${reach}`);
    }
  });

  socket.on("radio:undelivered", ({ reason, message }: { reason?: string; message?: string }) => {
    floorReceiptArrived();
    // Roster ids churn on reconnect, so this is an ordinary outcome and not a
    // fault. It must be visible: a message the sender believes was delivered
    // and that reached nobody is the worst failure this feature has.
    const why = reason === "not_on_floor"
      ? "They're no longer on the floor — nothing was sent."
      : reason === "floor_comms_off"
        ? "Your store has floor messages switched off."
        : "Not delivered.";
    setFloorStatus(why, "warn");
    log(`radio → UNDELIVERED (${reason}): ${message ?? ""}`);
  });

  socket.on("radio:message", (m: RadioMessage) => {
    // Our own message, echoed back so the dashboard and the web harness get
    // the full log. Nobody needs to read on their own glass the thing they
    // just sent.
    if (m.fromId && m.fromId === socket.id) return;
    log(`radio ← ${m.from}: ${m.message}`
        + `${addressedToMe(m) ? " (to you)" : ""}`
        + `${m.priority === "urgent" ? " (urgent)" : ""}`);

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
      // Do not touch what the associate is looking at — repaint the same
      // view, which picks up the header's unread count and, on the FLOOR
      // card, the new message itself.
      void restoreView();
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

  // Which retail world this launch belongs to, on the always-visible line.
  //
  // The badge for this used to be in the diagnostics strip, and the
  // preferences restructure put that strip behind a collapsed disclosure — so
  // the single most important piece of context on the page became invisible.
  // The lens demo defaults to `?tenant=gap`; a store whose slug is `cuesea`
  // then reads as a store with the camera switched off, and the next move is
  // to go and check a Console toggle that was already right.
  if (ui.whoTenant) {
    const unknown = !capabilities.known;
    ui.whoTenant.textContent = unknown ? `${TENANT} · NOT FOUND` : TENANT;
    ui.whoTenant.className = unknown ? "whoami-meta unknown" : "whoami-meta";
  }
  // Logged as what it is — a gate, and which way it fell. When the capture
  // card is missing from the page this line is the only thing that says
  // whether the store turned it off or the fetch never answered.
  log(`capabilities: camera=${capabilities.camera_capture ? "on" : "off"} ` +
      `shift=${capabilities.shift_telemetry ? "on" : "off"} ` +
      `voice=${capabilities.voice} floor=${capabilities.floor_comms}`);
  mountCaptureCard(capabilities);
  mountFloorCard(capabilities);
  // Said before anything is sent, deliberately. If the first record of a shift
  // reaches the server before the sentence reaches the page, there is a window
  // — however short — in which somebody is being measured and their own phone
  // has not told them.
  mountTelemetryNotice(capabilities);
  telemetryOn = capabilities.shift_telemetry === true;
  if (telemetryOn) startTelemetry();

  // Now that the store has answered, anything it does not permit falls back to
  // its default and its control is never built. The two unenforced capabilities
  // are why this resolves to the *default* rather than to off: see prefs.ts.
  const wasVoice = prefs.voice;
  prefs = effectivePrefs(stored, capabilities, TENANT);
  mountPrefsCard(capabilities);
  mountTenantCard();
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
