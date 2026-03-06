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

## Option D: TLS-in-WebSocket

### Overview

Run a full TLS session inside the WebSocket tunnel. The outer WSS provides transport encryption to the relay; the inner TLS provides true E2E encryption. The relay only sees opaque TLS records it cannot decrypt.

```
App Data -> [Inner TLS encrypt] -> TLS records -> [WebSocket frame] -> [WSS encrypt] -> Network
                                                    ^ relay sees this: opaque TLS records
```

### Implementation

**Backend (Python) — `ssl.MemoryBIO`:**

Python's `ssl` module supports memory-based BIOs natively (since 3.5), allowing TLS over any transport:

```python
import ssl

incoming_bio = ssl.MemoryBIO()
outgoing_bio = ssl.MemoryBIO()

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain("server.pem", "server-key.pem")

ssl_obj = ctx.wrap_bio(incoming_bio, outgoing_bio, server_side=True)

# Sending: write plaintext -> read encrypted from outgoing_bio -> send over WS
ssl_obj.write(plaintext)
encrypted = outgoing_bio.read()
websocket.send(encrypted)

# Receiving: write WS data to incoming_bio -> read plaintext
incoming_bio.write(ws_data)
plaintext = ssl_obj.read()
```

This uses OpenSSL under the hood — full TLS 1.3 support including KeyUpdate for rekeying.

**Browser (JavaScript) — `node-forge`:**

Browsers have no raw TLS API. The `node-forge` library provides a pure-JS TLS implementation:

```javascript
const tls = forge.tls.createConnection({
  server: false,
  tlsDataReady: (conn) => {
    // encrypted TLS records ready -> send over WebSocket
    websocket.send(conn.tlsData.getBytes());
  },
  dataReady: (conn) => {
    // decrypted plaintext received
    handlePlaintext(conn.data.getBytes());
  }
});

// Feed incoming WS data into the TLS connection
websocket.onmessage = (e) => tls.process(e.data);
```

### Properties

- **Full TLS semantics**: Certificate-based auth, session resumption, built-in rekeying (KeyUpdate)
- **Battle-tested protocol**: TLS is the most scrutinized security protocol in existence
- **Backend is easy**: Python's `ssl.MemoryBIO` is production-ready, uses OpenSSL
- **Built-in key rotation**: TLS 1.3 KeyUpdate provides automatic rekeying (see Key Rotation section)

### Limitations

- **Browser side limited to TLS 1.2**: `node-forge` does not support TLS 1.3
- **Pure-JS crypto is slow**: node-forge runs crypto in JavaScript, not using hardware acceleration
- **Side-channel risk**: Pure-JS implementations are vulnerable to timing attacks
- **Certificate management**: Need a self-signed CA or PSK-based TLS, adding complexity
- **Large dependency**: node-forge is ~250KB minified
- **Unmaintained concerns**: node-forge TLS 1.3 support is unlikely to arrive

### Verdict

TLS-in-WebSocket is elegant on the server side but impractical on the browser side due to the node-forge TLS 1.2 limitation and performance concerns. If a future browser API exposes raw TLS (unlikely), this would become the best option.

---

## Comparison

| Criteria | Option A: ECDH+AES-GCM | Option B: PSK | Option C: Noise | Option D: TLS-in-WS |
|----------|------------------------|---------------|-----------------|---------------------|
| Forward secrecy | Yes | No | Yes | Yes (TLS 1.3) |
| Key distribution | Automatic | Manual | Automatic (static keys) | Automatic (certs) |
| Mutual auth | No (relies on relay auth) | No | Yes | Yes (mTLS possible) |
| Implementation effort | Medium | Low | High | Medium (Python) / High (Browser) |
| Browser dependencies | None (Web Crypto) | None (Web Crypto) | Custom lib or WASM | node-forge (~250KB) |
| Relay changes | Minimal (forward new frame) | None | Minimal (forward new frames) | None |
| UX friction | None | Must enter PSK per device | Must manage static keys | Cert management |
| Crypto maturity | Standard primitives | Standard primitives | Formally verified | Most scrutinized protocol |
| Built-in rekeying | Manual (see below) | Manual | No | Yes (KeyUpdate) |
| Browser TLS version | N/A | N/A | N/A | TLS 1.2 only (node-forge) |
| Mobile performance | Excellent (HW accel) | Excellent (HW accel) | Good | Poor (pure-JS crypto) |

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

## Cipher Negotiation

Inspired by TLS 1.3's cipher suite negotiation, the E2E handshake should include protocol negotiation. This allows:

- Upgrading crypto algorithms without breaking older clients
- Slower devices (older iPads) to choose lighter ciphers
- Future-proofing for post-quantum algorithms

### Negotiation Protocol

The key exchange message (E2E_KEY_EXCHANGE) includes supported algorithms:

```
1. Browser sends HELLO:
   {
     "protocol_version": 1,
     "supported_ciphers": ["AES-256-GCM", "AES-128-GCM"],
     "supported_kex": ["ECDH-P256"],
     "supported_kdf": ["HKDF-SHA256"],
     "client_public_key": "<base64 ephemeral ECDH P-256 public key>",
     "client_random": "<32 bytes base64>"
   }

2. Backend responds with HELLO_REPLY:
   {
     "protocol_version": 1,
     "selected_cipher": "AES-256-GCM",
     "selected_kex": "ECDH-P256",
     "selected_kdf": "HKDF-SHA256",
     "server_public_key": "<base64 ephemeral ECDH P-256 public key>",
     "server_random": "<32 bytes base64>"
   }

3. Both sides: ECDH shared secret -> HKDF -> symmetric keys
4. All subsequent frames: encrypted with negotiated cipher
```

### Design Principles (from TLS)

- **Client proposes, server selects**: Avoids downgrade race conditions. The backend picks the strongest cipher both sides support.
- **Speculative key share**: The browser includes its ECDH public key in the first message, enabling 1-RTT (single round-trip) setup.
- **Transcript binding**: Hash the full negotiation exchange into the HKDF `info` parameter. This binds the derived keys to the exact negotiation that occurred, preventing an attacker from tampering with algorithm selection.
- **Version field**: The `protocol_version` field allows future protocol revisions without ambiguity.

### Extensibility

Adding a new cipher (e.g., ChaCha20-Poly1305, or a post-quantum KEM) only requires:
1. Adding it to the `supported_ciphers` / `supported_kex` lists
2. Implementing the algorithm on both sides
3. No relay changes — the relay never inspects these fields

---

## Key Rotation Policy

### Why Rotate Keys?

AES-GCM has a critical constraint: **nonce reuse with the same key is catastrophic**. With 96-bit nonces and a counter, the theoretical limit is 2^32 messages per key before collision risk grows (with random nonces). While we use sequential counters (safe up to 2^64), rotating keys periodically provides defense-in-depth.

### How TLS 1.3 Does It

TLS 1.3 provides a `KeyUpdate` mechanism (RFC 8446, Section 4.6.3):

1. Either side sends a `KeyUpdate` message
2. New keys are derived: `secret_N+1 = HKDF-Expand-Label(secret_N, "traffic upd", "", Hash.length)`
3. The derivation is one-way — compromising key N+1 does not reveal key N
4. Rekeying is directional: each side updates its sending keys independently

**TLS implementation defaults:**
- Erlang/OTP: rekeys after ~353 TB of data
- OpenSSL: limits to 32 KeyUpdates per connection
- NIST guidance: rekey before 2^32 invocations with random nonces

### Our Rekeying Strategy

For TmuxDeck relay, terminal data volumes are small (KB/s, not GB/s), so rekeying thresholds are generous:

```
Rekey trigger (whichever comes first):
  - Every 2^24 messages (~16 million) per direction
  - Every 1 hour of session time
  - On explicit request from either side
```

**Rekeying mechanism:**

```
new_secret = HKDF-Expand(
  current_secret,
  info="tmuxdeck-rekey-" + generation_counter,
  length=32
)
new_key, new_iv = HKDF-Expand(new_secret, ...)
```

Both sides track a `generation` counter. When a rekey occurs:
1. Sender increments its generation counter
2. Derives new key from current secret (one-way)
3. Sends a `REKEY` control message (new frame type or special E2E_KEY_EXCHANGE sub-type)
4. Switches to new key for subsequent messages
5. Receiver derives the same new key and switches

This provides **intra-session forward secrecy**: if a key is compromised mid-session, past messages remain protected.

---

## Performance Benchmarks

### AES-GCM on Apple Silicon (iPad/iPhone)

All Apple devices since iPhone 5s (A7, 2013) include ARMv8 Cryptography Extensions with dedicated AES and GHASH (PMULL) hardware instructions.

| Device / Chip | AES-128-GCM | AES-256-GCM | ChaCha20-Poly1305 |
|---------------|-------------|-------------|-------------------|
| A11 (iPhone 8/X) | ~1,242 MB/s | ~1,050 MB/s | ~400 MB/s (software) |
| M3 Pro (MacBook) | ~7.5 GB/s | ~6.4 GB/s | ~4.2 GB/s (software) |
| Without HW accel | ~14 MB/s | ~12 MB/s | ~4.2 GB/s (software) |

Key takeaway: **AES-GCM is 1.5-3x faster than ChaCha20 on Apple Silicon** because AES has hardware acceleration while ChaCha20 does not.

### ECDH P-256 Key Exchange

| Platform | Time |
|----------|------|
| Cortex-M4 @ 168 MHz (constrained IoT) | ~338 ms |
| Apple A-series / M-series | < 1 ms |
| Browser Web Crypto API | < 5 ms |

Key exchange is a one-time cost per session — completely negligible.

### Web Crypto API on Safari/iOS

The Web Crypto API delegates to native crypto libraries (Apple CryptoKit / CommonCrypto), which use hardware acceleration. Performance characteristics:

- **AES-GCM**: Near-native speed via hardware acceleration
- **ECDH P-256**: Supported and fast
- **HKDF-SHA256**: Supported
- **All operations are async** (return Promises), keeping the UI thread responsive
- **ChaCha20-Poly1305**: NOT available in Web Crypto API — rules it out for browser use

### Practical Impact on Terminal Sessions

Terminal data is tiny: a fast typist produces ~10 bytes/s of input; busy command output peaks at ~1 MB/s. Even the slowest scenario (software AES at 12 MB/s) handles this with < 0.1ms latency per frame. **Encryption overhead is completely imperceptible for terminal use on any Apple device.**

### AES-128 vs AES-256

| | AES-128-GCM | AES-256-GCM |
|--|-------------|-------------|
| Key size | 128-bit | 256-bit |
| Rounds | 10 | 14 |
| Speed difference | Baseline | ~10-15% slower |
| Security margin | 128-bit (sufficient for all known attacks) | 256-bit (quantum-resistant margin) |
| Recommendation | Good default for performance-sensitive devices | Good default for maximum security |

Both are available via Web Crypto API and hardware-accelerated. The negotiation protocol lets each client choose.

---

## Recommendation

**Option A (ECDH + AES-GCM) with cipher negotiation** is the best balance of security, simplicity, and UX:

1. Zero configuration — key exchange is automatic
2. Forward secrecy — new ephemeral keys per session, with periodic rekeying
3. Standard primitives — available natively in Python and browsers via Web Crypto API
4. Hardware-accelerated on all Apple devices since 2013 — negligible performance impact
5. Cipher negotiation — allows slower devices to pick AES-128-GCM, future upgrades without breaking changes
6. Minimal relay changes — just forward a new frame type
7. No additional dependencies in the browser

**Why not TLS-in-WebSocket (Option D)?** Despite TLS being an excellent protocol, the browser limitation is the blocker: node-forge only supports TLS 1.2, runs crypto in pure JavaScript (no hardware acceleration), and adds a large dependency. The Python side would be great (`ssl.MemoryBIO` is production-ready), but both sides need to match. Our custom ECDH + AES-GCM protocol effectively implements the core of what TLS does (key exchange, authenticated encryption, rekeying) using the same primitives, but through the Web Crypto API which gets hardware acceleration on mobile.

**Option B (PSK)** could be offered as a fallback for advanced users who want explicit key control.

**Option C (Noise)** provides the strongest security model but the implementation cost and browser library situation make it impractical for now.

### Suggested Implementation Order

1. Add `E2E_KEY_EXCHANGE` frame type to the tunnel protocol
2. Implement cipher negotiation in the handshake (client proposes, server selects)
3. Implement ECDH P-256 + AES-GCM in the Python backend relay client
4. Implement ECDH P-256 + AES-GCM in the frontend WebSocket connection code (Web Crypto API)
5. Implement periodic rekeying (every 2^24 messages or 1 hour)
6. Add optional fingerprint display for verification
7. Consider PSK as an alternative mode for advanced users
