"""Manages multiple relay client connections, started/stopped dynamically."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .relay_client import RelayClient

logger = logging.getLogger(__name__)


class RelayManager:
    """Singleton that manages a pool of relay connections from stored config."""

    _instance: RelayManager | None = None

    def __init__(self) -> None:
        # relay_id -> (task, client)
        self._connections: dict[str, tuple[asyncio.Task, RelayClient]] = {}

    @classmethod
    def get(cls) -> RelayManager:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def is_connected(self, relay_id: str) -> bool:
        task, client = self._connections.get(relay_id, (None, None))
        return task is not None and not task.done() and client is not None and client.is_connected

    async def start(self, relay_id: str, url: str, token: str, backend_url: str = "http://127.0.0.1:8000", *, e2e: bool = True) -> None:
        await self.stop(relay_id)
        client = RelayClient(url, token, backend_url, e2e=e2e)
        task = asyncio.create_task(client.connect_with_retry(), name=f"relay-{relay_id}")
        self._connections[relay_id] = (task, client)
        logger.info("Relay %s started → %s", relay_id, url)

    async def stop(self, relay_id: str) -> None:
        entry = self._connections.pop(relay_id, None)
        if entry:
            task, client = entry
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
            logger.info("Relay %s stopped", relay_id)

    async def sync(self, relays: list[dict[str, Any]], backend_url: str = "http://127.0.0.1:8000") -> None:
        """Reconcile running connections to match the given relay configs."""
        wanted = {r["id"] for r in relays if r.get("enabled", True)}
        running = set(self._connections.keys())

        for relay_id in running - wanted:
            await self.stop(relay_id)

        for relay in relays:
            if not relay.get("enabled", True):
                continue
            relay_id = relay["id"]
            # (re)start if not running or task died
            task, _ = self._connections.get(relay_id, (None, None))
            if task is None or task.done():
                await self.start(relay_id, relay["url"], relay["token"], backend_url, e2e=relay.get("e2e", True))

    async def stop_all(self) -> None:
        for relay_id in list(self._connections.keys()):
            await self.stop(relay_id)
