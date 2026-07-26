"""Read a vector file with pyogrio/geopandas and land it in gis_data.

Everything blocking (GDAL reads, the bulk INSERT) runs on a worker thread.
The table is created first and the layer row second; if the layer row fails
the table is dropped, so a failed import leaves nothing behind.
"""

from __future__ import annotations

import logging
import shutil
import uuid
import zipfile
from pathlib import Path
from typing import Any

import anyio
import geopandas as gpd
from fastapi import UploadFile
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import UnsupportedFormatError, UpstreamDataError
from app.db.identifiers import qualified, quote
from app.db.sync_engine import get_sync_engine
from app.models.layer import Layer
from app.repositories import catalog_repository, layer_repository
from app.schemas.layer import LayerCreate
from app.schemas.source import PostgisSource
from app.services import layer_service
from app.services.upload_service import save_upload, slugify_table_name

logger = logging.getLogger(__name__)

SUPPORTED_SUFFIXES = {".geojson", ".json", ".gpkg", ".zip", ".shp", ".gml", ".kml"}
GEOMETRY_COLUMN = "geometry"
ID_COLUMN = "fid"


def _resolve_dataset_path(path: Path) -> Path:
    """Unzip a shapefile/gpkg bundle and return the actual dataset to open."""
    if path.suffix.lower() != ".zip":
        return path
    extract_dir = path.with_suffix("")
    extract_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path) as archive:
        for member in archive.namelist():
            if Path(member).is_absolute() or ".." in Path(member).parts:
                raise UpstreamDataError(
                    "Archive contains an unsafe path", details={"entry": member}
                )
        archive.extractall(extract_dir)
    for pattern in ("**/*.shp", "**/*.gpkg", "**/*.geojson"):
        matches = sorted(extract_dir.glob(pattern))
        if matches:
            return matches[0]
    raise UnsupportedFormatError(
        "Archive contains no .shp, .gpkg or .geojson dataset",
        details={"filename": path.name},
    )


def _read_and_write(path: Path, table_name: str) -> dict[str, Any]:
    """Blocking half of the import. Runs on a worker thread."""
    dataset = _resolve_dataset_path(path)
    try:
        frame = gpd.read_file(dataset, engine="pyogrio")
    except Exception as exc:  # GDAL raises a wide variety of errors
        raise UpstreamDataError(
            "Could not read the uploaded dataset",
            details={"filename": path.name, "reason": str(exc)[:400]},
        ) from exc

    if frame.empty:
        raise UpstreamDataError("Dataset contains no features", details={"filename": path.name})
    if frame.crs is None:
        frame = frame.set_crs(4326)  # GeoJSON without a CRS member is CRS84
    frame = frame.to_crs(4326)
    if frame.geometry.name != GEOMETRY_COLUMN:
        frame = frame.rename_geometry(GEOMETRY_COLUMN)

    settings = get_settings()
    engine = get_sync_engine()
    frame.to_postgis(
        table_name,
        engine,
        schema=settings.import_schema,
        if_exists="fail",
        index=True,
        index_label=ID_COLUMN,
    )
    qualified_name = qualified(settings.import_schema, table_name)
    with engine.begin() as conn:
        conn.execute(text(f"ALTER TABLE {qualified_name} ADD PRIMARY KEY ({quote(ID_COLUMN)})"))
        conn.execute(
            text(
                f"CREATE INDEX {quote('ix_' + table_name + '_geom')} "
                f"ON {qualified_name} USING GIST ({quote(GEOMETRY_COLUMN)})"
            )
        )
    return {
        "feature_count": len(frame),
        "geometry_type": str(frame.geom_type.iloc[0]).upper(),
        "extent": [float(value) for value in frame.total_bounds],
    }


def _drop_table(table_name: str) -> None:
    settings = get_settings()
    with get_sync_engine().begin() as conn:
        conn.execute(text(f"DROP TABLE IF EXISTS {qualified(settings.import_schema, table_name)}"))


async def import_vector_file(
    session: AsyncSession,
    project_id: uuid.UUID,
    upload: UploadFile,
    layer_name: str | None,
) -> Layer:
    settings = get_settings()
    original_name = Path(upload.filename or "upload").name
    if Path(original_name).suffix.lower() not in SUPPORTED_SUFFIXES:
        raise UnsupportedFormatError(
            "Unsupported vector format",
            details={"filename": original_name, "supported": sorted(SUPPORTED_SUFFIXES)},
        )

    work_dir = settings.upload_tmp_dir / uuid.uuid4().hex
    try:
        saved = await save_upload(upload, work_dir, settings.upload_max_bytes)
        table_name = slugify_table_name(original_name)
        stats = await anyio.to_thread.run_sync(_read_and_write, saved, table_name)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

    source = PostgisSource(
        schema_name=settings.import_schema,
        table_name=table_name,
        geometry_column=GEOMETRY_COLUMN,
        id_column=ID_COLUMN,
        srid=4326,
    )
    try:
        layer = await layer_service.create_layer(
            session,
            project_id,
            LayerCreate(name=layer_name or Path(original_name).stem, kind="vector", source=source),
        )
        metadata = await catalog_repository.geometry_metadata(session, source)
        layer = await layer_repository.update(
            session,
            layer,
            srid=4326,
            geometry_type=(str(metadata["geometry_type"]) if metadata else stats["geometry_type"]),
            extent=stats["extent"],
            feature_count=stats["feature_count"],
        )
        return layer
    except Exception:
        # The table was written on a separate SYNC connection and already
        # committed, so the request-scoped rollback cannot undo it. Drop it
        # explicitly or a failed import leaves an orphan table behind.
        logger.exception("Layer registration failed; dropping imported table %s", table_name)
        await anyio.to_thread.run_sync(_drop_table, table_name)
        raise
