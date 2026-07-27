from __future__ import annotations

import hashlib
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import InvalidRequestError
from app.models.layer import Layer
from app.repositories import feature_repository, tile_repository
from app.services import catalog_service, layer_service

MAX_ZOOM = 24


def validate_tile_coords(z: int, x: int, y: int) -> None:
    if not 0 <= z <= MAX_ZOOM:
        raise InvalidRequestError("Zoom out of range", details={"z": z, "maxZoom": MAX_ZOOM})
    span = 1 << z
    if not (0 <= x < span and 0 <= y < span):
        raise InvalidRequestError(
            "Tile coordinate out of range for this zoom",
            details={"z": z, "x": x, "y": y, "tilesPerAxis": span},
        )


def tile_etag(layer: Layer, z: int, x: int, y: int) -> str:
    """Changes whenever the layer row changes, so a style or rename busts the cache."""
    seed = f"{layer.id}:{layer.updated_at.isoformat()}:{z}/{x}/{y}"
    return f'W/"{hashlib.sha256(seed.encode()).hexdigest()[:32]}"'


async def get_vector_tile(
    session: AsyncSession, layer_id: uuid.UUID, z: int, x: int, y: int
) -> tuple[bytes, Layer]:
    validate_tile_coords(z, x, y)
    layer = await layer_service.get_layer_or_404(session, layer_id)
    source = layer_service.require_postgis_source(layer)
    await catalog_service.verify_source(session, source)
    columns = await feature_repository.attribute_columns(session, source)
    blob = await tile_repository.render_mvt(session, source, columns, z, x, y, layer.name)
    return blob, layer
