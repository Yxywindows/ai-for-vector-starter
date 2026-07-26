import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.layer import Layer
from app.models.project import Project


async def _project(session: AsyncSession, name: str = "Demo") -> Project:
    project = Project(name=name, view={"center": [0, 0], "zoom": 2})
    session.add(project)
    await session.flush()
    return project


async def test_layer_defaults_are_sane(db_session: AsyncSession) -> None:
    project = await _project(db_session)
    layer = Layer(project_id=project.id, name="Roads", kind="vector", source={"type": "postgis"})
    db_session.add(layer)
    await db_session.flush()

    assert layer.visible is True
    assert layer.opacity == 1.0
    assert layer.z_index == 0
    assert layer.style == {}
    assert layer.extent is None
    assert layer.created_at is not None


async def test_layer_name_is_unique_per_project(db_session: AsyncSession) -> None:
    project = await _project(db_session)
    db_session.add(Layer(project_id=project.id, name="Roads", kind="vector", source={}))
    await db_session.flush()
    db_session.add(Layer(project_id=project.id, name="Roads", kind="vector", source={}))
    with pytest.raises(IntegrityError):
        await db_session.flush()


async def test_same_layer_name_allowed_in_different_projects(db_session: AsyncSession) -> None:
    first = await _project(db_session, "A")
    second = await _project(db_session, "B")
    db_session.add(Layer(project_id=first.id, name="Roads", kind="vector", source={}))
    db_session.add(Layer(project_id=second.id, name="Roads", kind="vector", source={}))
    await db_session.flush()  # must not raise


async def test_deleting_project_cascades_to_layers(db_session: AsyncSession) -> None:
    project = await _project(db_session)
    db_session.add(Layer(project_id=project.id, name="Roads", kind="vector", source={}))
    await db_session.flush()

    await db_session.delete(project)
    await db_session.flush()

    remaining = (await db_session.execute(select(Layer))).scalars().all()
    assert remaining == []


async def test_layer_kind_is_constrained(db_session: AsyncSession) -> None:
    project = await _project(db_session)
    db_session.add(Layer(project_id=project.id, name="Bad", kind="nonsense", source={}))
    with pytest.raises(IntegrityError):
        await db_session.flush()
