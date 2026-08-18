/**
 * The audio a phone actually sends.
 *
 * These four functions are the whole difference between "the associate asked a
 * question" and "the transcriber received noise". None of them are visible in
 * the UI, and all of them fail silently: wrong endianness, a wrapped clip or a
 * mis-scaled sample all produce audio that plays back as *something*, gets
 * transcribed as *something else*, and surfaces as "voice is inaccurate"
 * rather than as a bug with a location.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { toPcm16, toBase64, levelOf, micSupported } from "../.test-dist/voice.js";

test("silence is silence, not a DC offset", () => {
  const bytes = toPcm16(new Float32Array([0, 0, 0, 0]));
  assert.equal(bytes.length, 8);
  assert.deepEqual([...bytes], [0, 0, 0, 0, 0, 0, 0, 0]);
});

test("samples are written little-endian, which is what the WAV header claims", () => {
  // `stt.pcm_to_wav` writes a header saying 16-bit LE. Big-endian bytes under
  // that header are not a decode error — they are quiet, wrong-sounding audio.
  const bytes = toPcm16(new Float32Array([1]));
  const view = new DataView(bytes.buffer);
  assert.equal(view.getInt16(0, true), 0x7fff, "full scale, read as LE");
});

test("a clipped sample saturates rather than wrapping", () => {
  // Wrapping turns the loudest moment of a sentence — the one carrying the
  // noun — into a full-amplitude inversion. Whisper hears a click.
  const hot = toPcm16(new Float32Array([2.5, -2.5]));
  const view = new DataView(hot.buffer);
  assert.equal(view.getInt16(0, true), 0x7fff);
  assert.equal(view.getInt16(2, true), -0x8000);
});

test("the negative floor uses the full range, so quiet audio is not quieter", () => {
  const view = new DataView(toPcm16(new Float32Array([-1])).buffer);
  assert.equal(view.getInt16(0, true), -0x8000);
});

test("base64 survives a buffer larger than the argument limit", () => {
  // 4096 samples is one frame; the naive `String.fromCharCode(...bytes)` throws
  // on buffers this size in some engines and silently truncates in others.
  const big = toPcm16(new Float32Array(4096).fill(0.5));
  const b64 = toBase64(big);
  assert.equal(Buffer.from(b64, "base64").length, 8192);
});

test("level is zero for silence and rises with speech", () => {
  assert.equal(levelOf(new Float32Array(64)), 0);
  const quiet = levelOf(new Float32Array(64).fill(0.02));
  const loud = levelOf(new Float32Array(64).fill(0.4));
  assert.ok(loud > quiet, `${loud} should exceed ${quiet}`);
});

test("level ignores sign — a waveform is loud in both directions", () => {
  const alternating = Float32Array.from({ length: 64 }, (_, i) => (i % 2 ? 0.5 : -0.5));
  assert.ok(levelOf(alternating) > 0.4, "a symmetric wave must not average to zero");
});

test("an empty frame has no level rather than NaN", () => {
  // A NaN width lands in `style.width` as garbage and the meter simply stops,
  // which reads as a dead microphone.
  assert.equal(levelOf(new Float32Array(0)), 0);
});

test("a browser with no getUserMedia reports unsupported rather than throwing", () => {
  assert.equal(micSupported(), false, "node has no mediaDevices; this must not throw");
});
