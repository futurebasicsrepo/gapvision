/**
 * CueSea voice client — double-press the temple, ask, read the answer in-lens.
 *
 * Flow
 *   double-press -> audioControl(true, glasses)
 *                -> audioEvent chunks (16 kHz mono 16-bit LE PCM)
 *                -> batched to the realtime server over the existing socket
 *                -> silence or cap ends the utterance
 *                -> server -> STT -> answer -> `voice:result` -> lens
 *
 * The three things that make this usable on a sales floor:
 *
 *   1. Endpointing on-device. The associate has one hand on a folded sweater;
 *      they cannot press again to stop. We watch amplitude and close the mic
 *      ~900 ms after they stop talking, with a hard 12 s cap so a stuck mic
 *      can't stream forever.
 *   2. A live level meter in the lens. Voice UI with no feedback feels broken
 *      the moment it mishears; showing amplitude proves the mic is open.
 *   3. Batched chunks. The host emits PCM in small buffers; sending each one
 *      as its own socket frame floods a store's wifi. We coalesce to ~250 ms.
 */
import type { GlassesBridge } from "./bridge";

/** Host contract: 16 kHz mono 16-bit little-endian PCM. */
export const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;

const FLUSH_MS = 250;
const FLUSH_BYTES = 8_192;
/** Stop this long after speech drops below the floor. */
const SILENCE_HANGOVER_MS = 900;
/** Don't endpoint before this — people pause before the noun. */
const MIN_UTTERANCE_MS = 700;
/** Hard cap; the server enforces its own at 15 s. */
const MAX_UTTERANCE_MS = 12_000;
/** Mean amplitude (0-1) below which a frame counts as silence. */
/**
 * Absolute floor. Below this nothing counts as speech however loud the room
 * seems — it stops a silent mic's own hiss from reading as a voice.
 *
 * It is NOT the silence threshold. It used to be: the mic closed when the
 * level fell under this constant. Measured on a real G2 in a real room, the
 * quietest frame across 12.2 s of audio was 0.014 — above it. Not one frame in
 * 122 ever counted as silence, so the mic never closed and every question ran
 * to the 12 s cap. A constant cannot work here: this room's noise floor sits
 * at ~0.02 and a shop floor is louder still.
 */
const SILENCE_FLOOR = 0.012;

/**
 * Speech is judged against how loud *this* utterance is, not against a number
 * chosen in a quiet office. Measured levels from that same session: ambient
 * ~0.02, speech peaks 0.38 — a 15:1 ratio that survives being scaled by the
 * room. Two thresholds with hysteresis, so a natural pause mid-sentence does
 * not end the question but a real stop does.
 */
const SPEECH_ON = 0.35;   // of peak — must be clearly talking to start
const SPEECH_OFF = 0.20;  // of peak — quieter than this counts as stopped

/** Exported for the unit test, which replays real captured envelopes. */
export function speechThreshold(peak: number, started: boolean): number {
  return Math.max(SILENCE_FLOOR, peak * (started ? SPEECH_OFF : SPEECH_ON));
}

export function isSpeaking(level: number, peak: number, started: boolean): boolean {
  return level >= speechThreshold(peak, started);
}
/** How long an answer stays on the lens before we restore the prior view. */
export const ANSWER_DWELL_MS = 12_000;

export type VoiceState = "idle" | "listening" | "thinking" | "answering";

export interface VoiceResult {
  ok?: boolean;
  transcript?: string;
  intent?: string;
  answer?: string;
  /** Written for the glass: three lines and up to three supporting facts. */
  cue?: { lines: string[]; meta?: string[] };
  glasses_lines?: string[];
}

export interface VoiceDeps {
  bridge: GlassesBridge;
  /** Send a socket event. Kept as a callback so voice.ts never imports the socket. */
  emit(event: string, payload?: unknown): void;
  /** Render a cue to the lens (main.ts owns the page/container lifecycle).
   *  Three lines and up to three supporting facts — never a hint row. The
   *  glass shows nothing it doesn't have to. */
  render(lines: string[], meta: string[]): Promise<void>;
  log(message: string): void;
  onState?(state: VoiceState): void;
  /** Called when an answer's dwell expires, to restore idle/engaged view. */
  onDone?(): void;
}

/** Normalize whatever the host hands us into raw PCM bytes.
 *  Flutter's Uint8List survives the JSON bridge as number[] on some hosts and
 *  a base64 string on others; the SDK types it as Uint8Array. Accept all. */
export function toBytes(pcm: unknown): Uint8Array {
  if (pcm instanceof Uint8Array) return pcm;
  if (pcm instanceof ArrayBuffer) return new Uint8Array(pcm);
  if (Array.isArray(pcm)) return Uint8Array.from(pcm as number[]);
  if (typeof pcm === "string") {
    try {
      const bin = atob(pcm);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return new Uint8Array(0);
    }
  }
  if (pcm && typeof pcm === "object" && "length" in (pcm as any)) {
    return Uint8Array.from(pcm as ArrayLike<number>);
  }
  return new Uint8Array(0);
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  // Chunked to stay under the argument-count limit on large buffers.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Mean absolute amplitude, 0-1, over 16-bit LE samples. */
export function frameLevel(bytes: Uint8Array): number {
  const samples = Math.floor(bytes.length / BYTES_PER_SAMPLE);
  if (samples === 0) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples * BYTES_PER_SAMPLE);
  let total = 0;
  const step = Math.max(1, Math.floor(samples / 512));
  let counted = 0;
  for (let i = 0; i < samples; i += step) {
    total += Math.abs(view.getInt16(i * BYTES_PER_SAMPLE, true));
    counted++;
  }
  return counted ? total / counted / 32768 : 0;
}

/** Eight-step bar for the lens; monochrome-safe block glyphs. */
export function levelMeter(level: number, width = 12): string {
  const filled = Math.min(width, Math.round(Math.sqrt(level) * width * 1.6));
  return "█".repeat(filled) + "·".repeat(Math.max(0, width - filled));
}

export class VoiceController {
  private state: VoiceState = "idle";
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private capTimer: ReturnType<typeof setTimeout> | null = null;
  private dwellTimer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;
  private lastVoiceAt = 0;
  private heardSpeech = false;
  private level = 0;
  /** Loudest frame so far this utterance — the reference for both thresholds. */
  private peak = 0;
  private meterTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: VoiceDeps) {}

  get current(): VoiceState {
    return this.state;
  }

  private setState(next: VoiceState) {
    this.state = next;
    this.deps.onState?.(next);
  }

  /** Double-press handler: start listening, or stop if already listening. */
  async toggle(context: { tenant: string; guestId?: string | null; focusSku?: string | null }) {
    if (this.state === "listening") return this.stop("manual");
    if (this.state === "thinking") return; // a query is already in flight
    await this.start(context);
  }

  private async start(context: { tenant: string; guestId?: string | null; focusSku?: string | null }) {
    this.clearDwell();
    this.deps.emit("voice:start", {
      tenant: context.tenant,
      guestId: context.guestId ?? null,
      focusSku: context.focusSku ?? null,
      sampleRate: SAMPLE_RATE,
    });

    let opened = false;
    try {
      opened = await this.deps.bridge.audioControl(true, "glasses");
    } catch (e) {
      this.deps.log(`voice: audioControl threw — ${String(e)}`);
    }
    if (opened === false) {
      // Host refused the mic (permission, or another app holds it).
      this.deps.emit("voice:cancel");
      await this.deps.render(
        ["MIC UNAVAILABLE", "CHECK EVEN APP PERMISSION"], [],
      );
      this.deps.log("voice: mic refused by host");
      this.setState("idle");
      this.scheduleDwell(4000);
      return;
    }

    this.pending = [];
    this.pendingBytes = 0;
    this.startedAt = Date.now();
    this.lastVoiceAt = Date.now();
    this.heardSpeech = false;
    this.level = 0;
    this.peak = 0;
    this.setState("listening");
    this.deps.log("voice: mic open");

    await this.paintListening();
    this.meterTimer = setInterval(() => void this.paintListening(), 400);
    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
    this.capTimer = setTimeout(() => void this.stop("max-length"), MAX_UTTERANCE_MS);
  }

  /** Feed a raw audioEvent payload in. Safe to call in any state. */
  onAudioChunk(rawPcm: unknown) {
    if (this.state !== "listening") return;
    const bytes = toBytes(rawPcm);
    if (bytes.length === 0) return;

    this.level = frameLevel(bytes);
    this.peak = Math.max(this.peak, this.level);
    if (isSpeaking(this.level, this.peak, this.heardSpeech)) {
      this.heardSpeech = true;
      this.lastVoiceAt = Date.now();
    }

    this.pending.push(bytes);
    this.pendingBytes += bytes.length;
    if (this.pendingBytes >= FLUSH_BYTES) this.flush();

    const elapsed = Date.now() - this.startedAt;
    const quietFor = Date.now() - this.lastVoiceAt;
    if (this.heardSpeech && elapsed > MIN_UTTERANCE_MS && quietFor > SILENCE_HANGOVER_MS) {
      void this.stop("silence");
    }
  }

  private flush() {
    if (this.pendingBytes === 0) return;
    const merged = new Uint8Array(this.pendingBytes);
    let offset = 0;
    for (const chunk of this.pending) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.pending = [];
    this.pendingBytes = 0;
    this.deps.emit("voice:chunk", { b64: toBase64(merged) });
  }

  private async stop(reason: string) {
    if (this.state !== "listening") return;
    this.clearTimers();
    try {
      await this.deps.bridge.audioControl(false);
    } catch {
      /* closing a mic that's already closed is not an error worth surfacing */
    }
    this.flush();

    if (!this.heardSpeech) {
      // Never pay for a transcription of room noise.
      this.deps.emit("voice:cancel");
      this.deps.log(`voice: no speech (${reason})`);
      await this.deps.render(
        ["DIDNT HEAR ANYTHING", "DOUBLE PRESS AND SPEAK"], [],
      );
      this.setState("idle");
      this.scheduleDwell(4000);
      return;
    }

    this.deps.emit("voice:end");
    this.setState("thinking");
    this.deps.log(`voice: closed (${reason}, ${Date.now() - this.startedAt}ms)`);
    await this.deps.render(["THINKING"], []);
  }

  /** Server answer arrived. */
  async onResult(result: VoiceResult) {
    this.clearTimers();
    const lines = result.cue?.lines?.length
      ? result.cue.lines
      : result.glasses_lines?.length
        ? result.glasses_lines
        : ["NO ANSWER", (result.answer || "").toUpperCase()];
    this.setState("answering");
    await this.deps.render(lines, result.cue?.meta ?? []);
    this.deps.log(
      `voice: "${result.transcript ?? ""}" → ${result.intent ?? "?"} — ${result.answer ?? ""}`,
    );
    this.scheduleDwell(ANSWER_DWELL_MS);
  }

  /** Associate pressed while an answer was up, or the dwell expired. */
  dismiss() {
    if (this.state === "idle") return false;
    this.clearTimers();
    this.clearDwell();
    if (this.state === "listening") {
      void this.deps.bridge.audioControl(false).catch(() => {});
      this.deps.emit("voice:cancel");
    }
    this.setState("idle");
    this.deps.onDone?.();
    return true;
  }

  private async paintListening() {
    const seconds = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    await this.deps.render(
      ["LISTENING", levelMeter(this.level), this.heardSpeech ? "" : "ASK ABOUT STOCK OR SIZE"],
      [`${seconds}S`],
    );
  }

  private scheduleDwell(ms: number) {
    this.clearDwell();
    this.dwellTimer = setTimeout(() => {
      this.dwellTimer = null;
      this.setState("idle");
      this.deps.onDone?.();
    }, ms);
  }

  private clearDwell() {
    if (this.dwellTimer) clearTimeout(this.dwellTimer);
    this.dwellTimer = null;
  }

  private clearTimers() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.capTimer) clearTimeout(this.capTimer);
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.flushTimer = this.capTimer = this.meterTimer = null;
  }
}
