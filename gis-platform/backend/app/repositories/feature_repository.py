"""Reads of feature geometry and attributes from an arbitrary PostGIS table.

Two deliberate choices:

* `&&` (bounding-box overlap) rather than `ST_Intersects`. A viewport query
  wants "might be visible", and `&&` is answered directly from the GIST
  index without an exact geometry test. Fetching a handful of extra features
  at the tile edge costs far less than an exact intersection over the table.
* The envelope is transformed into the table's SRID, not the geometry into
  4326. Transforming the geometry would make the index unusable.
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import InvalidRequestError
from app.db.identifiers import qualified, quote, quote_list, validate_identifier
from app.repositories import catalog_repository
from app.schemas.attribute import OPERATOR_SQL, VALUELESS_OPS, AttributeFilter
from app.schemas.feature import BBox
from app.schemas.source import PostgisSource


async def attribute_columns(session: AsyncSession, source: PostgisSource) -> list[str]:
    columns = await catalog_repository.list_columns(session, source.schema_name, source.table_name)
    return [column.name for column in columns if column.name != source.geometry_column]


async def read_in_bbox(
    session: AsyncSession, source: PostgisSource, bbox: BBox, limit: int
) -> list[dict[str, Any]]:
    geom = quote(source.geometry_column)
    fid = quote(source.id_column)
    table = qualified(source.schema_name, source.table_name)

    sql = text(
        f"""
        SELECT t.{fid}::text AS fid,
               ST_AsGeoJSON(ST_Transform(t.{geom}, 4326)) AS geometry,
               to_jsonb(t) - :geom_key - :id_key AS properties
        FROM {table} AS t
        WHERE t.{geom} && ST_Transform(
                  ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326), CAST(:srid AS integer)
              )
        ORDER BY t.{fid}
        LIMIT :limit
        """
    )
    params: dict[str, Any] = {
        **bbox.as_params,
        "srid": source.srid,
        "geom_key": source.geometry_column,
        "id_key": source.id_column,
        "limit": limit + 1,  # one extra row is how truncation is detected
    }
    rows = (await session.execute(sql, params)).mappings().all()
    return [
        {
            "fid": row["fid"],
            "geometry": json.loads(row["geometry"]) if row["geometry"] else None,
            "properties": dict(row["properties"] or {}),
        }
        for row in rows
    ]


def build_where(filters: list[AttributeFilter], allowed: set[str]) -> tuple[str, dict[str, Any]]:
    """Compose a WHERE clause from validated fields and bound values.

    The field name is validated twice — against the set of columns that
    actually exist on this table, and against the identifier allowlist
    regex (via `quote`/`validate_identifier`) when it is spliced into the
    clause — and the operator can only be one of the fixed keys of
    OPERATOR_SQL. The value is always a bind parameter, never text.
    """
    clauses: list[str] = []
    params: dict[str, Any] = {}
    for index, item in enumerate(filters):
        if item.field not in allowed:
            raise InvalidRequestError(
                "Unknown filter field",
                details={"field": item.field, "allowed": sorted(allowed)},
            )
        template = OPERATOR_SQL[item.op]
        placeholder = f"f{index}"
        clauses.append(template.format(col=quote(validate_identifier(item.field)), p=placeholder))
        if item.op not in VALUELESS_OPS:
            if item.op == "in":
                if not isinstance(item.value, list) or not item.value:
                    raise InvalidRequestError(
                        "The 'in' operator needs a non-empty list",
                        details={"field": item.field},
                    )
                # The template casts the column to text (see OPERATOR_SQL),
                # so the bound array must be text too, for every column type.
                params[placeholder] = [str(v) for v in item.value]
            else:
                params[placeholder] = item.value
    return (" AND ".join(clauses) if clauses else "TRUE"), params


async def read_attribute_page(
    session: AsyncSession,
    source: PostgisSource,
    columns: list[str],
    filters: list[AttributeFilter],
    sort_by: str,
    sort_order: str,
    page: int,
    page_size: int,
) -> tuple[list[dict[str, Any]], int]:
    table = qualified(source.schema_name, source.table_name)
    where, params = build_where(filters, set(columns))
    direction = "DESC" if sort_order.lower() == "desc" else "ASC"
    order = f"{quote(validate_identifier(sort_by))} {direction}"

    total = int(
        (
            await session.execute(text(f"SELECT count(*) FROM {table} WHERE {where}"), params)
        ).scalar_one()
    )
    rows = (
        (
            await session.execute(
                text(
                    f"""
                SELECT {quote_list(columns)}
                FROM {table}
                WHERE {where}
                ORDER BY {order}, {quote(source.id_column)} ASC
                LIMIT :limit OFFSET :offset
                """
                ),
                {**params, "limit": page_size, "offset": (page - 1) * page_size},
            )
        )
        .mappings()
        .all()
    )
    return [dict(row) for row in rows], total
