# GIS Platform — Performance & Feature-Completeness Modification Plan

**Date:** 2026-08-01 · **Scope:** modification plan only, no implementation.
**Ground rule:** every finding below cites the current implementation
(`backend/`, `web/` at commit `0ead4a9`). Nothing proposes a rewrite; the
architecture (FastAPI + PostGIS + rio-tiler backend, React + OpenLayers
frontend, layered routes→services→repositories) supports every change
incrementally.

---

## 1. Current bottlenecks (verified in code)

### 1.1 Vector loading — the dominant bottleneck

- **Every PostGIS layer loads as bbox GeoJSON regardless of size.**
  `web/src/map/layerFactory.ts:38-48` builds a `VectorSource` with
  `bboxStrategy` + `createBboxLoader` for `source.type === 'postgis'` —
  unconditionally. The server-side MVT endpoint
  (`backend/app/api/v1/routes/tiles.py:26`, `tile_repository.render_mvt`)
  is **only** reachable for `source.type === 'mvt'` (externally registered
  tile URLs, `layerFactory.ts:50`). App-imported layers can never use it.
- Feature responses are capped at `feature_bbox_limit: 2000`
  (`backend/app/core/config.py`); beyond that the map silently shows a
  sample plus a truncation warning (`featureLoader.ts:36`,
  `LayerPanel.tsx:115-119`). A 100K-feature layer is not viewable today.
- Each viewport change re-serializes full-precision GeoJSON in PostGIS
  (`ST_AsGeoJSON(ST_Transform(...))`, `feature_repository.py:57`) — no
  zoom-dependent simplification, no coordinate precision limit.
- The loader re-serializes the whole response a second time just to weigh
  it: `JSON.stringify(collection).length` (`featureLoader.ts:35`).
- No request cancellation anywhere: `apiFetch` (`web/src/api/client.ts:33`)
  accepts no `AbortSignal`; a fast pan queues stale bbox requests that all
  complete and parse.

### 1.2 Per-tile and per-page catalog overhead

- `tile_service.get_vector_tile` (`tile_service.py:33-42`) runs, per tile:
  `get_layer_or_404` (1 query) → `catalog_service.verify_source`
  (information_schema) → `feature_repository.attribute_columns`
  (information_schema, `feature_repository.py:42-44`) → then the MVT query.
  ≈3 catalog queries × 20–60 tiles per viewport before any tile bytes.
- Attribute pages run `SELECT count(*)` per page load
  (`feature_repository.py:145-149`) — a full scan on large filtered tables.
- Every single-feature edit re-queries `information_schema` for the id
  column type (`_id_column_type`, `feature_repository.py:178-180`).

### 1.3 Caching

- Tiles ship `Cache-Control: public, max-age=60` + weak ETag derived from
  `layer.updated_at` (`tiles.py:14`, `tile_service.py:27-30`). Correct but
  shallow: after 60s, or for any new client, every tile re-renders in
  PostGIS / rio-tiler. There is **no server-side tile cache** (no in-process
  LRU, no shared store), and no cache differentiation between immutable
  imported tables and editable registered tables.

### 1.4 Rendering

- All vector rendering is OL's Canvas renderer; no WebGL path. Styles are
  resolved **per feature per frame** through `compileStyle`/`resolveColor`
  (`web/src/map/styleCompiler.ts:27-40`) — fine at 2K features, measurable
  at 50K, prohibitive at 500K.
- No clustering, no declutter tuning, no `renderBuffer`/`updateWhileInteracting`
  configuration on `VectorLayer` (`layerFactory.ts:46`).

### 1.5 Layer management & memory

- `LayerMemoryManager` (`web/src/map/memory/LayerMemoryManager.ts`) is a
  sound LRU design, but it weighs vector layers by **JSON text length**
  (`featureLoader.ts:35`), which underestimates parsed OL feature memory by
  roughly 3–5×; and eviction is whole-layer (`onEvict` → `source.clear`),
  so one over-budget layer thrashes between empty and full.
- Enforcement runs on a fixed 2s interval (`useLayerMemory.ts:5,19-22`)
  regardless of activity.

### 1.6 Attribute table

- Plain `<table>` with `PAGE_SIZE = 50` (`useAttributes.ts:7`) — adequate
  at 50 rows, but sorting always round-trips a `count(*)`; the server-side
  filter machinery (`AttributeFilter`, `build_where`,
  `feature_repository.py:85-118`) is fully implemented and **has no UI** —
  `setFilters` is returned by the hook and never called by any component.

### 1.7 Spatial queries

- Viewport reads use `&&` with the envelope transformed into the table's
  SRID (`feature_repository.py:60-62`) — index-correct. But **registered**
  PostGIS tables (`/layers/from-postgis`) are never checked for a GIST
  index; a table without one turns every bbox/tile/identify query into a
  sequential scan, silently. Imported tables do get GIST + PK
  (`vector_import_service._create_indexes`). Attribute sort/filter columns
  have no supporting btree indexes anywhere.

### 1.8 Large-file processing

- Vector import runs inside the HTTP request: GDAL read of the whole file
  into a GeoDataFrame (`_read_frame`, `vector_import_service.py:311`), then
  `to_postgis` — request-scoped even though off-thread. A multi-hundred-MB
  upload risks proxy/request timeouts and gives no progress. The staged
  JSON flow posts the entire FeatureCollection in one request body (capped
  at 64 MB / 50K features, `config.py`).
- Raster import already converts to COG (`rio_cogeo.cog_translate`,
  `raster_import_service.py:114`) and serves via a bounded dataset pool
  (`dataset_pool.py`) — this path is architecturally right; only its
  synchronous, in-request execution and single-handle-per-file concurrency
  are limits.

### 1.9 Misc

- The UI always opens `projects[0]` (`App.tsx:33`) — multi-project exists
  in the API only.
- `docker-compose.yml` runs PostGIS with stock configuration (no
  `shared_buffers`/`work_mem` tuning) and contains no cache/queue service.

---

## 2. Modules that must change (and only these)

| Area | Files/modules to modify |
|---|---|
| Backend config | `app/core/config.py` (thresholds, cache sizes, job settings) |
| Tile fast-path & cache | `app/services/tile_service.py`, new `app/services/source_snapshot.py` (in-process TTL cache), `app/api/v1/routes/tiles.py` (headers) |
| Spatial filtering & simplification | `app/repositories/feature_repository.py` (simplify + precision params), `app/api/v1/routes/features.py` (query params) |
| Counts | `app/repositories/feature_repository.py` (+ estimated count via `pg_class.reltuples`), `app/services/attribute_service.py` |
| Index audit | `app/services/catalog_service.py` (+ index introspection), `app/api/v1/routes/catalog.py` (surface it) |
| Async imports | new `app/models/job.py`, `migrations/versions/0003_import_jobs.py`, new `app/services/job_service.py`, `app/api/v1/routes/imports.py` (+ job endpoints), `app/services/vector_import_service.py` / `raster_import_service.py` (enqueue path) |
| Geometry validation | `app/services/draft_import_service.py` + `geojson_validation.py` (opt-in `ST_MakeValid` repair pass) |
| PMTiles export | new `app/services/pmtiles_service.py`, `app/api/v1/routes/exports.py`; infra: tippecanoe (container) |
| Frontend loading | `web/src/api/client.ts` (AbortSignal), `web/src/api/features.ts`, `web/src/map/featureLoader.ts`, `web/src/map/layerFactory.ts` (adaptive branch), `web/src/map/syncLayers.ts` (fingerprint incl. strategy) |
| Rendering | `web/src/map/styleCompiler.ts` (flat-style variant), `layerFactory.ts` (WebGL/cluster branches) |
| Memory | `web/src/map/memory/LayerMemoryManager.ts` (+ real-size estimator), `featureLoader.ts` |
| Attribute table | `web/src/features/attributes/AttributeTable.tsx` (+ filter UI, virtualization), `useAttributes.ts` |
| New GIS features | new files under `web/src/features/` (measure, legend, basemap, analysis) — additive |
| Deployment | `docker-compose.yml` (PostGIS tuning; optional tippecanoe job image) |

Everything else — schemas wire format, editing path, identify, import
preview, memory panel, project/layer CRUD — stays untouched.

---

## 3. Adaptive data-loading strategy

Decision input: `layer.feature_count` (already persisted on every imported
layer and computed for registered ones) + `layer.kind`. Decision point:
`layerFactory.createOlLayer` — the one place all sources are constructed.

| Tier | Condition | Strategy |
|---|---|---|
| Small | `featureCount ≤ 2 000` | One full GeoJSON fetch (`strategy: all`), no bbox churn; keep Canvas rendering; client-side sort/filter allowed |
| Medium | `2 000 < featureCount ≤ 50 000` | Current bbox loader, plus: `AbortSignal` cancellation, `simplify` + `precision` query params answered by `ST_SimplifyPreserveTopology`/`ST_ReducePrecision` chosen from zoom, and raised limit with paged continuation |
| Large | `featureCount > 50 000` | Switch the OL layer to `VectorTileSource` pointed at the **existing** `/tiles/{z}/{x}/{y}.mvt` endpoint; identify keeps working (fid rides as an MVT attribute, `tile_repository.py:76`) |
| Static large | Imported (immutable) tables above the large threshold, on demand | One-time PMTiles export job (tippecanoe); layer gains an alternate `pmtiles` source consumed via `ol-pmtiles`; server just serves the static file with long-lived immutable cache headers |
| Raster | unchanged | COG + windowed reads via the dataset pool (already correct); add per-layer tile LRU and `immutable` cache headers since COGs never mutate |

Thresholds live in `config.py` and are surfaced through the existing
`/system` route family so the client doesn't hard-code them.

---

## 4. Backend changes (specified)

1. **Source snapshot cache** — new module caching, per `layer_id`, the
   verified source + attribute-column list, keyed by `layer.updated_at`
   (which already busts on edits — the ETag uses the same signal,
   `tile_service.py:29`). Eliminates the 3-catalog-query preamble in
   `get_vector_tile` and `attribute_service`. TTL + explicit invalidation on
   layer PATCH/import. In-process only; no new infra.
2. **Server tile LRU** — bounded in-memory `(layer_id, updated_at, z, x, y)
   → bytes` cache in `tile_service` (size from config, e.g. 64 MB). Raises
   warm-tile hit rate to memory speed without Redis; the key design makes
   staleness impossible. Redis is an explicit non-goal until multi-process
   deployment exists.
3. **MVT hardening** — keep `render_mvt` as-is (it is correct and
   index-aware); add optional attribute allowlist (only columns the style
   and identify need) to shrink tiles; skip-empty fast path already exists
   via 204.
4. **Simplification & precision** on `/features`: `simplify=<tolerance>`
   and `precision=<decimals>` params flowing into `read_in_bbox`'s SELECT —
   `ST_SimplifyPreserveTopology(t.geom, :tol)` before transform, keeping
   the `&&` predicate untouched so the GIST index still answers it.
5. **Estimated counts** — `read_attribute_page` gains a fast path: when no
   filters are active, use `pg_class.reltuples` (post-`ANALYZE` estimate)
   and label the value estimated; exact `count(*)` only when filtered or on
   explicit request. Import already ANALYZE-equivalents via index build;
   add `ANALYZE` after import to keep estimates honest.
6. **Index audit for registered tables** — `catalog_service.verify_source`
   (or a sibling) checks `pg_indexes` for a GIST on the geometry column and
   a btree/PK on the id column; result surfaced on the catalog listing and
   as a warning on layer creation. Optional `POST .../indexes` to create
   them (explicitly user-triggered; never silently DDL someone's table).
7. **Async import tasks** — `gis.job` table (id, kind, status, progress,
   error, payload, created/updated) via migration 0003; imports above a
   size threshold enqueue and return `202 {jobId}`; an in-process
   `asyncio.Task` worker executes the existing import functions unchanged
   (they are already thread-dispatched); `GET /jobs/{id}` for progress; the
   small-file path stays synchronous so current UX and tests keep working.
8. **Metadata extraction & geometry validation** — import already records
   extent/count/SRID/geometry_type; add per-import invalid-geometry counts
   and an opt-in `repair=true` (`ST_MakeValid`) pass in the draft-import
   service, reported in the existing `ImportResult.warnings` envelope.
9. **Cache control** — raster + PMTiles: `Cache-Control: public, max-age=
   86400, immutable` (their sources never mutate without a new file);
   vector tiles keep ETag but raise max-age for imported (non-editable)
   tables; editable registered tables keep 60s.

---

## 5. Frontend changes (specified)

1. **Cancellation** — `apiFetch` accepts `AbortSignal`; `createBboxLoader`
   keeps one in-flight controller per layer, aborting the previous fetch on
   a new extent (OL's loader contract already passes failure callbacks,
   `featureLoader.ts:42-45`).
2. **Viewport loading** — small tier drops the bbox strategy entirely (one
   fetch); medium tier debounces `moveend` and passes zoom-derived
   `simplify`/`precision`; large tier is tiles (no bbox loader at all).
3. **LOD** — zoom thresholds per tier: below a layer's `minZoomForDetail`,
   medium-tier layers request aggressive simplification; large-tier MVT
   already has per-zoom generalization from `ST_AsMVTGeom`.
4. **Clustering** — opt-in `Cluster` source wrapper for point layers in the
   small/medium tiers (style-aware count badges via the existing
   `styleCompiler` fallback color); persisted as a per-layer flag in
   `layer.style` (JSONB — no migration).
5. **Web Workers** — reuse the proven `parseWorker` transport pattern from
   the import feature (`web/src/features/import/parseWorker.ts`) for
   parsing medium-tier GeoJSON responses off the main thread; byte size
   comes from the worker (replacing the `JSON.stringify` re-serialization).
6. **Virtualized table** — keep the plain table at `pageSize ≤ 100`;
   above that, mount the already-installed ag-grid Community
   (`DraftGrid` proves the integration) in read-only mode for attribute
   browsing. No new dependency.
7. **GPU rendering** — `WebGLVectorLayer` branch in `layerFactory` for
   point layers above a feature threshold; requires a flat-style variant in
   `styleCompiler` (single + graduated map cleanly; categorized needs a
   match expression). Canvas remains the default and the fallback.
8. **Layer visibility optimization** — verify (and enforce) that hidden
   layers never fetch: gate the bbox loader on `layer.visible` and skip
   tile prefetch for hidden tile layers in `layerFactory`; memory manager
   `touch()` only on visible layers.
9. **Memory accounting** — replace text-length weighing with a
   per-geometry estimator (vertex count × 16 bytes + attribute estimate)
   computed in the parse worker; enforcement stays LRU whole-layer (partial
   eviction is not worth the complexity yet).

---

## 6. GIS capability roadmap (ordered)

1. **Attribute filter UI + map linkage** — server (`build_where`) and hook
   (`setFilters`) already exist; add filter chips to the attribute drawer
   and push the same filter into the map path (`/features` and MVT gain a
   `filters` param routed through the identical `build_where`). Highest
   value-to-effort in the codebase.
2. **Measurement** — distance/area draw tools on the map toolbar
   (client-only, `ol/interaction/Draw` + `ol/sphere`, geodesic).
3. **Rectangle/lasso selection** — `DragBox` → select features → existing
   store `selectFeatures` (the identify/table sync built this session
   already carries multi-select arrays).
4. **Legend panel** — render swatches straight from `layer.style`
   (single/categorized/graduated all carry their classes; `ramps.ts` has
   the color math).
5. **Basemap switcher + scale bar** — additional XYZ presets; scale bar in
   the status strip (`ol/control/ScaleLine` restyled).
6. **Basic spatial analysis** — buffer & intersect endpoints executing in
   PostGIS (`ST_Buffer`, `ST_Intersection`) writing results as new
   imported-style tables through the existing `write_frame_and_register`
   path — reusing import's transactional guarantees. Strictly bounded
   (feature-count cap) to avoid runaway geometry work.
7. **Raster controls** — band picker + hillshade (`rio-tiler` supports
   both) extending `RasterStyle`; UI extends the existing raster
   StyleEditor branch.
8. **Time-series** — last (needs a temporal column convention): detect
   date/timestamp columns from the catalog, add a time-slider control that
   drives the standard filter param from (1). No schema changes.

---

## 7. Preservation guarantees

- All current endpoints, wire schemas (camelCase envelope, error format),
  uploaded data, and the `gis`/`gis_data` schemas stay as-is; every new
  server capability is a **new optional query param or new endpoint**.
- The adaptive strategy is a client-side decision over existing data
  (`featureCount`); `layer.source` JSONB is not migrated. Small layers
  behave exactly as today.
- The synchronous import path remains for small files, keeping the current
  UX and all 278 backend / 241 frontend tests green; async is additive.
- Editing stays on the GeoJSON feature path (MVT layers above the large
  threshold are read-optimized; selecting a feature for editing fetches it
  individually via the existing `read_one`).

## 8. Risks, migrations, dependencies

| Risk | Mitigation |
|---|---|
| MVT switch changes identify/selection semantics (attributes come from tile payload, may be simplified/clipped) | fid always present (`tile_repository.py:76`); identify falls back to `read_one` fetch for full attributes |
| WebGL flat styles can't express every categorized style | Canvas fallback per layer; capability check in `styleCompiler` |
| Estimated counts confuse users | label "≈"; exact count on demand |
| Registered-table DDL (index creation) touches user-owned tables | never automatic; explicit user action with SQL preview |
| Async jobs add state | single new table + in-process worker; no broker; jobs are resumable-by-rerun, imports already transactional (drop-on-failure) |
| tippecanoe is a native dependency | run as a container job (compose service, profile-gated); PMTiles phase is severable if infra is unwanted |
| Tile LRU in a multi-worker deployment would fragment | documented single-process assumption; keyed by `updated_at` so never stale, only cold |
| Simplification changes rendered geometry | only applied above configured zoom-out thresholds; tolerance 0 at high zoom |
| Migrations | 0003 jobs table only (additive); rollback = drop table |
| Performance regression risk | benchmarks in Phase 0 run in CI against seeded datasets before/after each phase |

## 9. Acceptance criteria

Measured with: seeded synthetic layers (10K/100K/1M points + 100K-polygon
layer, generated once by a bench script), Playwright-driven pan/zoom script
counting `postrender` frames over 5s, `performance.memory` +
MemoryPanel readouts, and a k6/`httpx` micro-bench for endpoints (p95 over
200 warm requests, dev hardware).

| Scenario | Criterion |
|---|---|
| 10K points (small/medium tier) | first layer paint ≤ 1.5s after project load; pan ≥ 50 FPS; layer memory ≤ 80 MB; `/features` p95 ≤ 300 ms |
| 100K features (large tier, MVT) | first tiles ≤ 2.5s; interaction ≥ 45 FPS; tile p95 ≤ 250 ms warm / ≤ 800 ms cold; **zero truncation warnings** |
| 1M features (MVT ± PMTiles) | usable pan/zoom ≥ 30 FPS; tile p95 ≤ 400 ms; warm-cache hit ratio ≥ 70% on revisit; attribute page ≤ 500 ms (estimated count); tab memory ≤ 200 MB |
| Large raster (multi-GB COG) | tile p95 ≤ 300 ms warm pool; first tile after cold open ≤ 1.2 s |
| Import 100 MB vector file | accepted ≤ 2 s (202 + jobId); progress visible; UI interactive throughout; no request exceeds 30 s |
| Regression gate | all existing tests green; small-layer behavior byte-identical on the wire |

## 10. Phases

**Phase 0 — Measurement baseline** (prereq for everything)
- Objective: make every later claim falsifiable.
- Affected: new `backend/scripts/bench_seed.py`, `web/scripts/bench_map.ts` (Playwright), CI hook.
- Changes: dataset seeding (10K/100K/1M), FPS/latency/memory harness, recorded baseline numbers.
- Dependencies: none. Risks: none. Validation: baseline report committed.

**Phase 1 — Backend fast-path & caching**
- Objective: cut per-tile/per-page overhead without touching the wire format.
- Affected: `tile_service.py`, new `source_snapshot.py`, `attribute_service.py`, `feature_repository.py`, `config.py`, `catalog_service.py` (index audit), `docker-compose.yml` (PostGIS `shared_buffers`/`work_mem`).
- Changes: snapshot cache; tile LRU; estimated counts; `_id_column_type` memoization; ANALYZE after import; index audit surfaced read-only.
- Dependencies: Phase 0. Risks: cache invalidation (keyed by `updated_at` — same signal the ETag already trusts).
- Validation: tile p95 before/after on 100K seed; catalog query count per tile == 0 (SQL echo assert in a test).

**Phase 2 — Adaptive loading + cancellation (the user-visible unlock)**
- Objective: 100K–1M layers become viewable; pans stop wasting work.
- Affected: `layerFactory.ts`, `featureLoader.ts`, `client.ts`, `features.ts`, `syncLayers.ts`, `feature_repository.py` (simplify/precision), `features.py` route.
- Changes: three-tier branch on `featureCount`; MVT source for large; AbortSignal; simplification params; small-tier single fetch.
- Dependencies: Phase 1 (tiles must be cheap first). Risks: identify semantics on MVT (mitigated via `read_one` fallback); style parity on vector-tile layers (same `compileStyle` applies — `layerFactory.ts:59-62` already styles MVT).
- Validation: acceptance rows 1–3 (except FPS ≥45 at 100K which may need Phase 4); truncation warning count == 0 on seeds.

**Phase 3 — Async import pipeline**
- Objective: large files import without request-lifetime coupling; progress visible.
- Affected: migration 0003, `models/job.py`, `job_service.py`, `imports.py` route, `vector_import_service.py`, `raster_import_service.py`, frontend `AddLayerDialog`/import status UI.
- Changes: jobs table + in-process worker + 202 path above threshold; progress endpoint; geometry `repair` option in draft imports.
- Dependencies: none on P1/P2 (parallelizable). Risks: worker lifetime on reload (jobs marked stale on startup); double-submit (idempotency key = upload hash).
- Validation: acceptance row 5; kill-server-mid-import leaves no orphan table (extends the existing drop-on-failure tests).

**Phase 4 — Rendering & memory**
- Objective: FPS targets at 100K+; honest memory accounting.
- Affected: `styleCompiler.ts` (flat styles), `layerFactory.ts` (WebGL + cluster branches), `parseWorker` reuse for feature parsing, `LayerMemoryManager.ts` estimator, `AttributeTable` virtualization threshold.
- Changes: WebGL point path; clustering opt-in; worker parse; vertex-based memory estimate; hidden-layer load gating.
- Dependencies: Phase 2 (tiering determines which layers hit WebGL). Risks: WebGL style coverage (Canvas fallback); StrictMode double-mount of workers (pattern already solved in `useParseWorker`).
- Validation: FPS harness ≥45 at 100K, ≥30 at 1M; memory panel vs `performance.memory` divergence < 30%.

**Phase 5 — GIS capabilities (order fixed in §6)**
- Objective: close the completeness gaps behind stable foundations.
- Affected: additive feature modules + small route additions (`filters` on features/MVT, buffer/intersect endpoints, raster style fields).
- Dependencies: filter UI ← Phase 1 snapshot; analysis ← import write path (exists); time-series ← filter param.
- Risks: analysis runaway (bounded counts + statement timeout); each feature ships behind its own small test set.
- Validation: per-feature acceptance (filter round-trip test, measured length vs known geodesic, buffer result row counts, legend swatch parity with map rendering).

**Phase 6 (optional, severable) — PMTiles static path**
- Objective: near-zero-cost serving for immutable mega-layers.
- Affected: `pmtiles_service.py`, `exports.py`, compose (tippecanoe job container), `layerFactory.ts` (`pmtiles` source via `ol-pmtiles`).
- Dependencies: Phase 3 (runs as a job). Risks: native tooling on Windows dev (container-only); duplicate storage (retention policy).
- Validation: 1M-layer served from PMTiles with tile p95 ≤ 100 ms and zero PostGIS load during pan.

---

*Stop point: this document is the deliverable. No implementation has been
started.*
