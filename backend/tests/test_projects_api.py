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


async def test_thumbnail_round_trip(client, tmp_path, monkeypatch) -> None:
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "data_dir", tmp_path)
    project_id = (await client.post("/api/v1/projects", json={"name": "Thumb"})).json()["id"]

    missing = await client.get(f"/api/v1/projects/{project_id}/thumbnail")
    assert missing.status_code == 404

    png = b"\x89PNG\r\n\x1a\n" + b"0" * 64
    put = await client.put(
        f"/api/v1/projects/{project_id}/thumbnail",
        content=png,
        headers={"content-type": "image/png"},
    )
    assert put.status_code == 204

    got = await client.get(f"/api/v1/projects/{project_id}/thumbnail")
    assert got.status_code == 200
    assert got.content == png
    assert got.headers["content-type"] == "image/png"


async def test_thumbnail_rejects_empty_and_oversized(client, tmp_path, monkeypatch) -> None:
    from app.api.v1.routes import projects as projects_route
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "data_dir", tmp_path)
    project_id = (await client.post("/api/v1/projects", json={"name": "Thumb2"})).json()["id"]

    empty = await client.put(f"/api/v1/projects/{project_id}/thumbnail", content=b"")
    assert empty.status_code == 422

    monkeypatch.setattr(projects_route, "MAX_THUMBNAIL_BYTES", 10)
    big = await client.put(f"/api/v1/projects/{project_id}/thumbnail", content=b"x" * 11)
    assert big.status_code == 422
