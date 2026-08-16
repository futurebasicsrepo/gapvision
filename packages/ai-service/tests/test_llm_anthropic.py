"""The Anthropic provider speaks the Messages API and nothing else changes.

    python -m pytest tests/test_llm_anthropic.py -q

The provider subclasses GrokProvider so the prompts, grounding rules and mock
fallback are shared — these tests pin the parts that differ (transport shape,
auth headers, image encoding) and the parts that must not (the vision system
prompt, the fallback behaviour, the answer contract).
"""
from __future__ import annotations

import io
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("ANTHROPIC_API_KEY", "sk-ant-test")

from app import llm  # noqa: E402


class _Captured:
    def __init__(self):
        self.requests = []


def _fake_urlopen(captured, reply_text="HELLO"):
    def fake(req, timeout=None):
        captured.requests.append({
            "url": req.full_url,
            "headers": {k.lower(): v for k, v in req.header_items()},
            "body": json.loads(req.data.decode()),
            "timeout": timeout,
        })
        payload = json.dumps({
            "content": [{"type": "text", "text": reply_text}],
            "stop_reason": "end_turn",
        }).encode()
        return io.BytesIO(payload)
    return fake


def test_registered_and_selectable(monkeypatch):
    monkeypatch.setenv("GAPVISION_LLM", "anthropic")
    assert isinstance(llm.get_provider(), llm.AnthropicProvider)


def test_chat_speaks_the_messages_api(monkeypatch):
    cap = _Captured()
    monkeypatch.setattr(llm.urllib.request, "urlopen", _fake_urlopen(cap, "FINE"))
    p = llm.AnthropicProvider()
    out = p._chat("SYSTEM RULES", "USER FACTS")
    assert out == "FINE"
    r = cap.requests[0]
    assert r["url"] == "https://api.anthropic.com/v1/messages"
    assert r["headers"]["x-api-key"] == "sk-ant-test"
    assert r["headers"]["anthropic-version"] == llm.AnthropicProvider.API_VERSION
    assert r["body"]["system"] == "SYSTEM RULES"          # top-level, not a role
    assert r["body"]["messages"] == [{"role": "user", "content": "USER FACTS"}]


def test_read_image_sends_base64_block_and_shared_rules(monkeypatch):
    cap = _Captured()
    monkeypatch.setattr(llm.urllib.request, "urlopen", _fake_urlopen(cap, "GAP-DNM-0498"))
    p = llm.AnthropicProvider()
    out = p.read_image("QUJD", "image/jpeg", "Read the code.")
    assert out == "GAP-DNM-0498"
    body = cap.requests[0]["body"]
    # The one system prompt every provider shares: objects never people,
    # NONE when unreadable — inherited, not re-written.
    assert body["system"] == llm.GrokProvider.VISION_SYSTEM
    img = body["messages"][0]["content"][0]
    assert img == {"type": "image", "source": {
        "type": "base64", "media_type": "image/jpeg", "data": "QUJD"}}
    assert body["temperature"] == 0


def test_missing_key_names_the_env_var(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    try:
        llm.AnthropicProvider()._key()
        assert False, "should have raised"
    except RuntimeError as e:
        assert "ANTHROPIC_API_KEY" in str(e)


def test_model_outage_falls_back_to_the_deterministic_script(monkeypatch):
    def boom(*a, **k):
        raise OSError("api down")
    monkeypatch.setattr(llm.urllib.request, "urlopen", boom)
    guest = {"name": "Sarah Chen", "loyalty_tier": "Icon", "loyalty_points": 4200,
             "sizes": {"tops": "M"}, "persona_tags": [], "purchase_history": []}
    out = llm.AnthropicProvider().generate_script(guest, [])
    assert out["provider"] == "anthropic (fallback: mock)"
    assert out["opener"]           # the associate still gets a card
    assert out["glasses_lines"]    # and the glass still gets its cue
