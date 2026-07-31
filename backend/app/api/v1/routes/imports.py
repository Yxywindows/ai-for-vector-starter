from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, File, Form, UploadFile, status

from app.db.session import SessionDep
from app.schemas.import_draft import ImportDraftRequest, ImportResult
from app.schemas.layer import LayerRead
from app.services import draft_import_service, raster_import_service, vector_import_service

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


@router.post("/import-raster", response_model=LayerRead, status_code=status.HTTP_201_CREATED)
async def import_raster(
    project_id: uuid.UUID,
    session: SessionDep,
    file: Annotated[UploadFile, File(description="GeoTIFF / COG")],
    name: Annotated[str | None, Form()] = None,
) -> LayerRead:
    layer = await raster_import_service.import_raster_file(session, project_id, file, name)
    return LayerRead.model_validate(layer)


@router.post("/import-draft", response_model=ImportResult, status_code=status.HTTP_201_CREATED)
async def import_draft(
    project_id: uuid.UUID,
    session: SessionDep,
    request: ImportDraftRequest,
) -> ImportResult:
    """Persist an edited import draft. The client has already previewed it;
    the server validates it again and trusts none of that."""
    return await draft_import_service.import_draft(session, project_id, request)
