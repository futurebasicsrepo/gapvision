/**
 * Cue Lens for Meta Ray-Ban Display — entry.
 *
 * This is a Web App in Meta's sense: it runs ON the glasses, rendered by the
 * glasses' own runtime into the 600×600 in-lens display. There is no phone
 * page and no bridge SDK — the app talks straight to the Cue realtime server
 * over HTTPS, exactly like any browser client.
 *
 * Launch URL carries identity (no camera, no QR pairing on this hardware):
 *   https://lens.cuesea.ai/?t=<associate-token>&tenant=gap&zone=Denim%20Wall
 * The token is remembered in localStorage so subsequent launches need nothing.
 */
import { io, type Socket } from "socket.io-client";
import type { DisplayPayload } from "./types.js";
import { type DeckState, back, deckOf, move, select } from "./deck.js";
import { onGesture } from "./input.js";
import { renderDeck, renderIdle } from "./render.js";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";

const params = new URLSearchParams(location.search);
for (const k of ["t", "tenant", "zone"]) {
  const v = params.get(k);
  if (v) localStorage.setItem(`cue.${k}`, v);
}
const TOKEN = localStorage.getItem("cue.t") || "";
const TENANT = (localStorage.getItem("cue.tenant") || "gap").toLowerCase();
const ZONE = localStorage.getItem("cue.zone") || "Floor";
const TENANT_LABEL = TENANT === "gap" ? "GAP · DEMO" : `${TENANT.toUpperCase()} · LIVE`;

let socket: Socket;
let connected = false;
let deck: DeckState | null = null;
let payload: DisplayPayload | null = null;

const clock = () =>
  new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

function paint() {
  if (deck && payload) renderDeck(deck, payload, clock());
  else renderIdle(clock(), TENANT_LABEL, connected);
}

// Idle clock ticks on the minute only — no wire traffic, no busy repaints.
let lastMinute = "";
setInterval(() => {
  const m = clock();
  if (m !== lastMinute) {
    lastMinute = m;
    if (!deck) paint();
  }
}, 5000);

function endEngagement() {
  deck = null;
  payload = null;
  socket.emit("session:end");
  paint();
}

onGesture((g) => {
  if (!deck) return; // idle: back/select fall through to the system
  if (g === "prev") deck = move(deck, -1);
  else if (g === "next") deck = move(deck, 1);
  else if (g === "up") deck = move(deck, -1);
  else if (g === "down") deck = move(deck, 1);
  else if (g === "back") deck = back(deck);
  else if (g === "select") {
    const r = select(deck);
    deck = r.state;
    if (r.action === "end-engagement") return endEngagement();
    if (r.action === "open-floor") socket.emit("floor:open");
  }
  paint();
});

/** Dev/demo hook: drive the lens without a server (browser console or a
 *  scripted walkthrough on glass). `__cueDemo(payload)` engages; `__cueDemo()`
 *  returns to idle. Gestures work as normal against the demo deck. */
(window as any).__cueDemo = (p?: DisplayPayload) => {
  payload = p ?? null;
  deck = p ? deckOf(p) : null;
  paint();
};

function main() {
  socket = io(SERVER_URL, {
    // WebSocket support on the glasses runtime is undocumented; fetch is not.
    // Start on polling and let socket.io upgrade if the runtime allows it.
    transports: ["polling", "websocket"],
    auth: { token: TOKEN, tenant: TENANT },
  });

  socket.on("connect", () => {
    connected = true;
    socket.emit("register", { role: "associate", name: "Display Associate", zone: ZONE, tenant: TENANT });
    paint();
  });
  socket.on("disconnect", () => {
    connected = false;
    paint();
  });
  socket.on("glasses:display", (p: DisplayPayload) => {
    payload = p;
    deck = deckOf(p);
    paint();
  });
  socket.on("session:ended", endEngagement);

  paint();
}

main();
