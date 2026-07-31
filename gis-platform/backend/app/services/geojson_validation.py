"""Structural and geometric validation of a normalised GeoJSON FeatureCollection.

Pure: no database, no filesystem, no settings lookups. Everything the caller
needs to vary is a keyword argument, so the whole module is unit testable
without a running PostGIS -- which matters because this is the code that
decides whether anything gets written at all.

Every rule maps to a stable snake_case `code` that reaches the client
unchanged, so the UI can key off codes rather than parsing prose.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from typing import Any

SUPPORTED_GEOMETRY_TYPES = frozenset(
    {"Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"}
)

# How deeply `coordinates` nests before reaching a position ([x, y]).
# Point's coordinates *are* a position, so depth 0; a Polygon is a list of
# rings which are lists of positions, so depth 2. Driving the structural
# check off this table keeps one implementation for all six types.
_COORDINATE_DEPTH = {
    "Point": 0,
    "MultiPoint": 1,
    "LineString": 1,
    "MultiLineString": 2,
    "Polygon": 2,
    "MultiPolygon": 3,
}

# Minimum positions in the innermost list, by type.
_MIN_POSITIONS = {"LineString": 2, "MultiLineString": 2, "Polygon": 4, "MultiPolygon": 4}

# Types whose innermost lists are linear rings that must be closed.
_RING_TYPES = {"Polygon", "MultiPolygon"}


@dataclass(frozen=True)
class Issue:
    feature_index: int
    field: str | None
    code: str
    message: str


@dataclass
class ValidationOutcome:
    features: list[dict[str, Any]] = field(default_factory=list)
    errors: list[Issue] = field(default_factory=list)
    warnings: list[Issue] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


def _is_position(value: Any) -> bool:
    return (
        isinstance(value, (list, tuple))
        and 2 <= len(value) <= 3
        and all(
            isinstance(number, (int, float)) and not isinstance(number, bool) for number in value
        )
    )


def _check_position(position: list[float], index: int, errors: list[Issue]) -> bool:
    """Range and finiteness. Returns False on the first problem found."""
    longitude, latitude = float(position[0]), float(position[1])
    for number in (longitude, latitude):
        if math.isnan(number) or math.isinf(number):
            errors.append(
                Issue(index, None, "coordinate_not_finite", "Coordinate is NaN or infinite")
            )
            return False
    if not -180.0 <= longitude <= 180.0 or not -90.0 <= latitude <= 90.0:
        errors.append(
            Issue(
                index,
                None,
                "coordinate_out_of_range",
                f"Coordinate ({longitude}, {latitude}) is outside "
                "longitude [-180, 180] / latitude [-90, 90]",
            )
        )
        return False
    return True


def _close_ring(ring: list[Any]) -> tuple[list[Any], bool]:
    """Repeat the first position at the end if the ring is open."""
    if len(ring) >= 3 and list(ring[0]) != list(ring[-1]):
        return [*ring, list(ring[0])], True
    return ring, False


def _walk(
    node: Any, depth: int, geometry_type: str, index: int, errors: list[Issue]
) -> tuple[Any, bool]:
    """Validate `node` at `depth` levels above a position; return (node, closed_a_ring)."""
    if depth == 0:
        if not _is_position(node):
            errors.append(
                Issue(index, None, "malformed_coordinates", "Expected a [longitude, latitude] pair")
            )
            return node, False
        return node, False

    if not isinstance(node, list) or not node:
        errors.append(
            Issue(
                index,
                None,
                "malformed_coordinates",
                f"Expected a non-empty array of {geometry_type} coordinates",
            )
        )
        return node, False

    closed_any = False
    if depth == 1:
        minimum = _MIN_POSITIONS.get(geometry_type)
        if geometry_type in _RING_TYPES:
            node, closed = _close_ring(node)
            closed_any = closed_any or closed
        if minimum is not None and len(node) < minimum:
            errors.append(
                Issue(
                    index,
                    None,
                    "malformed_coordinates",
                    f"{geometry_type} needs at least {minimum} positions, got {len(node)}",
                )
            )
            return node, closed_any

    rebuilt = []
    for child in node:
        new_child, closed = _walk(child, depth - 1, geometry_type, index, errors)
        closed_any = closed_any or closed
        rebuilt.append(new_child)
    return rebuilt, closed_any


def _validate_geometry(
    geometry: Any, index: int, errors: list[Issue], warnings: list[Issue]
) -> Any:
    if geometry is None or not isinstance(geometry, dict):
        errors.append(Issue(index, None, "missing_geometry", "Feature has no geometry"))
        return geometry

    geometry_type = geometry.get("type")
    if geometry_type not in SUPPORTED_GEOMETRY_TYPES:
        errors.append(
            Issue(
                index,
                None,
                "unsupported_geometry_type",
                f"Geometry type {geometry_type!r} is not supported",
            )
        )
        return geometry

    before = len(errors)
    coordinates, closed_a_ring = _walk(
        geometry.get("coordinates"), _COORDINATE_DEPTH[geometry_type], geometry_type, index, errors
    )
    if len(errors) > before:
        return geometry

    # Ranges are only meaningful once the structure is known good.
    for position in _positions(coordinates, _COORDINATE_DEPTH[geometry_type]):
        if not _check_position(position, index, errors):
            return geometry

    if closed_a_ring:
        warnings.append(
            Issue(
                index,
                None,
                "ring_auto_closed",
                "Polygon ring was not closed and was closed automatically",
            )
        )
    return {**geometry, "coordinates": coordinates}


def _positions(node: Any, depth: int) -> list[list[float]]:
    if depth == 0:
        return [node]
    return [position for child in node for position in _positions(child, depth - 1)]


def _validate_properties(properties: Any, index: int, errors: list[Issue]) -> dict[str, Any]:
    if properties is None:
        return {}
    if not isinstance(properties, dict):
        errors.append(
            Issue(index, None, "unsupported_property_value", "Feature properties must be an object")
        )
        return {}
    for key, value in properties.items():
        try:
            json.dumps(value)
        except (TypeError, ValueError):
            errors.append(
                Issue(
                    index,
                    str(key),
                    "unsupported_property_value",
                    f"Property {key!r} is not JSON-serialisable",
                )
            )
    return properties


def _property_warnings(features: list[dict[str, Any]], warnings: list[Issue]) -> None:
    """Sparse and mixed-type properties are notable but never fatal."""
    seen: dict[str, set[str]] = {}
    counts: dict[str, int] = {}
    for feature in features:
        for key, value in (feature.get("properties") or {}).items():
            counts[key] = counts.get(key, 0) + 1
            if value is not None:
                seen.setdefault(key, set()).add(type(value).__name__)

    total = len(features)
    for key in sorted(counts):
        if counts[key] < total:
            warnings.append(
                Issue(-1, key, "sparse_property", f"Property {key!r} is absent from some features")
            )
        if len(seen.get(key, set())) > 1:
            warnings.append(
                Issue(
                    -1,
                    key,
                    "mixed_property_type",
                    f"Property {key!r} holds more than one value type; stored as text",
                )
            )


def validate_feature_collection(collection: Any, *, max_features: int) -> ValidationOutcome:
    """Validate an already-normalised FeatureCollection.

    Normalisation (single Feature, plain arrays, record arrays) happens in the
    browser; by the time a document reaches here it must already be a
    FeatureCollection. Anything else is `unsupported_root`.
    """
    outcome = ValidationOutcome()

    if not isinstance(collection, dict) or collection.get("type") != "FeatureCollection":
        outcome.errors.append(
            Issue(-1, None, "unsupported_root", "Root must be a GeoJSON FeatureCollection")
        )
        return outcome

    raw = collection.get("features")
    if not isinstance(raw, list):
        outcome.errors.append(
            Issue(-1, None, "unsupported_root", "FeatureCollection.features must be an array")
        )
        return outcome

    if not raw:
        outcome.errors.append(Issue(-1, None, "empty_document", "Document contains no features"))
        return outcome

    if len(raw) > max_features:
        outcome.errors.append(
            Issue(
                -1,
                None,
                "too_many_features",
                f"{len(raw)} features exceeds the limit of {max_features}",
            )
        )
        return outcome

    for index, feature in enumerate(raw):
        if not isinstance(feature, dict):
            outcome.errors.append(
                Issue(index, None, "unsupported_root", "Feature must be an object")
            )
            continue
        geometry = _validate_geometry(
            feature.get("geometry"), index, outcome.errors, outcome.warnings
        )
        properties = _validate_properties(feature.get("properties"), index, outcome.errors)
        outcome.features.append({"type": "Feature", "geometry": geometry, "properties": properties})

    _property_warnings(outcome.features, outcome.warnings)
    return outcome
