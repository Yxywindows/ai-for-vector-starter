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
cd gis-platform/backend
python -m venv .venv
.venv/Scripts/activate          # Windows;  source .venv/bin/activate on POSIX
pip install -e ".[dev]"
alembic upgrade head
uvicorn app.main:app --reload --port 1316

# 4. Web frontend (port 1317) — added when the frontend module lands
cd gis-platform/frontend
npm install
npm run dev -- --port 1317
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
cd gis-platform/backend
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
gis-platform/
├── README.md
├── docker-compose.yml                # PostGIS 16-3.4 (5401) + pgAdmin (5051)
├── .env.example                      # docker-compose POSTGRES_* vars
├── backend/
│   ├── pyproject.toml
│   ├── requirements.lock.txt        # exact versions frozen from pip install -e ".[dev]"
│   ├── .env.example
│   ├── alembic.ini
│   ├── migrations/
│   │   ├── env.py                   # reads Settings.database_url; async engine
│   │   ├── script.py.mako
│   │   └── versions/
│   │       └── 0001_initial_schema.py
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py                  # create_app() and module-level app
│   │   ├── core/
│   │   │   ├── __init__.py
│   │   │   ├── config.py            # Settings, get_settings()
│   │   │   ├── logging.py           # configure_logging()
│   │   │   └── errors.py            # AppError hierarchy, error envelope
│   │   ├── db/
│   │   │   ├── __init__.py
│   │   │   ├── base.py              # Base, naming convention
│   │   │   └── session.py           # engine, SessionLocal, get_session()
│   │   ├── models/
│   │   │   ├── __init__.py
│   │   │   ├── project.py           # Project
│   │   │   └── layer.py             # Layer
│   │   └── api/
│   │       ├── __init__.py
│   │       └── v1/
│   │           ├── __init__.py
│   │           ├── router.py        # api_router — every route registers here
│   │           └── routes/
│   │               ├── __init__.py
│   │               └── health.py
│   └── tests/
│       ├── __init__.py
│       ├── conftest.py              # db_session, client fixtures
│       ├── test_alembic_env.py      # include_object autogenerate-scope tests
│       ├── test_errors.py
│       ├── test_health.py
│       └── test_models.py
└── docs/
    ├── 01-architecture-overview.md
    └── 02-spatial-data-model.md
```

## Documentation

| Doc                                                            | Covers |
|------------------------------------------------------------------|--------|
| [`docs/01-architecture-overview.md`](docs/01-architecture-overview.md) | The three tiers, the layered backend, the error envelope, configuration, and how to run the API. |
| [`docs/02-spatial-data-model.md`](docs/02-spatial-data-model.md) | The `gis`/`gis_data`/user-schema split, the `layer` table, cascade/uniqueness constraints, test transaction isolation, and the Alembic migration workflow. |

## Quality gate

Run from `gis-platform/backend/`, with the virtual environment activated:

```bash
ruff check . && ruff format --check . && mypy app && pytest
```

All four must pass before any change to this module is considered done.
