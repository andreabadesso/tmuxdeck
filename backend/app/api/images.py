from __future__ import annotations

import base64
import logging
import os
import time

from fastapi import APIRouter, HTTPException, UploadFile

from ..services.bridge_manager import BridgeManager, bridge_source_from_container, is_bridge
from ..services.docker_manager import DockerManager
from ..services.tmux_manager import _is_host, _is_local

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1", tags=["images"])

ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}
MAX_SIZE = 20 * 1024 * 1024  # 20 MB
DEST_DIR = "/tmp/claude-images"


def _unique_filename(ext: str) -> str:
    ts = int(time.time() * 1000)
    rand = os.urandom(2).hex()
    return f"paste-{ts}-{rand}{ext}"


@router.post("/containers/{container_id}/upload-image")
async def upload_image(container_id: str, file: UploadFile):
    # Validate extension
    original = file.filename or "paste.png"
    ext = os.path.splitext(original)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported image type: {ext}")

    content = await file.read()
    if len(content) > MAX_SIZE:
        raise HTTPException(413, "File exceeds 20 MB limit")

    filename = _unique_filename(ext)
    dest_path = f"{DEST_DIR}/{filename}"

    if _is_local(container_id) or _is_host(container_id):
        os.makedirs(DEST_DIR, exist_ok=True)
        with open(dest_path, "wb") as f:
            f.write(content)
    elif is_bridge(container_id):
        bm = BridgeManager.get()
        conn = bm.get_bridge_for_container(container_id)
        if not conn:
            raise HTTPException(502, "Bridge not connected")
        source = bridge_source_from_container(container_id)
        encoded = base64.b64encode(content).decode("ascii")
        result = await conn.request({
            "type": "file_write",
            "path": dest_path,
            "data": encoded,
            "source": source,
        }, timeout=30)
        if "error" in result:
            raise HTTPException(500, result["error"])
    else:
        dm = DockerManager.get()
        await dm.put_file(container_id, DEST_DIR, filename, content)

    return {"path": dest_path}
