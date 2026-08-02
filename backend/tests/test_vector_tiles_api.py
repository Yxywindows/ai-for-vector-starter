import pytest
from httpx import AsyncClient

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


async def test_world_tile_contains_the_seeded_features(
    client: AsyncClient, cities_layer: dict
) -> None:
    response = await client.get(f"/api/v1/layers/{cities_layer['id']}/tiles/0/0/0.mvt")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/vnd.mapbox-vector-tile"
    assert len(response.content) > 0
    # MVT is protobuf; the layer name is stored as a plain string in the blob.
    assert b"Cities" in response.content or b"default" in response.content
    assert b"population" in response.content


async def test_empty_tile_returns_204(client: AsyncClient, cities_layer: dict) -> None:
    # Zoom 5 tile over the mid-Atlantic — no seeded city is there.
    response = await client.get(f"/api/v1/layers/{cities_layer['id']}/tiles/5/13/15.mvt")
    assert response.status_code == 204
    assert response.content == b""


async def test_tile_sets_cache_headers_and_an_etag(client: AsyncClient, cities_layer: dict) -> None:
    response = await client.get(f"/api/v1/layers/{cities_layer['id']}/tiles/0/0/0.mvt")
    assert response.headers["cache-control"] == "public, max-age=60"
    assert response.headers["etag"]


async def test_matching_if_none_match_returns_304(client: AsyncClient, cities_layer: dict) -> None:
    first = await client.get(f"/api/v1/layers/{cities_layer['id']}/tiles/0/0/0.mvt")
    etag = first.headers["etag"]
    second = await client.get(
        f"/api/v1/layers/{cities_layer['id']}/tiles/0/0/0.mvt",
        headers={"if-none-match": etag},
    )
    assert second.status_code == 304


async def test_out_of_range_tile_is_rejected(client: AsyncClient, cities_layer: dict) -> None:
    response = await client.get(f"/api/v1/layers/{cities_layer['id']}/tiles/0/5/5.mvt")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


async def test_tiles_on_a_non_postgis_layer_are_rejected(client: AsyncClient) -> None:
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
    response = await client.get(f"/api/v1/layers/{layer['id']}/tiles/0/0/0.mvt")
    assert response.status_code == 422
