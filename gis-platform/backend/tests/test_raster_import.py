from pathlib import Path

import pytest
import rasterio
from httpx import AsyncClient

from app.core.config import get_settings
from app.core.errors import InvalidRequestError
from app.schemas.source import RasterFileSource
from app.services.raster_import_service import resolve_raster_path


@pytest.fixture
async def project_id(client: AsyncClient) -> str:
    return (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]


async def test_import_geotiff_creates_a_raster_layer(
    client: AsyncClient, project_id: str, sample_geotiff: Path
) -> None:
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/import-raster",
        files={"file": ("sample.tif", sample_geotiff.read_bytes(), "image/tiff")},
        data={"name": "Elevation"},
    )
    assert response.status_code == 201, response.text
    layer = response.json()
    assert layer["kind"] == "raster"
    assert layer["name"] == "Elevation"
    # `type` is a Literal *value*, not a field name, so `to_camel` never
    # touches it -- it stays "raster_file" on the wire.
    assert layer["source"]["type"] == "raster_file"
    assert layer["source"]["bandCount"] == 1
    assert layer["source"]["isCog"] is True
    assert layer["extent"] == pytest.approx([100.0, 30.0, 101.0, 31.0], abs=1e-6)
    assert layer["srid"] == 4326
    assert layer["style"]["kind"] == "raster"
    assert layer["style"]["bands"] == [1]
    assert layer["style"]["rescale"] is not None


async def test_imported_raster_is_a_valid_cog_on_disk(
    client: AsyncClient, project_id: str, sample_geotiff: Path
) -> None:
    layer = (
        await client.post(
            f"/api/v1/projects/{project_id}/layers/import-raster",
            files={"file": ("sample.tif", sample_geotiff.read_bytes(), "image/tiff")},
        )
    ).json()
    path = get_settings().raster_dir / Path(layer["source"]["path"]).name
    assert path.exists()
    with rasterio.open(path) as dataset:
        assert dataset.crs.to_epsg() == 4326
        assert dataset.count == 1


async def test_import_rejects_a_raster_without_a_crs(
    client: AsyncClient, project_id: str, sample_geotiff_no_crs: Path
) -> None:
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/import-raster",
        files={"file": ("nocrs.tif", sample_geotiff_no_crs.read_bytes(), "image/tiff")},
    )
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "upstream_data_error"


async def test_import_rejects_a_non_raster_extension(client: AsyncClient, project_id: str) -> None:
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/import-raster",
        files={"file": ("cities.geojson", b"{}", "application/geo+json")},
    )
    assert response.status_code == 415


def test_resolve_raster_path_blocks_directory_escape() -> None:
    with pytest.raises(InvalidRequestError):
        resolve_raster_path(RasterFileSource(path="../../etc/passwd", band_count=1, is_cog=True))


def test_resolve_raster_path_returns_a_path_inside_the_data_dir(
    client: AsyncClient,
) -> None:
    settings = get_settings()
    (settings.raster_dir / "ok.tif").parent.mkdir(parents=True, exist_ok=True)
    (settings.raster_dir / "ok.tif").write_bytes(b"")
    resolved = resolve_raster_path(RasterFileSource(path="ok.tif", band_count=1, is_cog=True))
    assert resolved == (settings.raster_dir / "ok.tif").resolve()


async def test_failed_import_removes_the_orphan_cog_file(
    client: AsyncClient,
    project_id: str,
    sample_geotiff: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The COG is written to `settings.raster_dir` before the layer row is
    ever created. If registration fails after that write, the request-scoped
    rollback undoes the layer row but cannot undo a file on disk --
    `import_raster_file` must delete it itself. This forces the failure
    *after* the COG has actually been written (by monkeypatching the layer
    creation step that only runs once the file exists) and asserts nothing
    new is left behind in raster_dir."""
    from app.services import raster_import_service

    async def _boom(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("layer registration failed")

    monkeypatch.setattr(raster_import_service.layer_service, "create_layer", _boom)

    settings = get_settings()
    before = set(settings.raster_dir.glob("*")) if settings.raster_dir.exists() else set()

    with pytest.raises(RuntimeError, match="layer registration failed"):
        await client.post(
            f"/api/v1/projects/{project_id}/layers/import-raster",
            files={"file": ("sample.tif", sample_geotiff.read_bytes(), "image/tiff")},
        )

    after = set(settings.raster_dir.glob("*")) if settings.raster_dir.exists() else set()
    assert after == before
