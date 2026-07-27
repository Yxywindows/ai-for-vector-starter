"""Write path for features.

Three guards stand between a request body and an UPDATE statement:

1. The column must be in `editable_columns` — not the primary key, not the
   geometry column, not a generated or identity column.
2. The column name must pass `validate_identifier` on the way into SQL.
3. The geometry must survive `ST_GeomFromGeoJSON` and `ST_IsValid` before
   anything is written.

Each request is one transaction, managed entirely by
`app.db.session.get_session` -- this module never calls `session.commit()`
or `session.rollback()`. Every error path below raises immediately after
the statement that failed, so nothing else runs on this session before the
request boundary rolls the whole thing back; there is no partial state
for this module to clean up itself.

A statement PostgreSQL rejects can surface as more than one SQLAlchemy
exception type. `IntegrityError` covers constraint violations (`NOT NULL`,
a foreign key) and gets its own message below. Everything else PostgreSQL
can reject a statement for -- a GeoJSON type PostGIS's parser refuses, a
geometry whose type doesn't match the column's typmod (a Polygon into a
`geometry(Point, 4326)` column), a value that doesn't cast to the target
column's type -- is caught via `DBAPIError`, the common base every
DBAPI-level error inherits from. This matters concretely with the asyncpg
dialect: its SQLAlchemy translation table has no entry for `DataError`, so
SQLSTATE class 22 errors (numeric/text conversion failures, the typmod
mismatch above) surface as a bare `DBAPIError`, not `DataError` -- catching
only `(IntegrityError, DataError)`, as an earlier version of this module
did, leaves that whole class of ordinary, client-triggerable input errors
unhandled and returning 500.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import InvalidRequestError, NotFoundError
from app.repositories import catalog_repository, feature_repository
from app.schemas.feature import Feature, FeaturePatch, FeatureWrite
from app.schemas.source import PostgisSource
from app.services import catalog_service, layer_service


async def editable_columns(session: AsyncSession, source: PostgisSource) -> set[str]:
    columns = await catalog_repository.list_columns(session, source.schema_name, source.table_name)
    return {
        column.name
        for column in columns
        if column.editable
        and column.name != source.geometry_column
        and column.name != source.id_column
    }


def _reject_unwritable(properties: dict[str, Any], allowed: set[str]) -> None:
    offending = sorted(set(properties) - allowed)
    if offending:
        raise InvalidRequestError(
            "One or more properties are not writable on this layer",
            details={"rejected": offending, "editable": sorted(allowed)},
        )


async def _validated_geojson(session: AsyncSession, geometry: dict[str, Any] | None) -> str | None:
    if geometry is None:
        return None
    payload = json.dumps(geometry)
    try:
        valid, reason = await feature_repository.geometry_is_valid(session, payload)
    except DBAPIError as exc:
        raise InvalidRequestError(
            "Geometry could not be parsed as GeoJSON",
            details={"reason": str(exc.orig)[:300] if exc.orig else None},
        ) from exc
    if not valid:
        raise InvalidRequestError("Geometry is not valid", details={"reason": reason})
    return payload


async def _resolve(session: AsyncSession, layer_id: uuid.UUID) -> PostgisSource:
    layer = await layer_service.get_layer_or_404(session, layer_id)
    source = layer_service.require_postgis_source(layer)
    await catalog_service.verify_source(session, source)
    return source


async def create_feature(
    session: AsyncSession, layer_id: uuid.UUID, payload: FeatureWrite
) -> Feature:
    source = await _resolve(session, layer_id)
    allowed = await editable_columns(session, source)
    _reject_unwritable(payload.properties, allowed)
    geojson = await _validated_geojson(session, payload.geometry)
    assert geojson is not None  # geometry is required on create

    try:
        row = await feature_repository.insert_feature(session, source, geojson, payload.properties)
    except IntegrityError as exc:
        raise InvalidRequestError(
            "Insert violates a table constraint",
            details={"reason": str(exc.orig)[:300] if exc.orig else None},
        ) from exc
    except DBAPIError as exc:
        raise InvalidRequestError(
            "Insert rejected by the database",
            details={"reason": str(exc.orig)[:300] if exc.orig else None},
        ) from exc
    return Feature(id=row["fid"], geometry=row["geometry"], properties=row["properties"])


async def update_feature(
    session: AsyncSession, layer_id: uuid.UUID, feature_id: str, payload: FeaturePatch
) -> Feature:
    if payload.geometry is None and not payload.properties:
        raise InvalidRequestError("Provide 'geometry', 'properties', or both")

    source = await _resolve(session, layer_id)
    allowed = await editable_columns(session, source)
    if payload.properties:
        _reject_unwritable(payload.properties, allowed)
    geojson = await _validated_geojson(session, payload.geometry)

    try:
        row = await feature_repository.update_feature_row(
            session, source, feature_id, geojson, payload.properties
        )
    except IntegrityError as exc:
        raise InvalidRequestError(
            "Update violates a table constraint",
            details={"reason": str(exc.orig)[:300] if exc.orig else None},
        ) from exc
    except DBAPIError as exc:
        raise InvalidRequestError(
            "Update rejected by the database",
            details={"reason": str(exc.orig)[:300] if exc.orig else None},
        ) from exc
    if row is None:
        raise NotFoundError(
            f"Feature {feature_id} not found",
            details={"layerId": str(layer_id), "featureId": feature_id},
        )
    return Feature(id=row["fid"], geometry=row["geometry"], properties=row["properties"])


async def delete_feature(session: AsyncSession, layer_id: uuid.UUID, feature_id: str) -> None:
    source = await _resolve(session, layer_id)
    try:
        deleted = await feature_repository.delete_feature_row(session, source, feature_id)
    except IntegrityError as exc:
        raise InvalidRequestError(
            "Delete blocked by a table constraint",
            details={"reason": str(exc.orig)[:300] if exc.orig else None},
        ) from exc
    except DBAPIError as exc:
        raise InvalidRequestError(
            "Delete rejected by the database",
            details={"reason": str(exc.orig)[:300] if exc.orig else None},
        ) from exc
    if not deleted:
        raise NotFoundError(
            f"Feature {feature_id} not found",
            details={"layerId": str(layer_id), "featureId": feature_id},
        )
