import pytest
from httpx import AsyncClient

BASEMAP = {
    "name": "OSM",
    "kind": "basemap",
    "source": {"type": "xyz", "url": "https://tile.example/{z}/{x}/{y}.png"},
}


@pytest.fixture
async def project_id(client: AsyncClient) -> str:
    return (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]


async def test_create_layer_assigns_next_z_index(client: AsyncClient, project_id: str) -> None:
    first = await client.post(f"/api/v1/projects/{project_id}/layers", json=BASEMAP)
    assert first.status_code == 201
    assert first.json()["zIndex"] == 0

    second = await client.post(
        f"/api/v1/projects/{project_id}/layers", json={**BASEMAP, "name": "OSM 2"}
    )
    assert second.json()["zIndex"] == 1


async def test_create_layer_fills_a_default_style(client: AsyncClient, project_id: str) -> None:
    body = (await client.post(f"/api/v1/projects/{project_id}/layers", json=BASEMAP)).json()
    assert body["style"]["kind"] == "vector"
    assert body["style"]["renderer"]["type"] == "single"


async def test_duplicate_layer_name_in_project_is_a_conflict(
    client: AsyncClient, project_id: str
) -> None:
    await client.post(f"/api/v1/projects/{project_id}/layers", json=BASEMAP)
    duplicate = await client.post(f"/api/v1/projects/{project_id}/layers", json=BASEMAP)
    assert duplicate.status_code == 409
    assert duplicate.json()["error"]["code"] == "conflict"


async def test_patch_layer_rename_to_duplicate_name_is_a_conflict(
    client: AsyncClient, project_id: str
) -> None:
    """Task 4 note: the (project_id, name) uniqueness check must cover rename,
    not just create — otherwise PATCH would raise a raw IntegrityError 500
    instead of the conflict envelope."""
    await client.post(f"/api/v1/projects/{project_id}/layers", json=BASEMAP)
    other = (
        await client.post(
            f"/api/v1/projects/{project_id}/layers", json={**BASEMAP, "name": "Other"}
        )
    ).json()

    response = await client.patch(f"/api/v1/layers/{other['id']}", json={"name": "OSM"})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "conflict"


async def test_patch_layer_updates_visibility_opacity_and_style(
    client: AsyncClient, project_id: str
) -> None:
    layer = (await client.post(f"/api/v1/projects/{project_id}/layers", json=BASEMAP)).json()
    response = await client.patch(
        f"/api/v1/layers/{layer['id']}",
        json={
            "visible": False,
            "opacity": 0.4,
            "style": {"kind": "vector", "fill": {"color": "#ff0000", "opacity": 0.9}},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["visible"] is False
    assert body["opacity"] == 0.4
    assert body["style"]["fill"]["color"] == "#ff0000"


async def test_patch_layer_rejects_invalid_style(client: AsyncClient, project_id: str) -> None:
    layer = (await client.post(f"/api/v1/projects/{project_id}/layers", json=BASEMAP)).json()
    response = await client.patch(
        f"/api/v1/layers/{layer['id']}", json={"style": {"kind": "vector", "opacity": "loud"}}
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


async def test_reorder_rewrites_z_indexes(client: AsyncClient, project_id: str) -> None:
    a = (await client.post(f"/api/v1/projects/{project_id}/layers", json=BASEMAP)).json()
    b = (
        await client.post(f"/api/v1/projects/{project_id}/layers", json={**BASEMAP, "name": "B"})
    ).json()
    c = (
        await client.post(f"/api/v1/projects/{project_id}/layers", json={**BASEMAP, "name": "C"})
    ).json()

    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/reorder",
        json={"layerIds": [c["id"], a["id"], b["id"]]},
    )
    assert response.status_code == 200
    assert [layer["name"] for layer in response.json()] == ["C", "OSM", "B"]
    assert [layer["zIndex"] for layer in response.json()] == [0, 1, 2]


async def test_reorder_rejects_a_partial_id_list(client: AsyncClient, project_id: str) -> None:
    a = (await client.post(f"/api/v1/projects/{project_id}/layers", json=BASEMAP)).json()
    await client.post(f"/api/v1/projects/{project_id}/layers", json={**BASEMAP, "name": "B"})

    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/reorder", json={"layerIds": [a["id"]]}
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


async def test_project_detail_returns_layers_in_z_order(
    client: AsyncClient, project_id: str
) -> None:
    await client.post(f"/api/v1/projects/{project_id}/layers", json=BASEMAP)
    await client.post(f"/api/v1/projects/{project_id}/layers", json={**BASEMAP, "name": "B"})
    body = (await client.get(f"/api/v1/projects/{project_id}")).json()
    assert [layer["name"] for layer in body["layers"]] == ["OSM", "B"]


async def test_delete_layer(client: AsyncClient, project_id: str) -> None:
    layer = (await client.post(f"/api/v1/projects/{project_id}/layers", json=BASEMAP)).json()
    assert (await client.delete(f"/api/v1/layers/{layer['id']}")).status_code == 204
    assert (await client.get(f"/api/v1/layers/{layer['id']}")).status_code == 404
