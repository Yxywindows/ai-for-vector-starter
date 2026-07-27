from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import InvalidRequestError, NotFoundError
from app.models.layer import Layer
from app.repositories import catalog_repository, layer_repository
from app.schemas.catalog import GeometryTableInfo, RegisterTableRequest
from app.schemas.layer import LayerCreate
from app.schemas.source import PostgisSource
from app.services import layer_service


async def list_tables(session: AsyncSession) -> list[GeometryTableInfo]:
    return await catalog_repository.list_geometry_tables(session)


async def verify_source(session: AsyncSession, source: PostgisSource) -> None:
    """Gate two: the validated names must actually name a real table and columns.

    Called by every service that runs dynamic SQL against a layer's table, so
    a layer whose table was dropped fails with 404 instead of a SQL error.
    """
    if not await catalog_repository.table_exists(session, source.schema_name, source.table_name):
        raise NotFoundError(
            f"Table {source.schema_name}.{source.table_name} does not exist",
            details={"schemaName": source.schema_name, "tableName": source.table_name},
        )
    columns = {
        column.name
        for column in await catalog_repository.list_columns(
            session, source.schema_name, source.table_name
        )
    }
    missing = {source.geometry_column, source.id_column} - columns
    if missing:
        raise NotFoundError(
            "Column not found on table",
            details={
                "schemaName": source.schema_name,
                "tableName": source.table_name,
                "missing": sorted(missing),
            },
        )


async def register_table(
    session: AsyncSession, project_id: uuid.UUID, request: RegisterTableRequest
) -> Layer:
    probe = PostgisSource(
        schema_name=request.schema_name,
        table_name=request.table_name,
        geometry_column=request.geometry_column,
        id_column=request.id_column,
        srid=4326,
    )
    await verify_source(session, probe)

    metadata = await catalog_repository.geometry_metadata(session, probe)
    if metadata is None:
        raise NotFoundError(
            "Column is not registered in geometry_columns",
            details={
                "schemaName": request.schema_name,
                "tableName": request.table_name,
                "geometryColumn": request.geometry_column,
            },
        )

    srid = int(metadata["srid"])
    if srid < 1:
        raise InvalidRequestError(
            f"Table {request.schema_name}.{request.table_name} has an unknown SRID "
            f"({srid}); declare one before registering it.",
            details={
                "schemaName": request.schema_name,
                "tableName": request.table_name,
                "geometryColumn": request.geometry_column,
            },
        )

    # Rebuild rather than `probe.model_copy(update=...)`: model_copy does not
    # re-validate, and PostgisSource.srid requires >= 1 (Field(ge=1)) — the
    # copy would silently carry an SRID Pydantic itself would have rejected.
    source = PostgisSource(
        schema_name=request.schema_name,
        table_name=request.table_name,
        geometry_column=request.geometry_column,
        id_column=request.id_column,
        srid=srid,
    )

    # Create the layer row first, then fill in its computed stats. If the
    # extent/count queries fail after this point, the whole request rolls
    # back as one unit (see `get_session`) — no half-registered layer.
    layer = await layer_service.create_layer(
        session,
        project_id,
        LayerCreate(name=request.name, kind="vector", source=source),
    )

    extent = await catalog_repository.compute_extent_4326(session, source)
    feature_count = await catalog_repository.count_rows(session, source)

    return await layer_repository.update(
        session,
        layer,
        srid=source.srid,
        geometry_type=str(metadata["geometry_type"]),
        extent=extent,
        feature_count=feature_count,
    )
