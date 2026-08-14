"""Voice pipeline tests — STT plumbing and the grounded answer engine.

The bar for the answer engine: it must never invent stock. Every assertion
about a size or a count traces back to a record in the fixture inventory.
"""
import base64
import json
import math
import struct

import pytest

from app import crm
from app.main import app
from app.stt import (
    MAX_AUDIO_BYTES,
    MockSTT,
    STTError,
    audio_duration_seconds,
    audio_rms,
    pcm_to_wav,
)
from app.voice import (
    answer_query,
    detect_intent,
    extract_size,
    nearest_sizes,
    resolve_product,
    size_availability,
    size_scheme,
)

SR = 16_000


def tone(seconds: float, amplitude: int = 8000, freq: float = 180.0) -> bytes:
    n = int(SR * seconds)
    return b"".join(
        struct.pack("<h", int(amplitude * math.sin(2 * math.pi * freq * i / SR)))
        for i in range(n)
    )


def silence(seconds: float) -> bytes:
    return b"\x00\x00" * int(SR * seconds)


# --- STT ---------------------------------------------------------------------

def test_wav_header_is_well_formed():
    pcm = tone(0.5)
    wav = pcm_to_wav(pcm)
    assert wav[:4] == b"RIFF" and wav[8:12] == b"WAVE"
    assert struct.unpack_from("<I", wav, 4)[0] == 36 + len(pcm)
    # fmt chunk: PCM(1), 1 channel, 16kHz, 16-bit
    fmt = struct.unpack_from("<IHHIIHH", wav, 16)
    assert fmt[1] == 1 and fmt[2] == 1 and fmt[3] == SR and fmt[6] == 16
    assert struct.unpack_from("<I", wav, 40)[0] == len(pcm)
    assert wav[44:] == pcm


def test_duration_and_rms():
    assert audio_duration_seconds(tone(1.0)) == pytest.approx(1.0, abs=0.01)
    assert audio_rms(silence(0.5)) == 0.0
    assert audio_rms(tone(0.5)) > 0.1


def test_mock_stt_rejects_silence_and_stubs():
    stt = MockSTT()
    with pytest.raises(STTError, match="No audio"):
        stt.transcribe(b"")
    with pytest.raises(STTError, match="too short"):
        stt.transcribe(tone(0.1))
    with pytest.raises(STTError, match="no speech"):
        stt.transcribe(silence(1.0))
    with pytest.raises(STTError, match="too long"):
        stt.transcribe(b"\x01\x00" * (MAX_AUDIO_BYTES // 2 + 1))


def test_mock_stt_returns_deterministic_transcript():
    stt = MockSTT()
    first = stt.transcribe(tone(1.0))
    assert first == stt.transcribe(tone(1.0))
    assert first in MockSTT.SCRIPT


def test_mock_stt_can_be_pinned(monkeypatch):
    monkeypatch.setenv("CUE_STT_MOCK_TRANSCRIPT", "where is the denim wall")
    assert MockSTT().transcribe(tone(1.0)) == "where is the denim wall"


# --- parsing -----------------------------------------------------------------

@pytest.mark.parametrize("phrase,expected", [
    ("do we have these in a 32", "32"),
    ("any 28 by 30 left", "28x30"),
    ("got these in 32x30", "32x30"),
    ("do we have a medium", "M"),
    ("anything in size L", "L"),
    ("any extra large", "XL"),
    ("where is the denim wall", None),
])
def test_extract_size(phrase, expected):
    assert extract_size(phrase) == expected


@pytest.mark.parametrize("phrase,expected", [
    ("do we have these in a 32", "stock"),
    ("how many are left", "stock"),
    ("where is the poplin shirt", "location"),
    ("how much is the linen blazer", "price"),
    ("what did she buy last time", "history"),
    ("what should I show her next", "recommend"),
])
def test_detect_intent(phrase, expected):
    assert detect_intent(phrase, extract_size(phrase)) == expected


def test_resolve_product_by_name_then_deixis():
    inv = crm.INVENTORY
    item, how = resolve_product("how much is the linen blazer", inv)
    assert item["sku"] == "GAP-BLZ-7810" and how == "named"

    focus = next(i for i in inv if i["sku"] == "GAP-DNM-0498")
    item, how = resolve_product("do we have these in a 32", inv, focus=focus)
    assert item["sku"] == "GAP-DNM-0498" and how == "focus"


def test_waist_size_never_binds_to_a_letter_sized_garment():
    """The bug this guards: "these in a 32x30" while a tee is on the lens
    must not answer about the tee, and must never offer S/M/L as alternatives
    to a waist size."""
    tee = next(i for i in crm.INVENTORY if i["sku"] == "GAP-TEE-1150")
    item, how = resolve_product("do we have these in a 32x30", crm.INVENTORY,
                                focus=tee, size="32x30")
    assert item["sku"] == "GAP-DNM-0498" and how == "size-scheme"

    r = answer_query("do we have these in a 32x30", crm.INVENTORY, focus_sku="GAP-TEE-1150")
    assert r["product"]["sku"] == "GAP-DNM-0498"
    assert "3 in 32x30" in r["glasses_lines"][1]

    # Letter sizes must never appear as alternatives to a waist size.
    jeans_item = jeans()
    assert all("x" in s for s in nearest_sizes(jeans_item, "34x32"))


def test_named_item_asked_for_a_size_it_isnt_sold_in():
    r = answer_query("do we have the poplin shirt in a 32x30", crm.INVENTORY)
    assert "isn't sized 32x30" in r["answer"]
    assert "XS" in r["answer"]


def test_ambiguous_deixis_asks_rather_than_guesses():
    tee = next(i for i in crm.INVENTORY if i["sku"] == "GAP-TEE-1150")
    inventory = [tee, jeans(), {**jeans(), "sku": "OTHER-DNM", "name": "Other Jeans"}]
    r = answer_query("do we have these in a 32x30", inventory, focus_sku="GAP-TEE-1150")
    assert r["product"] is None
    assert "Say the product name" in r["answer"]


@pytest.mark.parametrize("size,scheme", [
    ("32x30", "waist"), ("32", "numeric"), ("M", "letter"), ("XXL", "letter"), (None, None),
])
def test_size_scheme(size, scheme):
    assert size_scheme(size) == scheme


def test_size_availability_is_honest_without_variant_data():
    item = {"name": "Mystery Item", "stock": 5, "tags": []}
    assert size_availability(item, "M") == ("unknown", None)
    assert size_availability(item, None) == ("yes", 5)


# --- answers -----------------------------------------------------------------

def guest():
    return crm.get_guest("guest-001")


def jeans():
    return next(i for i in crm.INVENTORY if i["sku"] == "GAP-DNM-0498")


def test_stock_answer_is_grounded_in_the_record():
    r = answer_query("do we have these in a 32x30", crm.INVENTORY, focus_sku="GAP-DNM-0498")
    assert r["intent"] == "stock"
    assert "3" in r["answer"]  # 32x30 -> 3 units in the fixture
    assert str(jeans()["sizes"]["32x30"]) in r["glasses_lines"][1]
    assert r["glasses_lines"][0].startswith("[ICON:MIC]")


def test_out_of_stock_offers_real_alternatives_only():
    r = answer_query("any of these in a 34x32", crm.INVENTORY, focus_sku="GAP-DNM-0498")
    available = {s for s, units in jeans()["sizes"].items() if units > 0}
    assert "No 34x32" in r["answer"]
    offered = [s for s in jeans()["sizes"] if s in r["answer"]]
    assert set(offered) - {"34x32"} <= available


def test_missing_size_falls_back_to_the_guests_own_size():
    r = answer_query("do we have these", crm.INVENTORY, guest=guest(), focus_sku="GAP-DNM-0498")
    # Sarah Chen wears 28x30; the fixture has 3.
    assert r["size"] == "28x30"
    assert "28x30" in r["answer"]
    assert any("assumed their size" in line for line in r["glasses_lines"])


def test_unknown_product_does_not_guess():
    r = answer_query("do we have the space suit in a 32", [])
    assert r["product"] is None
    assert "No floor item matches" in r["answer"]


def test_location_and_price():
    loc = answer_query("where is the poplin shirt", crm.INVENTORY)
    assert loc["intent"] == "location" and "New Arrivals" in loc["answer"]

    price = answer_query("how much is the linen blazer", crm.INVENTORY)
    assert price["intent"] == "price" and "$128.00" in price["answer"]


def test_history_intents():
    hist = answer_query("what did she buy last time", crm.INVENTORY, guest=guest())
    assert hist["intent"] == "history"
    assert "Mid Rise Vintage Slim Jeans" in hist["answer"]

    sizes = answer_query("what size is she", crm.INVENTORY, guest=guest())
    assert "28x30" in sizes["answer"] and "M" in sizes["answer"]

    points = answer_query("how many points does she have", crm.INVENTORY, guest=guest())
    assert "4200" in points["answer"]


def test_history_without_a_guest_says_so():
    r = answer_query("what did she buy last time", crm.INVENTORY)
    assert "No guest is engaged" in r["answer"]


def test_recommend_uses_persona_and_excludes_owned():
    r = answer_query("what should I show her next", crm.INVENTORY, guest=guest())
    owned = {p["sku"] for p in guest()["purchase_history"]}
    assert r["intent"] == "recommend"
    assert all(m["sku"] not in owned for m in r["matches"])


def test_lines_fit_the_lens():
    for q in ["do we have these in a 32x30", "what should I show her next",
              "what did she buy last time", "where is the poplin shirt"]:
        r = answer_query(q, crm.INVENTORY, guest=guest(), focus_sku="GAP-DNM-0498")
        assert len(r["glasses_lines"]) <= 7, q
        for line in r["glasses_lines"]:
            assert len(line) <= 60, (q, line)


# --- endpoint ----------------------------------------------------------------

def client():
    from fastapi.testclient import TestClient
    return TestClient(app)


def test_voice_query_endpoint_with_audio(auth_headers):
    res = client().post("/api/voice-query", headers=auth_headers, json={
        "tenant": "gap",
        "audio_b64": base64.b64encode(tone(1.4)).decode(),
        "guest_id": "guest-001",
        "focus_sku": "GAP-DNM-0498",
    })
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["transcript"] in MockSTT.SCRIPT
    assert body["glasses_lines"]
    assert body["audio_seconds"] == pytest.approx(1.4, abs=0.05)


def test_voice_query_endpoint_with_transcript_skips_stt(auth_headers):
    res = client().post("/api/voice-query", headers=auth_headers, json={
        "tenant": "gap",
        "transcript": "how much is the linen blazer",
    })
    body = res.json()
    assert body["ok"] is True and body["intent"] == "price"
    assert "$128.00" in body["answer"]


def test_voice_query_silence_is_a_result_not_a_crash(auth_headers):
    res = client().post("/api/voice-query", headers=auth_headers, json={
        "tenant": "gap",
        "audio_b64": base64.b64encode(silence(1.0)).decode(),
    })
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    assert body["glasses_lines"][0].startswith("[ICON:WARN]")


def test_voice_query_rejects_junk_and_oversize_audio(auth_headers):
    c = client()
    assert c.post("/api/voice-query", headers=auth_headers,
                  json={"tenant": "gap"}).status_code == 400
    assert c.post("/api/voice-query", headers=auth_headers, json={
        "tenant": "gap", "audio_b64": "not base64!!"}).status_code == 400
    big = base64.b64encode(b"\x01\x00" * (MAX_AUDIO_BYTES // 2 + 1)).decode()
    assert c.post("/api/voice-query", headers=auth_headers, json={
        "tenant": "gap", "audio_b64": big}).status_code == 413


def test_voice_query_requires_the_service_key(auth_headers):
    """The voice endpoint carries a guest_id and can return purchase history,
    so it is the same door as /api/guest-context and gets the same lock."""
    c = client()
    body = {"tenant": "gap", "transcript": "how much is the linen blazer"}

    assert c.post("/api/voice-query", json=body).status_code == 401
    assert c.post("/api/voice-query", headers={"x-gapvision-key": "wrong"},
                  json=body).status_code == 401
    assert c.post("/api/voice-query", headers=auth_headers, json=body).status_code == 200


def test_health_stays_open_and_leaks_nothing():
    body = client().get("/health").json()
    assert body["status"] == "ok"
    assert body["auth"]["api_key_configured"] is True
    assert "test-key" not in json.dumps(body)


def test_health_reports_stt_provider():
    body = client().get("/health").json()
    assert body["stt_provider"] == "mock"
