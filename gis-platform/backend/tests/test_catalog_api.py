import pytest
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.layer import Layer
from app.repositories import catalog_repository
from app.schemas.source import PostgisSource


async def test_lists_geometry_tables_including_the_seeded_one(
    client: AsyncClient, seeded_spatial_table: PostgisSource
) -> None:
    response = await client.get("/api/v1/connections/postgis/tables")
    assert response.status_code == 200
    tables = response.json()
    match = next(t for t in tables if t["tableName"] == "test_cities")
    assert match["schemaName"] == "gis_data"
    assert match["geometryColumn"] == "geometry"
    assert match["srid"] == 4326
    assert match["geometryType"] == "POINT"
    assert match["primaryKey"] == "fid"


async def test_catalog_hides_postgis_internal_schemas(client: AsyncClient) -> None:
    tables = (await client.get("/api/v1/connections/postgis/tables")).json()
    assert all(t["schemaName"] not in {"topology", "tiger", "pg_catalog"} for t in tables)


async def test_register_table_creates_a_layer_with_extent_and_count(
    client: AsyncClient, seeded_spatial_table: PostgisSource
) -> None:
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/from-postgis",
        json={
            "schemaName": "gis_data",
            "tableName": "test_cities",
            "geometryColumn": "geometry",
            "idColumn": "fid",
            "name": "Cities",
        },
    )
    assert response.status_code == 201
    layer = response.json()
    assert layer["kind"] == "vector"
    assert layer["srid"] == 4326
    assert layer["featureCount"] == 3
    assert layer["geometryType"] == "POINT"
    minx, miny, maxx, maxy = layer["extent"]
    assert 91.0 < minx < 91.2
    assert 29.6 < miny < 29.7
    assert 121.4 < maxx < 121.5
    assert 39.9 < maxy < 40.0
    assert layer["source"]["type"] == "postgis"


async def test_register_rejects_an_unknown_table(client: AsyncClient) -> None:
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/from-postgis",
        json={
            "schemaName": "gis_data",
            "tableName": "no_such_table",
            "geometryColumn": "geometry",
            "idColumn": "fid",
            "name": "Nope",
        },
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_register_rejects_an_unknown_geometry_column(
    client: AsyncClient, seeded_spatial_table: PostgisSource
) -> None:
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/from-postgis",
        json={
            "schemaName": "gis_data",
            "tableName": "test_cities",
            "geometryColumn": "shape",
            "idColumn": "fid",
            "name": "Nope",
        },
    )
    assert response.status_code == 404
    body = response.json()
    assert body["error"]["code"] == "not_found"
    # Proves verify_source's column check actually ran, not just its table check.
    assert body["error"]["details"]["missing"] == ["shape"]


async def test_register_rejects_an_injection_shaped_name(client: AsyncClient) -> None:
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/from-postgis",
        json={
            "schemaName": "gis_data",
            "tableName": "test_cities; DROP TABLE gis.layer",
            "geometryColumn": "geometry",
            "idColumn": "fid",
            "name": "Evil",
        },
    )
    assert response.status_code == 422
    # And the platform tables are still there.
    assert (await client.get("/api/v1/projects")).status_code == 200


async def test_register_rejects_a_table_with_unknown_srid(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """A column declared plain `geometry(Point)`, with no SRID, is common for
    externally-owned tables this endpoint exists to register — PostGIS
    reports that as SRID 0 ("unknown"), which isn't a real projection and
    can't be transformed to EPSG:4326. `register_table` must reject it with
    a clear 422 instead of raising a raw error inside `ST_Transform` (for a
    non-empty table) or silently persisting an SRID Pydantic would otherwise
    reject on the very next read."""
    await db_session.execute(text("DROP TABLE IF EXISTS gis_data.no_srid_table"))
    await db_session.execute(
        text(
            "CREATE TABLE gis_data.no_srid_table (fid serial PRIMARY KEY, geometry geometry(Point))"
        )
    )
    await db_session.flush()

    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/from-postgis",
        json={
            "schemaName": "gis_data",
            "tableName": "no_srid_table",
            "geometryColumn": "geometry",
            "idColumn": "fid",
            "name": "NoSrid",
        },
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"

    remaining = (await db_session.execute(select(Layer))).scalars().all()
    assert remaining == []


async def test_register_table_is_atomic_when_extent_computation_fails(
    client: AsyncClient,
    seeded_spatial_table: PostgisSource,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`register_table` creates the layer row, then fills in its computed
    stats (extent, feature count). Before this fix, `layer_service.create_layer`
    committed on its own, so a failure after that point (a dropped connection,
    a bad geometry, anything) left a persisted layer with no SRID and no
    extent — unusable, and invisible as broken until something tried to read
    it. `compute_extent_4326` is the natural seam to fail after the layer
    row exists but before the request finishes."""

    async def _boom(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("computing extent failed")

    monkeypatch.setattr(catalog_repository, "compute_extent_4326", _boom)

    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]

    with pytest.raises(RuntimeError, match="computing extent failed"):
        await client.post(
            f"/api/v1/projects/{project_id}/layers/from-postgis",
            json={
                "schemaName": "gis_data",
                "tableName": "test_cities",
                "geometryColumn": "geometry",
                "idColumn": "fid",
                "name": "Cities",
            },
        )

    # The `client` fixture's session override wraps each request in its own
    # `db_session.begin_nested()` (see conftest.py) to mirror `get_session`'s
    # real commit-on-success/rollback-on-exception contract, so the failed
    # `POST .../layers/from-postgis` above was already rolled back to that
    # request's own SAVEPOINT by the time `pytest.raises` caught the
    # RuntimeError — including the layer row `create_layer` had written
    # before `compute_extent_4326` blew up. No explicit rollback is needed
    # here to observe that: if `register_table` were not atomic, the layer
    # row would already be gone from `db_session`'s point of view before
    # this assertion even runs.
    remaining = (await db_session.execute(select(Layer))).scalars().all()
    assert remaining == []
