/**
 * Cue — Even Hub plugin entry.
 *
 * Runs in the Even App WebView on the associate's phone. Connects to the
 * Cue realtime server, renders guest context to the glasses via the
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
import { buildCue, CUE_LINES, IDLE_CUE, toDisplayText, type Cue } from "./layout";
import { VoiceController, type VoiceResult, type VoiceState } from "./voice";

/** Everything goes through the realtime server. The plugin is a static
 *  bundle, so it cannot hold the AI service key — the server holds it and
 *  proxies. There is deliberately no VITE_AI_URL any more: a build flag that
 *  points the plugin straight at the AI service would quietly undo that. */
const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";

/** Tenant = which retail world this launch belongs to ("gap" demo | "shopify"
 *  live). Carried by the launch URL, i.e. the QR code that opened us. */
const TENANT =
  new URLSearchParams(window.location.search).get("tenant")?.toLowerCase() || "gap";
const TENANT_LABEL = TENANT === "shopify" ? "FUTURE BASICS · LIVE" : "GAP · DEMO";
const ZONE = TENANT === "shopify" ? "Front Table" : "Denim Wall";

type Recommendation = {
  sku: string;
  name: string;
  price?: number;
  location?: string;
  stock?: number;
};

type DisplayPayload = {
  lines: string[];
  cue?: Cue;
  script?: { opener: string; upsell: string; closer: string };
  guest?: { name: string; tier: string; guest_id?: string };
  recommendations?: Recommendation[];
};

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
let currentLines: string[] = [];
let pageBuilt = false;
let engaged = false;

/** What the associate is currently looking at — the context a voice question
 *  like "do we have these in a 32" needs in order to mean anything. */
let engagedGuestId: string | null = null;
let focusSku: string | null = null;
let lastDisplay: DisplayPayload | null = null;

/** Recommendation carousel. -1 = showing the guest card, not a product. */
let recommendations: Recommendation[] = [];
let recIndex = -1;

/** Render a cue. `status` is gone: the glass shows nothing it doesn't have to,
 *  and a hint row is chrome. */
async function renderCue(cue: Cue, latencyMs?: number) {
  const page = buildCue(cue, latencyMs);
  const lines = cue.lines || [];
  const sameShape =
    pageBuilt && lines.slice(0, CUE_LINES).length === currentLines.slice(0, CUE_LINES).length;

  if (!pageBuilt) {
    await bridge.createStartUpPageContainer(page);
    pageBuilt = true;
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
  }
  currentLines = lines;
}

async function showIdle() {
  engaged = false;
  engagedGuestId = null;
  focusSku = null;
  lastDisplay = null;
  await renderCue({ ...IDLE_CUE, lines: ["CUESEA READY", TENANT_LABEL, "AWAITING GUEST SIGNAL"] });
  ui.sessionInfo.textContent = "No active session";
}

async function onDisplay(payload: DisplayPayload) {
  engaged = true;
  lastDisplay = payload;
  engagedGuestId = payload.guest?.guest_id ?? engagedGuestId;
  recommendations = payload.recommendations ?? [];
  recIndex = -1;
  focusSku = recommendations[0]?.sku ?? focusSku;
  await renderCue(cueOf(payload));
  ui.sessionInfo.textContent = payload.guest
    ? `Engaged: ${payload.guest.name} (${payload.guest.tier})`
    : "Engaged";
  log(`display ← ${payload.guest?.name ?? "server"} (${payload.lines.length} lines)`);
}

/** Restore whatever was on the lens before a voice interaction took it over. */
async function restoreView() {
  if (!engaged || !lastDisplay) return showIdle();
  if (recIndex >= 0 && recommendations[recIndex]) return showRecommendation(recIndex);
  await renderCue(cueOf(lastDisplay));
}

/** The service writes in glass grammar. `lines` is the flat form kept for the
 *  manager view and older payloads; fall back to it only if `cue` is absent. */
function cueOf(payload: DisplayPayload): Cue {
  if (payload.cue?.lines?.length) return payload.cue;
  return { lines: (payload.lines || []).slice(0, CUE_LINES).map(toDisplayText) };
}

/** Whole units on the glass — decimals are punctuation. */
function money(v?: number) {
  return typeof v === "number" ? `$${Math.round(v).toLocaleString()}` : "";
}

/**
 * Scrolling the ring walks the recommendation list. Whatever is showing also
 * becomes `focusSku`, so the associate can scroll to an item and immediately
 * ask "do we have these in a 32" without naming it.
 */
async function showRecommendation(index: number) {
  const item = recommendations[index];
  if (!item) return;
  recIndex = index;
  focusSku = item.sku;
  await renderCue({
    lines: [item.name, item.location || "", ""],
    meta: [
      money(item.price),
      typeof item.stock === "number" ? `${item.stock} ON HAND` : "",
      `${index + 1} OF ${recommendations.length}`,
    ].filter(Boolean),
  });
  log(`showing rec ${index + 1}/${recommendations.length}: ${item.name}`);
}

async function cycleRecommendations(step: 1 | -1) {
  if (!engaged || recommendations.length === 0) return;
  // From the guest card, scrolling either way enters the list at the ends.
  const next =
    recIndex < 0
      ? step === 1
        ? 0
        : recommendations.length - 1
      : recIndex + step;

  if (next < 0 || next >= recommendations.length) {
    // Walked off either end — back to the guest card.
    recIndex = -1;
    focusSku = recommendations[0]?.sku ?? null;
    if (lastDisplay) await renderCue(cueOf(lastDisplay));
    return;
  }
  await showRecommendation(next);
}

/** The idle screen is our root page: nothing engaged, no carousel, and
 *  nothing voice put on the lens. Everything else is an internal page, where
 *  double-press is ours to use and mode-0 exits would be permitted. */
function onRootPage(): boolean {
  return !engaged && recIndex < 0 && voice.current === "idle";
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
  if (g.source === "ring" && ui.ringStatus) {
    ui.ringStatus.textContent = "ring active";
    ui.ringStatus.className = "pill live";
  }

  switch (g.action) {
    case "click":
      // A click first dismisses whatever voice put on the lens; only then does
      // it mean "I'm done with this guest".
      if (voice.dismiss()) return;
      if (recIndex >= 0) {
        // Back out of the carousel before ending the engagement.
        recIndex = -1;
        if (lastDisplay) void renderCue(cueOf(lastDisplay));
        return;
      }
      if (engaged) {
        socket.emit("session:end");
        void showIdle();
        return;
      }
      // Nothing engaged: press is how you ask a question from the idle screen,
      // because double-press is spoken for there. See onRootPage() below.
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
      if (onRootPage()) {
        void bridge.shutDownPageContainer(1);
        return;
      }
      void voice.toggle({ tenant: TENANT, guestId: engagedGuestId, focusSku });
      return;

    case "scroll-up":
      void cycleRecommendations(-1);
      return;

    case "scroll-down":
      void cycleRecommendations(1);
      return;

    case "exit":
    case "foreground-exit":
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

async function main() {
  bridge = await getBridge();
  ui.bridgeStatus.textContent =
    bridge.kind === "even-app" ? "Even App bridge (native)" : "Mock bridge (virtual lens)";
  ui.bridgeStatus.className = bridge.kind === "even-app" ? "pill ok" : "pill dev";

  const user = (await bridge.getUserInfo()) ?? {};
  // Attribution rides on this. If the Even App won't tell us, everything
  // still works — it just lands unattributed, and the console says so.
  const device = (await bridge.getDeviceInfo()) ?? {};

  voice = new VoiceController({
    bridge,
    emit: (event, payload) => socket?.emit(event, payload),
    render: (lines, meta) => renderCue({ lines, meta }),
    log,
    onState: (state: VoiceState) => {
      ui.voiceStatus.textContent =
        state === "idle" ? "voice ready" : `voice: ${state}`;
      ui.voiceStatus.className =
        state === "listening" ? "pill live" : state === "idle" ? "pill" : "pill dev";
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
  socket.on("connect", () => {
    ui.serverStatus.textContent = "Realtime linked";
    ui.serverStatus.className = "pill ok";
    socket.emit("register", {
      role: "associate",
      // The tenant decides which floor's radio and roster this pair of glasses
      // joins, so it is sent at register rather than waiting for the first
      // guest. An associate who never engages anyone still belongs to a store.
      tenant: TENANT,
      name: `${(user as any).name || "G2 Associate"} [${TENANT}]`,
      zone: ZONE,
      deviceSerial: (device as any).sn || null,
      deviceModel: (device as any).model || null,
    });
  });
  socket.on("disconnect", () => {
    ui.serverStatus.textContent = "Server offline";
    ui.serverStatus.className = "pill warn";
  });
  socket.on("glasses:display", (payload: DisplayPayload) => void onDisplay(payload));
  socket.on("voice:result", (result: VoiceResult) => void voice.onResult(result));
  socket.on("voice:state", (s: { state: string }) => log(`voice state ← ${s.state}`));
  socket.on("radio:message", (m: { from: string; message: string }) => {
    log(`radio ← ${m.from}: ${m.message}`);
    if (!engaged) {
      void renderCue({
        lines: ["RADIO", toDisplayText(m.from), toDisplayText(m.message)],
        meta: [],
      });
      setTimeout(() => { if (!engaged) void showIdle(); }, 6000);
    }
  });

  await showIdle();

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
          socket.emit("beacon:guest-enter", { guestId: g.guest_id, zone: ZONE, tenant: TENANT });
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
