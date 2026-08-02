# Four-Session GIS Platform Improvement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Each session is executed in a fresh context** using only the repository state, this plan, and `docs/superpowers/HANDOFF.md`.

**Goal:** Make large-dataset loading measurably fast with a multi-level client cache, complete the project lifecycle with real data, ship a polished Hangzhou demo, and validate + document everything reproducibly.

**Architecture:** The platform is FastAPI + PostGIS (schema `gis` for metadata, `gis_data` for feature tables) serving GeoJSON, MVT vector tiles, and COG raster tiles, with a React 19 + OpenLayers 10 frontend that already selects loading strategy by feature count (≤2 000 full GeoJSON / ≤50 000 bbox GeoJSON / >50 000 MVT). This plan adds a client-side cache hierarchy (memory LRU → IndexedDB → conditional HTTP), completes project CRUD with safe cascading cleanup, and builds a real-data pipeline culminating in a Hangzhou study-area demo.

**Tech Stack:** Backend: Python 3.12, FastAPI, SQLAlchemy 2 async, PostGIS 3.4, geopandas/pyogrio, rio-tiler. Frontend: React 19, OpenLayers 10.9, TanStack Query 5, zustand, Vite 8, Vitest 4. New dev-deps this plan introduces: `playwright` + `@playwright/test` (web, benches + e2e), `fake-indexeddb` (web, tests), `osm2geojson` (backend dev extra, Session 3 script only).

## Global Constraints

Copied from the repo's binding conventions (original plan `2026-07-26-web-gis-platform.md`, README):

- Ports: backend **1316**, web dev **1317** (proxies `/api`), PostGIS **5401**, pgAdmin 5051. DB `gis_platform`, test DB `gis_platform_test`.
- API prefix `/api/v1`; wire format camelCase via `APIModel`; errors always `{"error": {"code", "message", "details"}}`.
- Schemas: `gis` = metadata only (3 tables: project, layer, task), `gis_data` = imported feature tables. Storage SRID for imports is always 4326; tiles are EPSG:3857.
- All dynamic SQL over user-named tables goes through `validate_identifier()` / `quote()` (`backend/app/db/identifiers.py`). Never interpolate unvalidated names.
- One request = one transaction: services never call `commit()`; `get_session` commits at the request boundary. (Session 2 documents its one deliberate exception for project deletion.)
- Backend tests run ONLY against `gis_platform_test` (`conftest.py` enforces the URL suffix). Command: `cd backend && $env:GIS_DATABASE_URL='postgresql+asyncpg://gis:gis@localhost:5401/gis_platform_test'; pytest`.
- Quality gates before any commit: backend `ruff check . && ruff format --check . && mypy app && pytest`; web `npm run lint && npm run typecheck && npm run test -- --run`.
- Windows dev machine: no native tippecanoe/osmium; anything needing them is out of scope or container-only.
- Never commit large raw data files; `backend/var/` is gitignored and is where downloads/artifacts live. Committed data files must be tiny test fixtures (< 100 KB each).
- Existing wire shapes, endpoints, and the 278-backend/312-web test suites must stay green. New server capabilities are new optional params or new endpoints.
- Do not modify `web/src/features/import/parseWorker.ts` contract or `AttributeTable.tsx` semantics; reuse patterns instead.

---

## Session protocol (applies to every session)

1. **Start:** read `docs/superpowers/HANDOFF.md` + this plan's section for the session. Verify environment: `docker compose up -d postgres`, backend venv active (`backend/.venv`), `alembic upgrade head`, backend on 1316, `npm install` current in `web/`.
2. **During:** TDD per task — write the failing test, watch it fail, implement, watch it pass, commit. Keep commits scoped to one task.
3. **End:** run both quality gates (or the affected side's gate if the other side is untouched — state which in the handoff), run the session's benchmark/verification steps, commit, then rewrite `docs/superpowers/HANDOFF.md` (it is a living document, not a log): completed work, key decisions, benchmark numbers, remaining risks, and the exact next-session task. Nothing else carries across sessions.
4. Never mix tasks from two sessions in one commit.

---

## Current state (verified 2026-08-02, commit 55f7322)

- **Server already has:** MVT tiles (`ST_AsMVT`, ETag + `max-age=60`, 204-empty, in-process 64 MB LRU keyed `(layer_id, updated_at, z, x, y)` — `tile_service.py`), source-snapshot cache, `/features?bbox&limit&simplify&precision` (cap 2 000, envelope-transform bbox strategy), reltuples count estimates, task system (DB queue + asyncio worker, 11 handlers), async import endpoint `POST /projects/{id}/tasks/import` (202 + task, **no UI caller**), COG raster tiles via pooled readers.
- **Client already has:** three-tier adaptive loading (`loadingTiers.ts`: small ≤2 000 full fetch / medium ≤50 000 bbox + zoom-scaled `simplify` + AbortController / large MVT), `LayerMemoryManager` 128 MiB LRU over OL sources, TanStack Query (staleTime 30 s), task pages with adaptive polling.
- **Client does NOT have:** any persistent cache (no IndexedDB/service worker), request deduplication, prefetch, stale-while-revalidate, worker parsing for feature responses (worker exists only for import), byte-accurate memory accounting (uses `JSON.stringify().length` re-serialization — `featureLoader.ts:65,94`), project create/rename/delete UI (`createProject`/`updateProject` in `api/layers.ts` have zero call sites), a frontend benchmark harness, or any e2e suite.
- **Known defects to fix in Session 2:** `DELETE /projects/{id}` orphans every `gis_data` table, the thumbnail PNG, export files, and task tmp uploads, and cascades away task history; `DELETE /layers/{id}` orphans its table; ~20 orphaned `var/data/tmp/tasks/*` dirs already exist.
- **Bench harness:** `backend/scripts/bench.py seed|measure|clean` (10K/100K/1M point layers in a "Benchmarks" project; p50/p95 for tiles cold/warm, features, attributes). No web-side harness.
- **Repo hygiene debt:** README still says `gis-platform/backend` (dead paths), root `.gitignore:16` ignores a dead path, empty `frontend/` dir, ~30 untracked screenshots at root, untracked `.playwright-mcp/`.
- `LayerRead` wire objects: check whether `updatedAt` is exposed (`backend/app/schemas/layer.py`, `web/src/api/types.ts`). The ORM column exists; if the schema omits it, Session 1 Task 1.6 adds `updated_at: datetime` to `LayerRead` — it is the client cache's version signal.

### Decision log (choices made at planning time, with reasons)

| Decision | Reason |
|---|---|
| Hand-rolled IndexedDB wrapper, no `idb`/`localforage` dep | ~120 lines; full control over corruption recovery and eviction; repo prefers zero-dep infrastructure |
| No Service Worker | IDB-direct gives the same offline/warm wins without SW lifecycle complexity and dev-server interplay; SW listed as future work |
| No PMTiles/tippecanoe | Native tooling absent on Windows; server MVT + client IDB cache meets the targets; severable future work |
| No WebGL renderer work | Rendering-engine change is orthogonal to loading/caching and high-risk; 1M MVT already renders (see `bench-1m-render.png`); documented as future optimization |
| `fake-indexeddb` + `playwright` dev-deps | Only way to test IDB in jsdom / measure real-browser metrics; dev-only |
| Cache version signal = `layer.updatedAt` | Same signal the server ETag already trusts; bumps on any layer PATCH (style edits too — harmless over-invalidation, accepted) |
| Session 2 real data: Natural Earth + Geofabrik Monaco + Geofabrik Berlin | Public domain / ODbL, direct stable URLs, ≈220 MB total < 500 MB budget, spans all three loading tiers |
| Session 3 Hangzhou via Overpass API, not Geofabrik China | `china-latest` is > 1 GB (budget breach); Overpass fetches only the ~8×8 km study extent; raw responses cached on disk, query + timestamp recorded for reproducibility |

---

# Session 1 — Geospatial Loading Performance

**Scope:** frontend multi-level cache (memory LRU → IndexedDB → conditional HTTP), request deduplication, stale-while-revalidate, worker JSON parsing with transferable buffers, chunked feature insertion, neighbor-tile prefetch, offline metadata snapshot, opt-in point clustering, cache metrics; one small backend addition (ETag on `/features`); a Playwright benchmark harness with baseline-before/final-after numbers.

**Out of scope:** WebGL rendering, PMTiles, service workers, attribute-table changes, any Session 2–4 content.

**Acceptance criteria** (measured by the harness of Task 1.1 on the seeded Benchmarks project, same machine, dev build):
1. Warm reload (second visit, IDB populated): time-to-first-`rendercomplete` ≤ 50 % of cold baseline; network bytes ≤ 10 % of cold baseline.
2. Cache-hit latency: memory p95 ≤ 2 ms, IDB p95 ≤ 15 ms (from `geoCache` metrics).
3. Zero duplicate concurrent identical tile/feature requests during a scripted zoom-out/in (dedupe metric `dedupedRequests` > 0, network request count for repeated URLs == 1).
4. Medium-tier load (10K layer): longest main-thread task during load ≤ 50 % of baseline longest task (worker parse absorbs `JSON.parse`).
5. Cold-path regression bound: cold initial load and pan p95 frame time within +10 % of baseline.
6. Corrupted-cache recovery: with a deliberately corrupted IDB store the app loads from network, logs one recovery, and repopulates (unit-tested + one manual harness run).
7. Both quality gates green.

**Expected commits (8–10):** housekeeping; bench harness; baseline doc; features ETag; IDB wrapper; geoCache core; tile wiring; feature wiring + worker; prefetch + metadata snapshot; clustering; metrics panel + final benchmark doc. (Squash-adjacent-small is fine but never across task boundaries.)

**Relevant tests to run at session end:** full web gate, backend gate (ETag change), harness cold/warm/pan scenarios.

### Task 1.0: Repo housekeeping

**Files:**
- Modify: `.gitignore` (root), `README.md`
- Delete: empty `frontend/` directory

- [ ] Root `.gitignore`: remove the dead `gis-platform/backend/var/` line; add:
  ```
  /*.png
  .playwright-mcp/
  web/bench/results/
  web/bench/.profiles/
  ```
- [ ] `README.md`: replace every `gis-platform/backend` → `backend`, `gis-platform/web` → `web`; fix doc links `docs/01-…` → `docs/learning/01-…`; add one line under Quality gates: "Benchmarks: see `docs/benchmarks.md`" (file arrives in Task 1.2).
- [ ] `Remove-Item frontend` (it is empty and untracked).
- [ ] Commit: `chore: fix stale README paths, ignore capture artifacts`

### Task 1.1: Playwright benchmark harness

**Files:**
- Create: `web/bench/bench.mjs`, `web/bench/README.md`
- Modify: `web/package.json` (devDeps `playwright`; script `"bench": "node bench/bench.mjs"`), `web/src/map/MapCanvas.tsx` (one `performance.mark`)

**Interfaces:**
- Produces: CLI `node bench/bench.mjs --scenario cold|warm|pan --project "Benchmarks" [--url http://localhost:1317]` writing JSON to `web/bench/results/<scenario>-<runstamp>.json` and printing a summary table.
- Metrics captured per run: `initialLoadMs` (navigation start → first OL `rendercomplete`), `panP95FrameMs` (rAF deltas during scripted pan), `moveSettleP95Ms` (moveend → rendercomplete), `usedJSHeapMB` (`performance.memory`, launched with `--enable-precise-memory-info`), `networkBytes` (CDP `Network.loadingFinished` `encodedDataLength` sum), `longTasks` (count + max duration via buffered `PerformanceObserver('longtask')`), and — once geoCache exists — `window.__geoCache.metrics` verbatim.

- [ ] App-side mark: in `MapCanvas.tsx`, after the map gets its target, attach `map.once('rendercomplete', () => performance.mark('graticule:first-render'))`. No test needed beyond typecheck (it is instrumentation), but keep it out of the render path (inside the existing effect).
- [ ] `bench.mjs` core (real code, abbreviated only by omitted imports):
  ```js
  const scenario = arg('--scenario', 'cold')
  const profileDir = path.join('bench', '.profiles', scenario === 'warm' ? 'warm' : `cold-${Date.now()}`)
  // warm scenario REUSES the profile dir so IndexedDB + HTTP cache persist across runs
  const ctx = await chromium.launchPersistentContext(profileDir, {
    args: ['--enable-precise-memory-info'], viewport: { width: 1440, height: 900 },
  })
  const page = ctx.pages()[0] ?? await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable')
  let networkBytes = 0
  cdp.on('Network.loadingFinished', (e) => { networkBytes += e.encodedDataLength })
  await page.addInitScript(() => {
    window.__bench = { longTasks: [], frames: [] }
    new PerformanceObserver((l) => window.__bench.longTasks.push(...l.getEntries().map(e => e.duration)))
      .observe({ type: 'longtask', buffered: true })
  })
  await page.goto(`${baseUrl}/projects/${projectId}/map`)
  await page.waitForFunction(() => performance.getEntriesByName('graticule:first-render').length > 0, { timeout: 120_000 })
  ```
  Pan scenario: `page.evaluate` a loop of `view.animate({center: …, duration: 800})` between two anchors 5×, recording rAF deltas into `window.__bench.frames`, then compute p95 in Node. Resolve `projectId` by name via `GET /api/v1/projects`.
- [ ] Verify: with backend + `npm run dev` running and Benchmarks seeded (`python scripts/bench.py seed`), `npm run bench -- --scenario cold` writes a results JSON with non-zero `initialLoadMs` and `networkBytes`.
- [ ] Commit: `feat(bench): playwright map benchmark harness (cold/warm/pan)`

### Task 1.2: Record the baseline

**Files:**
- Create: `docs/benchmarks.md`

- [ ] Seed: `cd backend && python scripts/bench.py seed`. Run `python scripts/bench.py measure` (server-side numbers) and the harness: cold ×3, warm ×3 (run cold once first to populate the warm profile — pre-geoCache "warm" is just browser HTTP cache), pan ×3 on the 100K and 1M layers' project.
- [ ] `docs/benchmarks.md` gets: methodology (machine, commands, dataset, N runs, median-of-3 reporting), a **Baseline (pre-cache, commit <hash>)** table with all six metric families (initial load, pan/zoom latency, memory, cache-hit latency = n/a at baseline, network transfer, main-thread long tasks), and the server-side bench.py table.
- [ ] Commit: `docs(bench): baseline numbers before client caching`

### Task 1.3: ETag + conditional GET on `/features`

**Files:**
- Modify: `backend/app/api/v1/routes/features.py`
- Test: `backend/tests/test_features_api.py`

**Interfaces:**
- Produces: `GET /layers/{id}/features` responses carry `ETag: W/"<sha256[:32]>"` over `f"{layer.id}:{layer.updated_at.isoformat()}:{bbox}:{simplify}:{precision}:{limit}"` and `Cache-Control: no-cache`; a request with matching `If-None-Match` returns **304** with empty body. The client cache (Task 1.7) sends `If-None-Match` on revalidation.

- [ ] Failing test:
  ```python
  async def test_features_conditional_get(client, cities_layer):
      url = f"/api/v1/layers/{cities_layer}/features"
      first = await client.get(url, params={"bbox": "-180,-90,180,90"})
      assert first.status_code == 200
      etag = first.headers["etag"]
      again = await client.get(url, params={"bbox": "-180,-90,180,90"}, headers={"if-none-match": etag})
      assert again.status_code == 304 and again.content == b""
      other_bbox = await client.get(url, params={"bbox": "0,0,1,1"}, headers={"if-none-match": etag})
      assert other_bbox.status_code == 200  # different query → different ETag
  ```
- [ ] Implement in the route (mirror the tile route's pattern at `routes/tiles.py:26-41`; the layer object is already loaded there via the service — if the current route delegates layer lookup to `feature_service`, have the service return the layer's `updated_at` alongside the collection or fetch the layer first in the route as tiles do).
- [ ] Backend gate; commit: `feat(api): conditional GET with weak ETags on feature responses`

### Task 1.4: IndexedDB wrapper with corruption recovery

**Files:**
- Create: `web/src/cache/idb.ts`
- Test: `web/src/cache/idb.test.ts` (devDep `fake-indexeddb`, imported as `fake-indexeddb/auto` in the test file only)

**Interfaces:**
- Produces:
  ```ts
  export type StoreName = 'tiles' | 'features' | 'meta'
  export interface StoredEntry {
    key: string; value: unknown; etag: string | null
    storedAt: number; lastAccess: number; size: number; layerId: string
  }
  export interface GeoDB {
    get(store: StoreName, key: string): Promise<StoredEntry | undefined>
    put(store: StoreName, entry: StoredEntry): Promise<void>
    delete(store: StoreName, key: string): Promise<void>
    deleteByLayer(store: StoreName, layerId: string): Promise<number>
    evictLRU(store: StoreName, targetBytes: number): Promise<number>  // returns bytes evicted
    totalBytes(store: StoreName): Promise<number>
    close(): void
  }
  /** Opens `graticule-geocache` v1 (stores tiles/features/meta, keyPath 'key',
   * indexes 'lastAccess' and 'layerId'). On any open/upgrade failure it deletes
   * the database and retries ONCE; if that fails too, resolves null (caller
   * falls back to memory-only) and increments the passed onError counter. */
  export function openGeoDB(onError: () => void): Promise<GeoDB | null>
  ```
- All per-operation failures (`get`/`put`/…) are caught inside the wrapper: `get` failures resolve `undefined`, `put`/`delete` failures resolve silently after calling `onError`. The cache must never throw into map rendering.

- [ ] Failing tests: round-trip put/get; `deleteByLayer` removes only that layer's keys; `evictLRU` removes oldest-`lastAccess` entries until under target and returns evicted byte count; corruption path — force `indexedDB.open` to reject once (spy) and assert one delete+retry then success; both attempts failing resolves `null` and fires `onError`.
- [ ] Implement (~130 lines, cursor over the `lastAccess` index for eviction; running byte total maintained per store in the `meta` store under key `__bytes:<store>` to avoid full scans).
- [ ] Commit: `feat(cache): IndexedDB store with LRU eviction and corruption recovery`

### Task 1.5: geoCache core — keys, memory LRU, SWR, dedupe, metrics

**Files:**
- Create: `web/src/cache/geoCache.ts`, `web/src/cache/keys.ts`
- Test: `web/src/cache/geoCache.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 1.6–1.9, 1.11 and the bench harness):
  ```ts
  // keys.ts — every cache key embeds the dataset version (updatedAt) so
  // invalidation is structural, and the query params so variants never collide.
  export function tileKey(layerId: string, updatedAt: string, z: number, x: number, y: number): string
  export function featureKey(layerId: string, updatedAt: string, bbox: string,
    p: { simplify?: number; precision?: number; limit?: number }): string

  // geoCache.ts
  export interface GeoCacheMetrics {
    memHits: number; idbHits: number; misses: number
    revalidated304: number; revalidated200: number
    dedupedRequests: number; evictedBytes: number; idbErrors: number
    networkBytes: number; cachedBytesServed: number
    hitLatencyMs: { mem: number[]; idb: number[] }   // ring buffers, max 500 samples
  }
  export interface FetchResult<T> { value: T; source: 'mem' | 'idb' | 'network' }
  /** Tiles: raw bytes (null = server 204 empty tile, cached as such). */
  export function cachedTile(key: string, url: string, layerId: string,
    signal?: AbortSignal): Promise<FetchResult<ArrayBuffer | null>>
  /** Features: parsed FeatureCollection JSON (object, structured-cloned via IDB). */
  export function cachedFeatures(key: string, url: string, layerId: string,
    signal?: AbortSignal): Promise<FetchResult<unknown>>
  export function invalidateLayer(layerId: string): Promise<void>
  export function warmTile(key: string, url: string, layerId: string, signal?: AbortSignal): Promise<void> // prefetch: skip if cached, fetch+store otherwise
  export function getMetrics(): GeoCacheMetrics
  export function resetForTests(): void
  ```
- Behavior contract: memory tier is a Map-based LRU (budget 32 MiB — OL keeps parsed data, so this tier only accelerates re-visits and dedupe); IDB tier budget **256 MiB** with hysteresis (evict to 224 MiB on overflow); a hit returns immediately and — when `Date.now() - storedAt > FRESH_MS` (60 000, mirroring the server `max-age`) — fires ONE background revalidation with `If-None-Match` (304 → refresh `storedAt`; 200 → replace stored value; network error → keep serving cached, i.e. offline works); concurrent calls for the same key share one in-flight promise (dedupe) with abort refcounting (underlying fetch aborts only when every caller aborted); `lastAccess` writes are throttled to once per 60 s per key; error responses are never cached; non-OK network → typed error via the existing `ApiError` shape.

- [ ] Failing tests (mock `fetch`, use fake-indexeddb): miss→network→stored; second get→mem hit, no fetch; mem evicted→idb hit; stale hit triggers exactly one conditional request with `If-None-Match` and a 304 refreshes without replacing; two concurrent gets → one fetch, `dedupedRequests === 1`; abort of one caller doesn't abort the shared fetch, abort of both does; `invalidateLayer` clears both tiers for that layer only; eviction fires past budget; when `openGeoDB` resolves null everything still works memory-only and `idbErrors > 0`.
- [ ] Implement. Commit: `feat(cache): multi-level geo cache — memory LRU, IndexedDB, SWR, dedupe`

### Task 1.6: Route vector/raster tiles through geoCache

**Files:**
- Modify: `web/src/map/memory/instrumentation.ts`, `web/src/map/layerFactory.ts`, `web/src/map/syncLayers.ts` (only if `updatedAt` isn't already reachable where sources are built), `backend/app/schemas/layer.py` + `web/src/api/types.ts` (only if `updatedAt` missing from the wire — see Current state)
- Test: `web/src/map/memory/instrumentation.test.ts` (new), existing `layerFactory.test.ts` extended

**Interfaces:**
- Consumes: `cachedTile`, `tileKey` (Task 1.5).
- Produces: `instrumentVectorTileSource`/`instrumentTileSource` load via `cachedTile` instead of raw `fetch`; the OL layer carries `olLayer.set('cache_meta', { layerId, updatedAt })` refreshed by `applyLayerProperties` on every sync so the loader closure always keys with the current `updatedAt` without rebuilding the source.

- [ ] Failing test: instrumented source's tile load function called twice for the same tile URL performs one network fetch (spy) and reports both byte counts to the memory manager; after `applyLayerProperties` with a bumped `updatedAt`, the next load misses (new key).
- [ ] Implement. Parse tile z/x/y for the key from the URL template substitution OL already performs (the loader receives the final URL; extract with the regex `/tiles\/(\d+)\/(\d+)\/(\d+)\.(mvt|png)$/`).
- [ ] Run the harness warm scenario once locally — expect `idbHits > 0` on reload. Commit: `feat(map): serve MVT and raster tiles through the persistent cache`

### Task 1.7: Feature responses — cache, worker parse, transferables, chunked insert, honest bytes

**Files:**
- Create: `web/src/cache/parseJsonWorker.ts` (module worker: `{id, buffer} → {id, ok, value|error}`, parses `new TextDecoder().decode(buffer)` then `JSON.parse`), `web/src/cache/parseJson.ts` (main-thread facade)
- Modify: `web/src/map/featureLoader.ts`, `web/src/api/features.ts`
- Test: `web/src/cache/parseJson.test.ts`, `web/src/map/featureLoader.test.ts` (extend)

**Interfaces:**
- Consumes: `cachedFeatures`, `featureKey`.
- Produces:
  ```ts
  // parseJson.ts — buffer is TRANSFERRED to the worker (zero-copy).
  // Falls back to main-thread JSON.parse below 256 KiB or after a 10 s
  // watchdog / worker error (pattern copied from useParseWorker.ts).
  export function parseJsonOffThread(buffer: ArrayBuffer): Promise<unknown>
  ```
  `createBboxLoader`/`createFullLoader` gain the flow: build URL + key (needs `layerId`, `updatedAt` — extend `LoaderTarget` params) → `cachedFeatures` (which internally uses `parseJsonOffThread` for network responses and stores the parsed object; IDB hits skip parsing entirely) → convert with the existing GeoJSON format reader → **chunked `addFeatures`** in slices of 2 000 with an awaited `requestAnimationFrame` between slices, checking the abort signal between chunks → `success(all)`. Byte accounting: use `buffer.byteLength` (network) or the stored `size` (cache hit) — **delete both `JSON.stringify(collection).length` call sites** (`featureLoader.ts:65,94`).
- [ ] Failing tests: loader reports `byteLength`, not re-serialized length (assert the stringify spy is never called); chunked insertion inserts all features across ≥2 frames for 5 000 features and stops at the chunk boundary when aborted; parse falls back to main thread when the worker errors (jsdom has no real worker — the facade's fallback branch IS the jsdom path, and the worker branch is covered by a constructor-level unit test with a mocked Worker).
- [ ] Implement; run web gate. Commit: `feat(map): cached, worker-parsed, chunk-inserted feature loading`

### Task 1.8: Neighbor-tile prefetch

**Files:**
- Create: `web/src/map/prefetch.ts`
- Modify: `web/src/App.tsx` (attach/detach with the map lifecycle)
- Test: `web/src/map/prefetch.test.ts`

**Interfaces:**
- Consumes: `warmTile`, `tileKey`; OL `map`, each large-tier layer's `VectorTileSource.getTileGrid()` and url template.
- Produces: `attachTilePrefetch(map: OlMap, opts?: { limit?: number; idleMs?: number }): () => void` — on `moveend`, waits `idleMs` (400), then for every **visible** large-tier vector-tile layer collects the one-tile ring around the current viewport at the current z (via `tileGrid.forEachTileCoord` over the extent buffered by one tile size), sorts by distance from center, and calls `warmTile` for at most `limit` (16) tiles with a shared AbortController that `movestart` aborts. Never prefetches for hidden layers.

- [ ] Failing tests (fake timers, stub map/source): computes the ring, respects the cap, aborts on movestart, skips hidden layers.
- [ ] Implement + attach. Commit: `feat(map): idle prefetch of neighboring vector tiles`

### Task 1.9: Persistent workspace-metadata snapshot (offline shell)

**Files:**
- Create: `web/src/cache/metaSnapshot.ts`
- Modify: `web/src/App.tsx`
- Test: `web/src/cache/metaSnapshot.test.ts`

**Interfaces:**
- Produces: `saveWorkspaceSnapshot(projectId: string, data: ProjectRead): Promise<void>` (written to the `meta` store on every successful project query, key `project:<id>`) and `loadWorkspaceSnapshot(projectId: string): Promise<ProjectRead | null>`. In `App.tsx`, when the project query errors with a network failure (not a 404), hydrate from the snapshot via `queryClient.setQueryData(['project', id], snapshot)` and render a dismissible `role="status"` banner "Showing cached workspace — backend unreachable". Combined with Tasks 1.6/1.7 this makes a previously-visited workspace render fully offline (project basemap tiles from Mapbox excepted).

- [ ] Failing tests: snapshot saved on success; network-error + snapshot → hydrated data + banner; 404 → no hydration (falls through to the existing error path).
- [ ] Implement. Commit: `feat(app): offline workspace restore from cached metadata`

### Task 1.10: Opt-in clustering for point layers

**Files:**
- Modify: `backend/app/schemas/style.py` (optional `cluster: ClusterSpec | None` with `ClusterSpec{enabled: bool, distance: int = 48}` — additive, default None), `web/src/api/types.ts`, `web/src/map/layerFactory.ts` (small/medium point layers with `style.cluster?.enabled` wrap their `VectorSource` in `ol/source/Cluster`), `web/src/map/styleCompiler.ts` (cluster features — `features.length > 1` — render a circle + count label using the style's primary color; single-member clusters delegate to the compiled per-feature style), `web/src/features/styling/StyleEditor.tsx` (checkbox + distance input, point geometry only)
- Test: `backend/tests/test_schemas.py` (accepts/roundtrips cluster spec), `web/src/map/layerFactory.test.ts`, `web/src/map/styleCompiler.test.ts`

- [ ] Backend failing test → implement → gate. Web failing tests: cluster-enabled point layer builds a `Cluster` source with the configured distance; MVT (large) tier ignores the flag (assert plain source); compiler renders count label for multi-feature clusters.
- [ ] Implement; verify by toggling on a bench layer in the browser. Commit: `feat(map): opt-in point clustering persisted in layer style`

### Task 1.11: Cache metrics in the memory panel

**Files:**
- Modify: `web/src/features/memory/MemoryPanel.tsx`, `web/src/cache/geoCache.ts` (expose `window.__geoCache = { metrics: getMetrics }` in dev/bench builds — guard `if (import.meta.env.DEV || import.meta.env.MODE === 'bench')`)
- Test: `web/src/features/memory/MemoryPanel.test.tsx` (extend)

- [ ] Failing test: panel shows a "Data cache" section with hit ratio, entries/bytes per tier, revalidations, dedupes, IDB errors, and a "Clear cache" button that calls a new `clearAll()` export.
- [ ] Implement (poll `getMetrics()` on the panel's existing refresh cadence). Commit: `feat(memory): surface data-cache metrics and manual clear`

### Task 1.12: Final benchmarks + session close

- [ ] Re-run: `python scripts/bench.py measure`; harness cold ×3 / warm ×3 / pan ×3 on the Benchmarks project.
- [ ] Append a **Post-cache (commit <hash>)** section to `docs/benchmarks.md` with a baseline-vs-now delta table for all six metric families and a short honest analysis (including any metric that did NOT improve). Verify acceptance criteria 1–6 explicitly; where a criterion fails, say so in the handoff rather than tuning numbers.
- [ ] Both quality gates. Commit: `docs(bench): session 1 results — client cache hierarchy`
- [ ] Rewrite `docs/superpowers/HANDOFF.md` (per Session protocol) — next task: Session 2.

---

# Session 2 — Project Management and Real Test Data

**Scope:** full project lifecycle (create/rename/update/delete/switch) with safe cascading cleanup and orphan sweeping; active-project fallback; e2e infrastructure; real-dataset acquisition (< 500 MB) with recorded provenance.

**Out of scope:** Hangzhou (Session 3), auth/user model (known platform gap), export retention policy beyond project-scoped cleanup.

**Acceptance criteria:**
1. Backend: `DELETE /projects/{id}` removes — layer rows (existing cascade), every `gis_data` table referenced **only** by that project's layers, raster files referenced only by that project, the thumbnail PNG, export files of the project's tasks, and its task tmp-upload dirs; returns `{deleted: true, cleaned: {...counts}, failures: [...]}`. Tables/files also referenced by another project's layers survive (test proves it).
2. `DELETE /layers/{id}` performs the same reference-counted cleanup for its single table/raster.
3. `POST /system/maintenance/purge-orphans` (default `dryRun=true`) reports and, with `dryRun=false`, removes orphaned `gis_data` tables, thumbnails, exports, and tmp uploads; running it twice is a no-op; the ~20 pre-existing orphans are actually purged during the session (recorded in handoff).
4. Web: create (Dashboard empty-state + Projects page), rename (inline on Projects page), delete (dialog requiring the project name typed back, listing layer count and cleanup consequences); switching stays URL-based. Deleting the current/last-used project cleans its localStorage keys (`graticule:layout:<id>`, `graticule:layout-presets:<id>`, `graticule:basemap:<id>`, `graticule:lastProject` if matching) and navigates to `/projects`; opening a URL for a deleted project shows the not-found state with a link back (no crash).
5. e2e: `npx playwright test` runs a full lifecycle spec (create → import fixture → open workspace → rename → delete → fallback) green against the dev stack.
6. Real data: `python scripts/fetch_testdata.py` downloads Natural Earth + Monaco + Berlin (≈220 MB, script asserts total < 500 MB), re-zips per-theme shapefiles, imports via the **async task endpoint** (`POST /projects/{id}/tasks/import`) polling to completion, and is idempotent (re-run replaces the three projects). `docs/data-provenance.md` records source, license, URL, size, format, CRS, preprocessing, artifacts for every dataset.
7. Both gates green; Session 1 cache works against Berlin's large layers (spot-check in handoff).

**Expected commits (6–8):** deletion cleanup backend; purge-orphans; web project CRUD + fallback; e2e infra + lifecycle spec; fetch script + provenance; handoff.

### Task 2.1: Reference-counted deletion cleanup (backend)

**Files:**
- Modify: `backend/app/services/project_service.py`, `backend/app/services/layer_service.py`, `backend/app/api/v1/routes/projects.py`, `backend/app/api/v1/routes/layers.py`, `backend/app/schemas/project.py` (deletion report schema)
- Create: `backend/app/services/artifact_cleanup.py`
- Test: `backend/tests/test_project_lifecycle.py`

**Interfaces:**
- Produces:
  ```python
  # artifact_cleanup.py
  @dataclass
  class ArtifactPlan:
      tables: list[tuple[str, str]]      # (schema, table) — schema always == settings.import_schema
      raster_paths: list[Path]
      thumbnail: Path | None
      export_paths: list[Path]
      upload_dirs: list[Path]

  async def plan_for_project(session, project: Project) -> ArtifactPlan: ...
  async def plan_for_layer(session, layer: Layer) -> ArtifactPlan: ...
  def execute(plan: ArtifactPlan) -> CleanupReport:  # best-effort; every failure captured, never raised
  ```
  Reference counting: a `gis_data` table (or raster path) enters the plan only when **zero layers outside the deletion set** reference the same `source.table_name`/path (one SQL query over `gis.layer.source` JSONB per artifact kind, using `->>'table_name'` / `->>'path'`). DDL (`DROP TABLE IF EXISTS`) runs on the sync engine in a thread, names via `validate_identifier` + `quote`.
- Route semantics (the documented exception to one-request-one-transaction): the route builds the plan, deletes the ORM row, **explicitly commits**, then runs `execute(plan)` and returns `200 {"deleted": true, "cleaned": {...}, "failures": [...]}` (was 204 — the web client tolerates both; update `deleteLayer`/add `deleteProject` accordingly). DB truth first; disk/DDL cleanup is best-effort; anything that fails becomes an orphan for Task 2.2's sweeper. Task history: per the deliberate cascade, project deletion removes the project's tasks — update the `models/task.py` docstring to say history survives *layer* deletion, not *project* deletion (decision recorded here).

- [ ] Failing tests: delete project with an imported layer → table gone, thumbnail gone (create a dummy file first), export file of a project task gone, tmp upload dir gone; two projects registering the SAME `gis_data` table (via `/layers/from-postgis`) → deleting one keeps the table; monkeypatched `Path.unlink` raising → response `failures` non-empty, DB row still deleted; layer-level delete drops its table only when unreferenced.
- [ ] Implement; backend gate. Commit: `feat(api): project and layer deletion clean their data artifacts`

### Task 2.2: Orphan sweeper

**Files:**
- Create: route in `backend/app/api/v1/routes/system.py`, logic in `backend/app/services/artifact_cleanup.py` (extend)
- Test: `backend/tests/test_purge_orphans.py`

**Interfaces:**
- Produces: `POST /api/v1/system/maintenance/purge-orphans?dryRun=true|false` → `{"dryRun": bool, "tables": [...], "thumbnails": [...], "exports": [...], "uploadDirs": [...], "removed": {...counts when not dry-run}}`. Orphan = `gis_data` table in `geometry_columns` not referenced by any `gis.layer.source`; thumbnail without a project row; export file without a task row; `tmp/tasks/*` dir whose task is missing or in a terminal non-retryable state.

- [ ] Failing tests: seeded orphans of each kind are reported in dry-run and removed with `dryRun=false`; referenced artifacts never appear; second run reports empty.
- [ ] Implement; run it for real against the dev DB once (removes the accumulated orphans; record counts in handoff). Commit: `feat(api): orphan sweeper for tables, thumbnails, exports and uploads`

### Task 2.3: Project CRUD UI + active-project fallback

**Files:**
- Modify: `web/src/api/layers.ts` (add `deleteProject`; align delete return type), `web/src/pages/ProjectsPage.tsx`, `web/src/pages/DashboardPage.tsx`, `web/src/app/ProjectSwitcher.tsx` ("New project…" entry), `web/src/App.tsx` (404 → not-found state with link, already-partially-handled — verify)
- Create: `web/src/features/projects/ProjectDialogs.tsx` (create + rename + delete-confirm dialogs), `web/src/features/projects/useProjectMutations.ts`, `web/src/features/projects/localCleanup.ts`
- Test: `web/src/features/projects/ProjectDialogs.test.tsx`, `web/src/features/projects/useProjectMutations.test.ts`, `web/src/features/projects/localCleanup.test.ts`

**Interfaces:**
- Produces: `useProjectMutations()` → `{ create, rename, remove }` TanStack mutations invalidating `['projects']`; delete-confirm dialog disables its destructive button until the typed name matches exactly and shows layer count + "removes N imported tables and related files"; `cleanupProjectLocalState(projectId: string)` removes the four localStorage keys and returns the fallback route (`/projects`).

- [ ] Failing tests: create dialog posts name and navigates to the new project's overview; rename patches; delete requires exact name match, calls `deleteProject`, runs local cleanup, navigates; `graticule:lastProject` cleared only when it matches.
- [ ] Implement; web gate. Commit: `feat(web): project create, rename and guarded delete with local-state fallback`

### Task 2.4: e2e infrastructure + lifecycle spec

**Files:**
- Create: `web/playwright.config.ts` (baseURL `http://localhost:1317`, `webServer` starting `npm run dev` with `reuseExistingServer: true`; backend + DB documented as prerequisites in the config header comment), `web/e2e/project-lifecycle.spec.ts`, `web/e2e/fixtures/lakes-sample.geojson` (≤ 50 KB, ~20 polygon features — generate from Natural Earth lakes; committed test fixture)
- Modify: `web/package.json` (devDep `@playwright/test`, script `"e2e": "playwright test"`), `web/tsconfig.json` sphere — ensure `npm run typecheck` still only sweeps `src/` (add `e2e/tsconfig.json` extending the base with playwright types if `tsc -b` complains)

- [ ] Spec (assert at each step): create project via UI → appears in list → open workspace → Add layer → import the fixture file → layer renders (wait for `graticule:first-render` mark + layer row visible) → back to `/projects` → rename → name updated → delete with typed confirmation → list no longer shows it → direct navigation to the old workspace URL shows the not-found state.
- [ ] Run: `npx playwright install chromium` once, then `npm run e2e` green against the running stack.
- [ ] Commit: `test(e2e): full project lifecycle in a real browser`

### Task 2.5: Real test data — fetch, import, provenance

**Files:**
- Create: `backend/scripts/fetch_testdata.py`, `docs/data-provenance.md`

**Interfaces:**
- Produces: `python scripts/fetch_testdata.py [--only ne|monaco|berlin] [--base http://localhost:1316]`. Manifest (in-script constant):

  | Dataset | URL | License | ~Size | Target project |
  |---|---|---|---|---|
  | NE 10m admin_0 countries | `https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_0_countries.zip` | Public domain | 6 MB | Real Data — Global |
  | NE 10m admin_1 states | `https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_1_states_provinces.zip` | Public domain | 10 MB | Real Data — Global |
  | NE 10m populated places | `https://naciscdn.org/naturalearth/10m/cultural/ne_10m_populated_places.zip` | Public domain | 7 MB | Real Data — Global |
  | NE 10m roads | `https://naciscdn.org/naturalearth/10m/cultural/ne_10m_roads.zip` | Public domain | 8 MB | Real Data — Global |
  | NE 10m lakes | `https://naciscdn.org/naturalearth/10m/physical/ne_10m_lakes.zip` | Public domain | 4 MB | Real Data — Global |
  | NE 10m urban areas | `https://naciscdn.org/naturalearth/10m/cultural/ne_10m_urban_areas.zip` | Public domain | 2 MB | Real Data — Global |
  | Geofabrik Monaco extract | `https://download.geofabrik.de/europe/monaco-latest-free.shp.zip` | ODbL 1.0 | 3 MB | Real Data — Monaco (small urban scene) |
  | Geofabrik Berlin extract | `https://download.geofabrik.de/europe/germany/berlin-latest-free.shp.zip` | ODbL 1.0 | ~180 MB | Real Data — Berlin (large-tier realism: buildings ≈ 0.5 M polygons, roads ≈ 0.2 M lines) |

  Behavior: stream-download to `backend/var/downloads/<name>/` with skip-if-present + printed SHA-256; assert cumulative download < 500 MB; NE zips upload as-is (single shp each); Geofabrik zips are extracted and re-zipped **per theme** (`gis_osm_buildings_a_free_1`, `gis_osm_roads_free_1`, `gis_osm_water_a_free_1`, `gis_osm_landuse_a_free_1`, `gis_osm_pois_free_1` — shp+dbf+shx+prj+cpg each) because the importer takes the first `.shp` in an archive; each theme zip is submitted to `POST /projects/{id}/tasks/import` and polled via `GET /tasks/{id}` until terminal, failing loudly on `failed`; idempotency: if the target project exists it is deleted first via the API (exercising Task 2.1!) then recreated.
- [ ] `docs/data-provenance.md`: one row per dataset — source, license (+ attribution line for ODbL: "© OpenStreetMap contributors"), exact URL, download date, size on disk, format, source CRS (all EPSG:4326), preprocessing (re-zip command performed by the script), generated artifacts (project + layer names + `gis_data` table names printed by the script and pasted in).
- [ ] Run the script fully; open Berlin buildings in the workspace; confirm MVT tier + cache serve it (harness warm run; numbers to handoff).
- [ ] Commit: `feat(data): scripted real-dataset acquisition with recorded provenance`

### Task 2.6: Session close

- [ ] Both gates + `npm run e2e` + a Session 1 harness warm run against "Real Data — Berlin" (regression guard). Record in `docs/benchmarks.md` under "Real-data spot checks".
- [ ] Rewrite `docs/superpowers/HANDOFF.md`; next task: Session 3.

---

# Session 3 — Hangzhou Research Dataset

**Scope:** a coherent central-Hangzhou study area as the default demo: boundary, buildings, roads/transport, water, landuse, POIs (7 categories); cleaned, CRS-normalized, field-reduced; styled demo project with legends, zoom ranges, sensible defaults. Adds two small product features the demo needs: per-layer zoom range (in `StyleSpec`) and a legend panel.

**Study extent (decision):** `120.115 E – 120.205 E, 30.215 N – 30.285 N` (~8.6 × 7.8 km): West Lake's east shore, Hubin/Wulin CBD, and the Grand Canal — dense, recognizable, and small enough for Overpass.

**Acceptance criteria:**
1. `python scripts/hangzhou_demo.py` (fetch → clean → import → style) rebuilds the "Hangzhou Study Area" project idempotently from cached raw responses; `--refresh` refetches from Overpass.
2. Data quality gates (script-enforced, printed): 100 % `ST_IsValid` after repair, 0 empty geometries, all layers EPSG:4326, every layer clipped to the study extent, POIs categorized into exactly {transit, education, healthcare, commercial, cultural, tourism, public-service}, field count per layer ≤ 8.
3. Demo project: boundary (always visible, outline), landuse + water (fills, visible, no zoom limit), buildings (visible from zoom ≥ 13), roads (major always, minor via one layer with zoom ≥ 12 — single layer, `minZoom` 12 is acceptable if class-split proves noisy), POIs (categorized markers, zoom ≥ 13), view centered `[120.160, 30.252]` zoom 13. Legend panel shows every visible layer's classes.
4. Zoom-range + legend features are unit-tested on both sides; both gates green.
5. `docs/data-provenance.md` extended with every Overpass query, endpoint, `osm3s` timestamp, response sizes, license (ODbL), and the cleaning steps.
6. Browser verification: workspace screenshot at z13 (overview) and z15 (street level) captured and referenced from the handoff.

**Expected commits (5–6):** zoom-range feature; legend panel; fetch script; pipeline + build script; provenance + verification; handoff.

### Task 3.1: Per-layer zoom range in StyleSpec

**Files:**
- Modify: `backend/app/schemas/style.py` (optional `min_zoom: int | None` / `max_zoom: int | None`, 0–24, additive), `web/src/api/types.ts`, `web/src/map/layerFactory.ts` (`applyLayerProperties` calls `olLayer.setMinZoom(style.minZoom ?? -Infinity)` / `setMaxZoom(style.maxZoom ?? Infinity)`), `web/src/features/styling/StyleEditor.tsx` (two numeric inputs)
- Test: `backend/tests/test_schemas.py`, `web/src/map/layerFactory.test.ts`, `web/src/features/styling/StyleEditor.test.tsx`

- [ ] Failing tests both sides (schema roundtrip; OL layer receives min/max zoom; editor emits the fields) → implement → gates → Commit: `feat(style): per-layer zoom range`

### Task 3.2: Legend panel

**Files:**
- Create: `web/src/features/legend/LegendPanel.tsx`, `web/src/features/legend/legendEntries.ts`
- Modify: `web/src/features/layers/LayerPanel.tsx` (collapsible "Legend" section listing entries for visible layers)
- Test: `web/src/features/legend/legendEntries.test.ts`, `web/src/features/legend/LegendPanel.test.tsx`

**Interfaces:**
- Produces: `legendEntries(layer: LayerRead): LegendEntry[]` — pure function: single renderer → one swatch (fill/stroke/marker aware); categorized → one per class + "other" fallback; graduated → one per break with formatted ranges (`[min, max)` matching `styleCompiler` semantics); cluster flag appends a cluster badge entry. `LegendEntry = { label: string; swatch: { kind: 'fill'|'line'|'point'; color: string; stroke?: string } }`.

- [ ] Failing tests: entry derivation for all three renderers matches the styleCompiler's class semantics; panel renders swatches for visible layers only.
- [ ] Implement → gate → Commit: `feat(legend): legend panel derived from layer styles`

### Task 3.3: Overpass fetch with on-disk cache

**Files:**
- Create: `backend/scripts/hangzhou/fetch.py`, `backend/scripts/hangzhou/queries.py`
- Modify: `backend/pyproject.toml` (dev extra: `osm2geojson`)

**Interfaces:**
- Produces: `fetch_all(refresh: bool) -> dict[str, dict]` — theme → GeoJSON dict, cached at `backend/var/downloads/hangzhou/raw/<theme>.json`. Endpoint `https://overpass-api.de/api/interpreter`, 3 retries with 30 s backoff (Overpass rate-limits), `[out:json][timeout:180]`, shared bbox `(30.215,120.115,30.285,120.205)`. Themes (queries.py, real QL):
  - `boundary`: none fetched — the study rectangle is generated in code as one polygon feature.
  - `buildings`: `(way["building"](bbox); relation["building"](bbox););out geom;`
  - `roads`: `way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian|service)$"](bbox);out geom;`
  - `transit`: `(node["railway"="station"](bbox); node["station"="subway"](bbox); way["railway"~"^(rail|subway|light_rail)$"](bbox););out geom;`
  - `water`: `(way["natural"="water"](bbox); relation["natural"="water"](bbox); way["waterway"~"^(river|canal|stream)$"](bbox););out geom;`
  - `landuse`: `(way["landuse"](bbox); relation["landuse"](bbox); way["leisure"~"^(park|garden)$"](bbox); relation["leisure"~"^(park|garden)$"](bbox););out geom;`
  - `pois`: nodes+ways for `amenity~"^(school|university|college|kindergarten|hospital|clinic|pharmacy|theatre|library|townhall|police|fire_station|post_office|marketplace)$"`, `shop~"^(mall|department_store|supermarket)$"`, `tourism~"^(museum|attraction|viewpoint|hotel)$"`, `railway=station`, `highway=bus_stop`; `out center;` (ways collapse to centroids).
  Conversion via `osm2geojson.json2geojson`; record the response's `osm3s.timestamp_osm_base` per theme into `raw/manifest.json`.
- [ ] Verify: run against live Overpass; each theme lands non-empty (print feature counts). Commit: `feat(data): Hangzhou study-area Overpass fetch with cached raw responses`

### Task 3.4: Cleaning pipeline + demo build

**Files:**
- Create: `backend/scripts/hangzhou/pipeline.py` (pure geopandas transforms), `backend/scripts/hangzhou_demo.py` (CLI orchestrator: fetch → pipeline → write GeoJSON artifacts to `var/downloads/hangzhou/clean/` → delete-and-recreate project via API → import each artifact via `/tasks/import` → PATCH styles/order/visibility → PATCH project view)
- Test: `backend/tests/test_hangzhou_pipeline.py` (pipeline functions on tiny inline fixtures — no network)

**Interfaces:**
- Produces (pipeline.py):
  ```python
  def clean_frame(gdf: GeoDataFrame, extent: tuple[float,...]) -> GeoDataFrame:
      # make_valid → drop empty/null → clip to extent → to_crs(4326) → explode nothing (keep multi)
  def reduce_buildings(gdf) -> GeoDataFrame:   # keep: name, building, levels → int
  def reduce_roads(gdf) -> GeoDataFrame:       # keep: name, highway (class), oneway; adds road_rank int (motorway=0 … service=8)
  def reduce_water(gdf) / reduce_landuse(gdf)  # keep: name, water/waterway | landuse/leisure → category
  def categorize_pois(gdf) -> GeoDataFrame:    # adds category ∈ 7 values from the tag mapping in Task 3.3; keep name, category, subtype
  def study_boundary(extent) -> GeoDataFrame   # one rectangle polygon, fields: name="Hangzhou study area", area_km2
  ```
- Demo styling (constants in `hangzhou_demo.py`, applied via `PATCH /layers/{id}`): boundary — no fill, 2px dark outline, `zIndex` top; landuse — categorized pale fills (park green, residential warm gray, commercial tan); water — `#a8cfe7` fill; buildings — `#c9c4bc` fill 0.8 opacity, `minZoom: 13`; roads — graduated width by `road_rank` (categorized renderer on class, majors thicker/darker), `minZoom: 12`; transit — line + station markers; POIs — categorized markers by `category` (7 distinct hues from `ramps.ts`), `minZoom: 13`. Project view `{center: [120.160, 30.252], zoom: 13}`.
- [ ] Failing pipeline tests: invalid self-intersecting polygon becomes valid; features outside extent dropped; POI with `amenity=school` → `education`, `tourism=museum` → `cultural`, `railway=station` → `transit`; reduced frames expose exactly the whitelisted columns.
- [ ] Implement; run `python scripts/hangzhou_demo.py`; script prints per-layer counts + validity summary (acceptance §2).
- [ ] Commit: `feat(data): Hangzhou demo pipeline and styled study-area project`

### Task 3.5: Verification + provenance + session close

- [ ] Extend `docs/data-provenance.md` (queries, timestamps, sizes, license, cleaning steps, artifact names).
- [ ] Browser check: open the demo, capture z13 + z15 screenshots to `docs/captures/hangzhou-z13.png`, `docs/captures/hangzhou-z15.png` (this folder IS committed — small JPEG/PNG ≤ 300 KB each; adjust root `.gitignore` with `!docs/captures/*.png`), verify legend, zoom ranges, POI categories, identify on a building.
- [ ] Both gates; harness cold+warm on the Hangzhou project appended to `docs/benchmarks.md`.
- [ ] Commits: `docs(data): Hangzhou provenance and captures`; rewrite HANDOFF → next: Session 4.

---

# Session 4 — Validation and Documentation

**Scope:** end-to-end validation matrix + final documentation. No new features; only test/doc/tooling code and fixes for defects the validation uncovers (each fix committed separately with its own test).

**Acceptance criteria:**
1. **Benchmark matrix** (cold + warm × {Benchmarks 100K, Benchmarks 1M, Berlin buildings, Hangzhou}) recorded in `docs/benchmarks.md` with the methodology reproducible from the doc alone.
2. **Lifecycle:** Session 2 e2e green; purge-orphans dry-run reports zero orphans after a create-import-delete cycle.
3. **Large-layer interaction:** scripted pan/zoom/identify on the 1M layer meets Session 1's frame-time numbers; identify returns correct attributes (e2e assertion).
4. **Cache invalidation:** e2e — edit a feature in a medium-tier layer (bumps `updatedAt`) → reload → cache misses on the new key, old entries for the layer evicted (`invalidateLayer` called on layer PATCH — verify this wiring exists; if not, this is the one allowed product change, tested).
5. **Offline/reload:** e2e — warm visit, then `context.setOffline(true)` + reload → workspace renders from snapshot + IDB (assert banner, `idbHits > 0`, map `rendercomplete`).
6. **Memory leak:** harness scenario `leak` — open/close the workspace 10× in one page, force GC (`--js-flags=--expose-gc`), assert final heap ≤ 1.3 × first-cycle heap; plus `LayerMemoryManager` releases (existing `clearAll` on exit) verified via metrics.
7. **Cancellation regression:** e2e pan rapidly across a medium-tier layer and assert via CDP that superseded `/features` requests are actually aborted (failed/canceled in the network log), and the map settles correct.
8. **Hangzhou demo:** manual + scripted browser verification recorded with fresh screenshots.
9. **Docs complete:** README (accurate quickstart incl. data scripts + bench + e2e), `docs/architecture.md` (current three-tier + cache hierarchy diagram in mermaid, module map, task system), `docs/data-provenance.md` (final), `docs/benchmarks.md` (final tables + analysis), `docs/limitations-and-roadmap.md` (known limits: single-process caches, no auth, Mapbox token needed for basemaps, OSM coverage gaps in CN, no SW/WebGL/PMTiles — each with the recommended future step). Every doc statement about a command must be copy-paste runnable.
10. Both gates + e2e + full benchmark matrix green/recorded in the final HANDOFF, which closes the effort with "no next session — maintenance notes".

**Expected commits (5–7):** e2e validation specs (invalidation/offline/cancellation/identify); leak scenario in harness; any defect fixes (separate, test-first); benchmark matrix doc; documentation set; final handoff.

**Task order:** 4.1 e2e validation specs → 4.2 leak + cancellation scenarios → 4.3 benchmark matrix runs → 4.4 Hangzhou verification → 4.5 documentation set → 4.6 final handoff. (Each is structured like the tasks above: failing spec first where a spec is the deliverable; docs tasks end with a link-check + command-check pass.)

---

## Risks

| Risk | Mitigation |
|---|---|
| Overpass rate-limiting / outage during Session 3 | Raw responses cached on disk after first success; retries with backoff; the session can proceed from cache; fallback endpoint `https://overpass.kumi.systems/api/interpreter` documented in fetch.py |
| Geofabrik/Natural Earth URL drift | Script fails loudly with the URL; provenance doc records the download date; alternates: NE via `naturalearth_lowres` mirror, Geofabrik dated snapshots (`…-250101-free.shp.zip`) |
| Berlin buildings import time (0.5 M polygons through geopandas) | Runs as an async task (progress visible, retry-able); if `to_postgis` exceeds ~10 min, provenance notes it and the script's `--only` flag lets you skip Berlin without blocking the session |
| IDB quota pressure / private-mode browsers | 256 MiB budget + eviction; `openGeoDB` null-fallback keeps the app fully functional memory-only |
| `updatedAt` missing from `LayerRead` wire | Checked in Task 1.6; one-line additive schema change if needed |
| OL tile-URL regex breaks if the tile route changes | Regex lives next to `tileUrl()`; layerFactory test pins both |
| Playwright + dev-server flakiness on Windows | `reuseExistingServer`, generous timeouts, marks-based waits (never sleeps); e2e runs against the SAME stack the benches use |
| Style-PATCH bumping `updatedAt` over-invalidates data caches | Accepted (server ETag identical); noted in limitations doc |
| project deletion explicit-commit exception misused later | Confined to the two delete routes; documented inline and in architecture doc |

## Self-review record (planning session)

- Spec coverage: every Session-1 technique the user listed is either implemented (memory LRU, IndexedDB, metadata cache, HTTP validation, key design, viewport loading = existing tiers, chunking = tiles + chunked insert, progressive rendering, dedupe, cancellation extension, prefetch, SWR, workers, transferables, clustering, limits/eviction/invalidation/metrics/recovery) or explicitly deferred with reasons in the decision log (binary formats beyond MVT, WebGL, PMTiles). Sessions 2–4 map 1:1 to the user's bullets, including provenance recording, <500 MB budget, deletion semantics, fallback, e2e, Hangzhou composition, and the validation matrix.
- Placeholder scan: no TBDs; dataset URLs, Overpass QL, key formats, budgets, and thresholds are concrete.
- Type consistency: `cachedTile`/`cachedFeatures`/`warmTile`/`invalidateLayer`/`getMetrics` names match across Tasks 1.5–1.11 and Session 4; `ArtifactPlan`/`execute` match between 2.1 and 2.2; `legendEntries` and StyleSpec fields match 3.1/3.2/3.4.
