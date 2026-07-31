"""Reads and writes of feature geometry and attributes on an arbitrary PostGIS table.

Two deliberate choices in the read path:

* `&&` (bounding-box overlap) rather than `ST_Intersects`. A viewport query
  wants "might be visible", and `&&` is answered directly from the GIST
  index without an exact geometry test. Fetching a handful of extra features
  at the tile edge costs far less than an exact intersection over the table.
* The envelope is transformed into the table's SRID, not the geometry into
  4326. Transforming the geometry would make the index unusable.

The write functions (`insert_feature`, `update_feature_row`,
`delete_feature_row`) assume the caller -- `app.services.edit_service` --
has already checked every column name against an allowlist and every
geometry against `ST_IsValid`. Nothing here re-checks that; this module's
job is composing the SQL safely (identifiers validated, values always bind
parameters), not deciding what is editable.
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import InvalidRequestError
from app.db.identifiers import qualified, quote, quote_list_catalog, validate_identifier
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
                params[placeholder] = item.value
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
                SELECT {quote_list_catalog(columns)}
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


GEOMETRY_SQL = (
    "ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(:geojson), 4326), CAST(:srid AS integer))"
)

_INTEGER_TYPES = {"smallint", "integer", "bigint"}


async def _id_column_type(session: AsyncSession, source: PostgisSource) -> str:
    columns = await catalog_repository.list_columns(session, source.schema_name, source.table_name)
    return next(column.data_type for column in columns if column.name == source.id_column)


def _id_predicate(fid: str, data_type: str, alias: str | None = None) -> str:
    """The single-feature id comparison, shaped to keep the primary-key index usable.

    `fid`/`alias` are already-quoted SQL fragments (`quote(...)`); `:fid` is
    always bound as a Python `str` -- every route takes `feature_id: str`.
    Casting the *column* (`{fid}::text = :fid`, this module's first
    version) turns the predicate into a function of the column: a plain
    btree index on `fid` was built on the column's real values, not their
    text representation, so Postgres cannot use it to answer a predicate
    shaped like that -- every single-feature `PATCH`/`DELETE` became a
    sequential scan. Casting the *parameter* instead leaves the column bare
    on the left, so the index built on exactly that column stays usable --
    the same principle documented for the bbox predicate in
    `04-feature-streaming.md` (transform the one side that is cheap to
    transform, never the indexed column).

    For a numeric id column (`integer`/`bigint`/`smallint` -- what
    `serial`/`bigserial`/`identity` primary keys actually are), the
    parameter is cast to that type via `CAST(:fid AS text)::<type>`, not the
    more obvious `CAST(:fid AS integer)`. The obvious form fails at
    runtime: `CAST(:fid AS integer)` makes Postgres infer the *parameter
    itself* as `integer`, and asyncpg then rejects the Python `str` that is
    actually bound (`invalid input for query argument: 'str' object cannot
    be interpreted as an integer`) -- casting to `text` first matches what
    is actually bound, and only then converts to the column's type.
    Anything else -- a `text` or `uuid` id column -- is compared with a
    bare `=`: with no overload to disambiguate (unlike `ST_Transform`'s two
    signatures), Postgres infers the parameter's type from the column with
    no cast needed.
    """
    column = f"{alias}.{fid}" if alias else fid
    if data_type in _INTEGER_TYPES:
        return f"{column} = CAST(:fid AS text)::{data_type}"
    return f"{column} = :fid"


RETURNING_SQL = """
    RETURNING {fid}::text AS fid,
              ST_AsGeoJSON(ST_Transform({geom}, 4326)) AS geometry,
              to_jsonb({tbl}) - :geom_key - :id_key AS properties
"""


def _row_to_feature(row: Any) -> dict[str, Any]:
    return {
        "fid": row["fid"],
        "geometry": json.loads(row["geometry"]) if row["geometry"] else None,
        "properties": dict(row["properties"] or {}),
    }


async def geometry_is_valid(session: AsyncSession, geojson: str) -> tuple[bool, str | None]:
    """Ask PostGIS, not Python: it is the thing that will store the geometry."""
    row = (
        (
            await session.execute(
                text(
                    """
                SELECT ST_IsValid(g) AS valid, ST_IsValidReason(g) AS reason
                FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON(:geojson), 4326) AS g) AS parsed
                """
                ),
                {"geojson": geojson},
            )
        )
        .mappings()
        .one()
    )
    return bool(row["valid"]), None if row["valid"] else str(row["reason"])


async def read_one(
    session: AsyncSession, source: PostgisSource, feature_id: str
) -> dict[str, Any] | None:
    geom = quote(source.geometry_column)
    fid = quote(source.id_column)
    table = qualified(source.schema_name, source.table_name)
    predicate = _id_predicate(fid, await _id_column_type(session, source), alias="t")
    row = (
        (
            await session.execute(
                text(
                    f"""
                SELECT t.{fid}::text AS fid,
                       ST_AsGeoJSON(ST_Transform(t.{geom}, 4326)) AS geometry,
                       to_jsonb(t) - :geom_key - :id_key AS properties
                FROM {table} AS t
                WHERE {predicate}
                """
                ),
                {
                    "fid": feature_id,
                    "geom_key": source.geometry_column,
                    "id_key": source.id_column,
                },
            )
        )
        .mappings()
        .one_or_none()
    )
    return None if row is None else _row_to_feature(row)


async def insert_feature(
    session: AsyncSession,
    source: PostgisSource,
    geojson: str,
    properties: dict[str, Any],
) -> dict[str, Any]:
    geom = quote(source.geometry_column)
    fid = quote(source.id_column)
    table = qualified(source.schema_name, source.table_name)
    alias = quote(source.table_name)

    names = [quote(validate_identifier(key)) for key in properties]
    placeholders = [f":p_{index}" for index in range(len(properties))]
    params: dict[str, Any] = {
        f"p_{index}": value for index, value in enumerate(properties.values())
    }
    params.update(
        {
            "geojson": geojson,
            "srid": source.srid,
            "geom_key": source.geometry_column,
            "id_key": source.id_column,
        }
    )

    columns = ", ".join([*names, geom])
    values = ", ".join([*placeholders, GEOMETRY_SQL])
    returning = RETURNING_SQL.format(fid=fid, geom=geom, tbl=alias)
    row = (
        (
            await session.execute(
                text(f"INSERT INTO {table} AS {alias} ({columns}) VALUES ({values}) {returning}"),
                params,
            )
        )
        .mappings()
        .one()
    )
    return _row_to_feature(row)


async def update_feature_row(
    session: AsyncSession,
    source: PostgisSource,
    feature_id: str,
    geojson: str | None,
    properties: dict[str, Any] | None,
) -> dict[str, Any] | None:
    geom = quote(source.geometry_column)
    fid = quote(source.id_column)
    table = qualified(source.schema_name, source.table_name)
    alias = quote(source.table_name)

    assignments: list[str] = []
    params: dict[str, Any] = {
        "fid": feature_id,
        "srid": source.srid,
        "geom_key": source.geometry_column,
        "id_key": source.id_column,
    }
    for index, (key, value) in enumerate((properties or {}).items()):
        assignments.append(f"{quote(validate_identifier(key))} = :p_{index}")
        params[f"p_{index}"] = value
    if geojson is not None:
        assignments.append(f"{geom} = {GEOMETRY_SQL}")
        params["geojson"] = geojson

    predicate = _id_predicate(fid, await _id_column_type(session, source), alias=alias)
    returning = RETURNING_SQL.format(fid=fid, geom=geom, tbl=alias)
    row = (
        (
            await session.execute(
                text(
                    f"UPDATE {table} AS {alias} SET {', '.join(assignments)} "
                    f"WHERE {predicate} {returning}"
                ),
                params,
            )
        )
        .mappings()
        .one_or_none()
    )
    return None if row is None else _row_to_feature(row)


async def delete_feature_row(session: AsyncSession, source: PostgisSource, feature_id: str) -> bool:
    fid = quote(source.id_column)
    table = qualified(source.schema_name, source.table_name)
    predicate = _id_predicate(fid, await _id_column_type(session, source))
    result = await session.execute(
        text(f"DELETE FROM {table} WHERE {predicate} RETURNING 1"), {"fid": feature_id}
    )
    return result.first() is not None
