"""Manages connected bridge agents and multiplexed terminal I/O."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import struct
import time
import uuid
from collections import deque
from dataclasses import dataclass

from fastapi import WebSocket

from .debug_log import DebugLog

logger = logging.getLogger(__name__)

BRIDGE_PREFIX = "bridge:"


def is_bridge(container_id: str) -> bool:
    return container_id.startswith(BRIDGE_PREFIX)


def bridge_id_from_container(container_id: str) -> str:
    """Extract bridge ID from container_id.

    "bridge:abc123:local" → "abc123"
    "bridge:abc123:host" → "abc123"
    "bridge:abc123:docker:def456" → "abc123"
    "bridge:abc123" → "abc123"  (legacy format)
    """
    parts = container_id.split(":", 2)
    return parts[1] if len(parts) >= 2 else ""


def bridge_source_from_container(container_id: str) -> str:
    """Extract source from container_id.

    "bridge:abc123:local" → "local"
    "bridge:abc123:host" → "host"
    "bridge:abc123:docker:def456" → "docker:def456"
    "bridge:abc123" → "local"  (legacy format, default to local)
    """
    parts = container_id.split(":", 2)
    return parts[2] if len(parts) >= 3 else "local"


@dataclass
class TerminalInfo:
    """Metadata for a terminal relayed through a bridge."""

    channel_id: int
    user_ws: WebSocket
    session_name: str
    window_index: int
    source: str
    cols: int = 80
    rows: int = 24


class BridgeConnection:
    """A single connected bridge agent."""

    def __init__(self, bridge_id: str, name: str, ws: WebSocket) -> None:
        self.bridge_id = bridge_id
        self.name = name
        self.ws: WebSocket | None = ws
        self.connected = True
        self.sessions: list[dict] = []
        self.sources: list[str] = []
        self._pending: dict[str, asyncio.Future] = {}
        self._terminal_relays: dict[int, TerminalInfo] = {}  # channel_id → TerminalInfo
        self._next_channel: int = 1
        self._cleanup_task: asyncio.Task | None = None
        # Latency tracking
        self._latency_samples: deque[float] = deque(maxlen=30)
        self._ping_sent_at: float | None = None
        # Traffic stats (updated on each pong, reset after)
        self.ws_rx_bin_frames: int = 0
        self.ws_rx_bin_bytes: int = 0
        self.ws_rx_text_frames: int = 0
        self.ws_fwd_tasks: int = 0
        # Capability negotiation
        self.capabilities: dict | None = None
        self.negotiated_settings: dict | None = None
        # Auto-tune hysteresis
        self._last_auto_tune_at: float = 0.0
        self._auto_tune_cooldown: float = 60.0  # seconds between setting changes

    def allocate_channel(self) -> int:
        """Allocate the next available channel ID."""
        channel = self._next_channel
        self._next_channel += 1
        if self._next_channel > 65535:
            self._next_channel = 1
        return channel

    def register_terminal(self, channel_id: int, info: TerminalInfo) -> None:
        self._terminal_relays[channel_id] = info

    def unregister_terminal(self, channel_id: int) -> None:
        self._terminal_relays.pop(channel_id, None)

    def get_terminal_ws(self, channel_id: int) -> WebSocket | None:
        info = self._terminal_relays.get(channel_id)
        return info.user_ws if info else None

    def get_terminal_info(self, channel_id: int) -> TerminalInfo | None:
        return self._terminal_relays.get(channel_id)

    def has_terminals(self) -> bool:
        return bool(self._terminal_relays)

    def get_all_terminals(self) -> list[TerminalInfo]:
        return list(self._terminal_relays.values())

    def get_session_source(self, session_name: str) -> str | None:
        """Look up the source tag for a session by name."""
        for s in self.sessions:
            if s.get("name") == session_name:
                return s.get("source")
        return None

    async def send_json(self, msg: dict) -> None:
        """Send JSON to bridge, silently dropping if disconnected."""
        if not self.connected or self.ws is None:
            return
        try:
            await self.ws.send_text(json.dumps(msg))
        except Exception:
            logger.debug("send_json failed (bridge disconnected)")

    async def send_binary(self, channel_id: int, data: bytes) -> None:
        """Send binary to bridge, silently dropping if disconnected."""
        if not self.connected or self.ws is None:
            return
        try:
            header = struct.pack(">H", channel_id)
            await self.ws.send_bytes(header + data)
        except Exception:
            logger.debug("send_binary failed (bridge disconnected)")

    async def request(self, msg: dict, timeout: float = 10.0) -> dict:
        """Send a JSON message and await a correlated response."""
        if not self.connected or self.ws is None:
            raise ConnectionError("Bridge is not connected")
        req_id = str(uuid.uuid4())[:8]
        msg["id"] = req_id
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[req_id] = fut
        try:
            await self.ws.send_text(json.dumps(msg))
            return await asyncio.wait_for(fut, timeout=timeout)
        finally:
            self._pending.pop(req_id, None)

    def resolve_pending(self, req_id: str, result: dict) -> None:
        fut = self._pending.get(req_id)
        if fut and not fut.done():
            fut.set_result(result)

    def mark_ping_sent(self) -> None:
        """Record the time a ping was sent. Skip if a previous ping is still pending."""
        if self._ping_sent_at is None:
            self._ping_sent_at = time.monotonic()

    def record_pong(self) -> None:
        """Compute RTT from the last ping and store the sample."""
        if self._ping_sent_at is not None:
            rtt_ms = (time.monotonic() - self._ping_sent_at) * 1000
            self._latency_samples.append(rtt_ms)
            self._ping_sent_at = None

    def _percentile(self, p: float) -> float | None:
        """Compute the p-th percentile from the rolling sample window."""
        if not self._latency_samples:
            return None
        s = sorted(self._latency_samples)
        k = (len(s) - 1) * (p / 100)
        lo = int(k)
        hi = min(lo + 1, len(s) - 1)
        frac = k - lo
        return s[lo] + (s[hi] - s[lo]) * frac

    @property
    def latency_p90_ms(self) -> float | None:
        return self._percentile(90)

    @property
    def latency_p95_ms(self) -> float | None:
        return self._percentile(95)

    @property
    def latency_p99_ms(self) -> float | None:
        return self._percentile(99)

    @property
    def latency_last_ms(self) -> float | None:
        if not self._latency_samples:
            return None
        return self._latency_samples[-1]

    @property
    def latency_min_ms(self) -> float | None:
        if not self._latency_samples:
            return None
        return min(self._latency_samples)

    @property
    def latency_max_ms(self) -> float | None:
        if not self._latency_samples:
            return None
        return max(self._latency_samples)

    @property
    def latency_jitter_ms(self) -> float | None:
        """Standard deviation of latency samples."""
        if len(self._latency_samples) < 2:
            return None
        avg = sum(self._latency_samples) / len(self._latency_samples)
        variance = sum((s - avg) ** 2 for s in self._latency_samples) / len(self._latency_samples)
        return math.sqrt(variance)

    @property
    def latency_history(self) -> list[float]:
        return list(self._latency_samples)

    @staticmethod
    def negotiate_settings(
        capabilities: dict,
        stored_settings: dict,
    ) -> dict:
        """Clamp stored settings to bridge-advertised capability ranges."""
        supported = capabilities.get("supported", {})
        result: dict = {}

        # Defaults when no stored setting exists
        defaults = {
            "compression": False,
            "report_interval_sec": 5.0,
            "ping_interval_sec": 10.0,
            "coalesce_ms": 0,
        }

        for key, default_val in defaults.items():
            value = stored_settings.get(key, default_val)
            cap = supported.get(key)
            if cap is None:
                # Bridge doesn't advertise this capability — use default
                result[key] = default_val
            elif isinstance(cap, bool):
                # Boolean capability — use stored value
                result[key] = bool(value)
            elif isinstance(cap, dict):
                # Range capability — clamp to min/max
                mn = cap.get("min", value)
                mx = cap.get("max", value)
                if isinstance(value, (int, float)):
                    result[key] = type(default_val)(max(mn, min(mx, value)))
                else:
                    result[key] = cap.get("default", default_val)
            else:
                result[key] = default_val

        return result

    async def push_settings(self, stored_settings: dict) -> None:
        """Re-negotiate against stored capabilities and send settings message."""
        if not self.capabilities:
            return
        negotiated = self.negotiate_settings(self.capabilities, stored_settings)
        self.negotiated_settings = negotiated
        await self.send_json({"type": "settings", "settings": negotiated})

    def set_disconnected(self) -> None:
        """Mark bridge as disconnected but keep terminal registrations alive."""
        self.connected = False
        self.ws = None
        # Cancel all pending request futures
        for req_id, fut in list(self._pending.items()):
            if not fut.done():
                fut.set_exception(ConnectionError("Bridge disconnected"))
        self._pending.clear()

    def reconnect(self, new_ws: WebSocket) -> None:
        """Swap in a new WebSocket after bridge reconnects."""
        # Cancel any pending cleanup timer
        if self._cleanup_task and not self._cleanup_task.done():
            self._cleanup_task.cancel()
            self._cleanup_task = None
        # Cancel all pending request futures from old connection
        for req_id, fut in list(self._pending.items()):
            if not fut.done():
                fut.set_exception(ConnectionError("Bridge reconnected"))
        self._pending.clear()
        self.ws = new_ws
        self.connected = True
        self._latency_samples.clear()
        self._ping_sent_at = None
        logger.info("Bridge reconnected: %s (%s), %d terminals to reattach",
                     self.bridge_id, self.name, len(self._terminal_relays))

    async def reattach_all(self) -> None:
        """Re-attach all active terminals after bridge reconnection."""
        for channel_id, info in list(self._terminal_relays.items()):
            try:
                result = await self.request({
                    "type": "attach",
                    "session_name": info.session_name,
                    "window_index": info.window_index,
                    "channel_id": channel_id,
                    "cols": info.cols,
                    "rows": info.rows,
                    "source": info.source,
                })
                if result.get("type") == "attach_error":
                    logger.warning("Reattach failed for ch %d (%s): %s",
                                   channel_id, info.session_name,
                                   result.get("reason", "unknown"))
                    # Session is gone — close only this user WS
                    with contextlib.suppress(Exception):
                        await info.user_ws.send_text("SESSION_GONE:")
                    with contextlib.suppress(Exception):
                        await info.user_ws.close(code=4404, reason="Session gone")
                    self._terminal_relays.pop(channel_id, None)
                else:
                    logger.info("Reattached ch %d to %s", channel_id, info.session_name)
            except Exception as e:
                logger.warning("Reattach exception for ch %d: %s", channel_id, e)
                # Don't remove terminal — bridge may have reconnected again

    async def close_all_terminals(self) -> None:
        """Close all relayed user WebSockets when bridge disconnects permanently."""
        for channel_id, info in list(self._terminal_relays.items()):
            try:
                await info.user_ws.close(code=1001, reason="Bridge disconnected")
            except Exception:
                pass
        self._terminal_relays.clear()


def compute_auto_settings(p90_ms: float, jitter_ms: float) -> dict:
    """Compute optimal settings based on measured latency and jitter.

    Tuned to keep coalescing at zero for LAN bridges (P90 < 40ms) and
    to avoid enabling compression unless latency is genuinely high.
    """
    # Coalesce — zero for LAN, ramp gently for WAN
    if p90_ms < 40:
        coalesce_ms = 0
    elif p90_ms <= 100:
        coalesce_ms = 2
    elif p90_ms <= 200:
        scale = int((p90_ms - 100) / 100 * 8)
        coalesce_ms = 4 + scale
    else:
        coalesce_ms = min(20, 12 + int((p90_ms - 200) / 100 * 8))
    if jitter_ms > 50:
        coalesce_ms += 3

    # Ping interval
    if jitter_ms > 50:
        ping_interval_sec = 5
    elif jitter_ms > 20:
        ping_interval_sec = 8
    else:
        ping_interval_sec = 15
    if p90_ms > 200:
        ping_interval_sec = min(ping_interval_sec, 10)

    # Compression — only for genuinely slow links, not brief spikes
    compression = p90_ms > 150

    # Report interval
    report_interval_sec = 3 if jitter_ms > 50 else 5

    return {
        "compression": compression,
        "report_interval_sec": float(report_interval_sec),
        "ping_interval_sec": float(ping_interval_sec),
        "coalesce_ms": coalesce_ms,
    }


def _settings_changed(old: dict, new: dict) -> bool:
    """Check if auto-tune settings differ meaningfully from current.

    Uses wide thresholds to prevent oscillation / flapping.
    """
    if old.get("compression") != new.get("compression"):
        return True
    if abs(old.get("coalesce_ms", 0) - new.get("coalesce_ms", 0)) > 5:
        return True
    if abs(old.get("ping_interval_sec", 0) - new.get("ping_interval_sec", 0)) > 3:
        return True
    if abs(old.get("report_interval_sec", 0) - new.get("report_interval_sec", 0)) > 2:
        return True
    return False


class BridgeManager:
    """Singleton tracking all connected bridge agents."""

    _instance: BridgeManager | None = None

    def __init__(self) -> None:
        self.bridges: dict[str, BridgeConnection] = {}  # bridge_id → connection

    @classmethod
    def get(cls) -> BridgeManager:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def register(self, bridge_id: str, name: str, ws: WebSocket) -> BridgeConnection:
        conn = BridgeConnection(bridge_id, name, ws)
        self.bridges[bridge_id] = conn
        logger.info("Bridge registered: %s (%s)", bridge_id, name)
        DebugLog.get().info("bridge", f"Bridge connected: {name}", f"id={bridge_id}")
        return conn

    def unregister(self, bridge_id: str) -> None:
        conn = self.bridges.pop(bridge_id, None)
        if conn:
            logger.info("Bridge unregistered: %s (%s)", bridge_id, conn.name)
            DebugLog.get().info("bridge", f"Bridge disconnected: {conn.name}", f"id={bridge_id}")

    def get_bridge(self, bridge_id: str) -> BridgeConnection | None:
        return self.bridges.get(bridge_id)

    def get_bridge_for_container(self, container_id: str) -> BridgeConnection | None:
        if not is_bridge(container_id):
            return None
        bid = bridge_id_from_container(container_id)
        return self.bridges.get(bid)

    def is_connected(self, bridge_id: str) -> bool:
        return bridge_id in self.bridges

    def list_bridges(self) -> list[BridgeConnection]:
        return list(self.bridges.values())

    async def check_auto_tune(self, bridge_id: str) -> None:
        """If auto-tune is enabled, recompute and push settings if changed.

        Applies a cooldown period between changes to prevent oscillation.
        """
        from .. import store

        bridge_cfg = store.get_bridge_config(bridge_id)
        if not bridge_cfg or not bridge_cfg.get("autoTune") or bridge_cfg.get("lanMode"):
            return

        conn = self.get_bridge(bridge_id)
        if not conn or not conn.connected:
            return
        if len(conn._latency_samples) < 5:
            return

        # Enforce cooldown to prevent oscillation / flapping
        now = time.monotonic()
        if now - conn._last_auto_tune_at < conn._auto_tune_cooldown:
            return

        p90 = conn.latency_p90_ms or 0
        jitter = conn.latency_jitter_ms or 0
        new_settings = compute_auto_settings(p90, jitter)
        current = conn.negotiated_settings or {}

        if _settings_changed(current, new_settings):
            conn._last_auto_tune_at = now
            store.update_bridge_config(bridge_id, {"settings": new_settings})
            await conn.push_settings(new_settings)
            logger.info("Auto-tune [%s]: updated settings %s (p90=%.0fms jitter=%.0fms)",
                        conn.name, new_settings, p90, jitter)
