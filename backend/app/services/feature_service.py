from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import InvalidRequestError
from app.repositories import feature_repository
from app.schemas.feature import BBox, Feature, FeatureCollection
from app.services import layer_service, source_snapshot


def clamp_limit(requested: int | None) -> int:
    """A client may ask for fewer than the cap, never more."""
    cap = get_settings().feature_bbox_limit
    if requested is None:
        return cap
    if requested < 1 or requested > cap:
        raise InvalidRequestError(
            "limit must be between 1 and the server cap",
            details={"requested": requested, "max": cap},
        )
    return requested


async def get_features(
    session: AsyncSession,
    layer_id: uuid.UUID,
    bbox: BBox,
    limit: int | None,
    simplify: float | None = None,
    precision: int | None = None,
) -> FeatureCollection:
    layer = await layer_service.get_layer_or_404(session, layer_id)
    source = layer_service.require_postgis_source(layer)
    snapshot = await source_snapshot.get(session, layer, source)

    effective = clamp_limit(limit)
    digits = precision if precision is not None else get_settings().geojson_default_precision
    rows = await feature_repository.read_in_bbox(
        session, snapshot.source, bbox, effective, simplify=simplify, precision=digits
    )
    truncated = len(rows) > effective
    visible = rows[:effective]

    return FeatureCollection(
        features=[
            Feature(id=row["fid"], geometry=row["geometry"], properties=row["properties"])
            for row in visible
        ],
        returned=len(visible),
        limit=effective,
        truncated=truncated,
    )
