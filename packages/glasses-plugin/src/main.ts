/**
 * Cue — Even Hub plugin entry.
 *
 * Runs in the Even App WebView on the associate's phone. Connects to the
 * Cue realtime server, renders guest context to the glasses via the
 * Even Hub bridge, and maps temple gestures to session actions.
 *
 * In a plain browser this same file runs against the MockBridge and renders
 * to the on-page virtual lens — the full flow is testable with zero hardware.
 */
import { io, type Socket } from "socket.io-client";
import { getBridge, type GlassesBridge } from "./bridge";
import { buildPage, IDLE_LINES, MAX_LINES, toDisplayText } from "./layout";
import { VoiceController, type VoiceResult, type VoiceState } from "./voice";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";
const AI_URL = import.meta.env.VITE_AI_URL || "http://localhost:8000";

/** Tenant = which retail world this launch belongs to ("gap" demo | "shopify"
 *  live). Carried by the launch URL, i.e. the QR code that opened us. */
const TENANT =
  new URLSearchParams(window.location.search).get("tenant")?.toLowerCase() || "gap";
const TENANT_LABEL = TENANT === "shopify" ? "FUTURE BASICS · LIVE" : "GAP · DEMO";
const ZONE = TENANT === "shopify" ? "Front Table" : "Denim Wall";

type DisplayPayload = {
  lines: string[];
  script?: { opener: string; upsell: string; closer: string };
  guest?: { name: string; tier: string; guest_id?: string };
  recommendations?: { sku: string; name: string }[];
};

const ui = {
  bridgeStatus: document.getElementById("bridge-status")!,
  serverStatus: document.getElementById("server-status")!,
  voiceStatus: document.getElementById("voice-status")!,
  sessionInfo: document.getElementById("session-info")!,
  log: document.getElementById("event-log")!,
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

async function renderLines(lines: string[], status: string) {
  const page = buildPage(lines, status);
  const sameShape =
    pageBuilt && lines.slice(0, MAX_LINES).length === currentLines.slice(0, MAX_LINES).length;

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
  await renderLines(
    [IDLE_LINES[0], TENANT_LABEL, "", "Awaiting guest signal..."],
    "BLE OK · zone: " + ZONE
  );
  ui.sessionInfo.textContent = "No active session";
}

async function onDisplay(payload: DisplayPayload) {
  engaged = true;
  lastDisplay = payload;
  engagedGuestId = payload.guest?.guest_id ?? engagedGuestId;
  focusSku = payload.recommendations?.[0]?.sku ?? focusSku;
  await renderLines(payload.lines, "press: done · 2x: ask");
  ui.sessionInfo.textContent = payload.guest
    ? `Engaged: ${payload.guest.name} (${payload.guest.tier})`
    : "Engaged";
  log(`display ← ${payload.guest?.name ?? "server"} (${payload.lines.length} lines)`);
}

/** Restore whatever was on the lens before a voice interaction took it over. */
async function restoreView() {
  if (engaged && lastDisplay) {
    await renderLines(lastDisplay.lines, "press: done · 2x: ask");
  } else {
    await showIdle();
  }
}

/** Temple gestures → session actions. Mapping is intentionally minimal for pilot. */
function onGesture(gesture: string) {
  log(`gesture: ${gesture}`);
  if (gesture === "press") {
    // A press first dismisses whatever voice put on the lens; only then does
    // it mean "I'm done with this guest".
    if (voice.dismiss()) return;
    if (engaged) {
      socket.emit("session:end");
      void showIdle();
    }
  } else if (gesture === "double-press") {
    void voice.toggle({ tenant: TENANT, guestId: engagedGuestId, focusSku });
  }
  // swipe-up / swipe-down reserved for radio channel cycling.
}

async function main() {
  bridge = await getBridge();
  ui.bridgeStatus.textContent =
    bridge.kind === "even-app" ? "Even App bridge (native)" : "Mock bridge (virtual lens)";
  ui.bridgeStatus.className = bridge.kind === "even-app" ? "pill ok" : "pill dev";

  const user = (await bridge.getUserInfo()) ?? {};

  voice = new VoiceController({
    bridge,
    emit: (event, payload) => socket?.emit(event, payload),
    render: (lines, status) => renderLines(lines, status),
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
    if (event.mockGesture) return onGesture(event.mockGesture);
    if (event.audioEvent) return voice.onAudioChunk(event.audioEvent.audioPcm);
    // Real-device events: first text container is the capture target.
    if (event.textEvent) return onGesture("press");
    if (event.listEvent) return onGesture("press");
  });

  socket = io(SERVER_URL);
  socket.on("connect", () => {
    ui.serverStatus.textContent = "Realtime linked";
    ui.serverStatus.className = "pill ok";
    socket.emit("register", {
      role: "associate",
      name: `${(user as any).name || "G2 Associate"} [${TENANT}]`,
      zone: ZONE,
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
      void renderLines(
        ["◉ RADIO", "", toDisplayText(`${m.from}:`), m.message.slice(0, 40)],
        "press: dismiss"
      );
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
      const res = await fetch(`${AI_URL}/api/guests?tenant=${TENANT}`);
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
