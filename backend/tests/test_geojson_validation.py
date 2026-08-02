"""Pure validation tests: no database, no fixtures, no I/O."""

from __future__ import annotations

from typing import Any

import pytest

from app.services.geojson_validation import validate_feature_collection


def collection(*geometries: Any, properties: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "geometry": geometry, "properties": properties or {}}
            for geometry in geometries
        ],
    }


def codes(issues: list[Any]) -> list[str]:
    return [issue.code for issue in issues]


POINT = {"type": "Point", "coordinates": [116.4, 39.9]}
MULTIPOINT = {"type": "MultiPoint", "coordinates": [[116.4, 39.9], [121.5, 31.2]]}
LINESTRING = {"type": "LineString", "coordinates": [[116.4, 39.9], [121.5, 31.2]]}
MULTILINESTRING = {
    "type": "MultiLineString",
    "coordinates": [[[116.4, 39.9], [121.5, 31.2]], [[0.0, 0.0], [1.0, 1.0]]],
}
POLYGON = {
    "type": "Polygon",
    "coordinates": [[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 0.0]]],
}
MULTIPOLYGON = {
    "type": "MultiPolygon",
    "coordinates": [[[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 0.0]]]],
}


@pytest.mark.parametrize(
    "geometry", [POINT, MULTIPOINT, LINESTRING, MULTILINESTRING, POLYGON, MULTIPOLYGON]
)
def test_accepts_every_supported_geometry_type(geometry: dict[str, Any]) -> None:
    outcome = validate_feature_collection(collection(geometry), max_features=100)
    assert outcome.errors == []
    assert len(outcome.features) == 1


def test_rejects_an_empty_document() -> None:
    outcome = validate_feature_collection(collection(), max_features=100)
    assert codes(outcome.errors) == ["empty_document"]


def test_rejects_a_non_feature_collection_root() -> None:
    outcome = validate_feature_collection(
        {"type": "Point", "coordinates": [0, 0]}, max_features=100
    )
    assert codes(outcome.errors) == ["unsupported_root"]


def test_rejects_a_missing_geometry() -> None:
    outcome = validate_feature_collection(collection(None), max_features=100)
    assert codes(outcome.errors) == ["missing_geometry"]


def test_rejects_an_unsupported_geometry_type() -> None:
    geometry = {"type": "GeometryCollection", "geometries": []}
    outcome = validate_feature_collection(collection(geometry), max_features=100)
    assert codes(outcome.errors) == ["unsupported_geometry_type"]


@pytest.mark.parametrize(
    "coordinates",
    [
        "not-an-array",
        [],
        [116.4],
        [[116.4, 39.9]],  # nested one level too deep for a Point
    ],
)
def test_rejects_malformed_point_coordinates(coordinates: Any) -> None:
    geometry = {"type": "Point", "coordinates": coordinates}
    outcome = validate_feature_collection(collection(geometry), max_features=100)
    assert codes(outcome.errors) == ["malformed_coordinates"]


def test_rejects_a_linestring_with_one_position() -> None:
    geometry = {"type": "LineString", "coordinates": [[116.4, 39.9]]}
    outcome = validate_feature_collection(collection(geometry), max_features=100)
    assert codes(outcome.errors) == ["malformed_coordinates"]


def test_rejects_malformed_multipoint_coordinates() -> None:
    geometry = {"type": "MultiPoint", "coordinates": "not-an-array"}
    outcome = validate_feature_collection(collection(geometry), max_features=100)
    assert codes(outcome.errors) == ["malformed_coordinates"]


def test_rejects_malformed_multilinestring_coordinates() -> None:
    geometry = {"type": "MultiLineString", "coordinates": "not-an-array"}
    outcome = validate_feature_collection(collection(geometry), max_features=100)
    assert codes(outcome.errors) == ["malformed_coordinates"]


def test_rejects_a_multilinestring_line_with_one_position() -> None:
    geometry = {
        "type": "MultiLineString",
        "coordinates": [[[116.4, 39.9], [121.5, 31.2]], [[0.0, 0.0]]],
    }
    outcome = validate_feature_collection(collection(geometry), max_features=100)
    assert codes(outcome.errors) == ["malformed_coordinates"]


def test_rejects_malformed_multipolygon_coordinates() -> None:
    geometry = {"type": "MultiPolygon", "coordinates": "not-an-array"}
    outcome = validate_feature_collection(collection(geometry), max_features=100)
    assert codes(outcome.errors) == ["malformed_coordinates"]


def test_rejects_a_multipolygon_ring_below_the_minimum_position_count() -> None:
    geometry = {
        "type": "MultiPolygon",
        "coordinates": [[[[0.0, 0.0], [1.0, 1.0]]]],
    }
    outcome = validate_feature_collection(collection(geometry), max_features=100)
    assert codes(outcome.errors) == ["malformed_coordinates"]


def test_closes_an_unclosed_ring_nested_inside_a_multipolygon_and_warns() -> None:
    unclosed = {
        "type": "MultiPolygon",
        "coordinates": [[[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]]],
    }
    outcome = validate_feature_collection(collection(unclosed), max_features=100)
    assert outcome.errors == []
    assert codes(outcome.warnings) == ["ring_auto_closed"]
    ring = outcome.features[0]["geometry"]["coordinates"][0][0]
    assert ring[0] == ring[-1]
    assert len(ring) == 4


@pytest.mark.parametrize("position", [[181.0, 39.9], [-181.0, 39.9], [116.4, 91.0], [116.4, -91.0]])
def test_rejects_out_of_range_coordinates(position: list[float]) -> None:
    geometry = {"type": "Point", "coordinates": position}
    outcome = validate_feature_collection(collection(geometry), max_features=100)
    assert codes(outcome.errors) == ["coordinate_out_of_range"]


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_rejects_non_finite_coordinates(bad: float) -> None:
    geometry = {"type": "Point", "coordinates": [bad, 39.9]}
    outcome = validate_feature_collection(collection(geometry), max_features=100)
    assert codes(outcome.errors) == ["coordinate_not_finite"]


def test_rejects_more_features_than_the_configured_maximum() -> None:
    outcome = validate_feature_collection(collection(POINT, POINT, POINT), max_features=2)
    assert codes(outcome.errors) == ["too_many_features"]


def test_closes_an_unclosed_polygon_ring_and_warns() -> None:
    unclosed = {
        "type": "Polygon",
        "coordinates": [[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]],
    }
    outcome = validate_feature_collection(collection(unclosed), max_features=100)
    assert outcome.errors == []
    assert codes(outcome.warnings) == ["ring_auto_closed"]
    ring = outcome.features[0]["geometry"]["coordinates"][0]
    assert ring[0] == ring[-1]
    assert len(ring) == 4


def test_reports_the_index_of_the_offending_feature() -> None:
    outcome = validate_feature_collection(
        collection(POINT, {"type": "Point", "coordinates": [999.0, 0.0]}, POINT),
        max_features=100,
    )
    assert [issue.feature_index for issue in outcome.errors] == [1]


def test_preserves_property_names_values_and_nesting_exactly() -> None:
    properties = {
        "Name": "Beijing",
        "unknown_key": None,
        "nested": {"a": [1, 2, {"b": True}]},
        "tags": ["x", "y"],
    }
    outcome = validate_feature_collection(
        collection(POINT, properties=properties), max_features=100
    )
    assert outcome.errors == []
    assert outcome.features[0]["properties"] == properties


def test_mixed_attribute_types_warn_but_do_not_coerce_or_reject() -> None:
    document = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "geometry": POINT, "properties": {"pop": 100}},
            {"type": "Feature", "geometry": POINT, "properties": {"pop": "many"}},
        ],
    }
    outcome = validate_feature_collection(document, max_features=100)
    assert outcome.errors == []
    assert codes(outcome.warnings) == ["mixed_property_type"]
    assert outcome.features[0]["properties"]["pop"] == 100
    assert outcome.features[1]["properties"]["pop"] == "many"


def test_warns_when_a_property_is_absent_from_some_features() -> None:
    document = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "geometry": POINT, "properties": {"a": 1, "b": 2}},
            {"type": "Feature", "geometry": POINT, "properties": {"a": 1}},
        ],
    }
    outcome = validate_feature_collection(document, max_features=100)
    assert outcome.errors == []
    assert codes(outcome.warnings) == ["sparse_property"]


def test_rejects_a_property_value_that_is_not_json_serialisable() -> None:
    document = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "geometry": POINT, "properties": {"when": object()}},
        ],
    }
    outcome = validate_feature_collection(document, max_features=100)
    assert codes(outcome.errors) == ["unsupported_property_value"]


def test_rejects_a_top_level_nan_property_value() -> None:
    document = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "geometry": POINT, "properties": {"score": float("nan")}},
        ],
    }
    outcome = validate_feature_collection(document, max_features=100)
    assert codes(outcome.errors) == ["unsupported_property_value"]


def test_rejects_a_nan_nested_inside_an_object_property() -> None:
    document = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": POINT,
                "properties": {"stats": {"mean": float("nan")}},
            },
        ],
    }
    outcome = validate_feature_collection(document, max_features=100)
    assert codes(outcome.errors) == ["unsupported_property_value"]


def test_rejects_a_nan_nested_inside_a_list_property() -> None:
    document = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": POINT,
                "properties": {"samples": [1, 2, float("nan")]},
            },
        ],
    }
    outcome = validate_feature_collection(document, max_features=100)
    assert codes(outcome.errors) == ["unsupported_property_value"]
