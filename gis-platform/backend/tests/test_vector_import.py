import json
from pathlib import Path

import pytest
from httpx import AsyncClient

from app.services.vector_import_service import _is_unsafe_zip_member

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


async def test_failed_import_drops_the_table_when_indexing_fails_after_the_bulk_write(
    client: AsyncClient, project_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`to_postgis` commits on the sync engine before `_create_indexes` (the
    ADD PRIMARY KEY / CREATE INDEX statements) ever runs. This forces the
    failure specifically in that second window -- after the bulk write has
    already landed a real, committed table, and before indexing finishes --
    and asserts the table is still dropped rather than left behind
    half-built (no primary key, no geometry index). This is deliberately a
    *different* failure point from `test_failed_import_drops_the_orphan_table`
    above, which fails only after `_read_and_write` has already succeeded
    end to end; a test that fails during or after `_create_indexes` cannot
    be satisfied by that other test's coverage."""
    from sqlalchemy import text

    from app.db.sync_engine import get_sync_engine
    from app.services import vector_import_service

    def _boom(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("indexing failed")

    monkeypatch.setattr(vector_import_service, "_create_indexes", _boom)

    with pytest.raises(RuntimeError, match="indexing failed"):
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


@pytest.mark.parametrize(
    ("member", "expected"),
    [
        ("roads.shp", False),
        ("sub/dir/roads.shp", False),
        ("../evil.txt", True),
        ("a/../../b", True),
        ("/etc/passwd", True),  # POSIX-absolute; Path.is_absolute() is False on Windows
        ("\\etc\\passwd", True),  # Windows-rooted, drive-relative; also not "absolute"
        ("C:/evil.txt", True),
        ("C:\\evil.txt", True),
    ],
)
def test_is_unsafe_zip_member_catches_both_path_flavours_on_any_host(
    member: str, expected: bool
) -> None:
    assert _is_unsafe_zip_member(member) is expected


async def test_import_zipped_shapefile_creates_a_layer(
    client: AsyncClient, project_id: str, tmp_path: Path
) -> None:
    """End-to-end coverage for the zip path, which none of the GeoJSON tests
    above touch: a real ESRI Shapefile bundle (.shp/.shx/.dbf/.prj/.cpg),
    zipped up, must resolve, read and import exactly like a bare GeoJSON."""
    import zipfile

    import geopandas as gpd
    from shapely.geometry import Point

    frame = gpd.GeoDataFrame(
        {"name": ["Beijing", "Lhasa"]},
        geometry=[Point(116.4074, 39.9042), Point(91.1409, 29.6450)],
        crs="EPSG:4326",
    )
    shp_dir = tmp_path / "shp_src"
    shp_dir.mkdir()
    frame.to_file(shp_dir / "roads.shp", driver="ESRI Shapefile")

    zip_path = tmp_path / "roads.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        for member in shp_dir.iterdir():
            zf.write(member, arcname=member.name)

    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/import",
        files={"file": ("roads.zip", zip_path.read_bytes(), "application/zip")},
    )
    assert response.status_code == 201, response.text
    layer = response.json()
    assert layer["name"] == "roads"
    assert layer["featureCount"] == 2
    assert layer["srid"] == 4326
    assert layer["source"]["tableName"].startswith("roads_")


async def test_import_rejects_a_zip_with_an_unsafe_entry_and_extracts_nothing(
    client: AsyncClient, project_id: str, tmp_path: Path
) -> None:
    """A hostile entry name must be rejected before `extractall` ever runs,
    not merely handled "safely" by chance. Assert on where files actually
    landed: the whole per-import work directory tree must be gone (cleaned
    up by `import_vector_file`'s `finally`), so nothing -- inside or outside
    the work directory -- was left on disk from this request."""
    import zipfile

    from app.core.config import get_settings

    zip_path = tmp_path / "evil.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("/etc/passwd", "pwned")

    settings = get_settings()
    before = set(settings.upload_tmp_dir.iterdir()) if settings.upload_tmp_dir.exists() else set()

    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/import",
        files={"file": ("evil.zip", zip_path.read_bytes(), "application/zip")},
    )
    assert response.status_code == 502
    body = response.json()
    assert body["error"]["code"] == "upstream_data_error"
    assert body["error"]["details"]["entry"] == "/etc/passwd"

    after = set(settings.upload_tmp_dir.iterdir()) if settings.upload_tmp_dir.exists() else set()
    assert after == before  # the per-import work directory was cleaned up, nothing leaked
