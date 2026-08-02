"""Provider-agnostic LLM layer.

Models are a config value, not an architecture decision. Set GAPVISION_LLM to
'mock' (default), 'anthropic', 'openai', or 'google' and provide the matching
API key env var. The mock provider returns deterministic, demo-friendly
scripts shaped exactly like real provider output, so swapping providers never
changes the API contract.
"""
import os
import textwrap


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

        return {
            "provider": self.name,
            "opener": opener,
            "upsell": upsell,
            "closer": closer,
            # Pre-formatted lines for the monochrome glasses display.
            "glasses_lines": _to_glasses_lines(guest, top, cart),
        }


def _to_glasses_lines(guest: dict, top: dict | None, cart: list[dict]) -> list[str]:
    """Format for a 576x288 monochrome display: short text lines + icon markers."""
    first_name = guest["name"].split()[0]
    lines = [
        f"[ICON:USER] {guest['name']}",
        f"[ICON:STAR] {guest['loyalty_tier']} * {guest['loyalty_points']} pts",
        f"[ICON:TAG] Size {guest['sizes']['tops']} top / {guest['sizes']['bottoms']}",
    ]
    if cart:
        lines.append(f"[ICON:CART] Online cart: {cart[0]['name']}")
    if top:
        lines.append(f"[ICON:ARROW] Show: {top['name']}")
        lines.append(f"        @ {top['location']} ${top['price']:.2f}")
    lines.append(f"[ICON:CHAT] \"Welcome back, {first_name}!\"")
    return lines


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
    "anthropic": AnthropicProvider,
    "openai": OpenAIProvider,
    "google": GoogleProvider,
}


def get_provider() -> BaseProvider:
    choice = os.environ.get("GAPVISION_LLM", "mock").lower()
    cls = _PROVIDERS.get(choice, MockProvider)
    return cls()
