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
import time

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


async def _ping_loop(conn: BridgeConnection, interval: float = PING_INTERVAL) -> None:
    """Periodically send ping to bridge agent to measure latency."""
    try:
        while True:
            # Use negotiated interval if available
            actual_interval = interval
            if conn.negotiated_settings:
                actual_interval = conn.negotiated_settings.get("ping_interval_sec", interval)
            await asyncio.sleep(actual_interval)
            if not conn.connected or conn.ws is None:
                break
            conn.mark_ping_sent()
            await conn.send_json({"type": "ping"})
    except asyncio.CancelledError:
        pass


# Per-channel forwarding queues — one consumer task per active channel.
# Replaces per-frame asyncio.create_task() to reduce task-creation overhead
# and guarantee frame ordering within a channel.
_channel_queues: dict[int, asyncio.Queue] = {}
_channel_tasks: dict[int, asyncio.Task] = {}
_CHANNEL_QUEUE_SIZE = 256


async def _channel_consumer(conn: BridgeConnection, channel_id: int, user_ws: WebSocket) -> None:
    """Drain the per-channel queue and forward frames to the user WebSocket."""
    queue = _channel_queues.get(channel_id)
    if queue is None:
        return
    try:
        while True:
            data = await queue.get()
            if data is None:
                break  # Poison pill — channel closed
            try:
                await asyncio.wait_for(user_ws.send_bytes(data), timeout=5.0)
            except asyncio.TimeoutError:
                logger.warning("Forward timeout on ch %d — dropping slow client", channel_id)
                conn.unregister_terminal(channel_id)
                break
            except Exception:
                conn.unregister_terminal(channel_id)
                break
    except asyncio.CancelledError:
        pass
    finally:
        _channel_queues.pop(channel_id, None)
        _channel_tasks.pop(channel_id, None)


def _ensure_channel(conn: BridgeConnection, channel_id: int, user_ws: WebSocket) -> asyncio.Queue:
    """Get or create the forwarding queue and consumer task for a channel."""
    queue = _channel_queues.get(channel_id)
    if queue is None:
        queue = asyncio.Queue(maxsize=_CHANNEL_QUEUE_SIZE)
        _channel_queues[channel_id] = queue
        task = asyncio.create_task(_channel_consumer(conn, channel_id, user_ws))
        _channel_tasks[channel_id] = task
    return queue


def _cleanup_channel(channel_id: int) -> None:
    """Stop forwarding for a channel."""
    queue = _channel_queues.pop(channel_id, None)
    if queue is not None:
        try:
            queue.put_nowait(None)  # Poison pill
        except asyncio.QueueFull:
            pass
    task = _channel_tasks.pop(channel_id, None)
    if task is not None:
        task.cancel()


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

        # Traffic stats (reset on each pong)
        _rx_bin_frames = 0
        _rx_bin_bytes = 0
        _rx_text_frames = 0
        _fwd_tasks = 0

        def _format_bytes(n: int) -> str:
            if n >= 1_048_576:
                return f"{n / 1_048_576:.1f}MB"
            if n >= 1024:
                return f"{n / 1024:.1f}KB"
            return f"{n}B"

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
                _rx_bin_frames += 1
                _rx_bin_bytes += len(data) - 2
                channel_id = struct.unpack(">H", data[:2])[0]
                payload = data[2:]
                user_ws = conn.get_terminal_ws(channel_id)
                if user_ws:
                    _fwd_tasks += 1
                    queue = _ensure_channel(conn, channel_id, user_ws)
                    try:
                        queue.put_nowait(bytes(payload))
                    except asyncio.QueueFull:
                        pass  # Backpressure: drop frame rather than blocking

            # Text frame: JSON control message
            elif "text" in message and message["text"]:
                _rx_text_frames += 1
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

                elif msg_type == "capabilities":
                    conn.capabilities = msg
                    # Load stored settings and negotiate
                    bridge_cfg = store.get_bridge_config(bridge_id)
                    stored = bridge_cfg.get("settings", {}) if bridge_cfg else {}
                    negotiated = conn.negotiate_settings(msg, stored)
                    conn.negotiated_settings = negotiated
                    await conn.send_json({"type": "settings", "settings": negotiated})
                    logger.info("Bridge [%s] capabilities received, sent settings: %s", name, negotiated)

                elif msg_type == "settings_ack":
                    applied = msg.get("applied", {})
                    conn.negotiated_settings = applied
                    logger.info("Bridge [%s] settings_ack: %s", name, applied)

                elif msg_type == "pong":
                    conn.record_pong()
                    rtt = conn.latency_last_ms
                    logger.info(
                        "Bridge [%s] latency: %.0fms | rx since last pong: %d bin (%s) %d txt | fwd_tasks: %d",
                        name, rtt or 0,
                        _rx_bin_frames, _format_bytes(_rx_bin_bytes),
                        _rx_text_frames, _fwd_tasks,
                    )
                    # Store for API consumption
                    conn.ws_rx_bin_frames = _rx_bin_frames
                    conn.ws_rx_bin_bytes = _rx_bin_bytes
                    conn.ws_rx_text_frames = _rx_text_frames
                    conn.ws_fwd_tasks = _fwd_tasks
                    _rx_bin_frames = 0
                    _rx_bin_bytes = 0
                    _rx_text_frames = 0
                    _fwd_tasks = 0

                    # Auto-tune check
                    if len(conn._latency_samples) >= 5:
                        await bm.check_auto_tune(bridge_id)

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
        # Clean up per-channel forwarding queues for this bridge
        if conn:
            for ch_id in list(conn._terminal_relays):
                _cleanup_channel(ch_id)
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
