"""Speech-to-text layer — provider-agnostic, same shape as `llm.py`.

The glasses stream raw 16 kHz mono 16-bit little-endian PCM. Nothing upstream
of this module knows or cares which STT vendor is in play: set `CUE_STT` to
'mock' (default), 'openai', 'groq', or 'deepgram' and supply the matching key.

  CUE_STT=openai    OPENAI_API_KEY=...    (whisper-1 / gpt-4o-transcribe)
  CUE_STT=groq      GROQ_API_KEY=...      (whisper-large-v3-turbo, cheap+fast)
  CUE_STT=deepgram  DEEPGRAM_API_KEY=...  (nova-2, lowest latency)

Legacy `GAPVISION_STT` is still honored so a redeploy never breaks on the
rename.

Design notes for the pilot:
  * We transcribe a complete utterance, not a live stream. An associate's
    question is 2-6 seconds; batch transcription keeps the vendor surface tiny
    and the round trip is still well under a second on Groq/Deepgram.
  * Providers that want a container get a WAV header synthesized here — no
    ffmpeg dependency in the image.
"""
from __future__ import annotations

import io
import os
import struct
import urllib.error
import urllib.request
import uuid

SAMPLE_RATE = 16_000
SAMPLE_WIDTH = 2  # 16-bit
CHANNELS = 1

# Guard rails: an associate's question, not a podcast.
MAX_AUDIO_SECONDS = 15
MAX_AUDIO_BYTES = SAMPLE_RATE * SAMPLE_WIDTH * CHANNELS * MAX_AUDIO_SECONDS


class STTError(RuntimeError):
    """Transcription failed in a way the caller should surface, not crash on."""


def _env(*names: str, default: str = "") -> str:
    for n in names:
        v = os.environ.get(n)
        if v:
            return v
    return default


def pcm_to_wav(pcm: bytes, sample_rate: int = SAMPLE_RATE) -> bytes:
    """Wrap raw mono 16-bit LE PCM in a 44-byte RIFF/WAVE header."""
    byte_rate = sample_rate * CHANNELS * SAMPLE_WIDTH
    block_align = CHANNELS * SAMPLE_WIDTH
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " + struct.pack(
        "<IHHIIHH", 16, 1, CHANNELS, sample_rate, byte_rate, block_align, SAMPLE_WIDTH * 8
    ) + b"data" + struct.pack("<I", len(pcm))
    return header + pcm


def audio_duration_seconds(pcm: bytes, sample_rate: int = SAMPLE_RATE) -> float:
    return len(pcm) / float(sample_rate * CHANNELS * SAMPLE_WIDTH)


def audio_rms(pcm: bytes) -> float:
    """Mean absolute amplitude, 0.0-1.0. Used to reject silence before we pay
    a vendor to transcribe it."""
    n = len(pcm) // 2
    if n == 0:
        return 0.0
    total = 0
    # Sample at most ~4000 frames; this runs per request and precision is moot.
    step = max(1, n // 4000)
    counted = 0
    for i in range(0, n, step):
        (s,) = struct.unpack_from("<h", pcm, i * 2)
        total += abs(s)
        counted += 1
    return (total / counted) / 32768.0 if counted else 0.0


class BaseSTT:
    name = "base"
    #: Below this mean amplitude we treat the clip as silence and skip the call.
    silence_floor = 0.004

    def transcribe(self, pcm: bytes, sample_rate: int = SAMPLE_RATE) -> str:
        raise NotImplementedError

    def _precheck(self, pcm: bytes, sample_rate: int) -> None:
        if not pcm:
            raise STTError("No audio received")
        if len(pcm) > MAX_AUDIO_BYTES:
            raise STTError(f"Audio too long (limit {MAX_AUDIO_SECONDS}s)")
        if audio_duration_seconds(pcm, sample_rate) < 0.25:
            raise STTError("Audio too short — hold the temple a moment longer")
        if audio_rms(pcm) < self.silence_floor:
            raise STTError("Didn't catch that — no speech detected")


class MockSTT(BaseSTT):
    """Deterministic transcripts for demos, CI, and hardware bring-up.

    Real audio still gets the same silence/length pre-checks, so the whole
    plugin-side flow (mic open, chunking, level meter, timeout) is exercised
    honestly without a vendor account. The returned text rotates by clip
    duration so repeated presses demo different intents; override with
    CUE_STT_MOCK_TRANSCRIPT to pin one line for a scripted demo.
    """

    name = "mock"

    SCRIPT = [
        "do we have these jeans in a 32",
        "where is the denim wall",
        "how much is the fleece hoodie",
        "what did she buy last time",
        "what should I show her next",
    ]

    def transcribe(self, pcm: bytes, sample_rate: int = SAMPLE_RATE) -> str:
        self._precheck(pcm, sample_rate)
        pinned = os.environ.get("CUE_STT_MOCK_TRANSCRIPT")
        if pinned:
            return pinned
        tenths = int(audio_duration_seconds(pcm, sample_rate) * 10)
        return self.SCRIPT[tenths % len(self.SCRIPT)]


def _http_post(url: str, body: bytes, headers: dict, timeout: int = 20) -> bytes:
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise STTError(f"STT provider {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise STTError(f"STT provider unreachable: {e.reason}") from e


def _multipart(fields: dict[str, str], filename: str, payload: bytes) -> tuple[bytes, str]:
    """Minimal multipart/form-data encoder (no `requests` dependency)."""
    boundary = f"----cue{uuid.uuid4().hex}"
    buf = io.BytesIO()
    for key, value in fields.items():
        buf.write(f"--{boundary}\r\n".encode())
        buf.write(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode())
        buf.write(f"{value}\r\n".encode())
    buf.write(f"--{boundary}\r\n".encode())
    buf.write(
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode()
    )
    buf.write(b"Content-Type: audio/wav\r\n\r\n")
    buf.write(payload)
    buf.write(f"\r\n--{boundary}--\r\n".encode())
    return buf.getvalue(), f"multipart/form-data; boundary={boundary}"


class _WhisperCompatibleSTT(BaseSTT):
    """OpenAI-shaped /audio/transcriptions endpoint (OpenAI and Groq both)."""

    endpoint = ""
    default_model = ""
    key_names: tuple[str, ...] = ()

    def transcribe(self, pcm: bytes, sample_rate: int = SAMPLE_RATE) -> str:
        self._precheck(pcm, sample_rate)
        key = _env(*self.key_names)
        if not key:
            raise STTError(f"{self.name} STT selected but {self.key_names[0]} is unset")
        model = _env(f"CUE_STT_MODEL", default=self.default_model)
        body, content_type = _multipart(
            {"model": model, "response_format": "json", "language": "en"},
            "utterance.wav",
            pcm_to_wav(pcm, sample_rate),
        )
        raw = _http_post(
            self.endpoint,
            body,
            {"Authorization": f"Bearer {key}", "Content-Type": content_type},
        )
        import json

        return (json.loads(raw).get("text") or "").strip()


class OpenAISTT(_WhisperCompatibleSTT):
    name = "openai"
    endpoint = "https://api.openai.com/v1/audio/transcriptions"
    default_model = "gpt-4o-mini-transcribe"
    key_names = ("OPENAI_API_KEY",)


class GroqSTT(_WhisperCompatibleSTT):
    name = "groq"
    endpoint = "https://api.groq.com/openai/v1/audio/transcriptions"
    default_model = "whisper-large-v3-turbo"
    key_names = ("GROQ_API_KEY",)


class DeepgramSTT(BaseSTT):
    """Deepgram takes raw PCM directly — no container, lowest latency."""

    name = "deepgram"

    def transcribe(self, pcm: bytes, sample_rate: int = SAMPLE_RATE) -> str:
        self._precheck(pcm, sample_rate)
        key = _env("DEEPGRAM_API_KEY")
        if not key:
            raise STTError("deepgram STT selected but DEEPGRAM_API_KEY is unset")
        model = _env("CUE_STT_MODEL", default="nova-2")
        url = (
            "https://api.deepgram.com/v1/listen"
            f"?model={model}&encoding=linear16&sample_rate={sample_rate}"
            "&channels=1&smart_format=true&punctuate=true"
        )
        raw = _http_post(
            url,
            pcm,
            {"Authorization": f"Token {key}", "Content-Type": "audio/l16"},
        )
        import json

        data = json.loads(raw)
        try:
            return (
                data["results"]["channels"][0]["alternatives"][0]["transcript"] or ""
            ).strip()
        except (KeyError, IndexError) as e:
            raise STTError("Unexpected Deepgram response shape") from e


_PROVIDERS: dict[str, type[BaseSTT]] = {
    "mock": MockSTT,
    "openai": OpenAISTT,
    "groq": GroqSTT,
    "deepgram": DeepgramSTT,
}


def get_stt() -> BaseSTT:
    choice = _env("CUE_STT", "GAPVISION_STT", default="mock").lower()
    return _PROVIDERS.get(choice, MockSTT)()


def rms_envelope(pcm: bytes, sample_rate: int = SAMPLE_RATE,
                 frame_ms: int = 100) -> list[float]:
    """Per-frame RMS across an utterance, 0.0-1.0.

    Diagnostic, not part of the answer path. The plugin closes the mic when its
    own on-device level drops below a fixed floor; on real hardware that never
    fired and every question ran to the 12 s cap. This is how we find out what
    the levels actually are in a real room instead of guessing at a constant —
    computed server-side from audio we already have, so it costs no round trip
    through the Even Hub upload flow.
    """
    frame = max(1, int(sample_rate * frame_ms / 1000))
    out: list[float] = []
    total_frames = len(pcm) // 2 // frame
    for f in range(total_frames):
        base = f * frame * 2
        acc = 0
        # Every 4th sample is plenty to characterise a 100 ms frame.
        for i in range(0, frame, 4):
            (s,) = struct.unpack_from("<h", pcm, base + i * 2)
            acc += abs(s)
        out.append(round((acc / max(1, frame // 4)) / 32768.0, 5))
    return out


def describe_levels(pcm: bytes, sample_rate: int = SAMPLE_RATE) -> dict:
    """One line an operator can act on: where is the noise floor, where is
    speech, and would the plugin's silence threshold ever have been crossed?"""
    env = rms_envelope(pcm, sample_rate)
    if not env:
        return {"frames": 0}
    ordered = sorted(env)
    pct = lambda p: ordered[min(len(ordered) - 1, int(len(ordered) * p))]  # noqa: E731
    # The constant the plugin currently uses (voice.ts SILENCE_FLOOR).
    floor = 0.012
    below = [i for i, v in enumerate(env) if v < floor]
    return {
        "frames": len(env),
        "seconds": round(len(env) * 0.1, 1),
        "min": ordered[0],
        "p10": pct(0.10),
        "median": pct(0.50),
        "p90": pct(0.90),
        "max": ordered[-1],
        "client_floor": floor,
        "frames_below_floor": len(below),
        # The plugin needs ~9 consecutive quiet frames (900 ms hangover).
        "longest_quiet_run_ms": _longest_run(env, floor) * 100,
        "tail_1s": env[-10:],
    }


def _longest_run(env: list[float], floor: float) -> int:
    best = run = 0
    for v in env:
        run = run + 1 if v < floor else 0
        best = max(best, run)
    return best
