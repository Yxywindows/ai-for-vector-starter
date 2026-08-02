# GIS Platform

A standalone web GIS platform: a PostGIS-backed FastAPI service for storing,
importing, and serving vector and raster geospatial data, paired with an
OpenLayers/React frontend for browsing a layer tree, styling layers, viewing
attribute tables, and editing features — the same workflow a desktop tool
like QGIS offers, delivered over HTTP so any browser can use it.

## Quickstart

```bash
# 1. PostGIS (port 5401) + pgAdmin (port 5051)
docker compose up -d postgres

# 2. Test database (the only manual bootstrap step — Alembic's migration
#    connection handles its own schema/search_path setup automatically)
docker compose exec postgres psql -U gis -d postgres -c "CREATE DATABASE gis_platform_test OWNER gis;"

# 3. Backend API (port 1316)
cd backend
python -m venv .venv
.venv/Scripts/activate          # Windows;  source .venv/bin/activate on POSIX
pip install -e ".[dev]"
alembic upgrade head
uvicorn app.main:app --reload --port 1316

# 4. Web frontend (port 1317; proxies /api to the backend on 1316)
cd web
npm install
npm run dev
```

With the backend running, `curl http://localhost:1316/api/v1/health` returns
`{"status":"ok","environment":"development"}` (also reachable unversioned at
`/health` for container/load-balancer probes), and
`http://localhost:1316/docs` renders the interactive OpenAPI page.

`alembic upgrade head` works unattended against a genuinely fresh database —
no manual `CREATE SCHEMA` and no role-level `search_path` change required.
`migrations/env.py` creates the `gis` schema itself before configuring the
migration context (see `docs/02-spatial-data-model.md` for why that has to
happen before Alembic's own bookkeeping table can be created), and gives its
own connection an explicit `search_path` instead of depending on server-side
role state — this project's database user happens to be named `gis`, same as
the metadata schema, which would otherwise make Postgres treat `gis` as that
connection's default schema and silently corrupt `alembic
revision --autogenerate`'s diff. Both fixes are scoped to the migration
connection only; they never touch role configuration, so raw SQL run by the
import pipeline (Tasks 5, 6, 9) over its own connections is unaffected.

Run the backend test suite (Task 2 onward) against the dedicated test
database, never the dev one:

```bash
cd backend
export GIS_DATABASE_URL=postgresql+asyncpg://gis:gis@localhost:5401/gis_platform_test
pytest
```

`pyproject.toml` pins dependency floors only; for a reproducible install run
`pip install -r requirements.lock.txt && pip install -e . --no-deps` instead
of `pip install -e ".[dev]"` to get the exact versions this module was built
and tested against — regenerate the lock file after changing dependencies
with `pip freeze | grep -v -E "^-e |gis[_-]platform[_-]backend" > requirements.lock.txt`
(with the venv active and `.[dev]` installed).

## Directory structure

```
backend/                             # FastAPI + SQLAlchemy + PostGIS
├── app/
│   ├── core/                        # Settings, logging, error envelope
│   ├── db/                          # engine/session, identifier quoting, sync engine
│   ├── models/                      # Project, Layer ORM
│   ├── schemas/                     # wire contracts: LayerSource, StyleSpec, …
│   ├── repositories/                # SQL: features, attributes, tiles, catalog
│   ├── services/                    # import, editing, tiles, raster pool, system
│   └── api/v1/routes/               # projects, layers, features, tiles, system
├── migrations/                      # Alembic (async env)
└── tests/                           # pytest against gis_platform_test

web/                                 # React + OpenLayers + TanStack Query + zustand
└── src/
    ├── api/                         # typed API layer mirroring the wire contracts
    ├── app/                         # shell layout, query client
    ├── map/                         # MapProvider, layer factory, sync, memory manager
    ├── features/
    │   ├── layers/                  # layer panel, add-layer dialog
    │   ├── attributes/              # attribute table with inline editing
    │   ├── styling/                 # style editor, colour ramps
    │   ├── editing/                 # draw/modify/delete with a buffered edit session
    │   └── memory/                  # browser + server memory panel
    └── state/                       # UI-only zustand store

docs/
├── learning/                        # Nine numbered architecture chapters
└── superpowers/                     # Claude Code skills and workflows
```

## Documentation

Nine numbered chapters in [`docs/learning/`](docs/learning/), written to teach the concepts the
code embodies, in reading order:

| Doc | Covers |
|---|---|
| [`01-architecture-overview.md`](docs/learning/01-architecture-overview.md) | The three tiers, the layered backend, the error envelope, configuration. |
| [`02-spatial-data-model.md`](docs/learning/02-spatial-data-model.md) | The `gis`/`gis_data` schema split, the `layer` table, migrations. |
| [`03-postgis-and-dynamic-sql.md`](docs/learning/03-postgis-and-dynamic-sql.md) | Safe dynamic SQL over user-named tables; catalog introspection. |
| [`04-feature-streaming.md`](docs/learning/04-feature-streaming.md) | BBOX windowing, reprojection that keeps indexes usable, truncation honesty. |
| [`05-vector-tiles-mvt.md`](docs/learning/05-vector-tiles-mvt.md) | `ST_AsMVT` tiles, ETags, empty-tile 204s. |
| [`06-raster-tiling-and-cog.md`](docs/learning/06-raster-tiling-and-cog.md) | GeoTIFF import, COG conversion, rio-tiler XYZ tiles and statistics. |
| [`07-memory-management.md`](docs/learning/07-memory-management.md) | All three memory layers: server handle pool, response caps, browser budget. |
| [`08-styling-and-renderers.md`](docs/learning/08-styling-and-renderers.md) | The engine-neutral `StyleSpec` and its OpenLayers compiler. |
| [`09-editing-and-transactions.md`](docs/learning/09-editing-and-transactions.md) | Write-path transactions, geometry validation, the client edit buffer. |

## Quality gates

Backend — run from `backend/` with the venv active:

```bash
ruff check . && ruff format --check . && mypy app && pytest
```

Web — run from `web/`:

```bash
npm run lint && npm run typecheck && npm run test -- --run
```

All must pass before any change to this module is considered done.

Benchmarks: see `docs/benchmarks.md`
