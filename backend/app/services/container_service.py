"""Shared container enumeration logic.

Extracted from api/containers.py so it can be reused by the snapshot service.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from .. import store
from ..config import config
from ..schemas import ContainerListResponse, ContainerResponse, TmuxSessionResponse
from .bridge_manager import BRIDGE_PREFIX, BridgeManager
from .docker_manager import DockerManager
from .tmux_manager import HOST_CONTAINER_ID, LOCAL_CONTAINER_ID, TmuxManager

logger = logging.getLogger(__name__)


async def _build_local_container(tm: TmuxManager) -> ContainerResponse:
    sessions: list[dict] = []
    try:
        sessions = await tm.list_sessions(LOCAL_CONTAINER_ID)
    except Exception:
        logger.debug("Failed to list local tmux sessions")

    return ContainerResponse(
        id=LOCAL_CONTAINER_ID,
        name="local",
        display_name="Local",
        status="running",
        image="local",
        container_type="local",
        sessions=[TmuxSessionResponse(**s) for s in sessions],
        created_at=datetime.now(UTC).isoformat(),
    )


async def _build_host_container(tm: TmuxManager) -> ContainerResponse:
    sessions: list[dict] = []
    try:
        sessions = await tm.list_sessions(HOST_CONTAINER_ID)
    except Exception:
        logger.debug("Failed to list host tmux sessions")

    return ContainerResponse(
        id=HOST_CONTAINER_ID,
        name="localhost",
        display_name="Host",
        status="running",
        image="host",
        container_type="host",
        sessions=[TmuxSessionResponse(**s) for s in sessions],
        created_at=datetime.now(UTC).isoformat(),
    )


def _build_container_response(
    docker_info: dict, meta: dict | None, sessions: list[dict] | None = None
) -> ContainerResponse:
    display_name = docker_info["name"]
    template_id = None
    if meta:
        display_name = meta.get("displayName", docker_info["name"])
        template_id = meta.get("templateId")

    return ContainerResponse(
        id=docker_info["id"],
        name=docker_info["name"],
        display_name=display_name,
        status=docker_info["status"],
        image=docker_info["image"],
        container_type="docker",
        template_id=template_id,
        sessions=[TmuxSessionResponse(**s) for s in (sessions or [])],
        created_at=docker_info["created_at"],
    )


async def enumerate_containers() -> ContainerListResponse:
    """Enumerate all containers (local, host, bridge, docker) with their sessions.

    Also computes missing_snapshot_sessions by comparing live sessions against the snapshot.
    """
    tm = TmuxManager.get()

    local = await _build_local_container(tm)
    results: list[ContainerResponse] = [local]

    if config.host_tmux_socket:
        host = await _build_host_container(tm)
        results.append(host)

    # Bridge containers
    bm = BridgeManager.get()
    for conn in bm.list_bridges():
        by_source: dict[str, list[dict]] = {}
        for src in conn.sources:
            by_source.setdefault(src, [])
        for s in conn.sessions:
            src = s.get("source", "local")
            by_source.setdefault(src, []).append(s)
        if not by_source:
            by_source["local"] = []

        for source, source_sessions in by_source.items():
            container_id = f"{BRIDGE_PREFIX}{conn.bridge_id}:{source}"
            if source == "local":
                display = f"{conn.name} (Local)"
            elif source == "host":
                display = f"{conn.name} (Host)"
            elif source.startswith("docker:"):
                docker_id = source.split(":", 1)[1]
                display = f"{conn.name} ({docker_id})"
            else:
                display = conn.name

            results.append(ContainerResponse(
                id=container_id,
                name=conn.name,
                display_name=display,
                status="running",
                image="bridge",
                container_type="bridge",
                sessions=[TmuxSessionResponse(**s) for s in source_sessions],
                created_at=datetime.now(UTC).isoformat(),
            ))

    # Docker containers
    docker_error: str | None = None
    try:
        dm = DockerManager.get()
        docker_containers = await dm.list_containers()
    except Exception as exc:
        logger.warning("Docker unavailable, skipping Docker containers", exc_info=True)
        missing, drifted = _count_snapshot_issues(results)
        return ContainerListResponse(
            containers=results,
            docker_error=str(exc),
            missing_snapshot_sessions=missing,
            drifted_snapshot_sessions=drifted,
        )

    metas = store.list_container_metas()
    meta_map = {m["dockerContainerId"]: m for m in metas}
    for dc in docker_containers:
        meta = meta_map.get(dc["full_id"]) or meta_map.get(dc["id"])

        sessions: list[dict] = []
        if dc["status"] == "running":
            try:
                sessions = await tm.list_sessions(dc["id"])
            except Exception:
                logger.debug("Failed to list sessions for %s", dc["id"])

        results.append(_build_container_response(dc, meta, sessions))

    missing, drifted = _count_snapshot_issues(results)
    return ContainerListResponse(
        containers=results,
        docker_error=docker_error,
        missing_snapshot_sessions=missing,
        drifted_snapshot_sessions=drifted,
    )


def _count_snapshot_issues(
    live_containers: list[ContainerResponse],
) -> tuple[int, int]:
    """Count missing and drifted sessions comparing snapshot to live state.

    Returns (missing, drifted) counts.
    Missing = session name gone from live.
    Drifted = session exists but has fewer windows / missing paths vs snapshot.
    """
    snap = store.get_snapshot()
    if not snap:
        return 0, 0

    # Build live session data: container_id -> session_name -> set of paths
    live_sessions: dict[str, dict[str, set[str]]] = {}
    live_status: dict[str, str] = {}
    for c in live_containers:
        session_map: dict[str, set[str]] = {}
        for s in c.sessions:
            session_map[s.name] = {w.path for w in s.windows if w.path}
        live_sessions[c.id] = session_map
        live_status[c.id] = c.status

    missing = 0
    drifted = 0
    for sc in snap.get("containers", []):
        cid = sc.get("id", "")
        # Skip containers not in live list (stopped docker, disconnected bridge)
        if cid not in live_sessions:
            continue
        # Skip stopped containers
        if live_status.get(cid) != "running":
            continue
        container_live = live_sessions[cid]
        for session in sc.get("sessions", []):
            sname = session.get("name", "")
            if sname not in container_live:
                missing += 1
            else:
                snap_paths = {w.get("path", "") for w in session.get("windows", [])}
                snap_paths.discard("")
                live_paths = container_live[sname]
                if snap_paths and (snap_paths - live_paths):
                    drifted += 1

    return missing, drifted
