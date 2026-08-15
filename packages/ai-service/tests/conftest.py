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
# The auth routes are throttled per-email and per-IP (see auth.throttle). The
# suite signs in as the same handful of accounts hundreds of times from one
# client, which is nothing like how a person uses this and everything like what
# the limiter exists to stop. Raise them here rather than testing the limiter
# by accident — `test_password_links.py` asserts it works, deliberately, with
# its own numbers.
os.environ.setdefault("CUE_LOGIN_EMAIL_LIMIT", "100000")
os.environ.setdefault("CUE_LOGIN_IP_LIMIT", "100000")
os.environ.setdefault("CUE_FORGOT_EMAIL_LIMIT", "100000")

# Credential sealing key. A fixed value here so a sealed row written by one
# test can be opened by another; production generates one per deployment with
# `openssl rand -hex 32`.
os.environ.setdefault("CUE_CRED_KEY", "11" * 32)

import pytest  # noqa: E402


@pytest.fixture
def api_key() -> str:
    return os.environ["GAPVISION_API_KEY"]


@pytest.fixture
def auth_headers(api_key) -> dict:
    return {"x-gapvision-key": api_key}
