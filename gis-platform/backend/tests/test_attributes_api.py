import json

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.source import PostgisSource


@pytest.fixture
async def cities_layer(client: AsyncClient, seeded_spatial_table: PostgisSource) -> dict:
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    return (
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


async def test_fields_excludes_geometry_and_marks_the_key(
    client: AsyncClient, cities_layer: dict
) -> None:
    body = (await client.get(f"/api/v1/layers/{cities_layer['id']}/fields")).json()
    names = [field["name"] for field in body["fields"]]
    assert names == ["fid", "name", "population"]
    assert body["idColumn"] == "fid"
    assert body["geometryColumn"] == "geometry"
    population = next(f for f in body["fields"] if f["name"] == "population")
    assert population["dataType"] == "integer"
    assert population["editable"] is True


async def test_attribute_page_returns_rows_and_total(
    client: AsyncClient, cities_layer: dict
) -> None:
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/attributes",
            params={"page": 1, "pageSize": 2},
        )
    ).json()
    assert body["total"] == 3
    assert body["page"] == 1
    assert body["pageSize"] == 2
    assert len(body["rows"]) == 2
    assert body["columns"] == ["fid", "name", "population"]
    assert "geometry" not in body["rows"][0]


async def test_second_page_returns_the_remainder(client: AsyncClient, cities_layer: dict) -> None:
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/attributes",
            params={"page": 2, "pageSize": 2},
        )
    ).json()
    assert len(body["rows"]) == 1


async def test_sorting_by_a_real_column(client: AsyncClient, cities_layer: dict) -> None:
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/attributes",
            params={"sortBy": "population", "sortOrder": "desc"},
        )
    ).json()
    assert [row["name"] for row in body["rows"]] == ["Shanghai", "Beijing", "Lhasa"]


async def test_sorting_by_an_unknown_column_is_rejected(
    client: AsyncClient, cities_layer: dict
) -> None:
    response = await client.get(
        f"/api/v1/layers/{cities_layer['id']}/attributes", params={"sortBy": "nope"}
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


async def test_sort_by_injection_attempt_is_rejected(
    client: AsyncClient, cities_layer: dict
) -> None:
    response = await client.get(
        f"/api/v1/layers/{cities_layer['id']}/attributes",
        params={"sortBy": "population; DROP TABLE gis.layer"},
    )
    assert response.status_code == 422
    assert (await client.get("/api/v1/projects")).status_code == 200


async def test_structured_filter_narrows_the_result(
    client: AsyncClient, cities_layer: dict
) -> None:
    filters = json.dumps([{"field": "population", "op": "gte", "value": 1000000}])
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/attributes", params={"filters": filters}
        )
    ).json()
    assert body["total"] == 2
    assert {row["name"] for row in body["rows"]} == {"Beijing", "Shanghai"}


async def test_like_filter_is_parameterised(client: AsyncClient, cities_layer: dict) -> None:
    filters = json.dumps([{"field": "name", "op": "like", "value": "%hai"}])
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/attributes", params={"filters": filters}
        )
    ).json()
    assert [row["name"] for row in body["rows"]] == ["Shanghai"]


async def test_in_filter_accepts_a_list(client: AsyncClient, cities_layer: dict) -> None:
    filters = json.dumps([{"field": "name", "op": "in", "value": ["Lhasa", "Beijing"]}])
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/attributes", params={"filters": filters}
        )
    ).json()
    assert body["total"] == 2


async def test_filter_on_an_unknown_field_is_rejected(
    client: AsyncClient, cities_layer: dict
) -> None:
    filters = json.dumps([{"field": "secret", "op": "eq", "value": 1}])
    response = await client.get(
        f"/api/v1/layers/{cities_layer['id']}/attributes", params={"filters": filters}
    )
    assert response.status_code == 422


async def test_unknown_operator_is_rejected(client: AsyncClient, cities_layer: dict) -> None:
    filters = json.dumps([{"field": "name", "op": "regex", "value": ".*"}])
    response = await client.get(
        f"/api/v1/layers/{cities_layer['id']}/attributes", params={"filters": filters}
    )
    assert response.status_code == 422


async def test_page_size_is_capped(client: AsyncClient, cities_layer: dict) -> None:
    response = await client.get(
        f"/api/v1/layers/{cities_layer['id']}/attributes", params={"pageSize": 100000}
    )
    assert response.status_code == 422


# The remaining OPERATOR_SQL keys the brief's own tests don't exercise
# (eq, neq, gt, lt, lte, ilike, isnull, notnull) plus `in` against a numeric
# column -- added so every entry in that fixed dict has coverage, not just
# the three the brief happened to pick.


async def test_eq_filter_matches_an_exact_value(client: AsyncClient, cities_layer: dict) -> None:
    filters = json.dumps([{"field": "population", "op": "eq", "value": 560000}])
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/attributes", params={"filters": filters}
        )
    ).json()
    assert [row["name"] for row in body["rows"]] == ["Lhasa"]


async def test_neq_filter_excludes_a_value(client: AsyncClient, cities_layer: dict) -> None:
    filters = json.dumps([{"field": "population", "op": "neq", "value": 560000}])
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/attributes", params={"filters": filters}
        )
    ).json()
    assert {row["name"] for row in body["rows"]} == {"Beijing", "Shanghai"}


async def test_gt_filter_is_strict(client: AsyncClient, cities_layer: dict) -> None:
    filters = json.dumps([{"field": "population", "op": "gt", "value": 21540000}])
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/attributes", params={"filters": filters}
        )
    ).json()
    assert [row["name"] for row in body["rows"]] == ["Shanghai"]


async def test_lt_filter_is_strict(client: AsyncClient, cities_layer: dict) -> None:
    filters = json.dumps([{"field": "population", "op": "lt", "value": 21540000}])
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/attributes", params={"filters": filters}
        )
    ).json()
    assert [row["name"] for row in body["rows"]] == ["Lhasa"]


async def test_lte_filter_includes_the_boundary(client: AsyncClient, cities_layer: dict) -> None:
    filters = json.dumps([{"field": "population", "op": "lte", "value": 21540000}])
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/attributes", params={"filters": filters}
        )
    ).json()
    assert {row["name"] for row in body["rows"]} == {"Beijing", "Lhasa"}


async def test_ilike_filter_is_case_insensitive(client: AsyncClient, cities_layer: dict) -> None:
    filters = json.dumps([{"field": "name", "op": "ilike", "value": "%HAI"}])
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/attributes", params={"filters": filters}
        )
    ).json()
    assert [row["name"] for row in body["rows"]] == ["Shanghai"]


async def test_in_filter_works_on_a_numeric_column(client: AsyncClient, cities_layer: dict) -> None:
    filters = json.dumps([{"field": "population", "op": "in", "value": [21540000, 560000]}])
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/attributes", params={"filters": filters}
        )
    ).json()
    assert {row["name"] for row in body["rows"]} == {"Beijing", "Lhasa"}


@pytest.fixture
async def cities_layer_with_a_null_population(cities_layer: dict, db_session: AsyncSession) -> dict:
    await db_session.execute(
        text(
            "INSERT INTO gis_data.test_cities (name, population, geometry) VALUES "
            "('Unknown', NULL, ST_SetSRID(ST_MakePoint(0, 0), 4326))"
        )
    )
    await db_session.flush()
    return cities_layer


async def test_isnull_filter_finds_the_null_row(
    client: AsyncClient, cities_layer_with_a_null_population: dict
) -> None:
    filters = json.dumps([{"field": "population", "op": "isnull"}])
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer_with_a_null_population['id']}/attributes",
            params={"filters": filters},
        )
    ).json()
    assert [row["name"] for row in body["rows"]] == ["Unknown"]


async def test_notnull_filter_excludes_the_null_row(
    client: AsyncClient, cities_layer_with_a_null_population: dict
) -> None:
    filters = json.dumps([{"field": "population", "op": "notnull"}])
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer_with_a_null_population['id']}/attributes",
            params={"filters": filters},
        )
    ).json()
    assert body["total"] == 3
    assert "Unknown" not in {row["name"] for row in body["rows"]}
