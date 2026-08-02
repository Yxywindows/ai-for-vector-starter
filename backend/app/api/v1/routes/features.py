from __future__ import annotations

import hashlib
import uuid

from fastapi import APIRouter, Query, Request, Response, status

from app.db.session import SessionDep
from app.models.layer import Layer
from app.schemas.attribute import AttributePage, FieldList
from app.schemas.feature import BBox, Feature, FeatureCollection, FeaturePatch, FeatureWrite
from app.schemas.system import RasterStatistics
from app.services import (
    attribute_service,
    edit_service,
    feature_service,
    layer_service,
    raster_tile_service,
)

router = APIRouter(prefix="/layers/{layer_id}", tags=["features"])


def _features_etag(
    layer: Layer, bbox: str, simplify: float | None, precision: int | None, limit: int | None
) -> str:
    """Mirrors tile_service.tile_etag: weak ETag from layer identity, freshness and query."""
    seed = f"{layer.id}:{layer.updated_at.isoformat()}:{bbox}:{simplify}:{precision}:{limit}"
    return f'W/"{hashlib.sha256(seed.encode()).hexdigest()[:32]}"'


@router.get(
    "/features",
    response_model=FeatureCollection,
    responses={304: {"description": "Not modified"}},
)
async def read_features(
    request: Request,
    layer_id: uuid.UUID,
    session: SessionDep,
    bbox: str = Query(..., description="minx,miny,maxx,maxy in EPSG:4326"),
    limit: int | None = Query(default=None, ge=1),
    simplify: float | None = Query(
        default=None, ge=0, description="ST_SimplifyPreserveTopology tolerance in degrees"
    ),
    precision: int | None = Query(
        default=None, ge=0, le=9, description="Max coordinate decimal digits"
    ),
) -> Response:
    layer = await layer_service.get_layer_or_404(session, layer_id)
    etag = _features_etag(layer, bbox, simplify, precision, limit)
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers={"ETag": etag})

    collection = await feature_service.get_features(
        session, layer_id, BBox.parse(bbox), limit, simplify=simplify, precision=precision
    )
    return Response(
        content=collection.model_dump_json(by_alias=True),
        media_type="application/json",
        headers={"ETag": etag, "Cache-Control": "no-cache"},
    )


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


@router.post("/features", response_model=Feature, status_code=status.HTTP_201_CREATED)
async def create_feature(
    layer_id: uuid.UUID, payload: FeatureWrite, session: SessionDep
) -> Feature:
    return await edit_service.create_feature(session, layer_id, payload)


@router.patch("/features/{feature_id}", response_model=Feature)
async def update_feature(
    layer_id: uuid.UUID, feature_id: str, payload: FeaturePatch, session: SessionDep
) -> Feature:
    return await edit_service.update_feature(session, layer_id, feature_id, payload)


@router.delete("/features/{feature_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_feature(layer_id: uuid.UUID, feature_id: str, session: SessionDep) -> None:
    await edit_service.delete_feature(session, layer_id, feature_id)
