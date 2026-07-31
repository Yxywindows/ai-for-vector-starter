"""Vector tile generation inside PostGIS.

`ST_AsMVT` is an aggregate: it consumes a row set whose geometry column has
already been clipped to the tile by `ST_AsMVTGeom`, and emits one protobuf
blob. Doing this in the database rather than in Python means the geometry
never leaves Postgres as GeoJSON text — for a dense layer that is the
difference between kilobytes and megabytes per tile.

Attribute columns are expanded explicitly rather than passed as one jsonb
value, because `ST_AsMVT` maps each *column* to an MVT attribute; a single
jsonb column would arrive in the client as one opaque string.
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.identifiers import qualified, quote, quote_catalog_name
from app.schemas.source import PostgisSource

MVT_EXTENT = 4096
MVT_BUFFER = 64


async def render_mvt(
    session: AsyncSession,
    source: PostgisSource,
    columns: list[str],
    z: int,
    x: int,
    y: int,
    layer_name: str,
) -> bytes:
    geom = quote(source.geometry_column)
    fid = quote(source.id_column)
    table = qualified(source.schema_name, source.table_name)
    # `columns` is `feature_repository.attribute_columns(session, source)` --
    # names read back from `information_schema` for a table already resolved
    # via `catalog_service.verify_source`, the same catalog trust boundary as
    # `read_attribute_page`'s SELECT list. `quote_catalog_name` (not
    # `validate_identifier`) is correct here for the same reason.
    attribute_select = "".join(
        f", t.{quote_catalog_name(column)}" for column in columns if column != source.id_column
    )

    # The `&&` predicate transforms the tile envelope into the table's SRID,
    # never `t.{geom}` itself — same trick, same reason, as
    # `feature_repository.read_in_bbox`: wrapping the geometry column in
    # ST_Transform makes the GIST index unusable. `CAST(:srid AS integer)`
    # is required, not decorative: ST_Transform is overloaded on
    # (geometry, integer) and (geometry, text), and a bare `:srid` bind lets
    # asyncpg's parameter-type inference pick the wrong overload.
    #
    # `fid` is selected and carried through as a plain attribute, not as
    # `ST_AsMVT`'s optional `feature_id_name` argument. That argument (the
    # protobuf feature id, not a regular attribute) requires the source
    # column to be int2/int4/int8 -- confirmed against live PostGIS, which
    # raises `mvt_agg_transfn: Could not find column 'fid' of integer type`
    # the moment `fid` is cast to text and then named there. `id_column` is
    # not guaranteed to be an integer type for every PostGIS layer (it could
    # be a text or uuid primary key), so `fid` rides as an ordinary
    # attribute instead -- identical treatment to every other column, and
    # still enough for the frontend to identify a clicked feature.
    sql = text(
        f"""
        WITH bounds AS (
            SELECT ST_TileEnvelope(:z, :x, :y) AS envelope_3857
        ),
        clipped AS (
            SELECT ST_AsMVTGeom(
                       ST_Transform(t.{geom}, 3857),
                       bounds.envelope_3857,
                       :extent, :buffer, true
                   ) AS geom,
                   t.{fid}::text AS fid
                   {attribute_select}
            FROM {table} AS t, bounds
            WHERE t.{geom} && ST_Transform(bounds.envelope_3857, CAST(:srid AS integer))
        )
        SELECT COALESCE(ST_AsMVT(clipped, :layer_name, :extent, 'geom'), ''::bytea)
        FROM clipped
        WHERE geom IS NOT NULL
        """
    )
    result = await session.execute(
        sql,
        {
            "z": z,
            "x": x,
            "y": y,
            "extent": MVT_EXTENT,
            "buffer": MVT_BUFFER,
            "srid": source.srid,
            "layer_name": layer_name,
        },
    )
    blob = result.scalar_one_or_none()
    return bytes(blob) if blob else b""
