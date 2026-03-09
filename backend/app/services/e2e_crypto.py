"""End-to-end encryption for relay WebSocket streams.

Uses ECDH P-256 for key exchange and AES-GCM for authenticated encryption.

Protocol:
  1. Client sends CLIENT_HELLO (ECDH pubkey + supported ciphers)
  2. Server responds with SERVER_HELLO (ECDH pubkey + selected cipher)
  3. Both derive shared AES key via HKDF-SHA256
  4. All subsequent messages are AES-GCM encrypted

Handshake message format (binary):
  [0x00 0xE2 0xEE 0x00] [version: 1] [type: 1] [payload...]

Encrypted message format (binary):
  [nonce: 12 bytes] [ciphertext + GCM tag: variable]
"""

from __future__ import annotations

import asyncio
import os
import struct
from hashlib import sha256

from cryptography.hazmat.primitives.asymmetric.ec import (
    ECDH,
    SECP256R1,
    EllipticCurvePublicKey,
    generate_private_key,
)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

# --- Constants ---

E2E_MAGIC = b"\x00\xe2\xee\x00"
PROTOCOL_VERSION = 1

MSG_CLIENT_HELLO = 0x01
MSG_SERVER_HELLO = 0x02

# Cipher IDs
CIPHER_AES_256_GCM = 0x01
CIPHER_AES_128_GCM = 0x02

# Server preference order (strongest first)
SERVER_CIPHER_PREFERENCE = [CIPHER_AES_256_GCM, CIPHER_AES_128_GCM]


def _cipher_key_bytes(cipher_id: int) -> int:
    return 16 if cipher_id == CIPHER_AES_128_GCM else 32


# --- Handshake parsing ---


def is_handshake_message(data: bytes) -> bool:
    return len(data) >= 6 and data[:4] == E2E_MAGIC


def _build_handshake(msg_type: int, payload: bytes) -> bytes:
    return E2E_MAGIC + bytes([PROTOCOL_VERSION, msg_type]) + payload


def _parse_client_hello(payload: bytes) -> tuple[list[int], bytes, bytes]:
    """Returns (supported_ciphers, client_pubkey, client_random)."""
    offset = 0
    cipher_count = payload[offset]
    offset += 1
    ciphers = list(payload[offset : offset + cipher_count])
    offset += cipher_count
    pubkey_len = struct.unpack(">H", payload[offset : offset + 2])[0]
    offset += 2
    pubkey = payload[offset : offset + pubkey_len]
    offset += pubkey_len
    client_random = payload[offset : offset + 32]
    return ciphers, pubkey, client_random


def _encode_server_hello(
    cipher_id: int, pubkey: bytes, server_random: bytes
) -> bytes:
    """Encode SERVER_HELLO payload."""
    return (
        bytes([cipher_id])
        + struct.pack(">H", len(pubkey))
        + pubkey
        + server_random
    )


# --- E2E Session ---


class E2ESession:
    """Encrypts/decrypts messages for a single WebSocket stream."""

    def __init__(self, aes_gcm: AESGCM):
        self._aes = aes_gcm
        self._send_counter = 0

    def _make_nonce(self, counter: int) -> bytes:
        """12-byte nonce: [direction:1][counter:7][zero:4].
        Server uses direction=0x02, client uses 0x01."""
        nonce = bytearray(12)
        nonce[0] = 0x02  # server direction
        counter_bytes = counter.to_bytes(7, "big")
        nonce[1:8] = counter_bytes
        return bytes(nonce)

    def encrypt(self, plaintext: bytes) -> bytes:
        """Encrypt plaintext, returns [nonce:12][ciphertext+tag]."""
        nonce = self._make_nonce(self._send_counter)
        self._send_counter += 1
        ct = self._aes.encrypt(nonce, plaintext, None)
        return nonce + ct

    def decrypt(self, data: bytes) -> bytes:
        """Decrypt [nonce:12][ciphertext+tag], returns plaintext."""
        nonce = data[:12]
        ciphertext = data[12:]
        return self._aes.decrypt(nonce, ciphertext, None)


def _handle_client_hello_sync(data: bytes) -> tuple[bytes, E2ESession]:
    """Synchronous implementation of the E2E handshake (CPU-intensive).

    Performs ECDH key generation, shared secret exchange, and HKDF derivation.
    Should be called via asyncio.to_thread() to avoid blocking the event loop.
    """
    payload = data[6:]  # skip magic + version + type
    client_ciphers, client_pubkey_raw, client_random = _parse_client_hello(
        payload
    )

    # Select strongest cipher both sides support
    selected = None
    for cipher in SERVER_CIPHER_PREFERENCE:
        if cipher in client_ciphers:
            selected = cipher
            break
    if selected is None:
        raise ValueError("No mutually supported cipher")

    # Generate ephemeral ECDH key pair
    private_key = generate_private_key(SECP256R1())
    public_key = private_key.public_key()

    # Export our public key in uncompressed point format (same as Web Crypto 'raw')
    server_pubkey_raw = public_key.public_bytes(
        Encoding.X962, PublicFormat.UncompressedPoint
    )

    # Import client's public key
    client_pubkey = EllipticCurvePublicKey.from_encoded_point(
        SECP256R1(), client_pubkey_raw
    )

    # ECDH shared secret
    shared_secret = private_key.exchange(ECDH(), client_pubkey)

    # Server random
    server_random = os.urandom(32)

    # Salt = SHA-256(client_random || server_random) for transcript binding
    transcript = client_random + server_random
    salt = sha256(transcript).digest()

    # Derive AES key via HKDF
    key_bytes = _cipher_key_bytes(selected)
    derived_key = HKDF(
        algorithm=SHA256(),
        length=key_bytes,
        salt=salt,
        info=b"tmuxdeck-e2e-v1",
    ).derive(shared_secret)

    aes = AESGCM(derived_key)
    session = E2ESession(aes)

    # Build SERVER_HELLO
    hello_payload = _encode_server_hello(
        selected, server_pubkey_raw, server_random
    )
    server_hello = _build_handshake(MSG_SERVER_HELLO, hello_payload)

    return server_hello, session


async def handle_client_hello(data: bytes) -> tuple[bytes, E2ESession]:
    """Process a CLIENT_HELLO message and return (SERVER_HELLO_bytes, session).

    Offloads CPU-intensive crypto operations to a thread to avoid blocking
    the event loop.
    """
    return await asyncio.to_thread(_handle_client_hello_sync, data)
