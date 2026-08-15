"""The Grok provider — shape, grounding, and what happens when it fails.

Runs with no API key: `_chat` is replaced with a stub, because the assertions
worth making are about what this code does with a model's output, not about
what the model says. The one thing only a live call can prove — that the
grounding prompt actually holds against the real model — is checked separately
in `scripts/check_grok_live.py`.
"""
from __future__ import annotations

import json

import pytest

from app import cue as cue_format
from app.llm import GrokProvider, MockProvider, get_provider

GUEST = {
    "guest_id": "gid://shopify/Customer/1",
    "name": "Sarah Chen",
    "loyalty_tier": "Icon",
    "loyalty_points": 4200,
    "sizes": {"tops": "M", "bottoms": "28X30"},
    "persona_tags": ["denim", "tops"],
    "purchase_history": [{"sku": "a", "name": "Cashsoft Crew Sweater", "price": 69.0}],
    "open_cart_online": [{"sku": "b", "name": "Cashsoft Crew Sweater", "price": 69.0}],
}
RECS = [{"sku": "c", "name": "Denim Jacket", "price": 128.0,
         "location": "Denim Wall", "stock": 4, "tags": ["denim"]}]
INVENTORY = RECS + [{"sku": "d", "name": "Cargo Pant", "price": 78.0,
                     "location": "Floor", "stock": 0, "tags": ["bottoms"]}]


def grok(reply: str | Exception) -> GrokProvider:
    """A provider whose model says exactly what the test needs it to."""
    p = GrokProvider()
    captured: dict = {}

    def fake_chat(system, user, *, max_tokens=400):
        captured["system"] = system
        captured["user"] = user
        if isinstance(reply, Exception):
            raise reply
        return reply

    p._chat = fake_chat  # type: ignore[method-assign]
    p.captured = captured  # type: ignore[attr-defined]
    return p


# --- registration ------------------------------------------------------------

def test_grok_is_selectable(monkeypatch):
    monkeypatch.setenv("GAPVISION_LLM", "grok")
    assert get_provider().name == "grok"


def test_missing_key_is_a_clear_error(monkeypatch):
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.delenv("GROK_API_KEY", raising=False)
    with pytest.raises(RuntimeError) as e:
        GrokProvider()._key()
    assert "XAI_API_KEY" in str(e.value)


# --- script generation -------------------------------------------------------

def test_script_has_the_same_shape_as_mock():
    p = grok(json.dumps({
        "opener": "Sarah left the Cashsoft crew in her cart — offer it in an M.",
        "upsell": "She leans denim; walk her to the Denim Wall.",
        "closer": "She's on 4200 points at the till.",
    }))
    out = p.generate_script(GUEST, RECS)
    assert set(out) == set(MockProvider().generate_script(GUEST, RECS))
    assert out["provider"] == "grok"
    assert "Sarah" in out["opener"]


def test_the_model_does_not_write_the_glass():
    """The cue grammar is brand-locked. Whatever the model returns, the lens
    gets the same three lines it would have got from any other provider."""
    p = grok(json.dumps({"opener": "x" * 400, "upsell": "y", "closer": "z"}))
    out = p.generate_script(GUEST, RECS)
    expected = cue_format.guest_cue(GUEST, RECS[0], GUEST["open_cart_online"])
    assert out["cue"] == expected
    assert out["glasses_lines"] == cue_format.flatten(expected)
    assert "x" * 400 not in str(out["glasses_lines"])


@pytest.mark.parametrize("reply", [
    RuntimeError("502 Bad Gateway"),
    "I'm afraid I can't help with that.",   # no JSON at all
    '{"opener": ""}',                        # JSON, but empty
])
def test_a_model_failure_still_produces_a_guest_card(reply):
    """An associate walking up to a customer must get a card. Worse prose is a
    fine outcome; a blank lens is not."""
    out = grok(reply).generate_script(GUEST, RECS)
    assert out["opener"] and out["glasses_lines"]
    assert out["provider"] == "grok (fallback: mock)"


def test_fenced_json_is_still_read():
    p = grok('```json\n{"opener":"a","upsell":"b","closer":"c"}\n```')
    assert p.generate_script(GUEST, RECS)["opener"] == "a"


# --- grounding ---------------------------------------------------------------

def test_the_prompt_forbids_inventing_stock():
    p = grok("We have four in the Denim Wall.")
    p.answer_question("do you have these in a 32", GUEST, RECS[0], INVENTORY)
    system = p.captured["system"]  # type: ignore[attr-defined]
    for rule in ["ONLY", "may not estimate", "Never state a stock level"]:
        assert rule in system, system


def test_only_the_records_we_hold_are_sent():
    p = grok("ok")
    p.answer_question("q", GUEST, RECS[0], INVENTORY)
    sent = json.loads(p.captured["user"])  # type: ignore[attr-defined]
    assert sent["question"] == "q"
    assert [i["name"] for i in sent["floor_inventory"]] == ["Denim Jacket", "Cargo Pant"]
    # Stock travels verbatim, including zero — an out-of-stock item the model
    # can see is the difference between "no" and a guess.
    assert sent["floor_inventory"][1]["stock"] == 0


def test_no_customer_record_is_sent_when_nobody_is_engaged():
    p = grok("ok")
    p.answer_question("what's the price", None, None, INVENTORY)
    sent = json.loads(p.captured["user"])  # type: ignore[attr-defined]
    assert sent["customer"] is None


def test_a_model_outage_on_voice_degrades_rather_than_breaks(monkeypatch):
    """`voice._answer_open` catches this and renders a warning on the lens.
    Asserted here so the contract it relies on stays true."""
    from app import voice

    p = grok(RuntimeError("timed out"))
    monkeypatch.setattr(voice, "get_provider", lambda: p)
    out = voice._answer_open("tell me about this", GUEST, RECS[0], INVENTORY)
    assert out["glasses_lines"]
    assert "unavailable" in out["answer"].lower()
