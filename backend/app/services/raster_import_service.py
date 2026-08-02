"""Validate an uploaded raster, normalise it to a COG, and register a layer.

Cloud-Optimized GeoTIFF is not a nicety here: it is what makes
`/tiles/{z}/{x}/{y}.png` cheap. A COG has internal tiling and overviews, so
rio-tiler reads a few kilobytes per tile instead of decoding the whole
image. Non-COG uploads are converted once at import rather than paid for on
every tile request.
"""

from __future__ import annotations

import logging
import shutil
import uuid
import warnings
from pathlib import Path
from typing import Any

import anyio
import rasterio
from fastapi import UploadFile
from rasterio.errors import RasterioDeprecationWarning
from rasterio.warp import transform_bounds
from rio_cogeo.cogeo import cog_translate, cog_validate
from rio_cogeo.profiles import cog_profiles
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import (
    AppError,
    InvalidRequestError,
    UnsupportedFormatError,
    UpstreamDataError,
)
from app.models.layer import Layer
from app.repositories import layer_repository
from app.schemas.layer import LayerCreate
from app.schemas.source import RasterFileSource
from app.schemas.style import RasterStyle
from app.services import layer_service
from app.services.upload_service import save_upload

logger = logging.getLogger(__name__)

SUPPORTED_SUFFIXES = {".tif", ".tiff", ".vrt", ".img", ".jp2"}


def resolve_raster_path(source: RasterFileSource) -> Path:
    """Turn a stored relative path into an absolute one, refusing to escape.

    Task 12 calls this on every tile request, so a `source.path` value that
    resolves outside `settings.raster_dir` (e.g. via `..` components) must
    never be handed to rasterio.
    """
    root = get_settings().raster_dir.resolve()
    candidate = (root / source.path).resolve()
    if not candidate.is_relative_to(root):
        raise InvalidRequestError(
            "Raster path escapes the data directory", details={"path": source.path}
        )
    return candidate


def _inspect_and_normalise(saved: Path, target: Path) -> dict[str, Any]:
    """Blocking half: validate, convert to COG, read stats. Runs on a worker thread."""
    try:
        with rasterio.open(saved) as dataset:
            if dataset.crs is None:
                raise UpstreamDataError(
                    "Raster has no CRS; cannot place it on a map",
                    details={"filename": saved.name},
                )
            bounds_4326 = transform_bounds(
                dataset.crs, "EPSG:4326", *dataset.bounds, densify_pts=21
            )
            band_count = int(dataset.count)
            nodata = None if dataset.nodata is None else float(dataset.nodata)
            # Deliberately `.statistics()`, not the newer `.stats()`: both
            # call the same GDAL function, but `.stats()` discards GDAL's
            # return code, so a band GDAL cannot compute statistics for
            # (e.g. all pixels equal nodata) comes back as a *successful*
            # Statistics(min=0, max=0, ...) instead of raising -- verified
            # empirically against an all-nodata fixture. `.statistics()`
            # wraps the same failure in a catchable `StatisticsError`,
            # which the `except Exception` below turns into the same
            # `UpstreamDataError` the CRS check above raises, so a raster
            # that cannot be scaled fails exactly like one that cannot be
            # placed on a map, instead of succeeding with a bogus rescale
            # range.
            #
            # `.statistics()` is deprecated in favour of `.stats()`, but
            # `RasterioDeprecationWarning` subclasses `FutureWarning`, not
            # `DeprecationWarning` (confirmed via its `__mro__`), so it
            # never trips this project's `filterwarnings =
            # ["error::DeprecationWarning"]`. It is suppressed here purely
            # to keep logs/test output free of noise for a warning this
            # comment already explains.
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RasterioDeprecationWarning)
                band_stats = [dataset.statistics(band, approx=True) for band in dataset.indexes]
    except UpstreamDataError:
        raise
    except Exception as exc:
        raise UpstreamDataError(
            "Could not read the uploaded raster",
            details={"filename": saved.name, "reason": str(exc)[:400]},
        ) from exc

    target.parent.mkdir(parents=True, exist_ok=True)
    already_cog, _errors, _warnings = cog_validate(saved, quiet=True)
    if already_cog:
        shutil.copyfile(saved, target)
    else:
        logger.info("Converting %s to COG", saved.name)
        # `cog_profiles.get` ships without a type annotation even though the
        # module itself is typed (py.typed), so this one call needs a scoped
        # ignore rather than the broader `ignore_missing_imports` override.
        deflate_profile = cog_profiles.get("deflate")  # type: ignore[no-untyped-call]
        cog_translate(saved, target, deflate_profile, quiet=True, in_memory=False)

    return {
        "band_count": band_count,
        "nodata": nodata,
        "extent": [float(value) for value in bounds_4326],
        "rescale": [(float(stat.min), float(stat.max)) for stat in band_stats],
    }


async def import_raster_file(
    session: AsyncSession,
    project_id: uuid.UUID,
    upload: UploadFile,
    layer_name: str | None,
) -> Layer:
    settings = get_settings()
    original_name = Path(upload.filename or "upload").name
    if Path(original_name).suffix.lower() not in SUPPORTED_SUFFIXES:
        raise UnsupportedFormatError(
            "Unsupported raster format",
            details={"filename": original_name, "supported": sorted(SUPPORTED_SUFFIXES)},
        )

    work_dir = settings.upload_tmp_dir / uuid.uuid4().hex
    stored_name = f"{uuid.uuid4().hex}.tif"
    target = settings.raster_dir / stored_name

    from app.services import task_service

    started = task_service._now()
    provenance = {"sourceFilename": original_name, "submittedVia": "sync-import"}
    try:
        saved = await save_upload(upload, work_dir, settings.upload_max_bytes)
        # One guard spans every step from here on: `_inspect_and_normalise`
        # is where `target` becomes a real COG on disk, and everything after
        # it -- building the source/style models and registering the layer
        # -- can still fail. No database rollback removes a file, so any
        # exception in this whole span must delete `target` itself, or a
        # failed import silently leaves an orphan raster behind.
        try:
            info = await anyio.to_thread.run_sync(_inspect_and_normalise, saved, target)

            source = RasterFileSource(
                path=stored_name,
                band_count=info["band_count"],
                nodata=info["nodata"],
                is_cog=True,
            )
            style = RasterStyle(bands=[1], rescale=[info["rescale"][0]])

            layer = await layer_service.create_layer(
                session,
                project_id,
                LayerCreate(
                    name=layer_name or Path(original_name).stem,
                    kind="raster",
                    source=source,
                    style=style,
                ),
            )
            updated = await layer_repository.update(
                session, layer, srid=4326, extent=info["extent"]
            )
            await task_service.record_finished(
                session,
                project_id=project_id,
                kind="raster_import",
                provenance=provenance,
                started_at=started,
                layer_id=updated.id,
                result={"layerId": str(updated.id), "layerName": updated.name},
            )
            return updated
        except AppError as exc:
            target.unlink(missing_ok=True)
            await task_service.record_failure_detached(
                project_id=project_id,
                kind="raster_import",
                provenance=provenance,
                started_at=started,
                error=task_service.error_envelope(exc),
            )
            raise
        except Exception:
            target.unlink(missing_ok=True)
            raise
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
