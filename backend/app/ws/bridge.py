"""WebSocket endpoint for bridge agent connections.

One persistent WebSocket per bridge carries:
- JSON text frames for control messages
- Binary frames with 2-byte channel header for multiplexed terminal I/O
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import socket
import struct

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .. import store
from ..services.bridge_manager import BridgeConnection, BridgeManager
from ..services.debug_log import DebugLog

logger = logging.getLogger(__name__)
router = APIRouter()

# How long to wait for bridge to reconnect before cleaning up terminals
BRIDGE_RECONNECT_TIMEOUT = 120  # seconds
PING_INTERVAL = 10.0  # seconds between latency pings


def _set_tcp_nodelay(websocket: WebSocket) -> None:
    """Set TCP_NODELAY on the underlying socket to disable Nagle's algorithm."""
    transport = websocket.scope.get("transport")
    if transport:
        sock = transport.get_extra_info("socket")
        if sock:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)


async def _ping_loop(conn: BridgeConnection) -> None:
    """Periodically send ping to bridge agent to measure latency."""
    try:
        while True:
            await asyncio.sleep(PING_INTERVAL)
            if not conn.connected or conn.ws is None:
                break
            conn.mark_ping_sent()
            await conn.send_json({"type": "ping"})
    except asyncio.CancelledError:
        pass


async def _forward_bytes(conn: BridgeConnection, channel_id: int, user_ws: WebSocket, data: bytes) -> None:
    """Forward binary data to user WebSocket without blocking the bridge receive loop."""
    try:
        await user_ws.send_bytes(data)
    except Exception:
        conn.unregister_terminal(channel_id)


async def _bridge_cleanup_timer(
    bm: BridgeManager,
    bridge_id: str,
    timeout: float = BRIDGE_RECONNECT_TIMEOUT,
) -> None:
    """Wait for bridge to reconnect; if it doesn't, close all terminals."""
    try:
        await asyncio.sleep(timeout)
    except asyncio.CancelledError:
        # Bridge reconnected — timer cancelled
        return
    conn = bm.get_bridge(bridge_id)
    if conn and not conn.connected:
        logger.info("Bridge %s did not reconnect within %ds, cleaning up", bridge_id, timeout)
        await conn.close_all_terminals()
        bm.unregister(bridge_id)


@router.websocket("/ws/bridge")
async def bridge_ws(websocket: WebSocket):
    await websocket.accept()
    _set_tcp_nodelay(websocket)

    bridge_id: str | None = None
    conn: BridgeConnection | None = None
    bm = BridgeManager.get()
    needs_reattach = False
    ping_task: asyncio.Task | None = None

    try:
        # Step 1: Wait for auth message
        raw = await websocket.receive_text()
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            await websocket.send_text(json.dumps({
                "type": "auth_error", "reason": "Invalid JSON",
            }))
            await websocket.close(code=4000)
            return

        if msg.get("type") != "auth":
            await websocket.send_text(json.dumps({
                "type": "auth_error", "reason": "Expected auth message",
            }))
            await websocket.close(code=4000)
            return

        token = msg.get("token", "")
        name = msg.get("name", "unnamed")

        bridge_config = store.get_bridge_by_token(token)
        if not bridge_config:
            DebugLog.get().warn("bridge", f"Auth failed: invalid token from '{name}'")
            await websocket.send_text(json.dumps({
                "type": "auth_error", "reason": "Invalid token",
            }))
            await websocket.close(code=4001)
            return

        if not bridge_config.get("enabled", True):
            DebugLog.get().warn("bridge", f"Auth rejected: bridge '{bridge_config['name']}' is disabled")
            await websocket.send_text(json.dumps({
                "type": "auth_error", "reason": "Bridge is disabled",
            }))
            await websocket.close(code=4001)
            return

        bridge_id = bridge_config["id"]

        # Seamless reconnect: reuse existing connection if it has active terminals
        existing = bm.get_bridge(bridge_id)
        if existing and existing.has_terminals():
            conn = existing
            conn.reconnect(websocket)
            needs_reattach = True
            DebugLog.get().info("bridge", f"Bridge reconnected: {name}", f"id={bridge_id}")
        else:
            if existing:
                await existing.close_all_terminals()
                bm.unregister(bridge_id)
            conn = bm.register(bridge_id, name, websocket)

        await websocket.send_text(json.dumps({
            "type": "auth_ok", "bridge_id": bridge_id,
        }))
        logger.info("Bridge authenticated: %s (%s)%s", bridge_id, name,
                     " (reattaching)" if needs_reattach else "")

        # Reattach terminals from previous connection
        if needs_reattach:
            asyncio.create_task(conn.reattach_all())

        # Start latency ping loop
        ping_task = asyncio.create_task(_ping_loop(conn))

        # Step 2: Main message loop
        while True:
            message = await websocket.receive()

            if message.get("type") == "websocket.disconnect":
                break

            # Binary frame: route to user WebSocket
            if "bytes" in message and message["bytes"]:
                data = message["bytes"]
                if len(data) < 2:
                    continue
                channel_id = struct.unpack(">H", data[:2])[0]
                payload = bytes(data[2:])
                user_ws = conn.get_terminal_ws(channel_id)
                if user_ws:
                    asyncio.create_task(_forward_bytes(conn, channel_id, user_ws, payload))

            # Text frame: JSON control message
            elif "text" in message and message["text"]:
                try:
                    msg = json.loads(message["text"])
                except json.JSONDecodeError:
                    continue

                msg_type = msg.get("type", "")

                if msg_type == "sessions":
                    conn.sessions = msg.get("sessions", [])
                    conn.sources = msg.get("sources", [])

                elif msg_type == "attach_ok":
                    req_id = msg.get("id")
                    if req_id:
                        conn.resolve_pending(req_id, msg)

                elif msg_type == "attach_error":
                    req_id = msg.get("id")
                    if req_id:
                        conn.resolve_pending(req_id, msg)

                elif msg_type == "detached":
                    channel_id = msg.get("channel_id", 0)
                    user_ws = conn.get_terminal_ws(channel_id)
                    if user_ws:
                        try:
                            await user_ws.close(code=1000, reason="Detached")
                        except Exception:
                            pass
                        conn.unregister_terminal(channel_id)

                elif msg_type == "cmd_result":
                    req_id = msg.get("id")
                    if req_id:
                        conn.resolve_pending(req_id, msg)

                elif msg_type == "file_result":
                    req_id = msg.get("id")
                    if req_id:
                        conn.resolve_pending(req_id, msg)

                elif msg_type == "file_write_result":
                    req_id = msg.get("id")
                    if req_id:
                        conn.resolve_pending(req_id, msg)

                elif msg_type == "pong":
                    conn.record_pong()

                else:
                    logger.debug("Unknown bridge message type: %s", msg_type)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error("Bridge WebSocket error: %s", e)
        DebugLog.get().error("bridge", f"WebSocket error: {e}", f"bridge_id={bridge_id}")
    finally:
        # Cancel ping loop
        if ping_task is not None:
            ping_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await ping_task
        if conn and conn.has_terminals():
            # Bridge disconnected but terminals are active — keep conn alive
            conn.set_disconnected()
            # Notify user terminals of temporary disruption
            for info in conn.get_all_terminals():
                with contextlib.suppress(Exception):
                    await info.user_ws.send_text("BRIDGE_RECONNECTING:")
            # Cleanup timer: if bridge doesn't reconnect in time, close everything
            conn._cleanup_task = asyncio.create_task(
                _bridge_cleanup_timer(bm, bridge_id, timeout=BRIDGE_RECONNECT_TIMEOUT)
            )
        else:
            if conn:
                await conn.close_all_terminals()
            if bridge_id:
                bm.unregister(bridge_id)
        try:
            await websocket.close()
        except Exception:
            pass
