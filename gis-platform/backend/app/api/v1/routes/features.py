from __future__ import annotations

import uuid

from fastapi import APIRouter, Query

from app.db.session import SessionDep
from app.schemas.attribute import AttributePage, FieldList
from app.schemas.feature import BBox, FeatureCollection
from app.schemas.system import RasterStatistics
from app.services import attribute_service, feature_service, raster_tile_service

router = APIRouter(prefix="/layers/{layer_id}", tags=["features"])


@router.get("/features", response_model=FeatureCollection)
async def read_features(
    layer_id: uuid.UUID,
    session: SessionDep,
    bbox: str = Query(..., description="minx,miny,maxx,maxy in EPSG:4326"),
    limit: int | None = Query(default=None, ge=1),
) -> FeatureCollection:
    return await feature_service.get_features(session, layer_id, BBox.parse(bbox), limit)


@router.get("/fields", response_model=FieldList)
async def read_fields(layer_id: uuid.UUID, session: SessionDep) -> FieldList:
    return await attribute_service.get_fields(session, layer_id)


@router.get("/attributes", response_model=AttributePage)
async def read_attributes(
    layer_id: uuid.UUID,
    session: SessionDep,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, alias="pageSize", ge=1),
    sort_by: str | None = Query(default=None, alias="sortBy"),
    sort_order: str = Query(default="asc", alias="sortOrder"),
    filters: str | None = Query(default=None, description="JSON array of {field, op, value}"),
) -> AttributePage:
    return await attribute_service.get_page(
        session, layer_id, page, page_size, sort_by, sort_order, filters
    )


@router.get("/statistics", response_model=RasterStatistics)
async def read_statistics(layer_id: uuid.UUID, session: SessionDep) -> RasterStatistics:
    return await raster_tile_service.band_statistics(session, layer_id)
