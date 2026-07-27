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
