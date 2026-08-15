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

// ---- Live session state, partitioned by tenant (Redis in production) --------
//
// Every field below used to be a single global. That was correct when there was
// one store and a disclosure the moment there were two: floor radio went to one
// `associates` room so a merchant's staff would hear another merchant's traffic,
// and one `dashboard` room meant every manager saw every retailer's roster.
//
// Same shape of mistake as the process-wide Shopify client — state that is fine
// with one customer and wrong with two — so it gets the same treatment: keyed by
// tenant, with the tenant pinned to the socket at register and never taken from
// a later event.

const DEMO_TENANT = "gap";

const associatesRoom = (tenant) => `associates:${tenant}`;
const dashboardRoom = (tenant) => `dashboard:${tenant}`;

function freshState(tenant) {
  return {
    associates: new Map(), // socketId -> { name, zone, status }
    activeSessions: [],    // guest engagements in progress
    radioLog: [],
    voiceLog: [],          // recent voice queries, for the manager view
    // The simulator's three names are demo furniture, so they stay in the demo
    // world. A real retailer opening their dashboard to "Alex R. — $1,240"
    // would reasonably conclude the product is showing them another company's
    // numbers, and would be right to stop the pilot over it.
    leaderboard: tenant === DEMO_TENANT
      ? [
          { name: "Alex R.", sales: 1240, assists: 9 },
          { name: "Jordan M.", sales: 980, assists: 12 },
          { name: "Sam T.", sales: 715, assists: 6 },
        ]
      : [],
    stats: { guestsToday: 0, scriptsServed: 0, radioMessages: 0, voiceQueries: 0 },
  };
}

/** tenant slug -> live state. Created on first sight of a tenant. */
const tenantStates = new Map();

function stateFor(tenant) {
  const key = (tenant || DEMO_TENANT).toLowerCase();
  if (!tenantStates.has(key)) tenantStates.set(key, freshState(key));
  return tenantStates.get(key);
}

/**
 * Pin a socket to one tenant, first value wins.
 *
 * The events carry a `tenant` field because the plugin has always sent one, but
 * a socket that registered as retailer A must not be able to write into
 * retailer B by putting a different slug in a later payload. So the first value
 * seen sticks and every later disagreement is ignored and logged.
 */
function bindTenant(socket, tenant) {
  const next = String(tenant || "").toLowerCase() || null;
  if (!socket.data.tenant) {
    socket.data.tenant = next || DEMO_TENANT;
  } else if (next && next !== socket.data.tenant) {
    console.warn(
      `[cue] ignored tenant '${next}' on a socket already bound to '${socket.data.tenant}'`
    );
  }
  return socket.data.tenant;
}

function dashboardSnapshot(tenant) {
  const state = stateFor(tenant);
  return {
    tenant,
    associates: [...state.associates.values()],
    activeSessions: state.activeSessions.slice(-10),
    radioLog: state.radioLog.slice(-20),
    voiceLog: state.voiceLog.slice(-10),
    leaderboard: [...state.leaderboard].sort((a, b) => b.sales - a.sales),
    stats: state.stats,
  };
}

function broadcastDashboard(tenant) {
  const t = (tenant || DEMO_TENANT).toLowerCase();
  io.to(dashboardRoom(t)).emit("dashboard:update", dashboardSnapshot(t));
}

/**
 * Write an event to the control plane.
 *
 * Fire and forget, deliberately. An associate mid-conversation must not feel
 * a reporting outage: if the analytics write fails, the guest card still
 * renders and the lens still answers. We log it and move on.
 */
async function ingest(path, body) {
  try {
    const res = await fetch(`${AI_SERVICE_URL}/api/ingest/${path}`, {
      method: "POST",
      headers: aiHeaders(AI_API_KEY),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[cue] ingest ${path} → ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[cue] ingest ${path} failed: ${err.message}`);
    return null;
  }
}

// ---- Socket wiring ----------------------------------------------------------
/**
 * A guest has arrived, and this associate is the one who should see them.
 *
 * Extracted from the socket handler so the HTTP front door can call it too.
 * The alternative was for `/api/presence` to emit `beacon:guest-enter` at the
 * client — which does nothing, because the plugin never listens for it; it
 * listens for `glasses:display`. The event name looked right and the guest
 * would simply never have appeared.
 */
async function enterGuest(socket, { guestId, zone, tenant, source } = {}) {
  const t = bindTenant(socket, tenant);
  const state = stateFor(t);
  // Every arrival is a front door, including this one. Recorded before the
  // context call so a guest who checked in still shows as present even if
  // the CRM is having a bad minute.
  void ingest("presence", {
    tenant: t, guest_ref: guestId, zone: zone || "Floor",
    source: source || "demo",
  });
  try {
    const res = await fetch(`${AI_SERVICE_URL}/api/guest-context`, {
      method: "POST",
      headers: aiHeaders(AI_API_KEY),
      body: JSON.stringify({ guest_id: guestId, zone, tenant: t }),
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
    socket.data.guestId = guestId;
    socket.data.focusSku = context.recommendations?.[0]?.sku || null;

    const opened = await ingest("engagement/start", {
      tenant: t,
      guest_ref: guestId,
      zone: zone || "Floor",
      associate_email: socket.data.email,
      device_serial: socket.data.deviceSerial,
      device_model: socket.data.deviceModel,
      // What the glasses are about to show. Sent here rather than derived
      // later because stock moves: "what did we suggest" and "what would we
      // suggest now" are different questions, and only the first is
      // reviewable after the fact.
      recommendations: context.recommendations || [],
      cue_lines: context.script?.cue?.lines || context.script?.glasses_lines || [],
    });
    socket.data.engagementId = opened?.engagement_id || null;

    // Push the monochrome overlay to the requesting associate's glasses...
    socket.emit("glasses:display", {
      // The cue as written for the glass; `lines` is the flat form the
      // manager view and the log use.
      cue: context.script.cue,
      lines: context.script.glasses_lines,
      script: context.script,
      recommendations: context.recommendations,
      guest: {
        guest_id: context.guest.guest_id,
        name: context.guest.name,
        tier: context.guest.loyalty_tier,
        // For the lens fact rail. Sizes and points are what an associate
        // glances at mid-sentence, and the payload carried neither — the
        // rail would have rendered a tier and three blanks.
        points: context.guest.loyalty_points,
        sizes: context.guest.sizes,
        // Customer depth — the cards behind the cue. Passed straight
        // through: the lens decides what fits on a 21-character row, and
        // the server deciding for it is how the rail ended up with facts
        // that did not fit.
        contact: context.guest.contact || null,
        address: context.guest.address || null,
        orders: context.guest.orders || null,
        purchase_history: context.guest.purchase_history || [],
        open_cart_online: context.guest.open_cart_online || [],
      },
    });
    // ...and the full context to the manager view.
    broadcastDashboard(t);
  } catch (err) {
    socket.emit("glasses:display", {
      lines: ["[ICON:WARN] AI service unavailable", String(err.message)],
    });
  }
}

io.on("connection", (socket) => {
  socket.on("register", ({ role, name, zone, email, deviceSerial, deviceModel, tenant,
                          appVersion }) => {
    socket.data.role = role;
    // Register is where a socket picks its tenant. Older plugin builds don't
    // send one here and instead carry it on `beacon:guest-enter` / `voice:start`
    // — `bindTenant` accepts that and pins whichever arrives first, so a client
    // that predates this change still lands in exactly one tenant's rooms.
    const t = bindTenant(socket, tenant);
    const state = stateFor(t);
    // Attribution for the control plane. The glasses identify themselves by
    // serial — the Even SDK exposes no email — and the AI service resolves
    // that to whoever the device is assigned to in Cue Console. Email is the
    // fallback for the simulator and the dashboard's associate view, which do
    // have one. With neither, activity is still recorded against the tenant,
    // just unattributed.
    socket.data.email = email || null;
    socket.data.deviceSerial = deviceSerial || null;
    socket.data.deviceModel = deviceModel || null;
    // Which build is on the glasses. Absent means a client older than 0.1.4,
    // which is itself the answer when an upload appears to have changed
    // nothing.
    socket.data.appVersion = appVersion || null;
    if (role === "dashboard") {
      // A client switching views re-registers; drop any associate identity.
      socket.leave(associatesRoom(t));
      state.associates.delete(socket.id);
      socket.join(dashboardRoom(t));
      socket.emit("dashboard:update", dashboardSnapshot(t));
      broadcastDashboard(t);
    } else if (role === "associate") {
      socket.join(associatesRoom(t));
      state.associates.set(socket.id, {
        id: socket.id,
        name: name || "Associate",
        zone: zone || "Floor",
        status: "available",
        appVersion: socket.data.appVersion,
        deviceModel: socket.data.deviceModel,
        gestures: [],
      });
      broadcastDashboard(t);
    }
  });

  /**
   * Beacon simulation: an opted-in guest's phone enters an associate's zone.
   * Flow: signal -> AI service -> script -> glasses overlay + dashboard.
   */
  socket.on("beacon:guest-enter", (payload) => void enterGuest(socket, payload));

  socket.on("session:end", ({ outcome, saleCents } = {}) => {
    const state = stateFor(socket.data.tenant);
    const associate = state.associates.get(socket.id);
    if (associate) associate.status = "available";
    if (socket.data.engagementId) {
      void ingest("engagement/end", {
        engagement_id: socket.data.engagementId,
        outcome: outcome || "no_sale",
        sale_cents: Number(saleCents) || 0,
      });
    }
    socket.data.engagementId = null;
    socket.data.guestId = null;
    socket.data.focusSku = null;
    broadcastDashboard(socket.data.tenant);
  });

  /** An associate helping someone else's guest. Recorded so the leaderboard
   *  can reward it — a sales-only ranking punishes exactly this behaviour. */
  socket.on("assist:record", ({ note } = {}) => {
    // An assist has to name someone — credit is the entire content of the
    // record. Either identity will do; neither means there is nothing to file.
    if (!socket.data.email && !socket.data.deviceSerial) return;
    void ingest("assist", {
      tenant: socket.data.tenant || DEMO_TENANT,
      helper_email: socket.data.email,
      device_serial: socket.data.deviceSerial,
      device_model: socket.data.deviceModel,
      engagement_id: socket.data.engagementId || null,
      note: note || null,
    });
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
      tenant: bindTenant(socket, tenant),
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
  socket.on("radio:send", ({ from, message, channel, priority } = {}) => {
    const t = socket.data.tenant || DEMO_TENANT;
    const state = stateFor(t);
    const text = String(message ?? "").slice(0, 140).trim();
    if (!text) return;
    const entry = {
      // Message id and sender socket, so a client can recognise its own
      // message coming back. The glasses must not render what the wearer just
      // sent — but the dashboard mirror and the web harness both want the
      // full log, so the echo stays and the plugin filters.
      id: `${socket.id}-${Date.now()}`,
      fromId: socket.id,
      // The roster name wins over anything the client sent. A name is what
      // appears on someone else's glasses in the middle of a shift, and
      // "who is asking for backup" is not a field to take on trust from a
      // browser. `from` survives only for the demo harness, which has no
      // roster entry of its own.
      from: state.associates.get(socket.id)?.name || from || "Unknown",
      message: text,
      channel: channel || "floor",
      // Two tiers, and only two. Anything unrecognised is normal — an unknown
      // value must never be able to take over someone's display.
      priority: priority === "urgent" ? "urgent" : "normal",
      at: new Date().toISOString(),
    };
    state.radioLog.push(entry);
    if (state.radioLog.length > 200) state.radioLog.shift();
    state.stats.radioMessages += 1;
    // One store's floor only. This line is the whole reason for the partition.
    io.to(associatesRoom(t)).emit("radio:message", entry);
    broadcastDashboard(t);
  });

  /**
   * Gesture telemetry.
   *
   * Diagnostic only — nothing branches on it. Whether a temple double tap
   * reaches the plugin as one DOUBLE_CLICK or as two CLICKs is not knowable
   * from outside the device, and that question blocked an evening.
   */
  socket.on("client:gesture", (g = {}) => {
    const state = stateFor(socket.data.tenant);
    const who = state.associates.get(socket.id);
    if (!who) return;
    who.gestures = [
      ...(who.gestures || []),
      { ...g, at: new Date().toISOString() },
    ].slice(-12);
    broadcastDashboard(socket.data.tenant);
  });

  socket.on("sale:record", ({ name, amount }) => {
    const state = stateFor(socket.data.tenant);
    const row = state.leaderboard.find((r) => r.name === name);
    if (row) row.sales += amount;
    else state.leaderboard.push({ name, sales: amount, assists: 0 });
    broadcastDashboard(socket.data.tenant);
  });

  socket.on("disconnect", () => {
    endVoiceSession(socket);
    // An associate whose phone died mid-engagement leaves an open row
    // otherwise, and "average engagement length" quietly becomes fiction.
    if (socket.data.engagementId) {
      void ingest("engagement/end", {
        engagement_id: socket.data.engagementId,
        outcome: "abandoned",
      });
      socket.data.engagementId = null;
    }
    stateFor(socket.data.tenant).associates.delete(socket.id);
    broadcastDashboard(socket.data.tenant);
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

  const state = stateFor(session.tenant);
  state.stats.voiceQueries += 1;
  state.voiceLog.push({
    associate: state.associates.get(socket.id)?.name || "Associate",
    transcript: result.transcript || "",
    intent: result.intent || "error",
    answer: result.answer || "",
    ok: result.ok !== false,
    ms: Date.now() - session.startedAt,
    // Diagnostic, surfaced to the manager view so a level problem on real
    // hardware can be read off without another plugin build.
    levels: result.audio_levels || null,
    at: new Date().toISOString(),
  });
  if (state.voiceLog.length > 100) state.voiceLog.shift();

  void ingest("voice", {
    tenant: session.tenant,
    engagement_id: socket.data.engagementId || null,
    associate_email: socket.data.email,
    device_serial: socket.data.deviceSerial,
    device_model: socket.data.deviceModel,
    intent: result.intent || null,
    ok: result.ok !== false,
    resolved_by: result.resolved_by || null,
    latency_ms: Date.now() - session.startedAt,
    audio_seconds: result.audio_seconds ?? null,
    stt_provider: result.stt_provider || null,
    transcript: result.transcript || null,
    // The answer rides the same privacy flag as the transcript, on the AI
    // service side. Sending it unconditionally and letting the tenant's own
    // setting decide keeps that decision in one place.
    answer: result.answer || null,
  });

  socket.emit("voice:result", result);
  socket.emit("voice:state", { state: "idle" });
  broadcastDashboard(session.tenant);
}

/**
 * Which doors a browser is allowed to claim it came through.
 *
 * The AI service derives `consent` from the source, and the caller cannot
 * override it — but that guarantee is only worth as much as the source. This
 * route is open to the whole internet, so without this set anybody could POST
 * `source: "app-beacon"` and manufacture a `device`-class consent record: the
 * strongest provenance we store, asserted by a stranger with curl.
 *
 * The two plate doors are the only ones a guest's own browser genuinely walks
 * through. Everything else in `app/presence.py`'s SOURCES — the retailer's
 * app, a wallet pass, an order collection, an associate asking — arrives from
 * a system that holds the service key and posts to the AI service directly.
 */
const PUBLIC_SOURCES = new Set(["nfc-plate", "qr-plate"]);

/**
 * The front door a guest's own phone can reach.
 *
 * A plate tap or a QR scan opens a page in the guest's browser. That page
 * cannot hold the service key — nothing in a browser ever does — so it calls
 * here, and this server, which does hold the key, records the arrival and
 * puts the guest on the right associate's glasses.
 *
 * The zone comes from the plate itself. Each plate's URL names where it is
 * mounted, which is why this door needs no beacons, no calibration and no
 * fixture power: an acrylic plate in fitting room three *is* the beacon for
 * fitting room three, and it never needs a battery.
 */
app.post("/api/presence", async (req, res) => {
  const { tenant, guest_ref: guestRef, zone, source } = req.body || {};
  const t = String(tenant || DEMO_TENANT);
  if (!guestRef) return res.status(400).json({ error: "guest_ref is required" });

  const src = String(source || "qr-plate");
  if (!PUBLIC_SOURCES.has(src)) {
    return res.status(400).json({ error: `'${src}' is not a public door` });
  }

  const recorded = await ingest("presence", {
    tenant: t, guest_ref: guestRef, zone: zone || "Floor",
    source: src,
  });
  if (!recorded) {
    return res.status(502).json({ error: "Could not record presence" });
  }

  // Route to whoever is covering that zone. No associate connected is not an
  // error the guest should see — they checked in successfully, and the cue
  // simply has nowhere to land yet.
  const state = stateFor(t);
  const zoneName = zone || "Floor";
  let delivered = 0;
  for (const [socketId, a] of state.associates) {
    if (a.zone && a.zone !== zoneName) continue;
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) continue;
    // The same path a simulated beacon takes — context fetched, cue composed,
    // card pushed to that associate's glasses.
    await enterGuest(sock, { guestId: guestRef, zone: zoneName, tenant: t,
                             source: src });
    delivered += 1;
  }

  res.json({ ok: true, zone: zoneName, source: src,
             consent: recorded.consent, delivered });
});

/**
 * The way out, and it has to be as easy as the way in.
 *
 * A check-in page that can start a session but not end one is a page that
 * asks a guest to trust a promise it does not implement. This closes every
 * live check-in for that guest, across every door — somebody who taps Stop
 * means stop, not "stop for the plate I tapped".
 *
 * Open, like the check-in it undoes. Someone who knows another guest's
 * reference can end that guest's session, which is a denial of presence and
 * not a disclosure: the failure mode is a cue that does not appear, and the
 * alternative — making people prove who they are in order to be forgotten —
 * is worse in every case we care about.
 */
app.post("/api/presence/revoke", async (req, res) => {
  const { tenant, guest_ref: guestRef } = req.body || {};
  if (!guestRef) return res.status(400).json({ error: "guest_ref is required" });

  const closed = await ingest("presence/revoke", {
    tenant: String(tenant || DEMO_TENANT), guest_ref: guestRef,
  });
  if (!closed) return res.status(502).json({ error: "Could not revoke" });
  res.json({ ok: true, closed: closed.closed });
});

app.get("/health", (_req, res) => {
  // Totals across tenants, never a list of slugs — this route is open so the
  // scheduled check can poll it, and the set of tenants is the set of
  // customers. Same rule the AI service's /health follows.
  let associates = 0;
  let voiceQueries = 0;
  for (const state of tenantStates.values()) {
    associates += state.associates.size;
    voiceQueries += state.stats.voiceQueries;
  }
  res.json({
    status: "ok",
    tenants_live: tenantStates.size,
    associates,
    voiceSessions: voiceSessions.size,
    voiceQueries,
  });
});

/**
 * The AI service's own health, relayed.
 *
 * Cue Console needs to show whether Depth is up, but the AI service keeps a
 * CORS allowlist and a browser on a different origin can't read it directly —
 * a healthy service would report as "failed to fetch", which is the exact
 * false alarm a health panel must never produce. This origin is already
 * allowed and already proxies everything else, so relay it here.
 *
 * Unauthenticated, like both /health routes it sits between: it reports
 * configuration state and never tenant data.
 */
app.get("/health/ai", async (_req, res) => {
  try {
    const upstream = await fetch(`${AI_SERVICE_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = await upstream.json();
    res.status(upstream.ok ? 200 : 502).json(body);
  } catch (e) {
    // Reaching the AI service is the question being asked, so a failure here
    // is an answer worth returning cleanly rather than a 500.
    res.status(502).json({ status: "unreachable", error: String(e.message || e) });
  }
});

server.listen(PORT, () =>
  console.log(`[cue] realtime server on :${PORT} (AI: ${AI_SERVICE_URL})`)
);
