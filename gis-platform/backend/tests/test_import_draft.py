"""Staged import: the browser sends a normalised FeatureCollection, the server
re-validates it and either writes all of it or none of it."""

from __future__ import annotations

from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import text

from app.db.sync_engine import get_sync_engine

POINT = {"type": "Point", "coordinates": [116.4074, 39.9042]}
POINT_2 = {"type": "Point", "coordinates": [91.1409, 29.6450]}


def draft(*features: dict[str, Any], name: str = "Cities") -> dict[str, Any]:
    return {
        "name": name,
        "sourceFilename": "cities.geojson",
        "featureCollection": {"type": "FeatureCollection", "features": list(features)},
    }


def feature(geometry: Any, **properties: Any) -> dict[str, Any]:
    return {"type": "Feature", "geometry": geometry, "properties": properties}


def imported_tables() -> list[str]:
    with get_sync_engine().begin() as conn:
        return list(
            conn.execute(
                text(
                    "SELECT tablename FROM pg_tables "
                    "WHERE schemaname = 'gis_data' AND tablename <> 'test_cities'"
                )
            ).scalars()
        )


@pytest.fixture(autouse=True)
async def drop_imported_tables():
    yield
    with get_sync_engine().begin() as conn:
        for table in imported_tables():
            conn.execute(text(f'DROP TABLE IF EXISTS gis_data."{table}" CASCADE'))


@pytest.fixture
async def project_id(client: AsyncClient) -> str:
    return (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]


async def post_draft(client: AsyncClient, project_id: str, body: dict[str, Any]):
    return await client.post(f"/api/v1/projects/{project_id}/layers/import-draft", json=body)


async def test_valid_draft_creates_a_layer_and_a_table(
    client: AsyncClient, project_id: str
) -> None:
    response = await post_draft(
        client,
        project_id,
        draft(feature(POINT, name="Beijing"), feature(POINT_2, name="Lhasa")),
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["importedCount"] == 2
    assert body["rejectedCount"] == 0
    assert body["errors"] == []

    layer = body["layer"]
    assert layer["kind"] == "vector"
    assert layer["name"] == "Cities"
    assert layer["featureCount"] == 2
    assert layer["srid"] == 4326
    assert layer["sourceFilename"] == "cities.geojson"
    assert layer["source"]["schemaName"] == "gis_data"
    assert layer["source"]["idColumn"] == "fid"
    assert imported_tables() != []


async def test_nested_properties_round_trip_through_jsonb(
    client: AsyncClient, project_id: str
) -> None:
    nested = {"sensor": {"bands": [1, 2, 3], "calibrated": True}}
    response = await post_draft(
        client, project_id, draft(feature(POINT, Name="Beijing", meta=nested))
    )
    assert response.status_code == 201, response.text
    layer_id = response.json()["layer"]["id"]

    rows = (await client.get(f"/api/v1/layers/{layer_id}/attributes")).json()["rows"]
    assert rows[0]["Name"] == "Beijing"  # original casing preserved
    assert rows[0]["meta"] == nested  # nesting preserved, not flattened


async def test_a_mixed_case_property_layer_renders_a_vector_tile(
    client: AsyncClient, project_id: str
) -> None:
    """Regression guard: `tile_repository.render_mvt` reads the same
    catalog-derived column list as the attribute page, so a layer with a
    non-lowercase property (like `Name` above) must be selectable there too,
    not just readable through /attributes."""
    response = await post_draft(client, project_id, draft(feature(POINT, Name="Beijing")))
    assert response.status_code == 201, response.text
    layer_id = response.json()["layer"]["id"]

    tile = await client.get(f"/api/v1/layers/{layer_id}/tiles/0/0/0.mvt")
    assert tile.status_code == 200
    assert len(tile.content) > 0
    assert b"Name" in tile.content


async def test_a_single_invalid_feature_rejects_the_whole_import(
    client: AsyncClient, project_id: str
) -> None:
    response = await post_draft(
        client,
        project_id,
        draft(
            feature(POINT, name="ok"),
            feature({"type": "Point", "coordinates": [999.0, 0.0]}, name="bad"),
            feature(POINT_2, name="ok too"),
        ),
    )
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "invalid_request"
    assert error["details"]["errors"][0]["code"] == "coordinate_out_of_range"
    assert error["details"]["errors"][0]["featureIndex"] == 1

    # Nothing was written: not the table, not the layer.
    assert imported_tables() == []
    project = (await client.get(f"/api/v1/projects/{project_id}")).json()
    assert project["layers"] == []


async def test_missing_geometry_is_rejected(client: AsyncClient, project_id: str) -> None:
    response = await post_draft(client, project_id, draft(feature(None, name="nowhere")))
    assert response.status_code == 422
    assert response.json()["error"]["details"]["errors"][0]["code"] == "missing_geometry"
    assert imported_tables() == []


async def test_an_empty_feature_collection_is_rejected(
    client: AsyncClient, project_id: str
) -> None:
    response = await post_draft(client, project_id, draft())
    assert response.status_code == 422
    assert response.json()["error"]["details"]["errors"][0]["code"] == "empty_document"


async def test_a_non_feature_collection_root_is_rejected(
    client: AsyncClient, project_id: str
) -> None:
    body = {
        "name": "X",
        "sourceFilename": "x.json",
        "featureCollection": {"type": "Point", "coordinates": [0, 0]},
    }
    response = await post_draft(client, project_id, body)
    assert response.status_code == 422
    assert response.json()["error"]["details"]["errors"][0]["code"] == "unsupported_root"


async def test_too_many_features_is_rejected(
    client: AsyncClient, project_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.services import draft_import_service

    monkeypatch.setattr(draft_import_service, "_max_features", lambda: 2)
    response = await post_draft(
        client, project_id, draft(feature(POINT), feature(POINT), feature(POINT))
    )
    assert response.status_code == 422
    assert response.json()["error"]["details"]["errors"][0]["code"] == "too_many_features"
    assert imported_tables() == []


async def test_mixed_attribute_types_import_with_a_warning(
    client: AsyncClient, project_id: str
) -> None:
    response = await post_draft(
        client, project_id, draft(feature(POINT, pop=100), feature(POINT_2, pop="many"))
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["importedCount"] == 2
    assert body["warningCount"] >= 1
    assert any(w["code"] == "mixed_property_type" for w in body["warnings"])


async def test_a_write_failure_after_the_bulk_write_leaves_no_table(
    client: AsyncClient, project_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """to_postgis commits on the sync engine before indexing runs, so a
    failure in that second window cannot be undone by the request rollback.
    The shared drop-on-failure guard must remove the table itself."""
    from app.services import vector_import_service

    def _boom(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("indexing failed")

    monkeypatch.setattr(vector_import_service, "_create_indexes", _boom)

    with pytest.raises(RuntimeError, match="indexing failed"):
        await post_draft(client, project_id, draft(feature(POINT, name="Beijing")))

    assert imported_tables() == []


async def test_a_duplicate_confirmation_conflicts_instead_of_creating_two_layers(
    client: AsyncClient, project_id: str
) -> None:
    body = draft(feature(POINT, name="Beijing"), name="Cities")

    first = await post_draft(client, project_id, body)
    assert first.status_code == 201, first.text

    second = await post_draft(client, project_id, body)
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "conflict"

    project = (await client.get(f"/api/v1/projects/{project_id}")).json()
    assert len(project["layers"]) == 1
    # The second write() runs before the conflict is detected and does
    # create a table -- the drop-on-failure guard must remove it.
    assert len(imported_tables()) == 1
