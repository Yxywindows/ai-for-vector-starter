"""Reads of the PostgreSQL/PostGIS catalog, plus geometry statistics.

Everything here that interpolates a name has already passed
`validate_identifier`; values are always bind parameters.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.identifiers import qualified, quote, validate_identifier
from app.schemas.catalog import ColumnInfo, GeometryTableInfo
from app.schemas.source import PostgisSource

HIDDEN_SCHEMAS = ("pg_catalog", "information_schema", "topology", "tiger", "tiger_data")

_LIST_TABLES = text(
    """
    SELECT g.f_table_schema  AS schema_name,
           g.f_table_name    AS table_name,
           g.f_geometry_column AS geometry_column,
           g.srid            AS srid,
           g.type            AS geometry_type,
           COALESCE(c.reltuples, 0)::bigint AS estimated_rows
    FROM geometry_columns g
    LEFT JOIN pg_class c
           ON c.oid = to_regclass(quote_ident(g.f_table_schema) || '.'
                                  || quote_ident(g.f_table_name))
    WHERE g.f_table_schema <> ALL(:hidden)
    ORDER BY g.f_table_schema, g.f_table_name
    """
)

_PRIMARY_KEY = text(
    """
    SELECT a.attname AS name
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = to_regclass(:qname) AND i.indisprimary
    ORDER BY a.attnum
    LIMIT 1
    """
)

_TABLE_EXISTS = text("SELECT to_regclass(:qname) IS NOT NULL AS present")

_COLUMNS = text(
    """
    SELECT column_name AS name,
           data_type   AS data_type,
           is_nullable = 'YES' AS nullable,
           is_generated = 'NEVER' AND identity_generation IS NULL AS editable
    FROM information_schema.columns
    WHERE table_schema = :schema AND table_name = :table
    ORDER BY ordinal_position
    """
)

_COLUMN_EXISTS = text(
    """
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = :schema AND table_name = :table AND column_name = :column
    ) AS present
    """
)

_GEOMETRY_METADATA = text(
    """
    SELECT srid, type AS geometry_type
    FROM geometry_columns
    WHERE f_table_schema = :schema
      AND f_table_name = :table
      AND f_geometry_column = :geom
    """
)


async def list_geometry_tables(session: AsyncSession) -> list[GeometryTableInfo]:
    result = await session.execute(_LIST_TABLES, {"hidden": list(HIDDEN_SCHEMAS)})
    rows = result.mappings().all()
    tables: list[GeometryTableInfo] = []
    for row in rows:
        primary_key = await find_primary_key(session, row["schema_name"], row["table_name"])
        tables.append(
            GeometryTableInfo(
                schema_name=row["schema_name"],
                table_name=row["table_name"],
                geometry_column=row["geometry_column"],
                srid=row["srid"],
                geometry_type=row["geometry_type"],
                primary_key=primary_key,
                estimated_rows=max(int(row["estimated_rows"]), 0),
            )
        )
    return tables


async def find_primary_key(session: AsyncSession, schema: str, table: str) -> str | None:
    result = await session.execute(_PRIMARY_KEY, {"qname": qualified(schema, table)})
    row = result.mappings().one_or_none()
    return None if row is None else str(row["name"])


async def table_exists(session: AsyncSession, schema: str, table: str) -> bool:
    result = await session.execute(_TABLE_EXISTS, {"qname": qualified(schema, table)})
    return bool(result.scalar_one())


async def column_exists(session: AsyncSession, schema: str, table: str, column: str) -> bool:
    result = await session.execute(
        _COLUMN_EXISTS,
        {
            "schema": validate_identifier(schema),
            "table": validate_identifier(table),
            "column": validate_identifier(column),
        },
    )
    return bool(result.scalar_one())


async def list_columns(session: AsyncSession, schema: str, table: str) -> list[ColumnInfo]:
    result = await session.execute(
        _COLUMNS,
        {"schema": validate_identifier(schema), "table": validate_identifier(table)},
    )
    return [ColumnInfo.model_validate(dict(row)) for row in result.mappings().all()]


async def geometry_metadata(session: AsyncSession, source: PostgisSource) -> dict[str, Any] | None:
    """SRID and geometry type as declared in geometry_columns."""
    result = await session.execute(
        _GEOMETRY_METADATA,
        {
            "schema": source.schema_name,
            "table": source.table_name,
            "geom": source.geometry_column,
        },
    )
    row = result.mappings().one_or_none()
    return None if row is None else dict(row)


async def compute_extent_4326(session: AsyncSession, source: PostgisSource) -> list[float] | None:
    """Bounding box in EPSG:4326, or None for an empty / all-null table."""
    sql = text(
        f"""
        SELECT ST_XMin(box) AS minx, ST_YMin(box) AS miny,
               ST_XMax(box) AS maxx, ST_YMax(box) AS maxy
        FROM (
            SELECT ST_Extent(ST_Transform({quote(source.geometry_column)}, 4326)) AS box
            FROM {qualified(source.schema_name, source.table_name)}
        ) AS extent
        """
    )
    row = (await session.execute(sql)).mappings().one()
    if row["minx"] is None:
        return None
    return [float(row["minx"]), float(row["miny"]), float(row["maxx"]), float(row["maxy"])]


async def count_rows(session: AsyncSession, source: PostgisSource) -> int:
    sql = text(f"SELECT count(*) FROM {qualified(source.schema_name, source.table_name)}")
    return int((await session.execute(sql)).scalar_one())
