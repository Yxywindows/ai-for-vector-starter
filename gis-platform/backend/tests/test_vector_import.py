import json

import pytest
from httpx import AsyncClient

GEOJSON = {
    "type": "FeatureCollection",
    "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3/CRS84"}},
    "features": [
        {
            "type": "Feature",
            "properties": {"name": "Beijing", "population": 21540000},
            "geometry": {"type": "Point", "coordinates": [116.4074, 39.9042]},
        },
        {
            "type": "Feature",
            "properties": {"name": "Lhasa", "population": 560000},
            "geometry": {"type": "Point", "coordinates": [91.1409, 29.6450]},
        },
    ],
}


@pytest.fixture(autouse=True)
async def drop_imported_tables():
    yield
    from sqlalchemy import text

    from app.db.sync_engine import get_sync_engine

    with get_sync_engine().begin() as conn:
        rows = (
            conn.execute(
                text(
                    "SELECT tablename FROM pg_tables "
                    "WHERE schemaname = 'gis_data' AND tablename <> 'test_cities'"
                )
            )
            .scalars()
            .all()
        )
        for table in rows:
            conn.execute(text(f'DROP TABLE IF EXISTS gis_data."{table}" CASCADE'))


@pytest.fixture
async def project_id(client: AsyncClient) -> str:
    return (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]


async def test_import_geojson_creates_a_layer_backed_by_a_new_table(
    client: AsyncClient, project_id: str
) -> None:
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/import",
        files={"file": ("cities.geojson", json.dumps(GEOJSON), "application/geo+json")},
        data={"name": "Cities"},
    )
    assert response.status_code == 201, response.text
    layer = response.json()
    assert layer["kind"] == "vector"
    assert layer["name"] == "Cities"
    assert layer["featureCount"] == 2
    assert layer["srid"] == 4326
    assert layer["geometryType"].endswith("POINT")
    assert layer["source"]["type"] == "postgis"
    assert layer["source"]["schemaName"] == "gis_data"
    assert layer["source"]["tableName"].startswith("cities_")
    assert layer["source"]["idColumn"] == "fid"
    assert layer["extent"][0] == pytest.approx(91.1409, abs=1e-4)


async def test_imported_table_is_queryable_through_the_catalog(
    client: AsyncClient, project_id: str
) -> None:
    layer = (
        await client.post(
            f"/api/v1/projects/{project_id}/layers/import",
            files={"file": ("cities.geojson", json.dumps(GEOJSON), "application/geo+json")},
        )
    ).json()
    tables = (await client.get("/api/v1/connections/postgis/tables")).json()
    match = next(t for t in tables if t["tableName"] == layer["source"]["tableName"])
    assert match["primaryKey"] == "fid"
    assert match["srid"] == 4326


async def test_import_defaults_the_layer_name_to_the_filename(
    client: AsyncClient, project_id: str
) -> None:
    layer = (
        await client.post(
            f"/api/v1/projects/{project_id}/layers/import",
            files={"file": ("my cities.geojson", json.dumps(GEOJSON), "application/geo+json")},
        )
    ).json()
    assert layer["name"] == "my cities"


async def test_import_rejects_an_unsupported_extension(
    client: AsyncClient, project_id: str
) -> None:
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/import",
        files={"file": ("notes.txt", b"hello", "text/plain")},
    )
    assert response.status_code == 415
    assert response.json()["error"]["code"] == "unsupported_format"


async def test_import_rejects_a_file_with_no_crs(client: AsyncClient, project_id: str) -> None:
    crsless = {"type": "FeatureCollection", "features": GEOJSON["features"]}
    payload = json.dumps(crsless)
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/import",
        files={"file": ("nocrs.geojson", payload, "application/geo+json")},
    )
    # GeoJSON without a CRS member is CRS84 by spec, so this must succeed.
    assert response.status_code == 201
    assert response.json()["srid"] == 4326


async def test_import_rejects_unreadable_content(client: AsyncClient, project_id: str) -> None:
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/import",
        files={"file": ("broken.geojson", b"{not json", "application/geo+json")},
    )
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "upstream_data_error"


async def test_failed_import_drops_the_orphan_table(
    client: AsyncClient, project_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The table is written on a separate sync connection that commits
    independently of the request-scoped transaction. If layer registration
    (`layer_service.create_layer`) fails *after* that write, the request
    rollback cannot undo it -- `import_vector_file` must drop the table
    itself, or a failed import silently leaves an orphan table in
    `gis_data`. This forces that failure after a real `to_postgis` write
    and asserts nothing is left behind."""
    from sqlalchemy import text

    from app.db.sync_engine import get_sync_engine
    from app.services import vector_import_service

    async def _boom(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("layer registration failed")

    monkeypatch.setattr(vector_import_service.layer_service, "create_layer", _boom)

    with pytest.raises(RuntimeError, match="layer registration failed"):
        await client.post(
            f"/api/v1/projects/{project_id}/layers/import",
            files={"file": ("cities.geojson", json.dumps(GEOJSON), "application/geo+json")},
        )

    with get_sync_engine().begin() as conn:
        remaining = (
            conn.execute(
                text(
                    "SELECT tablename FROM pg_tables "
                    "WHERE schemaname = 'gis_data' AND tablename <> 'test_cities'"
                )
            )
            .scalars()
            .all()
        )
    assert remaining == []
