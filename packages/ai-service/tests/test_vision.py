"""The phone camera path: the gate, the ceiling, and what may reach the glass.

    python -m pytest tests/test_vision.py -q

No database and no network. The tenant flag is stubbed at
`capabilities._privacy` and the model at `vision.get_provider`, because every
assertion here is about what this service does with an answer — not about what
a vision model says.

Three properties are worth a test each, and they are the three that would cost
something real if they broke:

  · **The flag is server-side.** A plugin is a static bundle on somebody's
    phone. If the only thing stopping a capture is the client's own copy of a
    boolean, the retailer's consent is decoration.
  · **The payload has a ceiling.** An unbounded image field is an unbounded
    memory allocation reachable by anyone holding the service key.
  · **A price on the glass comes from a record.** The model reads characters
    off a tag; it does not know what anything costs or whether it is in stock.
    A vision path that prints a model's guess breaks the promise the whole
    product is sold on.
"""
from __future__ import annotations

import base64
import json

import pytest
from fastapi.testclient import TestClient

from app import capabilities, crm, vision
from app.llm import AnthropicProvider, MockProvider, VisionUnsupported
from app.main import app

#: Big enough to clear the "too small to read anything" floor, small enough to
#: keep the suite fast. Contents are irrelevant — nothing here decodes an image.
IMAGE = base64.b64encode(bytes(4096)).decode()

#: A real record from the demo floor, so a grounded answer can be checked
#: against something this service actually holds.
KNOWN = crm.INVENTORY[1]          # GAP-DNM-0498, High Rise Barrel Jeans


class FakeVision:
    """A provider whose model says exactly what the test needs it to.

    Also records whether it was called at all, which is how the payload-cap
    tests prove the ceiling is enforced *before* an image is sent anywhere.
    """

    name = "fake"

    def __init__(self, reading: str | Exception = "NONE"):
        self.reading = reading
        self.calls: list[dict] = []

    def read_image(self, image_base64: str, mime: str, question: str) -> str:
        self.calls.append({"mime": mime, "question": question,
                           "bytes": len(image_base64)})
        if isinstance(self.reading, Exception):
            raise self.reading
        return self.reading


class FakeCRM:
    def __init__(self, items=None, raises: Exception | None = None):
        self.items = items if items is not None else crm.INVENTORY
        self.raises = raises

    def floor_inventory(self):
        if self.raises:
            raise self.raises
        return self.items


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def camera_on(monkeypatch):
    """A tenant that has turned capture on, with the rest of its posture intact.

    Includes `retention_days` and `store_transcripts` deliberately: the
    capabilities route must be able to see them and must not report them.
    """
    monkeypatch.setattr(capabilities, "_privacy", lambda slug: {
        "camera_capture": True, "store_transcripts": True,
        "shift_telemetry": False,
        "retention_days": 365, "opt_in_tiers": ["qr_checkin"],
    })
    monkeypatch.setattr(capabilities, "_config", lambda slug: {})


def analyze(monkeypatch, provider: FakeVision, *, kind="sku", crm_obj=None,
            note=None) -> dict:
    monkeypatch.setattr(vision, "get_provider", lambda: provider)
    return vision.analyze(tenant="gap", kind=kind, image_base64=IMAGE,
                          mime="image/jpeg", note=note,
                          crm=crm_obj or FakeCRM())


# --- capabilities: booleans, and only booleans -------------------------------

def test_capabilities_returns_switches_not_a_privacy_posture(client, auth_headers,
                                                             camera_on):
    """A plugin asks what it may offer. It does not get told how long this
    retailer keeps data or whether they record what staff said.

    The exact set is asserted rather than a subset. Adding a key here has to be
    a deliberate act with a diff somebody reads: this response reaches a static
    bundle on a phone, so anything that lands in it is published. The set grew
    once, for `shift_telemetry` — the switch that decides whether the plugin
    reports when its wearer started and stopped working — and that is what a
    deliberate act looks like.
    """
    r = client.get("/api/tenant/capabilities?tenant=gap", headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"camera_capture", "shift_telemetry", "voice",
                         "floor_comms", "known"}, (
        f"the capability contract changed: {sorted(body)}")
    assert all(isinstance(v, bool) for v in body.values()), (
        f"a client can only branch on booleans: {body}")
    for leaked in ("retention_days", "store_transcripts", "opt_in_tiers", "365"):
        assert leaked not in r.text, (
            f"{leaked!r} reached a static bundle through /capabilities: {r.text}")


def test_capabilities_is_closed_when_the_tenant_cannot_be_read(client, auth_headers):
    """No database, no row, a blip — every unknown resolves to camera off.

    The convenient answer here is "assume it's fine". The convenient answer is
    a capture nobody consented to.
    """
    body = client.get("/api/tenant/capabilities?tenant=gap",
                      headers=auth_headers).json()
    assert body["camera_capture"] is False, body


def test_capabilities_needs_the_service_key(client):
    """Same door, same lock as every other data route."""
    assert client.get("/api/tenant/capabilities?tenant=gap").status_code == 401


# --- the gate ----------------------------------------------------------------

def test_capture_is_refused_when_the_tenant_flag_is_off(client, auth_headers):
    r = client.post("/api/vision/analyze", headers=auth_headers,
                    json={"tenant": "gap", "kind": "sku",
                          "image_base64": IMAGE, "mime": "image/jpeg"})
    assert r.status_code == 403, r.text
    detail = r.json()["detail"]
    assert capabilities.CAMERA_CAPTURE in detail, (
        f"the 403 has to name the flag an operator would flip: {detail}")
    assert "off by default" in detail, detail


def test_the_flag_is_checked_before_the_payload_is(client, auth_headers):
    """Order matters: a tenant with capture off should never have an image of
    theirs decoded, measured or forwarded, however large it is."""
    r = client.post("/api/vision/analyze", headers=auth_headers,
                    json={"tenant": "gap", "kind": "sku",
                          "image_base64": "A" * (vision.MAX_BASE64_CHARS + 8),
                          "mime": "image/jpeg"})
    assert r.status_code == 403, (
        f"expected the consent gate first, got {r.status_code}: {r.text}")


def test_capture_needs_the_service_key(client):
    assert client.post("/api/vision/analyze",
                       json={"tenant": "gap", "image_base64": IMAGE}).status_code == 401


# --- the ceiling -------------------------------------------------------------

def test_an_oversized_image_is_refused_and_told_the_limit(client, auth_headers,
                                                          camera_on):
    r = client.post("/api/vision/analyze", headers=auth_headers,
                    json={"tenant": "gap", "kind": "sku",
                          "image_base64": "A" * (vision.MAX_BASE64_CHARS + 8),
                          "mime": "image/jpeg"})
    assert r.status_code == 413, r.text
    detail = r.json()["detail"]
    assert "3 MB" in detail, f"the error has to state the cap: {detail}"
    assert "1600" in detail, (
        f"and what to do about it, or the associate just retries: {detail}")


def test_the_ceiling_is_enforced_before_the_model_sees_anything(monkeypatch):
    """The cap is a memory and cost control, not a validation message. A
    payload over it must not be decoded and must not be uploaded."""
    provider = FakeVision("GAP-DNM-0498")
    monkeypatch.setattr(vision, "get_provider", lambda: provider)
    with pytest.raises(vision.VisionRefused) as e:
        vision.analyze(tenant="gap", kind="sku",
                       image_base64="A" * (vision.MAX_BASE64_CHARS + 8),
                       mime="image/jpeg", note=None, crm=FakeCRM())
    assert e.value.status == 413
    assert not provider.calls, "an oversized image was sent to the model"


def test_an_unsupported_image_type_is_named(monkeypatch):
    provider = FakeVision()
    monkeypatch.setattr(vision, "get_provider", lambda: provider)
    with pytest.raises(vision.VisionRefused) as e:
        vision.analyze(tenant="gap", kind="sku", image_base64=IMAGE,
                       mime="image/heic", note=None, crm=FakeCRM())
    assert e.value.status == 415
    assert "image/jpeg" in e.value.detail, e.value.detail
    assert not provider.calls


# --- grounding ---------------------------------------------------------------

def test_a_known_code_is_answered_from_the_record(monkeypatch):
    """Price, location and count come out of inventory — never out of the
    model, which was asked for a code and nothing else."""
    out = analyze(monkeypatch, FakeVision(f"SKU: {KNOWN['sku']}"))
    text = " ".join(out["lines"])
    assert out["grounded"] is True, out
    assert out["sku"] == KNOWN["sku"], out
    assert KNOWN["location"].upper() in text, text
    assert str(KNOWN["stock"]) in text, text
    assert f"${round(KNOWN['price'])}" in text, text


def test_an_unknown_code_says_so_rather_than_inventing_a_product(monkeypatch):
    out = analyze(monkeypatch, FakeVision("XX-9999-0000"))
    text = " ".join(out["lines"])
    assert "NOT IN FLOOR RECORDS" in text, text
    assert "XX 9999 0000" in text or "XX-9999-0000" in text, (
        f"the code that was read belongs on the glass: {text}")


def test_a_model_that_talks_about_prices_gets_none_of_it_on_the_glass(monkeypatch):
    """The single most expensive failure available here: a price an associate
    reads aloud that came from a model looking at a photograph."""
    out = analyze(monkeypatch, FakeVision("These jeans are $49.99 and we have four"))
    text = " ".join(out["lines"])
    assert "49" not in text and "FOUR" not in text, text
    assert "NO CODE READ" in text, text


def test_the_mock_provider_never_fabricates_a_code(monkeypatch):
    """Every other mock output is a plausible stand-in. This one must not be:
    a fabricated SKU would match a real record and print a price and a stock
    count as though a tag had been read."""
    assert MockProvider().read_image(IMAGE, "image/jpeg", "read it") == "NONE"
    out = analyze(monkeypatch, MockProvider())
    assert "NO CODE READ" in " ".join(out["lines"]), out


@pytest.mark.parametrize("floor", [
    FakeCRM(items=[]),                                  # feed synced nothing
    FakeCRM(raises=RuntimeError("shopify 502")),        # provider fell over
])
def test_no_records_is_not_the_same_answer_as_not_carried(monkeypatch, floor):
    """The completeness bug, refused entry.

    `crm.floor_inventory()` is called bare elsewhere in this service, so an
    empty list means both "this store carries nothing" and "we could not read
    the inventory" — and an associate holding a jean would be told the store
    does not stock it because a product query timed out. Here the two are
    different sentences.
    """
    out = analyze(monkeypatch, FakeVision(KNOWN["sku"]), crm_obj=floor)
    text = " ".join(out["lines"])
    assert "NOT IN FLOOR RECORDS" not in text, (
        f"an unreadable inventory was reported as a product we don't carry: {text}")
    assert "NO FLOOR RECORDS LOADED" in text, text
    assert out["grounded"] is False, out


# --- the boundary ------------------------------------------------------------

def test_a_photograph_of_a_person_is_refused_on_the_glass(monkeypatch):
    """Objects, never people. The provider prompt refuses the subject; this is
    the half that makes the refusal something the associate can read."""
    out = analyze(monkeypatch, FakeVision("NO_SUBJECT"))
    text = " ".join(out["lines"])
    assert "NOT PEOPLE" in text, text
    assert out["grounded"] is False, out


# --- providers ---------------------------------------------------------------

def test_a_provider_without_vision_says_so_clearly():
    with pytest.raises(VisionUnsupported) as e:
        AnthropicProvider().read_image(IMAGE, "image/jpeg", "read it")
    assert "no vision support" in str(e.value), str(e.value)
    assert "GAPVISION_LLM" in str(e.value), (
        f"the error has to name what an operator changes: {e.value}")


def test_a_provider_without_vision_is_an_operator_error_not_a_blank_lens(monkeypatch):
    monkeypatch.setattr(vision, "get_provider", lambda: AnthropicProvider())
    with pytest.raises(vision.VisionRefused) as e:
        vision.analyze(tenant="gap", kind="sku", image_base64=IMAGE,
                       mime="image/jpeg", note=None, crm=FakeCRM())
    assert e.value.status == 503, e.value.detail


def test_a_model_outage_still_paints_something(monkeypatch):
    """The associate pressed a button and is looking at the glass. A blank lens
    reads as broken hardware — same posture as the voice path."""
    out = analyze(monkeypatch, FakeVision(RuntimeError("timed out")))
    assert out["lines"], out
    assert "COULD NOT READ IT" in " ".join(out["lines"]), out


# --- what the glass can hold -------------------------------------------------

def test_the_answer_obeys_the_full_frame_cue_budget(monkeypatch):
    """A vision answer has no fact rail beside it, so it gets the 33-character
    line — and it still gets three lines, never four."""
    from app import cue as cue_format

    long_name = dict(KNOWN, name="Extremely Long Product Name For A Barrel Jean",
                     location="The Furthest Corner Of The Denim Wall")
    out = analyze(monkeypatch, FakeVision(KNOWN["sku"]),
                  crm_obj=FakeCRM(items=[long_name]))
    assert len(out["lines"]) <= cue_format.CUE_LINES, out["lines"]
    for line in out["lines"]:
        assert len(line) <= cue_format.LINE_CHARS, (
            f"{line!r} is {len(line)} characters in a "
            f"{cue_format.LINE_CHARS}-character frame")


# --- the image itself --------------------------------------------------------

def test_the_image_is_never_printed_or_returned(monkeypatch, capsys):
    """It is not written to disk or to the database because nothing in this
    module opens either — and a log line is the remaining way an image leaks,
    so assert on the one output stream a test can see."""
    out = analyze(monkeypatch, FakeVision(KNOWN["sku"]), note="broken clasp")
    captured = capsys.readouterr()
    assert IMAGE[:64] not in captured.out + captured.err, (
        "the image payload reached stdout")
    assert IMAGE[:64] not in json.dumps(out), "the image was echoed back"


def test_spoken_context_reaches_the_question_and_nothing_else(monkeypatch):
    provider = FakeVision(KNOWN["sku"])
    analyze(monkeypatch, provider, kind="part", note="the hinge snapped")
    assert "the hinge snapped" in provider.calls[0]["question"], provider.calls


def test_a_part_reading_is_marked_as_a_reading(monkeypatch):
    """Nothing on a retail floor can confirm a cracked hinge, so the strip says
    where the sentence came from rather than lending it a record's authority."""
    out = analyze(monkeypatch, FakeVision("Nylon door hinge, part 44-B"),
                  kind="part")
    assert out["grounded"] is False, out
    assert "MODEL READ" in " ".join(out["meta"]), out


def test_an_unknown_kind_is_refused(monkeypatch):
    provider = FakeVision()
    monkeypatch.setattr(vision, "get_provider", lambda: provider)
    with pytest.raises(vision.VisionRefused) as e:
        vision.analyze(tenant="gap", kind="face", image_base64=IMAGE,
                       mime="image/jpeg", note=None, crm=FakeCRM())
    assert e.value.status == 400
    assert not provider.calls


def test_an_unknown_slug_is_distinguishable_from_a_store_with_it_switched_off(
        client, auth_headers, monkeypatch):
    """The switches fail closed either way. The *report* must not.

    This is the bug that cost an evening. The lens demo defaults to
    `?tenant=gap`; the store being tested had the slug `cuesea` and its camera
    flag correctly on. Both answered 200 with an identical body, so a typo in a
    launch URL rendered as a working page with no camera on it — and the next
    move is to go and check a Console toggle that was already right.

    Same rule the Health panel has had since the first deploy reported a
    healthy database with no schema in it: unknown must never render as a
    valid answer.
    """
    # Slug-aware, unlike the shared fixture: the whole question here is
    # whether the route can tell two slugs apart, so a stub that answers the
    # same for every slug would test nothing.
    monkeypatch.setattr(capabilities, "_privacy", lambda slug: (
        {"camera_capture": True} if slug == "gap" else None))
    monkeypatch.setattr(capabilities, "_config", lambda slug: {})

    real = client.get("/api/tenant/capabilities?tenant=gap",
                      headers=auth_headers).json()
    ghost = client.get("/api/tenant/capabilities?tenant=no-such-store-here",
                       headers=auth_headers).json()

    assert real["known"] is True, real
    assert ghost["known"] is False, ghost
    assert real != ghost, (
        "a tenant that exists and one that does not produced identical bodies")

    # And the switches still fail closed for the ghost, which is the half that
    # decides anything.
    assert ghost["camera_capture"] is False, ghost
