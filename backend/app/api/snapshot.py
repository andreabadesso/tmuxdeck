from __future__ import annotations

from fastapi import APIRouter

from .. import store
from ..schemas import CamelModel
from ..services.snapshot_service import SnapshotService

router = APIRouter(prefix="/api/v1/snapshot", tags=["snapshot"])


class RestoreRequest(CamelModel):
    container_id: str | None = None
    session_name: str | None = None
    dry_run: bool = False


class RestoreResult(CamelModel):
    restored: list[str]
    skipped: list[str]
    errors: list[str]


@router.get("")
async def get_snapshot():
    snap = store.get_snapshot()
    if snap:
        return snap
    return {"timestamp": None, "containers": []}


@router.post("/restore", response_model=RestoreResult)
async def restore_snapshot(req: RestoreRequest | None = None):
    svc = SnapshotService.get()
    result = await svc.restore(
        container_id=req.container_id if req else None,
        session_name=req.session_name if req else None,
        dry_run=req.dry_run if req else False,
    )
    return RestoreResult(**result)


@router.delete("/container/{container_id}/session/{session_name}", status_code=204)
async def dismiss_snapshot_session(container_id: str, session_name: str):
    store.remove_session_from_snapshot(container_id, session_name)
