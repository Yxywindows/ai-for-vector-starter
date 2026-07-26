"""SQL for gis.layer."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.layer import Layer


async def create(session: AsyncSession, **fields: Any) -> Layer:
    layer = Layer(**fields)
    session.add(layer)
    await session.flush()
    await session.refresh(layer)
    return layer


async def get(session: AsyncSession, layer_id: uuid.UUID) -> Layer | None:
    result = await session.execute(select(Layer).where(Layer.id == layer_id))
    return result.scalar_one_or_none()


async def list_for_project(session: AsyncSession, project_id: uuid.UUID) -> list[Layer]:
    result = await session.execute(
        select(Layer).where(Layer.project_id == project_id).order_by(Layer.z_index)
    )
    return list(result.scalars().all())


async def next_z_index(session: AsyncSession, project_id: uuid.UUID) -> int:
    result = await session.execute(
        select(func.coalesce(func.max(Layer.z_index) + 1, 0)).where(Layer.project_id == project_id)
    )
    return int(result.scalar_one())


async def name_exists(session: AsyncSession, project_id: uuid.UUID, name: str) -> bool:
    result = await session.execute(
        select(func.count())
        .select_from(Layer)
        .where(Layer.project_id == project_id, Layer.name == name)
    )
    return int(result.scalar_one()) > 0


async def update(session: AsyncSession, layer: Layer, **fields: Any) -> Layer:
    for key, value in fields.items():
        setattr(layer, key, value)
    await session.flush()
    await session.refresh(layer)
    return layer


async def delete(session: AsyncSession, layer: Layer) -> None:
    await session.delete(layer)
    await session.flush()


async def set_z_indexes(
    session: AsyncSession, project_id: uuid.UUID, ordered_ids: list[uuid.UUID]
) -> None:
    layers = {layer.id: layer for layer in await list_for_project(session, project_id)}
    for position, layer_id in enumerate(ordered_ids):
        layers[layer_id].z_index = position
    await session.flush()
