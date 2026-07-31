"""XYZ PNG tiles from COGs, read through the bounded dataset pool.

rio-tiler does the windowed read: given a tile's Web Mercator bounds it
picks the right overview level and reads only the bytes that intersect. All
of that is blocking file I/O, so every call is dispatched to a worker
thread; the pool's per-key lock guarantees only one thread touches a given
rasterio dataset at a time.
"""

from __future__ import annotations

import uuid
from typing import cast

import anyio
from rio_tiler.colormap import cmap
from rio_tiler.errors import InvalidColorMapName
from rio_tiler.io import Reader
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import InvalidRequestError, UpstreamDataError
from app.models.layer import Layer
from app.resources.dataset_pool import get_raster_pool
from app.schemas.source import RasterFileSource, parse_source
from app.schemas.style import RasterStyle, parse_style
from app.schemas.system import BandStatistics, RasterStatistics
from app.services import layer_service
from app.services.raster_import_service import resolve_raster_path
from app.services.tile_service import validate_tile_coords

TILE_SIZE = 256


def open_reader(key: str) -> Reader:
    """Pool factory. `key` is the absolute path of a raster on disk.

    Runs on a worker thread -- see `DatasetPool._checkout` -- because
    opening a raster is real, blocking file I/O (header, tiling scheme,
    overview table), and the pool's global guard must never be held while
    that happens.
    """
    return Reader(key)


def close_reader(reader: Reader) -> None:
    # `Reader.close` ships without a type annotation even though rio-tiler
    # is otherwise typed (py.typed), so this one call needs a scoped ignore
    # rather than the broader `ignore_missing_imports` override -- same
    # shape as `cog_profiles.get` in raster_import_service.py.
    reader.close()  # type: ignore[no-untyped-call]


def _require_raster_source(layer: Layer) -> RasterFileSource:
    source = parse_source(layer.source)
    if not isinstance(source, RasterFileSource):
        raise InvalidRequestError(
            f"Layer {layer.id} is not backed by a raster file",
            details={"layerId": str(layer.id), "sourceType": source.type},
        )
    return source


def _raster_style(layer: Layer, source: RasterFileSource) -> RasterStyle:
    style = parse_style(layer.style)
    if isinstance(style, RasterStyle):
        return style
    return RasterStyle(bands=list(range(1, min(source.band_count, 3) + 1)))


async def render_png(
    session: AsyncSession, layer_id: uuid.UUID, z: int, x: int, y: int
) -> tuple[bytes | None, Layer]:
    validate_tile_coords(z, x, y)
    layer = await layer_service.get_layer_or_404(session, layer_id)
    source = _require_raster_source(layer)
    style = _raster_style(layer, source)
    path = str(resolve_raster_path(source))

    def _read(reader: Reader) -> bytes | None:
        if not reader.tile_exists(x, y, z):
            return None
        image = reader.tile(x, y, z, indexes=style.bands, tilesize=TILE_SIZE)
        if style.rescale:
            image.rescale(in_range=style.rescale)
        colormap = None
        if style.colormap:
            try:
                colormap = cmap.get(style.colormap)
            # `cmap.get` raises `rio_tiler.errors.InvalidColorMapName` for an
            # unknown name -- confirmed by calling it directly -- which is
            # neither a `KeyError` nor a `ValueError`; both are caught
            # anyway in case a future rio-tiler version or a custom
            # colormap path raises one of those instead.
            except (InvalidColorMapName, KeyError, ValueError) as exc:
                raise InvalidRequestError(
                    "Unknown colormap",
                    details={"colormap": style.colormap},
                ) from exc
        return bytes(image.render(img_format="PNG", colormap=colormap))

    try:
        async with get_raster_pool().acquire(path) as handle:
            reader = cast(Reader, handle)
            return await anyio.to_thread.run_sync(_read, reader), layer
    # A raster deleted from disk after its layer row was created surfaces
    # here as `rasterio.errors.RasterioIOError` (confirmed by opening a
    # missing path directly) -- an `OSError` subclass, but not a
    # `FileNotFoundError`, since the two are siblings under `OSError`
    # rather than parent/child. Catching `OSError` is what actually
    # observes it.
    except OSError as exc:
        raise UpstreamDataError(
            "Raster file is missing from disk", details={"path": source.path}
        ) from exc


async def band_statistics(session: AsyncSession, layer_id: uuid.UUID) -> RasterStatistics:
    layer = await layer_service.get_layer_or_404(session, layer_id)
    source = _require_raster_source(layer)
    path = str(resolve_raster_path(source))

    def _read(reader: Reader) -> RasterStatistics:
        raw = reader.statistics()
        bands: list[BandStatistics] = []
        for index, (_name, stat) in enumerate(raw.items(), start=1):
            # `percentile_2`/`percentile_98` are not declared fields on
            # rio_tiler.models.BandStatistics -- confirmed by inspecting
            # `BandStatistics.model_fields` -- they arrive only because the
            # model allows extras (`model_config = {"extra": "allow"}"`) and
            # rio-tiler's own `Statistics()` helper always includes them.
            # `model_dump()` surfaces extras as plain dict keys, which mypy
            # can check without a per-attribute `type: ignore`.
            values = stat.model_dump()
            bands.append(
                BandStatistics(
                    band=index,
                    min=float(values["min"]),
                    max=float(values["max"]),
                    mean=float(values["mean"]),
                    std=float(values["std"]),
                    percentile2=float(values["percentile_2"]),
                    percentile98=float(values["percentile_98"]),
                )
            )
        return RasterStatistics(bands=bands)

    try:
        async with get_raster_pool().acquire(path) as handle:
            reader = cast(Reader, handle)
            return await anyio.to_thread.run_sync(_read, reader)
    except OSError as exc:
        raise UpstreamDataError(
            "Raster file is missing from disk", details={"path": source.path}
        ) from exc
