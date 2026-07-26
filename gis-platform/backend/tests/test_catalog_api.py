from httpx import AsyncClient

from app.schemas.source import PostgisSource


async def test_lists_geometry_tables_including_the_seeded_one(
    client: AsyncClient, seeded_spatial_table: PostgisSource
) -> None:
    response = await client.get("/api/v1/connections/postgis/tables")
    assert response.status_code == 200
    tables = response.json()
    match = next(t for t in tables if t["tableName"] == "test_cities")
    assert match["schemaName"] == "gis_data"
    assert match["geometryColumn"] == "geometry"
    assert match["srid"] == 4326
    assert match["geometryType"] == "POINT"
    assert match["primaryKey"] == "fid"


async def test_catalog_hides_postgis_internal_schemas(client: AsyncClient) -> None:
    tables = (await client.get("/api/v1/connections/postgis/tables")).json()
    assert all(t["schemaName"] not in {"topology", "tiger", "pg_catalog"} for t in tables)


async def test_register_table_creates_a_layer_with_extent_and_count(
    client: AsyncClient, seeded_spatial_table: PostgisSource
) -> None:
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/from-postgis",
        json={
            "schemaName": "gis_data",
            "tableName": "test_cities",
            "geometryColumn": "geometry",
            "idColumn": "fid",
            "name": "Cities",
        },
    )
    assert response.status_code == 201
    layer = response.json()
    assert layer["kind"] == "vector"
    assert layer["srid"] == 4326
    assert layer["featureCount"] == 3
    assert layer["geometryType"] == "POINT"
    minx, miny, maxx, maxy = layer["extent"]
    assert 91.0 < minx < 91.2
    assert 29.6 < miny < 29.7
    assert 121.4 < maxx < 121.5
    assert 39.9 < maxy < 40.0
    assert layer["source"]["type"] == "postgis"


async def test_register_rejects_an_unknown_table(client: AsyncClient) -> None:
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/from-postgis",
        json={
            "schemaName": "gis_data",
            "tableName": "no_such_table",
            "geometryColumn": "geometry",
            "idColumn": "fid",
            "name": "Nope",
        },
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_register_rejects_an_unknown_geometry_column(
    client: AsyncClient, seeded_spatial_table: PostgisSource
) -> None:
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/from-postgis",
        json={
            "schemaName": "gis_data",
            "tableName": "test_cities",
            "geometryColumn": "shape",
            "idColumn": "fid",
            "name": "Nope",
        },
    )
    assert response.status_code == 404


async def test_register_rejects_an_injection_shaped_name(client: AsyncClient) -> None:
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/from-postgis",
        json={
            "schemaName": "gis_data",
            "tableName": "test_cities; DROP TABLE gis.layer",
            "geometryColumn": "geometry",
            "idColumn": "fid",
            "name": "Evil",
        },
    )
    assert response.status_code == 422
    # And the platform tables are still there.
    assert (await client.get("/api/v1/projects")).status_code == 200
