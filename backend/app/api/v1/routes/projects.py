from __future__ import annotations

import uuid
from pathlib import Path

import anyio
from fastapi import APIRouter, Request, Response, status

from app.core.config import get_settings
from app.core.errors import InvalidRequestError, NotFoundError
from app.db.session import SessionDep
from app.schemas.layer import LayerCreate, LayerRead
from app.schemas.project import (
    LayerReorder,
    ProjectCreate,
    ProjectRead,
    ProjectSummary,
    ProjectUpdate,
)
from app.services import layer_service, project_service

router = APIRouter(prefix="/projects", tags=["projects"])

MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024


def _thumbnail_path(project_id: uuid.UUID) -> Path:
    return get_settings().data_dir / "thumbnails" / f"{project_id}.png"


@router.post("", response_model=ProjectRead, status_code=status.HTTP_201_CREATED)
async def create_project(payload: ProjectCreate, session: SessionDep) -> ProjectRead:
    project = await project_service.create_project(session, payload)
    return ProjectRead.model_validate(project)


@router.get("", response_model=list[ProjectSummary])
async def list_projects(session: SessionDep) -> list[ProjectSummary]:
    return await project_service.list_projects(session)


@router.get("/{project_id}", response_model=ProjectRead)
async def get_project(project_id: uuid.UUID, session: SessionDep) -> ProjectRead:
    project = await project_service.get_or_404(session, project_id)
    return ProjectRead.model_validate(project)


@router.patch("/{project_id}", response_model=ProjectRead)
async def update_project(
    project_id: uuid.UUID,
    payload: ProjectUpdate,
    session: SessionDep,
) -> ProjectRead:
    project = await project_service.update_project(session, project_id, payload)
    return ProjectRead.model_validate(project)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(project_id: uuid.UUID, session: SessionDep) -> None:
    await project_service.delete_project(session, project_id)


@router.put("/{project_id}/thumbnail", status_code=status.HTTP_204_NO_CONTENT)
async def put_thumbnail(project_id: uuid.UUID, request: Request, session: SessionDep) -> None:
    """Store the workspace's captured PNG snapshot for dashboard cards.

    Raw image bytes as the body — no multipart ceremony for a fire-and-
    forget capture the workspace sends on a debounce.
    """
    await project_service.get_or_404(session, project_id)
    data = await request.body()
    if not data or len(data) > MAX_THUMBNAIL_BYTES:
        raise InvalidRequestError(
            "Thumbnail must be a non-empty PNG under the size cap",
            details={"maxBytes": MAX_THUMBNAIL_BYTES, "received": len(data)},
        )

    path = _thumbnail_path(project_id)

    def _write() -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    await anyio.to_thread.run_sync(_write)


@router.get("/{project_id}/thumbnail")
async def get_thumbnail(project_id: uuid.UUID, session: SessionDep) -> Response:
    await project_service.get_or_404(session, project_id)
    path = _thumbnail_path(project_id)
    data = await anyio.to_thread.run_sync(lambda: path.read_bytes() if path.exists() else None)
    if data is None:
        raise NotFoundError("No thumbnail captured yet", details={"projectId": str(project_id)})
    return Response(
        content=data, media_type="image/png", headers={"Cache-Control": "public, max-age=300"}
    )


@router.get("/{project_id}/layers", response_model=list[LayerRead])
async def list_layers(project_id: uuid.UUID, session: SessionDep) -> list[LayerRead]:
    project = await project_service.get_or_404(session, project_id)
    return [LayerRead.model_validate(layer) for layer in project.layers]


@router.post("/{project_id}/layers", response_model=LayerRead, status_code=status.HTTP_201_CREATED)
async def create_layer(
    project_id: uuid.UUID,
    payload: LayerCreate,
    session: SessionDep,
) -> LayerRead:
    layer = await layer_service.create_layer(session, project_id, payload)
    return LayerRead.model_validate(layer)


@router.post("/{project_id}/layers/reorder", response_model=list[LayerRead])
async def reorder_layers(
    project_id: uuid.UUID,
    payload: LayerReorder,
    session: SessionDep,
) -> list[LayerRead]:
    layers = await layer_service.reorder(session, project_id, payload.layer_ids)
    return [LayerRead.model_validate(layer) for layer in layers]
