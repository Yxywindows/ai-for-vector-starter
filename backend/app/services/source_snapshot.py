"""Per-layer snapshot of the verified source and its catalog columns.

Every tile, feature and attribute request used to re-run the same three
catalog lookups — layer row, `verify_source` (information_schema), and
`list_columns` (information_schema) — before doing any real work. At 20-60
tiles per viewport that is hundreds of redundant catalog queries per pan.

The snapshot caches the *verified* source plus its column list, keyed by
`(layer_id, layer.updated_at)`. `updated_at` is the exact signal the tile
ETag already trusts for staleness (`tile_service.tile_etag`): any layer
PATCH, style change or re-import moves it, which makes the old key
unreachable rather than stale. The cache is in-process and LRU-bounded;
a multi-process deployment gets cold caches per worker, never wrong ones.

DDL applied directly to a *registered* table (a column added in psql)
without touching the layer row is invisible until the entry is evicted or
the layer is next updated — the same trade the 60-second tile
Cache-Control already makes, now stated explicitly.
"""

from __future__ import annotations

import uuid
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.layer import Layer
from app.repositories import catalog_repository
from app.schemas.catalog import ColumnInfo
from app.schemas.source import PostgisSource
from app.services import catalog_service


@dataclass(frozen=True)
class SourceSnapshot:
    source: PostgisSource
    columns: tuple[ColumnInfo, ...]
    """Every table column, geometry included, in catalog order."""

    @property
    def attribute_names(self) -> list[str]:
        return [
            column.name for column in self.columns if column.name != self.source.geometry_column
        ]

    @property
    def id_column_type(self) -> str:
        return next(
            column.data_type for column in self.columns if column.name == self.source.id_column
        )


_cache: OrderedDict[tuple[uuid.UUID, datetime], SourceSnapshot] = OrderedDict()


async def get(session: AsyncSession, layer: Layer, source: PostgisSource) -> SourceSnapshot:
    """Verified source + columns for `layer`, from cache when fresh."""
    key = (layer.id, layer.updated_at)
    hit = _cache.get(key)
    if hit is not None:
        _cache.move_to_end(key)
        return hit

    await catalog_service.verify_source(session, source)
    columns = await catalog_repository.list_columns(session, source.schema_name, source.table_name)
    snapshot = SourceSnapshot(source=source, columns=tuple(columns))

    _cache[key] = snapshot
    # Older revisions of the same layer can never be requested again --
    # updated_at only moves forward -- so drop them eagerly.
    for stale in [k for k in _cache if k[0] == layer.id and k != key]:
        del _cache[stale]
    max_entries = get_settings().snapshot_cache_max_entries
    while len(_cache) > max_entries:
        _cache.popitem(last=False)
    return snapshot


def invalidate(layer_id: uuid.UUID) -> None:
    for key in [k for k in _cache if k[0] == layer_id]:
        del _cache[key]


def clear() -> None:
    """Test isolation hook."""
    _cache.clear()
