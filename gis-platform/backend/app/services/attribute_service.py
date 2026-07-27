from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import InvalidRequestError
from app.repositories import catalog_repository, feature_repository
from app.schemas.attribute import AttributeFilter, AttributePage, FieldList
from app.schemas.source import PostgisSource
from app.services import catalog_service, layer_service


async def _verified_source(session: AsyncSession, layer_id: uuid.UUID) -> PostgisSource:
    layer = await layer_service.get_layer_or_404(session, layer_id)
    source = layer_service.require_postgis_source(layer)
    await catalog_service.verify_source(session, source)
    return source


async def get_fields(session: AsyncSession, layer_id: uuid.UUID) -> FieldList:
    source = await _verified_source(session, layer_id)
    all_columns = await catalog_repository.list_columns(
        session, source.schema_name, source.table_name
    )
    return FieldList(
        fields=[column for column in all_columns if column.name != source.geometry_column],
        id_column=source.id_column,
        geometry_column=source.geometry_column,
    )


async def get_page(
    session: AsyncSession,
    layer_id: uuid.UUID,
    page: int,
    page_size: int,
    sort_by: str | None,
    sort_order: str,
    filters_raw: str | None,
) -> AttributePage:
    source = await _verified_source(session, layer_id)
    columns = await feature_repository.attribute_columns(session, source)

    cap = get_settings().attribute_page_max
    if page < 1 or page_size < 1 or page_size > cap:
        raise InvalidRequestError(
            "Invalid paging", details={"page": page, "pageSize": page_size, "maxPageSize": cap}
        )

    effective_sort = sort_by or source.id_column
    if effective_sort not in columns:
        raise InvalidRequestError(
            "Unknown sort column", details={"sortBy": effective_sort, "allowed": columns}
        )
    if sort_order.lower() not in {"asc", "desc"}:
        raise InvalidRequestError(
            "sortOrder must be 'asc' or 'desc'", details={"sortOrder": sort_order}
        )

    filters = AttributeFilter.parse_list(filters_raw)
    rows, total = await feature_repository.read_attribute_page(
        session, source, columns, filters, effective_sort, sort_order, page, page_size
    )
    return AttributePage(columns=columns, rows=rows, page=page, page_size=page_size, total=total)
