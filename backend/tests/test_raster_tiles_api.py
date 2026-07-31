from pathlib import Path

import pytest
from httpx import AsyncClient

from app.core.config import get_settings


@pytest.fixture
async def raster_layer(client: AsyncClient, sample_geotiff: Path) -> dict:
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    return (
        await client.post(
            f"/api/v1/projects/{project_id}/layers/import-raster",
            files={"file": ("sample.tif", sample_geotiff.read_bytes(), "image/tiff")},
            data={"name": "Sample"},
        )
    ).json()


async def test_tile_covering_the_raster_returns_a_png(
    client: AsyncClient, raster_layer: dict
) -> None:
    # The sample covers 100..101E, 30..31N. At z=8 that is tile x=214, y=110 (approx).
    response = await client.get(f"/api/v1/layers/{raster_layer['id']}/tiles/0/0/0.png")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.content[:8] == b"\x89PNG\r\n\x1a\n"


async def test_tile_outside_the_raster_returns_204(client: AsyncClient, raster_layer: dict) -> None:
    # A z=8 tile over the Atlantic, far from 100E/30N.
    response = await client.get(f"/api/v1/layers/{raster_layer['id']}/tiles/8/120/120.png")
    assert response.status_code == 204


async def test_raster_tile_sets_cache_headers(client: AsyncClient, raster_layer: dict) -> None:
    response = await client.get(f"/api/v1/layers/{raster_layer['id']}/tiles/0/0/0.png")
    assert response.headers["cache-control"] == "public, max-age=60"
    assert response.headers["etag"]


async def test_out_of_range_raster_tile_is_rejected(
    client: AsyncClient, raster_layer: dict
) -> None:
    response = await client.get(f"/api/v1/layers/{raster_layer['id']}/tiles/0/9/9.png")
    assert response.status_code == 422


async def test_png_tiles_on_a_vector_layer_are_rejected(client: AsyncClient) -> None:
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
    response = await client.get(f"/api/v1/layers/{layer['id']}/tiles/0/0/0.png")
    assert response.status_code == 422


async def test_statistics_reports_per_band_ranges(client: AsyncClient, raster_layer: dict) -> None:
    body = (await client.get(f"/api/v1/layers/{raster_layer['id']}/statistics")).json()
    assert len(body["bands"]) == 1
    band = body["bands"][0]
    assert band["band"] == 1
    assert band["min"] >= 0
    assert band["max"] <= 255
    assert band["max"] > band["min"]
    assert band["percentile98"] >= band["percentile2"]


async def test_the_pool_reports_a_handle_after_serving_tiles(
    client: AsyncClient, raster_layer: dict
) -> None:
    await client.get(f"/api/v1/layers/{raster_layer['id']}/tiles/0/0/0.png")
    stats = (await client.get("/api/v1/system/memory")).json()["rasterPool"]
    assert stats["openHandles"] == 1
    assert stats["misses"] >= 1

    await client.get(f"/api/v1/layers/{raster_layer['id']}/tiles/0/0/0.png")
    stats_again = (await client.get("/api/v1/system/memory")).json()["rasterPool"]
    assert stats_again["hits"] >= 1
    assert stats_again["openHandles"] == 1  # reused, not reopened


async def test_unknown_colormap_is_rejected(client: AsyncClient, raster_layer: dict) -> None:
    """`rio_tiler.colormap.cmap.get` raises `InvalidColorMapName` -- confirmed
    by calling it directly -- neither a `KeyError` nor a `ValueError`, so this
    must come back as this app's own 422 envelope, not an unhandled 500."""
    patched = await client.patch(
        f"/api/v1/layers/{raster_layer['id']}",
        json={"style": {"kind": "raster", "bands": [1], "colormap": "not_a_real_colormap"}},
    )
    assert patched.status_code == 200, patched.text

    response = await client.get(f"/api/v1/layers/{raster_layer['id']}/tiles/0/0/0.png")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


async def test_missing_raster_file_on_disk_is_an_upstream_error(
    client: AsyncClient, raster_layer: dict
) -> None:
    """A layer row can outlive its file (e.g. deleted out-of-band on disk).
    Opening it then raises `rasterio.errors.RasterioIOError` -- confirmed by
    opening a missing path directly -- an `OSError` sibling of
    `FileNotFoundError`, not a subclass of it, so this must come back as a
    502 upstream-data error rather than an unhandled 500."""
    stored = get_settings().raster_dir / Path(raster_layer["source"]["path"]).name
    stored.unlink()

    response = await client.get(f"/api/v1/layers/{raster_layer['id']}/tiles/0/0/0.png")
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "upstream_data_error"


async def test_statistics_on_a_missing_raster_file_is_an_upstream_error(
    client: AsyncClient, raster_layer: dict
) -> None:
    stored = get_settings().raster_dir / Path(raster_layer["source"]["path"]).name
    stored.unlink()

    response = await client.get(f"/api/v1/layers/{raster_layer['id']}/statistics")
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "upstream_data_error"
