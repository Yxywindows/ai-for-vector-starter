from httpx import AsyncClient

from app.resources import dataset_pool


async def test_memory_report_shape(client: AsyncClient) -> None:
    response = await client.get("/api/v1/system/memory")
    assert response.status_code == 200
    body = response.json()
    assert body["rasterPool"]["maxOpen"] == 8
    assert body["rasterPool"]["openHandles"] == 0
    assert body["featureBboxLimit"] == 2000
    assert body["attributePageMax"] == 500
    assert body["processRssBytes"] > 0


async def test_memory_report_is_service_unavailable_before_the_pool_is_initialised(
    client: AsyncClient,
) -> None:
    # The pool is process-lifetime state normally created by the app's
    # lifespan (which `client` has already run). Reset the module global
    # directly to simulate a request arriving before startup finished, and
    # restore it afterwards so this shared global cannot leak into other
    # tests.
    previous_pool = dataset_pool._raster_pool
    dataset_pool._raster_pool = None
    try:
        response = await client.get("/api/v1/system/memory")
    finally:
        dataset_pool._raster_pool = previous_pool

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "service_unavailable"


async def test_import_limits_reports_the_configured_values(client: AsyncClient) -> None:
    response = await client.get("/api/v1/system/import-limits")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["allowedExtensions"] == [".json", ".geojson"]
    assert body["maxFileBytes"] == 64 * 1024 * 1024
    assert body["maxFeatures"] == 50_000
    assert body["previewMaxFeatures"] == 5_000


async def test_overview_counts_projects_layers_and_features(client) -> None:
    project_id = (await client.post("/api/v1/projects", json={"name": "Ov"})).json()["id"]
    await client.post(
        f"/api/v1/projects/{project_id}/layers",
        json={
            "name": "Base",
            "kind": "basemap",
            "source": {"type": "xyz", "url": "https://t/{z}/{x}/{y}.png", "attribution": None},
        },
    )

    body = (await client.get("/api/v1/system/overview")).json()
    assert body["projectCount"] >= 1
    assert body["layerCount"] >= 1
    assert body["layersByKind"].get("basemap", 0) >= 1
    assert isinstance(body["featureTotal"], int)
    recent = body["recentLayers"]
    assert any(layer["name"] == "Base" and layer["projectName"] == "Ov" for layer in recent)
