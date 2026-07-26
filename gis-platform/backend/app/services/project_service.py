from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFoundError
from app.models.project import Project
from app.repositories import project_repository
from app.schemas.project import ProjectCreate, ProjectSummary, ProjectUpdate


async def get_or_404(session: AsyncSession, project_id: uuid.UUID) -> Project:
    project = await project_repository.get(session, project_id)
    if project is None:
        raise NotFoundError(
            f"Project {project_id} not found", details={"projectId": str(project_id)}
        )
    return project


async def create_project(session: AsyncSession, payload: ProjectCreate) -> Project:
    project = await project_repository.create(
        session, name=payload.name, view=payload.view.model_dump(by_alias=True)
    )
    await session.commit()
    await session.refresh(project)
    return project


async def list_projects(session: AsyncSession) -> list[ProjectSummary]:
    rows = await project_repository.list_summaries(session)
    return [
        ProjectSummary(id=project.id, name=project.name, layer_count=count)
        for project, count in rows
    ]


async def update_project(
    session: AsyncSession, project_id: uuid.UUID, payload: ProjectUpdate
) -> Project:
    project = await get_or_404(session, project_id)
    fields: dict[str, object] = {}
    if payload.name is not None:
        fields["name"] = payload.name
    if payload.view is not None:
        fields["view"] = payload.view.model_dump(by_alias=True)
    project = await project_repository.update(session, project, **fields)
    await session.commit()
    await session.refresh(project)
    return project


async def delete_project(session: AsyncSession, project_id: uuid.UUID) -> None:
    project = await get_or_404(session, project_id)
    await project_repository.delete(session, project)
    await session.commit()
