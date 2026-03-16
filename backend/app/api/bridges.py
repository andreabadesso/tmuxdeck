"""REST API for managing bridge configurations."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import store
from ..schemas import BridgeConfigResponse, CreateBridgeRequest, UpdateBridgeRequest
from ..services.bridge_manager import BridgeManager

router = APIRouter(prefix="/api/v1/bridges", tags=["bridges"])


def _build_response(cfg: dict, bm: BridgeManager, *, include_token: bool = False) -> BridgeConfigResponse:
    conn = bm.get_bridge(cfg["id"])
    resp = BridgeConfigResponse(
        id=cfg["id"],
        name=cfg["name"],
        token=cfg.get("token") if include_token else None,
        connected=bm.is_connected(cfg["id"]),
        enabled=cfg.get("enabled", True),
        auto_tune=cfg.get("autoTune", False),
        created_at=cfg["createdAt"],
        settings=cfg.get("settings"),
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
        resp.ws_rx_bin_frames = conn.ws_rx_bin_frames
        resp.ws_rx_bin_bytes = conn.ws_rx_bin_bytes
        resp.ws_rx_text_frames = conn.ws_rx_text_frames
        resp.ws_fwd_tasks = conn.ws_fwd_tasks
        resp.capabilities = conn.capabilities
        resp.negotiated_settings = conn.negotiated_settings
    return resp


@router.get("", response_model=list[BridgeConfigResponse])
async def list_bridges():
    configs = store.list_bridge_configs()
    bm = BridgeManager.get()
    return [_build_response(cfg, bm) for cfg in configs]


@router.post("", response_model=BridgeConfigResponse, status_code=201)
async def create_bridge(req: CreateBridgeRequest):
    cfg = store.create_bridge_config(req.name)
    bm = BridgeManager.get()
    return _build_response(cfg, bm, include_token=True)


@router.patch("/{bridge_id}", response_model=BridgeConfigResponse)
async def update_bridge(bridge_id: str, req: UpdateBridgeRequest):
    updates = req.model_dump(exclude_none=True)
    # Serialize settings sub-model to dict
    if req.settings is not None:
        updates["settings"] = req.settings.model_dump(exclude_none=True)
    # Map auto_tune → autoTune for store
    if "auto_tune" in updates:
        updates["autoTune"] = updates.pop("auto_tune")
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

    # If settings were updated, push to connected bridge
    if req.settings is not None:
        conn = bm.get_bridge(bridge_id)
        if conn and conn.connected:
            await conn.push_settings(cfg.get("settings", {}))

    return _build_response(cfg, bm)


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
