"""Tests for `get_session`'s own commit/rollback behaviour.

`conftest.py`'s `client` fixture replaces `get_session` for every other test
in the suite, so the per-test transaction rollback stays the isolation
mechanism (see `docs/02-spatial-data-model.md`) — which also means nothing
else in the suite ever exercises the real `get_session`. These tests build
their own small, self-contained app and hit the real database directly
through the real dependency, cleaning up after themselves with a dedicated
scratch table, instead of touching the shared fixtures at all.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import register_exception_handlers
from app.db.session import SessionDep, engine
from app.main import create_app
from app.services import edit_service

_PROBE_TABLE = "gis.get_session_probe"


@pytest.fixture(autouse=True)
async def _probe_table() -> AsyncIterator[None]:
    async with engine.begin() as conn:
        await conn.execute(text(f"DROP TABLE IF EXISTS {_PROBE_TABLE}"))
        await conn.execute(
            text(f"CREATE TABLE {_PROBE_TABLE} (id serial PRIMARY KEY, label text NOT NULL)")
        )
    try:
        yield
    finally:
        async with engine.begin() as conn:
            await conn.execute(text(f"DROP TABLE IF EXISTS {_PROBE_TABLE}"))


async def _probe_row_count() -> int:
    """A brand new connection, separate from anything a request used — this
    only returns > 0 if a row was genuinely committed, not merely flushed
    within some other still-open session."""
    async with engine.connect() as conn:
        result = await conn.execute(text(f"SELECT count(*) FROM {_PROBE_TABLE}"))
        return int(result.scalar_one())


def _build_app() -> FastAPI:
    app = FastAPI()
    register_exception_handlers(app)

    @app.post("/insert")
    async def insert(session: SessionDep) -> dict[str, str]:
        await session.execute(text(f"INSERT INTO {_PROBE_TABLE} (label) VALUES ('ok')"))
        return {"status": "inserted"}

    @app.post("/insert-then-raise")
    async def insert_then_raise(session: SessionDep) -> None:
        await session.execute(text(f"INSERT INTO {_PROBE_TABLE} (label) VALUES ('boom')"))
        raise RuntimeError("endpoint failed")

    return app


async def test_get_session_commits_on_the_success_path() -> None:
    app = _build_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/insert")
    assert response.status_code == 200
    assert await _probe_row_count() == 1


async def test_get_session_rolls_back_when_the_endpoint_raises() -> None:
    app = _build_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        with pytest.raises(RuntimeError, match="endpoint failed"):
            await client.post("/insert-then-raise")
    assert await _probe_row_count() == 0


async def test_a_commit_failure_becomes_a_500_envelope_not_a_silent_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The regression test for the `scope="function"` fix. Before it, a
    generator dependency's teardown (where `get_session` commits) ran
    *after* FastAPI had already sent the response to the client — so a
    `commit()` failure there could never change what the client received;
    the caller had already been told the request succeeded. `scope=
    "function"` moves that teardown to before the send, so a raising commit
    now reaches `ServerErrorMiddleware` while `response_started` is still
    False and becomes a real 500 in the error envelope instead.

    `raise_app_exceptions=False` (httpx's equivalent of Starlette
    TestClient's `raise_server_exceptions=False`, used the same way by
    `tests/test_errors.py`) is required here specifically so the assertions
    can inspect the *response the client actually received* rather than the
    exception that keeps propagating server-side for logging — same as
    every other endpoint in this suite, that exception is not this test's
    concern; what the client received is.
    """

    async def _boom_on_commit(self: AsyncSession) -> None:
        raise RuntimeError("commit failed")

    monkeypatch.setattr(AsyncSession, "commit", _boom_on_commit)

    app = _build_app()
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/insert")

    assert response.status_code == 500
    assert response.json() == {
        "error": {"code": "internal_error", "message": "Internal server error", "details": None}
    }
    # And the row the handler inserted was never actually committed.
    assert await _probe_row_count() == 0


async def test_an_unhandled_error_after_a_write_rolls_back_that_write(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The same guarantee as the two tests above, exercised through the real
    editing routes rather than a synthetic app.

    Every test in `tests/test_editing_api.py` goes through `conftest.py`'s
    `client` fixture, which replaces `get_session` with a test-only override
    (a SAVEPOINT per request on a shared, never-committed session -- see
    that fixture's docstring and `docs/09-editing-and-transactions.md`) so
    that per-test isolation works. That override was written to imitate
    `get_session`'s commit-on-success/rollback-on-exception contract, but
    imitating it is not the same as exercising the real thing: nothing in
    this codebase's editing test suite ever runs a write through the actual
    `get_session`. This test does -- real app, real routes, real database,
    no override -- and checks that a completely unrelated failure (a bug in
    building the response, well after `edit_service.create_feature`'s
    INSERT has already executed) still leaves the row unwritten.
    """
    table = 'gis_data."test_session_rollback_probe"'
    async with engine.begin() as conn:
        await conn.execute(text(f"DROP TABLE IF EXISTS {table}"))
        await conn.execute(
            text(
                f"CREATE TABLE {table} "
                "(fid serial PRIMARY KEY, name text NOT NULL, geometry geometry(Point, 4326))"
            )
        )

    app = create_app()
    project_id: str | None = None
    try:
        async with app.router.lifespan_context(app):
            transport = ASGITransport(app=app, raise_app_exceptions=False)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                project_id = (
                    await client.post("/api/v1/projects", json={"name": "rollback-probe"})
                ).json()["id"]
                layer = (
                    await client.post(
                        f"/api/v1/projects/{project_id}/layers/from-postgis",
                        json={
                            "schemaName": "gis_data",
                            "tableName": "test_session_rollback_probe",
                            "geometryColumn": "geometry",
                            "idColumn": "fid",
                            "name": "Probe",
                        },
                    )
                ).json()

                def _boom(*args: object, **kwargs: object) -> None:
                    raise RuntimeError("response construction failed")

                # The INSERT inside `edit_service.create_feature` has already
                # executed by the time this fires -- `Feature(...)` is the
                # very last statement in that function.
                monkeypatch.setattr(edit_service, "Feature", _boom)

                response = await client.post(
                    f"/api/v1/layers/{layer['id']}/features",
                    json={
                        "geometry": {"type": "Point", "coordinates": [1, 1]},
                        "properties": {"name": "should not survive"},
                    },
                )
        assert response.status_code == 500

        async with engine.connect() as conn:
            count = (await conn.execute(text(f"SELECT count(*) FROM {table}"))).scalar_one()
        assert count == 0
    finally:
        if project_id is not None:
            async with engine.begin() as conn:
                await conn.execute(
                    text("DELETE FROM gis.project WHERE id = :id"), {"id": project_id}
                )
        async with engine.begin() as conn:
            await conn.execute(text(f"DROP TABLE IF EXISTS {table}"))
