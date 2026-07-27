import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.source import PostgisSource


@pytest.fixture
async def cities_layer(client: AsyncClient, seeded_spatial_table: PostgisSource) -> dict:
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
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


async def test_bbox_returns_only_intersecting_features(
    client: AsyncClient, cities_layer: dict
) -> None:
    # A box around Lhasa only.
    response = await client.get(
        f"/api/v1/layers/{cities_layer['id']}/features", params={"bbox": "90,29,92,30"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["type"] == "FeatureCollection"
    assert body["returned"] == 1
    assert body["truncated"] is False
    assert [f["properties"]["name"] for f in body["features"]] == ["Lhasa"]


async def test_features_are_geojson_in_4326_without_the_geometry_column_in_properties(
    client: AsyncClient, cities_layer: dict
) -> None:
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/features", params={"bbox": "-180,-90,180,90"}
        )
    ).json()
    feature = next(f for f in body["features"] if f["properties"]["name"] == "Beijing")
    assert feature["geometry"]["type"] == "Point"
    assert feature["geometry"]["coordinates"] == pytest.approx([116.4074, 39.9042], abs=1e-4)
    assert "geometry" not in feature["properties"]
    assert "fid" not in feature["properties"]
    assert feature["id"] == "1"
    assert feature["properties"]["population"] == 21540000


async def test_limit_is_honoured_and_truncation_is_reported(
    client: AsyncClient, cities_layer: dict
) -> None:
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/features",
            params={"bbox": "-180,-90,180,90", "limit": 2},
        )
    ).json()
    assert body["returned"] == 2
    assert body["limit"] == 2
    assert body["truncated"] is True


async def test_limit_is_clamped_to_the_server_cap(client: AsyncClient, cities_layer: dict) -> None:
    response = await client.get(
        f"/api/v1/layers/{cities_layer['id']}/features",
        params={"bbox": "-180,-90,180,90", "limit": 999999},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


async def test_missing_bbox_is_rejected(client: AsyncClient, cities_layer: dict) -> None:
    response = await client.get(f"/api/v1/layers/{cities_layer['id']}/features")
    assert response.status_code == 422


async def test_features_on_a_non_postgis_layer_is_a_clear_error(client: AsyncClient) -> None:
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    layer = (
        await client.post(
            f"/api/v1/projects/{project_id}/layers",
            json={
                "name": "OSM",
                "kind": "basemap",
                "source": {"type": "xyz", "url": "https://t/{z}/{x}/{y}.png"},
            },
        )
    ).json()
    response = await client.get(
        f"/api/v1/layers/{layer['id']}/features", params={"bbox": "0,0,1,1"}
    )
    assert response.status_code == 422
    assert "not backed by a PostGIS table" in response.json()["error"]["message"]


async def test_features_on_a_dropped_table_is_a_404(
    client: AsyncClient, cities_layer: dict, db_session: AsyncSession
) -> None:
    await db_session.execute(text("DROP TABLE gis_data.test_cities"))
    await db_session.flush()
    response = await client.get(
        f"/api/v1/layers/{cities_layer['id']}/features", params={"bbox": "0,0,1,1"}
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_reprojects_from_a_non_4326_table(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    await db_session.execute(
        text(
            """
            CREATE TABLE gis_data.test_webmerc (
                fid serial PRIMARY KEY,
                name text,
                geometry geometry(Point, 3857)
            )
            """
        )
    )
    await db_session.execute(
        text(
            "INSERT INTO gis_data.test_webmerc (name, geometry) VALUES "
            "('Origin', ST_SetSRID(ST_MakePoint(0, 0), 3857))"
        )
    )
    await db_session.flush()

    project_id = (await client.post("/api/v1/projects", json={"name": "P2"})).json()["id"]
    layer = (
        await client.post(
            f"/api/v1/projects/{project_id}/layers/from-postgis",
            json={
                "schemaName": "gis_data",
                "tableName": "test_webmerc",
                "geometryColumn": "geometry",
                "idColumn": "fid",
                "name": "WebMerc",
            },
        )
    ).json()
    assert layer["srid"] == 3857

    body = (
        await client.get(f"/api/v1/layers/{layer['id']}/features", params={"bbox": "-1,-1,1,1"})
    ).json()
    assert body["returned"] == 1
    assert body["features"][0]["geometry"]["coordinates"] == pytest.approx([0.0, 0.0], abs=1e-9)
