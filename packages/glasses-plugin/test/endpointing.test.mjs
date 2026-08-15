/**
 * Endpointing, replayed against real hardware measurements.
 *
 *   node packages/glasses-plugin/test/endpointing.test.mjs
 *
 * The old logic closed the mic when the frame level fell below a constant,
 * 0.012. On a real G2 in a real room that never happened: across 12.2 s of
 * audio the *quietest* frame was 0.014, so zero frames in 122 counted as
 * silence and every question ran to the 12 s hard cap. Thirteen seconds
 * standing in front of a customer.
 *
 * The envelopes below are built from levels the AI service measured on two
 * actual utterances (2026-08-15), so this test fails against the constant and
 * passes against a threshold relative to the utterance's own peak.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The module is TypeScript; pull the two pure functions out by evaluating the
// constants directly rather than adding a build step to a unit test.
const src = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "voice.ts"),
  "utf8",
);
const num = (name) => {
  // `12_000` is a valid literal and `[0-9.]+` stops at the underscore, which
  // silently turned a 12-second cap into 12 milliseconds.
  const m = src.match(new RegExp(`const ${name} = ([0-9._]+)`));
  assert.ok(m, `${name} not found in voice.ts`);
  return Number(m[1].replace(/_/g, ""));
};
const SILENCE_FLOOR = num("SILENCE_FLOOR");
const SPEECH_ON = num("SPEECH_ON");
const SPEECH_OFF = num("SPEECH_OFF");
const MIN_UTTERANCE_MS = num("MIN_UTTERANCE_MS");
const SILENCE_HANGOVER_MS = num("SILENCE_HANGOVER_MS");
const MAX_UTTERANCE_MS = num("MAX_UTTERANCE_MS");

const speechThreshold = (peak, started) =>
  Math.max(SILENCE_FLOOR, peak * (started ? SPEECH_OFF : SPEECH_ON));
const isSpeaking = (level, peak, started) => level >= speechThreshold(peak, started);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/** Run an envelope (one level per 100 ms) through the endpointing rule.
 *  Returns the ms at which the mic would close, or the cap. */
function runEndpointing(env, frameMs = 100) {
  let peak = 0, heardSpeech = false, lastVoiceAt = 0, elapsed = 0;
  for (const level of env) {
    elapsed += frameMs;
    peak = Math.max(peak, level);
    if (isSpeaking(level, peak, heardSpeech)) {
      heardSpeech = true;
      lastVoiceAt = elapsed;
    }
    const quietFor = elapsed - lastVoiceAt;
    if (heardSpeech && elapsed > MIN_UTTERANCE_MS && quietFor > SILENCE_HANGOVER_MS) {
      return { closedAt: elapsed, reason: "silence" };
    }
    if (elapsed >= MAX_UTTERANCE_MS) return { closedAt: elapsed, reason: "max-length" };
  }
  return { closedAt: elapsed, reason: "ran-out" };
}

/** Build an envelope with a given ambient floor, speech band and peak. */
function envelope({ ambient, speechLow, peak, speechFrames, tailFrames, leadFrames = 3 }) {
  const env = [];
  for (let i = 0; i < leadFrames; i++) env.push(ambient);
  for (let i = 0; i < speechFrames; i++) {
    // Alternate through the speech band, hitting the peak periodically, and
    // include short intra-word dips at ambient — the thing hysteresis exists
    // to survive.
    env.push(i % 7 === 3 ? ambient * 1.2 : i % 3 === 0 ? peak : speechLow);
  }
  for (let i = 0; i < tailFrames; i++) env.push(ambient);
  return env;
}

// --- the two real utterances -------------------------------------------------
// Measured: min / p10 / median / p90 / max, and the last 1 s of each.

const REAL = [
  {
    name: '"Can you show me black pants in size thirty three?"',
    ambient: 0.0281,   // median — the room, between words
    speechLow: 0.11,
    peak: 0.38431,
    speechFrames: 45,
    tailFrames: 15,    // measured tail sat 0.014–0.031, i.e. at ambient
  },
  {
    name: '"Can you show me a white t shirt?"',
    ambient: 0.0221,
    speechLow: 0.09,
    peak: 0.38753,
    speechFrames: 38,
    tailFrames: 15,
  },
];

for (const u of REAL) {
  const env = envelope(u);
  const { closedAt, reason } = runEndpointing(env);
  check(`${u.name} closes on silence, not the cap`,
    reason === "silence", `closed at ${closedAt}ms via ${reason}`);
  // Speech ends at leadFrames+speechFrames; hangover is 900ms, so it should
  // close within ~1.2s of the last word.
  const speechEndsMs = (3 + u.speechFrames) * 100;
  check(`${u.name} closes promptly after the last word`,
    closedAt - speechEndsMs <= 1300,
    `${closedAt - speechEndsMs}ms after speech ended`);
}

// --- what the old constant did ----------------------------------------------
{
  const u = REAL[0];
  const env = envelope(u);
  // The old rule: quiet means below the absolute floor.
  let heard = false, lastVoiceAt = 0, elapsed = 0, closed = null;
  for (const level of env) {
    elapsed += 100;
    if (level >= SILENCE_FLOOR) { heard = true; lastVoiceAt = elapsed; }
    if (heard && elapsed > MIN_UTTERANCE_MS && elapsed - lastVoiceAt > SILENCE_HANGOVER_MS) {
      closed = elapsed; break;
    }
  }
  check("the old absolute floor never detects silence in this room",
    closed === null,
    closed === null ? "ran to the cap, as observed on hardware" : `closed at ${closed}ms`);
}

// --- it must not cut people off ---------------------------------------------
{
  // A pause for breath mid-sentence: 500 ms at ambient, then more speech.
  const env = [
    ...Array(3).fill(0.028),
    ...Array(15).fill(0.30),
    ...Array(5).fill(0.028),   // 500 ms pause — under the 900 ms hangover
    ...Array(15).fill(0.30),
    ...Array(15).fill(0.028),
  ];
  const { closedAt } = runEndpointing(env);
  check("a 500ms pause mid-sentence does not end the question",
    closedAt > (3 + 15 + 5 + 15) * 100, `closed at ${closedAt}ms`);
}

// --- a quiet room still works ------------------------------------------------
{
  const env = envelope({ ambient: 0.0008, speechLow: 0.05, peak: 0.14,
                         speechFrames: 20, tailFrames: 15 });
  const { reason } = runEndpointing(env);
  check("a quiet room with quiet speech still endpoints", reason === "silence");
}

// --- a loud shop floor -------------------------------------------------------
{
  // Ambient four times louder than Kyle's room; speech scales with it.
  const env = envelope({ ambient: 0.09, speechLow: 0.32, peak: 0.85,
                         speechFrames: 25, tailFrames: 15 });
  const { reason } = runEndpointing(env);
  check("a loud floor endpoints too — the threshold scales with the room",
    reason === "silence");
}

// --- silence never becomes speech -------------------------------------------
{
  const env = Array(40).fill(0.004);   // mic open, nobody talking
  let heard = false, peak = 0;
  for (const l of env) { peak = Math.max(peak, l); if (isSpeaking(l, peak, heard)) heard = true; }
  check("an empty room never registers as speech", !heard);
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
