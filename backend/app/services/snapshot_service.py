"""Periodic snapshot of the tmux tree with merge-based persistence and restore."""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime

from .. import store
from .container_service import enumerate_containers
from .tmux_manager import TmuxManager

logger = logging.getLogger(__name__)

SNAPSHOT_INTERVAL = 30  # seconds


class SnapshotService:
    """Singleton service for periodic snapshot auto-save and manual restore."""

    _instance: SnapshotService | None = None

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    @classmethod
    def get(cls) -> SnapshotService:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop(), name="snapshot-service")
            logger.info("Snapshot service started")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
            logger.info("Snapshot service stopped")

    def _is_enabled(self) -> bool:
        settings = store.get_settings()
        return settings.get("snapshotEnabled", True)

    async def _loop(self) -> None:
        """Capture immediately, then every SNAPSHOT_INTERVAL seconds."""
        try:
            if self._is_enabled():
                await self._capture()
        except Exception:
            logger.exception("Snapshot capture failed (initial)")
        while True:
            await asyncio.sleep(SNAPSHOT_INTERVAL)
            try:
                if self._is_enabled():
                    await self._capture()
            except Exception:
                logger.exception("Snapshot capture failed")

    async def _capture(self) -> None:
        """Capture the current tmux tree and merge with existing snapshot."""
        resp = await enumerate_containers()
        now = datetime.now(UTC).isoformat()

        # Build live snapshot data
        live_containers: dict[str, dict] = {}
        for c in resp.containers:
            live_containers[c.id] = {
                "id": c.id,
                "display_name": c.display_name,
                "container_type": c.container_type or "",
                "status": c.status,
                "sessions": [
                    {
                        "name": s.name,
                        "windows": [
                            {"index": w.index, "name": w.name, "path": w.path}
                            for w in s.windows
                        ],
                    }
                    for s in c.sessions
                ],
            }

        async with self._lock:
            old_snap = store.get_snapshot()
            merged = self._merge(old_snap, live_containers, now)
            store.save_snapshot(merged)

    @staticmethod
    def _merge(
        old_snap: dict | None,
        live_containers: dict[str, dict],
        timestamp: str,
    ) -> dict:
        """Merge live data into existing snapshot.

        Rules:
        1. Sessions in both live and old -> update with fresh data
        2. Sessions only in live -> add (new session)
        3. Sessions only in old -> keep (disappeared, may need restoring)
        4. Containers not in live scan -> keep old snapshot data
        """
        old_by_id: dict[str, dict] = {}
        if old_snap:
            for c in old_snap.get("containers", []):
                old_by_id[c["id"]] = c

        merged_containers: list[dict] = []

        # Process all containers that appear in either live or old
        all_ids = set(live_containers.keys()) | set(old_by_id.keys())
        for cid in all_ids:
            live_c = live_containers.get(cid)
            old_c = old_by_id.get(cid)

            if live_c and not old_c:
                # New container, just add
                merged_containers.append(live_c)
            elif not live_c and old_c:
                # Container not in live scan — keep old data (rule 4)
                merged_containers.append(old_c)
            else:
                # Both exist — merge sessions
                assert live_c is not None and old_c is not None
                live_session_names = {s["name"] for s in live_c["sessions"]}
                old_sessions_by_name = {s["name"]: s for s in old_c.get("sessions", [])}

                merged_sessions = list(live_c["sessions"])  # All live sessions (fresh data)
                # Add disappeared sessions from old snapshot (rule 3)
                for sname, old_s in old_sessions_by_name.items():
                    if sname not in live_session_names:
                        merged_sessions.append(old_s)

                merged_c = dict(live_c)
                merged_c["sessions"] = merged_sessions
                merged_containers.append(merged_c)

        return {"timestamp": timestamp, "containers": merged_containers}

    async def restore(
        self,
        container_id: str | None = None,
        session_name: str | None = None,
        dry_run: bool = False,
    ) -> dict:
        """Restore missing sessions from snapshot.

        Returns: {"restored": [...], "skipped": [...], "errors": [...]}
        """
        async with self._lock:
            snap = store.get_snapshot()

        if not snap:
            return {"restored": [], "skipped": [], "errors": []}

        # Get current live state
        resp = await enumerate_containers()
        live_sessions: dict[str, set[str]] = {}
        live_status: dict[str, str] = {}
        live_types: dict[str, str | None] = {}
        for c in resp.containers:
            live_sessions[c.id] = {s.name for s in c.sessions}
            live_status[c.id] = c.status
            live_types[c.id] = c.container_type

        restored: list[str] = []
        skipped: list[str] = []
        errors: list[str] = []
        tm = TmuxManager.get()

        for sc in snap.get("containers", []):
            cid = sc.get("id", "")
            ctype = sc.get("container_type", "")

            # Filter by container_id if specified
            if container_id and cid != container_id:
                continue

            # Skip bridge containers
            if ctype == "bridge":
                for s in sc.get("sessions", []):
                    skipped.append(f"{cid}/{s['name']} (bridge container)")
                continue

            # Skip containers not in live list
            if cid not in live_sessions:
                for s in sc.get("sessions", []):
                    skipped.append(f"{cid}/{s['name']} (container not running)")
                continue

            # Skip stopped containers
            if live_status.get(cid) != "running":
                for s in sc.get("sessions", []):
                    skipped.append(f"{cid}/{s['name']} (container stopped)")
                continue

            live_names = live_sessions[cid]

            for session in sc.get("sessions", []):
                sname = session.get("name", "")
                if not sname:
                    continue

                # Filter by session_name if specified
                if session_name and sname != session_name:
                    continue

                # Only restore fully missing sessions
                if sname in live_names:
                    continue

                label = f"{cid}/{sname}"

                if dry_run:
                    restored.append(label)
                    continue

                try:
                    windows = session.get("windows", [])
                    first_path = windows[0]["path"] if windows else None

                    await tm.create_session(cid, sname, start_dir=first_path or None)

                    # Create additional windows
                    for win in windows[1:]:
                        await tm.create_window(
                            cid, sname,
                            window_name=win.get("name"),
                            start_dir=win.get("path") or None,
                        )

                    restored.append(label)
                except Exception as exc:
                    errors.append(f"{label}: {exc}")

        return {"restored": restored, "skipped": skipped, "errors": errors}
