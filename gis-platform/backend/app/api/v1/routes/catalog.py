from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
from app.schemas.catalog import GeometryTableInfo, RegisterTableRequest
from app.schemas.layer import LayerRead
from app.services import catalog_service

router = APIRouter(tags=["catalog"])


@router.get("/connections/postgis/tables", response_model=list[GeometryTableInfo])
async def list_postgis_tables(
    session: AsyncSession = Depends(get_session),
) -> list[GeometryTableInfo]:
    return await catalog_service.list_tables(session)


@router.post(
    "/projects/{project_id}/layers/from-postgis",
    response_model=LayerRead,
    status_code=status.HTTP_201_CREATED,
)
async def register_postgis_table(
    project_id: uuid.UUID,
    payload: RegisterTableRequest,
    session: AsyncSession = Depends(get_session),
) -> LayerRead:
    layer = await catalog_service.register_table(session, project_id, payload)
    return LayerRead.model_validate(layer)
