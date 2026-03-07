"""Tests for E2E encryption module."""

import struct

import pytest

from app.services.e2e_crypto import (
    CIPHER_AES_128_GCM,
    CIPHER_AES_256_GCM,
    E2E_MAGIC,
    MSG_CLIENT_HELLO,
    PROTOCOL_VERSION,
    E2ESession,
    handle_client_hello,
    is_handshake_message,
)

from cryptography.hazmat.primitives.asymmetric.ec import generate_private_key, SECP256R1, ECDH
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from hashlib import sha256
import os


def _build_client_hello(client_pubkey_raw: bytes, client_random: bytes) -> bytes:
    """Build a CLIENT_HELLO message like the browser would."""
    ciphers = [CIPHER_AES_256_GCM, CIPHER_AES_128_GCM]
    payload = bytearray()
    payload.append(len(ciphers))
    payload.extend(ciphers)
    payload.extend(struct.pack(">H", len(client_pubkey_raw)))
    payload.extend(client_pubkey_raw)
    payload.extend(client_random)
    return E2E_MAGIC + bytes([PROTOCOL_VERSION, MSG_CLIENT_HELLO]) + bytes(payload)


def _parse_server_hello(data: bytes):
    """Parse SERVER_HELLO like the browser would."""
    payload = data[6:]  # skip magic + version + type
    offset = 0
    selected_cipher = payload[offset]; offset += 1
    pubkey_len = struct.unpack(">H", payload[offset:offset + 2])[0]; offset += 2
    server_pubkey = payload[offset:offset + pubkey_len]; offset += pubkey_len
    server_random = payload[offset:offset + 32]
    return selected_cipher, server_pubkey, server_random


class TestE2ECrypto:
    def test_is_handshake_message(self):
        assert is_handshake_message(b"\x00\xe2\xee\x00\x01\x01payload")
        assert not is_handshake_message(b"hello")
        assert not is_handshake_message(b"\x00\xe2\xee")

    def test_full_handshake_and_roundtrip(self):
        """Simulate a full handshake as browser (client) + backend (server)."""
        # --- Client side: generate key pair ---
        client_private = generate_private_key(SECP256R1())
        client_public = client_private.public_key()
        client_pubkey_raw = client_public.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
        client_random = os.urandom(32)

        # Build CLIENT_HELLO
        client_hello = _build_client_hello(client_pubkey_raw, client_random)
        assert is_handshake_message(client_hello)

        # --- Server side: handle_client_hello ---
        server_hello_bytes, server_session = handle_client_hello(client_hello)
        assert is_handshake_message(server_hello_bytes)

        # --- Client side: parse SERVER_HELLO and derive key ---
        selected_cipher, server_pubkey_raw, server_random = _parse_server_hello(server_hello_bytes)
        assert selected_cipher == CIPHER_AES_256_GCM

        from cryptography.hazmat.primitives.asymmetric.ec import EllipticCurvePublicKey
        server_pubkey = EllipticCurvePublicKey.from_encoded_point(SECP256R1(), server_pubkey_raw)

        shared_secret = client_private.exchange(ECDH(), server_pubkey)

        transcript = client_random + server_random
        salt = sha256(transcript).digest()

        derived_key = HKDF(
            algorithm=SHA256(),
            length=32,  # AES-256
            salt=salt,
            info=b"tmuxdeck-e2e-v1",
        ).derive(shared_secret)

        client_aes = AESGCM(derived_key)

        # --- Encrypt/decrypt roundtrip: client -> server ---
        plaintext = b"echo hello world\r"
        # Client encrypts (direction=0x01)
        client_nonce = bytearray(12)
        client_nonce[0] = 0x01  # client direction
        ct = client_aes.encrypt(bytes(client_nonce), plaintext, None)
        encrypted_msg = bytes(client_nonce) + ct

        # Server decrypts
        decrypted = server_session.decrypt(encrypted_msg)
        assert decrypted == plaintext

        # --- Encrypt/decrypt roundtrip: server -> client ---
        server_plaintext = b"\x1b[32mhello\x1b[0m"
        encrypted_from_server = server_session.encrypt(server_plaintext)

        # Client decrypts (direction=0x02)
        nonce = encrypted_from_server[:12]
        ct = encrypted_from_server[12:]
        client_decrypted = client_aes.decrypt(nonce, ct, None)
        assert client_decrypted == server_plaintext

    def test_tampered_ciphertext_fails(self):
        """Verify that modifying ciphertext causes decryption to fail (integrity)."""
        client_private = generate_private_key(SECP256R1())
        client_pubkey_raw = client_private.public_key().public_bytes(
            Encoding.X962, PublicFormat.UncompressedPoint
        )
        client_random = os.urandom(32)

        client_hello = _build_client_hello(client_pubkey_raw, client_random)
        server_hello_bytes, server_session = handle_client_hello(client_hello)

        # Server encrypts a message
        encrypted = server_session.encrypt(b"sensitive data")

        # Tamper with the ciphertext (flip a byte)
        tampered = bytearray(encrypted)
        tampered[15] ^= 0xFF  # flip a byte in the ciphertext
        tampered = bytes(tampered)

        # Client-side decryption should fail
        _, server_pubkey_raw, server_random = _parse_server_hello(server_hello_bytes)
        from cryptography.hazmat.primitives.asymmetric.ec import EllipticCurvePublicKey
        server_pubkey = EllipticCurvePublicKey.from_encoded_point(SECP256R1(), server_pubkey_raw)
        shared_secret = client_private.exchange(ECDH(), server_pubkey)

        salt = sha256(client_random + server_random).digest()
        derived_key = HKDF(
            algorithm=SHA256(), length=32, salt=salt, info=b"tmuxdeck-e2e-v1"
        ).derive(shared_secret)

        client_aes = AESGCM(derived_key)
        nonce = tampered[:12]
        ct = tampered[12:]

        with pytest.raises(Exception):
            client_aes.decrypt(nonce, ct, None)

    def test_cipher_negotiation_selects_aes256(self):
        """Server should select AES-256-GCM when client supports both."""
        client_private = generate_private_key(SECP256R1())
        client_pubkey_raw = client_private.public_key().public_bytes(
            Encoding.X962, PublicFormat.UncompressedPoint
        )
        client_hello = _build_client_hello(client_pubkey_raw, os.urandom(32))
        server_hello_bytes, _ = handle_client_hello(client_hello)
        selected, _, _ = _parse_server_hello(server_hello_bytes)
        assert selected == CIPHER_AES_256_GCM
