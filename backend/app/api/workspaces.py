from fastapi import APIRouter, HTTPException

from .. import store
from ..schemas import (
    CreateWorkspaceRequest,
    UpdateWorkspaceRequest,
    WorkspaceListResponse,
    WorkspaceOrderRequest,
    WorkspaceResponse,
)

router = APIRouter(prefix="/api/v1/workspaces", tags=["workspaces"])


def _to_response(ws: dict) -> WorkspaceResponse:
    return WorkspaceResponse(
        id=ws["id"],
        name=ws["name"],
        members=ws.get("members", []),
        is_default=ws.get("isDefault", False),
    )


@router.get("", response_model=WorkspaceListResponse)
async def list_workspaces():
    data = store.list_workspaces()
    return WorkspaceListResponse(
        workspaces=[_to_response(ws) for ws in data["workspaces"]],
        workspace_order=data["workspaceOrder"],
    )


@router.post("", response_model=WorkspaceResponse, status_code=201)
async def create_workspace(req: CreateWorkspaceRequest):
    ws = store.create_workspace(req.name)
    return _to_response(ws)


# Static route must come before /{workspace_id}
@router.put("/ordering")
async def save_workspace_order(req: WorkspaceOrderRequest):
    store.save_workspace_order(req.order)
    return {"ok": True}


@router.patch("/{workspace_id}", response_model=WorkspaceResponse)
async def update_workspace(workspace_id: str, req: UpdateWorkspaceRequest):
    updates = {}
    if req.name is not None:
        updates["name"] = req.name
    if req.members is not None:
        updates["members"] = [m.model_dump(by_alias=True) for m in req.members]
    ws = store.update_workspace(workspace_id, updates)
    if not ws:
        raise HTTPException(404, f"Workspace {workspace_id} not found")
    return _to_response(ws)


@router.delete("/{workspace_id}", status_code=204)
async def delete_workspace(workspace_id: str):
    if not store.delete_workspace(workspace_id):
        raise HTTPException(404, f"Workspace {workspace_id} not found")
