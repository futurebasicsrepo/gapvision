/**
 * Cue Realtime Server — the Nervous System.
 *
 * Routes events between associates (glasses/phone clients), the manager
 * dashboard, and the AI service. In-memory state here stands in for Redis;
 * Socket.io stands in for MQTT at production scale.
 */
import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import { aiHeaders, createAiProxy } from "./proxy.js";

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://localhost:8000";
const AI_API_KEY = process.env.GAPVISION_API_KEY;
const PORT = process.env.PORT || 4000;

const app = express();
app.use(cors());
app.use(express.json());

// Static clients (plugin, dashboard) cannot hold the AI service key, so they
// call us and we attach it server-side. Mounted before the socket wiring.
app.use(createAiProxy({
  aiServiceUrl: AI_SERVICE_URL,
  apiKey: AI_API_KEY,
  allowRoster: process.env.GAPVISION_ALLOW_ROSTER === "true",
}));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ---- Live session state (Redis in production) -------------------------------
const state = {
  associates: new Map(), // socketId -> { name, zone, status }
  activeSessions: [],    // guest engagements in progress
  radioLog: [],
  voiceLog: [],        // recent voice queries, for the manager view
  leaderboard: [
    { name: "Alex R.", sales: 1240, assists: 9 },
    { name: "Jordan M.", sales: 980, assists: 12 },
    { name: "Sam T.", sales: 715, assists: 6 },
  ],
  stats: { guestsToday: 0, scriptsServed: 0, radioMessages: 0, voiceQueries: 0 },
};

function dashboardSnapshot() {
  return {
    associates: [...state.associates.values()],
    activeSessions: state.activeSessions.slice(-10),
    radioLog: state.radioLog.slice(-20),
    voiceLog: state.voiceLog.slice(-10),
    leaderboard: [...state.leaderboard].sort((a, b) => b.sales - a.sales),
    stats: state.stats,
  };
}

function broadcastDashboard() {
  io.to("dashboard").emit("dashboard:update", dashboardSnapshot());
}

// ---- Socket wiring ----------------------------------------------------------
io.on("connection", (socket) => {
  socket.on("register", ({ role, name, zone }) => {
    socket.data.role = role;
    if (role === "dashboard") {
      // A client switching views re-registers; drop any associate identity.
      socket.leave("associates");
      state.associates.delete(socket.id);
      socket.join("dashboard");
      socket.emit("dashboard:update", dashboardSnapshot());
      broadcastDashboard();
    } else if (role === "associate") {
      socket.join("associates");
      state.associates.set(socket.id, {
        id: socket.id,
        name: name || "Associate",
        zone: zone || "Floor",
        status: "available",
      });
      broadcastDashboard();
    }
  });

  /**
   * Beacon simulation: an opted-in guest's phone enters an associate's zone.
   * Flow: signal -> AI service -> script -> glasses overlay + dashboard.
   */
  socket.on("beacon:guest-enter", async ({ guestId, zone, tenant }) => {
    try {
      const res = await fetch(`${AI_SERVICE_URL}/api/guest-context`, {
        method: "POST",
        headers: aiHeaders(AI_API_KEY),
        body: JSON.stringify({ guest_id: guestId, zone, tenant: tenant || "gap" }),
      });
      if (!res.ok) throw new Error(`AI service ${res.status}`);
      const context = await res.json();

      state.stats.guestsToday += 1;
      state.stats.scriptsServed += 1;
      state.activeSessions.push({
        guest: context.guest.name,
        tier: context.guest.loyalty_tier,
        zone: zone || "Floor",
        at: new Date().toISOString(),
      });

      const associate = state.associates.get(socket.id);
      if (associate) associate.status = "engaged";

      // Remember what this associate is looking at. A voice question like
      // "do we have these in a 32" is only answerable because we kept the
      // engaged guest and the product currently on their lens.
      socket.data.tenant = tenant || "gap";
      socket.data.guestId = guestId;
      socket.data.focusSku = context.recommendations?.[0]?.sku || null;

      // Push the monochrome overlay to the requesting associate's glasses...
      socket.emit("glasses:display", {
        lines: context.script.glasses_lines,
        script: context.script,
        recommendations: context.recommendations,
        guest: {
          name: context.guest.name,
          tier: context.guest.loyalty_tier,
        },
      });
      // ...and the full context to the manager view.
      broadcastDashboard();
    } catch (err) {
      socket.emit("glasses:display", {
        lines: ["[ICON:WARN] AI service unavailable", String(err.message)],
      });
    }
  });

  socket.on("session:end", () => {
    const associate = state.associates.get(socket.id);
    if (associate) associate.status = "available";
    socket.data.guestId = null;
    socket.data.focusSku = null;
    broadcastDashboard();
  });

  // ---- Voice queries -------------------------------------------------------
  // The glasses stream raw PCM in small chunks while the mic is open. We
  // buffer per socket, then hand one complete utterance to the AI service.
  // Buffering here (not on the phone) keeps the plugin thin and means a
  // dropped WebView doesn't lose the question mid-flight.

  socket.on("voice:start", ({ tenant, guestId, focusSku, sampleRate } = {}) => {
    endVoiceSession(socket); // a second press restarts rather than interleaves
    const session = {
      chunks: [],
      bytes: 0,
      sampleRate: Number(sampleRate) || 16000,
      tenant: tenant || socket.data.tenant || "gap",
      guestId: guestId ?? socket.data.guestId ?? null,
      focusSku: focusSku ?? socket.data.focusSku ?? null,
      startedAt: Date.now(),
      // Safety net: if the plugin dies with the mic open we still resolve.
      timer: setTimeout(() => void finalizeVoice(socket, "timeout"), MAX_UTTERANCE_MS + 2000),
    };
    voiceSessions.set(socket.id, session);
    socket.emit("voice:state", { state: "listening" });
  });

  socket.on("voice:chunk", ({ b64 } = {}) => {
    const session = voiceSessions.get(socket.id);
    if (!session || typeof b64 !== "string") return;
    if (session.bytes >= MAX_UTTERANCE_BYTES) return; // hard cap, keep draining
    const buf = Buffer.from(b64, "base64");
    session.chunks.push(buf);
    session.bytes += buf.length;
    if (session.bytes >= MAX_UTTERANCE_BYTES) {
      void finalizeVoice(socket, "max-length");
    }
  });

  socket.on("voice:end", () => void finalizeVoice(socket, "end"));

  socket.on("voice:cancel", () => {
    endVoiceSession(socket);
    socket.emit("voice:state", { state: "idle" });
  });

  /** Digital radio: associate-to-associate comms, mirrored to dashboard. */
  socket.on("radio:send", ({ from, message, channel }) => {
    const entry = {
      from: from || state.associates.get(socket.id)?.name || "Unknown",
      message,
      channel: channel || "floor",
      at: new Date().toISOString(),
    };
    state.radioLog.push(entry);
    state.stats.radioMessages += 1;
    io.to("associates").emit("radio:message", entry);
    broadcastDashboard();
  });

  socket.on("sale:record", ({ name, amount }) => {
    const row = state.leaderboard.find((r) => r.name === name);
    if (row) row.sales += amount;
    else state.leaderboard.push({ name, sales: amount, assists: 0 });
    broadcastDashboard();
  });

  socket.on("disconnect", () => {
    endVoiceSession(socket);
    state.associates.delete(socket.id);
    broadcastDashboard();
  });
});

// ---- Voice session plumbing -------------------------------------------------

/** Longest single question we'll buffer: 15s of 16kHz mono 16-bit PCM. */
const MAX_UTTERANCE_MS = 15_000;
const MAX_UTTERANCE_BYTES = 16_000 * 2 * 15;

/** socketId -> { chunks, bytes, tenant, guestId, focusSku, timer, ... } */
const voiceSessions = new Map();

function endVoiceSession(socket) {
  const session = voiceSessions.get(socket.id);
  if (!session) return null;
  clearTimeout(session.timer);
  voiceSessions.delete(socket.id);
  return session;
}

async function finalizeVoice(socket, reason) {
  const session = endVoiceSession(socket);
  if (!session) return;

  const audio = Buffer.concat(session.chunks, session.bytes);
  socket.emit("voice:state", { state: "thinking", bytes: audio.length, reason });

  let result;
  try {
    const res = await fetch(`${AI_SERVICE_URL}/api/voice-query`, {
      method: "POST",
      headers: aiHeaders(AI_API_KEY),
      body: JSON.stringify({
        tenant: session.tenant,
        audio_b64: audio.toString("base64"),
        sample_rate: session.sampleRate,
        guest_id: session.guestId,
        focus_sku: session.focusSku,
      }),
    });
    if (!res.ok) throw new Error(`AI service ${res.status}`);
    result = await res.json();
  } catch (err) {
    result = {
      ok: false,
      intent: "error",
      transcript: "",
      answer: String(err.message),
      glasses_lines: ["[ICON:WARN] Voice service unavailable", String(err.message)],
    };
  }

  state.stats.voiceQueries += 1;
  state.voiceLog.push({
    associate: state.associates.get(socket.id)?.name || "Associate",
    transcript: result.transcript || "",
    intent: result.intent || "error",
    answer: result.answer || "",
    ok: result.ok !== false,
    ms: Date.now() - session.startedAt,
    at: new Date().toISOString(),
  });
  if (state.voiceLog.length > 100) state.voiceLog.shift();

  socket.emit("voice:result", result);
  socket.emit("voice:state", { state: "idle" });
  broadcastDashboard();
}

app.get("/health", (_req, res) =>
  res.json({
    status: "ok",
    associates: state.associates.size,
    voiceSessions: voiceSessions.size,
    voiceQueries: state.stats.voiceQueries,
  })
);

server.listen(PORT, () =>
  console.log(`[cue] realtime server on :${PORT} (AI: ${AI_SERVICE_URL})`)
);
