"""PIN-based authentication for TmuxDeck.

Provides PIN hashing/verification, session management, and settings
integration via the store module.
"""

from __future__ import annotations

import hashlib
import os
import secrets
import time
from typing import Any

from . import store

# In-memory session store: token → expiry timestamp
_sessions: dict[str, float] = {}

SESSION_MAX_AGE = 7 * 24 * 60 * 60  # 7 days in seconds


def hash_pin(pin: str) -> str:
    """Hash a PIN with a random salt. Returns ``"salt_hex:hash_hex"``."""
    salt = os.urandom(16)
    h = hashlib.sha256(salt + pin.encode()).hexdigest()
    return f"{salt.hex()}:{h}"


def verify_pin(pin: str, stored: str) -> bool:
    """Verify *pin* against a ``"salt_hex:hash_hex"`` string (timing-safe)."""
    try:
        salt_hex, expected_hex = stored.split(":", 1)
    except ValueError:
        return False
    salt = bytes.fromhex(salt_hex)
    actual_hex = hashlib.sha256(salt + pin.encode()).hexdigest()
    return secrets.compare_digest(actual_hex, expected_hex)


def create_session() -> str:
    """Create a new session token and store it in memory."""
    token = secrets.token_urlsafe(32)
    _sessions[token] = time.time() + SESSION_MAX_AGE
    return token


def validate_session(token: str) -> bool:
    """Return True if *token* exists and hasn't expired."""
    expiry = _sessions.get(token)
    if expiry is None:
        return False
    if time.time() > expiry:
        _sessions.pop(token, None)
        return False
    return True


def destroy_session(token: str) -> None:
    """Remove a session token."""
    _sessions.pop(token, None)


# --- Settings helpers ---


def _get_settings() -> dict[str, Any]:
    return store.get_settings()


def is_pin_set() -> bool:
    return bool(_get_settings().get("pinHash"))


def get_pin_hash() -> str | None:
    return _get_settings().get("pinHash") or None


def set_pin_hash(pin_hash: str) -> None:
    store.update_settings({"pinHash": pin_hash})


# --- WebAuthn challenge store (in-memory, same pattern as sessions) ---

CHALLENGE_TTL = 120  # seconds

_webauthn_challenges: dict[str, tuple[bytes, float]] = {}


def store_challenge(key: str, challenge: bytes) -> None:
    """Store a WebAuthn challenge with a TTL."""
    _webauthn_challenges[key] = (challenge, time.time() + CHALLENGE_TTL)


def retrieve_challenge(key: str) -> bytes | None:
    """Retrieve and consume a one-time challenge. Returns None if expired/missing."""
    entry = _webauthn_challenges.pop(key, None)
    if entry is None:
        return None
    challenge, expiry = entry
    if time.time() > expiry:
        return None
    return challenge


# --- WebAuthn credential helpers ---


def get_webauthn_credentials() -> list[dict[str, Any]]:
    """Return list of stored WebAuthn credentials."""
    return _get_settings().get("webauthnCredentials", [])


def add_webauthn_credential(credential: dict[str, Any]) -> None:
    """Append a new WebAuthn credential to settings."""
    creds = get_webauthn_credentials()
    creds.append(credential)
    store.update_settings({"webauthnCredentials": creds})


def remove_webauthn_credential(credential_id: str) -> bool:
    """Remove a credential by its ID. Returns True if found and removed."""
    creds = get_webauthn_credentials()
    new_creds = [c for c in creds if c["id"] != credential_id]
    if len(new_creds) == len(creds):
        return False
    store.update_settings({"webauthnCredentials": new_creds})
    return True


def update_webauthn_sign_count(credential_id: str, new_count: int) -> None:
    """Update the sign count for a credential after successful authentication."""
    creds = get_webauthn_credentials()
    for c in creds:
        if c["id"] == credential_id:
            c["signCount"] = new_count
            break
    store.update_settings({"webauthnCredentials": creds})


def has_webauthn_credentials() -> bool:
    """Return True if any WebAuthn credentials are registered."""
    return len(get_webauthn_credentials()) > 0
