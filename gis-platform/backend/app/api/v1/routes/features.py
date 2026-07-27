from __future__ import annotations

import uuid

from fastapi import APIRouter, Query

from app.db.session import SessionDep
from app.schemas.feature import BBox, FeatureCollection
from app.services import feature_service

router = APIRouter(prefix="/layers/{layer_id}", tags=["features"])


@router.get("/features", response_model=FeatureCollection)
async def read_features(
    layer_id: uuid.UUID,
    session: SessionDep,
    bbox: str = Query(..., description="minx,miny,maxx,maxy in EPSG:4326"),
    limit: int | None = Query(default=None, ge=1),
) -> FeatureCollection:
    return await feature_service.get_features(session, layer_id, BBox.parse(bbox), limit)
