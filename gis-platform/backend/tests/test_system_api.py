from httpx import AsyncClient


async def test_memory_report_shape(client: AsyncClient) -> None:
    response = await client.get("/api/v1/system/memory")
    assert response.status_code == 200
    body = response.json()
    assert body["rasterPool"]["maxOpen"] == 8
    assert body["rasterPool"]["openHandles"] == 0
    assert body["featureBboxLimit"] == 2000
    assert body["attributePageMax"] == 500
    assert body["processRssBytes"] > 0
