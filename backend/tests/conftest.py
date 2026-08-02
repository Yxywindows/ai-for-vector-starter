"""Test fixtures.

The suite runs against a real PostGIS database (`gis_platform_test`) because
almost everything interesting here IS SQL. Schema is created once per session
with `create_all`; per-test isolation comes from an outer transaction that is
rolled back, so tests never see each other's rows.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator

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

# Tests drive `task_worker.run_once` directly with their own transactional
# session; the lifespan's polling loop would race them on another engine.
get_settings().task_worker_enabled = False

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
        """Mirror `get_session`'s per-request unit of work for the test session.

        The real `get_session` commits once per request on success and rolls
        back on exception; `db_session` here can't actually commit (its own
        outer transaction has to survive to the next request so cross-request
        reads within one test work at all, and ultimately has to roll back at
        teardown for test isolation). `begin_nested()` gives each request its
        own SAVEPOINT instead: released on success, rolled back to on
        exception -- the same per-request boundary, without an actual COMMIT.
        A bare `yield db_session` (this fixture's first version) had no such
        boundary at all: a statement PostgreSQL rejected left the session
        poisoned for every later request in the same test, and the only way
        to recover it -- a session-wide rollback -- would undo every earlier
        request's work too, not just the failed one. See
        `docs/09-editing-and-transactions.md`.
        """
        async with db_session.begin_nested():
            yield db_session

    app.dependency_overrides[get_session] = _override
    # httpx's ASGITransport does not run the app's lifespan, but /system/memory
    # needs the raster pool the lifespan creates -- drive it manually here.
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as http_client:
            yield http_client
    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def _clean_raster_dir() -> Iterator[None]:
    """Imported COGs land under `settings.raster_dir`, outside the database
    transaction that per-test rollback otherwise handles -- without this,
    every raster-import test would leave a file behind permanently. Only
    files created *during* the test are removed; anything already present
    (e.g. from a previous, non-test run of the app) is left alone."""
    raster_dir = get_settings().raster_dir
    before = set(raster_dir.glob("*")) if raster_dir.exists() else set()
    yield
    if raster_dir.exists():
        for path in set(raster_dir.glob("*")) - before:
            path.unlink(missing_ok=True)


from tests.fixtures.raster import (  # noqa: E402, F401
    sample_geotiff,
    sample_geotiff_all_nodata,
    sample_geotiff_no_crs,
    sample_geotiff_not_a_cog,
)
from tests.fixtures.spatial import seeded_spatial_table  # noqa: E402, F401
