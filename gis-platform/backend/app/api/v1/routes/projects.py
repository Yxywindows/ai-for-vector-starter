from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
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


@router.post("", response_model=ProjectRead, status_code=status.HTTP_201_CREATED)
async def create_project(
    payload: ProjectCreate, session: AsyncSession = Depends(get_session)
) -> ProjectRead:
    project = await project_service.create_project(session, payload)
    return ProjectRead.model_validate(project)


@router.get("", response_model=list[ProjectSummary])
async def list_projects(session: AsyncSession = Depends(get_session)) -> list[ProjectSummary]:
    return await project_service.list_projects(session)


@router.get("/{project_id}", response_model=ProjectRead)
async def get_project(
    project_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> ProjectRead:
    project = await project_service.get_or_404(session, project_id)
    return ProjectRead.model_validate(project)


@router.patch("/{project_id}", response_model=ProjectRead)
async def update_project(
    project_id: uuid.UUID,
    payload: ProjectUpdate,
    session: AsyncSession = Depends(get_session),
) -> ProjectRead:
    project = await project_service.update_project(session, project_id, payload)
    return ProjectRead.model_validate(project)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> None:
    await project_service.delete_project(session, project_id)


@router.get("/{project_id}/layers", response_model=list[LayerRead])
async def list_layers(
    project_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> list[LayerRead]:
    project = await project_service.get_or_404(session, project_id)
    return [LayerRead.model_validate(layer) for layer in project.layers]


@router.post("/{project_id}/layers", response_model=LayerRead, status_code=status.HTTP_201_CREATED)
async def create_layer(
    project_id: uuid.UUID,
    payload: LayerCreate,
    session: AsyncSession = Depends(get_session),
) -> LayerRead:
    layer = await layer_service.create_layer(session, project_id, payload)
    return LayerRead.model_validate(layer)


@router.post("/{project_id}/layers/reorder", response_model=list[LayerRead])
async def reorder_layers(
    project_id: uuid.UUID,
    payload: LayerReorder,
    session: AsyncSession = Depends(get_session),
) -> list[LayerRead]:
    layers = await layer_service.reorder(session, project_id, payload.layer_ids)
    return [LayerRead.model_validate(layer) for layer in layers]
