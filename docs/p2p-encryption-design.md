# P2P Encryption for TmuxDeck Relay

## Problem

The TmuxDeck cloud relay currently acts as a transparent proxy between the browser client and the TmuxDeck backend. While all connections use TLS at the transport layer (WSS/HTTPS), the relay server itself can observe all data in plaintext within the tunnel:

- Terminal input/output (keystrokes, command output)
- HTTP request/response bodies (API calls, configuration data)
- WebSocket messages (real-time terminal streams)
- HTTP headers (cookies, authorization tokens)

```
Browser ---(TLS)---> Cloud Relay ---(TLS)---> TmuxDeck Backend
                     ^ plaintext access to all tunnel frame payloads
```

The goal is end-to-end encryption so the relay becomes a dumb pipe that routes opaque blobs.

```
Browser ---(TLS + E2E)---> Cloud Relay ---(TLS + E2E)---> TmuxDeck Backend
                           ^ sees only encrypted payloads
```

## Current Tunnel Protocol

The relay multiplexes streams over a single WebSocket using a binary frame format:

```
[stream_id: 4 bytes] [frame_type: 1 byte] [payload: variable]
```

Frame types: HTTP_REQUEST (0x01), HTTP_RESPONSE (0x02), WS_OPEN (0x03), WS_DATA (0x04), WS_CLOSE (0x05), STREAM_RESET (0x06), PING (0x07), PONG (0x08).

HTTP payloads are JSON with Base64-encoded bodies. WebSocket payloads are raw binary or UTF-8 text.

## What to Encrypt

| Data | Encrypt? | Rationale |
|------|----------|-----------|
| WS_DATA payloads (terminal I/O) | Yes | Most sensitive - keystrokes, command output |
| HTTP request/response bodies | Yes | Contains API data, session info |
| HTTP headers | Partial | Auth headers yes; routing headers (Host, path) must stay visible |
| Stream IDs, frame types | No | Required by relay for routing |
| Paths/URLs | No | Required by relay for HTTP/WS routing |
| PING/PONG frames | No | Keepalive, no sensitive data |

---

## Option A: ECDH Key Exchange + AES-GCM (Recommended)

### Overview

The browser and TmuxDeck backend perform an Elliptic Curve Diffie-Hellman (ECDH) key exchange through the relay tunnel. The derived shared secret is used for AES-256-GCM authenticated encryption of all data payloads. The relay cannot decrypt the data because it never sees the private keys.

### Key Exchange Flow

```
Browser                     Cloud Relay              TmuxDeck Backend
   |                            |                          |
   |--- connect via subdomain ->|                          |
   |                            |--- WS_OPEN frame ------->|
   |                            |                          |
   |  E2E_KEY_EXCHANGE (0x09)   |                          |
   |--- browser_pubkey -------->|--- forward blob -------->|
   |                            |                          |
   |                            |<-- backend_pubkey -------|
   |<-- forward blob -----------|  E2E_KEY_EXCHANGE (0x09) |
   |                            |                          |
   | [ECDH derive shared key]   |  [cannot derive key]     | [ECDH derive shared key]
   |                            |                          |
   |=== encrypted WS_DATA ====>|=== opaque blob =========>|
   |<=== encrypted WS_DATA ====|<=== opaque blob =========|
```

### Crypto Primitives

| Primitive | Algorithm | Available In |
|-----------|-----------|-------------|
| Key Agreement | ECDH with P-256 (secp256r1) | Python `cryptography`, Web Crypto API |
| Key Derivation | HKDF-SHA256 | Python `cryptography`, Web Crypto API |
| Encryption | AES-256-GCM | Python `cryptography`, Web Crypto API |
| Nonce | 96-bit, counter-based per direction | Standard |

### Encrypted Frame Format

For encrypted payloads, the tunnel frame payload becomes:

```
[nonce: 12 bytes] [ciphertext + GCM tag: variable]
```

The outer tunnel frame stays the same — stream_id and frame_type remain plaintext for routing.

### Implementation Details

**New frame type:**
- `E2E_KEY_EXCHANGE = 0x09` — carries ECDH public keys during handshake

**Backend (Python):**
- Uses `cryptography` library (already a common dependency)
- Generates ephemeral P-256 key pair per tunnel session
- Derives AES-256 key via HKDF-SHA256 from ECDH shared secret
- Encrypts/decrypts WS_DATA and HTTP body payloads

**Frontend (Browser):**
- Uses Web Crypto API (built-in, no dependencies)
- `crypto.subtle.generateKey("ECDH", ...)` for key generation
- `crypto.subtle.deriveKey(...)` for HKDF
- `crypto.subtle.encrypt("AES-GCM", ...)` for encryption
- Ephemeral key pair per WebSocket session

**Cloud Relay (Elixir):**
- Minimal changes: forward `E2E_KEY_EXCHANGE` frames like any other frame
- No crypto code needed on the relay

### Properties

- **Forward secrecy**: New ephemeral keys per session; compromising one session doesn't affect others
- **No pre-shared secrets**: Key exchange happens automatically
- **Relay-agnostic**: Relay only forwards opaque blobs
- **Standard crypto**: Well-audited primitives available on all platforms
- **Low overhead**: AES-GCM is hardware-accelerated on modern CPUs; ~negligible latency for terminal data

### Limitations

- No mutual authentication out of the box — the browser doesn't verify the backend's identity beyond what TLS provides. See "Trust & Verification" section below.
- Request paths and routing metadata remain visible to the relay.

---

## Option B: Pre-Shared Key (PSK)

### Overview

The user manually configures a shared secret on both the TmuxDeck backend and in the browser. All payloads are encrypted with AES-256-GCM using a key derived from this secret.

### Flow

```
1. User generates a secret (e.g., 256-bit random, displayed as base64)
2. User pastes the secret into TmuxDeck backend config
3. User enters the secret in the browser when connecting via relay
4. Both sides derive AES-256-GCM key via HKDF(secret, salt)
5. All payloads encrypted/decrypted with this key
```

### Implementation

**Key derivation:**
```
key = HKDF-SHA256(ikm=psk, salt=session_salt, info="tmuxdeck-e2e", length=32)
```

A random salt is exchanged in the clear at session start to ensure unique keys per session.

### Properties

- **Simple**: No key exchange protocol needed
- **No extra frame types**: Just encrypt payloads with the known key
- **Fewer moving parts**: Less code, fewer failure modes

### Limitations

- **No forward secrecy**: If the PSK is compromised, all past and future sessions are compromised
- **Manual key distribution**: User must securely transfer the secret to any device they use
- **Key rotation is manual**: Changing the key requires updating both sides
- **UX friction**: User must enter a secret in the browser for each new device

---

## Option C: Noise Protocol Framework

### Overview

Use the [Noise Protocol Framework](https://noiseprotocol.org/) (specifically the `Noise_XX` pattern) for mutual authentication and key exchange. This is the same framework used by WireGuard, Signal, and Lightning Network.

### Flow (Noise_XX pattern)

```
Browser                     Cloud Relay              TmuxDeck Backend
   |                            |                          |
   |--- e (ephemeral pub) ----->|--- forward ------------->|
   |                            |                          |
   |                            |<-- e, ee, s, es ---------|
   |<-- forward ----------------|                          |
   |                            |                          |
   |--- s, se ----------------->|--- forward ------------->|
   |                            |                          |
   | [handshake complete]       | [opaque blobs]           | [handshake complete]
   | [transport encryption]     |                          | [transport encryption]
```

### Properties

- **Mutual authentication**: Both sides verify each other's static keys
- **Forward secrecy**: Ephemeral keys per session
- **Identity hiding**: Static keys encrypted after first message
- **Battle-tested**: Used in production by WireGuard, Signal
- **Formal verification**: Noise patterns have been formally verified

### Limitations

- **Complexity**: Noise is a framework, not a single algorithm — more code to implement and audit
- **Library support**: Python has `noiseprotocol` (unmaintained) or `dissononce`; browser has no mature Noise library — would need a custom implementation or WASM build
- **Static key management**: Both sides need persistent key pairs, adding UX complexity for key backup/recovery
- **Overkill?**: The relay already authenticates both sides (instance token + account session); full mutual authentication may be unnecessary

---

## Comparison

| Criteria | Option A: ECDH+AES-GCM | Option B: PSK | Option C: Noise |
|----------|------------------------|---------------|-----------------|
| Forward secrecy | Yes | No | Yes |
| Key distribution | Automatic | Manual | Automatic (static keys need persistence) |
| Mutual auth | No (relies on relay auth) | No | Yes |
| Implementation effort | Medium | Low | High |
| Browser dependencies | None (Web Crypto) | None (Web Crypto) | Custom lib or WASM |
| Relay changes | Minimal (forward new frame) | None | Minimal (forward new frames) |
| UX friction | None | Must enter PSK per device | Must manage static keys |
| Crypto maturity | Standard primitives | Standard primitives | Formally verified framework |

---

## Trust & Verification

Regardless of which option is chosen, there's a question of how the browser knows it's talking to the real backend (and not a MITM at the relay).

### Fingerprint Verification (Optional Enhancement)

After key exchange (Option A or C), both sides can compute a fingerprint of the shared session:

```
fingerprint = SHA-256(sorted(browser_pubkey, backend_pubkey))
display as: "A3F2 9B1C 44E7 ..." (first 32 hex chars)
```

The browser displays this fingerprint. The user can verify it matches what the backend shows (e.g., in the TmuxDeck UI or terminal). This is similar to Signal's safety number verification.

This is optional — it adds security against an actively malicious relay but requires user action.

---

## Recommendation

**Option A (ECDH + AES-GCM)** is the best balance of security, simplicity, and UX:

1. Zero configuration — key exchange is automatic
2. Forward secrecy — each session has unique keys
3. Standard primitives — available natively in Python and browsers
4. Minimal relay changes — just forward a new frame type
5. No additional dependencies in the browser

Option B (PSK) could be offered as a simpler alternative for users who want to manage their own keys, but shouldn't be the primary mechanism.

Option C (Noise) provides the strongest security model but the implementation cost and browser library situation make it impractical for now.

### Suggested Implementation Order

1. Add `E2E_KEY_EXCHANGE` frame type to the protocol
2. Implement ECDH + AES-GCM in the Python backend relay client
3. Implement ECDH + AES-GCM in the frontend WebSocket connection code
4. Add optional fingerprint display for verification
5. Consider PSK as an alternative mode for advanced users
