from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ConflictError, InvalidRequestError, NotFoundError
from app.models.layer import Layer
from app.repositories import layer_repository
from app.schemas.layer import LayerCreate, LayerUpdate
from app.schemas.source import PostgisSource, parse_source
from app.services import project_service


async def get_layer_or_404(session: AsyncSession, layer_id: uuid.UUID) -> Layer:
    layer = await layer_repository.get(session, layer_id)
    if layer is None:
        raise NotFoundError(f"Layer {layer_id} not found", details={"layerId": str(layer_id)})
    return layer


def require_postgis_source(layer: Layer) -> PostgisSource:
    """Feature reads, attribute tables, MVT and editing all need a real table."""
    source = parse_source(layer.source)
    if not isinstance(source, PostgisSource):
        raise InvalidRequestError(
            f"Layer {layer.id} is not backed by a PostGIS table",
            details={"layerId": str(layer.id), "sourceType": source.type},
        )
    return source


async def create_layer(session: AsyncSession, project_id: uuid.UUID, payload: LayerCreate) -> Layer:
    await project_service.get_or_404(session, project_id)
    if await layer_repository.name_exists(session, project_id, payload.name):
        raise ConflictError(
            f"A layer named {payload.name!r} already exists in this project",
            details={"name": payload.name},
        )
    layer = await layer_repository.create(
        session,
        project_id=project_id,
        name=payload.name,
        kind=payload.kind,
        source=payload.source.model_dump(by_alias=True),
        style=payload.style.model_dump(by_alias=True) if payload.style else {},
        visible=payload.visible,
        opacity=payload.opacity,
        z_index=await layer_repository.next_z_index(session, project_id),
    )
    await session.commit()
    await session.refresh(layer)
    return layer


async def update_layer(session: AsyncSession, layer_id: uuid.UUID, payload: LayerUpdate) -> Layer:
    layer = await get_layer_or_404(session, layer_id)
    fields: dict[str, object] = {}
    if payload.name is not None and payload.name != layer.name:
        if await layer_repository.name_exists(session, layer.project_id, payload.name):
            raise ConflictError(
                f"A layer named {payload.name!r} already exists in this project",
                details={"name": payload.name},
            )
        fields["name"] = payload.name
    if payload.style is not None:
        fields["style"] = payload.style.model_dump(by_alias=True)
    if payload.visible is not None:
        fields["visible"] = payload.visible
    if payload.opacity is not None:
        fields["opacity"] = payload.opacity

    layer = await layer_repository.update(session, layer, **fields)
    await session.commit()
    await session.refresh(layer)
    return layer


async def delete_layer(session: AsyncSession, layer_id: uuid.UUID) -> None:
    layer = await get_layer_or_404(session, layer_id)
    await layer_repository.delete(session, layer)
    await session.commit()


async def reorder(
    session: AsyncSession, project_id: uuid.UUID, layer_ids: list[uuid.UUID]
) -> list[Layer]:
    await project_service.get_or_404(session, project_id)
    existing = {layer.id for layer in await layer_repository.list_for_project(session, project_id)}
    requested = set(layer_ids)
    if existing != requested or len(layer_ids) != len(requested):
        raise InvalidRequestError(
            "layerIds must list every layer in the project exactly once",
            details={
                "missing": sorted(str(i) for i in existing - requested),
                "unknown": sorted(str(i) for i in requested - existing),
            },
        )
    await layer_repository.set_z_indexes(session, project_id, layer_ids)
    await session.commit()
    return await layer_repository.list_for_project(session, project_id)
