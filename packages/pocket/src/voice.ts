/**
 * Asking out loud, from a phone.
 *
 * Until this file existed, Ask was the one pillar the phone did not have. The
 * customer deck sells the phone as where a pilot starts — "requests, answers,
 * comms and the customer card" — and sells Ask as the thing that makes CueSea
 * an interaction difference rather than a feature difference. Both were true
 * and they were not true *together*: `voice:start` was emitted only from the
 * glasses, so a phone pilot shipped without the capability the pitch rests on.
 *
 * The realtime server needed no changes. Its voice protocol is surface-blind —
 * `voice:start {tenant, guestId, focusSku, sampleRate}`, then `voice:chunk
 * {b64}`, then `voice:end` — and it answers `voice:state` and `voice:result`
 * to whoever asked. This file is a second mouth on the same protocol.
 *
 * ── Hold to talk, rather than endpointing ─────────────────────────────────
 *
 * The glasses detect the end of speech themselves (`glasses-plugin/src/
 * voice.ts`, with a noise floor measured on a real G2 in a real room), because
 * a double-press is the only gesture available and something has to decide
 * when the question stopped.
 *
 * A phone already has the answer in the associate's hand: they are touching
 * the button. Press, ask, release. No threshold to tune per room, no hangover
 * timer, and no failure mode where a loud floor holds the mic open for the
 * full twelve seconds. It is also the idiom every messaging app on that phone
 * already taught them.
 *
 * That is why this is not the glasses' voice module reused. The endpointing
 * half — the majority of it — is exactly the part a phone should not have.
 *
 * ── Why ScriptProcessorNode, which is deprecated ──────────────────────────
 *
 * AudioWorklet is the modern path and needs a separate module file fetched at
 * runtime. Pocket is an offline-first PWA whose service worker has to cache
 * everything it will ever need; adding a script that must load *at the moment
 * an associate presses a button, possibly on bad shop wifi* trades a
 * deprecation warning for a failure in the one place that matters. The work
 * here is 16 kHz mono int-conversion — trivial on the main thread.
 *
 * ── The sample rate is reported, not forced ───────────────────────────────
 *
 * `AudioContext({sampleRate: 16000})` is a request, not a guarantee; Safari
 * routinely gives 44.1 or 48 kHz. Rather than resample on a mid-range handset,
 * this sends whatever the context actually produced. The rate rides the
 * protocol into the WAV header the AI service writes (`stt.pcm_to_wav`), so
 * the transcriber is told the truth instead of being handed 48 kHz audio
 * labelled 16.
 */

/** Longer than any real question, and under the server's own 15 s cap. */
const MAX_UTTERANCE_MS = 12_000;

/** Samples per `onaudioprocess` callback. ~256 ms at 16 kHz. */
const FRAME = 4096;

export type MicState = "idle" | "listening" | "denied" | "unsupported";

export interface MicDeps {
  emit: (event: string, payload?: unknown) => void;
  /** 0-1 mean amplitude, for a meter that proves it is hearing something. */
  onLevel: (level: number) => void;
  onState: (state: MicState) => void;
}

/** Is there a microphone path on this handset at all? */
export function micSupported(): boolean {
  const nav = globalThis.navigator as Navigator | undefined;
  const Ctx = (globalThis as { AudioContext?: unknown; webkitAudioContext?: unknown });
  return !!nav?.mediaDevices?.getUserMedia && !!(Ctx.AudioContext || Ctx.webkitAudioContext);
}

/** Float32 [-1,1] to 16-bit LE PCM, clamped rather than wrapped — a clipped
 *  sample should sound loud, not invert into noise the transcriber chokes on. */
export function toPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/** Base64, chunked to stay under the argument-count limit on large buffers. */
export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Mean absolute amplitude of a frame, 0-1. */
export function levelOf(samples: Float32Array): number {
  let total = 0;
  const step = Math.max(1, Math.floor(samples.length / 512));
  let counted = 0;
  for (let i = 0; i < samples.length; i += step) { total += Math.abs(samples[i]); counted++; }
  // An empty frame falls out here as 0 rather than NaN — `counted` never
  // incremented. No early return for it: a guard that cannot change the answer
  // is a line the next reader has to prove is dead.
  return counted ? total / counted : 0;
}

export interface Mic {
  state: () => MicState;
  /** Begin an utterance. Resolves once the mic is actually open, or after the
   *  state has been set to `denied` — never rejects, because a refused
   *  permission is an answer and not an error. */
  start: (ctx?: { guestId?: string | null; focusSku?: string | null }) => Promise<void>;
  /** End it and let the server answer. */
  stop: () => void;
  /** Drop it with no question asked — a press the associate thought better of. */
  cancel: () => void;
}

export function createMic(deps: MicDeps): Mic {
  let state: MicState = micSupported() ? "idle" : "unsupported";
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let node: ScriptProcessorNode | null = null;
  let capTimer: ReturnType<typeof setTimeout> | null = null;

  function teardown(): void {
    if (capTimer) { clearTimeout(capTimer); capTimer = null; }
    try { node?.disconnect(); } catch { /* already gone */ }
    try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* already gone */ }
    // Closing is what actually releases the OS mic indicator. A context left
    // suspended keeps the little red dot on, which reads to an associate as
    // "this thing is listening to me all shift".
    try { void ctx?.close(); } catch { /* already gone */ }
    node = null; stream = null; ctx = null;
    deps.onLevel(0);
  }

  function set(next: MicState): void {
    state = next;
    deps.onState(next);
  }

  return {
    state: () => state,

    async start(where = {}) {
      if (state === "unsupported") return;
      if (state === "listening") return;      // a second press is not a second question
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });
      } catch {
        // Denied, or no device. Both are the same thing to the person holding
        // it: the button cannot work, and saying so is the whole job.
        set("denied");
        return;
      }

      const Ctor = (globalThis as unknown as { AudioContext: typeof AudioContext; webkitAudioContext?: typeof AudioContext });
      ctx = new (Ctor.AudioContext || Ctor.webkitAudioContext!)({ sampleRate: 16_000 });
      const source = ctx.createMediaStreamSource(stream);
      node = ctx.createScriptProcessor(FRAME, 1, 1);

      deps.emit("voice:start", {
        guestId: where.guestId ?? null,
        focusSku: where.focusSku ?? null,
        // What the context gave us, which is not always what we asked for.
        sampleRate: ctx.sampleRate,
      });
      set("listening");

      node.onaudioprocess = (e: AudioProcessingEvent) => {
        if (state !== "listening") return;
        const samples = e.inputBuffer.getChannelData(0);
        deps.onLevel(levelOf(samples));
        deps.emit("voice:chunk", { b64: toBase64(toPcm16(samples)) });
      };

      source.connect(node);
      // A ScriptProcessor only runs while it is connected to a destination.
      // Nothing should be audible, so it goes to a muted gain node rather than
      // to the speakers — otherwise the associate hears their own voice.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute);
      mute.connect(ctx.destination);

      // The thumb can leave the button without a pointerup — a call arrives, the
      // screen is locked, the browser backgrounds the tab. The server caps the
      // utterance too; this is the client keeping the mic light off.
      capTimer = setTimeout(() => this.stop(), MAX_UTTERANCE_MS);
    },

    stop() {
      if (state !== "listening") return;
      teardown();
      set("idle");
      deps.emit("voice:end");
    },

    cancel() {
      if (state !== "listening") return;
      teardown();
      set("idle");
      deps.emit("voice:cancel");
    },
  };
}
