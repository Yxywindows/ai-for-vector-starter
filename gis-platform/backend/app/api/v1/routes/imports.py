from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, File, Form, UploadFile, status

from app.db.session import SessionDep
from app.schemas.layer import LayerRead
from app.services import vector_import_service

router = APIRouter(prefix="/projects/{project_id}/layers", tags=["imports"])


@router.post("/import", response_model=LayerRead, status_code=status.HTTP_201_CREATED)
async def import_vector(
    project_id: uuid.UUID,
    session: SessionDep,
    file: Annotated[UploadFile, File(description="GeoJSON, GeoPackage, or zipped Shapefile")],
    name: Annotated[str | None, Form()] = None,
) -> LayerRead:
    layer = await vector_import_service.import_vector_file(session, project_id, file, name)
    return LayerRead.model_validate(layer)
