"""Test configuration.

`app.auth` reads its mode and key from the environment at import time, so
these have to be set before any test module imports the app. A key is set
here (rather than running in `demo` mode) so the tests exercise the guarded
path the way production does — including the tests that assert an
unauthenticated call is refused.
"""
import os

os.environ.setdefault("GAPVISION_AUTH_MODE", "strict")
os.environ.setdefault("GAPVISION_API_KEY", "test-key-" + "0" * 32)
# Rate limiting is per-IP and in-memory; the suite fires many requests from
# one client, so give it room rather than testing the limiter by accident.
os.environ.setdefault("GAPVISION_RATE_LIMIT", "100000")

import pytest  # noqa: E402


@pytest.fixture
def api_key() -> str:
    return os.environ["GAPVISION_API_KEY"]


@pytest.fixture
def auth_headers(api_key) -> dict:
    return {"x-gapvision-key": api_key}
