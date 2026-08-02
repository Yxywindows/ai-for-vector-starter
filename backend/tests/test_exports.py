"""R8: the export pipeline, on the task system.

Round-trips real files: submit through the API, run the worker with the
test session, download through the API, and parse what came back.
"""

from __future__ import annotations

import json
import zipfile
from io import BytesIO

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.schemas.source import PostgisSource
from app.services import task_worker


@pytest.fixture
async def export_project(client: AsyncClient, seeded_spatial_table: PostgisSource) -> dict:
    project_id = (await client.post("/api/v1/projects", json={"name": "Exports"})).json()["id"]
    layer = (
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
    return {"projectId": project_id, "layer": layer}


@pytest.fixture(autouse=True)
def _clean_exports() -> None:
    yield
    exports = get_settings().data_dir / "exports"
    if exports.exists():
        for path in exports.glob("*"):
            path.unlink(missing_ok=True)


async def _run_export(
    client: AsyncClient, db_session: AsyncSession, project_id: str, body: dict
) -> dict:
    submitted = await client.post(f"/api/v1/projects/{project_id}/exports/vector", json=body)
    assert submitted.status_code == 202, submitted.text
    assert await task_worker.run_once(db_session) is True
    detail = (await client.get(f"/api/v1/tasks/{submitted.json()['id']}")).json()
    assert detail["state"] == "succeeded", detail.get("error")
    return detail


async def test_geojson_export_honors_field_selection_and_reprojection(
    client: AsyncClient, db_session: AsyncSession, export_project: dict
) -> None:
    detail = await _run_export(
        client,
        db_session,
        export_project["projectId"],
        {
            "layerId": export_project["layer"]["id"],
            "format": "geojson",
            "fields": ["name"],
            "crs": 3857,
            "filename": "cities export",
        },
    )
    assert detail["result"]["featureCount"] == 3
    assert detail["result"]["crs"] == 3857
    assert detail["result"]["retention"] == "manual"

    download = await client.get(f"/api/v1/tasks/{detail['id']}/download")
    assert download.status_code == 200
    assert download.headers["content-type"].startswith("application/geo+json")
    assert "cities%20export.geojson" in download.headers["content-disposition"]

    collection = json.loads(download.content)
    assert len(collection["features"]) == 3
    properties = collection["features"][0]["properties"]
    assert set(properties.keys()) == {"name"}  # population excluded
    # Web Mercator coordinates are far outside the degree range.
    x = collection["features"][0]["geometry"]["coordinates"][0]
    assert abs(x) > 1_000_000

    # Download state is recorded on the task.
    after = (await client.get(f"/api/v1/tasks/{detail['id']}")).json()
    assert "lastDownloadedAt" in after["provenance"]


async def test_csv_export_writes_wkt_geometry(
    client: AsyncClient, db_session: AsyncSession, export_project: dict
) -> None:
    detail = await _run_export(
        client,
        db_session,
        export_project["projectId"],
        {"layerId": export_project["layer"]["id"], "format": "csv"},
    )
    download = await client.get(f"/api/v1/tasks/{detail['id']}/download")
    body = download.content.decode()
    header = body.splitlines()[0]
    assert "name" in header
    assert "population" in header
    assert "geometry_wkt" in header
    assert "POINT" in body


async def test_shapefile_export_bundles_sidecars_in_a_zip(
    client: AsyncClient, db_session: AsyncSession, export_project: dict
) -> None:
    detail = await _run_export(
        client,
        db_session,
        export_project["projectId"],
        {"layerId": export_project["layer"]["id"], "format": "shp", "filename": "city bundle"},
    )
    download = await client.get(f"/api/v1/tasks/{detail['id']}/download")
    bundle = zipfile.ZipFile(BytesIO(download.content))
    suffixes = {name.split(".")[-1] for name in bundle.namelist()}
    assert {"shp", "dbf", "shx", "prj"} <= suffixes
    # Files inside the zip carry the requested name, not the task id.
    assert all(name.startswith("city bundle.") for name in bundle.namelist())


async def test_gpkg_export_produces_a_nonempty_file(
    client: AsyncClient, db_session: AsyncSession, export_project: dict
) -> None:
    detail = await _run_export(
        client,
        db_session,
        export_project["projectId"],
        {"layerId": export_project["layer"]["id"], "format": "gpkg"},
    )
    assert detail["result"]["sizeBytes"] > 0
    download = await client.get(f"/api/v1/tasks/{detail['id']}/download")
    assert download.content[:16].startswith(b"SQLite format 3")


async def test_selected_features_and_filters_narrow_the_export(
    client: AsyncClient, db_session: AsyncSession, export_project: dict
) -> None:
    by_ids = await _run_export(
        client,
        db_session,
        export_project["projectId"],
        {
            "layerId": export_project["layer"]["id"],
            "format": "geojson",
            "featureIds": ["1", "3"],
        },
    )
    assert by_ids["result"]["featureCount"] == 2

    by_filter = await _run_export(
        client,
        db_session,
        export_project["projectId"],
        {
            "layerId": export_project["layer"]["id"],
            "format": "geojson",
            "filters": [{"field": "population", "op": "gt", "value": 1_000_000}],
        },
    )
    assert by_filter["result"]["featureCount"] == 2

    by_bbox = await _run_export(
        client,
        db_session,
        export_project["projectId"],
        {
            "layerId": export_project["layer"]["id"],
            "format": "geojson",
            "bbox": [90, 29, 92, 30],  # Lhasa only
        },
    )
    assert by_bbox["result"]["featureCount"] == 1


async def test_download_refuses_unfinished_and_non_export_tasks(
    client: AsyncClient, db_session: AsyncSession, export_project: dict
) -> None:
    submitted = await client.post(
        f"/api/v1/projects/{export_project['projectId']}/exports/vector",
        json={"layerId": export_project["layer"]["id"], "format": "geojson"},
    )
    early = await client.get(f"/api/v1/tasks/{submitted.json()['id']}/download")
    assert early.status_code == 409

    unknown_fields = await client.post(
        f"/api/v1/projects/{export_project['projectId']}/exports/vector",
        json={
            "layerId": export_project["layer"]["id"],
            "format": "geojson",
            "fields": ["nope"],
        },
    )
    await task_worker.run_once(db_session)  # first queued task (early one)
    await task_worker.run_once(db_session)  # the bad-fields one
    failed = (await client.get(f"/api/v1/tasks/{unknown_fields.json()['id']}")).json()
    assert failed["state"] == "failed"
    assert failed["error"]["code"] == "invalid_request"


async def test_raster_export_copies_the_cog(
    client: AsyncClient, db_session: AsyncSession, sample_geotiff, export_project: dict
) -> None:
    project_id = export_project["projectId"]
    with open(sample_geotiff, "rb") as handle:
        imported = await client.post(
            f"/api/v1/projects/{project_id}/layers/import-raster",
            files={"file": ("dem.tif", handle.read(), "image/tiff")},
        )
    assert imported.status_code == 201, imported.text

    submitted = await client.post(
        f"/api/v1/projects/{project_id}/exports/raster",
        json={"layerId": imported.json()["id"], "format": "gtiff"},
    )
    assert await task_worker.run_once(db_session) is True
    detail = (await client.get(f"/api/v1/tasks/{submitted.json()['id']}")).json()
    assert detail["state"] == "succeeded", detail.get("error")

    download = await client.get(f"/api/v1/tasks/{detail['id']}/download")
    assert download.status_code == 200
    assert download.content[:2] in (b"II", b"MM")  # TIFF magic

    # Vector export of a raster layer fails with a structured error.
    wrong = await client.post(
        f"/api/v1/projects/{project_id}/exports/vector",
        json={"layerId": imported.json()["id"], "format": "geojson"},
    )
    await task_worker.run_once(db_session)
    failed = (await client.get(f"/api/v1/tasks/{wrong.json()['id']}")).json()
    assert failed["state"] == "failed"
    assert failed["error"]["code"] == "invalid_request"
