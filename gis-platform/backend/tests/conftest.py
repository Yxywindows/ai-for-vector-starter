"""Test fixtures.

The suite runs against a real PostGIS database (`gis_platform_test`) because
almost everything interesting here IS SQL. Schema is created once per session
with `create_all`; per-test isolation comes from an outer transaction that is
rolled back, so tests never see each other's rows.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, AsyncSession, create_async_engine

from app.core.config import get_settings
from app.db.base import Base
from app.db.session import get_session
from app.main import create_app

TEST_DATABASE_URL = get_settings().database_url

if not TEST_DATABASE_URL.endswith("/gis_platform_test"):
    raise RuntimeError(
        "Refusing to run the suite against a non-test database. "
        "Export GIS_DATABASE_URL=postgresql+asyncpg://gis:gis@localhost:5401/gis_platform_test"
    )


@pytest.fixture(scope="session")
def anyio_backend() -> str:
    return "asyncio"


@pytest_asyncio.fixture(scope="session")
async def engine() -> AsyncIterator[AsyncEngine]:
    import app.models  # noqa: F401  -- registers mappers on Base.metadata

    test_engine = create_async_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    settings = get_settings()
    async with test_engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
        await conn.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{settings.metadata_schema}"'))
        await conn.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{settings.import_schema}"'))
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    yield test_engine
    await test_engine.dispose()


@pytest_asyncio.fixture
async def db_connection(engine: AsyncEngine) -> AsyncIterator[AsyncConnection]:
    connection = await engine.connect()
    transaction = await connection.begin()
    try:
        yield connection
    finally:
        await transaction.rollback()
        await connection.close()


@pytest_asyncio.fixture
async def db_session(db_connection: AsyncConnection) -> AsyncIterator[AsyncSession]:
    session = AsyncSession(
        bind=db_connection, expire_on_commit=False, join_transaction_mode="create_savepoint"
    )
    try:
        yield session
    finally:
        await session.close()


@pytest_asyncio.fixture
async def client(db_session: AsyncSession) -> AsyncIterator[AsyncClient]:
    app = create_app()

    async def _override() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = _override
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http_client:
        yield http_client
    app.dependency_overrides.clear()


from tests.fixtures.spatial import seeded_spatial_table  # noqa: E402, F401
