> 历史设计/计划记录：保留原始上下文，不作为当前功能清单或执行指令。当前实现请从 [文档目录](../../README.md) 阅读；下文的待办和完成状态仅代表当时记录。

# Graticule — Task-Oriented Information Architecture Redesign Plan

**Date:** 2026-08-01 · **Deliverable:** redesign + modification plan only; no implementation.
**Basis:** repository at `2ffc2cf` — inspected, not assumed. Key structural facts:
the frontend has **no router** (`web/src/App.tsx` renders one screen), the map
engine initializes unconditionally at the root (`MapProvider` constructs `OlMap`
in `useState` at mount, `main.tsx` → `App` → `MapProvider`), `ol` +`ag-grid` ship
in one 1.76 MB chunk, the UI opens `projects[0]` with no switcher, and all
chrome (panels, drawer, status bar) hangs off a single `AppShell` around a
permanent map. Server routes are already resource-oriented
(`projects`, `layers`, `features`, `attributes`, `tiles`, `imports`, `catalog`,
`system`) and multi-project capable — the redesign is almost entirely a
frontend-architecture change.

---

## 1. Target model in one paragraph

Graticule becomes a routed, multi-page platform where **pages are tasks, not
viewports**. A lightweight shell (nav rail + topbar) frames seven task areas:
Dashboard, Projects, Data Catalog, Dataset Details, Map Workspace, Analysis,
Tasks (import/processing), and Exports. The map exists in three strictly
separated presentation modes — stored **thumbnail**, embedded **preview**, and
the full **workspace** — and only the last two ever construct an OpenLayers
map. Everything OpenLayers/ag-grid lives in lazily-loaded route chunks; a user
who checks a dataset's schema or a job's progress never downloads a map engine,
requests a tile, or allocates a canvas.

## 2. Route structure

```
/                                → Dashboard
/projects                        → Projects list
/projects/:projectId             → Project overview (summary, no live map)
/projects/:projectId/map         → Full map workspace        [lazy: ol chunk]
/data                            → Data catalog (all layers + PostGIS tables)
/data/:layerId                   → Dataset details — Overview tab
/data/:layerId/metadata          →   metadata
/data/:layerId/schema            →   attribute schema
/data/:layerId/extent            →   spatial extent (static sketch, no engine)
/data/:layerId/preview           →   embedded map preview    [lazy: ol chunk]
/data/:layerId/style             →   styles
/data/:layerId/versions          →   versions / import history
/data/:layerId/permissions       →   permissions (placeholder boundary today)
/data/:layerId/results           →   related analysis results
/analysis                        → Analysis home (tool list + recent runs)
/analysis/new/:tool              → Tool form (inputs → params → submit)
/analysis/runs/:jobId            → Run status/result (open-on-map link)
/tasks                           → Import & processing tasks list
/tasks/:jobId                    → Task detail (progress, log, produced layers)
/exports                         → Exports & shared results
```

Router: **react-router (library mode, v7)** — data-router APIs for loaders are
optional; the plan needs only `createBrowserRouter`, `Outlet`, `lazy()` route
modules, and search-param state. One new dependency; no framework migration.

**URL-restorable state.** The workspace serializes into the URL:
`/projects/:id/map?view=z/lon/lat&layers=on:<ids>&sel=<layerId>:<fids>&panel=attributes`.
Dataset tabs and task pages are naturally restorable by path. Back/forward
navigates between tasks; nothing meaningful lives only in component state.

## 3. Shared application shell

The current `AppShell` is a *map* shell; the new `PlatformShell` is a *page*
shell, and the map workspace becomes one of its pages (with its own inner
chrome).

```
┌──────────────────────────────────────────────────────────────┐
│ ⊕ Graticule   ▸ Walkthrough ▾    [breadcrumb]      [search]  │ topbar 44px
├────┬─────────────────────────────────────────────────────────┤
│ ⌂  │                                                         │
│ ▤  │                                                         │
│ 🗺 │                <Outlet/> (routed page)                  │
│ ⚙  │                                                         │
│ ⇪  │                                                         │
│ ⤓  │                                                         │
├────┴─────────────────────────────────────────────────────────┤
│ status strip: contextual (only map pages show coordinates)   │
└──────────────────────────────────────────────────────────────┘
 rail: Dashboard / Data / Map / Analysis / Tasks / Exports
```

- **Nav rail** (56px icons, labels on hover / expanded at ≥1400px): Dashboard,
  Data, Map (jumps to `/projects/:current/map`), Analysis, Tasks, Exports.
- **Topbar**: monogram + wordmark → `/`; **project switcher** (fixes the
  hard-wired `projects[0]` in `App.tsx:33`); breadcrumb from the route tree.
- The **status strip is contextual**: mounted by map pages only (it currently
  subscribes to the map — `StatusBar.tsx` — and must not exist without one).
- The map workspace route renders edge-to-edge inside the shell with the rail
  collapsed to icons; it never re-implements the topbar.

## 4. Page responsibilities and wireframes

### 4.1 Dashboard `/`

No map engine. Thumbnails are images (see §6); statistics come from existing
endpoints (`listProjects`, `getProject`, `/system/memory`) plus one new
lightweight `GET /api/v1/system/overview` (counts by kind, storage totals,
recent activity) to avoid N+1 fanout.

```
┌ Dashboard ────────────────────────────────────────────────┐
│ Projects (3)                    Datasets (14)   Tasks (2) │
│ ┌───────────┐ ┌───────────┐    vector 9 · raster 3       │
│ │ [thumb]   │ │ [thumb]   │    tables 2 · 4.2 GB total   │
│ │ Walkthr…  │ │ Benchmarks│    ────────────────────────   │
│ │ 4 layers  │ │ 3 layers  │    Recent tasks               │
│ │ Open map ▸│ │ Open map ▸│    ⏳ import cities.geojson   │
│ └───────────┘ └───────────┘    ✓ buffer roads 250m        │
│ Recent datasets                Recent results             │
│ ▤ Cities · POINT · 4          ▦ roads_buffer_250 ▸ map   │
│ ▤ DEM · raster · COG          …                           │
└───────────────────────────────────────────────────────────┘
```

### 4.2 Projects `/projects`, `/projects/:id`

List: name, layer count, updated, thumbnail, open-map action. Overview: the
project's layer stack (reusing `LayerPanel`'s row anatomy read-only), saved
views, thumbnail, "Open map workspace" as the single primary action. Layer
CRUD that doesn't need geometry (rename/reorder/remove, add-from-catalog)
lives here; geometry-touching work links into the workspace.

### 4.3 Data catalog `/data`

The union the backend already exposes: project layers (`getProject`) and
registered-candidate PostGIS tables (`listPostgisTables` — today buried inside
`AddLayerDialog`'s second tab). Filterable by kind/geometry/project; row
actions: details, open on map, add to project.

```
┌ Data catalog ────────────────────────────────────────────┐
│ [search…] [kind ▾] [project ▾]              [Import ▸]  │
│ NAME          KIND    GEOM    FEATURES  PROJECT   ⋯     │
│ Cities        vector  POINT   4         Walkthr…  ▸     │
│ Bench 1M      vector  POINT   1,000,000 Benchmarks ▸    │
│ DEM           raster  —       —         Walkthr…  ▸     │
│ gis_data.x    table   POLY    12,004    (unregist.) ▸   │
└──────────────────────────────────────────────────────────┘
```

### 4.4 Dataset details `/data/:layerId` (tabbed)

```
┌ Cities — vector · POINT · 4 features ─────────────────────┐
│ Overview | Metadata | Schema | Extent | Preview | Style   │
│          | Versions | Permissions | Results               │
├───────────────────────────────────────────────────────────┤
│ Overview: [thumbnail]  source table gis_data.cities_…     │
│   SRID 4326 · loading tier: small · imported cities.geo…  │
│   [Open on map ▸] [Attribute table ▸] [Export ▸]          │
└───────────────────────────────────────────────────────────┘
```

- **Schema**: `getFields` — name/type/nullable/editable per column.
- **Extent**: drawn as a plain SVG sketch over a graticule — deliberately
  *not* a map engine; the number readout matters more than tiles.
- **Preview**: the one tab that lazy-loads the `ol` chunk — an embedded,
  interaction-limited map (`MapPreview` mode, §6).
- **Style**: `StyleEditor` moves here as its primary home (it edits persisted
  style, not a map session); the workspace keeps a compact style panel.
- **Versions**: import provenance (`sourceFilename`, dates) now; real
  versioning is out of scope.
- **Attribute schema ≠ attribute data**: full data browsing stays in the
  workspace drawer (virtualized path per the performance plan); details shows
  a read-only first-50 sample via `getAttributes`.
- **Permissions**: a placeholder tab defining the boundary (§10) — the
  backend has no auth model yet (documented "Known gap" since the import
  spec); the tab renders ownership/visibility as static "local workspace".

### 4.5 Map workspace `/projects/:id/map`

The current app, panelized. The map is the canvas; every panel is a window.

```
┌ topbar (shell) ──────────────────────────────────────────┐
│ rail│ ┌Layers⇱┐                        ┌Style     ⇱ ✕┐  │
│     │ │ ▣ ▤ ▤ │       MAP              │ renderer…    │  │
│     │ └───────┘                        └──────────────┘  │
│     │ ┌Analysis ✕┐              ┌Properties (identify)┐  │
│     │ │ buffer…  │              │ name Beijing …      │  │
│     │ └──────────┘              └─────────────────────┘  │
│     │ ┌Attributes ▁▁ drawer ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁⇕ ✕┐  │
│     │ └──────────────────────────────────────────────┘  │
│ coords · zoom · CRS · [panel toggles] [Save layout ▾]    │
└──────────────────────────────────────────────────────────┘
```

Panels (all collapsible + hideable + resizable; floatable = "detached" with
persisted x/y): **Layers, Style (compact), Properties/identify, Analysis,
Attribute table (drawer), Time controls (future), Task results.** Layout state
(§7) is saved/restored per user per project; `[Save layout]` names presets.

### 4.6 Analysis `/analysis…`

The §6-workflow of the performance plan gets its own pages: pick tool →
configure (inputs from catalog pickers, parameters validated client+server) →
submit as background job (the jobs table from performance-plan Phase 3) →
watch progress in `/analysis/runs/:jobId` → "Open result on map" deep-links
into the workspace with the produced layer toggled on.

### 4.7 Tasks `/tasks…`

Import and processing jobs — the async pipeline's UI. The staged import
preview (`ImportPreview`) stays a modal *within its launching context*
(catalog or workspace); completed/failed/running imports are rows here with
progress, source filename, produced layer links, and error envelopes.

### 4.8 Exports `/exports`

Thin v1: PMTiles/GeoJSON export jobs (performance-plan Phase 6 ties in),
download links, "shared results" as named, URL-addressable map states (§7's
saved views made shareable). No new sharing backend is invented yet.

## 5. Component disposition (retain / split / replace / move / merge / remove)

| Component (current) | Disposition |
|---|---|
| `AppShell.tsx` | **Split**: topbar/monogram → `PlatformShell`; panel/drawer chrome → `WorkspaceShell` (map page only) |
| `App.tsx` | **Replace** with router root; its query/memory wiring moves into `WorkspacePage` |
| `MapProvider/MapCanvas` | **Move** into the lazy map chunk; add `dispose()` on unmount (§6) |
| `StatusBar` | **Retain**, mounted only by map pages |
| `IdentifyPopup` | **Retain** in workspace; becomes the "Properties" panel's floating twin |
| `LayerPanel` | **Split**: row anatomy reused read-only on Project overview; interactive version = workspace Layers panel |
| `AddLayerDialog` | **Split**: PostGIS-table tab → Data catalog "register" flow; file upload → Import entry in catalog + workspace |
| `ImportPreview` + draft suite | **Retain** as modal, launchable from catalog and workspace; its jobs surface in `/tasks` |
| `AttributeTable` | **Split**: sample view (dataset Schema/Overview) vs full drawer in workspace (virtualized per perf plan) |
| `StyleEditor` | **Move** primary home to dataset Style tab; compact workspace panel reuses its internals |
| `MemoryPanel` | **Move** to workspace-only diagnostic panel (hidden by default) + numbers on Dashboard via `/system/memory` |
| `EditToolbar` | **Retain**, workspace-only |
| `layerStore` (zustand) | **Split**: selection/session → `workspaceStore` (map-scoped, reset on leave); projectId → route param (**remove** from store) |
| `queryClient` cache | **Retain** as the cross-page data spine |
| Graticule theme/tokens (`index.css`) | **Retain** wholesale; new pages compose existing primitives (`eyebrow`, `btn--primary`, `icon-btn`, mono data) |
| `loadingTiers`, `featureLoader`, `syncLayers`, memory manager | **Retain** unchanged inside the map chunk |
| Truncation warning in `LayerPanel` | **Merge** into workspace Layers panel row state |
| Nothing is **removed** outright; removals are all merges above | |

## 6. Map lifecycle and the three presentation modes

| Mode | Engine | Where | Contract |
|---|---|---|---|
| **Thumbnail** | none | dashboard, projects, dataset overview | An `<img>`. Captured on workspace exit (`map.once('rendercomplete')` → canvas → `POST /api/v1/projects/:id/thumbnail`, stored beside rasters in `var/data/thumbnails`) with a graceful fallback: extent rectangle + graticule SVG when no capture exists. Never fetches tiles. |
| **Preview** | lazy `ol` | dataset Preview tab | One `MapPreview` component: own small `OlMap`, this layer only, interactions limited (zoom/pan), no editing/identify chrome — the pattern `PreviewMap.tsx` (import feature) already proves, generalized. Disposed on tab leave. |
| **Workspace** | lazy `ol` | `/projects/:id/map` | Full `MapProvider` + panels. Constructed on route entry, **disposed on route exit**: `map.setTarget(undefined)`, `map.dispose()`, `LayerMemoryManager` evict-all + unregister, abort in-flight loaders (the AbortController plumbing added in `2ffc2cf` makes this possible), `queryClient` keeps only metadata queries. |

**Lazy boundaries** (fixes the 1.76 MB chunk): route-level `React.lazy` for
`WorkspacePage`, `MapPreview`, and the attribute-grid module; `ol/*` and
`ag-grid-*` must appear only in those chunks (enforced by acceptance §9.3).
The import preview modal (which embeds `PreviewMap` + `DraftGrid`) becomes a
lazy import at open time.

## 7. Workspace state, saved layouts, saved views

```ts
// workspaceStore (zustand) — map-scoped, created per workspace mount
interface WorkspaceState {
  selection: { layerId: string | null; featureIds: string[] }   // from layerStore
  truncatedLayerIds: string[]
  panels: Record<PanelId, {
    open: boolean; detached: boolean;
    size: { w?: number; h?: number }; position?: { x: number; y: number }
  }>
  layoutName: string | null
}
```

- **Persistence tiers**: (1) URL — view/visible-layers/selection/primary panel
  (shareable, restorable); (2) `localStorage` per `(userless-local, projectId)`
  — panel layout, named presets; (3) server (future, one JSONB column
  `gis.project.workspace_layouts`) when auth exists. The plan targets 1+2;
  the model is shaped so 3 is a storage swap, not a redesign.
- **Saved views** = named `{view, visibleLayers, selection}` snapshots stored
  with the layout presets; "shared results" (§4.8) are saved views rendered
  as links.
- Cross-page flow: pages communicate through the TanStack Query cache and
  route params only. No global store carries page-to-page state; navigating
  catalog → dataset → workspace passes ids in the URL, and the workspace
  reads the same cached queries the catalog already warmed.

## 8. Loading, empty, permission, and responsive behavior

- **Loading**: route-level suspense fallbacks use the existing panel skeleton
  language (eyebrow + hairline + muted line placeholders); the workspace
  shows the shell immediately and streams the map in (`Reading…` pattern from
  `ImportPreview` generalizes).
- **Empty states**: every list page states what belongs there and offers its
  primary action (catalog → "Import a file or register a table"; analysis →
  "Choose a tool"; tasks → "No running tasks"; exports → "Nothing exported
  yet"), following the `layer-panel__empty` idiom.
- **Permissions**: the boundary is *defined* now, enforced later — routes and
  actions declare a required capability (`view`, `edit-data`, `manage-project`,
  `run-analysis`); a single `can()` helper returns `true` today (local
  single-user), giving the auth integration a seam instead of a rewrite.
  This honors the standing "no fake identity" constraint: no user objects,
  no always-null owner fields.
- **Responsive**: pages are documents — they reflow to one column at <920px
  (catalog table → cards, dashboard grid → stack). The workspace keeps its
  ≥920px floating-panel model and below that collapses to map + drawer with
  panels as full-screen sheets. Rail collapses to icons <1160px, to a bottom
  bar <720px.

## 9. Acceptance criteria (measurable)

1. **Navigation clarity**: any of the eight page types reachable in ≤2
   interactions from any other; breadcrumb always equals route truth; browser
   back never lands on a broken intermediate.
2. **Map initialization time**: non-map pages perform **zero** map work —
   verified: no `ol` module evaluated (chunk never requested), zero
   `/tiles/` requests, zero canvas elements. Workspace map first-render ≤1.5s
   after chunk load on the Walkthrough project (Playwright-timed).
3. **Lazy loading**: main entry chunk ≤300 KB gzipped; `ol` and `ag-grid`
   appear only in lazy chunks (assert via build manifest in CI).
4. **Memory release**: after leaving the workspace, layer-manager bytes = 0,
   no OL `postrender` listeners firing, and `performance.memory` heap
   returns to within 15% of its pre-workspace baseline after GC.
5. **Panel behavior**: every non-essential panel individually hideable;
   layout survives reload (localStorage) and restore-preset round-trips;
   detached panels persist position.
6. **URL restore**: pasting a workspace URL reproduces project, view (±1px
   center drift), visible layers, selection, and open primary panel; dataset
   tab URLs deep-link correctly.
7. **Large-dataset usability**: catalog and dataset details for the 1M bench
   layer open with p95 ≤500 ms interactions (no full counts, no tile loads);
   workspace on it sustains ≥30 FPS pan (ties to the performance plan's
   criteria and bench harness).
8. **Responsive**: no horizontal document scroll at 768/920/1160/1440px on
   any page; workspace usable (map + drawer + sheet panels) at 768px.

## 10. Phased migration (each phase ships green and reversible)

**R0 — Router under the current app** *(enabler, no visible change)*
Objective: routing exists; nothing moves. Add react-router; mount the entire
current `App` at `/projects/:projectId/map`; `/` redirects to the first
project's map (today's behavior, now explicit); topbar gains the project
switcher (removes `projects[0]` hard-wiring). Affected: `main.tsx`, `App.tsx`,
new `router.tsx`, `AppShell` topbar. Risks: none material — all 250 frontend
tests keep passing because components are untouched. Validation: suite green;
switcher round-trip test.

**R1 — Platform shell + read-only pages**
Dashboard, Projects, Data catalog as compositions of existing queries + the
new `/system/overview` endpoint; nav rail; thumbnails ship with the fallback
sketch first (capture endpoint comes in R3). Dependencies: R0. Risks: none to
existing flows (additive routes). Validation: acceptance 1; zero `/tiles/`
requests asserted on the three new pages.

**R2 — Dataset details + lazy seams**
Tabbed details; `StyleEditor` moves (workspace keeps compact panel);
`MapPreview` extracted from `PreviewMap`; route-level code splitting lands
(`ol`/`ag-grid` out of the main chunk). Dependencies: R1. Risks: chunk-split
regressions (worker URL pattern already proven under Vite); style-edit
round-trip must stay identical — covered by existing StyleEditor tests moved
with it. Validation: acceptance 3; bundle manifest check in CI.

**R3 — Workspace panelization + layouts + lifecycle**
`WorkspaceShell` with configurable panels, layout persistence, URL state,
map disposal on exit, thumbnail capture on exit. Dependencies: R2. Risks:
StrictMode double-mount vs `dispose()` (the codebase's known bug class —
regression-test it the way `useImportDraft` was); editing interactions during
panel detach. Validation: acceptance 2, 4, 5, 6.

**R4 — Analysis, Tasks, Exports**
Pages over the jobs backend (performance-plan Phase 3 is the dependency;
until it lands, Tasks lists synchronous import history from layer metadata
and Analysis ships behind a "requires jobs" flag). Risks: contained — new
routes only. Validation: acceptance 1 + job-flow E2E (submit → progress →
open-on-map).

**R5 — Responsive + hardening + full acceptance run**
Breakpoint work, empty/loading polish, the complete acceptance battery on the
bench datasets, and removal of any temporarily-duplicated chrome. Validation:
acceptance 7, 8; full before/after report.

Preservation guarantees across all phases: no backend contract changes except
additive endpoints (`/system/overview`, thumbnail capture); import, editing,
styling, identify, memory management and the adaptive loading tiers keep
their exact current behavior inside the workspace; uploaded data untouched;
every phase keeps both test suites green.

---

*Stop point: plan only. Implementation begins on explicit go-ahead, phase by
phase.*
