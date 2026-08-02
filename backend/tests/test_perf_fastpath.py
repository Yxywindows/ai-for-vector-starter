"""Phase-1 fast-path behavior: snapshot cache, tile LRU, estimated counts,
and the simplify/precision parameters.

Each test clears the in-process caches first — they are keyed by
(layer_id, updated_at) so cross-test staleness is impossible, but counting
assertions need a known-cold start.
"""

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.repositories import tile_repository
from app.schemas.source import PostgisSource
from app.services import catalog_service, source_snapshot, tile_service


@pytest.fixture
async def cities_layer(client: AsyncClient, seeded_spatial_table: PostgisSource) -> dict:
    project_id = (await client.post("/api/v1/projects", json={"name": "Perf"})).json()["id"]
    return (
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
    ).json()


@pytest.fixture(autouse=True)
def cold_caches():
    source_snapshot.clear()
    tile_service.clear_tile_cache()
    yield
    source_snapshot.clear()
    tile_service.clear_tile_cache()


async def test_snapshot_verifies_the_source_once_across_tiles(
    client: AsyncClient, cities_layer: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = 0
    real_verify = catalog_service.verify_source

    async def counting_verify(session, source):  # type: ignore[no-untyped-def]
        nonlocal calls
        calls += 1
        return await real_verify(session, source)

    monkeypatch.setattr(catalog_service, "verify_source", counting_verify)

    # Two *different* tiles: the second must be answered from the source
    # snapshot, not a fresh catalog round-trip.
    first = await client.get(f"/api/v1/layers/{cities_layer['id']}/tiles/2/3/1.mvt")
    second = await client.get(f"/api/v1/layers/{cities_layer['id']}/tiles/2/0/1.mvt")
    assert first.status_code in (200, 204)
    assert second.status_code in (200, 204)
    assert calls == 1


async def test_repeated_tile_is_served_from_the_lru_without_rendering(
    client: AsyncClient, cities_layer: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    renders = 0
    real_render = tile_repository.render_mvt

    async def counting_render(*args, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal renders
        renders += 1
        return await real_render(*args, **kwargs)

    monkeypatch.setattr(tile_repository, "render_mvt", counting_render)

    first = await client.get(f"/api/v1/layers/{cities_layer['id']}/tiles/2/3/1.mvt")
    second = await client.get(f"/api/v1/layers/{cities_layer['id']}/tiles/2/3/1.mvt")
    assert first.status_code == 200
    assert second.status_code == 200
    assert second.content == first.content
    assert renders == 1


async def test_layer_update_invalidates_the_tile_cache(
    client: AsyncClient,
    cities_layer: dict,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    renders = 0
    real_render = tile_repository.render_mvt

    async def counting_render(*args, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal renders
        renders += 1
        return await real_render(*args, **kwargs)

    monkeypatch.setattr(tile_repository, "render_mvt", counting_render)

    await client.get(f"/api/v1/layers/{cities_layer['id']}/tiles/2/3/1.mvt")
    # A real PATCH moves updated_at via now(), but the whole test runs in one
    # wrapping transaction where now() is frozen at transaction start --
    # clock_timestamp() is what a separate production transaction would see.
    await db_session.execute(
        text("UPDATE gis.layer SET updated_at = clock_timestamp() WHERE id = :id"),
        {"id": cities_layer["id"]},
    )
    await client.get(f"/api/v1/layers/{cities_layer['id']}/tiles/2/3/1.mvt")
    # updated_at moved, so the old key is unreachable: a fresh render.
    assert renders == 2


async def test_unfiltered_total_uses_the_planner_estimate_after_analyze(
    client: AsyncClient,
    cities_layer: dict,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The estimate path only engages above a size threshold; lower it so a
    # three-row fixture exercises it.
    monkeypatch.setattr(get_settings(), "attribute_count_estimate_min", 1)
    await db_session.execute(text("ANALYZE gis_data.test_cities"))

    body = (await client.get(f"/api/v1/layers/{cities_layer['id']}/attributes")).json()
    assert body["total"] == 3
    assert body["totalEstimated"] is True

    filtered = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/attributes",
            params={"filters": '[{"field": "population", "op": "gt", "value": 1000000}]'},
        )
    ).json()
    assert filtered["total"] == 2
    assert filtered["totalEstimated"] is False


async def test_never_analyzed_table_falls_back_to_the_exact_count(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    # A table with no PK and no index: nothing has ever set reltuples
    # (CREATE INDEX would -- the seeded fixture table gets one, which is why
    # this test builds its own), so it is -1 and the exact count must run.
    await db_session.execute(
        text(
            """
            CREATE TABLE gis_data.test_bare (
                fid integer,
                name text,
                geometry geometry(Point, 4326)
            )
            """
        )
    )
    await db_session.execute(
        text(
            "INSERT INTO gis_data.test_bare VALUES "
            "(1, 'a', ST_SetSRID(ST_MakePoint(0, 0), 4326)), "
            "(2, 'b', ST_SetSRID(ST_MakePoint(1, 1), 4326))"
        )
    )
    await db_session.flush()

    project_id = (await client.post("/api/v1/projects", json={"name": "Bare"})).json()["id"]
    layer = (
        await client.post(
            f"/api/v1/projects/{project_id}/layers/from-postgis",
            json={
                "schemaName": "gis_data",
                "tableName": "test_bare",
                "geometryColumn": "geometry",
                "idColumn": "fid",
                "name": "Bare",
            },
        )
    ).json()

    body = (await client.get(f"/api/v1/layers/{layer['id']}/attributes")).json()
    assert body["total"] == 2
    assert body["totalEstimated"] is False


async def test_precision_caps_coordinate_digits(client: AsyncClient, cities_layer: dict) -> None:
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/features",
            params={"bbox": "-180,-90,180,90", "precision": 2},
        )
    ).json()
    for feature in body["features"]:
        for value in feature["geometry"]["coordinates"]:
            assert value == round(value, 2)


async def test_simplify_parameter_is_accepted_and_returns_valid_geojson(
    client: AsyncClient, cities_layer: dict
) -> None:
    response = await client.get(
        f"/api/v1/layers/{cities_layer['id']}/features",
        params={"bbox": "-180,-90,180,90", "simplify": 0.5},
    )
    assert response.status_code == 200
    body = response.json()
    # Points survive any tolerance; the parameter routes through without error.
    assert body["returned"] == 3
