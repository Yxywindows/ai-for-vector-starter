from __future__ import annotations

import hashlib
import uuid
from collections import OrderedDict
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import InvalidRequestError
from app.models.layer import Layer
from app.repositories import tile_repository
from app.services import layer_service, source_snapshot

MAX_ZOOM = 24

_TileKey = tuple[uuid.UUID, datetime, int, int, int]

# In-process LRU of rendered vector tiles, byte-bounded. The key embeds
# `layer.updated_at` — the same freshness signal the ETag uses — so an
# entry can only ever be cold, never stale. Single event loop, no awaits
# between reads and writes, so no lock is needed.
_tile_cache: OrderedDict[_TileKey, bytes] = OrderedDict()
_tile_cache_bytes = 0


def _tile_cache_get(key: _TileKey) -> bytes | None:
    blob = _tile_cache.get(key)
    if blob is not None:
        _tile_cache.move_to_end(key)
    return blob


def _tile_cache_put(key: _TileKey, blob: bytes) -> None:
    global _tile_cache_bytes
    if key in _tile_cache:
        return
    max_bytes = get_settings().tile_cache_max_bytes
    if max_bytes <= 0:
        return
    _tile_cache[key] = blob
    _tile_cache_bytes += len(blob)
    while _tile_cache_bytes > max_bytes and _tile_cache:
        _, evicted = _tile_cache.popitem(last=False)
        _tile_cache_bytes -= len(evicted)


def clear_tile_cache() -> None:
    """Test isolation hook."""
    global _tile_cache_bytes
    _tile_cache.clear()
    _tile_cache_bytes = 0


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

    key: _TileKey = (layer.id, layer.updated_at, z, x, y)
    cached = _tile_cache_get(key)
    if cached is not None:
        return cached, layer

    source = layer_service.require_postgis_source(layer)
    snapshot = await source_snapshot.get(session, layer, source)
    blob = await tile_repository.render_mvt(
        session, snapshot.source, snapshot.attribute_names, z, x, y, layer.name
    )
    _tile_cache_put(key, blob)
    return blob, layer
