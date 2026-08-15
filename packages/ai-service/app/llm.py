"""Provider-agnostic LLM layer.

Models are a config value, not an architecture decision. Set GAPVISION_LLM to
'mock' (default), 'grok', 'anthropic', 'openai', or 'google' and provide the
matching API key env var. The mock provider returns deterministic,
demo-friendly scripts shaped exactly like real provider output, so swapping
providers never changes the API contract.

**The model never writes what goes on the glass.** `cue` and `glasses_lines`
are built by `cue.py` from the same guest record regardless of provider. The
brand system specifies that grammar — three lines, uppercase, under 60
characters, no punctuation but the interpunct — and a model asked to be
creative inside it will eventually produce something four lines long at the
worst possible moment. Providers write the prose for the phone and the
dashboard; the glass stays deterministic.

**And the model is never the source of a fact.** `answer_question` is handed
the records we hold and told to answer from them or decline. That is the
standing decision — voice answers are grounded in records we hold, never a
model's guess about stock — expressed as a prompt and enforced by a test.
"""
import json
import os
import textwrap
import urllib.error
import urllib.request

from . import cue as cue_format


class BaseProvider:
    name = "base"

    def generate_script(self, guest: dict, recommendations: list[dict]) -> dict:
        raise NotImplementedError


class MockProvider(BaseProvider):
    """Deterministic template engine masquerading as an LLM. Free and instant."""

    name = "mock"

    def generate_script(self, guest: dict, recommendations: list[dict]) -> dict:
        first_name = guest["name"].split()[0]
        cart = guest.get("open_cart_online") or []
        top = recommendations[0] if recommendations else None

        if cart:
            opener = (
                f"{first_name} left the {cart[0]['name']} in their online cart — "
                f"offer to grab it in a {guest['sizes']['tops']} to try on."
            )
        elif guest["loyalty_tier"] == "Icon":
            opener = (
                f"{first_name} is an Icon member — thank them for their loyalty "
                f"before anything else."
            )
        else:
            opener = f"Greet {first_name} and ask what brings them in today."

        if top:
            upsell = (
                f"Their style leans {', '.join(guest['persona_tags'][:2])} — walk them to "
                f"{top['location']} and show the {top['name']} (${top['price']:.2f}). "
                f"We have their size in stock."
            )
        else:
            upsell = "Ask open questions about what they're shopping for today."

        closer = (
            f"At checkout: they have {guest['loyalty_points']} points"
            + (" — remind them points unlock double on denim this week." if guest[
                "loyalty_points"] >= 1000 else ".")
        )

        # The cue is designed for the glass first; the phone and the dashboard
        # get the same sentence with more room. `glasses_lines` stays as the
        # flat form for logs and the manager view.
        cue = cue_format.guest_cue(guest, top, cart)
        return {
            "provider": self.name,
            "opener": opener,
            "upsell": upsell,
            "closer": closer,
            "cue": cue,
            "glasses_lines": cue_format.flatten(cue),
        }


class GrokProvider(BaseProvider):
    """xAI Grok, over the OpenAI-compatible chat API.

    Config:
        GAPVISION_LLM=grok
        XAI_API_KEY=xai-...
        CUE_LLM_MODEL=grok-4.20-0309-non-reasoning   (default)

    The default is the non-reasoning model on purpose. Measured against this
    account, the reasoning models take ~9.6s for a one-sentence opener and the
    non-reasoning one ~1.2s. An associate is walking toward a customer while
    this resolves, and the platform check warns past 2.5s — deliberation is
    worth nothing here and costs the entire interaction.

    Not a vendor SDK: one urllib call, same as the Shopify adapter. A retail
    deployment does not need another dependency tree to keep patched.
    """

    name = "grok"

    URL = "https://api.x.ai/v1/chat/completions"
    DEFAULT_MODEL = "grok-4.20-0309-non-reasoning"
    TIMEOUT = 8

    def _key(self) -> str:
        key = os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY")
        if not key:
            raise RuntimeError(
                "GAPVISION_LLM=grok but XAI_API_KEY is unset. Set it on the "
                "ai-service, or set GAPVISION_LLM=mock."
            )
        return key

    def _chat(self, system: str, user: str, *, max_tokens: int = 400) -> str:
        body = json.dumps({
            "model": os.environ.get("CUE_LLM_MODEL", self.DEFAULT_MODEL),
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_tokens": max_tokens,
            "temperature": 0.3,
        }).encode()
        req = urllib.request.Request(
            self.URL, data=body, method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._key()}",
            },
        )
        with urllib.request.urlopen(req, timeout=self.TIMEOUT) as resp:
            out = json.loads(resp.read())
        return (out["choices"][0]["message"]["content"] or "").strip()

    @staticmethod
    def _json(raw: str) -> dict:
        """Models garnish JSON with prose and code fences. Dig it out."""
        raw = raw.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            raw = raw[4:] if raw.lower().startswith("json") else raw
        start, end = raw.find("{"), raw.rfind("}")
        if start == -1 or end <= start:
            raise ValueError("no JSON object in model output")
        return json.loads(raw[start:end + 1])

    # --- guest card prose ----------------------------------------------------

    SCRIPT_SYSTEM = textwrap.dedent("""\
        You write one-line coaching notes for a retail associate who is about to
        greet a specific customer. You are given that customer's real record.

        Rules:
        · Use only the facts given. Never invent a purchase, a size, a price, or
          stock. If a fact is missing, write around it.
        · Each field is one sentence, under 140 characters, plain and speakable.
        · No greeting templates, no exclamation marks, no "delight" or "elevate".
          Write the way a good floor manager briefs someone in passing.
        · Return JSON only: {"opener": ..., "upsell": ..., "closer": ...}
    """)

    def generate_script(self, guest: dict, recommendations: list[dict]) -> dict:
        cart = guest.get("open_cart_online") or []
        top = recommendations[0] if recommendations else None
        facts = {
            "name": guest["name"],
            "tier": guest["loyalty_tier"],
            "points": guest["loyalty_points"],
            "sizes": guest.get("sizes"),
            "style_tags": guest.get("persona_tags"),
            "recent_purchases": [p["name"] for p in guest.get("purchase_history", [])[:5]],
            "left_in_online_cart": [c["name"] for c in cart],
            "recommendation": top and {
                "name": top["name"], "price": top.get("price"),
                "location": top.get("location"), "in_stock": top.get("stock"),
            },
        }
        try:
            data = self._json(self._chat(
                self.SCRIPT_SYSTEM, json.dumps(facts, default=str), max_tokens=300
            ))
            opener = str(data.get("opener") or "").strip()
            upsell = str(data.get("upsell") or "").strip()
            closer = str(data.get("closer") or "").strip()
            if not opener:
                raise ValueError("model returned no opener")
        except Exception:
            # A model outage must not cost the associate their guest card. The
            # deterministic script is worse prose and entirely correct.
            fallback = MockProvider().generate_script(guest, recommendations)
            fallback["provider"] = f"{self.name} (fallback: mock)"
            return fallback

        # The glass grammar is not the model's to write — same cue every
        # provider produces, built from the record.
        cue = cue_format.guest_cue(guest, top, cart)
        return {
            "provider": self.name,
            "opener": opener,
            "upsell": upsell,
            "closer": closer,
            "cue": cue,
            "glasses_lines": cue_format.flatten(cue),
        }

    # --- open-ended voice questions -----------------------------------------

    ANSWER_SYSTEM = textwrap.dedent("""\
        You answer a retail associate's spoken question using ONLY the store
        records supplied below. The associate is wearing glasses and is standing
        with a customer.

        Hard rules:
        · Every claim must come from the supplied records. You may not estimate,
          infer, or generalise about stock, sizes, prices, or availability.
        · If the records do not answer the question, say so plainly in one
          sentence and suggest what would answer it — checking the stockroom,
          the till, another store. Do not guess and do not apologise at length.
        · Never state a stock level, size availability or price that is not in
          the records verbatim.
        · One or two short sentences. Under 200 characters. Speakable aloud.
        · Plain text. No markdown, no lists, no preamble.
    """)

    def answer_question(self, transcript: str, guest: dict | None,
                        item: dict | None, inventory: list[dict]) -> dict:
        records = {
            "question": transcript,
            "customer": guest and {
                "name": guest.get("name"),
                "tier": guest.get("loyalty_tier"),
                "sizes": guest.get("sizes"),
                "recent_purchases": [p["name"] for p in guest.get("purchase_history", [])[:5]],
            },
            "item_on_the_lens": item,
            # Only what the floor actually holds. If a size is not in here, the
            # honest answer is that we don't know it — which is the point.
            "floor_inventory": [
                {"name": i.get("name"), "price": i.get("price"),
                 "location": i.get("location"), "stock": i.get("stock"),
                 "tags": i.get("tags")}
                for i in (inventory or [])[:40]
            ],
        }
        answer = self._chat(
            self.ANSWER_SYSTEM, json.dumps(records, default=str), max_tokens=160
        )
        return {"answer": answer}


class AnthropicProvider(BaseProvider):
    """Stub: wire with `pip install anthropic` + ANTHROPIC_API_KEY."""

    name = "anthropic"

    def generate_script(self, guest, recommendations):
        raise RuntimeError(
            textwrap.dedent(
                """AnthropicProvider is stubbed. Install the sdk, set
                ANTHROPIC_API_KEY, and implement generate_script() with a
                prompt built from guest + recommendations. Return the same
                dict shape as MockProvider."""
            )
        )


class OpenAIProvider(BaseProvider):
    name = "openai"

    def generate_script(self, guest, recommendations):
        raise RuntimeError("OpenAIProvider is stubbed — see AnthropicProvider docstring.")


class GoogleProvider(BaseProvider):
    name = "google"

    def generate_script(self, guest, recommendations):
        raise RuntimeError("GoogleProvider is stubbed — see AnthropicProvider docstring.")


_PROVIDERS = {
    "mock": MockProvider,
    "grok": GrokProvider,
    "anthropic": AnthropicProvider,
    "openai": OpenAIProvider,
    "google": GoogleProvider,
}


def get_provider() -> BaseProvider:
    choice = os.environ.get("GAPVISION_LLM", "mock").lower()
    cls = _PROVIDERS.get(choice, MockProvider)
    return cls()
