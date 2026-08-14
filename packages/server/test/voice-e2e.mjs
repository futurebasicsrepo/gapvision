/**
 * End-to-end check of the voice path against a live realtime server + AI
 * service. Drives the exact socket sequence the plugin emits, with synthetic
 * 16 kHz PCM standing in for the glasses mic.
 *
 *   node packages/server/test/voice-e2e.mjs
 *
 * Expects both services already running (see the header of the run script).
 */
import { io } from "socket.io-client";

const SERVER = process.env.SERVER_URL || "http://localhost:4000";
const SR = 16000;

function tone(seconds, amp = 8000) {
  const n = Math.floor(SR * seconds);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 180 * i) / SR)), i * 2);
  }
  return buf;
}

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, ok: !!condition, detail });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function once(socket, event, timeoutMs = 15000, match = null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => { socket.off(event, handler); reject(new Error(`timeout waiting for ${event}`)); },
      timeoutMs,
    );
    function handler(payload) {
      if (match && !match(payload)) return; // skip states from a previous step
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

/** Wait for a specific voice state, ignoring any still in flight. */
const voiceState = (socket, want) =>
  once(socket, "voice:state", 15000, (p) => p.state === want);

/** Stream PCM the way the plugin does: ~250 ms batches. */
async function speak(socket, pcm) {
  const batch = SR * 2 * 0.25;
  for (let off = 0; off < pcm.length; off += batch) {
    socket.emit("voice:chunk", { b64: pcm.subarray(off, off + batch).toString("base64") });
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Counters are process-lifetime, so assert on the delta this run produces.
const baseline = await (await fetch(`${SERVER}/health`)).json();

const socket = io(SERVER, { transports: ["websocket"] });
await once(socket, "connect");
socket.emit("register", { role: "associate", name: "E2E Associate", zone: "Denim Wall" });

// 1. Beacon first, so the server holds guest + focus context.
socket.emit("beacon:guest-enter", { guestId: "guest-001", zone: "Denim Wall", tenant: "gap" });
const display = await once(socket, "glasses:display");
check("beacon returns guest context", display.guest?.name === "Sarah Chen", display.guest?.name);

// 2. A voice query with real audio.
socket.emit("voice:start", { tenant: "gap", sampleRate: SR });
const listening = await voiceState(socket, "listening");
check("server acks listening", listening.state === "listening", listening.state);

await speak(socket, tone(1.4));
socket.emit("voice:end");

const thinking = await voiceState(socket, "thinking");
check("server acks thinking", thinking.state === "thinking", `${thinking.bytes} bytes`);
check("all audio arrived intact", thinking.bytes === Math.floor(SR * 1.4) * 2, String(thinking.bytes));

const result = await once(socket, "voice:result");
check("voice result ok", result.ok === true, result.answer);
check("transcript present", !!result.transcript, result.transcript);
check("glasses lines rendered", (result.glasses_lines || []).length > 1,
  JSON.stringify(result.glasses_lines));
check("context carried from beacon",
  result.intent !== "error" && !/No guest is engaged/.test(result.answer || ""), result.intent);

// 3. Silence must come back as a rendered failure, not a crash.
socket.emit("voice:start", { tenant: "gap", sampleRate: SR });
await voiceState(socket, "listening");
await speak(socket, Buffer.alloc(SR * 2 * 1)); // 1s of digital silence
socket.emit("voice:end");
await voiceState(socket, "thinking");
const quiet = await once(socket, "voice:result");
check("silence returns a soft failure", quiet.ok === false, quiet.answer);
check("silence still renders a line", (quiet.glasses_lines || [])[0]?.includes("ICON:WARN"),
  JSON.stringify(quiet.glasses_lines));

// 4. Cancel path leaves no session behind.
socket.emit("voice:start", { tenant: "gap", sampleRate: SR });
await voiceState(socket, "listening");
socket.emit("voice:cancel");
const cancelled = await voiceState(socket, "idle");
check("cancel returns to idle", cancelled.state === "idle", cancelled.state);

const health = await (await fetch(`${SERVER}/health`)).json();
check("no dangling voice sessions", health.voiceSessions === 0, JSON.stringify(health));
check("voice queries counted", health.voiceQueries - baseline.voiceQueries === 2,
  `${baseline.voiceQueries} → ${health.voiceQueries}`);

socket.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
