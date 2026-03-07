"""Relay client - connects TmuxDeck backend to the cloud relay for remote access."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import struct
from typing import Any

import aiohttp
import websockets

from .e2e_crypto import E2ESession, handle_client_hello, is_handshake_message

logger = logging.getLogger(__name__)

# Frame types (must match cloud-relay/lib/relay/tunnels/protocol.ex)
HTTP_REQUEST = 0x01
HTTP_RESPONSE = 0x02
WS_OPEN = 0x03
WS_DATA = 0x04
WS_CLOSE = 0x05
STREAM_RESET = 0x06
PING = 0x07
PONG = 0x08


class RelayClient:
    """Connects to the cloud relay and proxies incoming requests to the local TmuxDeck backend."""

    def __init__(self, relay_url: str, token: str, backend_url: str = "http://localhost:8000"):
        self.relay_url = relay_url
        self.token = token
        self.backend_url = backend_url.rstrip("/")
        self._ws: websockets.ClientConnection | None = None
        self._ws_streams: dict[int, asyncio.Task] = {}
        self._ws_local_conns: dict[int, websockets.ClientConnection] = {}
        self._e2e_sessions: dict[int, E2ESession] = {}
        self._running = False
        self.is_connected: bool = False

    async def connect_with_retry(self, max_retries: int = 0) -> None:
        """Connect to the relay with exponential backoff. max_retries=0 means infinite."""
        attempt = 0
        while True:
            try:
                await self.connect()
            except Exception as e:
                attempt += 1
                if max_retries and attempt >= max_retries:
                    logger.error("Relay connection failed after %d attempts: %s", attempt, e)
                    return
                delay = min(2**attempt, 60)
                logger.warning("Relay connection lost (%s), reconnecting in %ds...", e, delay)
                await asyncio.sleep(delay)

    async def connect(self) -> None:
        """Establish connection to the relay and handle tunnel traffic."""
        logger.info("Connecting to relay at %s", self.relay_url)

        async with websockets.connect(
            self.relay_url,
            max_size=None,
            ping_interval=30,
            ping_timeout=10,
        ) as ws:
            self._ws = ws
            self._running = True

            # Authenticate with token
            await ws.send(json.dumps({"event": "auth", "token": self.token}))
            reply = json.loads(await ws.recv())

            if reply.get("event") == "authenticated":
                self.is_connected = True
                logger.info(
                    "Relay connected! Instance: %s, URL: %s",
                    reply.get("instance_id"),
                    reply.get("url"),
                )
            elif reply.get("event") == "error":
                raise ConnectionError(f"Relay auth failed: {reply.get('reason')}")
            else:
                raise ConnectionError(f"Unexpected relay response: {reply}")

            # Handle tunnel traffic
            try:
                await self._handle_tunnel(ws)
            finally:
                self._running = False
                self.is_connected = False
                # Clean up any active WS streams
                for task in self._ws_streams.values():
                    task.cancel()
                self._ws_streams.clear()
                self._ws_local_conns.clear()

    async def _handle_tunnel(self, ws: websockets.ClientConnection) -> None:
        """Main loop: receive frames from relay and dispatch them."""
        async for message in ws:
            if isinstance(message, str):
                # JSON control messages
                data = json.loads(message)
                if data.get("event") == "ping":
                    await ws.send(json.dumps({"event": "pong"}))
                continue

            if not isinstance(message, bytes) or len(message) < 5:
                continue

            stream_id, frame_type, payload = self._parse_frame(message)

            if frame_type == HTTP_REQUEST:
                asyncio.create_task(self._proxy_http(ws, stream_id, payload))
            elif frame_type == WS_OPEN:
                asyncio.create_task(self._proxy_ws_open(ws, stream_id, payload))
            elif frame_type == WS_DATA:
                self._relay_ws_data(stream_id, payload)
            elif frame_type == WS_CLOSE:
                self._close_ws_stream(stream_id)

    def _parse_frame(self, data: bytes) -> tuple[int, int, bytes]:
        stream_id = struct.unpack(">I", data[:4])[0]
        frame_type = data[4]
        payload = data[5:]
        return stream_id, frame_type, payload

    def _encode_frame(self, stream_id: int, frame_type: int, payload: bytes | str) -> bytes:
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        return struct.pack(">IB", stream_id, frame_type) + payload

    async def _proxy_http(
        self, ws: websockets.ClientConnection, stream_id: int, payload: bytes
    ) -> None:
        """Forward an HTTP request to the local backend and send the response back."""
        try:
            request = json.loads(payload)
            method = request["method"]
            path = request["path"]
            headers = request.get("headers", {})
            body = None
            if "body" in request and request["body"]:
                body = base64.b64decode(request["body"])

            # Remove headers that would conflict with aiohttp's own handling
            for h in ["host", "Host", "content-length", "Content-Length",
                      "transfer-encoding", "Transfer-Encoding"]:
                headers.pop(h, None)

            # Use a long read timeout but no total timeout for streaming responses
            timeout = aiohttp.ClientTimeout(total=None, connect=10, sock_read=300)
            async with aiohttp.ClientSession() as session:
                async with session.request(
                    method=method,
                    url=f"{self.backend_url}{path}",
                    headers=headers,
                    data=body,
                    timeout=timeout,
                    allow_redirects=False,
                ) as resp:
                    content_type = resp.headers.get("content-type", "")
                    is_streaming = "text/event-stream" in content_type

                    if is_streaming:
                        # SSE/streaming responses never end — the relay protocol only
                        # supports one HTTP_RESPONSE per stream, so we can't proxy them.
                        # Return an empty 200 so the client fails gracefully without hanging.
                        logger.debug("Skipping SSE stream for %s %s", method, path)
                        resp_body = b""
                    else:
                        resp_body = await resp.read()

                    response = json.dumps(
                        {
                            "status": resp.status,
                            "headers": dict(resp.headers),
                            "body": base64.b64encode(resp_body).decode("ascii"),
                        }
                    )
                    frame = self._encode_frame(stream_id, HTTP_RESPONSE, response)
                    await ws.send(frame)

        except Exception as e:
            logger.error("Proxy HTTP error for stream %d: %s", stream_id, e, exc_info=True)
            error_response = json.dumps(
                {
                    "status": 502,
                    "headers": {"content-type": "text/plain"},
                    "body": "UmVsYXkgcHJveHkgZXJyb3I=",  # "Relay proxy error"
                }
            )
            frame = self._encode_frame(stream_id, HTTP_RESPONSE, error_response)
            try:
                await ws.send(frame)
            except Exception:
                pass

    async def _proxy_ws_open(
        self, ws: websockets.ClientConnection, stream_id: int, payload: bytes
    ) -> None:
        """Open a local WebSocket connection and relay data bidirectionally."""
        try:
            request = json.loads(payload)
            path = request["path"]
            headers = request.get("headers", {})
            local_url = self.backend_url.replace("http://", "ws://").replace(
                "https://", "wss://"
            )
            local_url = f"{local_url}{path}"

            # Forward auth headers (cookie) so backend accepts the WS connection
            ws_headers = {}
            for key in ("cookie", "Cookie", "authorization", "Authorization"):
                if key in headers:
                    ws_headers[key] = headers[key]

            local_ws = await websockets.connect(local_url, max_size=None, additional_headers=ws_headers)

            # Store local_ws so _relay_ws_data can forward keystrokes to it
            self._ws_local_conns[stream_id] = local_ws

            # Store a task that reads from local WS and forwards to relay
            task = asyncio.create_task(
                self._ws_relay_loop(ws, stream_id, local_ws)
            )
            self._ws_streams[stream_id] = task

        except Exception as e:
            logger.error("WS proxy open error for stream %d: %s", stream_id, e)
            frame = self._encode_frame(stream_id, WS_CLOSE, b"")
            try:
                await ws.send(frame)
            except Exception:
                pass

    async def _ws_relay_loop(
        self,
        relay_ws: websockets.ClientConnection,
        stream_id: int,
        local_ws: websockets.ClientConnection,
    ) -> None:
        """Read from local WS and forward to relay tunnel (encrypting if E2E is active)."""
        try:
            async for message in local_ws:
                if isinstance(message, str):
                    data = message.encode("utf-8")
                else:
                    data = message

                session = self._e2e_sessions.get(stream_id)
                if session:
                    data = session.encrypt(data)

                frame = self._encode_frame(stream_id, WS_DATA, data)
                await relay_ws.send(frame)
        except Exception as e:
            logger.debug("WS relay loop ended for stream %d: %s", stream_id, e)
        finally:
            self._ws_streams.pop(stream_id, None)
            self._ws_local_conns.pop(stream_id, None)
            self._e2e_sessions.pop(stream_id, None)
            try:
                await local_ws.close()
            except Exception:
                pass

    def _relay_ws_data(self, stream_id: int, payload: bytes) -> None:
        """Forward WebSocket data from relay to the local WS connection."""
        # E2E handshake: client sends CLIENT_HELLO before any terminal data
        if is_handshake_message(payload):
            asyncio.create_task(self._handle_e2e_handshake(stream_id, payload))
            return

        # If this stream has an E2E session, decrypt before forwarding
        session = self._e2e_sessions.get(stream_id)
        if session:
            asyncio.create_task(self._decrypt_and_forward(session, stream_id, payload))
            return

        local_ws = self._ws_local_conns.get(stream_id)
        if local_ws:
            try:
                asyncio.create_task(local_ws.send(payload.decode("utf-8")))
            except UnicodeDecodeError:
                asyncio.create_task(local_ws.send(payload))

    async def _handle_e2e_handshake(self, stream_id: int, data: bytes) -> None:
        """Process E2E CLIENT_HELLO and respond with SERVER_HELLO."""
        try:
            server_hello, session = handle_client_hello(data)
            self._e2e_sessions[stream_id] = session
            # Send SERVER_HELLO back through the relay tunnel
            if self._ws:
                frame = self._encode_frame(stream_id, WS_DATA, server_hello)
                await self._ws.send(frame)
            logger.info("E2E encryption established for stream %d", stream_id)
        except Exception as e:
            logger.error("E2E handshake failed for stream %d: %s", stream_id, e)

    async def _decrypt_and_forward(
        self, session: E2ESession, stream_id: int, payload: bytes
    ) -> None:
        """Decrypt an E2E message and forward plaintext to the local WS."""
        local_ws = self._ws_local_conns.get(stream_id)
        if not local_ws:
            return
        try:
            plaintext = session.decrypt(payload)
            try:
                await local_ws.send(plaintext.decode("utf-8"))
            except UnicodeDecodeError:
                await local_ws.send(plaintext)
        except Exception as e:
            logger.error("E2E decrypt failed for stream %d: %s", stream_id, e)

    def _close_ws_stream(self, stream_id: int) -> None:
        """Close a proxied WebSocket stream."""
        task = self._ws_streams.pop(stream_id, None)
        if task:
            task.cancel()
        self._ws_local_conns.pop(stream_id, None)
        self._e2e_sessions.pop(stream_id, None)
