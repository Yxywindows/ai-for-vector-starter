# Staged JSON/GeoJSON Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user pick a `.json`/`.geojson` file, preview and edit it against a map and an attribute grid, and write it to PostGIS only after clicking Confirm Import.

**Architecture:** The browser parses and normalises the file in a Web Worker into an in-memory *import draft* that never touches the server. The draft is previewed in a full-screen overlay with its own OpenLayers map and an ag-grid attribute table, edited through an undo/redo command stack, and POSTed as one normalised `FeatureCollection` on confirm. The server re-validates every feature before writing anything, then reuses the existing `vector_import_service` write path (`to_postgis` + PK/identity + GIST index + drop-on-failure), so a rejected or failed import leaves no table and no layer row.

**Tech Stack:** Python 3.12 · FastAPI · SQLAlchemy 2.0 async · Alembic · PostgreSQL 16 + PostGIS 3.4 · geopandas/shapely · pytest — React 19 · TypeScript · Vite 8 · OpenLayers 10 · TanStack Query 5 · Zustand 5 · ag-grid-community 36 · Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-07-31-staged-geojson-import-design.md`

## Global Constraints

Every task inherits these. Do not restate them per task; do not violate them.

- **Module root:** all code lives under `gis-platform/`. Do not touch `frontend/`, `backend/`, or `api-learning-lab/` at the repository root. **Do not delete, move, or promote any root module** — the repository reorganisation is explicitly out of scope for this plan.
- **Working directory:** backend commands run from `gis-platform/backend/`; frontend commands from `gis-platform/web/`.
- **Test database:** every `pytest` invocation runs with this exported. Bare `pytest` in a step always means "with this set".
  ```bash
  export GIS_DATABASE_URL=postgresql+asyncpg://gis:gis@localhost:5401/gis_platform_test
  ```
- **Quality gate — every task must end green:**
  - backend: `ruff check . && ruff format --check . && mypy app && pytest`
  - frontend: `npm run lint && npm run typecheck && npm run test -- --run`
- **API prefix:** `/api/v1`. **JSON casing:** camelCase on the wire, snake_case in Python — every request/response model inherits `APIModel` from `app/schemas/base.py`.
- **Error envelope:** every non-2xx from application code is `{"error": {"code", "message", "details"}}`, raised via an `AppError` subclass from `app/core/errors.py`. Never invent a new envelope.
- **CRS:** the wire is EPSG:4326; storage SRID for imported tables is 4326.
- **Dependency limits:** `ag-grid-community@36.0.2` and `ag-grid-react@36.0.2` only. **No Enterprise modules, no license key, no feature requiring one.** No other new runtime dependency in either tier.
- **Do not modify** `web/src/features/attributes/AttributeTable.tsx` or its tests. It serves persisted layers; ag-grid serves the draft only.
- **Backend test files are flat:** `backend/tests/test_<topic>.py`. There are no `tests/services/` or `tests/api/` subdirectories.
- **Importing user is out of scope.** Do not add an `imported_by` column, a header-derived identity, or a placeholder user. See spec §"Known gap".
- **Commit style:** Conventional Commits. Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```

## File Structure

```
gis-platform/backend/
├── app/core/config.py                        MODIFY  4 import settings
├── app/models/layer.py                       MODIFY  source_filename column
├── app/schemas/layer.py                      MODIFY  source_filename on LayerRead
├── app/schemas/system.py                     MODIFY  ImportLimits
├── app/schemas/import_draft.py               CREATE  wire models for the draft
├── app/services/system_service.py            MODIFY  import_limits()
├── app/services/geojson_validation.py        CREATE  pure validation, no DB
├── app/services/vector_import_service.py     MODIFY  extract write_frame_and_register
├── app/services/draft_import_service.py      CREATE  validate → frame → write
├── app/api/v1/routes/system.py               MODIFY  GET /system/import-limits
├── app/api/v1/routes/imports.py              MODIFY  POST .../layers/import-draft
├── migrations/versions/0002_layer_source_filename.py   CREATE
└── tests/
    ├── test_geojson_validation.py            CREATE  pure, no DB
    ├── test_import_draft.py                  CREATE  against PostGIS
    ├── test_system_api.py                    MODIFY  import-limits case
    └── test_layers_api.py                    MODIFY  sourceFilename exposure

gis-platform/web/
├── package.json                              MODIFY  ag-grid deps
├── src/index.css                             MODIFY  append .import-preview rules
├── src/api/types.ts                          MODIFY  draft + limits types
├── src/api/imports.ts                        CREATE  confirmImportDraft, getImportLimits
└── src/features/import/
    ├── parseGeoJson.ts        CREATE  pure parse + normalise + infer
    ├── parseWorker.ts         CREATE  worker entry
    ├── useParseWorker.ts      CREATE  worker lifecycle + main-thread fallback
    ├── workerTypes.ts         CREATE  shared worker message types
    ├── validation.ts          CREATE  client mirror of server rules
    ├── useImportDraft.ts      CREATE  draft state + undo/redo command stack
    ├── DraftGrid.tsx          CREATE  ag-grid configuration
    ├── PreviewMap.tsx         CREATE  own OlMap + draft source + selection
    └── ImportPreview.tsx      CREATE  overlay workspace, owns selection state
└── src/features/layers/AddLayerDialog.tsx    MODIFY  route .json/.geojson to preview
```

Each frontend file is deliberately small and single-purpose: the pure logic (`parseGeoJson`, `validation`, `useImportDraft`) is separated from the React surface so it is unit-testable without a DOM, a worker, or a map.

## Task Order and Milestones

| # | Task | Independently verifiable milestone |
|---|---|---|
| 1 | Import limits config + endpoint | `GET /api/v1/system/import-limits` returns configured values |
| 2 | GeoJSON validation module | Every rule in the spec's table has a passing test, no DB needed |
| 3 | `source_filename` column | Migration up/down round-trips; `LayerRead` exposes `sourceFilename` |
| 4 | Extract shared write path | Existing `test_vector_import.py` passes **unmodified** |
| 5 | Draft import service + endpoint | Full backend flow: valid import, rejection, rollback, duplicate |
| 6 | Frontend parser | All four roots normalise; columns union across all features |
| 7 | Client validation mirror | Same codes as the server for the same inputs |
| 8 | Draft state + command stack | Edit / undo / redo / dirty verified |
| 9 | Web Worker | Parses off-thread; falls back on worker failure |
| 10 | ag-grid DraftGrid | Editors, JSON cells, search, delete, add/rename column |
| 11 | PreviewMap | Draft renders; selection syncs both ways |
| 12 | ImportPreview + wiring | End-to-end staged import from file pick to refreshed layer list |

Tasks 1–5 are backend and land in order. Tasks 6–9 are pure TypeScript and depend on nothing but each other. Tasks 10–12 build the UI. Task 12 is the only task that changes existing user-facing behaviour.

---

## Task 1: Import Limits Configuration and Endpoint

Publishes the configurable limits so the client enforces exactly what the server enforces. `MemoryReport` already publishes `feature_bbox_limit` and `attribute_page_max` this way — follow that precedent.

**Files:**
- Modify: `gis-platform/backend/app/core/config.py`
- Modify: `gis-platform/backend/app/schemas/system.py`
- Modify: `gis-platform/backend/app/services/system_service.py`
- Modify: `gis-platform/backend/app/api/v1/routes/system.py`
- Test: `gis-platform/backend/tests/test_system_api.py`

**Interfaces:**
- Produces: `Settings.import_allowed_extensions: list[str]`, `Settings.import_max_file_bytes: int`, `Settings.import_max_features: int`, `Settings.import_preview_max_features: int`; `ImportLimits` schema; `system_service.import_limits() -> ImportLimits`; `GET /api/v1/system/import-limits`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Append to `gis-platform/backend/tests/test_system_api.py`:

```python
async def test_import_limits_reports_the_configured_values(client: AsyncClient) -> None:
    response = await client.get("/api/v1/system/import-limits")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["allowedExtensions"] == [".json", ".geojson"]
    assert body["maxFileBytes"] == 64 * 1024 * 1024
    assert body["maxFeatures"] == 50_000
    assert body["previewMaxFeatures"] == 5_000
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_system_api.py::test_import_limits_reports_the_configured_values -v`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 3: Add the settings**

In `app/core/config.py`, after the `# Memory guard rails` block:

```python
    # Staged JSON/GeoJSON import
    import_allowed_extensions: list[str] = [".json", ".geojson"]
    import_max_file_bytes: int = 64 * 1024 * 1024
    import_max_features: int = 50_000
    import_preview_max_features: int = 5_000
```

- [ ] **Step 4: Add the schema**

In `app/schemas/system.py`, after `MemoryReport`:

```python
class ImportLimits(APIModel):
    allowed_extensions: list[str]
    max_file_bytes: int
    max_features: int
    preview_max_features: int
```

- [ ] **Step 5: Add the service function**

In `app/services/system_service.py`, import `ImportLimits` alongside the existing schema imports and add:

```python
def import_limits() -> ImportLimits:
    settings = get_settings()
    return ImportLimits(
        allowed_extensions=settings.import_allowed_extensions,
        max_file_bytes=settings.import_max_file_bytes,
        max_features=settings.import_max_features,
        preview_max_features=settings.import_preview_max_features,
    )
```

- [ ] **Step 6: Add the route**

In `app/api/v1/routes/system.py`:

```python
from app.schemas.system import ImportLimits, MemoryReport


@router.get("/import-limits", response_model=ImportLimits)
def import_limits() -> ImportLimits:
    return system_service.import_limits()
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pytest tests/test_system_api.py -v`
Expected: PASS, including the pre-existing memory-report tests.

- [ ] **Step 8: Run the full gate**

Run: `ruff check . && ruff format --check . && mypy app && pytest`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add app/core/config.py app/schemas/system.py app/services/system_service.py \
        app/api/v1/routes/system.py tests/test_system_api.py
git commit -m "feat: publish staged-import limits from settings

The client must enforce the same file-size, feature-count and extension
limits the server enforces. Following the MemoryReport precedent, they are
configured once on Settings and read over /system/import-limits rather than
duplicated as client constants that can drift.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: GeoJSON Validation Module

Pure functions over parsed JSON: no database, no filesystem, no network. This is the module the endpoint trusts, and the one the client mirrors in Task 7.

**Files:**
- Create: `gis-platform/backend/app/services/geojson_validation.py`
- Test: `gis-platform/backend/tests/test_geojson_validation.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Issue` dataclass — `feature_index: int`, `field: str | None`, `code: str`, `message: str`
  - `ValidationOutcome` dataclass — `features: list[dict[str, Any]]`, `errors: list[Issue]`, `warnings: list[Issue]`
  - `validate_feature_collection(collection: dict[str, Any], *, max_features: int) -> ValidationOutcome`
  - `SUPPORTED_GEOMETRY_TYPES: frozenset[str]`

- [ ] **Step 1: Write the failing tests**

Create `gis-platform/backend/tests/test_geojson_validation.py`:

```python
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
    outcome = validate_feature_collection({"type": "Point", "coordinates": [0, 0]}, max_features=100)
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_geojson_validation.py -v`
Expected: FAIL — `ModuleNotFoundError: app.services.geojson_validation`.

- [ ] **Step 3: Write the implementation**

Create `gis-platform/backend/app/services/geojson_validation.py`:

```python
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
        and all(isinstance(number, (int, float)) and not isinstance(number, bool) for number in value)
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
            Issue(index, None, "malformed_coordinates", f"Expected a non-empty array of {geometry_type} coordinates")
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
            Issue(index, None, "ring_auto_closed", "Polygon ring was not closed and was closed automatically")
        )
    return {**geometry, "coordinates": coordinates}


def _positions(node: Any, depth: int) -> list[list[float]]:
    if depth == 0:
        return [node]
    return [position for child in node for position in _positions(child, depth - 1)]


def _validate_properties(
    properties: Any, index: int, errors: list[Issue]
) -> dict[str, Any]:
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


def validate_feature_collection(
    collection: Any, *, max_features: int
) -> ValidationOutcome:
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
        geometry = _validate_geometry(feature.get("geometry"), index, outcome.errors, outcome.warnings)
        properties = _validate_properties(feature.get("properties"), index, outcome.errors)
        outcome.features.append(
            {"type": "Feature", "geometry": geometry, "properties": properties}
        )

    _property_warnings(outcome.features, outcome.warnings)
    return outcome
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest tests/test_geojson_validation.py -v`
Expected: PASS — all cases.

- [ ] **Step 5: Run the full gate**

Run: `ruff check . && ruff format --check . && mypy app && pytest`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add app/services/geojson_validation.py tests/test_geojson_validation.py
git commit -m "feat: validate GeoJSON structure, geometry and coordinates

Pure module with no database or filesystem access, so the rules that decide
whether an import is written at all can be tested exhaustively without
PostGIS. Structural checks are driven off a per-type coordinate-nesting
depth table rather than six near-identical branches.

Unclosed polygon rings are repaired and warned about instead of rejected:
the intent is unambiguous and the repair is lossless. Sparse and mixed-type
properties warn without coercing the underlying values.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `source_filename` Column

Records which file a layer came from. `created_at` already records import time and `feature_count` already exists, so this is the only new column.

**Files:**
- Modify: `gis-platform/backend/app/models/layer.py`
- Modify: `gis-platform/backend/app/schemas/layer.py`
- Create: `gis-platform/backend/migrations/versions/0002_layer_source_filename.py`
- Test: `gis-platform/backend/tests/test_layers_api.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `Layer.source_filename: Mapped[str | None]`; `LayerRead.source_filename: str | None` (wire: `sourceFilename`); Alembic revision `0002`.

- [ ] **Step 1: Write the failing test**

Append to `gis-platform/backend/tests/test_layers_api.py`:

```python
async def test_layer_read_exposes_a_null_source_filename_by_default(
    client: AsyncClient,
) -> None:
    """Layers not created by a file import have no source filename, and the
    field must still be present on the wire so the client can render it
    without probing for the key."""
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers",
        json={
            "name": "Basemap",
            "kind": "basemap",
            "source": {"type": "xyz", "url": "https://example.com/{z}/{x}/{y}.png",
                       "attribution": None},
        },
    )
    assert response.status_code == 201, response.text
    assert response.json()["sourceFilename"] is None
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pytest tests/test_layers_api.py::test_layer_read_exposes_a_null_source_filename_by_default -v`
Expected: FAIL — `KeyError: 'sourceFilename'`.

- [ ] **Step 3: Add the column to the model**

In `app/models/layer.py`, after the `geometry_type` column:

```python
    source_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
```

- [ ] **Step 4: Add the field to the read schema**

In `app/schemas/layer.py`, on `LayerRead`, after `geometry_type`:

```python
    source_filename: str | None = None
```

- [ ] **Step 5: Write the migration**

Create `gis-platform/backend/migrations/versions/0002_layer_source_filename.py`:

```python
"""add layer.source_filename

Revision ID: 0002
Revises: 0001
"""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "layer",
        sa.Column("source_filename", sa.String(length=255), nullable=True),
        schema="gis",
    )


def downgrade() -> None:
    op.drop_column("layer", "source_filename", schema="gis")
```

Rollback behaviour: the column is nullable and carries no constraint, index or
default, so `downgrade` drops it without touching any other object. Downgrading
discards recorded source filenames — that is data loss by design, and it is the
only effect. No `gis_data` table is affected, because imported feature data
never lived in this column.

- [ ] **Step 6: Verify the migration round-trips against a real database**

Run:
```bash
alembic upgrade head && alembic downgrade 0001 && alembic upgrade head
```
Expected: three clean runs, no error.

- [ ] **Step 7: Verify autogenerate reports no drift**

Run: `alembic revision --autogenerate -m "drift check" --sql | grep -c "op\." || true`
Expected: `0` — the model and the migration agree. Delete any file the command
created before continuing.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pytest tests/test_layers_api.py -v && pytest tests/test_models.py tests/test_schemas.py -v`
Expected: PASS.

- [ ] **Step 9: Run the full gate**

Run: `ruff check . && ruff format --check . && mypy app && pytest`
Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add app/models/layer.py app/schemas/layer.py \
        migrations/versions/0002_layer_source_filename.py tests/test_layers_api.py
git commit -m "feat: record the source filename on a layer

One nullable column. created_at already records import time and
feature_count already exists, so this completes the import audit trail the
spec asks for -- minus the importing user, which has nowhere to come from
until the platform grows authentication.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Extract the Shared Write Path

Behaviour-neutral refactor. The draft importer must reuse the exact table
creation, identity, index and drop-on-failure semantics the file importer
already has, rather than reimplement them. The proof that nothing changed is
that `tests/test_vector_import.py` passes **without modification**.

**Files:**
- Modify: `gis-platform/backend/app/services/vector_import_service.py`
- Test: `gis-platform/backend/tests/test_vector_import.py` (must not be edited)

**Interfaces:**
- Consumes: Task 3's `Layer.source_filename`.
- Produces:
  ```python
  async def write_frame_and_register(
      session: AsyncSession,
      project_id: uuid.UUID,
      frame: gpd.GeoDataFrame,
      *,
      layer_name: str,
      table_name: str,
      source_filename: str | None,
  ) -> Layer
  ```
  Writes `frame` to `gis_data.<table_name>`, adds PK/identity/GIST, registers the
  layer, and drops the table on any failure. Task 5 calls this.

- [ ] **Step 1: Confirm the existing tests pass before touching anything**

Run: `pytest tests/test_vector_import.py -v`
Expected: PASS. Record the count — the same tests must pass at the end.

- [ ] **Step 2: Split `_read_and_write` into read and write halves**

In `app/services/vector_import_service.py`, replace `_read_and_write` with a
read-only half. Delete the `to_postgis`/`_create_indexes` calls and the stats
dict from it; it now returns the frame:

```python
def _read_frame(path: Path) -> gpd.GeoDataFrame:
    """Blocking read half. Runs on a worker thread.

    Reads the dataset and normalises it to EPSG:4326 with a `geometry` column.
    Writing is deliberately not done here: `write_frame` owns that, so the
    draft importer -- which has a frame but no file -- shares the same write.
    """
    dataset = _resolve_dataset_path(path)
    try:
        frame = gpd.read_file(dataset, engine="pyogrio")
    except Exception as exc:  # GDAL raises a wide variety of errors
        raise UpstreamDataError(
            "Could not read the uploaded dataset",
            details={"filename": path.name, "reason": str(exc)[:400]},
        ) from exc

    if frame.empty:
        raise UpstreamDataError("Dataset contains no features", details={"filename": path.name})
    return normalize_frame(frame)


def normalize_frame(frame: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """CRS84 default, reproject to 4326, and name the geometry column."""
    if frame.crs is None:
        frame = frame.set_crs(4326)  # GeoJSON without a CRS member is CRS84
    frame = frame.to_crs(4326)
    if frame.geometry.name != GEOMETRY_COLUMN:
        frame = frame.rename_geometry(GEOMETRY_COLUMN)
    return frame


def _write_frame(frame: gpd.GeoDataFrame, table_name: str) -> dict[str, Any]:
    """Blocking write half. Runs on a worker thread.

    From the moment `to_postgis` returns, `table_name` is a durably committed
    table in `gis_data` -- that commit happens on the separate sync connection
    and is entirely independent of the request-scoped async session. The
    caller must treat this function, plus everything after it, as one failure
    domain that drops the table on any exception.
    """
    settings = get_settings()
    engine = get_sync_engine()
    frame.to_postgis(
        table_name,
        engine,
        schema=settings.import_schema,
        if_exists="fail",
        index=True,
        index_label=ID_COLUMN,
    )
    _create_indexes(engine, settings.import_schema, table_name)
    return {
        "feature_count": len(frame),
        "geometry_type": str(frame.geom_type.iloc[0]).upper(),
        "extent": [float(value) for value in frame.total_bounds],
    }
```

- [ ] **Step 3: Add the shared write-and-register span**

Add to the same module, above `import_vector_file`:

```python
async def write_frame_and_register(
    session: AsyncSession,
    project_id: uuid.UUID,
    frame: gpd.GeoDataFrame,
    *,
    layer_name: str,
    table_name: str,
    source_filename: str | None,
) -> Layer:
    """Write a frame to `gis_data` and register the layer, as one failure domain.

    One guard spans both windows in which `table_name` can end up as a real,
    committed table with nothing left to undo it: the bulk `to_postgis` write
    and its PK/index DDL inside `_write_frame` (committed on the separate sync
    connection), and layer registration below (committed by the request-scoped
    session). A failure anywhere in this block drops the table
    unconditionally; `DROP TABLE IF EXISTS` is a no-op if the write never got
    that far.
    """
    settings = get_settings()
    try:
        stats = await anyio.to_thread.run_sync(_write_frame, frame, table_name)

        source = PostgisSource(
            schema_name=settings.import_schema,
            table_name=table_name,
            geometry_column=GEOMETRY_COLUMN,
            id_column=ID_COLUMN,
            srid=4326,
        )
        layer = await layer_service.create_layer(
            session,
            project_id,
            LayerCreate(name=layer_name, kind="vector", source=source),
        )
        metadata = await catalog_repository.geometry_metadata(session, source)
        return await layer_repository.update(
            session,
            layer,
            srid=4326,
            geometry_type=(str(metadata["geometry_type"]) if metadata else stats["geometry_type"]),
            extent=stats["extent"],
            feature_count=stats["feature_count"],
            source_filename=source_filename,
        )
    except Exception:
        logger.exception("Import failed; dropping table %s if it was created", table_name)
        await anyio.to_thread.run_sync(_drop_table, table_name)
        raise
```

- [ ] **Step 4: Rewrite `import_vector_file` to use it**

Replace the body of `import_vector_file` after the extension check with:

```python
    work_dir = settings.upload_tmp_dir / uuid.uuid4().hex
    table_name = slugify_table_name(original_name)
    try:
        saved = await save_upload(upload, work_dir, settings.upload_max_bytes)
        frame = await anyio.to_thread.run_sync(_read_frame, saved)
        return await write_frame_and_register(
            session,
            project_id,
            frame,
            layer_name=layer_name or Path(original_name).stem,
            table_name=table_name,
            source_filename=original_name,
        )
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
```

- [ ] **Step 5: Point the indexing-failure test's monkeypatch at the right symbol**

`tests/test_vector_import.py` patches `vector_import_service._create_indexes`,
which still exists and is still called by `_write_frame` — no test edit is
needed. Confirm by reading the test, not by assuming.

Run: `grep -n "_create_indexes\|_read_and_write" tests/test_vector_import.py`
Expected: only `_create_indexes` appears. If `_read_and_write` appears, the
refactor has broken a test's monkeypatch target — stop and reconsider the split
rather than editing the test.

- [ ] **Step 6: Run the existing import tests, unmodified**

Run: `pytest tests/test_vector_import.py -v`
Expected: PASS, same count as Step 1. `git diff --stat tests/` must show no
changes to any test file.

- [ ] **Step 7: Run the full gate**

Run: `ruff check . && ruff format --check . && mypy app && pytest`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add app/services/vector_import_service.py
git commit -m "refactor: split vector import into read and write halves

The draft importer has a GeoDataFrame but no file, so it needs the write
half -- to_postgis, PK/identity, GIST index, layer registration and the
drop-on-failure guard -- without the GDAL read. Extracting
write_frame_and_register lets both importers share one failure domain
instead of maintaining two copies of the rollback semantics.

Behaviour-neutral: tests/test_vector_import.py passes unmodified.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Draft Import Service and Endpoint

The backend half of Confirm Import. Validates every feature before writing
anything, then hands a frame to Task 4's shared write path.

**Files:**
- Create: `gis-platform/backend/app/schemas/import_draft.py`
- Create: `gis-platform/backend/app/services/draft_import_service.py`
- Modify: `gis-platform/backend/app/api/v1/routes/imports.py`
- Test: `gis-platform/backend/tests/test_import_draft.py`

**Interfaces:**
- Consumes: `geojson_validation.validate_feature_collection` (Task 2);
  `vector_import_service.write_frame_and_register` and `normalize_frame` (Task 4);
  `Settings.import_max_features` (Task 1).
- Produces: `POST /api/v1/projects/{project_id}/layers/import-draft` accepting
  `ImportDraftRequest` and returning `ImportResult`; Task 12's client calls it.

- [ ] **Step 1: Write the failing tests**

Create `gis-platform/backend/tests/test_import_draft.py`:

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest tests/test_import_draft.py -v`
Expected: FAIL — 404 on every request, the route does not exist.

- [ ] **Step 3: Write the wire models**

Create `gis-platform/backend/app/schemas/import_draft.py`:

```python
"""Wire models for the staged import.

`ImportResult` carries `rejected_count` and `errors` even though a 201 always
has them empty: import is all-or-nothing, and a caller should not have to know
that rule to read the response. On a rejection there is no ImportResult at all
-- the issues travel in the error envelope as `details.errors`, in this same
FeatureIssue shape.
"""

from __future__ import annotations

from typing import Any

from pydantic import Field

from app.schemas.base import APIModel
from app.schemas.layer import LayerRead
from app.services.geojson_validation import Issue


class ImportDraftRequest(APIModel):
    name: str = Field(min_length=1, max_length=200)
    source_filename: str = Field(min_length=1, max_length=255)
    feature_collection: dict[str, Any]


class FeatureIssue(APIModel):
    feature_index: int
    field: str | None
    code: str
    message: str

    @classmethod
    def of(cls, issue: Issue) -> FeatureIssue:
        return cls(
            feature_index=issue.feature_index,
            field=issue.field,
            code=issue.code,
            message=issue.message,
        )


class ImportResult(APIModel):
    layer: LayerRead
    imported_count: int
    rejected_count: int
    warning_count: int
    errors: list[FeatureIssue]
    warnings: list[FeatureIssue]
```

- [ ] **Step 4: Write the service**

Create `gis-platform/backend/app/services/draft_import_service.py`:

```python
"""Persist an edited, in-memory import draft.

Validation runs to completion over every feature *before* a frame is built or
a table is created. That ordering is what makes "roll back everything if any
feature fails" true: a rejected draft never reaches a write at all. If a write
fails anyway, `write_frame_and_register`'s drop-on-failure guard removes the
freshly created table -- and because the table is always new, dropping it is
equivalent to a rollback, with no partial state either way.

There is one bulk insert, not one insert per feature.
"""

from __future__ import annotations

import uuid
from typing import Any

import anyio
import geopandas as gpd
from shapely.geometry import shape
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import ConflictError, InvalidRequestError
from app.schemas.import_draft import FeatureIssue, ImportDraftRequest, ImportResult
from app.schemas.layer import LayerRead
from app.services import vector_import_service
from app.services.geojson_validation import validate_feature_collection
from app.services.upload_service import slugify_table_name


def _max_features() -> int:
    """Indirection so a test can lower the limit without rebuilding Settings."""
    return get_settings().import_max_features


def _build_frame(features: list[dict[str, Any]]) -> gpd.GeoDataFrame:
    """Blocking. Runs on a worker thread.

    Property dicts go in as-is: no renaming, no coercion, no dropping of keys
    the frame's other rows lack. pandas fills a missing key with NaN, which
    to_postgis writes as SQL NULL -- the same thing "absent" means here.
    """
    geometries = [shape(item["geometry"]) for item in features]
    properties = [dict(item["properties"]) for item in features]
    return gpd.GeoDataFrame(properties, geometry=geometries, crs="EPSG:4326")


async def import_draft(
    session: AsyncSession, project_id: uuid.UUID, request: ImportDraftRequest
) -> ImportResult:
    outcome = validate_feature_collection(
        request.feature_collection, max_features=_max_features()
    )
    if outcome.errors:
        raise InvalidRequestError(
            "The import draft failed validation",
            details={
                "errors": [
                    FeatureIssue.of(issue).model_dump(by_alias=True) for issue in outcome.errors
                ]
            },
        )

    frame = await anyio.to_thread.run_sync(_build_frame, outcome.features)
    frame = vector_import_service.normalize_frame(frame)

    try:
        layer = await vector_import_service.write_frame_and_register(
            session,
            project_id,
            frame,
            layer_name=request.name,
            table_name=slugify_table_name(request.source_filename),
            source_filename=request.source_filename,
        )
    except IntegrityError as exc:
        raise ConflictError(
            "A layer with this name already exists in the project",
            details={"name": request.name},
        ) from exc

    warnings = [FeatureIssue.of(issue) for issue in outcome.warnings]
    return ImportResult(
        layer=LayerRead.model_validate(layer),
        imported_count=len(outcome.features),
        rejected_count=0,
        warning_count=len(warnings),
        errors=[],
        warnings=warnings,
    )
```

- [ ] **Step 5: Add the route**

In `app/api/v1/routes/imports.py`, add the imports and the endpoint:

```python
from app.schemas.import_draft import ImportDraftRequest, ImportResult
from app.services import draft_import_service, raster_import_service, vector_import_service


@router.post("/import-draft", response_model=ImportResult, status_code=status.HTTP_201_CREATED)
async def import_draft(
    project_id: uuid.UUID,
    session: SessionDep,
    request: ImportDraftRequest,
) -> ImportResult:
    """Persist an edited import draft. The client has already previewed it;
    the server validates it again and trusts none of that."""
    return await draft_import_service.import_draft(session, project_id, request)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pytest tests/test_import_draft.py -v`
Expected: PASS — all cases.

- [ ] **Step 7: Confirm the file-upload path still works**

Run: `pytest tests/test_vector_import.py -v`
Expected: PASS, unchanged.

- [ ] **Step 8: Run the full gate**

Run: `ruff check . && ruff format --check . && mypy app && pytest`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add app/schemas/import_draft.py app/services/draft_import_service.py \
        app/api/v1/routes/imports.py tests/test_import_draft.py
git commit -m "feat: persist a staged import draft in one transaction

POST /projects/{id}/layers/import-draft takes the normalised, edited
FeatureCollection the browser previewed and re-validates every feature
before building a frame -- so a rejected draft never reaches a write and
leaves no table and no layer row.

Persistence reuses the file importer's write path, so batch insert,
identity, GIST indexing and drop-on-failure behave identically. A repeated
confirmation hits the existing (project_id, name) unique constraint and
returns 409 rather than creating a second layer.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Frontend Parser and Normaliser

Pure, synchronous, no DOM and no network — so it is unit testable directly and
the worker in Task 9 is just transport around it.

**Files:**
- Create: `gis-platform/web/src/features/import/parseGeoJson.ts`
- Test: `gis-platform/web/src/features/import/parseGeoJson.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type DraftColumnType = 'text' | 'number' | 'boolean' | 'date' | 'json'
  export interface DraftColumn { name: string; type: DraftColumnType; mixed: boolean }
  export interface DraftFeature {
    id: string
    geometry: Record<string, unknown> | null
    properties: Record<string, unknown>
  }
  export interface ParseWarning { code: string; message: string; field?: string }
  export type DetectedFormat = 'featureCollection' | 'feature' | 'array' | 'records'
  export interface ParseResult {
    detectedFormat: DetectedFormat
    columns: DraftColumn[]
    features: DraftFeature[]
    geometryTypes: string[]
    lonColumn: string | null
    latColumn: string | null
    warnings: ParseWarning[]
  }
  export class ParseError extends Error { readonly code: string }
  export function parseGeoJson(text: string): ParseResult
  export function inferColumns(features: DraftFeature[]): DraftColumn[]
  export function buildPointGeometry(
    properties: Record<string, unknown>, lon: string | null, lat: string | null,
  ): Record<string, unknown> | null
  ```
- Task 8 consumes `DraftColumn`, `DraftFeature`, `inferColumns`,
  `buildPointGeometry`; Tasks 10–12 consume `ParseResult`.

- [ ] **Step 1: Write the failing tests**

Create `gis-platform/web/src/features/import/parseGeoJson.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { ParseError, inferColumns, parseGeoJson } from './parseGeoJson'

const POINT = { type: 'Point', coordinates: [116.4, 39.9] }

const featureCollection = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: POINT, properties: { name: 'Beijing', pop: 21540000 } },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [91.1, 29.6] },
      properties: { name: 'Lhasa', pop: 560000 },
    },
  ],
}

describe('parseGeoJson root shapes', () => {
  it('takes a FeatureCollection as-is', () => {
    const result = parseGeoJson(JSON.stringify(featureCollection))
    expect(result.detectedFormat).toBe('featureCollection')
    expect(result.features).toHaveLength(2)
    expect(result.geometryTypes).toEqual(['Point'])
  })

  it('wraps a single Feature into a one-feature collection', () => {
    const single = { type: 'Feature', geometry: POINT, properties: { name: 'Beijing' } }
    const result = parseGeoJson(JSON.stringify(single))
    expect(result.detectedFormat).toBe('feature')
    expect(result.features).toHaveLength(1)
    expect(result.features[0]!.properties.name).toBe('Beijing')
  })

  it('turns an array of objects into Points from detected lat/lon', () => {
    const rows = [
      { city: 'Beijing', lon: 116.4, lat: 39.9 },
      { city: 'Lhasa', lon: 91.1, lat: 29.6 },
    ]
    const result = parseGeoJson(JSON.stringify(rows))
    expect(result.detectedFormat).toBe('array')
    expect(result.lonColumn).toBe('lon')
    expect(result.latColumn).toBe('lat')
    expect(result.features[0]!.geometry).toEqual({ type: 'Point', coordinates: [116.4, 39.9] })
  })

  it('finds a records array inside a wrapper object', () => {
    const wrapper = { total: 2, records: [{ x: 1, y: 2, k: 'a' }] }
    const result = parseGeoJson(JSON.stringify(wrapper))
    expect(result.detectedFormat).toBe('records')
    expect(result.features).toHaveLength(1)
  })

  it('finds a sole array property even when it is not conventionally named', () => {
    const wrapper = { stations: [{ longitude: 1, latitude: 2 }] }
    const result = parseGeoJson(JSON.stringify(wrapper))
    expect(result.detectedFormat).toBe('records')
    expect(result.lonColumn).toBe('longitude')
    expect(result.latColumn).toBe('latitude')
  })

  it('keeps records with no detectable coordinate pair, with a null geometry', () => {
    const result = parseGeoJson(JSON.stringify([{ a: 1 }, { a: 2 }]))
    expect(result.lonColumn).toBeNull()
    expect(result.features[0]!.geometry).toBeNull()
  })
})

describe('parseGeoJson failures', () => {
  it('throws a coded error on malformed JSON', () => {
    expect(() => parseGeoJson('{not json')).toThrowError(ParseError)
    try {
      parseGeoJson('{not json')
    } catch (error) {
      expect((error as ParseError).code).toBe('malformed_json')
    }
  })

  it('throws on an empty file', () => {
    try {
      parseGeoJson('   ')
    } catch (error) {
      expect((error as ParseError).code).toBe('empty_document')
    }
  })

  it('throws on an unsupported root', () => {
    try {
      parseGeoJson(JSON.stringify({ type: 'Point', coordinates: [0, 0] }))
    } catch (error) {
      expect((error as ParseError).code).toBe('unsupported_root')
    }
  })

  it('throws when a wrapper object has two unnamed candidate arrays', () => {
    try {
      parseGeoJson(JSON.stringify({ a: [{ x: 1 }], b: [{ y: 2 }] }))
    } catch (error) {
      expect((error as ParseError).code).toBe('unsupported_root')
    }
  })

  it('throws on an empty FeatureCollection', () => {
    try {
      parseGeoJson(JSON.stringify({ type: 'FeatureCollection', features: [] }))
    } catch (error) {
      expect((error as ParseError).code).toBe('empty_document')
    }
  })
})

describe('column inference', () => {
  it('unions properties across every feature, not just the first', () => {
    const mixed = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: POINT, properties: { a: 1 } },
        { type: 'Feature', geometry: POINT, properties: { b: 2 } },
        { type: 'Feature', geometry: POINT, properties: { c: 3 } },
      ],
    }
    const result = parseGeoJson(JSON.stringify(mixed))
    expect(result.columns.map((c) => c.name)).toEqual(['a', 'b', 'c'])
  })

  it('orders columns by first appearance', () => {
    const features = [
      { id: '1', geometry: null, properties: { z: 1, a: 2 } },
      { id: '2', geometry: null, properties: { m: 3 } },
    ]
    expect(inferColumns(features).map((c) => c.name)).toEqual(['z', 'a', 'm'])
  })

  it('infers number, boolean, date, json and text', () => {
    const features = [
      {
        id: '1',
        geometry: null,
        properties: {
          n: 4,
          b: true,
          d: '2026-07-31T00:00:00Z',
          j: { nested: [1] },
          t: 'hello',
        },
      },
    ]
    const byName = Object.fromEntries(inferColumns(features).map((c) => [c.name, c.type]))
    expect(byName).toEqual({ n: 'number', b: 'boolean', d: 'date', j: 'json', t: 'text' })
  })

  it('falls back to text and flags a column whose values are of mixed type', () => {
    const features = [
      { id: '1', geometry: null, properties: { pop: 100 } },
      { id: '2', geometry: null, properties: { pop: 'many' } },
    ]
    const column = inferColumns(features)[0]!
    expect(column.type).toBe('text')
    expect(column.mixed).toBe(true)
  })

  it('ignores nulls when inferring a type', () => {
    const features = [
      { id: '1', geometry: null, properties: { pop: null } },
      { id: '2', geometry: null, properties: { pop: 12 } },
    ]
    const column = inferColumns(features)[0]!
    expect(column.type).toBe('number')
    expect(column.mixed).toBe(false)
  })
})

describe('value preservation', () => {
  it('keeps nested objects and arrays intact rather than flattening them', () => {
    const nested = { sensor: { bands: [1, 2, 3], calibrated: true } }
    const document = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: POINT, properties: { meta: nested } }],
    }
    const result = parseGeoJson(JSON.stringify(document))
    expect(result.features[0]!.properties.meta).toEqual(nested)
  })

  it('preserves unknown keys and original casing', () => {
    const document = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: POINT, properties: { OddKey: 1, 'with space': 2 } },
      ],
    }
    const result = parseGeoJson(JSON.stringify(document))
    expect(Object.keys(result.features[0]!.properties)).toEqual(['OddKey', 'with space'])
  })

  it('distinguishes an explicit null from an absent property', () => {
    const document = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: POINT, properties: { a: null } },
        { type: 'Feature', geometry: POINT, properties: {} },
      ],
    }
    const result = parseGeoJson(JSON.stringify(document))
    expect(result.features[0]!.properties.a).toBeNull()
    expect('a' in result.features[1]!.properties).toBe(false)
  })

  it('reports every distinct geometry type present', () => {
    const document = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: POINT, properties: {} },
        {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
          properties: {},
        },
      ],
    }
    expect(parseGeoJson(JSON.stringify(document)).geometryTypes).toEqual(['Point', 'LineString'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- --run src/features/import/parseGeoJson.test.ts`
Expected: FAIL — cannot resolve `./parseGeoJson`.

- [ ] **Step 3: Write the implementation**

Create `gis-platform/web/src/features/import/parseGeoJson.ts`:

```ts
/**
 * Parse a JSON/GeoJSON file into a normalised import draft.
 *
 * Pure and synchronous: no DOM, no network, no worker. The worker in
 * `parseWorker.ts` is only transport around this, so the interesting logic is
 * testable without any of that machinery.
 *
 * Nothing is discarded. Unknown property keys, original casing, nested objects
 * and arrays, and the difference between an explicit null and an absent key all
 * survive to the draft and back out to the server.
 */

export type DraftColumnType = 'text' | 'number' | 'boolean' | 'date' | 'json'

export interface DraftColumn {
  name: string
  type: DraftColumnType
  /** True when values of more than one type appear; the column falls back to text. */
  mixed: boolean
}

export interface DraftFeature {
  id: string
  geometry: Record<string, unknown> | null
  properties: Record<string, unknown>
}

export interface ParseWarning {
  code: string
  message: string
  field?: string
}

export type DetectedFormat = 'featureCollection' | 'feature' | 'array' | 'records'

export interface ParseResult {
  detectedFormat: DetectedFormat
  columns: DraftColumn[]
  features: DraftFeature[]
  geometryTypes: string[]
  lonColumn: string | null
  latColumn: string | null
  warnings: ParseWarning[]
}

export class ParseError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ParseError'
    this.code = code
  }
}

const RECORD_ARRAY_KEYS = ['features', 'records', 'data', 'items', 'rows']
const LON_NAMES = ['lon', 'lng', 'long', 'longitude', 'x']
const LAT_NAMES = ['lat', 'latitude', 'y']
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isRecordArray = (value: unknown): value is Record<string, unknown>[] =>
  Array.isArray(value) && value.length > 0 && value.every(isObject)

function valueType(value: unknown): DraftColumnType {
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'object') return 'json'
  if (typeof value === 'string' && ISO_DATE.test(value)) return 'date'
  return 'text'
}

/** Union the property keys of every feature — never just the first. */
export function inferColumns(features: DraftFeature[]): DraftColumn[] {
  const order: string[] = []
  const types = new Map<string, Set<DraftColumnType>>()

  for (const feature of features) {
    for (const [key, value] of Object.entries(feature.properties)) {
      if (!types.has(key)) {
        types.set(key, new Set())
        order.push(key)
      }
      if (value !== null && value !== undefined) types.get(key)!.add(valueType(value))
    }
  }

  return order.map((name) => {
    const seen = types.get(name)!
    const mixed = seen.size > 1
    const type: DraftColumnType = mixed ? 'text' : ([...seen][0] ?? 'text')
    return { name, type, mixed }
  })
}

function detectColumn(columns: DraftColumn[], candidates: string[]): string | null {
  for (const candidate of candidates) {
    const match = columns.find(
      (column) => column.name.toLowerCase() === candidate && column.type === 'number',
    )
    if (match) return match.name
  }
  return null
}

/** Build a Point from two property values, or null if either is unusable. */
export function buildPointGeometry(
  properties: Record<string, unknown>,
  lon: string | null,
  lat: string | null,
): Record<string, unknown> | null {
  if (!lon || !lat) return null
  const x = properties[lon]
  const y = properties[lat]
  if (typeof x !== 'number' || typeof y !== 'number') return null
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { type: 'Point', coordinates: [x, y] }
}

function toDraftFeatures(
  items: { geometry: Record<string, unknown> | null; properties: Record<string, unknown> }[],
): DraftFeature[] {
  return items.map((item, index) => ({
    id: String(index),
    geometry: item.geometry,
    properties: item.properties,
  }))
}

function fromFeatureArray(raw: unknown[]): DraftFeature[] {
  return toDraftFeatures(
    raw.map((entry) => {
      if (!isObject(entry)) {
        throw new ParseError('unsupported_root', 'Every feature must be an object')
      }
      const geometry = entry.geometry
      return {
        geometry: isObject(geometry) ? geometry : null,
        properties: isObject(entry.properties) ? entry.properties : {},
      }
    }),
  )
}

export function parseGeoJson(text: string): ParseResult {
  if (!text.trim()) {
    throw new ParseError('empty_document', 'The file is empty')
  }

  let root: unknown
  try {
    root = JSON.parse(text)
  } catch (error) {
    throw new ParseError('malformed_json', (error as Error).message)
  }

  let detectedFormat: DetectedFormat
  let features: DraftFeature[]
  let derivesGeometry = false

  if (isObject(root) && root.type === 'FeatureCollection') {
    if (!Array.isArray(root.features)) {
      throw new ParseError('unsupported_root', 'FeatureCollection.features must be an array')
    }
    detectedFormat = 'featureCollection'
    features = fromFeatureArray(root.features)
  } else if (isObject(root) && root.type === 'Feature') {
    detectedFormat = 'feature'
    features = fromFeatureArray([root])
  } else if (isRecordArray(root)) {
    detectedFormat = 'array'
    features = toDraftFeatures(root.map((entry) => ({ geometry: null, properties: entry })))
    derivesGeometry = true
  } else if (isObject(root)) {
    const named = RECORD_ARRAY_KEYS.find((key) => isRecordArray(root[key]))
    const candidates = Object.keys(root).filter((key) => isRecordArray(root[key]))
    const key = named ?? (candidates.length === 1 ? candidates[0] : undefined)
    if (!key) {
      throw new ParseError(
        'unsupported_root',
        candidates.length > 1
          ? 'The file has more than one candidate records array; none is named recognisably'
          : 'The file has no recognisable records array',
      )
    }
    detectedFormat = 'records'
    const rows = root[key] as Record<string, unknown>[]
    features = toDraftFeatures(rows.map((entry) => ({ geometry: null, properties: entry })))
    derivesGeometry = true
  } else {
    throw new ParseError('unsupported_root', 'The file root is not a supported structure')
  }

  if (features.length === 0) {
    throw new ParseError('empty_document', 'The file contains no features')
  }

  const columns = inferColumns(features)
  const warnings: ParseWarning[] = columns
    .filter((column) => column.mixed)
    .map((column) => ({
      code: 'mixed_property_type',
      field: column.name,
      message: `"${column.name}" holds more than one value type and is treated as text`,
    }))

  let lonColumn: string | null = null
  let latColumn: string | null = null
  if (derivesGeometry) {
    lonColumn = detectColumn(columns, LON_NAMES)
    latColumn = detectColumn(columns, LAT_NAMES)
    features = features.map((feature) => ({
      ...feature,
      geometry: buildPointGeometry(feature.properties, lonColumn, latColumn),
    }))
  }

  const geometryTypes = [
    ...new Set(
      features
        .map((feature) => feature.geometry?.type)
        .filter((type): type is string => typeof type === 'string'),
    ),
  ]

  return { detectedFormat, columns, features, geometryTypes, lonColumn, latColumn, warnings }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- --run src/features/import/parseGeoJson.test.ts`
Expected: PASS — all cases.

- [ ] **Step 5: Run the full gate**

Run: `npm run lint && npm run typecheck && npm run test -- --run`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/features/import/parseGeoJson.ts src/features/import/parseGeoJson.test.ts
git commit -m "feat: parse and normalise JSON/GeoJSON into an import draft

Handles the four accepted roots -- FeatureCollection, single Feature, array
of objects, and an object wrapping a records array -- normalising all of
them to one shape. Plain records become Points from an auto-detected
coordinate pair.

Columns are inferred from the union of every feature's properties rather
than the first feature's, so a key that only appears late is still a column.
Nested objects and arrays stay intact, and an explicit null stays
distinguishable from an absent key.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Client Validation Mirror

Same rules and the same codes as Task 2, evaluated in the browser so the user
sees problems before confirming. The server never trusts it.

**Files:**
- Create: `gis-platform/web/src/features/import/validation.ts`
- Test: `gis-platform/web/src/features/import/validation.test.ts`

**Interfaces:**
- Consumes: `DraftColumn`, `DraftColumnType`, `DraftFeature` (Task 6).
- Produces:
  ```ts
  export interface DraftIssue {
    featureIndex: number
    field: string | null
    code: string
    message: string
  }
  export function validateDraft(
    features: DraftFeature[], columns: DraftColumn[],
  ): { errors: DraftIssue[]; warnings: DraftIssue[] }
  export function validateCell(
    value: unknown, type: DraftColumnType,
  ): { ok: true; value: unknown } | { ok: false; message: string }
  export function coerceCellInput(
    raw: string, type: DraftColumnType,
  ): { ok: true; value: unknown } | { ok: false; message: string }
  ```
- Tasks 10 and 12 consume all three.

- [ ] **Step 1: Write the failing tests**

Create `gis-platform/web/src/features/import/validation.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { DraftColumn, DraftFeature } from './parseGeoJson'
import { coerceCellInput, validateCell, validateDraft } from './validation'

const columns: DraftColumn[] = [{ name: 'name', type: 'text', mixed: false }]

function features(...geometries: (Record<string, unknown> | null)[]): DraftFeature[] {
  return geometries.map((geometry, index) => ({
    id: String(index),
    geometry,
    properties: { name: 'x' },
  }))
}

describe('validateDraft', () => {
  it('accepts every supported geometry type', () => {
    const supported = [
      { type: 'Point', coordinates: [1, 2] },
      { type: 'MultiPoint', coordinates: [[1, 2]] },
      { type: 'LineString', coordinates: [[1, 2], [3, 4]] },
      { type: 'MultiLineString', coordinates: [[[1, 2], [3, 4]]] },
      { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] },
    ]
    const { errors } = validateDraft(features(...supported), columns)
    expect(errors).toEqual([])
  })

  it('reports a missing geometry against its feature index', () => {
    const { errors } = validateDraft(features({ type: 'Point', coordinates: [1, 2] }, null), columns)
    expect(errors).toEqual([
      expect.objectContaining({ code: 'missing_geometry', featureIndex: 1 }),
    ])
  })

  it('rejects an unsupported geometry type', () => {
    const { errors } = validateDraft(features({ type: 'GeometryCollection' }), columns)
    expect(errors[0]!.code).toBe('unsupported_geometry_type')
  })

  it.each([
    [[181, 0]],
    [[-181, 0]],
    [[0, 91]],
    [[0, -91]],
  ])('rejects out-of-range coordinates %j', (coordinates) => {
    const { errors } = validateDraft(features({ type: 'Point', coordinates }), columns)
    expect(errors[0]!.code).toBe('coordinate_out_of_range')
  })

  it.each([[NaN], [Infinity], [-Infinity]])('rejects non-finite coordinate %s', (bad) => {
    const { errors } = validateDraft(features({ type: 'Point', coordinates: [bad, 0] }), columns)
    expect(errors[0]!.code).toBe('coordinate_not_finite')
  })

  it('rejects malformed coordinates', () => {
    const { errors } = validateDraft(features({ type: 'Point', coordinates: 'nope' }), columns)
    expect(errors[0]!.code).toBe('malformed_coordinates')
  })

  it('rejects a LineString with fewer than two positions', () => {
    const { errors } = validateDraft(features({ type: 'LineString', coordinates: [[1, 2]] }), columns)
    expect(errors[0]!.code).toBe('malformed_coordinates')
  })

  it('reports an empty draft', () => {
    const { errors } = validateDraft([], columns)
    expect(errors[0]!.code).toBe('empty_document')
  })

  it('warns rather than errors on a mixed-type column', () => {
    const mixed: DraftColumn[] = [{ name: 'pop', type: 'text', mixed: true }]
    const { errors, warnings } = validateDraft(
      features({ type: 'Point', coordinates: [1, 2] }),
      mixed,
    )
    expect(errors).toEqual([])
    expect(warnings[0]!.code).toBe('mixed_property_type')
  })
})

describe('validateCell', () => {
  it('accepts null for every type', () => {
    for (const type of ['text', 'number', 'boolean', 'date', 'json'] as const) {
      expect(validateCell(null, type)).toEqual({ ok: true, value: null })
    }
  })

  it('rejects a non-numeric value in a number column', () => {
    expect(validateCell('many', 'number').ok).toBe(false)
  })

  it('rejects a non-finite number', () => {
    expect(validateCell(Infinity, 'number').ok).toBe(false)
  })
})

describe('coerceCellInput', () => {
  it('returns null for an empty string rather than an empty string', () => {
    expect(coerceCellInput('', 'text')).toEqual({ ok: true, value: null })
    expect(coerceCellInput('   ', 'number')).toEqual({ ok: true, value: null })
  })

  it('parses numbers, booleans and JSON', () => {
    expect(coerceCellInput('42', 'number')).toEqual({ ok: true, value: 42 })
    expect(coerceCellInput('true', 'boolean')).toEqual({ ok: true, value: true })
    expect(coerceCellInput('{"a":1}', 'json')).toEqual({ ok: true, value: { a: 1 } })
  })

  it('reports invalid JSON without throwing', () => {
    const result = coerceCellInput('{not json', 'json')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/json/i)
  })

  it('reports a non-numeric entry in a number column', () => {
    const result = coerceCellInput('lots', 'number')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/number/i)
  })

  it('reports an unparseable date', () => {
    expect(coerceCellInput('not-a-date', 'date').ok).toBe(false)
    expect(coerceCellInput('2026-07-31', 'date').ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- --run src/features/import/validation.test.ts`
Expected: FAIL — cannot resolve `./validation`.

- [ ] **Step 3: Write the implementation**

Create `gis-platform/web/src/features/import/validation.ts`:

```ts
/**
 * Client mirror of `app/services/geojson_validation.py`.
 *
 * Same rules, same codes, so a problem the user sees in the preview is the
 * same problem the server would report. This is a convenience, not a
 * security boundary: the server re-validates everything and trusts none of it.
 */

import type { DraftColumn, DraftColumnType, DraftFeature } from './parseGeoJson'

export interface DraftIssue {
  featureIndex: number
  field: string | null
  code: string
  message: string
}

const SUPPORTED_GEOMETRY_TYPES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
])

/** Nesting depth of `coordinates` before reaching a [x, y] position. */
const COORDINATE_DEPTH: Record<string, number> = {
  Point: 0,
  MultiPoint: 1,
  LineString: 1,
  MultiLineString: 2,
  Polygon: 2,
  MultiPolygon: 3,
}

const MIN_POSITIONS: Record<string, number> = {
  LineString: 2,
  MultiLineString: 2,
  Polygon: 4,
  MultiPolygon: 4,
}

const isPosition = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length >= 2 &&
  value.length <= 3 &&
  value.every((entry) => typeof entry === 'number')

function issue(featureIndex: number, code: string, message: string): DraftIssue {
  return { featureIndex, field: null, code, message }
}

function checkStructure(
  node: unknown,
  depth: number,
  type: string,
  index: number,
  errors: DraftIssue[],
): boolean {
  if (depth === 0) {
    if (!isPosition(node)) {
      errors.push(issue(index, 'malformed_coordinates', 'Expected a [longitude, latitude] pair'))
      return false
    }
    return true
  }
  if (!Array.isArray(node) || node.length === 0) {
    errors.push(issue(index, 'malformed_coordinates', `Expected an array of ${type} coordinates`))
    return false
  }
  if (depth === 1) {
    const minimum = MIN_POSITIONS[type]
    if (minimum !== undefined && node.length < minimum) {
      errors.push(
        issue(
          index,
          'malformed_coordinates',
          `${type} needs at least ${minimum} positions, got ${node.length}`,
        ),
      )
      return false
    }
  }
  return node.every((child) => checkStructure(child, depth - 1, type, index, errors))
}

function positions(node: unknown, depth: number): number[][] {
  if (depth === 0) return [node as number[]]
  return (node as unknown[]).flatMap((child) => positions(child, depth - 1))
}

function checkGeometry(
  geometry: Record<string, unknown> | null,
  index: number,
  errors: DraftIssue[],
): void {
  if (!geometry) {
    errors.push(issue(index, 'missing_geometry', 'Feature has no geometry'))
    return
  }
  const type = geometry.type
  if (typeof type !== 'string' || !SUPPORTED_GEOMETRY_TYPES.has(type)) {
    errors.push(
      issue(index, 'unsupported_geometry_type', `Geometry type "${String(type)}" is not supported`),
    )
    return
  }
  const depth = COORDINATE_DEPTH[type]!
  if (!checkStructure(geometry.coordinates, depth, type, index, errors)) return

  for (const [longitude, latitude] of positions(geometry.coordinates, depth)) {
    if (!Number.isFinite(longitude!) || !Number.isFinite(latitude!)) {
      errors.push(issue(index, 'coordinate_not_finite', 'Coordinate is NaN or infinite'))
      return
    }
    if (longitude! < -180 || longitude! > 180 || latitude! < -90 || latitude! > 90) {
      errors.push(
        issue(
          index,
          'coordinate_out_of_range',
          `Coordinate (${longitude}, ${latitude}) is outside longitude [-180, 180] / latitude [-90, 90]`,
        ),
      )
      return
    }
  }
}

export function validateDraft(
  features: DraftFeature[],
  columns: DraftColumn[],
): { errors: DraftIssue[]; warnings: DraftIssue[] } {
  const errors: DraftIssue[] = []
  const warnings: DraftIssue[] = []

  if (features.length === 0) {
    errors.push(issue(-1, 'empty_document', 'There are no features to import'))
    return { errors, warnings }
  }

  features.forEach((feature, index) => checkGeometry(feature.geometry, index, errors))

  for (const column of columns) {
    if (!column.mixed) continue
    warnings.push({
      featureIndex: -1,
      field: column.name,
      code: 'mixed_property_type',
      message: `"${column.name}" holds more than one value type and is stored as text`,
    })
  }

  return { errors, warnings }
}

type CellOutcome = { ok: true; value: unknown } | { ok: false; message: string }

export function validateCell(value: unknown, type: DraftColumnType): CellOutcome {
  if (value === null || value === undefined) return { ok: true, value: null }
  switch (type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? { ok: true, value }
        : { ok: false, message: 'Not a finite number' }
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true, value }
        : { ok: false, message: 'Not true or false' }
    case 'date':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value))
        ? { ok: true, value }
        : { ok: false, message: 'Not a recognisable date' }
    default:
      return { ok: true, value }
  }
}

/** Turn raw editor text into a typed value. Empty input always means null. */
export function coerceCellInput(raw: string, type: DraftColumnType): CellOutcome {
  if (raw.trim() === '') return { ok: true, value: null }

  switch (type) {
    case 'number': {
      const parsed = Number(raw)
      return Number.isFinite(parsed)
        ? { ok: true, value: parsed }
        : { ok: false, message: `"${raw}" is not a number` }
    }
    case 'boolean': {
      const normalised = raw.trim().toLowerCase()
      if (['true', 'yes', '1'].includes(normalised)) return { ok: true, value: true }
      if (['false', 'no', '0'].includes(normalised)) return { ok: true, value: false }
      return { ok: false, message: `"${raw}" is not true or false` }
    }
    case 'date':
      return Number.isNaN(Date.parse(raw))
        ? { ok: false, message: `"${raw}" is not a recognisable date` }
        : { ok: true, value: raw }
    case 'json':
      try {
        return { ok: true, value: JSON.parse(raw) }
      } catch (error) {
        return { ok: false, message: `Invalid JSON: ${(error as Error).message}` }
      }
    default:
      return { ok: true, value: raw }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- --run src/features/import/validation.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full gate**

Run: `npm run lint && npm run typecheck && npm run test -- --run`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/features/import/validation.ts src/features/import/validation.test.ts
git commit -m "feat: mirror the server's GeoJSON rules in the browser

Same rules and the same stable codes as geojson_validation.py, so the
preview reports exactly what the server would reject -- before the user
clicks Confirm. Structural checks share the per-type coordinate-depth
approach so the two implementations stay comparable.

Convenience only: the server re-validates and trusts none of this.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Draft State and Undo/Redo Command Stack

The draft lives in component state — never in `layerStore` (it is not a
persisted layer) and never in TanStack Query (it is not server state). Edits go
through invertible commands so undo/redo is a stack operation rather than a
snapshot diff.

**Files:**
- Create: `gis-platform/web/src/features/import/useImportDraft.ts`
- Test: `gis-platform/web/src/features/import/useImportDraft.test.ts`

**Interfaces:**
- Consumes: `DraftColumn`, `DraftFeature`, `ParseResult`, `buildPointGeometry`,
  `inferColumns` (Task 6); `coerceCellInput` (Task 7).
- Produces:
  ```ts
  export interface ImportDraft {
    fileName: string
    fileSize: number
    detectedFormat: DetectedFormat
    columns: DraftColumn[]
    features: DraftFeature[]
    geometryTypes: string[]
    lonColumn: string | null
    latColumn: string | null
  }
  export function useImportDraft(initial: ImportDraft | null): {
    draft: ImportDraft | null
    isDirty: boolean
    canUndo: boolean
    canRedo: boolean
    setCellValue: (featureId: string, column: string, value: unknown) => void
    addColumn: (name: string) => { ok: boolean; message?: string }
    renameColumn: (from: string, to: string) => { ok: boolean; message?: string }
    deleteFeatures: (featureIds: string[]) => void
    setGeometryColumns: (lon: string | null, lat: string | null) => void
    undo: () => void
    redo: () => void
    toFeatureCollection: () => { type: 'FeatureCollection'; features: unknown[] }
  }
  export function draftFromParse(result: ParseResult, fileName: string, fileSize: number): ImportDraft
  ```
- Task 12 consumes all of it.

- [ ] **Step 1: Write the failing tests**

Create `gis-platform/web/src/features/import/useImportDraft.test.ts`:

```ts
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { parseGeoJson } from './parseGeoJson'
import { draftFromParse, useImportDraft } from './useImportDraft'

const DOCUMENT = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [116.4, 39.9] },
      properties: { name: 'Beijing', pop: 21540000 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [91.1, 29.6] },
      properties: { name: 'Lhasa', pop: 560000 },
    },
  ],
})

const start = () =>
  renderHook(() => useImportDraft(draftFromParse(parseGeoJson(DOCUMENT), 'cities.geojson', 1234)))

describe('useImportDraft', () => {
  it('starts clean with nothing to undo', () => {
    const { result } = start()
    expect(result.current.isDirty).toBe(false)
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(false)
    expect(result.current.draft!.features).toHaveLength(2)
  })

  it('edits a cell and becomes dirty', () => {
    const { result } = start()
    act(() => result.current.setCellValue('0', 'name', 'Beijing Municipality'))
    expect(result.current.draft!.features[0]!.properties.name).toBe('Beijing Municipality')
    expect(result.current.isDirty).toBe(true)
  })

  it('undo restores the previous value and redo reapplies it', () => {
    const { result } = start()
    act(() => result.current.setCellValue('0', 'name', 'Changed'))
    act(() => result.current.undo())
    expect(result.current.draft!.features[0]!.properties.name).toBe('Beijing')
    expect(result.current.isDirty).toBe(false)

    act(() => result.current.redo())
    expect(result.current.draft!.features[0]!.properties.name).toBe('Changed')
    expect(result.current.isDirty).toBe(true)
  })

  it('a new edit clears the redo stack', () => {
    const { result } = start()
    act(() => result.current.setCellValue('0', 'name', 'A'))
    act(() => result.current.undo())
    act(() => result.current.setCellValue('0', 'name', 'B'))
    expect(result.current.canRedo).toBe(false)
  })

  it('adds a column that is absent on every feature until edited', () => {
    const { result } = start()
    act(() => {
      result.current.addColumn('note')
    })
    expect(result.current.draft!.columns.map((c) => c.name)).toContain('note')
    expect('note' in result.current.draft!.features[0]!.properties).toBe(false)

    act(() => result.current.setCellValue('0', 'note', 'checked'))
    expect(result.current.draft!.features[0]!.properties.note).toBe('checked')
  })

  it('rejects an empty or duplicate column name', () => {
    const { result } = start()
    let outcome: { ok: boolean; message?: string } = { ok: true }
    act(() => {
      outcome = result.current.addColumn('   ')
    })
    expect(outcome.ok).toBe(false)
    act(() => {
      outcome = result.current.addColumn('name')
    })
    expect(outcome.ok).toBe(false)
  })

  it('renames a column, preserving its values and position', () => {
    const { result } = start()
    act(() => {
      result.current.renameColumn('pop', 'population')
    })
    expect(result.current.draft!.columns.map((c) => c.name)).toEqual(['name', 'population'])
    expect(result.current.draft!.features[0]!.properties.population).toBe(21540000)
    expect('pop' in result.current.draft!.features[0]!.properties).toBe(false)
  })

  it('undoes a rename', () => {
    const { result } = start()
    act(() => {
      result.current.renameColumn('pop', 'population')
    })
    act(() => result.current.undo())
    expect(result.current.draft!.columns.map((c) => c.name)).toEqual(['name', 'pop'])
    expect(result.current.draft!.features[0]!.properties.pop).toBe(21540000)
  })

  it('rejects renaming onto an existing column name', () => {
    const { result } = start()
    let outcome: { ok: boolean; message?: string } = { ok: true }
    act(() => {
      outcome = result.current.renameColumn('pop', 'name')
    })
    expect(outcome.ok).toBe(false)
    expect(result.current.draft!.columns).toHaveLength(2)
  })

  it('deletes selected features as one undoable command', () => {
    const { result } = start()
    act(() => result.current.deleteFeatures(['0']))
    expect(result.current.draft!.features).toHaveLength(1)
    act(() => result.current.undo())
    expect(result.current.draft!.features).toHaveLength(2)
    expect(result.current.draft!.features[0]!.id).toBe('0')
  })

  it('serialises to a FeatureCollection preserving nesting and nulls', () => {
    const nested = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [1, 2] },
          properties: { meta: { a: [1, 2] }, empty: null },
        },
      ],
    })
    const { result } = renderHook(() =>
      useImportDraft(draftFromParse(parseGeoJson(nested), 'x.geojson', 10)),
    )
    const collection = result.current.toFeatureCollection()
    expect(collection.type).toBe('FeatureCollection')
    expect(collection.features).toEqual([
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [1, 2] },
        properties: { meta: { a: [1, 2] }, empty: null },
      },
    ])
  })
})

describe('useImportDraft in records mode', () => {
  const rows = JSON.stringify([
    { city: 'Beijing', lon: 116.4, lat: 39.9 },
    { city: 'Lhasa', lon: 91.1, lat: 29.6 },
  ])
  const startRecords = () =>
    renderHook(() => useImportDraft(draftFromParse(parseGeoJson(rows), 'rows.json', 99)))

  it('rebuilds geometry when a coordinate cell is edited', () => {
    const { result } = startRecords()
    act(() => result.current.setCellValue('0', 'lat', 40.5))
    expect(result.current.draft!.features[0]!.geometry).toEqual({
      type: 'Point',
      coordinates: [116.4, 40.5],
    })
  })

  it('rebuilds geometry when the coordinate columns change', () => {
    const { result } = startRecords()
    act(() => result.current.setGeometryColumns(null, null))
    expect(result.current.draft!.features[0]!.geometry).toBeNull()
    act(() => result.current.setGeometryColumns('lon', 'lat'))
    expect(result.current.draft!.features[0]!.geometry).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- --run src/features/import/useImportDraft.test.ts`
Expected: FAIL — cannot resolve `./useImportDraft`.

- [ ] **Step 3: Write the implementation**

Create `gis-platform/web/src/features/import/useImportDraft.ts`:

```ts
/**
 * In-memory import draft with undo/redo.
 *
 * The draft is not server state (TanStack Query) and not shared UI state
 * (layerStore) -- it belongs to the preview and dies with it. Keeping it in
 * component state is what makes "cancel leaves no trace" trivially true.
 *
 * Every mutation is expressed as a command that carries its own inverse, so
 * undo is a pop rather than a diff against a snapshot of the whole draft.
 */

import { useCallback, useMemo, useState } from 'react'

import {
  buildPointGeometry,
  type DetectedFormat,
  type DraftColumn,
  type DraftFeature,
  type ParseResult,
} from './parseGeoJson'

export interface ImportDraft {
  fileName: string
  fileSize: number
  detectedFormat: DetectedFormat
  columns: DraftColumn[]
  features: DraftFeature[]
  geometryTypes: string[]
  lonColumn: string | null
  latColumn: string | null
}

export function draftFromParse(
  result: ParseResult,
  fileName: string,
  fileSize: number,
): ImportDraft {
  return {
    fileName,
    fileSize,
    detectedFormat: result.detectedFormat,
    columns: result.columns,
    features: result.features,
    geometryTypes: result.geometryTypes,
    lonColumn: result.lonColumn,
    latColumn: result.latColumn,
  }
}

/** A draft derives geometry from properties only for plain-JSON roots. */
const derivesGeometry = (draft: ImportDraft): boolean =>
  draft.detectedFormat === 'array' || draft.detectedFormat === 'records'

function withDerivedGeometry(draft: ImportDraft): ImportDraft {
  if (!derivesGeometry(draft)) return draft
  const features = draft.features.map((feature) => ({
    ...feature,
    geometry: buildPointGeometry(feature.properties, draft.lonColumn, draft.latColumn),
  }))
  const geometryTypes = features.some((feature) => feature.geometry) ? ['Point'] : []
  return { ...draft, features, geometryTypes }
}

/**
 * Undo replays the surviving stack from `base` rather than applying an
 * inverse, so a command only needs `apply`. That is why every `apply` must be
 * a pure function of the draft it receives -- it will be re-run on every
 * render that follows an undo.
 */
interface Command {
  apply: (draft: ImportDraft) => ImportDraft
}

const nameTaken = (draft: ImportDraft, name: string) =>
  draft.columns.some((column) => column.name === name)

export function useImportDraft(initial: ImportDraft | null) {
  const [base] = useState(initial)
  const [undoStack, setUndoStack] = useState<Command[]>([])
  const [redoStack, setRedoStack] = useState<Command[]>([])

  const draft = useMemo(() => {
    if (!base) return null
    return undoStack.reduce((current, command) => command.apply(current), base)
  }, [base, undoStack])

  const push = useCallback((command: Command) => {
    setUndoStack((stack) => [...stack, command])
    setRedoStack([]) // a new edit invalidates any redo future
  }, [])

  const setCellValue = useCallback(
    (featureId: string, column: string, value: unknown) => {
      push({
        apply: (current) =>
          withDerivedGeometry({
            ...current,
            features: current.features.map((feature) =>
              feature.id === featureId
                ? { ...feature, properties: { ...feature.properties, [column]: value } }
                : feature,
            ),
          }),
      })
    },
    [push],
  )

  const addColumn = useCallback(
    (name: string) => {
      const trimmed = name.trim()
      if (!draft) return { ok: false, message: 'No draft loaded' }
      if (!trimmed) return { ok: false, message: 'Column name cannot be empty' }
      if (nameTaken(draft, trimmed)) return { ok: false, message: `"${trimmed}" already exists` }

      const column: DraftColumn = { name: trimmed, type: 'text', mixed: false }
      push({ apply: (current) => ({ ...current, columns: [...current.columns, column] }) })
      return { ok: true }
    },
    [draft, push],
  )

  const renameColumn = useCallback(
    (from: string, to: string) => {
      const trimmed = to.trim()
      if (!draft) return { ok: false, message: 'No draft loaded' }
      if (!trimmed) return { ok: false, message: 'Column name cannot be empty' }
      if (trimmed === from) return { ok: true }
      if (nameTaken(draft, trimmed)) return { ok: false, message: `"${trimmed}" already exists` }

      const rename = (current: ImportDraft, before: string, after: string): ImportDraft =>
        withDerivedGeometry({
          ...current,
          columns: current.columns.map((column) =>
            column.name === before ? { ...column, name: after } : column,
          ),
          features: current.features.map((feature) => {
            if (!(before in feature.properties)) return feature
            // Rebuild in order so the renamed key keeps its position.
            const properties: Record<string, unknown> = {}
            for (const [key, value] of Object.entries(feature.properties)) {
              properties[key === before ? after : key] = value
            }
            return { ...feature, properties }
          }),
          lonColumn: current.lonColumn === before ? after : current.lonColumn,
          latColumn: current.latColumn === before ? after : current.latColumn,
        })

      push({ apply: (current) => rename(current, from, trimmed) })
      return { ok: true }
    },
    [draft, push],
  )

  const deleteFeatures = useCallback(
    (featureIds: string[]) => {
      if (featureIds.length === 0) return
      const ids = new Set(featureIds)
      // Filtering (rather than splicing by captured index) is what keeps undo
      // order-correct: replaying from `base` reproduces the original order for
      // free, with no positions to restore.
      push({
        apply: (current) => ({
          ...current,
          features: current.features.filter((feature) => !ids.has(feature.id)),
        }),
      })
    },
    [push],
  )

  const setGeometryColumns = useCallback(
    (lon: string | null, lat: string | null) => {
      push({
        apply: (current) => withDerivedGeometry({ ...current, lonColumn: lon, latColumn: lat }),
      })
    },
    [push],
  )

  const undo = useCallback(() => {
    setUndoStack((stack) => {
      if (stack.length === 0) return stack
      const command = stack[stack.length - 1]!
      setRedoStack((redo) => [...redo, command])
      return stack.slice(0, -1)
    })
  }, [])

  const redo = useCallback(() => {
    setRedoStack((stack) => {
      if (stack.length === 0) return stack
      const command = stack[stack.length - 1]!
      setUndoStack((undoEntries) => [...undoEntries, command])
      return stack.slice(0, -1)
    })
  }, [])

  const toFeatureCollection = useCallback(
    () => ({
      type: 'FeatureCollection' as const,
      features: (draft?.features ?? []).map((feature) => ({
        type: 'Feature',
        geometry: feature.geometry,
        properties: feature.properties,
      })),
    }),
    [draft],
  )

  return {
    draft,
    isDirty: undoStack.length > 0,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    setCellValue,
    addColumn,
    renameColumn,
    deleteFeatures,
    setGeometryColumns,
    undo,
    redo,
    toFeatureCollection,
  }
}
```

Note: `setCellValue` always writes the key, so an edit turns an absent
property into a present one — which is what the user means by typing into an
empty cell. Undo removes the command, so absence is restored by replay rather
than by a delete branch.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- --run src/features/import/useImportDraft.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full gate**

Run: `npm run lint && npm run typecheck && npm run test -- --run`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/features/import/useImportDraft.ts src/features/import/useImportDraft.test.ts
git commit -m "feat: hold the import draft in memory with undo and redo

The draft is neither server state nor shared UI state, so it lives in
component state -- which is what makes 'cancel leaves no database record'
true by construction rather than by cleanup.

Edits are commands replayed from the parsed baseline, so undo is a pop and
dirty state is just a non-empty stack. Deleting features records positions
so undo restores original ordering; renaming a column rebuilds property
objects in order so the key keeps its place.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Web Worker Boundary

Parsing a large file must not block the main thread. The worker is transport
only: it imports Task 6's parser and posts the result back. The boundary is
deliberately thin so a worker failure can fall back to the same function
running inline.

**Files:**
- Create: `gis-platform/web/src/features/import/parseWorker.ts`
- Create: `gis-platform/web/src/features/import/useParseWorker.ts`
- Test: `gis-platform/web/src/features/import/useParseWorker.test.ts`

**Interfaces:**
- Consumes: `parseGeoJson`, `ParseError`, `ParseResult` (Task 6).
- Produces:
  ```ts
  export interface ParseRequest { text: string }
  export type ParseResponse =
    | { ok: true; result: ParseResult }
    | { ok: false; code: string; message: string }
  export function useParseWorker(): {
    parse: (text: string) => Promise<ParseResult>
    usedFallback: boolean
  }
  ```
- Task 12 consumes `useParseWorker`.

- [ ] **Step 1: Write the failing test**

Create `gis-platform/web/src/features/import/useParseWorker.test.ts`:

```ts
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ParseError } from './parseGeoJson'
import { useParseWorker } from './useParseWorker'

const DOCUMENT = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [1, 2] },
      properties: { a: 1 },
    },
  ],
})

afterEach(() => vi.unstubAllGlobals())

describe('useParseWorker', () => {
  it('falls back to main-thread parsing when a Worker cannot be constructed', async () => {
    // jsdom has no module-worker support; constructing one throws, which is
    // exactly the condition the fallback exists for.
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('Worker is not supported')
        }
      },
    )

    const { result } = renderHook(() => useParseWorker())
    const parsed = await result.current.parse(DOCUMENT)

    expect(parsed.features).toHaveLength(1)
    expect(result.current.usedFallback).toBe(true)
  })

  it('surfaces a coded ParseError from the fallback path', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('Worker is not supported')
        }
      },
    )

    const { result } = renderHook(() => useParseWorker())
    await expect(result.current.parse('{not json')).rejects.toBeInstanceOf(ParseError)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- --run src/features/import/useParseWorker.test.ts`
Expected: FAIL — cannot resolve `./useParseWorker`.

- [ ] **Step 3: Write the worker**

Create `gis-platform/web/src/features/import/parseWorker.ts`:

```ts
/// <reference lib="webworker" />
/**
 * Transport only. All parsing logic lives in `parseGeoJson.ts` so it stays
 * testable without worker plumbing, and so the main-thread fallback in
 * `useParseWorker.ts` runs byte-identical code.
 */

import { ParseError, parseGeoJson } from './parseGeoJson'
import type { ParseRequest, ParseResponse } from './workerTypes'

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  try {
    const result = parseGeoJson(event.data.text)
    const response: ParseResponse = { ok: true, result }
    self.postMessage(response)
  } catch (error) {
    const response: ParseResponse =
      error instanceof ParseError
        ? { ok: false, code: error.code, message: error.message }
        : { ok: false, code: 'parse_failed', message: (error as Error).message }
    self.postMessage(response)
  }
}
```

- [ ] **Step 4: Write the shared message types**

Create `gis-platform/web/src/features/import/workerTypes.ts`:

```ts
import type { ParseResult } from './parseGeoJson'

export interface ParseRequest {
  text: string
}

export type ParseResponse =
  | { ok: true; result: ParseResult }
  | { ok: false; code: string; message: string }
```

- [ ] **Step 5: Write the hook**

Create `gis-platform/web/src/features/import/useParseWorker.ts`:

```ts
/**
 * Run parsing off the main thread, with an inline fallback.
 *
 * A worker is an optimisation, not a requirement: if one cannot be built
 * (no worker support, a restrictive CSP, a test environment), parsing still
 * happens -- just on the main thread. Behaviour is identical either way,
 * because both paths call the same `parseGeoJson`.
 */

import { useCallback, useRef, useState } from 'react'

import { ParseError, type ParseResult, parseGeoJson } from './parseGeoJson'
import type { ParseRequest, ParseResponse } from './workerTypes'

function createWorker(): Worker | null {
  try {
    return new Worker(new URL('./parseWorker.ts', import.meta.url), { type: 'module' })
  } catch {
    return null
  }
}

export function useParseWorker() {
  const workerRef = useRef<Worker | null | undefined>(undefined)
  const [usedFallback, setUsedFallback] = useState(false)

  const parse = useCallback((text: string): Promise<ParseResult> => {
    if (workerRef.current === undefined) workerRef.current = createWorker()
    const worker = workerRef.current

    if (!worker) {
      setUsedFallback(true)
      // Deferred to a microtask so both paths reject asynchronously, and a
      // synchronous throw here can never escape into React's render phase.
      return Promise.resolve().then(() => parseGeoJson(text))
    }

    return new Promise<ParseResult>((resolve, reject) => {
      const cleanup = () => {
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onError)
      }

      const onMessage = (event: MessageEvent<ParseResponse>) => {
        cleanup()
        const data = event.data
        if (data.ok) resolve(data.result)
        else reject(new ParseError(data.code, data.message))
      }

      const onError = (event: ErrorEvent) => {
        cleanup()
        // A worker that dies mid-parse must not hang the preview: fall back.
        workerRef.current = null
        setUsedFallback(true)
        try {
          resolve(parseGeoJson(text))
        } catch (error) {
          reject(error instanceof ParseError ? error : new ParseError('parse_failed', event.message))
        }
      }

      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onError)
      const request: ParseRequest = { text }
      worker.postMessage(request)
    })
  }, [])

  return { parse, usedFallback }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test -- --run src/features/import/useParseWorker.test.ts`
Expected: PASS.

- [ ] **Step 7: Verify the worker bundles for a real build**

Run: `npm run build`
Expected: succeeds, and the output lists a separate worker chunk. If Vite
reports it cannot resolve the worker URL, the `new URL(..., import.meta.url)`
form has been altered — restore it rather than switching to a string path.

- [ ] **Step 8: Run the full gate**

Run: `npm run lint && npm run typecheck && npm run test -- --run`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add src/features/import/parseWorker.ts src/features/import/workerTypes.ts \
        src/features/import/useParseWorker.ts src/features/import/useParseWorker.test.ts
git commit -m "feat: parse import files in a Web Worker with an inline fallback

Large files must not freeze the UI while they parse. The worker is pure
transport around parseGeoJson, so the fallback path -- used when a worker
cannot be constructed or dies mid-parse -- runs identical code rather than a
second implementation that could drift.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: ag-grid Draft Grid

Adds the only new runtime dependency and wires the editable attribute table.
Community modules only.

**Files:**
- Modify: `gis-platform/web/package.json`
- Create: `gis-platform/web/src/features/import/DraftGrid.tsx`
- Modify: `gis-platform/web/src/index.css`
- Test: `gis-platform/web/src/features/import/DraftGrid.test.tsx`

**Editor choice:** ag-grid's stock Community editors are used —
`agTextCellEditor` for text/number/date, `agCheckboxCellEditor` for boolean,
`agLargeTextCellEditor` for `json`. A custom editor component would add a
second place where type rules live; instead every editor hands back a string
(or a boolean) and the single `valueSetter` runs it through `coerceCellInput`,
so the grid and the server agree by construction. `agLargeTextCellEditor`
renders a textarea, which is the formatted-JSON editing surface the spec asks
for.

**Interfaces:**
- Consumes: `DraftColumn`, `DraftFeature` (Task 6); `coerceCellInput` (Task 7).
- Produces:
  ```ts
  interface DraftGridProps {
    columns: DraftColumn[]
    features: DraftFeature[]
    selectedIds: string[]
    search: string
    cellErrors: Record<string, string>          // key: `${featureId}:${column}`
    onSelectionChange: (ids: string[]) => void
    onCellEdit: (featureId: string, column: string, value: unknown) => void
    onCellError: (featureId: string, column: string, message: string | null) => void
  }
  export function DraftGrid(props: DraftGridProps): JSX.Element
  ```
- Task 12 renders it.

- [ ] **Step 1: Install the dependency**

Run:
```bash
npm install ag-grid-community@36.0.2 ag-grid-react@36.0.2
```
Expected: both land in `dependencies`. Confirm no `ag-grid-enterprise` and no
`ag-grid-charts-enterprise` appears anywhere in `package.json` or the lockfile.

Run: `grep -c "ag-grid-enterprise" package.json package-lock.json || true`
Expected: `0` for both.

- [ ] **Step 2: Write the failing tests**

Create `gis-platform/web/src/features/import/DraftGrid.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { DraftGrid } from './DraftGrid'
import type { DraftColumn, DraftFeature } from './parseGeoJson'

const columns: DraftColumn[] = [
  { name: 'name', type: 'text', mixed: false },
  { name: 'pop', type: 'number', mixed: false },
  { name: 'meta', type: 'json', mixed: false },
]

const features: DraftFeature[] = [
  {
    id: '0',
    geometry: { type: 'Point', coordinates: [1, 2] },
    properties: { name: 'Beijing', pop: 21540000, meta: { a: 1 } },
  },
  {
    id: '1',
    geometry: { type: 'Point', coordinates: [3, 4] },
    properties: { name: 'Lhasa', pop: 560000, meta: null },
  },
]

function renderGrid(overrides: Partial<Parameters<typeof DraftGrid>[0]> = {}) {
  const props = {
    columns,
    features,
    selectedIds: [] as string[],
    search: '',
    cellErrors: {} as Record<string, string>,
    onSelectionChange: vi.fn(),
    onCellEdit: vi.fn(),
    onCellError: vi.fn(),
    ...overrides,
  }
  render(<DraftGrid {...props} />)
  return props
}

describe('DraftGrid', () => {
  it('renders a column per inferred property and a row per feature', async () => {
    renderGrid()
    expect(await screen.findByText('Beijing')).toBeInTheDocument()
    expect(screen.getByText('Lhasa')).toBeInTheDocument()
    for (const name of ['name', 'pop', 'meta']) {
      expect(screen.getByRole('columnheader', { name: new RegExp(name, 'i') })).toBeInTheDocument()
    }
  })

  it('renders an explicit null distinctly from an empty cell', async () => {
    renderGrid()
    expect(await screen.findByText('null')).toBeInTheDocument()
  })

  it('shows nested values as compact JSON rather than [object Object]', async () => {
    renderGrid()
    expect(await screen.findByText('{"a":1}')).toBeInTheDocument()
  })

  it('reports a coerced value when a cell is edited', async () => {
    const props = renderGrid()
    const cell = await screen.findByTestId('cell-0-pop')
    await userEvent.dblClick(cell)
    const input = within(cell).getByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, '22000000{Enter}')
    expect(props.onCellEdit).toHaveBeenCalledWith('0', 'pop', 22000000)
  })

  it('reports an error and does not edit when a value will not coerce', async () => {
    const props = renderGrid()
    const cell = await screen.findByTestId('cell-0-pop')
    await userEvent.dblClick(cell)
    const input = within(cell).getByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, 'lots{Enter}')
    expect(props.onCellEdit).not.toHaveBeenCalled()
    expect(props.onCellError).toHaveBeenCalledWith('0', 'pop', expect.stringMatching(/number/i))
  })

  it('clearing a cell yields null rather than an empty string', async () => {
    const props = renderGrid()
    const cell = await screen.findByTestId('cell-0-name')
    await userEvent.dblClick(cell)
    await userEvent.clear(within(cell).getByRole('textbox'))
    await userEvent.keyboard('{Enter}')
    expect(props.onCellEdit).toHaveBeenCalledWith('0', 'name', null)
  })

  it('rejects invalid JSON in a json cell and keeps the prior value', async () => {
    const props = renderGrid()
    const cell = await screen.findByTestId('cell-0-meta')
    await userEvent.dblClick(cell)
    const input = within(cell).getByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, '{{not json{Enter}')
    expect(props.onCellEdit).not.toHaveBeenCalled()
    expect(props.onCellError).toHaveBeenCalledWith('0', 'meta', expect.stringMatching(/json/i))
  })

  it('marks a cell that carries a validation error', async () => {
    renderGrid({ cellErrors: { '0:pop': 'Not a finite number' } })
    expect(await screen.findByTestId('cell-0-pop')).toHaveClass('draft-grid__cell--error')
  })

  it('filters rows by a case-insensitive substring across every column', async () => {
    renderGrid({ search: 'lha' })
    expect(await screen.findByText('Lhasa')).toBeInTheDocument()
    expect(screen.queryByText('Beijing')).not.toBeInTheDocument()
  })

  it('reports selection changes by feature id', async () => {
    const props = renderGrid()
    await screen.findByText('Beijing')
    await userEvent.click(screen.getAllByRole('checkbox')[1]!)
    expect(props.onSelectionChange).toHaveBeenCalledWith(expect.arrayContaining(['0']))
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test -- --run src/features/import/DraftGrid.test.tsx`
Expected: FAIL — cannot resolve `./DraftGrid`.

- [ ] **Step 4: Write the grid**

Create `gis-platform/web/src/features/import/DraftGrid.tsx`:

```tsx
/**
 * The editable attribute table for an import draft.
 *
 * ag-grid Community supplies virtualisation, sorting, filtering and column
 * resizing. Everything policy-shaped -- what an empty cell means, how a
 * nested value is edited, which values refuse to commit -- lives here, so it
 * matches the server's rules rather than the grid's defaults.
 *
 * This does not replace `features/attributes/AttributeTable.tsx`, which serves
 * persisted layers. Only the draft is rendered here.
 */

import {
  AllCommunityModule,
  type ColDef,
  type ICellRendererParams,
  ModuleRegistry,
  type ValueSetterParams,
} from 'ag-grid-community'
import { AgGridReact } from 'ag-grid-react'
import { useCallback, useMemo, useRef } from 'react'

import type { DraftColumn, DraftFeature } from './parseGeoJson'
import { coerceCellInput } from './validation'

ModuleRegistry.registerModules([AllCommunityModule])

export interface DraftGridProps {
  columns: DraftColumn[]
  features: DraftFeature[]
  selectedIds: string[]
  search: string
  /** Keyed `${featureId}:${column}`. */
  cellErrors: Record<string, string>
  onSelectionChange: (ids: string[]) => void
  onCellEdit: (featureId: string, column: string, value: unknown) => void
  onCellError: (featureId: string, column: string, message: string | null) => void
}

interface Row {
  id: string
  properties: Record<string, unknown>
}

/**
 * Stock Community editors, chosen per inferred type. Everything hands back a
 * string (or a boolean) and `valueSetter` does the typing, so there is exactly
 * one place where a value is converted -- and it is the one that mirrors the
 * server.
 */
const EDITORS: Record<DraftColumn['type'], string> = {
  text: 'agTextCellEditor',
  number: 'agTextCellEditor',
  date: 'agTextCellEditor',
  boolean: 'agCheckboxCellEditor',
  json: 'agLargeTextCellEditor',
}

/** Display text for a cell. Distinguishes absent (blank) from explicit null. */
function display(value: unknown): string {
  if (value === undefined) return ''
  if (value === null) return 'null'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function DraftGrid({
  columns,
  features,
  selectedIds,
  search,
  cellErrors,
  onSelectionChange,
  onCellEdit,
  onCellError,
}: DraftGridProps) {
  const gridRef = useRef<AgGridReact<Row>>(null)

  const rows = useMemo<Row[]>(
    () => features.map((feature) => ({ id: feature.id, properties: feature.properties })),
    [features],
  )

  const buildSetter = useCallback(
    (column: DraftColumn) => (params: ValueSetterParams<Row>) => {
      const raw = params.newValue
      const text = raw === null || raw === undefined ? '' : String(raw)
      const outcome =
        column.type === 'json' && typeof raw === 'object' && raw !== null
          ? { ok: true as const, value: raw }
          : coerceCellInput(text, column.type)

      if (!outcome.ok) {
        onCellError(params.data.id, column.name, outcome.message)
        return false // ag-grid keeps the prior value
      }
      onCellError(params.data.id, column.name, null)
      onCellEdit(params.data.id, column.name, outcome.value)
      return true
    },
    [onCellEdit, onCellError],
  )

  const columnDefs = useMemo<ColDef<Row>[]>(() => {
    const checkbox: ColDef<Row> = {
      colId: '__select__',
      headerName: '',
      width: 44,
      pinned: 'left',
      checkboxSelection: true,
      headerCheckboxSelection: true,
      sortable: false,
      filter: false,
      resizable: false,
      editable: false,
    }

    const rest = columns.map<ColDef<Row>>((column) => ({
      colId: column.name,
      headerName: column.mixed ? `${column.name} (mixed)` : column.name,
      field: `properties.${column.name}` as never,
      sortable: true,
      filter: true,
      resizable: true,
      editable: true,
      cellEditor: EDITORS[column.type],
      cellEditorPopup: column.type === 'json',
      // useFormatter makes the editor open on `display(value)` -- compact JSON
      // -- instead of "[object Object]", which is what a raw object stringifies to.
      cellEditorParams:
        column.type === 'json'
          ? { useFormatter: true, maxLength: 100_000, rows: 8, cols: 60 }
          : undefined,
      valueGetter: (params) => params.data?.properties[column.name],
      valueFormatter: (params) => display(params.value),
      valueSetter: buildSetter(column),
      cellClass: (params) =>
        cellErrors[`${params.data?.id}:${column.name}`]
          ? 'draft-grid__cell draft-grid__cell--error'
          : 'draft-grid__cell',
      cellRenderer: (params: ICellRendererParams<Row>) => (
        <span data-testid={`cell-${params.data?.id}-${column.name}`}>{display(params.value)}</span>
      ),
      tooltipValueGetter: (params) => cellErrors[`${params.data?.id}:${column.name}`] ?? undefined,
    }))

    return [checkbox, ...rest]
  }, [columns, cellErrors, buildSetter])

  const handleSelection = useCallback(() => {
    const selected = gridRef.current?.api.getSelectedRows() ?? []
    onSelectionChange(selected.map((row) => row.id))
  }, [onSelectionChange])

  return (
    <div className="draft-grid">
      <AgGridReact<Row>
        ref={gridRef}
        rowData={rows}
        columnDefs={columnDefs}
        getRowId={(params) => params.data.id}
        quickFilterText={search}
        rowSelection={{ mode: 'multiRow' }}
        onSelectionChanged={handleSelection}
        stopEditingWhenCellsLoseFocus
        // Virtualisation is ag-grid's default; stated here so it is not
        // silently disabled by a future config change.
        suppressColumnVirtualisation={false}
        domLayout="normal"
      />
    </div>
  )
}
```

- [ ] **Step 5: Style the grid against the existing theme**

Append to `gis-platform/web/src/index.css`:

```css
.draft-grid { height: 100%; min-height: 200px; }
.draft-grid .ag-root-wrapper {
  --ag-background-color: #fff;
  --ag-header-background-color: var(--panel-bg);
  --ag-border-color: var(--panel-border);
  --ag-foreground-color: var(--text);
  --ag-selected-row-background-color: #fef3c7;
  --ag-font-family: inherit;
  --ag-font-size: 13px;
}
.draft-grid__cell--error { background: #fee2e2; }
.draft-grid .ag-large-text-input textarea { font-family: ui-monospace, monospace; font-size: 12px; }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test -- --run src/features/import/DraftGrid.test.tsx`
Expected: PASS. If ag-grid's virtualisation hides rows in jsdom, set an
explicit height on the wrapper in the test via `domLayout="autoHeight"` — do
not weaken the assertions to match a rendering artefact.

- [ ] **Step 7: Run the full gate**

Run: `npm run lint && npm run typecheck && npm run test -- --run`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/index.css \
        src/features/import/DraftGrid.tsx src/features/import/DraftGrid.test.tsx
git commit -m "feat: add the ag-grid draft attribute table

ag-grid Community supplies virtualisation, sorting, filtering and column
resizing; the policy lives in our code so it matches the server's rules
rather than the grid's defaults -- an empty cell commits null rather than an
empty string, a value that will not coerce is refused with the prior value
intact, and nested values render as compact JSON and edit as formatted JSON.

Stock Community editors are chosen per inferred type rather than a custom
editor component, so there is exactly one place a value gets typed and it is
the one that mirrors the server. Modules are registered explicitly. The
existing AttributeTable for persisted layers is untouched.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Preview Map

Its own OpenLayers map, built the way `MapProvider` builds the main one. The
draft has no server layer id, so it deliberately does not touch `layerStore`,
`featureLoader` or the memory manager — all of which key on a persisted layer.

**Files:**
- Create: `gis-platform/web/src/features/import/PreviewMap.tsx`
- Test: `gis-platform/web/src/features/import/PreviewMap.test.tsx`

**Interfaces:**
- Consumes: `DraftFeature` (Task 6).
- Produces:
  ```ts
  interface PreviewMapProps {
    features: DraftFeature[]
    selectedIds: string[]
    maxRendered: number
    onSelect: (featureIds: string[]) => void
  }
  export function PreviewMap(props: PreviewMapProps): JSX.Element
  ```
- Task 12 renders it.

- [ ] **Step 1: Write the failing test**

Create `gis-platform/web/src/features/import/PreviewMap.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { PreviewMap } from './PreviewMap'
import type { DraftFeature } from './parseGeoJson'

const features: DraftFeature[] = [
  { id: '0', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: { n: 1 } },
  { id: '1', geometry: { type: 'Point', coordinates: [91.1, 29.6] }, properties: { n: 2 } },
  { id: '2', geometry: null, properties: { n: 3 } },
]

describe('PreviewMap', () => {
  it('renders a named map region without crashing on a null geometry', () => {
    render(
      <PreviewMap features={features} selectedIds={[]} maxRendered={100} onSelect={vi.fn()} />,
    )
    expect(screen.getByRole('region', { name: /import preview map/i })).toBeInTheDocument()
  })

  it('reports how many features it is showing when the draft exceeds the cap', () => {
    render(<PreviewMap features={features} selectedIds={[]} maxRendered={1} onSelect={vi.fn()} />)
    expect(screen.getByText(/showing 1 of 2/i)).toBeInTheDocument()
  })

  it('does not announce a subset when everything fits', () => {
    render(<PreviewMap features={features} selectedIds={[]} maxRendered={100} onSelect={vi.fn()} />)
    expect(screen.queryByText(/showing/i)).not.toBeInTheDocument()
  })

  it('survives a feature whose geometry is malformed', () => {
    const broken: DraftFeature[] = [
      { id: '0', geometry: { type: 'Point', coordinates: 'nonsense' }, properties: {} },
    ]
    expect(() =>
      render(<PreviewMap features={broken} selectedIds={[]} maxRendered={10} onSelect={vi.fn()} />),
    ).not.toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- --run src/features/import/PreviewMap.test.tsx`
Expected: FAIL — cannot resolve `./PreviewMap`.

- [ ] **Step 3: Write the implementation**

Create `gis-platform/web/src/features/import/PreviewMap.tsx`:

```tsx
/**
 * The draft's own OpenLayers map.
 *
 * A second Map instance rather than the app's: the draft has no layer id, so
 * it cannot participate in layerStore, featureLoader or the memory manager,
 * all of which key on a persisted layer. Isolation is also what makes cancel
 * free -- nothing to unwind on the main map.
 *
 * A malformed geometry is skipped rather than thrown: one bad feature must not
 * blank the preview the user needs in order to find and fix it.
 */

import Feature from 'ol/Feature'
import OlMap from 'ol/Map'
import View from 'ol/View'
import GeoJSON from 'ol/format/GeoJSON'
import VectorLayer from 'ol/layer/Vector'
import { fromLonLat } from 'ol/proj'
import VectorSource from 'ol/source/Vector'
import { Circle, Fill, Stroke, Style } from 'ol/style'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { DraftFeature } from './parseGeoJson'

const FEATURE_ID = 'draftId'

const BASE_STYLE = new Style({
  image: new Circle({ radius: 5, fill: new Fill({ color: '#2563eb' }) }),
  stroke: new Stroke({ color: '#2563eb', width: 2 }),
  fill: new Fill({ color: 'rgba(37, 99, 235, 0.15)' }),
})

const SELECTED_STYLE = new Style({
  image: new Circle({
    radius: 7,
    fill: new Fill({ color: '#b45309' }),
    stroke: new Stroke({ color: '#fff', width: 2 }),
  }),
  stroke: new Stroke({ color: '#b45309', width: 3 }),
  fill: new Fill({ color: 'rgba(180, 83, 9, 0.2)' }),
})

interface PreviewMapProps {
  features: DraftFeature[]
  selectedIds: string[]
  maxRendered: number
  onSelect: (featureIds: string[]) => void
}

export function PreviewMap({ features, selectedIds, maxRendered, onSelect }: PreviewMapProps) {
  const container = useRef<HTMLDivElement>(null)
  const [map] = useState(
    () => new OlMap({ view: new View({ center: fromLonLat([0, 0]), zoom: 2 }), layers: [] }),
  )
  const sourceRef = useRef(new VectorSource())

  // Selection is read through a ref inside the style function, so the layer is
  // built once instead of being rebuilt on every selection change. Declared
  // before the effect that closes over it.
  const selectedIdsRef = useRef(selectedIds)
  selectedIdsRef.current = selectedIds

  const withGeometry = useMemo(
    () => features.filter((feature) => feature.geometry !== null),
    [features],
  )
  const rendered = useMemo(
    () => withGeometry.slice(0, maxRendered),
    [withGeometry, maxRendered],
  )

  // Attach the map to its container once the element exists.
  useEffect(() => {
    if (!container.current) return
    map.setTarget(container.current)
    const layer = new VectorLayer({
      source: sourceRef.current,
      style: (feature) =>
        selectedIdsRef.current.includes(String(feature.get(FEATURE_ID)))
          ? SELECTED_STYLE
          : BASE_STYLE,
    })
    map.addLayer(layer)
    return () => {
      map.setTarget(undefined)
      map.removeLayer(layer)
    }
  }, [map])

  useEffect(() => {
    const format = new GeoJSON({ featureProjection: 'EPSG:3857' })
    const source = sourceRef.current
    source.clear()

    const olFeatures: Feature[] = []
    for (const draft of rendered) {
      try {
        const olFeature = format.readFeature({
          type: 'Feature',
          geometry: draft.geometry,
          properties: { [FEATURE_ID]: draft.id },
        }) as Feature
        olFeature.set(FEATURE_ID, draft.id)
        olFeatures.push(olFeature)
      } catch {
        // Malformed geometry: the validation summary already reports it, and
        // skipping keeps the rest of the preview usable.
      }
    }
    source.addFeatures(olFeatures)

    if (olFeatures.length > 0) {
      const extent = source.getExtent()
      if (extent.every(Number.isFinite)) {
        map.getView().fit(extent, { padding: [24, 24, 24, 24], maxZoom: 12, duration: 0 })
      }
    }
  }, [rendered, map])

  // Repaint when selection changes; the style function reads the ref.
  useEffect(() => {
    sourceRef.current.changed()
    if (selectedIds.length === 0) return
    const target = sourceRef.current
      .getFeatures()
      .find((feature) => String(feature.get(FEATURE_ID)) === selectedIds[0])
    const geometry = target?.getGeometry()
    if (geometry) {
      map.getView().fit(geometry.getExtent(), { padding: [60, 60, 60, 60], maxZoom: 14, duration: 0 })
    }
  }, [selectedIds, map])

  useEffect(() => {
    const handleClick = (event: { pixel: number[] }) => {
      const hit = map.forEachFeatureAtPixel(event.pixel, (feature) => feature)
      onSelect(hit ? [String((hit as Feature).get(FEATURE_ID))] : [])
    }
    map.on('click', handleClick as never)
    return () => map.un('click', handleClick as never)
  }, [map, onSelect])

  const truncated = withGeometry.length > rendered.length

  return (
    <div className="preview-map">
      <div
        className="preview-map__canvas"
        ref={container}
        role="region"
        aria-label="Import preview map"
      />
      {truncated ? (
        <p className="preview-map__note">
          Showing {rendered.length} of {withGeometry.length} features on the map. All features will
          be imported.
        </p>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 4: Add the styles**

Append to `gis-platform/web/src/index.css`:

```css
.preview-map { position: relative; height: 100%; min-height: 220px; }
.preview-map__canvas { position: absolute; inset: 0; }
.preview-map__note {
  position: absolute; bottom: 6px; left: 6px; margin: 0;
  padding: 3px 8px; font-size: 12px;
  background: rgba(255, 255, 255, 0.9); border: 1px solid var(--panel-border);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -- --run src/features/import/PreviewMap.test.tsx`
Expected: PASS.

- [ ] **Step 6: Run the full gate**

Run: `npm run lint && npm run typecheck && npm run test -- --run`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/features/import/PreviewMap.tsx src/features/import/PreviewMap.test.tsx src/index.css
git commit -m "feat: render the import draft on its own OpenLayers map

A second Map instance rather than the app's: a draft has no layer id, so it
cannot participate in layerStore, featureLoader or the memory manager, which
all key on a persisted layer. Isolation is also what makes cancel free --
there is nothing to unwind on the main map.

A malformed geometry is skipped rather than thrown, so one bad feature
cannot blank the preview the user needs to find it. Map rendering is capped
by previewMaxFeatures and says so; the cap never limits what is imported.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Import Preview Workspace and Entry Point

Assembles everything and changes user-facing behaviour for the first time:
picking a `.json`/`.geojson` file opens a preview instead of importing it.

**Files:**
- Create: `gis-platform/web/src/api/imports.ts`
- Create: `gis-platform/web/src/features/import/ImportPreview.tsx`
- Modify: `gis-platform/web/src/api/types.ts`
- Modify: `gis-platform/web/src/features/layers/AddLayerDialog.tsx`
- Modify: `gis-platform/web/src/index.css`
- Test: `gis-platform/web/src/features/import/ImportPreview.test.tsx`
- Test: `gis-platform/web/src/features/layers/AddLayerDialog.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 6–11, plus `apiFetch`/`ApiError`.
- Produces:
  ```ts
  // api/imports.ts
  export const getImportLimits: () => Promise<ImportLimits>
  export const confirmImportDraft: (
    projectId: string,
    body: { name: string; sourceFilename: string; featureCollection: unknown },
  ) => Promise<ImportResult>
  // ImportPreview.tsx
  interface ImportPreviewProps { projectId: string; file: File; onClose: () => void }
  export function ImportPreview(props: ImportPreviewProps): JSX.Element
  ```

- [ ] **Step 1: Add the wire types**

Append to `gis-platform/web/src/api/types.ts`:

```ts
export interface ImportLimits {
  allowedExtensions: string[]
  maxFileBytes: number
  maxFeatures: number
  previewMaxFeatures: number
}

export interface FeatureIssue {
  featureIndex: number
  field: string | null
  code: string
  message: string
}

export interface ImportResult {
  layer: Layer
  importedCount: number
  rejectedCount: number
  warningCount: number
  errors: FeatureIssue[]
  warnings: FeatureIssue[]
}
```

- [ ] **Step 2: Add the API client**

Create `gis-platform/web/src/api/imports.ts`:

```ts
import { apiFetch } from './client'
import type { ImportLimits, ImportResult } from './types'

export const getImportLimits = () => apiFetch<ImportLimits>('/system/import-limits')

export const confirmImportDraft = (
  projectId: string,
  body: { name: string; sourceFilename: string; featureCollection: unknown },
) =>
  apiFetch<ImportResult>(`/projects/${projectId}/layers/import-draft`, {
    method: 'POST',
    json: body,
  })
```

- [ ] **Step 3: Write the failing tests**

Create `gis-platform/web/src/features/import/ImportPreview.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../../api/client'
import * as importsApi from '../../api/imports'
import { ImportPreview } from './ImportPreview'

const DOCUMENT = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [116.4, 39.9] },
      properties: { name: 'Beijing', pop: 21540000 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [91.1, 29.6] },
      properties: { name: 'Lhasa', pop: 560000 },
    },
  ],
})

function fileOf(text: string, name = 'cities.geojson'): File {
  const file = new File([text], name, { type: 'application/geo+json' })
  // jsdom's File.text() is unreliable across versions; make it explicit.
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(text) })
  return file
}

const LIMITS = {
  allowedExtensions: ['.json', '.geojson'],
  maxFileBytes: 64 * 1024 * 1024,
  maxFeatures: 50_000,
  previewMaxFeatures: 5_000,
}

function renderPreview(file: File, onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ImportPreview projectId="p1" file={file} onClose={onClose} />
    </QueryClientProvider>,
  )
  return { onClose }
}

beforeEach(() => {
  vi.spyOn(importsApi, 'getImportLimits').mockResolvedValue(LIMITS)
  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        throw new Error('no worker in jsdom')
      }
    },
  )
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ImportPreview', () => {
  it('shows file metadata and the detected format without importing anything', async () => {
    const spy = vi.spyOn(importsApi, 'confirmImportDraft')
    renderPreview(fileOf(DOCUMENT))

    expect(await screen.findByText('cities.geojson')).toBeInTheDocument()
    expect(screen.getByText(/featurecollection/i)).toBeInTheDocument()
    expect(screen.getByText(/2 features/i)).toBeInTheDocument()
    expect(screen.getByText(/point/i)).toBeInTheDocument()
    expect(spy).not.toHaveBeenCalled()
  })

  it('selecting a grid row highlights the feature on the map', async () => {
    renderPreview(fileOf(DOCUMENT))
    await screen.findByText('Beijing')
    await userEvent.click(screen.getAllByRole('checkbox')[1]!)
    await waitFor(() =>
      expect(screen.getByTestId('preview-selection')).toHaveTextContent('1 selected'),
    )
  })

  it('confirms the import and reports the result', async () => {
    const spy = vi.spyOn(importsApi, 'confirmImportDraft').mockResolvedValue({
      layer: { id: 'l1', name: 'cities' } as never,
      importedCount: 2,
      rejectedCount: 0,
      warningCount: 0,
      errors: [],
      warnings: [],
    })
    renderPreview(fileOf(DOCUMENT))
    await screen.findByText('Beijing')
    await userEvent.click(screen.getByRole('button', { name: /confirm import/i }))

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('p1', {
        name: 'cities',
        sourceFilename: 'cities.geojson',
        featureCollection: expect.objectContaining({ type: 'FeatureCollection' }),
      }),
    )
    expect(await screen.findByText(/imported 2/i)).toBeInTheDocument()
  })

  it('blocks a second confirmation while the first is in flight', async () => {
    let release: (value: never) => void = () => {}
    const spy = vi
      .spyOn(importsApi, 'confirmImportDraft')
      .mockReturnValue(new Promise((resolve) => (release = resolve as never)))

    renderPreview(fileOf(DOCUMENT))
    await screen.findByText('Beijing')
    const confirm = screen.getByRole('button', { name: /confirm import/i })
    await userEvent.click(confirm)
    await userEvent.click(confirm)
    await userEvent.click(confirm)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(confirm).toBeDisabled()
    release(undefined as never)
  })

  it('disables confirm while the draft has a validation error', async () => {
    const broken = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [999, 0] }, properties: {} },
      ],
    })
    renderPreview(fileOf(broken))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /confirm import/i })).toBeDisabled(),
    )
    expect(screen.getByText(/coordinate/i)).toBeInTheDocument()
  })

  it('renders a parse failure as an error state instead of crashing', async () => {
    renderPreview(fileOf('{not json'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not read/i)
    expect(screen.queryByRole('button', { name: /confirm import/i })).not.toBeInTheDocument()
  })

  it('surfaces a server rejection with its feature-level detail', async () => {
    vi.spyOn(importsApi, 'confirmImportDraft').mockRejectedValue(
      new ApiError(422, 'invalid_request', 'The import draft failed validation', {
        errors: [
          { featureIndex: 1, field: null, code: 'coordinate_out_of_range', message: 'Out of range' },
        ],
      }),
    )
    renderPreview(fileOf(DOCUMENT))
    await screen.findByText('Beijing')
    await userEvent.click(screen.getByRole('button', { name: /confirm import/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/out of range/i)
  })

  it('rejects a file above the configured size limit before parsing', async () => {
    vi.spyOn(importsApi, 'getImportLimits').mockResolvedValue({ ...LIMITS, maxFileBytes: 5 })
    renderPreview(fileOf(DOCUMENT))
    expect(await screen.findByRole('alert')).toHaveTextContent(/too large/i)
  })

  it('asks for confirmation before closing with unsaved edits', async () => {
    const { onClose } = renderPreview(fileOf(DOCUMENT))
    await screen.findByText('Beijing')

    // No edits yet: closing is immediate.
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(window.confirm).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('prompts when cancelling after an edit and leaves the server untouched', async () => {
    const spy = vi.spyOn(importsApi, 'confirmImportDraft')
    const { onClose } = renderPreview(fileOf(DOCUMENT))
    const cell = await screen.findByTestId('cell-0-name')
    await userEvent.dblClick(cell)
    await userEvent.keyboard('X{Enter}')

    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(window.confirm).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
    expect(spy).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm run test -- --run src/features/import/ImportPreview.test.tsx`
Expected: FAIL — cannot resolve `./ImportPreview`.

- [ ] **Step 5: Write the preview workspace**

Create `gis-platform/web/src/features/import/ImportPreview.tsx`:

```tsx
/**
 * The staged import workspace.
 *
 * Owns the one piece of state both the map and the grid read -- the selected
 * feature ids -- so synchronisation is a single source with two subscribers
 * rather than two stores echoing each other.
 *
 * Nothing here writes to the server until Confirm Import. Cancelling discards
 * the draft and leaves no database record, because the draft only ever existed
 * in this component.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { ApiError } from '../../api/client'
import { confirmImportDraft, getImportLimits } from '../../api/imports'
import type { FeatureIssue, ImportResult } from '../../api/types'
import { DraftGrid } from './DraftGrid'
import { PreviewMap } from './PreviewMap'
import { ParseError, type ParseResult } from './parseGeoJson'
import { draftFromParse, useImportDraft } from './useImportDraft'
import { useParseWorker } from './useParseWorker'
import { validateDraft } from './validation'

interface ImportPreviewProps {
  projectId: string
  file: File
  onClose: () => void
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const FORMAT_LABEL: Record<string, string> = {
  featureCollection: 'GeoJSON FeatureCollection',
  feature: 'GeoJSON Feature',
  array: 'JSON array of records',
  records: 'JSON object with a records array',
}

export function ImportPreview({ projectId, file, onClose }: ImportPreviewProps) {
  const queryClient = useQueryClient()
  const { parse } = useParseWorker()

  const limits = useQuery({ queryKey: ['import-limits'], queryFn: getImportLimits })

  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [parseFailure, setParseFailure] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [cellErrors, setCellErrors] = useState<Record<string, string>>({})
  const [result, setResult] = useState<ImportResult | null>(null)
  const [serverIssues, setServerIssues] = useState<FeatureIssue[]>([])

  const initial = useMemo(
    () => (parsed ? draftFromParse(parsed, file.name, file.size) : null),
    [parsed, file.name, file.size],
  )
  const editor = useImportDraft(initial)

  // Parse once the limits are known, so the size check happens before the read.
  useEffect(() => {
    if (!limits.data) return
    let cancelled = false

    if (file.size > limits.data.maxFileBytes) {
      setParseFailure(
        `"${file.name}" is ${formatBytes(file.size)}, which is too large. ` +
          `The limit is ${formatBytes(limits.data.maxFileBytes)}.`,
      )
      return
    }

    void file
      .text()
      .then((text) => parse(text))
      .then((value) => {
        if (!cancelled) setParsed(value)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const message =
          error instanceof ParseError ? error.message : (error as Error).message
        setParseFailure(`Could not read "${file.name}": ${message}`)
      })

    return () => {
      cancelled = true
    }
  }, [file, limits.data, parse])

  const draft = editor.draft
  const validation = useMemo(
    () => (draft ? validateDraft(draft.features, draft.columns) : { errors: [], warnings: [] }),
    [draft],
  )

  const needsCoordinates =
    draft !== null &&
    (draft.detectedFormat === 'array' || draft.detectedFormat === 'records') &&
    (draft.lonColumn === null || draft.latColumn === null)

  const confirm = useMutation({
    mutationFn: () =>
      confirmImportDraft(projectId, {
        name: file.name.replace(/\.[^.]+$/, ''),
        sourceFilename: file.name,
        featureCollection: editor.toFeatureCollection(),
      }),
    onSuccess: (value) => {
      setResult(value)
      setServerIssues([])
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] })
    },
    onError: (error: unknown) => {
      const details = error instanceof ApiError ? error.details : null
      const issues =
        details && typeof details === 'object' && 'errors' in details
          ? ((details as { errors: FeatureIssue[] }).errors ?? [])
          : []
      setServerIssues(issues)
    },
  })

  const requestClose = useCallback(() => {
    if (editor.isDirty && !window.confirm('Discard unsaved edits and close this import?')) return
    onClose()
  }, [editor.isDirty, onClose])

  const setCellError = useCallback((featureId: string, column: string, message: string | null) => {
    setCellErrors((current) => {
      const key = `${featureId}:${column}`
      if (message === null) {
        if (!(key in current)) return current
        const next = { ...current }
        delete next[key]
        return next
      }
      return { ...current, [key]: message }
    })
  }, [])

  if (parseFailure) {
    return (
      <div className="import-preview" role="dialog" aria-label="Import preview">
        <p role="alert">{parseFailure}</p>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    )
  }

  if (!draft || !limits.data) {
    return (
      <div className="import-preview" role="dialog" aria-label="Import preview">
        <p>Reading {file.name}…</p>
      </div>
    )
  }

  const blockingErrors = validation.errors.length > 0 || Object.keys(cellErrors).length > 0
  const numericColumns = draft.columns.filter((column) => column.type === 'number')

  return (
    <div className="import-preview" role="dialog" aria-label="Import preview">
      <header className="import-preview__header">
        <div>
          <strong>{draft.fileName}</strong>
          <span className="import-preview__meta">
            {formatBytes(draft.fileSize)} · {FORMAT_LABEL[draft.detectedFormat]} ·{' '}
            {draft.features.length} features
            {draft.geometryTypes.length > 0 ? ` · ${draft.geometryTypes.join(', ')}` : ''}
          </span>
        </div>

        {(draft.detectedFormat === 'array' || draft.detectedFormat === 'records') && (
          <div className="import-preview__coords">
            <label>
              Longitude
              <select
                value={draft.lonColumn ?? ''}
                onChange={(event) =>
                  editor.setGeometryColumns(event.target.value || null, draft.latColumn)
                }
              >
                <option value="">— none —</option>
                {numericColumns.map((column) => (
                  <option key={column.name} value={column.name}>
                    {column.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Latitude
              <select
                value={draft.latColumn ?? ''}
                onChange={(event) =>
                  editor.setGeometryColumns(draft.lonColumn, event.target.value || null)
                }
              >
                <option value="">— none —</option>
                {numericColumns.map((column) => (
                  <option key={column.name} value={column.name}>
                    {column.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        <button type="button" aria-label="Close import preview" onClick={requestClose}>
          ×
        </button>
      </header>

      <div className="import-preview__body">
        <PreviewMap
          features={draft.features}
          selectedIds={selectedIds}
          maxRendered={limits.data.previewMaxFeatures}
          onSelect={setSelectedIds}
        />

        <aside className="import-preview__issues">
          <p className="import-preview__issues-head">
            {validation.errors.length} errors · {validation.warnings.length} warnings
          </p>
          <ul>
            {[...validation.errors, ...validation.warnings].slice(0, 50).map((issue, index) => (
              <li key={`${issue.code}-${issue.featureIndex}-${index}`}>
                <button
                  type="button"
                  onClick={() =>
                    setSelectedIds(issue.featureIndex >= 0 ? [String(issue.featureIndex)] : [])
                  }
                >
                  {issue.featureIndex >= 0 ? `Row ${issue.featureIndex + 1}: ` : ''}
                  {issue.message}
                </button>
              </li>
            ))}
          </ul>
          {needsCoordinates ? (
            <p role="alert">
              Choose a longitude and latitude column before importing these records.
            </p>
          ) : null}
        </aside>
      </div>

      <div className="import-preview__toolbar">
        <input
          type="search"
          aria-label="Search features"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search"
        />
        <button
          type="button"
          onClick={() => {
            const name = window.prompt('New column name')
            if (name === null) return
            const outcome = editor.addColumn(name)
            if (!outcome.ok) window.alert(outcome.message)
          }}
        >
          Add column
        </button>
        <button
          type="button"
          onClick={() => {
            const from = window.prompt('Rename which column?')
            if (from === null) return
            const to = window.prompt(`Rename "${from}" to`)
            if (to === null) return
            const outcome = editor.renameColumn(from, to)
            if (!outcome.ok) window.alert(outcome.message)
          }}
        >
          Rename column
        </button>
        <button
          type="button"
          disabled={selectedIds.length === 0}
          onClick={() => {
            if (!window.confirm(`Delete ${selectedIds.length} selected feature(s)?`)) return
            editor.deleteFeatures(selectedIds)
            setSelectedIds([])
          }}
        >
          Delete selected
        </button>
        <button type="button" aria-label="Undo" disabled={!editor.canUndo} onClick={editor.undo}>
          ↶
        </button>
        <button type="button" aria-label="Redo" disabled={!editor.canRedo} onClick={editor.redo}>
          ↷
        </button>
        <span data-testid="preview-selection">{selectedIds.length} selected</span>
        {editor.isDirty ? <span className="import-preview__dirty">● unsaved edits</span> : null}
      </div>

      <DraftGrid
        columns={draft.columns}
        features={draft.features}
        selectedIds={selectedIds}
        search={search}
        cellErrors={cellErrors}
        onSelectionChange={setSelectedIds}
        onCellEdit={editor.setCellValue}
        onCellError={setCellError}
      />

      {serverIssues.length > 0 ? (
        <div role="alert" className="import-preview__server-errors">
          {serverIssues.slice(0, 20).map((issue, index) => (
            <p key={index}>
              {issue.featureIndex >= 0 ? `Row ${issue.featureIndex + 1}: ` : ''}
              {issue.message}
            </p>
          ))}
        </div>
      ) : confirm.isError ? (
        <p role="alert">{(confirm.error as Error).message}</p>
      ) : null}

      {result ? (
        <p className="import-preview__result">
          Imported {result.importedCount}, rejected {result.rejectedCount}, warnings{' '}
          {result.warningCount}.{' '}
          <button type="button" onClick={onClose}>
            Done
          </button>
        </p>
      ) : (
        <footer className="import-preview__actions">
          <button type="button" onClick={requestClose}>
            Cancel
          </button>
          <button
            type="button"
            disabled={confirm.isPending || blockingErrors || needsCoordinates}
            onClick={() => confirm.mutate()}
          >
            {confirm.isPending ? 'Importing…' : 'Confirm Import'}
          </button>
        </footer>
      )}
    </div>
  )
}
```

- [ ] **Step 6: Add the styles**

Append to `gis-platform/web/src/index.css`:

```css
.import-preview {
  position: fixed; inset: 4%; z-index: 20;
  display: grid; grid-template-rows: auto 1fr auto 2fr auto auto;
  gap: 8px; padding: 16px;
  background: #fff; border: 1px solid var(--panel-border); overflow: auto;
}
.import-preview__header { display: flex; align-items: center; gap: 16px; justify-content: space-between; }
.import-preview__meta { color: #64748b; font-size: 12px; margin-left: 8px; }
.import-preview__coords { display: flex; gap: 12px; font-size: 12px; }
.import-preview__body { display: grid; grid-template-columns: 1fr 280px; gap: 8px; min-height: 220px; }
.import-preview__issues { overflow: auto; border: 1px solid var(--panel-border); padding: 8px; }
.import-preview__issues-head { margin: 0 0 6px; font-weight: 600; }
.import-preview__issues ul { list-style: none; margin: 0; padding: 0; font-size: 12px; }
.import-preview__issues button { background: none; border: none; padding: 2px 0; text-align: left; cursor: pointer; font: inherit; color: var(--accent); }
.import-preview__toolbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.import-preview__dirty { color: #b45309; font-size: 12px; }
.import-preview__actions { display: flex; justify-content: flex-end; gap: 8px; }
.import-preview__server-errors { border: 1px solid #fca5a5; background: #fee2e2; padding: 8px; font-size: 12px; }
.import-preview__server-errors p { margin: 0 0 4px; }
.import-preview__result { margin: 0; }
```

- [ ] **Step 7: Run the preview tests to verify they pass**

Run: `npm run test -- --run src/features/import/ImportPreview.test.tsx`
Expected: PASS.

- [ ] **Step 8: Write the failing entry-point test**

Create `gis-platform/web/src/features/layers/AddLayerDialog.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as importsApi from '../../api/imports'
import * as layersApi from '../../api/layers'
import { AddLayerDialog } from './AddLayerDialog'

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <AddLayerDialog projectId="p1" open onClose={vi.fn()} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.spyOn(importsApi, 'getImportLimits').mockResolvedValue({
    allowedExtensions: ['.json', '.geojson'],
    maxFileBytes: 64 * 1024 * 1024,
    maxFeatures: 50_000,
    previewMaxFeatures: 5_000,
  })
  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        throw new Error('no worker in jsdom')
      }
    },
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('AddLayerDialog file routing', () => {
  it('opens the preview for a .geojson instead of importing it', async () => {
    const importSpy = vi.spyOn(layersApi, 'importVector')
    renderDialog()

    const document = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { a: 1 } },
      ],
    })
    const file = new File([document], 'cities.geojson', { type: 'application/geo+json' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(document) })

    await userEvent.upload(screen.getByLabelText(/geojson/i), file)

    expect(await screen.findByRole('dialog', { name: /import preview/i })).toBeInTheDocument()
    expect(importSpy).not.toHaveBeenCalled()
  })

  it('still imports a GeoPackage immediately', async () => {
    const importSpy = vi.spyOn(layersApi, 'importVector').mockResolvedValue({ id: 'l1' } as never)
    renderDialog()

    const file = new File([new Uint8Array([1, 2, 3])], 'roads.gpkg')
    await userEvent.upload(screen.getByLabelText(/geojson/i), file)

    await waitFor(() => expect(importSpy).toHaveBeenCalled())
    expect(screen.queryByRole('dialog', { name: /import preview/i })).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 9: Wire the entry point**

In `gis-platform/web/src/features/layers/AddLayerDialog.tsx`, add the imports:

```tsx
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { getImportLimits } from '../../api/imports'
import { listPostgisTables } from '../../api/catalog'
import { ImportPreview } from '../import/ImportPreview'
import { useLayerMutations } from './useLayerMutations'
```

Add state and the limits query inside the component, next to the existing
`tab` state:

```tsx
  const [staged, setStaged] = useState<File | null>(null)
  const limits = useQuery({ queryKey: ['import-limits'], queryFn: getImportLimits })
```

Replace the file `<input>`'s `onChange` with:

```tsx
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (!file) return
              // A staged format opens the preview; nothing is imported until
              // the user confirms there. Every other format keeps the existing
              // immediate path -- they have no preview implementation.
              const extensions = limits.data?.allowedExtensions ?? ['.json', '.geojson']
              const staging = extensions.some((extension) =>
                file.name.toLowerCase().endsWith(extension),
              )
              if (staging) setStaged(file)
              else mutations.importFile.mutate({ file }, { onSuccess: onClose })
            }}
```

And render the preview after the existing `Close` button, before the closing
`</div>`:

```tsx
      {staged ? (
        <ImportPreview
          projectId={projectId}
          file={staged}
          onClose={() => {
            setStaged(null)
            onClose()
          }}
        />
      ) : null}
```

- [ ] **Step 10: Run the entry-point tests**

Run: `npm run test -- --run src/features/layers/AddLayerDialog.test.tsx`
Expected: PASS.

- [ ] **Step 11: Run the full frontend gate**

Run: `npm run lint && npm run typecheck && npm run test -- --run`
Expected: all green, including the untouched `AttributeTable` tests.

- [ ] **Step 12: Run the full backend gate one final time**

Run (from `gis-platform/backend/`, with `GIS_DATABASE_URL` exported):
`ruff check . && ruff format --check . && mypy app && pytest`
Expected: all green.

- [ ] **Step 13: Verify the end-to-end flow by hand**

Start the stack (`docker compose up -d`, backend on 1316, `npm run dev` on
1317). Then, in the browser:

1. Add layer → pick a `.geojson`. **The layer list must not change.**
2. The preview opens with file metadata, a map, and the grid.
3. Click a map feature → its grid row highlights. Click a grid row → the map
   zooms to that feature.
4. Edit a cell → the dirty dot appears; undo restores it.
5. Cancel → confirm the prompt. Check the layer list is unchanged and
   `SELECT tablename FROM pg_tables WHERE schemaname = 'gis_data'` shows no new
   table.
6. Repeat, and this time Confirm Import → the result line reports counts and
   the layer list refreshes with the new layer.

- [ ] **Step 14: Commit**

```bash
git add src/api/imports.ts src/api/types.ts src/index.css \
        src/features/import/ImportPreview.tsx src/features/import/ImportPreview.test.tsx \
        src/features/layers/AddLayerDialog.tsx src/features/layers/AddLayerDialog.test.tsx
git commit -m "feat: stage JSON/GeoJSON imports behind a preview workspace

Picking a .json or .geojson file now opens a preview instead of importing
it. The overlay owns the selected feature ids, so the map and the grid stay
in sync as one source with two subscribers rather than two stores echoing
each other.

Confirm is blocked while a request is in flight, while validation errors
stand, and while records mode has no coordinate pair. Cancelling discards a
draft that only ever existed in component state, so no database record can
survive it.

Other formats -- GeoPackage, Shapefile, raster -- keep the existing
immediate path; they have no preview implementation.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Plan Self-Review Notes

Corrections applied after checking the plan against the spec:

- **Backend test paths.** The spec named `tests/services/…` and `tests/api/…`;
  the repository uses flat `backend/tests/test_<topic>.py`. The plan uses the
  real convention. Spec §5 should be read with that substitution.
- **`workerTypes.ts`** was not in the spec's file list. It exists so the worker
  and its caller share message types without the hook importing the worker
  module (which would defeat code-splitting). Added to the File Structure above.
- **`normalize_frame`** is exported from `vector_import_service` in Task 4
  because Task 5 needs the CRS/geometry-column normalisation without the GDAL
  read. The spec described the extraction but named only
  `write_frame_and_register`.
- **`_max_features()` indirection** in `draft_import_service` exists solely so
  a test can lower the limit without rebuilding the `@lru_cache`d `Settings`.
  It is one line and replaces a much uglier cache-clearing fixture.
- **`JsonCellEditor` was dropped.** The first draft of Task 10 created a custom
  ag-grid editor component that Task 10's own grid never referenced, and whose
  props did not match ag-grid's editor API. Stock `agLargeTextCellEditor` with
  `useFormatter: true` gives the same formatted-JSON surface, and routing every
  editor through the one `valueSetter` keeps a single place where a value is
  typed. Spec §4.1 and §4.7 name `JsonCellEditor.tsx`; that file is not built.
- **`Command.invert` was dropped.** Undo replays the surviving command stack
  from the parsed baseline, so an inverse is never called. Keeping the field
  would have meant every command carrying dead code — and the captured
  "previous value" state that came with it was the only reason several
  callbacks depended on `draft` at all.

**Spec requirements with no task — none.** Every numbered section of the spec
maps to at least one task: §2 → Task 1; §3.3 → Task 2; §3.7 → Task 3; §3.4 →
Task 4; §3.2/§3.5/§3.6 → Task 5; §4.3/§4.4 → Task 6; client rules → Task 7;
§4.5 → Task 8; §4.8 → Task 9; §4.2/§4.7 → Task 10; §4.6 map → Task 11;
§4.6/§4.9 → Task 12. The "Known gap" section is honoured by the Global
Constraint forbidding an `imported_by` column.
