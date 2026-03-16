"""REST API for managing bridge configurations."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import store
from ..schemas import BridgeConfigResponse, CreateBridgeRequest, UpdateBridgeRequest
from ..services.bridge_manager import BridgeManager

router = APIRouter(prefix="/api/v1/bridges", tags=["bridges"])


@router.get("", response_model=list[BridgeConfigResponse])
async def list_bridges():
    configs = store.list_bridge_configs()
    bm = BridgeManager.get()
    results = []
    for cfg in configs:
        conn = bm.get_bridge(cfg["id"])
        resp = BridgeConfigResponse(
            id=cfg["id"],
            name=cfg["name"],
            token=None,  # never expose token in list
            connected=bm.is_connected(cfg["id"]),
            enabled=cfg.get("enabled", True),
            created_at=cfg["createdAt"],
        )
        if conn:
            resp.latency_last_ms = conn.latency_last_ms
            resp.latency_min_ms = conn.latency_min_ms
            resp.latency_max_ms = conn.latency_max_ms
            resp.latency_p90_ms = conn.latency_p90_ms
            resp.latency_p95_ms = conn.latency_p95_ms
            resp.latency_p99_ms = conn.latency_p99_ms
            resp.latency_jitter_ms = conn.latency_jitter_ms
            resp.latency_history = conn.latency_history
        results.append(resp)
    return results


@router.post("", response_model=BridgeConfigResponse, status_code=201)
async def create_bridge(req: CreateBridgeRequest):
    cfg = store.create_bridge_config(req.name)
    return BridgeConfigResponse(
        id=cfg["id"],
        name=cfg["name"],
        token=cfg["token"],  # shown once on creation
        connected=False,
        enabled=cfg.get("enabled", True),
        created_at=cfg["createdAt"],
    )


@router.patch("/{bridge_id}", response_model=BridgeConfigResponse)
async def update_bridge(bridge_id: str, req: UpdateBridgeRequest):
    updates = req.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(400, "No fields to update")

    cfg = store.update_bridge_config(bridge_id, updates)
    if not cfg:
        raise HTTPException(404, f"Bridge {bridge_id} not found")

    bm = BridgeManager.get()

    # If disabling, disconnect the bridge
    if req.enabled is False:
        conn = bm.get_bridge(bridge_id)
        if conn:
            await conn.close_all_terminals()
            bm.unregister(bridge_id)
            try:
                if conn.ws:
                    await conn.ws.close(code=1000, reason="Bridge disabled")
            except Exception:
                pass

    return BridgeConfigResponse(
        id=cfg["id"],
        name=cfg["name"],
        token=None,
        connected=bm.is_connected(cfg["id"]),
        enabled=cfg.get("enabled", True),
        created_at=cfg["createdAt"],
    )


@router.delete("/{bridge_id}", status_code=204)
async def delete_bridge(bridge_id: str):
    # Disconnect if active
    bm = BridgeManager.get()
    conn = bm.get_bridge(bridge_id)
    if conn:
        await conn.close_all_terminals()
        bm.unregister(bridge_id)
        try:
            if conn.ws:
                await conn.ws.close(code=1000, reason="Bridge deleted")
        except Exception:
            pass

    if not store.delete_bridge_config(bridge_id):
        raise HTTPException(404, f"Bridge {bridge_id} not found")
