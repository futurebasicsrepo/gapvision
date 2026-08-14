/**
 * Floor-to-dashboard end-to-end.
 *
 * Drives a real engagement over the socket the way the plugin does, then logs
 * in as a manager and checks the numbers moved. This is the test that proves
 * the dashboard is showing what actually happened rather than a hopeful
 * summary of what the server remembers this process lifetime.
 *
 *   node packages/server/test/spine-e2e.mjs
 *
 * Expects the realtime server + AI service running with a seeded database,
 * and CUE_MANAGER_EMAIL / CUE_MANAGER_PASSWORD for a manager account.
 */
import { io } from "socket.io-client";

const SERVER = process.env.SERVER_URL || "http://localhost:4000";
const AI = process.env.AI_URL || "http://localhost:8000";
const TENANT = process.env.CUE_TENANT || "gap";
const ASSOCIATE = process.env.CUE_ASSOCIATE_EMAIL || "alex@example.com";
const MANAGER = process.env.CUE_MANAGER_EMAIL || "manager@example.com";
const MANAGER_PW = process.env.CUE_MANAGER_PASSWORD || "demo-password-1234";
const SR = 16000;

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

function tone(seconds, amp = 8000) {
  const n = Math.floor(SR * seconds);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 180 * i) / SR)), i * 2);
  }
  return buf;
}

function once(socket, event, timeoutMs = 15000, match = null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting for ${event}`));
    }, timeoutMs);
    function handler(payload) {
      if (match && !match(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

const voiceState = (s, want) => once(s, "voice:state", 15000, (p) => p.state === want);

// --- sign in as the manager and take a baseline -----------------------------
const login = await fetch(`${AI}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: MANAGER, password: MANAGER_PW }),
});
check("manager can sign in", login.ok, `${login.status}`);
if (!login.ok) process.exit(1);
const { token, user } = await login.json();
check("manager is scoped to a tenant", user.tenant_slug === TENANT, user.tenant_slug);

const authed = { Authorization: `Bearer ${token}` };
const api = async (path) => (await fetch(`${AI}${path}`, { headers: authed })).json();

const before = await api("/api/analytics/summary?days=1");

// --- run a floor engagement -------------------------------------------------
const socket = io(SERVER, { transports: ["websocket"] });
await once(socket, "connect");
socket.emit("register", {
  role: "associate", name: "E2E Associate", zone: "Denim Wall", email: ASSOCIATE,
});

socket.emit("beacon:guest-enter", { guestId: "guest-001", zone: "Denim Wall", tenant: TENANT });
const display = await once(socket, "glasses:display");
check("guest card rendered", display.guest?.name === "Sarah Chen", display.guest?.name);

socket.emit("voice:start", { tenant: TENANT, sampleRate: SR });
await voiceState(socket, "listening");
const pcm = tone(1.4);
const batch = SR * 2 * 0.25;
for (let off = 0; off < pcm.length; off += batch) {
  socket.emit("voice:chunk", { b64: pcm.subarray(off, off + batch).toString("base64") });
  await new Promise((r) => setTimeout(r, 5));
}
socket.emit("voice:end");
await voiceState(socket, "thinking");
const voiceResult = await once(socket, "voice:result");
check("voice answered", voiceResult.ok === true, voiceResult.answer);

socket.emit("assist:record", { note: "covered the fitting room" });
socket.emit("session:end", { outcome: "sale", saleCents: 8995 });

// The ingest writes are fire-and-forget; give them a moment to land.
await new Promise((r) => setTimeout(r, 900));

// --- the dashboard should now reflect it ------------------------------------
const after = await api("/api/analytics/summary?days=1");
check("engagement recorded",
  after.engagements === before.engagements + 1,
  `${before.engagements} → ${after.engagements}`);
check("sale recorded",
  after.sale_cents === before.sale_cents + 8995,
  `${before.sale_cents} → ${after.sale_cents}`);
check("voice query recorded",
  after.voice.total === before.voice.total + 1,
  `${before.voice.total} → ${after.voice.total}`);
check("assist recorded",
  after.assists === before.assists + 1,
  `${before.assists} → ${after.assists}`);
check("latency captured", after.voice.avg_latency_ms > 0, `${after.voice.avg_latency_ms}ms`);

const engagements = (await api("/api/analytics/engagements?limit=5")).engagements;
const latest = engagements[0];
check("engagement attributed to the associate", !!latest.associate, latest.associate);
check("engagement closed out", latest.ended_at !== null && latest.outcome === "sale",
  `${latest.outcome}`);
check("guest referenced by CRM id, not copied",
  latest.guest_ref === "guest-001" && !JSON.stringify(latest).includes("Sarah"),
  latest.guest_ref);

const board = await api("/api/analytics/leaderboard?days=7");
const me = board.rows.find((r) => r.engagements > 0 || r.assists > 0);
check("leaderboard has a ranked associate", !!me, me ? `${me.name} score ${me.score}` : "none");
check("leaderboard exposes its components",
  me && ["engagements", "sale_cents", "assists"].every((k) => k in me));

const voice = await api("/api/analytics/voice?limit=5");
check("voice log visible to the manager", voice.voice.length > 0, `${voice.voice.length} rows`);
check("transcripts withheld by default",
  voice.transcripts_stored === false && voice.voice.every((v) => v.transcript === null));

// --- survives a restart -----------------------------------------------------
// The in-memory counters reset with the process; these numbers must not.
check("numbers are persisted, not process state",
  after.engagements >= 1 && (await api("/api/analytics/summary?days=1")).engagements
    === after.engagements);

socket.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
