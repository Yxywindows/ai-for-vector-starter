# Staged JSON/GeoJSON Import — Design

**Date:** 2026-07-31
**Module:** `gis-platform/`
**Branch:** `staged-geojson-import`, off `worktree-gis-platform` at `f837ec4`

## Goal

Replace the current fire-and-forget file import with a staged flow: parse and
validate a `.json`/`.geojson` file in the browser, show it in a preview
workspace with an editable attribute table and a map, and write to PostGIS only
when the user clicks **Confirm Import**. Selecting a file must never import it.

## Non-goals

- Geometry editing. Only feature properties are editable in this iteration;
  geometry is read-only in the attribute table.
- Staging binary formats. GeoPackage, Shapefile and raster keep the existing
  immediate-import path.
- A generic workflow engine, a temporary database schema, or a new abstraction
  layer over the existing import service.

## Known gap: importing user

The requirement to "record the importing user" cannot be met. `gis-platform`
has no authentication and no user model — nothing in the backend reads a
caller identity. Source filename, import time and feature count are recorded;
importing user is deliberately omitted rather than stored as a column that is
always null. When authentication lands, `gis.layer` gains an `imported_by`
column and `draft_import_service` populates it. This is the only requirement
from the source spec that is not implemented.

---

## 1. Conventions reused

Nothing below is redesigned. The feature adopts the module's existing patterns.

| Concern | Reused |
| --- | --- |
| Error envelope | `app/core/errors.py` — `AppError` subclasses serialise to `{"error": {"code", "message", "details"}}` |
| Error types | `InvalidRequestError` (422), `UnsupportedFormatError` (415), `PayloadTooLargeError` (413), `ConflictError` (409) |
| Wire casing | `APIModel` — `alias_generator=to_camel`, `populate_by_name=True`, `extra="forbid"` |
| Settings | `Settings(BaseSettings)`, env prefix `GIS_`, `@lru_cache get_settings()` |
| Layering | `routes → services → repositories → models/schemas` |
| PostGIS write | `vector_import_service` — `to_postgis`, PK + identity on `fid`, GIST index, drop-on-failure |
| Storage CRS | EPSG:4326, as `vector_import_service` already enforces |
| Table naming | `upload_service.slugify_table_name` → `db.identifiers.validate_identifier` |
| Blocking I/O | `anyio.to_thread.run_sync` for geopandas work |
| Client HTTP | `apiFetch` / `ApiError` from `web/src/api/client.ts` |
| Server state | TanStack Query; invalidate `['project', projectId]` after a write |
| Client UI state | Zustand, UI-only — the draft never enters `layerStore` |
| Error display | `<p role="alert">` — the module has no toast system, and this adds none |
| Theme | `--panel-bg`, `--panel-border`, `--text`, `--accent`; `.dialog` idiom in `index.css` |
| Map engine | OpenLayers 10 |
| Limits exposure | `MemoryReport` already publishes config limits to the client; import limits follow that precedent |

---

## 2. Configuration

New fields on `Settings` (`app/core/config.py`), all overridable via `GIS_`
environment variables:

| Field | Default | Meaning |
| --- | --- | --- |
| `import_allowed_extensions` | `[".json", ".geojson"]` | Extensions the staged flow accepts |
| `import_max_file_bytes` | `67_108_864` (64 MiB) | Largest file the staged flow accepts |
| `import_max_features` | `50_000` | Largest feature count accepted for persistence |
| `import_preview_max_features` | `5_000` | Features rendered on the preview map |

`import_max_file_bytes` is separate from the existing `upload_max_bytes`
(512 MiB): a staged draft is held in browser memory and re-serialised as a JSON
request body, so it needs a tighter bound than a streamed GeoTIFF upload.

`import_preview_max_features` bounds map rendering only. The attribute grid is
virtualised and shows every feature; the map draws the first
`import_preview_max_features` and the preview header states that it is showing
a subset. Persistence is never limited by this value.

These are published to the client by a new endpoint so there is one source of
truth:

```
GET /api/v1/system/import-limits → ImportLimits {
  allowedExtensions: string[], maxFileBytes: int,
  maxFeatures: int, previewMaxFeatures: int
}
```

The client fetches this once (TanStack Query, key `['import-limits']`) and
enforces the same limits before parsing. Client-side checks are a courtesy;
the server re-checks every one of them.

---

## 3. Backend

### 3.1 Files

**New**

- `app/schemas/import_draft.py` — wire models.
- `app/services/geojson_validation.py` — pure validation, no database, no I/O.
- `app/services/draft_import_service.py` — orchestration.
- `migrations/versions/<rev>_add_layer_source_filename.py` — one migration.

**Modified**

- `app/services/vector_import_service.py` — extract the shared write-and-register
  span (below). No behavioural change to the file-upload path.
- `app/api/v1/routes/imports.py` — add the draft endpoint.
- `app/api/v1/routes/system.py`, `app/schemas/system.py` — add `ImportLimits`.
- `app/services/system_service.py` — build `ImportLimits` from `Settings`.
- `app/core/config.py` — the four fields above.
- `app/models/layer.py`, `app/schemas/layer.py` — `source_filename`.

### 3.2 Wire models (`app/schemas/import_draft.py`)

```python
class ImportDraftRequest(APIModel):
    name: str                        # layer name; 1..200 chars
    source_filename: str             # original filename, for the audit trail
    feature_collection: dict[str, Any]   # normalised GeoJSON FeatureCollection

class FeatureIssue(APIModel):
    feature_index: int               # 0-based index into features[]
    field: str | None                # property name, or None for feature-level
    code: str                        # stable snake_case, e.g. "coordinate_out_of_range"
    message: str

class ImportResult(APIModel):
    layer: LayerRead
    imported_count: int
    rejected_count: int
    warning_count: int
    errors: list[FeatureIssue]
    warnings: list[FeatureIssue]
```

Because import is all-or-nothing (§3.5), a `201` response always carries
`rejected_count == 0` and `errors == []`. Both fields exist because the
requirement is to return imported, rejected and warning counts, and a caller
should not have to know the all-or-nothing rule to read the response. On a
rejection there is no `ImportResult` at all: the issues travel in the error
envelope as `details.errors`, using the same `FeatureIssue` shape.

`warnings` describes accepted-but-notable features (for example, a property
present on some features and absent on others, a property whose values are of
mixed type, or a polygon ring that had to be closed). Warnings never block an
import, and `warning_count > 0` is normal on a `201`.

### 3.3 Validation (`app/services/geojson_validation.py`)

Pure functions over parsed JSON. No database, no filesystem, no settings
lookups beyond values passed in as arguments — so the whole module is unit
testable without a running PostGIS.

Rules, each mapping to a stable `code`:

| Code | Condition |
| --- | --- |
| `empty_document` | Zero features after normalisation |
| `unsupported_root` | Root is not a `FeatureCollection`, `Feature`, array, or object with a records array |
| `missing_geometry` | Feature has no `geometry`, or `geometry` is `null` |
| `unsupported_geometry_type` | Not one of Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon |
| `malformed_coordinates` | `coordinates` is absent, not an array, or structurally wrong for the declared type |
| `coordinate_out_of_range` | Longitude outside [-180, 180] or latitude outside [-90, 90] |
| `coordinate_not_finite` | `NaN`, `Infinity`, or `-Infinity` in a coordinate position |
| `too_many_features` | Feature count exceeds `import_max_features` |
| `payload_too_large` | Request body exceeds `import_max_file_bytes` |
| `unsupported_property_value` | A property value is not JSON-serialisable |

Polygon rings whose first and last positions differ are **auto-closed and
warned about**, not rejected: the intent is unambiguous and the repair is
lossless. Every other rule in the table is an error.

Property names and values pass through untouched: no renaming, no case
folding, no coercion, no dropping of unknown keys. Nested objects and arrays
are preserved as JSONB.

### 3.4 Shared write path

`vector_import_service` currently interleaves "read a file" with "write a frame
and register a layer". The second half is extracted verbatim into:

```python
async def write_frame_and_register(
    session, project_id, frame, *, layer_name, table_name,
    source_filename: str | None,
) -> Layer
```

It keeps the existing failure domain exactly as documented today: `to_postgis`,
then `_create_indexes`, then `layer_service.create_layer` and the
`layer_repository.update` of `srid`/`geometry_type`/`extent`/`feature_count`,
all wrapped so that any exception drops the table.

`import_vector_file` is refactored to call it. Its observable behaviour does
not change — the existing Task 5/6 tests must pass untouched, which is the
guard against regression here.

### 3.5 Draft import (`app/services/draft_import_service.py`)

```
1. Re-validate the FeatureCollection with geojson_validation.
   Any error → InvalidRequestError with details={"errors": [FeatureIssue, ...]}.
   Nothing has been written at this point.
2. Build a GeoDataFrame from the validated features (shapely geometries +
   a properties DataFrame), set CRS 4326.
3. table_name = slugify_table_name(source_filename)
4. await anyio.to_thread.run_sync(...) → write_frame_and_register(...)
5. Return ImportResult.
```

Step 1 completes for **every** feature before step 2 begins. That is what makes
"roll back everything if any feature fails" true: a rejected import never
reaches a write. Should a write fail anyway (a database error mid-`to_postgis`),
the inherited drop-on-failure guard removes the freshly created table, and the
layer row is either never inserted or rolled back with the request-scoped
session. Because the table is always newly created and never pre-existing,
drop-on-failure is equivalent to a transactional rollback: no partial state can
survive either way.

Batch persistence: `to_postgis` issues one bulk insert. There is no
per-feature database round trip anywhere in this path.

### 3.6 Endpoint

```
POST /api/v1/projects/{project_id}/layers/import-draft
  body: ImportDraftRequest
  201  → ImportResult
  409  → conflict            (layer name already used in this project)
  413  → payload_too_large
  415  → unsupported_format
  422  → invalid_request     (details.errors = [FeatureIssue, ...])
```

Duplicate submissions: the existing `uq_layer_project_id` unique constraint on
`(project_id, name)` means a genuine double-submit produces a `409` rather than
two layers. The client additionally blocks the second click while the first
request is in flight (§4.6). No idempotency-key mechanism is introduced.

### 3.7 Database

One Alembic migration adding a single nullable column:

```sql
ALTER TABLE gis.layer ADD COLUMN source_filename VARCHAR(255);
```

`created_at` already records import time; `feature_count` already exists. Both
are populated by the existing write path. Imported feature data continues to
land in `gis_data` as tables created by `to_postgis`.

No new tables. No temporary or staging schema. No changes to `gis_data`
conventions.

---

## 4. Frontend

### 4.1 Files

**New** — `web/src/features/import/`

- `parseGeoJson.ts` — pure parse + normalise + column inference.
- `parseWorker.ts` — Web Worker wrapper around `parseGeoJson`.
- `useParseWorker.ts` — worker lifecycle, with a synchronous fallback.
- `validation.ts` — client mirror of the server rules.
- `useImportDraft.ts` — draft state, command stack, dirty flag.
- `ImportPreview.tsx` — the overlay workspace.
- `PreviewMap.tsx` — its own `OlMap` + draft vector source + selection sync.
- `DraftGrid.tsx` — ag-grid configuration.
- `JsonCellEditor.tsx` — controlled editor for nested objects/arrays.

**New** — `web/src/api/imports.ts` (`confirmImportDraft`, `getImportLimits`).

**Modified** — `features/layers/AddLayerDialog.tsx`, `api/types.ts`,
`index.css`, `package.json`.

### 4.2 ag-grid

`ag-grid-community` and `ag-grid-react`, latest stable, pinned at install.
Community only — no Enterprise modules, no license key, no feature that
requires one. Modules are registered explicitly
(`ModuleRegistry.registerModules([AllCommunityModule])`) and the grid is
themed through the Theming API against the four existing CSS variables, so it
does not import a competing design language.

The existing `features/attributes/AttributeTable.tsx` is **not** touched. It
keeps serving persisted layers; ag-grid serves the import draft only.

### 4.3 Parsing and normalisation (`parseGeoJson.ts`)

Pure, synchronous, no DOM, no network — directly unit testable.

Accepted roots, all normalised to a `FeatureCollection`:

1. `FeatureCollection` — used as-is.
2. `Feature` — wrapped in a single-feature collection.
3. Array of objects — each object becomes a feature (§4.4).
4. Object containing exactly one array-of-objects property (`features`,
   `records`, `data`, `items`, `rows`, or a sole array property) — that array
   is treated as case 3. If more than one candidate array exists and none is
   named, this is `unsupported_root`.

Column inference walks **all** features, not the first, and unions their
property keys. Column order is first-seen. A column's type is inferred from
its non-null values: `number`, `boolean`, `date` (ISO-8601 strings only),
`json` (any object or array), otherwise `text`. Mixed types fall back to
`text` and raise a warning; the underlying values are not coerced.

Nested objects and arrays are never flattened. They are typed `json` and
rendered as formatted JSON.

Null and missing are distinguished: a property absent from a feature is
`undefined` and renders as an empty cell; an explicit `null` renders as a
muted `null`. Neither is invented on the way out — serialisation writes back
exactly what was read for untouched cells.

### 4.4 Plain JSON records → Points

For roots 3 and 4, the parser looks for a coordinate pair among the inferred
columns, case-insensitively, in priority order:

- longitude: `lon`, `lng`, `long`, `longitude`, `x`
- latitude: `lat`, `latitude`, `y`

The detected pair is shown in the preview header with two dropdowns listing
every numeric column, so the user can override it. Each record becomes a
`Point` from that pair; the two source columns remain visible as ordinary
editable properties (they are the geometry's provenance, not a substitute for
it — nothing is silently dropped).

In records mode the geometry is *derived*, so it is recomputed whenever its
inputs change: on parse, when the dropdowns change, and when a coordinate
cell is edited. The preview map updates in step. This does not contradict
"geometry is read-only": the user is editing a property, and the geometry
follows. For roots 1 and 2 the geometry comes from the file and is never
editable by any path.

If no pair is detected and none is chosen, the validation summary reports
`missing_geometry` and **Confirm Import stays disabled**. Records without a
usable pair are never persisted geometryless — every layer this platform
creates has a geometry column and an SRID.

### 4.5 Draft state (`useImportDraft.ts`)

```ts
interface ImportDraft {
  fileName: string
  fileSize: number
  detectedFormat: 'featureCollection' | 'feature' | 'array' | 'records'
  columns: DraftColumn[]
  features: DraftFeature[]      // { id: local, geometry: readonly, properties }
  geometryTypes: string[]
  lonColumn: string | null      // records mode only
  latColumn: string | null
}
```

The draft lives in component state, never in `layerStore` and never in
TanStack Query — it is not server state and must not be cached as such.

Edits go through a command stack rather than mutating state directly:
`setCellValue`, `addColumn`, `renameColumn`, `deleteFeatures`,
`setGeometryColumns`. Each command records enough to invert itself, giving
undo/redo over unsaved edits. `isDirty` is `stack.length > 0`, shown as a dot
in the toolbar.

The original `File` object is held alongside the draft and released only on
confirm or cancel, so the uploaded file survives the whole preview session.

### 4.6 Preview workspace (`ImportPreview.tsx`)

A full-screen overlay above the shell, styled from the existing `.dialog`
rules and the four theme variables. Layout:

- **Header** — file name, formatted size, detected format, feature count,
  geometry types, lon/lat selectors in records mode, close button. When the
  feature count exceeds `previewMaxFeatures`, it states that the map is
  showing a subset and how many.
- **Map** — `PreviewMap`, its own `OlMap` instance built the way
  `MapProvider` builds the main one, fitted to the draft's extent.
- **Validation summary** — error and warning counts, then a list of issues,
  each clicking through to its row.
- **Grid toolbar** — search, add column, rename column, delete selected,
  undo, redo, dirty indicator.
- **Grid** — `DraftGrid`.
- **Actions** — Cancel, Confirm Import.

Selection is synchronised in both directions through a single
`selectedFeatureIds` state owned by `ImportPreview`: clicking a map feature
selects its grid row and scrolls it into view; selecting a grid row highlights
the map feature and zooms to it. One owner, two subscribers — no echo loop,
because each side only writes on user interaction and only reads on change.

**Confirm** is disabled when a request is in flight (`mutation.isPending`),
when the draft has validation errors, and when records mode has no coordinate
pair. On success it invalidates `['project', projectId]`, shows the imported /
rejected / warning counts, and closes.

**Cancel** and closing with unsaved edits both go through a confirmation
prompt. Replacing the file while the draft is dirty prompts the same way.
Cancelling sends nothing to the server, so no database record can exist.

**Failure containment**: `ImportPreview` renders inside an error boundary. A
parse failure, a malformed feature that breaks rendering, or a worker crash
shows an error state inside the overlay; it never propagates to the shell and
never leaves the app blank.

### 4.7 Grid behaviour (`DraftGrid.tsx`)

ag-grid supplies row virtualisation, sorting, filtering and column resizing.
The remaining behaviour is defined here so it is not left to interpretation:

- **Cell editors** by inferred column type: text, number, boolean (checkbox),
  date (ISO-8601), and `JsonCellEditor` for `json` columns. A `json` cell
  shows compact JSON in the grid and opens a formatted, controlled editor;
  invalid JSON blocks the commit with a cell error and the previous value
  stands.
- **Type-aware validation** runs per cell on commit, using the same rules as
  `validation.ts`. A failing cell is marked in place and listed in the
  validation summary. Errors do not revert the value — the user keeps their
  text and fixes it — but any outstanding cell error disables Confirm.
- **Null handling**: clearing a cell sets `null`, not `""`. A property absent
  from a feature stays absent unless the user types into it.
- **Search** filters rows by case-insensitive substring across every rendered
  cell value, including formatted JSON.
- **Row selection** is checkbox-based, multi-select, and is the same
  `selectedFeatureIds` state the map reads.
- **Delete selected** asks for confirmation, naming the count, then removes
  the features as one undoable command.
- **Add column** appends a column of type `text` whose value is absent on
  every existing feature until edited. The name must be non-empty and unique.
- **Rename column** rejects an empty name or a collision with an existing
  column, with an inline message; the rename is otherwise one undoable
  command that preserves values and column position.

### 4.8 Web Worker

Parsing runs in a module worker
(`new Worker(new URL('./parseWorker.ts', import.meta.url), { type: 'module' })`),
which Vite bundles natively. The main thread stays responsive on large files.

If the worker fails to construct — an environment without worker support, or a
CSP that blocks it — `useParseWorker` falls back to parsing on the main thread.
Behaviour is identical, only responsiveness differs. `parseGeoJson.ts` is
imported directly by tests, so worker plumbing is never in the way of testing
parse logic.

### 4.9 Entry point

In `AddLayerDialog`, a file whose extension is in `allowedExtensions`
(`.json`, `.geojson`) opens `ImportPreview` instead of calling
`mutations.importFile`. Every other extension keeps the existing immediate
path unchanged — `.gpkg`, `.zip`, `.shp` and rasters have no preview
implementation and are out of scope.

---

## 5. Test strategy

Both suites must be green, and the module's existing quality gate applies to
every step:

```
backend   ruff check . && ruff format --check . && mypy app && pytest
frontend  npm run lint && npm run typecheck && npm run test -- --run
```

Backend `pytest` runs against `gis_platform_test` with `GIS_DATABASE_URL`
exported, per the module's global constraints.

### Backend

`tests/services/test_geojson_validation.py` — no database:

- Valid `FeatureCollection` for all six geometry types.
- Single `Feature` normalises to a one-feature collection.
- Generic JSON array and record-array normalise to Points.
- Unsupported root structure.
- Missing and null geometry.
- Unsupported geometry type (e.g. `GeometryCollection`).
- Coordinates out of range; `NaN` / `Infinity`.
- Malformed coordinate nesting per geometry type.
- Empty document.
- Unclosed polygon ring auto-closes and warns.
- Mixed attribute types produce a warning, not an error, and are not coerced.
- Nested objects and arrays survive validation byte-identical.

`tests/api/test_import_draft.py` — against PostGIS:

- Valid import returns `201`, `importedCount == len(features)`, and creates
  both the `gis_data` table and the `gis.layer` row.
- `sourceFilename`, `createdAt` and `featureCount` are recorded.
- Nested properties round-trip through JSONB unchanged.
- Property names are preserved exactly, including case and unknown keys.
- One invalid feature among many valid ones → `422`, and **no** table and
  **no** layer row exist afterwards (rollback).
- A write failure injected after `to_postgis` leaves no table (drop-on-failure).
- Feature count above `import_max_features` → `422`, nothing written.
- Body above `import_max_file_bytes` → `413`.
- Duplicate confirmation with the same layer name → first `201`, second `409`,
  and exactly one layer exists.
- Existing `import_vector_file` tests continue to pass unmodified, proving the
  §3.4 extraction changed no behaviour.

### Frontend

`vitest` + Testing Library:

- `parseGeoJson.test.ts` — all four roots; column union across features where
  later features introduce new keys; first-seen column order; type inference
  including mixed-type fallback; nested objects/arrays preserved;
  `null` vs missing distinguished; lat/lon auto-detection and its absence.
- `validation.test.ts` — mirrors the server rule table, same codes.
- `useImportDraft.test.ts` — cell edit, add column, rename column, delete
  features; undo and redo restore prior state exactly; `isDirty` transitions;
  cancel discards without a request.
- `ImportPreview.test.tsx` — selecting a map feature highlights the grid row;
  selecting a grid row highlights and zooms the map feature; Confirm disabled
  while pending, on validation errors, and in records mode without a
  coordinate pair; a parse error renders an error state rather than crashing;
  unsaved edits prompt before close and before file replacement.
- `DraftGrid.test.tsx` — a `json` cell rejects invalid JSON and keeps the
  prior value; clearing a cell yields `null`, not `""`; search matches across
  all columns; delete-selected prompts before removing; add-column and
  rename-column reject empty and colliding names.
- `imports.test.ts` — `ApiError` from a `422` surfaces field-level and
  feature-level issues from `details.errors`.

---

## 6. Follow-up (not in this spec)

The user has asked for a repository reorganisation after this work lands:
delete `api-learning-lab/`, `frontend/` and `backend/` from the repository root
and promote `gis-platform/` to the root. That is destructive and independent of
this feature; it gets its own confirmation and its own change.
