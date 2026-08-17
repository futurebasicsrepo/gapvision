"""Device identity — minting, resolving, and what a device is allowed to say.

A device row used to be a note about hardware somebody was holding. It is now
the thing a lens authenticates as, which changes the rules around it:

* **The token is the identity.** Two of the three surfaces expose no serial to
  the page — the Meta Ray-Ban Display lens is a URL, the Lens Sim is a browser
  tab — so identity has to be minted, not read.
* **Shown once, stored hashed.** The same recipe as `auth_tokens` and
  `password_resets`, deliberately: one hashing rule in this service, and a
  leaked backup hands over nothing.
* **The hash never leaves the process.** Every row that reaches a response
  goes through `public()` first. A route that returns `SELECT d.*` from this
  table is a route that publishes credentials, which is why `public()` is not
  optional and why the older device routes were changed to use it.

The `sim` surface is first-class on purpose. A tenant onboarding before their
hardware arrives gets a provisioned, attributable lens in a browser tab, and
everything downstream exercises the real pipeline. It is badged in Console and
filterable out of analytics (`WHERE surface != 'sim'`) so demo traffic never
lands in a pilot's numbers.
"""
from __future__ import annotations

import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from . import db, identity

#: What renders the lens. Matches the CHECK in 011, extended by 013.
#:
#: `phone` means a **store-owned handheld** and nothing else. An associate's own
#: phone never appears in this table: it authenticates as a person through
#: `auth_tokens`, so revoking them in Console revokes it, and nobody has to
#: chase a handset that left with somebody who quit. The distinction is the
#: whole reason the phone surface was safe to add — see migration 013.
SURFACES = ("even-g2", "mrbd", "sim", "phone")

#: Surfaces provisioned by pointing a camera at a screen. A QR is the natural
#: medium when the device has a camera and no keyboard worth typing a token
#: into, which is true of the G2 and true of every phone; a Meta launch URL
#: goes through Meta's own share flow and the sim is a browser tab somebody
#: already has open.
QR_SURFACES = ("even-g2", "phone")

#: How long after a register a device still counts as on the floor. Registers
#: are re-sent on reconnect and hourly, so this is "we heard from it recently",
#: not "somebody is wearing it".
ACTIVE_WINDOW = timedelta(minutes=10)

#: The realtime server may register a device it has never heard of when nothing
#: is provisioned yet — localhost, a fresh clone, a demo laptop. Production
#: leaves this unset and unprovisioned registers are refused.
DEV_ALLOW_UNPROVISIONED = os.getenv("CUE_DEV_ALLOW_UNPROVISIONED") == "1"


# --- tokens ------------------------------------------------------------------

def mint_token() -> str:
    """A fresh provision token. 32 bytes, URL-safe — it travels in a query
    string and through a QR code, and both are unforgiving about padding."""
    return secrets.token_urlsafe(32)


def _hash(token: str) -> str:
    return identity.token_hash(token)


# --- launch URLs -------------------------------------------------------------
#
# Derived here rather than assembled in Console, for two reasons: a client that
# builds URLs is a client that has to be redeployed when a hostname moves, and
# a QR renderer whose job is "encode this string" cannot encode the wrong one.

def _base(name: str, default: str) -> str:
    return os.getenv(name, default).rstrip("/")


def launch_url(surface: str, tenant_slug: str, token: str) -> str:
    """Where this device's lens lives, with its token on it.

    `tenant` rides along beside the token because the lens needs it to
    register, and asking the network for it before the socket is up is a round
    trip in front of the first frame. It is a hint, never an authorisation:
    the tenant a device belongs to is resolved from the token server-side, and
    a mismatched `?tenant=` is refused, not honoured.
    """
    q = f"?t={quote(token)}&tenant={quote(tenant_slug)}"
    if surface == "mrbd":
        return _base("CUE_LENS_URL", "https://lens.cuesea.ai") + "/" + q
    if surface == "phone":
        # Its own origin, not Console's. Pocket is an installable app on a
        # device that leaves the building, and giving it the staff origin would
        # put a service-worker scope and a home-screen icon for `internal.` on
        # a handset — a same-origin foothold on the admin surface for the sake
        # of saving a DNS record.
        return _base("CUE_POCKET_URL", "https://pocket.cuesea.ai") + "/" + q
    if surface == "sim":
        # Served under Console's own origin: the sim's postMessage bridge is
        # same-origin-only on purpose, and a page that can iframe the lens
        # cross-origin could drive it.
        return _base("CUE_CONSOLE_URL", "https://internal.cuesea.ai") + "/lens-sim/sim.html" + q
    # even-g2: the sideload/launch URL the Even Hub plugin already carries.
    return _base("CUE_G2_LAUNCH_URL",
                 _base("CUE_LENS_URL", "https://lens.cuesea.ai") + "/g2") + "/" + q


def qr_rows(url: str) -> list[str] | None:
    """The provisioning QR, as a matrix of '0'/'1' rows.

    Generated **here, at mint**, and nowhere else — the token is stored hashed,
    so this is the only moment in the device's life when a QR of its launch URL
    can be produced at all. There is no "show me that QR again" route to write,
    because there is nothing left to write it from.

    A matrix rather than an SVG or a data URI, for one reason: what Console
    receives should be inert. Rows of two characters cannot carry markup, so the
    console draws rectangles from data instead of injecting a document
    fragment that arrived over the network into its own DOM.

    Returns None rather than raising if segno is missing — a QR is a
    convenience on top of a launch URL that is already in the response, and a
    dependency that failed to install must not be the reason a device cannot be
    provisioned.
    """
    try:
        import segno
    except ImportError:  # pragma: no cover - depends on the deployment
        print("[cue] segno is not installed; minting without a QR", flush=True)
        return None
    # Error correction 'm': the same level the printed plates use, chosen there
    # because a plate picks up scuffs. A screen does not, but matching keeps one
    # answer to "how dense is a Cue QR".
    return ["".join("1" if m else "0" for m in row)
            for row in segno.make(url, error="m").matrix]


# --- reading -----------------------------------------------------------------

def presence(row: dict) -> str:
    """Derived, never stored — `devices.status` is a different question.

    `status` is what an admin decided about a unit (active / retired / lost).
    This is what the fleet is doing right now, and the two disagree constantly:
    a pair marked active that nobody has switched on all week is exactly the
    row worth surfacing, and a column that overwrote one meaning with the other
    would hide it.
    """
    if row.get("revoked_at"):
        return "revoked"
    seen = row.get("last_seen_at")
    if not seen:
        return "provisioned"
    if isinstance(seen, str):
        try:
            seen = datetime.fromisoformat(seen)
        except ValueError:
            return "idle"
    if seen.tzinfo is None:
        seen = seen.replace(tzinfo=timezone.utc)
    return "active" if datetime.now(timezone.utc) - seen <= ACTIVE_WINDOW else "idle"


def public(row: dict | None) -> dict | None:
    """A device row that is safe to send anywhere.

    Drops the token hash and adds the derived presence. Everything that returns
    a device goes through here — including the routes that predate provisioning,
    because they select `d.*` and would otherwise have started publishing
    credentials the moment 011 ran.
    """
    if row is None:
        return None
    out = {k: v for k, v in row.items() if k != "provision_token_hash"}
    out["provisioned"] = bool(row.get("provision_token_hash"))
    out["presence"] = presence(row)
    return out


def list_for_tenant(tenant_id: str) -> list[dict]:
    rows = db.query(
        """
        SELECT d.*, u.name AS assigned_to
          FROM devices d LEFT JOIN users u ON u.id = d.user_id
         WHERE d.tenant_id = %s
         ORDER BY d.surface, d.label NULLS LAST, d.serial NULLS LAST
        """,
        (tenant_id,),
    )
    return [public(r) for r in rows]


# --- writing -----------------------------------------------------------------

def create(tenant_id: str, tenant_slug: str, *, surface: str, label: str | None = None,
           serial: str | None = None, user_id: str | None = None) -> tuple[dict, str]:
    """Mint a device. Returns the public row and the token, which is the only
    time the token exists anywhere outside the caller's response body."""
    token = mint_token()
    now = datetime.now(timezone.utc)
    row = db.query_one(
        """
        INSERT INTO devices (tenant_id, user_id, surface, serial, label,
                             provision_token_hash, provisioned_at, assigned_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING *
        """,
        (tenant_id, user_id, surface, serial or None, label,
         _hash(token), now, now if user_id else None),
    )
    return public(row), token


def reissue(device_id: str) -> tuple[dict, str]:
    """A new token for an existing device. The old one stops working the moment
    this returns — there is no grace window, because the reason somebody
    reissues is that the old token is somewhere it should not be."""
    token = mint_token()
    row = db.query_one(
        """
        UPDATE devices
           SET provision_token_hash = %s, provisioned_at = now(), revoked_at = NULL
         WHERE id = %s
        RETURNING *
        """,
        (_hash(token), device_id),
    )
    return public(row), token


def revoke(device_id: str) -> dict | None:
    """Stop this device registering, and keep the row.

    The hash stays. A revoked token that keeps knocking is a fact worth having
    — it is a pair somebody still has — and clearing the hash would turn that
    into an anonymous 401 from nowhere.
    """
    return public(db.query_one(
        "UPDATE devices SET revoked_at = now() WHERE id = %s RETURNING *",
        (device_id,),
    ))


# --- the register handshake ---------------------------------------------------

def resolve(token: str, tenant: str | None = None) -> dict | None:
    """Who is presenting this token, or None.

    None covers every failure — unknown, revoked, wrong tenant — and the caller
    turns all of them into the same 401. Same posture as `scope_tenant`: a
    device that names a tenant it does not belong to is told nothing about
    whether that tenant, or that token, exists.
    """
    if not token:
        return None
    row = db.query_one(
        """
        SELECT d.*, t.slug AS tenant_slug
          FROM devices d JOIN tenants t ON t.id = d.tenant_id
         WHERE d.provision_token_hash = %s
        """,
        (_hash(token),),
    )
    if row is None or row.get("revoked_at"):
        return None
    if row.get("status") in ("retired", "lost"):
        # An admin has said this unit is gone. Believe them.
        return None
    if tenant and tenant not in (row["tenant_slug"], str(row["tenant_id"])):
        return None
    return row


def seen(device_id: str, meta: dict | None = None) -> None:
    """Stamp a register. Fire-and-forget: a heartbeat that raises must never
    be the reason an associate's lens fails to come up."""
    try:
        db.execute(
            """
            UPDATE devices
               SET last_seen_at = now(),
                   last_seen_meta = COALESCE(%s::jsonb, last_seen_meta)
             WHERE id = %s
            """,
            (json.dumps(_clean_meta(meta)) if meta else None, device_id),
        )
    except Exception as exc:  # pragma: no cover - diagnostics only
        print(f"[cue] device heartbeat failed for {device_id}: {exc}", flush=True)


#: What a device is allowed to tell us about itself. A whitelist rather than
#: the whole payload: this blob is written by whatever is on the other end of
#: the socket, and an unbounded jsonb written by an unauthenticated-ish client
#: is a place to park a megabyte.
_META_KEYS = ("mode", "app_version", "ua", "surface", "zone")


def _clean_meta(meta: dict | None) -> dict:
    out = {}
    for k in _META_KEYS:
        v = (meta or {}).get(k)
        if isinstance(v, str) and v:
            out[k] = v[:200]
    return out
