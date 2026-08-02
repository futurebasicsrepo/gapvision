/**
 * GapVision — Even Hub plugin entry.
 *
 * Runs in the Even App WebView on the associate's phone. Connects to the
 * GapVision realtime server, renders guest context to the glasses via the
 * Even Hub bridge, and maps temple gestures to session actions.
 *
 * In a plain browser this same file runs against the MockBridge and renders
 * to the on-page virtual lens — the full flow is testable with zero hardware.
 */
import { io, type Socket } from "socket.io-client";
import { getBridge, type GlassesBridge } from "./bridge";
import { buildPage, IDLE_LINES, MAX_LINES, toDisplayText } from "./layout";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";
const ZONE = "Denim Wall"; // pilot: assigned per associate at login

type DisplayPayload = {
  lines: string[];
  script?: { opener: string; upsell: string; closer: string };
  guest?: { name: string; tier: string };
};

const ui = {
  bridgeStatus: document.getElementById("bridge-status")!,
  serverStatus: document.getElementById("server-status")!,
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
let currentLines: string[] = [];
let pageBuilt = false;
let engaged = false;

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
  await renderLines(IDLE_LINES, "BLE OK · zone: " + ZONE);
  ui.sessionInfo.textContent = "No active session";
}

async function onDisplay(payload: DisplayPayload) {
  engaged = true;
  await renderLines(payload.lines, "press: done · hold: ask");
  ui.sessionInfo.textContent = payload.guest
    ? `Engaged: ${payload.guest.name} (${payload.guest.tier})`
    : "Engaged";
  log(`display ← ${payload.guest?.name ?? "server"} (${payload.lines.length} lines)`);
}

/** Temple gestures → session actions. Mapping is intentionally minimal for pilot. */
function onGesture(gesture: string) {
  log(`gesture: ${gesture}`);
  if (gesture === "press" && engaged) {
    socket.emit("session:end");
    void showIdle();
  } else if (gesture === "double-press") {
    // Reserved: voice inventory query (audioControl + STT stream). Phase 2.
    void bridge.audioControl(true).then(() => {
      log("mic open (voice query stub) — closing in 3s");
      setTimeout(() => void bridge.audioControl(false), 3000);
    });
  }
  // swipe-up / swipe-down reserved for radio channel cycling.
}

async function main() {
  bridge = await getBridge();
  ui.bridgeStatus.textContent =
    bridge.kind === "even-app" ? "Even App bridge (native)" : "Mock bridge (virtual lens)";
  ui.bridgeStatus.className = bridge.kind === "even-app" ? "pill ok" : "pill dev";

  const user = (await bridge.getUserInfo()) ?? {};

  bridge.onEvenHubEvent((event: any) => {
    if (event.mockGesture) return onGesture(event.mockGesture);
    // Real-device events: first text container is the capture target.
    if (event.textEvent) return onGesture("press");
    if (event.listEvent) return onGesture("press");
    if (event.audioEvent) log(`audio chunk: ${event.audioEvent.audioPcm?.length ?? 0} bytes`);
  });

  socket = io(SERVER_URL);
  socket.on("connect", () => {
    ui.serverStatus.textContent = "Realtime linked";
    ui.serverStatus.className = "pill ok";
    socket.emit("register", {
      role: "associate",
      name: (user as any).name || "G2 Associate",
      zone: ZONE,
    });
  });
  socket.on("disconnect", () => {
    ui.serverStatus.textContent = "Server offline";
    ui.serverStatus.className = "pill warn";
  });
  socket.on("glasses:display", (payload: DisplayPayload) => void onDisplay(payload));
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

  // Dev-only: simulate an opt-in beacon from the phone page.
  document.querySelectorAll<HTMLButtonElement>("[data-beacon]").forEach((btn) =>
    btn.addEventListener("click", () => {
      socket.emit("beacon:guest-enter", { guestId: btn.dataset.beacon, zone: ZONE });
      log(`beacon → ${btn.dataset.beacon}`);
    })
  );
}

void main();
