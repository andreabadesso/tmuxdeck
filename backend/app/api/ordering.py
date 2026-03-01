from __future__ import annotations

from fastapi import APIRouter

from .. import store
from ..schemas import ContainerOrderRequest, OrderResponse, SessionOrderRequest

router = APIRouter(prefix="/api/v1/ordering", tags=["ordering"])


@router.get("/containers", response_model=OrderResponse)
async def get_container_order():
    return OrderResponse(order=store.get_container_order())


@router.put("/containers", response_model=OrderResponse)
async def save_container_order(req: ContainerOrderRequest):
    store.save_container_order(req.order)
    return OrderResponse(order=req.order)


@router.get("/containers/{container_id}/sessions", response_model=OrderResponse)
async def get_session_order(container_id: str):
    return OrderResponse(order=store.get_session_order(container_id))


@router.put("/containers/{container_id}/sessions", response_model=OrderResponse)
async def save_session_order(container_id: str, req: SessionOrderRequest):
    store.save_session_order(container_id, req.order)
    return OrderResponse(order=req.order)
