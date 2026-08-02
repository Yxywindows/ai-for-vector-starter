"""Export handlers (R8), on the shared task system.

A vector export reads the layer through the same trust boundary as every
other read path (verified source, catalog-membership field selection,
`build_where` filters). The query runs on the worker's own session (one
connection, one consistent snapshot); GeoDataFrame assembly and file
writing — the CPU-bound halves — run on a worker thread. A raster export
copies the layer's COG. Files land under `data_dir/exports`, named by
task id; the task's result carries file metadata and the download
endpoint streams it.

Retention is explicit and honest: files stay until removed by hand
(`retention: manual`) — there is no scheduled cleanup yet.
"""

from __future__ import annotations

import shutil
import uuid
import zipfile
from pathlib import Path
from typing import Any

import anyio
import geopandas as gpd
import shapely
from sqlalchemy import text

from app.core.config import get_settings
from app.core.errors import InvalidRequestError
from app.db.identifiers import qualified, quote, quote_catalog_name
from app.repositories.feature_repository import build_where
from app.schemas.export import RasterExportParams, VectorExportParams
from app.schemas.source import RasterFileSource, parse_source
from app.services import layer_service, source_snapshot, task_handlers
from app.services.raster_import_service import resolve_raster_path

EXTENSIONS = {"geojson": ".geojson", "csv": ".csv", "gpkg": ".gpkg", "shp": ".zip"}
DRIVERS = {"geojson": "GeoJSON", "gpkg": "GPKG", "shp": "ESRI Shapefile"}


def export_dir() -> Path:
    return get_settings().data_dir / "exports"


def export_file_path(task_id: uuid.UUID) -> Path | None:
    matches = list(export_dir().glob(f"{task_id}.*"))
    return matches[0] if matches else None


def _safe_filename(requested: str | None, default_stem: str, extension: str) -> str:
    stem = (requested or default_stem).strip().replace("/", "_").replace("\\", "_")
    stem = stem or default_stem
    return f"{Path(stem).stem}{extension}"


def _write_vector(
    frame: gpd.GeoDataFrame, fmt: str, target: Path, crs: int, stem: str
) -> None:
    """Blocking write half — runs on a worker thread.

    `stem` names the files *inside* a shapefile zip — the person unzipping
    should see their chosen name, not our task id.
    """
    if crs != 4326:
        frame = frame.to_crs(epsg=crs)
    if fmt == "csv":
        table = frame.drop(columns=frame.geometry.name).assign(
            geometry_wkt=frame.geometry.to_wkt()
        )
        table.to_csv(target, index=False)
        return
    if fmt == "shp":
        # A shapefile is a folder of sidecars; ship it as one zip.
        work = target.with_suffix(".tmp")
        work.mkdir(parents=True, exist_ok=True)
        try:
            frame.to_file(work / f"{stem}.shp", driver=DRIVERS[fmt])
            with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as bundle:
                for part in sorted(work.iterdir()):
                    bundle.write(part, part.name)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        return
    frame.to_file(target, driver=DRIVERS[fmt])


@task_handlers.register("export_vector")
async def export_vector(ctx: task_handlers.TaskContext) -> dict[str, Any]:
    params = VectorExportParams.model_validate(ctx.task.params)
    await ctx.report(0.05, "preparing", "resolving the dataset")

    layer = await layer_service.get_layer_or_404(ctx.session, params.layer_id)
    if layer.kind != "vector":
        raise InvalidRequestError(
            "Vector export needs a vector layer",
            details={"layerId": str(params.layer_id), "kind": layer.kind},
        )
    source = layer_service.require_postgis_source(layer)
    snapshot = await source_snapshot.get(ctx.session, layer, source)
    ctx.task.layer_id = layer.id

    columns = snapshot.attribute_names
    selected = params.fields if params.fields is not None else columns
    unknown = [name for name in selected if name not in columns]
    if unknown:
        raise InvalidRequestError(
            "Unknown export fields", details={"fields": unknown, "allowed": columns}
        )

    where_sql, where_params = build_where(list(params.filters or []), set(columns))
    conditions = [where_sql]
    bind: dict[str, Any] = dict(where_params)
    geom = quote(source.geometry_column)
    if params.bbox is not None:
        minx, miny, maxx, maxy = (float(value) for value in params.bbox)
        conditions.append(
            f"t.{geom} && ST_Transform(ST_MakeEnvelope("
            f"{minx}, {miny}, {maxx}, {maxy}, 4326), {int(source.srid)})"
        )
    if params.feature_ids is not None:
        conditions.append(f"t.{quote(source.id_column)}::text = ANY(:export_fids)")
        bind["export_fids"] = [str(value) for value in params.feature_ids]

    select_columns = ", ".join(
        [f"t.{quote_catalog_name(name)}" for name in selected]
        + [f"ST_AsBinary(ST_Transform(t.{geom}, 4326)) AS __geom_wkb"]
    )
    sql = (
        f"SELECT {select_columns} "
        f"FROM {qualified(source.schema_name, source.table_name)} AS t "
        f"WHERE {' AND '.join(conditions)} "
        f"ORDER BY t.{quote(source.id_column)}"
    )

    await ctx.report(0.2, "querying", "reading features")
    statement = text(sql).bindparams(**bind) if bind else text(sql)
    rows = (await ctx.session.execute(statement)).mappings().all()
    if not rows:
        raise InvalidRequestError(
            "Nothing to export: the current selection matches no features",
            details={"layerId": str(params.layer_id)},
        )
    await ctx.check_cancelled()

    def _build() -> gpd.GeoDataFrame:
        geometries = shapely.from_wkb([bytes(row["__geom_wkb"]) for row in rows])
        data = {name: [row[name] for row in rows] for name in selected}
        return gpd.GeoDataFrame(data=data or None, geometry=geometries, crs="EPSG:4326")

    frame = await anyio.to_thread.run_sync(_build)

    extension = EXTENSIONS[params.format]
    target_dir = export_dir()
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{ctx.task.id}{extension}"
    download_name = _safe_filename(params.filename, layer.name, extension)

    await ctx.report(0.6, "writing", f"writing {len(frame)} features as {params.format}")
    await anyio.to_thread.run_sync(
        _write_vector, frame, params.format, target, params.crs, Path(download_name).stem
    )
    await ctx.check_cancelled()

    await ctx.report(0.95, "finishing")
    return {
        "file": target.name,
        "downloadName": download_name,
        "format": params.format,
        "crs": params.crs,
        "featureCount": len(frame),
        "sizeBytes": target.stat().st_size,
        "retention": "manual",
    }


@task_handlers.register("export_raster")
async def export_raster(ctx: task_handlers.TaskContext) -> dict[str, Any]:
    params = RasterExportParams.model_validate(ctx.task.params)
    await ctx.report(0.05, "preparing", "resolving the dataset")

    layer = await layer_service.get_layer_or_404(ctx.session, params.layer_id)
    raster = parse_source(layer.source)
    if layer.kind != "raster" or not isinstance(raster, RasterFileSource):
        raise InvalidRequestError(
            "Raster export needs a raster layer",
            details={"layerId": str(params.layer_id), "kind": layer.kind},
        )
    ctx.task.layer_id = layer.id
    source_path = resolve_raster_path(raster)

    target_dir = export_dir()
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{ctx.task.id}.tif"
    download_name = _safe_filename(params.filename, layer.name, ".tif")

    await ctx.report(0.4, "writing", "copying the cloud-optimized GeoTIFF")
    await anyio.to_thread.run_sync(shutil.copyfile, source_path, target)

    await ctx.report(0.95, "finishing")
    return {
        "file": target.name,
        "downloadName": download_name,
        "format": "gtiff",
        "crs": layer.srid or 4326,
        "sizeBytes": target.stat().st_size,
        "retention": "manual",
    }
