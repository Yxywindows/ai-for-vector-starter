"""Spatial analysis handlers (R7), built entirely on the task system.

Every tool follows one shape: resolve and verify the input layers through
the catalog trust boundary, build a single CREATE TABLE AS statement that
PostGIS executes (the heavy work never runs in Python, in a request, or
in the browser), then index and register the result table as a normal
vector layer. Stages report real progress and cancellation checkpoints
sit between them; the statement itself is the unit of work.

Identifier safety follows the platform's established rules: request
input goes through validated pydantic models and `validate_identifier`-
built sources; catalog-derived column names are quoted with
`quote_catalog_name` after membership against `information_schema`.
Numeric parameters are validated floats/ints and inlined as literals
(utility statements cannot take bind parameters).
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import InvalidRequestError
from app.db.identifiers import qualified, quote, quote_catalog_name
from app.models.layer import Layer
from app.schemas.analysis import (
    BufferParams,
    ClipParams,
    DissolveParams,
    IntersectionParams,
    PointInPolygonParams,
    SpatialJoinParams,
    ValidateRepairParams,
)
from app.schemas.layer import LayerCreate
from app.schemas.source import PostgisSource
from app.services import layer_service, source_snapshot, task_handlers
from app.services.source_snapshot import SourceSnapshot

PREDICATES = {
    "intersects": "ST_Intersects",
    "contains": "ST_Contains",
    "within": "ST_Within",
}


async def _vector_input(session: AsyncSession, layer_id: uuid.UUID) -> tuple[Layer, SourceSnapshot]:
    layer = await layer_service.get_layer_or_404(session, layer_id)
    if layer.kind != "vector":
        raise InvalidRequestError(
            "Analysis inputs must be vector layers",
            details={"layerId": str(layer_id), "kind": layer.kind},
        )
    source = layer_service.require_postgis_source(layer)
    snapshot = await source_snapshot.get(session, layer, source)
    return layer, snapshot


def _geom(snapshot: SourceSnapshot, alias: str) -> str:
    """The input geometry, normalized to EPSG:4326."""
    column = f"{alias}.{quote(snapshot.source.geometry_column)}"
    if snapshot.source.srid == 4326:
        return column
    return f"ST_Transform({column}, 4326)"


def _attr_columns(
    snapshot: SourceSnapshot, alias: str, *, prefix: str = "", exclude: frozenset[str] = frozenset()
) -> list[str]:
    """Catalog-derived attribute columns, quoted, optionally re-prefixed.

    Anything literally named `geometry` is skipped: the result table's
    geometry column owns that name.
    """
    items: list[str] = []
    for name in snapshot.attribute_names:
        if name in exclude or name == "geometry":
            continue
        target = f"{prefix}{name}" if prefix else name
        items.append(f"{alias}.{quote_catalog_name(name)} AS {quote_catalog_name(target)}")
    return items


def _result_table_name() -> str:
    return f"analysis_{uuid.uuid4().hex[:12]}"


async def _register_result(
    ctx: task_handlers.TaskContext,
    *,
    table_name: str,
    output_name: str,
    id_column: str,
) -> Layer:
    """Index the result table and register it as a layer of the task's
    project. Any failure after the CTAS drops the table — the same
    all-or-nothing guarantee the import write path gives."""
    session = ctx.session
    settings = get_settings()
    result_qualified = qualified(settings.import_schema, table_name)

    try:
        await session.execute(
            text(
                f"ALTER TABLE {result_qualified} ADD PRIMARY KEY ({quote_catalog_name(id_column)})"
            )
        )
        await session.execute(
            text(
                f"CREATE INDEX {quote(f'ix_{table_name}_geom')} "
                f"ON {result_qualified} USING GIST (geometry)"
            )
        )
        await session.execute(text(f"ANALYZE {result_qualified}"))

        stats = (
            (
                await session.execute(
                    text(
                        f"""
                    SELECT (SELECT count(*)::int FROM {result_qualified}) AS n,
                           ST_XMin(e.b) AS minx, ST_YMin(e.b) AS miny,
                           ST_XMax(e.b) AS maxx, ST_YMax(e.b) AS maxy,
                           (
                               SELECT upper(GeometryType(geometry))
                               FROM {result_qualified}
                               WHERE geometry IS NOT NULL
                               LIMIT 1
                           ) AS gtype
                    FROM (SELECT ST_Extent(geometry) AS b FROM {result_qualified}) AS e
                    """
                    )
                )
            )
            .mappings()
            .first()
        )

        source = PostgisSource(
            schema_name=settings.import_schema,
            table_name=table_name,
            geometry_column="geometry",
            id_column=id_column,
            srid=4326,
        )
        layer = await layer_service.create_layer(
            session,
            ctx.task.project_id,
            LayerCreate(name=output_name, kind="vector", source=source),
        )
        from app.repositories import layer_repository

        extent = (
            [stats["minx"], stats["miny"], stats["maxx"], stats["maxy"]]
            if stats and stats["minx"] is not None
            else None
        )
        return await layer_repository.update(
            session,
            layer,
            feature_count=stats["n"] if stats else 0,
            extent=extent,
            srid=4326,
            geometry_type=stats["gtype"] if stats else None,
        )
    except Exception:
        await session.rollback()
        await session.execute(text(f"DROP TABLE IF EXISTS {result_qualified}"))
        await session.commit()
        raise


async def _execute(
    ctx: task_handlers.TaskContext,
    *,
    select_sql: str,
    output_name: str,
    id_column: str,
    extra_result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The shared tail of every tool: CTAS → checkpoint → register."""
    settings = get_settings()
    table_name = _result_table_name()
    result_qualified = qualified(settings.import_schema, table_name)

    await ctx.report(0.3, "executing", "running the analysis in PostGIS")
    await ctx.session.execute(text(f"CREATE TABLE {result_qualified} AS {select_sql}"))
    await ctx.check_cancelled()

    await ctx.report(0.75, "registering", "indexing and registering the result")
    layer = await _register_result(
        ctx, table_name=table_name, output_name=output_name, id_column=id_column
    )
    ctx.task.layer_id = layer.id
    return {
        "layerId": str(layer.id),
        "layerName": layer.name,
        "featureCount": layer.feature_count,
        **(extra_result or {}),
    }


@task_handlers.register("analysis_buffer")
async def buffer_handler(ctx: task_handlers.TaskContext) -> dict[str, Any]:
    params = BufferParams.model_validate(ctx.task.params)
    await ctx.report(0.1, "preparing", "resolving inputs")
    _, snapshot = await _vector_input(ctx.session, params.layer_id)
    await ctx.check_cancelled()

    columns = _attr_columns(snapshot, "t")
    distance = float(params.distance_meters)
    select_sql = f"""
        SELECT {", ".join(columns)},
               ST_Buffer({_geom(snapshot, "t")}::geography, {distance})::geometry AS geometry
        FROM {qualified(snapshot.source.schema_name, snapshot.source.table_name)} AS t
    """
    return await _execute(
        ctx,
        select_sql=select_sql,
        output_name=params.output_name,
        id_column=snapshot.source.id_column,
        extra_result={"distanceMeters": distance},
    )


@task_handlers.register("analysis_clip")
async def clip_handler(ctx: task_handlers.TaskContext) -> dict[str, Any]:
    params = ClipParams.model_validate(ctx.task.params)
    await ctx.report(0.1, "preparing", "resolving inputs")
    _, target = await _vector_input(ctx.session, params.layer_id)
    _, mask = await _vector_input(ctx.session, params.mask_layer_id)
    await ctx.check_cancelled()

    columns = _attr_columns(target, "t")
    select_sql = f"""
        WITH mask AS (
            SELECT ST_Union({_geom(mask, "m")}) AS g
            FROM {qualified(mask.source.schema_name, mask.source.table_name)} AS m
        )
        SELECT {", ".join(columns)},
               ST_Intersection({_geom(target, "t")}, mask.g) AS geometry
        FROM {qualified(target.source.schema_name, target.source.table_name)} AS t, mask
        WHERE {_geom(target, "t")} && mask.g
          AND ST_Intersects({_geom(target, "t")}, mask.g)
    """
    return await _execute(
        ctx,
        select_sql=select_sql,
        output_name=params.output_name,
        id_column=target.source.id_column,
    )


@task_handlers.register("analysis_intersection")
async def intersection_handler(ctx: task_handlers.TaskContext) -> dict[str, Any]:
    params = IntersectionParams.model_validate(ctx.task.params)
    await ctx.report(0.1, "preparing", "resolving inputs")
    _, a = await _vector_input(ctx.session, params.layer_id)
    _, b = await _vector_input(ctx.session, params.other_layer_id)
    await ctx.check_cancelled()

    a_cols = _attr_columns(a, "a", prefix="a_")
    b_cols = _attr_columns(b, "b", prefix="b_")
    select_sql = f"""
        SELECT row_number() OVER ()::bigint AS fid,
               {", ".join(a_cols + b_cols)},
               ST_Intersection({_geom(a, "a")}, {_geom(b, "b")}) AS geometry
        FROM {qualified(a.source.schema_name, a.source.table_name)} AS a
        JOIN {qualified(b.source.schema_name, b.source.table_name)} AS b
          ON {_geom(a, "a")} && {_geom(b, "b")}
         AND ST_Intersects({_geom(a, "a")}, {_geom(b, "b")})
        WHERE NOT ST_IsEmpty(ST_Intersection({_geom(a, "a")}, {_geom(b, "b")}))
    """
    return await _execute(
        ctx, select_sql=select_sql, output_name=params.output_name, id_column="fid"
    )


@task_handlers.register("analysis_dissolve")
async def dissolve_handler(ctx: task_handlers.TaskContext) -> dict[str, Any]:
    params = DissolveParams.model_validate(ctx.task.params)
    await ctx.report(0.1, "preparing", "resolving inputs")
    _, snapshot = await _vector_input(ctx.session, params.layer_id)
    await ctx.check_cancelled()

    src = qualified(snapshot.source.schema_name, snapshot.source.table_name)
    if params.by_field is not None:
        if params.by_field not in snapshot.attribute_names:
            raise InvalidRequestError(
                "Unknown dissolve field",
                details={"field": params.by_field, "allowed": snapshot.attribute_names},
            )
        by = quote_catalog_name(params.by_field)
        select_sql = f"""
            SELECT row_number() OVER ()::bigint AS fid,
                   t.{by} AS {by},
                   count(*)::int AS merged_count,
                   ST_Multi(ST_Union({_geom(snapshot, "t")})) AS geometry
            FROM {src} AS t
            GROUP BY t.{by}
        """
    else:
        select_sql = f"""
            SELECT 1::bigint AS fid,
                   count(*)::int AS merged_count,
                   ST_Multi(ST_Union({_geom(snapshot, "t")})) AS geometry
            FROM {src} AS t
        """
    return await _execute(
        ctx, select_sql=select_sql, output_name=params.output_name, id_column="fid"
    )


@task_handlers.register("analysis_spatial_join")
async def spatial_join_handler(ctx: task_handlers.TaskContext) -> dict[str, Any]:
    params = SpatialJoinParams.model_validate(ctx.task.params)
    await ctx.report(0.1, "preparing", "resolving inputs")
    _, target = await _vector_input(ctx.session, params.target_layer_id)
    _, joined = await _vector_input(ctx.session, params.join_layer_id)
    await ctx.check_cancelled()

    predicate = PREDICATES[params.predicate]
    t_cols = _attr_columns(target, "t")
    j_inner = _attr_columns(joined, "j", prefix="join_")
    j_outer = [
        f"j.{quote_catalog_name(f'join_{name}')}"
        for name in joined.attribute_names
        if name != "geometry"
    ]
    select_sql = f"""
        SELECT {", ".join(t_cols)},
               {", ".join(j_outer)},
               {_geom(target, "t")} AS geometry
        FROM {qualified(target.source.schema_name, target.source.table_name)} AS t
        LEFT JOIN LATERAL (
            SELECT {", ".join(j_inner)}
            FROM {qualified(joined.source.schema_name, joined.source.table_name)} AS j
            WHERE {predicate}({_geom(target, "t")}, {_geom(joined, "j")})
            LIMIT 1
        ) AS j ON true
    """
    return await _execute(
        ctx,
        select_sql=select_sql,
        output_name=params.output_name,
        id_column=target.source.id_column,
        extra_result={"predicate": params.predicate},
    )


@task_handlers.register("analysis_validate_repair")
async def validate_repair_handler(ctx: task_handlers.TaskContext) -> dict[str, Any]:
    params = ValidateRepairParams.model_validate(ctx.task.params)
    await ctx.report(0.1, "preparing", "resolving inputs")
    _, snapshot = await _vector_input(ctx.session, params.layer_id)
    await ctx.check_cancelled()

    src = qualified(snapshot.source.schema_name, snapshot.source.table_name)
    geom = _geom(snapshot, "t")
    invalid = (
        await ctx.session.execute(
            text(f"SELECT count(*)::int FROM {src} AS t WHERE NOT ST_IsValid({geom})")
        )
    ).scalar_one()

    columns = _attr_columns(snapshot, "t")
    select_sql = f"""
        SELECT {", ".join(columns)},
               CASE WHEN ST_IsValid({geom}) THEN {geom} ELSE ST_MakeValid({geom}) END AS geometry
        FROM {src} AS t
    """
    return await _execute(
        ctx,
        select_sql=select_sql,
        output_name=params.output_name,
        id_column=snapshot.source.id_column,
        extra_result={"repairedCount": int(invalid)},
    )


@task_handlers.register("analysis_point_in_polygon")
async def point_in_polygon_handler(ctx: task_handlers.TaskContext) -> dict[str, Any]:
    params = PointInPolygonParams.model_validate(ctx.task.params)
    await ctx.report(0.1, "preparing", "resolving inputs")
    _, points = await _vector_input(ctx.session, params.points_layer_id)
    _, polygons = await _vector_input(ctx.session, params.polygons_layer_id)
    await ctx.check_cancelled()

    poly_cols = _attr_columns(polygons, "t")
    select_sql = f"""
        SELECT {", ".join(poly_cols)},
               (
                   SELECT count(*)::int
                   FROM {qualified(points.source.schema_name, points.source.table_name)} AS p
                   WHERE ST_Contains({_geom(polygons, "t")}, {_geom(points, "p")})
               ) AS point_count,
               {_geom(polygons, "t")} AS geometry
        FROM {qualified(polygons.source.schema_name, polygons.source.table_name)} AS t
    """
    return await _execute(
        ctx,
        select_sql=select_sql,
        output_name=params.output_name,
        id_column=polygons.source.id_column,
    )
