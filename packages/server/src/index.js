/**
 * GapVision Realtime Server — the Nervous System.
 *
 * Routes events between associates (glasses/phone clients), the manager
 * dashboard, and the AI service. In-memory state here stands in for Redis;
 * Socket.io stands in for MQTT at production scale.
 */
import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://localhost:8000";
const PORT = process.env.PORT || 4000;

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ---- Live session state (Redis in production) -------------------------------
const state = {
  associates: new Map(), // socketId -> { name, zone, status }
  activeSessions: [],    // guest engagements in progress
  radioLog: [],
  leaderboard: [
    { name: "Alex R.", sales: 1240, assists: 9 },
    { name: "Jordan M.", sales: 980, assists: 12 },
    { name: "Sam T.", sales: 715, assists: 6 },
  ],
  stats: { guestsToday: 0, scriptsServed: 0, radioMessages: 0 },
};

function dashboardSnapshot() {
  return {
    associates: [...state.associates.values()],
    activeSessions: state.activeSessions.slice(-10),
    radioLog: state.radioLog.slice(-20),
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
  socket.on("beacon:guest-enter", async ({ guestId, zone }) => {
    try {
      const res = await fetch(`${AI_SERVICE_URL}/api/guest-context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guest_id: guestId, zone }),
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
    broadcastDashboard();
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
    state.associates.delete(socket.id);
    broadcastDashboard();
  });
});

app.get("/health", (_req, res) =>
  res.json({ status: "ok", associates: state.associates.size })
);

server.listen(PORT, () =>
  console.log(`[gapvision] realtime server on :${PORT} (AI: ${AI_SERVICE_URL})`)
);
