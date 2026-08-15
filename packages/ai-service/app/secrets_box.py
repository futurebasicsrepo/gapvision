"""Sealed secrets — AES-256-GCM, key held by the process, never by Postgres.

What this is for: a merchant's Shopify Admin token. That token can read every
customer, every order, and every price in their store. It is the most dangerous
thing Cue will ever hold on someone else's behalf, and it has to sit in a
database that gets backed up, replicated, and occasionally handed to a support
engineer at 2am.

Why not pgcrypto, which is already enabled: with `pgp_sym_encrypt` the key
travels to Postgres on every read and write, so the database process sees it.
The threat this module exists to cover — a stolen dump, a replica, a read-only
SQL injection — is exactly the one where the attacker is on the database side.
Encrypting in the application means the ciphertext is all the database ever
holds, and the key lives only in the service's environment.

Key material comes from `CUE_CRED_KEY` (32 bytes, hex or base64). Generate one
with:

    openssl rand -hex 32

Rotation: set `CUE_CRED_KEY` to the new key and `CUE_CRED_KEY_OLD` to the
previous one. Both are tried on open; only the current key is used to seal.
Every sealed row records `key_id` — the first 8 hex of the key's SHA-256 — so
you can tell at a glance which rows still need re-sealing without ever
comparing key material. Drop `CUE_CRED_KEY_OLD` once no row reports the old id.

The AAD binds each ciphertext to the tenant it belongs to. Moving a sealed
token from one tenant's row to another — the obvious move for someone with
write access to the database but not the key — fails to open rather than
silently pointing Cue at a store it should not read.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import os

try:  # pragma: no cover - exercised by the absence of the package
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    _HAVE_CRYPTO = True
except ImportError:  # the service must still boot; the feature reports as off
    AESGCM = None  # type: ignore[assignment]
    _HAVE_CRYPTO = False

NONCE_BYTES = 12
KEY_BYTES = 32


class SecretsNotConfigured(RuntimeError):
    """No usable key. Kept distinct from a decryption failure: 'you haven't set
    this up' and 'this ciphertext is wrong' want different answers."""


class SecretsUnavailable(RuntimeError):
    """The `cryptography` package is missing from the image."""


def _decode_key(raw: str) -> bytes:
    """Accept hex or base64 — whichever the operator's tooling produced."""
    raw = raw.strip()
    try:
        key = bytes.fromhex(raw)
        if len(key) == KEY_BYTES:
            return key
    except ValueError:
        pass
    for decoder in (base64.urlsafe_b64decode, base64.b64decode):
        try:
            key = decoder(raw + "=" * (-len(raw) % 4))
            if len(key) == KEY_BYTES:
                return key
        except (binascii.Error, ValueError):
            continue
    raise SecretsNotConfigured(
        f"CUE_CRED_KEY must decode to {KEY_BYTES} bytes (hex or base64). "
        "Generate one with: openssl rand -hex 32"
    )


def key_id(key: bytes) -> str:
    """A stable public name for a key that reveals nothing about it."""
    return hashlib.sha256(key).hexdigest()[:8]


def _keys() -> list[bytes]:
    """Current key first, then any retired key still needed to open old rows."""
    out: list[bytes] = []
    for var in ("CUE_CRED_KEY", "CUE_CRED_KEY_OLD"):
        raw = os.environ.get(var)
        if raw:
            out.append(_decode_key(raw))
    return out


def configured() -> bool:
    if not _HAVE_CRYPTO:
        return False
    try:
        return bool(_keys())
    except SecretsNotConfigured:
        return False


def status() -> dict:
    """Reported by /health. Names the key, never the key material."""
    if not _HAVE_CRYPTO:
        return {"configured": False, "error": "cryptography package not installed"}
    try:
        keys = _keys()
    except SecretsNotConfigured as e:
        return {"configured": False, "error": str(e)}
    if not keys:
        return {"configured": False, "error": "CUE_CRED_KEY is not set"}
    return {
        "configured": True,
        "key_id": key_id(keys[0]),
        "rotation_key_present": len(keys) > 1,
    }


def _require_keys() -> list[bytes]:
    if not _HAVE_CRYPTO:
        raise SecretsUnavailable(
            "The `cryptography` package is not installed, so stored credentials "
            "cannot be read or written. Add it to requirements.txt and redeploy."
        )
    keys = _keys()
    if not keys:
        raise SecretsNotConfigured(
            "CUE_CRED_KEY is not set, so credentials cannot be sealed or opened. "
            "Generate one with: openssl rand -hex 32"
        )
    return keys


def seal(plaintext: str, *, aad: str) -> tuple[bytes, str]:
    """Encrypt with the current key. Returns (nonce||ciphertext, key_id)."""
    keys = _require_keys()
    key = keys[0]
    nonce = os.urandom(NONCE_BYTES)
    ct = AESGCM(key).encrypt(nonce, plaintext.encode(), aad.encode())
    return nonce + ct, key_id(key)


def open_sealed(blob: bytes, *, aad: str, expect_key_id: str | None = None) -> str:
    """Decrypt. Tries the current key, then the retired one.

    `expect_key_id` only picks which key to try first; a row whose recorded id
    matches no available key is still attempted against everything we have,
    because the recorded id is a hint from the database and the database is the
    thing we are defending against.
    """
    keys = _require_keys()
    if expect_key_id:
        keys = sorted(keys, key=lambda k: key_id(k) != expect_key_id)

    blob = bytes(blob)
    if len(blob) <= NONCE_BYTES:
        raise ValueError("Sealed value is truncated")
    nonce, ct = blob[:NONCE_BYTES], blob[NONCE_BYTES:]

    for key in keys:
        try:
            return AESGCM(key).decrypt(nonce, ct, aad.encode()).decode()
        except Exception:
            continue
    raise ValueError(
        "Could not open the sealed credential with any configured key. "
        "If CUE_CRED_KEY was rotated, set CUE_CRED_KEY_OLD to the previous key."
    )


def fingerprint(plaintext: str) -> str:
    """A safe-to-display stand-in for a secret.

    Last four characters plus a short hash, so an operator can confirm which
    token is installed by comparing it against what Shopify shows them, without
    the console ever rendering the secret itself. The hash is salted with a
    fixed label so this value is not a useful oracle for guessing short tokens.
    """
    digest = hashlib.sha256(("cue-cred-fp:" + plaintext).encode()).hexdigest()[:8]
    tail = plaintext[-4:] if len(plaintext) >= 4 else ""
    return f"…{tail}·{digest}"
