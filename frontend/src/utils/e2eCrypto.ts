/**
 * End-to-end encryption for relay WebSocket connections.
 *
 * Uses ECDH P-256 for key exchange and AES-GCM for authenticated encryption.
 * All operations use the Web Crypto API (hardware-accelerated on Apple devices).
 *
 * Protocol:
 *   1. Client sends CLIENT_HELLO (ECDH pubkey + supported ciphers)
 *   2. Server responds with SERVER_HELLO (ECDH pubkey + selected cipher)
 *   3. Both derive shared AES key via HKDF-SHA256
 *   4. All subsequent messages are AES-GCM encrypted
 *
 * Handshake message format (binary):
 *   [0x00 0xE2 0xEE 0x00] [version: 1] [type: 1] [payload...]
 *
 * Encrypted message format (binary, after handshake):
 *   [nonce: 12 bytes] [ciphertext + GCM tag: variable]
 */

// --- Constants ---

const E2E_MAGIC = new Uint8Array([0x00, 0xe2, 0xee, 0x00]);
const PROTOCOL_VERSION = 1;

const MSG_CLIENT_HELLO = 0x01;
// SERVER_HELLO type = 0x02 (checked via byte value in completeHandshake)

const CIPHER_AES_256_GCM = 0x01;
const CIPHER_AES_128_GCM = 0x02;

const SUPPORTED_CIPHERS = [CIPHER_AES_256_GCM, CIPHER_AES_128_GCM];

function cipherKeyBits(cipherId: number): number {
  return cipherId === CIPHER_AES_128_GCM ? 128 : 256;
}

// --- Binary helpers ---

function isHandshakeMessage(data: ArrayBuffer): boolean {
  if (data.byteLength < 6) return false;
  const v = new Uint8Array(data, 0, 4);
  return v[0] === 0x00 && v[1] === 0xe2 && v[2] === 0xee && v[3] === 0x00;
}

function buildHandshake(type: number, payload: Uint8Array): ArrayBuffer {
  const msg = new Uint8Array(6 + payload.length);
  msg.set(E2E_MAGIC, 0);
  msg[4] = PROTOCOL_VERSION;
  msg[5] = type;
  msg.set(payload, 6);
  return msg.buffer;
}

function encodeClientHello(pubKey: Uint8Array, clientRandom: Uint8Array): Uint8Array {
  const buf = new Uint8Array(1 + SUPPORTED_CIPHERS.length + 2 + pubKey.length + 32);
  let off = 0;
  buf[off++] = SUPPORTED_CIPHERS.length;
  for (const c of SUPPORTED_CIPHERS) buf[off++] = c;
  buf[off++] = (pubKey.length >> 8) & 0xff;
  buf[off++] = pubKey.length & 0xff;
  buf.set(pubKey, off);
  off += pubKey.length;
  buf.set(clientRandom, off);
  return buf;
}

function parseServerHello(payload: Uint8Array) {
  let off = 0;
  const selectedCipher = payload[off++];
  const pkLen = (payload[off] << 8) | payload[off + 1];
  off += 2;
  const serverPubKey = payload.slice(off, off + pkLen);
  off += pkLen;
  const serverRandom = payload.slice(off, off + 32);
  return { selectedCipher, serverPubKey, serverRandom };
}

// --- Nonce ---

function makeNonce(direction: number, counter: number): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce[0] = direction;
  // 7-byte big-endian counter in bytes 1-7; bytes 8-11 stay zero
  for (let i = 6; i >= 0; i--) {
    nonce[7 - i] = (counter >> (i * 8)) & 0xff;
  }
  return nonce;
}

// --- E2EWebSocket wrapper ---

/**
 * Drop-in wrapper around a raw WebSocket that adds E2E encryption.
 *
 * After wrapping, all `send()` calls are encrypted and all incoming messages
 * are decrypted before being delivered to `onmessage`. During the handshake
 * phase, outgoing messages are buffered.
 *
 * Usage:
 *   const raw = new WebSocket(url);
 *   const ws = new E2EWebSocket(raw);
 *   // use ws.send(), ws.onmessage, ws.onopen, ws.onclose, ws.close() as normal
 */
export class E2EWebSocket {
  private ws: WebSocket;
  private aesKey: CryptoKey | null = null;
  private sendCounter = 0;
  private handshakeDone = false;
  private pendingSends: (string | ArrayBuffer | Uint8Array)[] = [];
  private clientKeyPair!: CryptoKeyPair;
  private clientRandom!: Uint8Array;

  // Public API matching WebSocket interface
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: Event | CloseEvent) => void) | null = null;
  binaryType: BinaryType;

  get readyState(): number {
    return this.ws.readyState;
  }

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.binaryType = ws.binaryType;

    ws.onopen = (ev) => {
      this.startHandshake();
      // Notify caller that WS is open (they can start sending — messages will be buffered)
      this.onopen?.(ev);
    };

    ws.onmessage = (ev) => {
      this.handleIncoming(ev);
    };

    ws.onerror = (ev) => {
      this.onerror?.(ev);
    };

    ws.onclose = (ev) => {
      this.onclose?.(ev);
    };
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (!this.handshakeDone) {
      // Buffer until handshake completes
      if (data instanceof ArrayBuffer) {
        this.pendingSends.push(data);
      } else if (ArrayBuffer.isView(data)) {
        this.pendingSends.push(
          (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength),
        );
      } else {
        this.pendingSends.push(data);
      }
      return;
    }
    this.encryptAndSend(data);
  }

  close(code?: number, reason?: string): void {
    this.ws.onclose = null;
    this.ws.close(code, reason);
  }

  // --- Internal ---

  private async startHandshake(): Promise<void> {
    try {
      this.clientKeyPair = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveKey', 'deriveBits'],
      );
      const pubRaw = await crypto.subtle.exportKey('raw', this.clientKeyPair.publicKey);
      this.clientRandom = crypto.getRandomValues(new Uint8Array(32));
      const hello = encodeClientHello(new Uint8Array(pubRaw), this.clientRandom);
      this.ws.send(buildHandshake(MSG_CLIENT_HELLO, hello));
    } catch (err) {
      console.error('[E2E] Handshake start failed:', err);
    }
  }

  private handleIncoming(ev: MessageEvent): void {
    const { data } = ev;

    // During handshake: intercept SERVER_HELLO
    if (!this.handshakeDone && data instanceof ArrayBuffer && isHandshakeMessage(data)) {
      this.completeHandshake(data);
      return;
    }

    // After handshake: all incoming data is encrypted binary
    if (this.handshakeDone && data instanceof ArrayBuffer) {
      this.decryptAndDeliver(data);
      return;
    }

    // Shouldn't happen after handshake, but pass through just in case
    this.onmessage?.(ev);
  }

  private async completeHandshake(data: ArrayBuffer): Promise<void> {
    try {
      const view = new Uint8Array(data);
      const payload = view.slice(6);
      const { selectedCipher, serverPubKey, serverRandom } = parseServerHello(payload);
      const keyBits = cipherKeyBits(selectedCipher);

      const serverKey = await crypto.subtle.importKey(
        'raw',
        (serverPubKey as Uint8Array<ArrayBuffer>).buffer,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        [],
      );

      const sharedBits = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: serverKey },
        this.clientKeyPair.privateKey,
        256,
      );

      const ikm = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);

      const transcript = new Uint8Array(64);
      transcript.set(this.clientRandom, 0);
      transcript.set(serverRandom, 32);
      const salt = new Uint8Array(await crypto.subtle.digest('SHA-256', transcript));

      this.aesKey = await crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: new TextEncoder().encode('tmuxdeck-e2e-v1').buffer as ArrayBuffer },
        ikm,
        { name: 'AES-GCM', length: keyBits },
        false,
        ['encrypt', 'decrypt'],
      );

      this.handshakeDone = true;

      // Flush buffered sends
      for (const msg of this.pendingSends) {
        this.encryptAndSend(msg);
      }
      this.pendingSends = [];
    } catch (err) {
      console.error('[E2E] Handshake completion failed:', err);
    }
  }

  private async encryptAndSend(data: string | ArrayBuffer | ArrayBufferView | Uint8Array): Promise<void> {
    if (!this.aesKey) return;
    try {
      let plainBuf: ArrayBuffer;
      if (typeof data === 'string') {
        plainBuf = new TextEncoder().encode(data).buffer as ArrayBuffer;
      } else if (data instanceof ArrayBuffer) {
        plainBuf = data;
      } else if (ArrayBuffer.isView(data)) {
        plainBuf = (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength);
      } else {
        plainBuf = data as ArrayBuffer;
      }

      const nonce = makeNonce(0x01, this.sendCounter++); // client direction
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce as BufferSource },
        this.aesKey,
        plainBuf,
      );

      const frame = new Uint8Array(12 + ct.byteLength);
      frame.set(nonce, 0);
      frame.set(new Uint8Array(ct), 12);
      this.ws.send(frame.buffer as ArrayBuffer);
    } catch (err) {
      console.error('[E2E] Encrypt failed:', err);
    }
  }

  private async decryptAndDeliver(data: ArrayBuffer): Promise<void> {
    if (!this.aesKey) return;
    try {
      const view = new Uint8Array(data);
      const nonce = new Uint8Array(view.buffer, view.byteOffset, 12);
      const ct = new Uint8Array(view.buffer, view.byteOffset + 12);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce as BufferSource },
        this.aesKey,
        ct as BufferSource,
      );

      // Try decoding as text, fall back to binary
      let decoded: string | ArrayBuffer;
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(plain);
      } catch {
        decoded = plain;
      }

      // Dispatch as a synthetic MessageEvent
      this.onmessage?.(new MessageEvent('message', { data: decoded }));
    } catch (err) {
      console.error('[E2E] Decrypt failed:', err);
    }
  }
}

/**
 * Detect if the current page is accessed through the relay (subdomain).
 * When accessed via relay, the hostname has the instance_id prefix, e.g.
 * "abc1234.relay.tmuxdeck.io" vs direct access at "localhost:3000".
 */
export function isRelayConnection(): boolean {
  const host = window.location.hostname;
  // Relay connections have at least 3 parts: instance_id.relay.domain.tld
  const parts = host.split('.');
  return parts.length >= 3 && !host.startsWith('www.');
}
