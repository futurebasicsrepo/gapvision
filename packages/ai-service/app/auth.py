"""Service authentication for the GapVision AI service.

These endpoints serve real customer records — names, sizes, purchase history,
open carts. Before this module they were reachable by anyone who knew the
Railway hostname: one call listed every customer, the next dumped each profile.

Design notes:

* **Fail closed.** If a tenant is backed by a real CRM and no API key is
  configured, the request is refused. A missing env var must not silently
  reopen the door.
* **Browsers never hold the key.** The glasses plugin and web dashboard are
  static bundles; a key shipped to them is a published key. They call the
  realtime server instead, which holds the key server-side and proxies.
* **Rate limited.** These endpoints are enumerable by design — a roster call
  hands you the ids for the detail call. Per-instance and in-memory, so it is
  a speed bump against scraping, not a defence against a distributed attacker.
"""
from __future__ import annotations

import hmac
import os
import time
from collections import defaultdict, deque

from fastapi import Header, HTTPException, Request

HEADER = "x-gapvision-key"

# Tenants whose data is synthetic. Everything else is presumed to be real
# people until proven otherwise.
DEMO_TENANTS = {"gap"}

# strict — every API call needs a key (default, correct end state)
# demo   — mock-data tenants readable without a key; real CRMs always need one
AUTH_MODE = os.environ.get("GAPVISION_AUTH_MODE", "strict").lower()

RATE_LIMIT = int(os.environ.get("GAPVISION_RATE_LIMIT", "60"))  # requests
RATE_WINDOW = int(os.environ.get("GAPVISION_RATE_WINDOW", "60"))  # seconds

_hits: dict[str, deque[float]] = defaultdict(deque)


def _configured_key() -> str | None:
    """The service key this deployment expects, whitespace and all removed.

    Trimmed, and that is not cosmetic. A key is set by pasting it into a
    dashboard, and a paste carries a trailing newline about as often as not —
    invisible in every UI that displays the value. Untrimmed, that newline
    becomes part of what we *demand*, so a caller who copied the same key
    cleanly is rejected with a 401 that says "wrong key" about a key that is
    right. That is exactly what happened on 18 Aug: the deck host was fixed to
    trim what it *sends*, and the mismatch survived, because the whitespace
    was on this side.

    Trimming both ends is the only version that converges. It costs nothing —
    a service key with meaningful leading or trailing whitespace is not a
    thing — and an attacker still needs the whole key.
    """
    key = (os.environ.get("GAPVISION_API_KEY") or "").strip()
    return key or None


def startup_check() -> dict:
    """Called at import time from main. Loud about an unsafe configuration."""
    key = _configured_key()
    state = {
        "auth_mode": AUTH_MODE,
        "api_key_configured": bool(key),
    }
    if not key:
        print(
            "[gapvision] WARNING: GAPVISION_API_KEY is not set. "
            "Requests for non-demo tenants will be refused with 503. "
            "Set it in the Railway dashboard.",
            flush=True,
        )
    elif len(key) < 32:
        print(
            "[gapvision] WARNING: GAPVISION_API_KEY is shorter than 32 chars. "
            "Generate one with: openssl rand -hex 32",
            flush=True,
        )
    return state


def _client_ip(request: Request) -> str:
    # Railway terminates TLS upstream, so the socket peer is the proxy.
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def throttle_key(key: str, limit: int, window: int) -> None:
    """Rate limit an arbitrary key. See `throttle` for why there are two."""
    now = time.monotonic()
    hits = _hits[key]
    while hits and now - hits[0] > window:
        hits.popleft()
    if len(hits) >= limit:
        raise HTTPException(
            status_code=429,
            detail="Too many attempts. Wait a minute and try again.",
            headers={"Retry-After": str(window)},
        )
    hits.append(now)


def throttle(request: Request, bucket: str, limit: int, window: int) -> None:
    """A named, independent rate limit.

    The service-key limiter below is generous by design — the realtime server
    is one client making a lot of legitimate calls. The auth routes are the
    opposite: a handful of requests from a human, and the two abuse surfaces
    the service key does not have.

    Login, because it is the one endpoint where guessing pays. And
    forgot-password, because it sends mail to an address the caller chooses,
    which makes it a free email cannon pointed at anybody with an account.
    Neither had a limit before; the module docstring's promise of rate
    limiting only ever covered `/api/*`.

    Keyed per bucket *and* per IP, so a burst of logins cannot exhaust
    somebody else's reset allowance.

    **Per-IP alone is not enough, and getting that wrong would have shipped.**
    A store is one NAT. Ten associates signing in at the start of a shift come
    from a single address, and an IP-only limit tight enough to stop somebody
    guessing one password is also tight enough to lock out the morning. So the
    auth routes throttle on two keys: the *email* tightly, because that is the
    one an attacker is grinding, and the *IP* loosely, because that is a
    building full of people who all work here.
    """
    throttle_key(f"{bucket}:{_client_ip(request)}", limit, window)


def _rate_limit(request: Request) -> None:
    ip = _client_ip(request)
    now = time.monotonic()
    window = _hits[ip]

    while window and now - window[0] > RATE_WINDOW:
        window.popleft()

    if len(window) >= RATE_LIMIT:
        raise HTTPException(
            status_code=429,
            detail="Too many requests",
            headers={"Retry-After": str(RATE_WINDOW)},
        )

    window.append(now)

    # Bound memory: drop idle buckets occasionally.
    if len(_hits) > 5000:
        for k in [k for k, v in _hits.items() if not v or now - v[-1] > RATE_WINDOW * 5]:
            _hits.pop(k, None)


def require_key(tenant: str | None, request: Request, supplied: str | None) -> None:
    """Raise unless this request may read this tenant's data."""
    _rate_limit(request)

    is_demo = (tenant or "gap").lower() in DEMO_TENANTS
    if AUTH_MODE == "demo" and is_demo:
        return

    expected = _configured_key()
    if not expected:
        # Fail closed. Never fall through to serving data.
        raise HTTPException(
            status_code=503,
            detail="Service is not configured to serve this tenant.",
        )

    # The header is trimmed for the same reason, and separately: a proxy or a
    # hand-rolled client may pad it, and neither end should have to be careful
    # about whitespace to be correct.
    supplied = (supplied or "").strip()
    if not supplied or not hmac.compare_digest(supplied, expected):
        # Same response whether the header was absent or wrong.
        raise HTTPException(status_code=401, detail="Unauthorized")


def guard(request: Request, tenant: str | None, x_gapvision_key: str | None) -> None:
    """Thin wrapper so route signatures stay readable."""
    require_key(tenant, request, x_gapvision_key)


# Convenience for FastAPI's Header() default in route signatures.
KeyHeader = Header(default=None, alias=HEADER)
