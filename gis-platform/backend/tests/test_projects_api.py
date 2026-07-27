from httpx import AsyncClient


async def test_create_project_returns_camel_case_and_defaults(client: AsyncClient) -> None:
    response = await client.post("/api/v1/projects", json={"name": "City Plan"})
    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "City Plan"
    assert body["view"] == {"center": [0.0, 0.0], "zoom": 2.0, "projection": "EPSG:3857"}
    assert body["layers"] == []


async def test_get_missing_project_returns_error_envelope(client: AsyncClient) -> None:
    missing = "8b1b0e0e-0000-4000-8000-0000000000ff"
    response = await client.get(f"/api/v1/projects/{missing}")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_list_projects_reports_layer_count(client: AsyncClient) -> None:
    created = (await client.post("/api/v1/projects", json={"name": "A"})).json()
    added = await client.post(
        f"/api/v1/projects/{created['id']}/layers",
        json={
            "name": "Roads",
            "kind": "basemap",
            "source": {"type": "xyz", "url": "https://tiles/{z}/{x}/{y}.png"},
        },
    )
    assert added.status_code == 201
    listing = (await client.get("/api/v1/projects")).json()
    assert listing == [{"id": created["id"], "name": "A", "layerCount": 1}]


async def test_list_projects_reports_zero_for_an_empty_project(client: AsyncClient) -> None:
    created = (await client.post("/api/v1/projects", json={"name": "Empty"})).json()
    listing = (await client.get("/api/v1/projects")).json()
    assert listing == [{"id": created["id"], "name": "Empty", "layerCount": 0}]


async def test_patch_project_view(client: AsyncClient) -> None:
    created = (await client.post("/api/v1/projects", json={"name": "A"})).json()
    response = await client.patch(
        f"/api/v1/projects/{created['id']}",
        json={"view": {"center": [116.4, 39.9], "zoom": 10.0, "projection": "EPSG:3857"}},
    )
    assert response.status_code == 200
    assert response.json()["view"]["center"] == [116.4, 39.9]


async def test_delete_project_removes_it(client: AsyncClient) -> None:
    created = (await client.post("/api/v1/projects", json={"name": "A"})).json()
    assert (await client.delete(f"/api/v1/projects/{created['id']}")).status_code == 204
    assert (await client.get(f"/api/v1/projects/{created['id']}")).status_code == 404
