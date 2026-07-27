import pytest
from httpx import AsyncClient

from app.schemas.source import PostgisSource

POINT = {"type": "Point", "coordinates": [113.2644, 23.1291]}


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


async def test_create_feature_returns_the_stored_row(
    client: AsyncClient, cities_layer: dict
) -> None:
    response = await client.post(
        f"/api/v1/layers/{cities_layer['id']}/features",
        json={"geometry": POINT, "properties": {"name": "Guangzhou", "population": 18700000}},
    )
    assert response.status_code == 201, response.text
    feature = response.json()
    assert feature["type"] == "Feature"
    assert feature["properties"]["name"] == "Guangzhou"
    assert feature["geometry"]["coordinates"] == pytest.approx([113.2644, 23.1291], abs=1e-6)
    assert feature["id"]  # server-assigned


async def test_created_feature_is_visible_to_a_bbox_read(
    client: AsyncClient, cities_layer: dict
) -> None:
    await client.post(
        f"/api/v1/layers/{cities_layer['id']}/features",
        json={"geometry": POINT, "properties": {"name": "Guangzhou", "population": 1}},
    )
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/features", params={"bbox": "113,23,114,24"}
        )
    ).json()
    assert [f["properties"]["name"] for f in body["features"]] == ["Guangzhou"]


async def test_patch_updates_attributes_only(client: AsyncClient, cities_layer: dict) -> None:
    response = await client.patch(
        f"/api/v1/layers/{cities_layer['id']}/features/1",
        json={"properties": {"population": 22000000}},
    )
    assert response.status_code == 200
    feature = response.json()
    assert feature["properties"]["population"] == 22000000
    assert feature["properties"]["name"] == "Beijing"  # untouched
    assert feature["geometry"]["coordinates"] == pytest.approx([116.4074, 39.9042], abs=1e-4)


async def test_patch_updates_geometry_only(client: AsyncClient, cities_layer: dict) -> None:
    response = await client.patch(
        f"/api/v1/layers/{cities_layer['id']}/features/1", json={"geometry": POINT}
    )
    assert response.status_code == 200
    feature = response.json()
    assert feature["geometry"]["coordinates"] == pytest.approx([113.2644, 23.1291], abs=1e-6)
    assert feature["properties"]["name"] == "Beijing"


async def test_patch_with_an_empty_body_is_rejected(
    client: AsyncClient, cities_layer: dict
) -> None:
    response = await client.patch(f"/api/v1/layers/{cities_layer['id']}/features/1", json={})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


async def test_cannot_write_the_primary_key(client: AsyncClient, cities_layer: dict) -> None:
    response = await client.patch(
        f"/api/v1/layers/{cities_layer['id']}/features/1", json={"properties": {"fid": 99}}
    )
    assert response.status_code == 422
    assert "fid" in str(response.json()["error"]["details"])


async def test_cannot_write_the_geometry_column_as_an_attribute(
    client: AsyncClient, cities_layer: dict
) -> None:
    response = await client.patch(
        f"/api/v1/layers/{cities_layer['id']}/features/1",
        json={"properties": {"geometry": "POINT(0 0)"}},
    )
    assert response.status_code == 422


async def test_cannot_write_an_unknown_column(client: AsyncClient, cities_layer: dict) -> None:
    response = await client.patch(
        f"/api/v1/layers/{cities_layer['id']}/features/1",
        json={"properties": {"injected": 1}},
    )
    assert response.status_code == 422


async def test_invalid_geometry_is_rejected(client: AsyncClient, cities_layer: dict) -> None:
    bowtie = {
        "type": "Polygon",
        "coordinates": [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]],
    }
    response = await client.patch(
        f"/api/v1/layers/{cities_layer['id']}/features/1", json={"geometry": bowtie}
    )
    assert response.status_code == 422
    assert "geometry" in response.json()["error"]["message"].lower()


async def test_malformed_geojson_geometry_is_rejected(
    client: AsyncClient, cities_layer: dict
) -> None:
    response = await client.patch(
        f"/api/v1/layers/{cities_layer['id']}/features/1",
        json={"geometry": {"type": "Nonsense", "coordinates": [1, 2]}},
    )
    assert response.status_code == 422


async def test_patching_a_missing_feature_is_a_404(client: AsyncClient, cities_layer: dict) -> None:
    response = await client.patch(
        f"/api/v1/layers/{cities_layer['id']}/features/9999",
        json={"properties": {"population": 1}},
    )
    assert response.status_code == 404


async def test_delete_removes_the_row(client: AsyncClient, cities_layer: dict) -> None:
    assert (
        await client.delete(f"/api/v1/layers/{cities_layer['id']}/features/3")
    ).status_code == 204
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/features", params={"bbox": "-180,-90,180,90"}
        )
    ).json()
    assert "Lhasa" not in [f["properties"]["name"] for f in body["features"]]


async def test_deleting_a_missing_feature_is_a_404(client: AsyncClient, cities_layer: dict) -> None:
    assert (
        await client.delete(f"/api/v1/layers/{cities_layer['id']}/features/9999")
    ).status_code == 404


async def test_editing_a_non_postgis_layer_is_rejected(client: AsyncClient) -> None:
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
    response = await client.post(
        f"/api/v1/layers/{layer['id']}/features",
        json={"geometry": POINT, "properties": {}},
    )
    assert response.status_code == 422


async def test_a_rejected_edit_leaves_the_row_unchanged(
    client: AsyncClient, cities_layer: dict
) -> None:
    await client.patch(
        f"/api/v1/layers/{cities_layer['id']}/features/1",
        json={"properties": {"population": 1}, "geometry": {"type": "Nonsense"}},
    )
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/attributes",
            params={"filters": '[{"field": "fid", "op": "eq", "value": 1}]'},
        )
    ).json()
    assert body["rows"][0]["population"] == 21540000
