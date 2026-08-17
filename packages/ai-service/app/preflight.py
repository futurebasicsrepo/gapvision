"""Does the launch URL actually serve the app we are about to point a QR at?

── The failure this exists to prevent ────────────────────────────────────────

A provision token is not a login. It **is** the store's identity on a device:
whatever redeems it registers as that shop. On a URL-launched surface it
travels in a query string — `https://pocket.cuesea.ai/?t=<token>&tenant=gap` —
inside a QR an admin holds up for somebody to scan.

If that hostname is serving a different application, scanning the QR delivers a
live store credential into an unrelated deployment's URL: its request logs, its
analytics, and the phone's browser history. Pocket never receives it, the
pairing appears to simply fail, and the only correct recovery is to revoke and
reissue — which nobody does, because nothing said the token was burned.

This is not hypothetical. `pocket.cuesea.ai` spent its first hours pointing at
an old project, discovered by a human opening it, hours after the surface
shipped and minutes before anybody would have scanned one.

── How the check works ───────────────────────────────────────────────────────

Every surface we serve publishes `/.well-known/cue-surface.json` naming itself:

    { "app": "cue-pocket", "surface": "phone", "version": 1 }

Before minting, the origin of the launch URL is asked for that file. A host
that answers with the wrong app, or does not have the file at all, is a host
that must not receive a token.

Deliberately an explicit identity file rather than a guess about page content.
Sniffing a `<title>` or a manifest name would be a heuristic that gets looser
every time somebody renames something; a file whose entire job is to say which
app this is cannot drift.

── Fail closed, or fail open? Both, and the difference matters ───────────────

This mirrors `resolveDevice` in `packages/server`, which had to answer the same
question and got it right:

  **answered, and it is the wrong app** → refuse. This is a definite fact and
  the token would definitely be burned.

  **could not ask** (DNS, timeout, TLS, a 502) → allow, and say so. Refusing
  here would take device provisioning offline because a network blinked, for a
  check that did not exist last week. An admin who cannot mint during an outage
  is worse off than one who mints and verifies by hand.

The distinction is the whole design. "We know this is wrong" and "we could not
find out" are different sentences and only one of them should stop somebody.

── On fetching a URL from the server ─────────────────────────────────────────

Server-side fetch of a URL is an SSRF primitive when the URL comes from a
caller. This one does not: it is derived by `devices.launch_url()` from
`CUE_POCKET_URL` / `CUE_LENS_URL` / `CUE_CONSOLE_URL`, which only an operator
sets. The shape is enforced anyway — https only outside localhost, no
redirects, a short timeout, a small read cap — because "not attacker-controlled
today" is a property that changes without anyone noticing.
"""
from __future__ import annotations

import json
import os
import socket
import urllib.error
import urllib.request
from urllib.parse import urlparse

#: Which app each surface's launch URL must be served by.
#:
#: `even-g2` is absent on purpose: its launch URL is a sideload target for the
#: Even Hub rather than a web app we serve, so there is nothing to ask and no
#: check to make. A surface missing from this table is simply not checked.
EXPECTED_APP = {
    "phone": "cue-pocket",
    "mrbd": "cue-meta-lens",
    # The sim is served under Console's own origin, so Console is what answers.
    "sim": "cue-console",
}

WELL_KNOWN = "/.well-known/cue-surface.json"

#: Short. This runs inside a mint request with an admin watching a spinner, and
#: a slow answer is worse than no answer — the unreachable path is safe.
TIMEOUT_SECONDS = float(os.getenv("CUE_PREFLIGHT_TIMEOUT", "3"))
MAX_BYTES = 4096

#: Set to "0" to switch the check off entirely. Present because an operator
#: running an air-gapped or not-yet-public deployment has a legitimate reason,
#: and the alternative is that they cannot provision at all.
ENABLED = os.getenv("CUE_PREFLIGHT", "1") != "0"


class Verdict:
    """What we learned, and whether it should stop a mint.

    Three states rather than a boolean, for the reason in the module docstring:
    `ok` and `unreachable` both allow the mint and mean completely different
    things, and flattening them is how an outage becomes an outage plus a
    provisioning freeze.
    """

    def __init__(self, state: str, detail: str = "", found: str | None = None):
        self.state = state            # "ok" | "wrong-app" | "unreachable" | "skipped"
        self.detail = detail
        self.found = found

    @property
    def blocks(self) -> bool:
        return self.state == "wrong-app"

    def public(self) -> dict:
        out = {"state": self.state}
        if self.detail:
            out["detail"] = self.detail
        if self.found:
            out["found"] = self.found
        return out


def _origin(url: str) -> str | None:
    """The scheme and host of a launch URL, or None if it is not fetchable.

    https only, with localhost exempted so `npm run dev` works. A launch URL
    that is not https is a launch URL that should not carry a token anyway.
    """
    try:
        p = urlparse(url)
    except ValueError:
        return None
    if not p.hostname:
        return None
    local = p.hostname in ("localhost", "127.0.0.1", "::1")
    if p.scheme == "https" or (p.scheme == "http" and local):
        return f"{p.scheme}://{p.netloc}"
    return None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse redirects rather than follow them.

    A redirect is the mechanism by which "the host I checked" and "the host
    that will serve the QR" quietly become two different hosts, which is
    precisely the confusion this module exists to remove.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def check(surface: str, launch_url: str) -> Verdict:
    """Ask the launch URL's origin which app it is."""
    if not ENABLED:
        return Verdict("skipped", "Preflight is switched off on this deployment.")

    expected = EXPECTED_APP.get(surface)
    if expected is None:
        return Verdict("skipped", "This surface is not served by us.")

    origin = _origin(launch_url)
    if origin is None:
        return Verdict("unreachable", "The launch URL is not an https address we can check.")

    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(origin + WELL_KNOWN, timeout=TIMEOUT_SECONDS) as res:
            body = res.read(MAX_BYTES)
    except urllib.error.HTTPError as e:
        # A definite answer: the host is up and has no identity file. That is
        # exactly the shape of the bug — a live host serving something else.
        return Verdict(
            "wrong-app",
            f"{origin} answered {e.code} for {WELL_KNOWN}, so it is not serving "
            f"Cue. A token scanned from here would go to whatever is.",
        )
    except (urllib.error.URLError, socket.timeout, TimeoutError, OSError) as e:
        return Verdict("unreachable", f"Could not reach {origin}: {e}")

    try:
        found = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return Verdict("wrong-app", f"{origin} answered with something that is not Cue's surface file.")

    app = found.get("app")
    if app != expected:
        return Verdict(
            "wrong-app",
            f"{origin} is serving “{app or 'an unnamed app'}”, not “{expected}”. "
            f"A token scanned from here would go to the wrong application.",
            found=app,
        )
    return Verdict("ok", f"{origin} is serving {expected}.", found=app)
