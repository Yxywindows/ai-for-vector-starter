"""R7: spatial analysis tools, executed through the task system.

Each test submits through the real API, drives the worker with the test
session, and asserts on the registered result layer — actual PostGIS
geometry math, not mocks.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.source import PostgisSource
from app.services import task_worker

POLYGONS = """
CREATE TABLE gis_data.test_zones (
    fid    serial PRIMARY KEY,
    zone   text NOT NULL,
    geometry geometry(Polygon, 4326)
)
"""

POLYGON_SEED = """
INSERT INTO gis_data.test_zones (zone, geometry) VALUES
    ('east', ST_GeomFromText('POLYGON((100 20, 130 20, 130 45, 100 45, 100 20))', 4326)),
    ('west', ST_GeomFromText('POLYGON((80 25, 95 25, 95 40, 80 40, 80 25))', 4326))
"""


@pytest.fixture
async def zones_table(db_session: AsyncSession, seeded_spatial_table: PostgisSource) -> None:
    await db_session.execute(text("DROP TABLE IF EXISTS gis_data.test_zones"))
    await db_session.execute(text(POLYGONS))
    await db_session.execute(text(POLYGON_SEED))
    await db_session.flush()


@pytest.fixture
async def analysis_project(client: AsyncClient, zones_table: None) -> dict:
    project_id = (await client.post("/api/v1/projects", json={"name": "Analysis"})).json()["id"]

    async def register(table: str, name: str) -> dict:
        return (
            await client.post(
                f"/api/v1/projects/{project_id}/layers/from-postgis",
                json={
                    "schemaName": "gis_data",
                    "tableName": table,
                    "geometryColumn": "geometry",
                    "idColumn": "fid",
                    "name": name,
                },
            )
        ).json()

    cities = await register("test_cities", "Cities")
    zones = await register("test_zones", "Zones")
    return {"projectId": project_id, "cities": cities, "zones": zones}


async def _run_and_fetch(
    client: AsyncClient, db_session: AsyncSession, task: dict
) -> tuple[dict, dict]:
    assert await task_worker.run_once(db_session) is True
    detail = (await client.get(f"/api/v1/tasks/{task['id']}")).json()
    assert detail["state"] == "succeeded", detail.get("error")
    layer = (await client.get(f"/api/v1/layers/{detail['result']['layerId']}")).json()
    return detail, layer


async def test_buffer_produces_polygons_with_source_attributes(
    client: AsyncClient, db_session: AsyncSession, analysis_project: dict
) -> None:
    pid = analysis_project["projectId"]
    submitted = await client.post(
        f"/api/v1/projects/{pid}/analysis/buffer",
        json={
            "layerId": analysis_project["cities"]["id"],
            "distanceMeters": 50_000,
            "outputName": "Cities buffered",
        },
    )
    assert submitted.status_code == 202, submitted.text
    detail, layer = await _run_and_fetch(client, db_session, submitted.json())

    assert layer["kind"] == "vector"
    assert layer["featureCount"] == 3
    assert layer["geometryType"] == "POLYGON"
    assert detail["result"]["distanceMeters"] == 50_000
    fields = (await client.get(f"/api/v1/layers/{layer['id']}/fields")).json()
    names = [field["name"] for field in fields["fields"]]
    assert "name" in names
    assert "population" in names


async def test_clip_keeps_only_masked_features(
    client: AsyncClient, db_session: AsyncSession, analysis_project: dict
) -> None:
    pid = analysis_project["projectId"]
    submitted = await client.post(
        f"/api/v1/projects/{pid}/analysis/clip",
        json={
            "layerId": analysis_project["cities"]["id"],
            "maskLayerId": analysis_project["zones"]["id"],
            "outputName": "Cities in zones",
        },
    )
    _, layer = await _run_and_fetch(client, db_session, submitted.json())
    # Beijing (116.4, 39.9) and Shanghai (121.5, 31.2) fall in the east
    # zone; Lhasa (91.1, 29.6) in the west zone.
    assert layer["featureCount"] == 3


async def test_intersection_pairs_overlapping_features(
    client: AsyncClient, db_session: AsyncSession, analysis_project: dict
) -> None:
    pid = analysis_project["projectId"]
    submitted = await client.post(
        f"/api/v1/projects/{pid}/analysis/intersection",
        json={
            "layerId": analysis_project["zones"]["id"],
            "otherLayerId": analysis_project["zones"]["id"],
            "outputName": "Zone self-intersection",
        },
    )
    _, layer = await _run_and_fetch(client, db_session, submitted.json())
    # Self-intersection: each zone intersects itself, zones don't overlap
    # each other -> exactly 2 pairs.
    assert layer["featureCount"] == 2
    fields = (await client.get(f"/api/v1/layers/{layer['id']}/fields")).json()
    names = [field["name"] for field in fields["fields"]]
    assert "a_zone" in names
    assert "b_zone" in names


async def test_dissolve_by_field_groups_and_counts(
    client: AsyncClient, db_session: AsyncSession, analysis_project: dict
) -> None:
    pid = analysis_project["projectId"]
    submitted = await client.post(
        f"/api/v1/projects/{pid}/analysis/dissolve",
        json={
            "layerId": analysis_project["zones"]["id"],
            "byField": "zone",
            "outputName": "Zones dissolved",
        },
    )
    _, layer = await _run_and_fetch(client, db_session, submitted.json())
    assert layer["featureCount"] == 2

    unknown = await client.post(
        f"/api/v1/projects/{pid}/analysis/dissolve",
        json={
            "layerId": analysis_project["zones"]["id"],
            "byField": "nope",
            "outputName": "Bad dissolve",
        },
    )
    assert await task_worker.run_once(db_session) is True
    failed = (await client.get(f"/api/v1/tasks/{unknown.json()['id']}")).json()
    assert failed["state"] == "failed"
    assert failed["error"]["code"] == "invalid_request"


async def test_spatial_join_attaches_zone_attributes_to_cities(
    client: AsyncClient, db_session: AsyncSession, analysis_project: dict
) -> None:
    pid = analysis_project["projectId"]
    submitted = await client.post(
        f"/api/v1/projects/{pid}/analysis/spatial-join",
        json={
            "targetLayerId": analysis_project["cities"]["id"],
            "joinLayerId": analysis_project["zones"]["id"],
            "predicate": "within",
            "outputName": "Cities with zones",
        },
    )
    _, layer = await _run_and_fetch(client, db_session, submitted.json())
    assert layer["featureCount"] == 3

    rows = (
        await client.get(f"/api/v1/layers/{layer['id']}/attributes", params={"sortBy": "name"})
    ).json()["rows"]
    by_name = {row["name"]: row for row in rows}
    assert by_name["Beijing"]["join_zone"] == "east"
    assert by_name["Lhasa"]["join_zone"] == "west"


async def test_validate_repair_reports_and_fixes_invalid_geometry(
    client: AsyncClient, db_session: AsyncSession, analysis_project: dict
) -> None:
    # A self-intersecting bowtie: classically invalid.
    await db_session.execute(
        text(
            "INSERT INTO gis_data.test_zones (zone, geometry) VALUES "
            "('bowtie', ST_GeomFromText('POLYGON((0 0, 2 2, 2 0, 0 2, 0 0))', 4326))"
        )
    )
    await db_session.flush()

    pid = analysis_project["projectId"]
    submitted = await client.post(
        f"/api/v1/projects/{pid}/analysis/validate-repair",
        json={"layerId": analysis_project["zones"]["id"], "outputName": "Zones repaired"},
    )
    detail, layer = await _run_and_fetch(client, db_session, submitted.json())
    assert detail["result"]["repairedCount"] == 1
    assert layer["featureCount"] == 3

    source = layer["source"]
    invalid_left = (
        await db_session.execute(
            text(
                f'SELECT count(*) FROM gis_data."{source["tableName"]}" '
                "WHERE NOT ST_IsValid(geometry)"
            )
        )
    ).scalar_one()
    assert invalid_left == 0


async def test_point_in_polygon_counts_cities_per_zone(
    client: AsyncClient, db_session: AsyncSession, analysis_project: dict
) -> None:
    pid = analysis_project["projectId"]
    submitted = await client.post(
        f"/api/v1/projects/{pid}/analysis/point-in-polygon",
        json={
            "pointsLayerId": analysis_project["cities"]["id"],
            "polygonsLayerId": analysis_project["zones"]["id"],
            "outputName": "Cities per zone",
        },
    )
    _, layer = await _run_and_fetch(client, db_session, submitted.json())

    rows = (
        await client.get(f"/api/v1/layers/{layer['id']}/attributes", params={"sortBy": "zone"})
    ).json()["rows"]
    counts = {row["zone"]: row["point_count"] for row in rows}
    assert counts == {"east": 2, "west": 1}


async def test_analysis_rejects_non_vector_inputs(
    client: AsyncClient, db_session: AsyncSession, analysis_project: dict
) -> None:
    pid = analysis_project["projectId"]
    basemap = (
        await client.post(
            f"/api/v1/projects/{pid}/layers",
            json={
                "name": "Base",
                "kind": "basemap",
                "source": {"type": "xyz", "url": "https://t/{z}/{x}/{y}.png", "attribution": None},
            },
        )
    ).json()
    submitted = await client.post(
        f"/api/v1/projects/{pid}/analysis/buffer",
        json={"layerId": basemap["id"], "distanceMeters": 10, "outputName": "Nope"},
    )
    assert submitted.status_code == 202  # queued fine; the handler validates
    assert await task_worker.run_once(db_session) is True
    failed = (await client.get(f"/api/v1/tasks/{submitted.json()['id']}")).json()
    assert failed["state"] == "failed"
    assert failed["error"]["code"] == "invalid_request"
    assert "vector" in failed["error"]["message"]
