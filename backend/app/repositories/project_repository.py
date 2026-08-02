"""SQL for gis.project. No business rules live here."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.layer import Layer
from app.models.project import Project


async def create(session: AsyncSession, *, name: str, view: dict[str, Any]) -> Project:
    project = Project(name=name, view=view)
    session.add(project)
    await session.flush()
    await session.refresh(project)
    return project


async def get(session: AsyncSession, project_id: uuid.UUID) -> Project | None:
    result = await session.execute(select(Project).where(Project.id == project_id))
    return result.scalar_one_or_none()


async def list_summaries(session: AsyncSession) -> list[tuple[Project, int]]:
    stmt = (
        select(Project, func.count(Layer.id))
        .outerjoin(Layer, Layer.project_id == Project.id)
        .group_by(Project.id)
        .order_by(Project.created_at)
    )
    result = await session.execute(stmt)
    return [(project, count) for project, count in result.all()]


async def update(session: AsyncSession, project: Project, **fields: Any) -> Project:
    for key, value in fields.items():
        setattr(project, key, value)
    await session.flush()
    await session.refresh(project)
    return project


async def delete(session: AsyncSession, project: Project) -> None:
    await session.delete(project)
    await session.flush()
