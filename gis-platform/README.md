# GIS Platform

A standalone web GIS platform: a PostGIS-backed FastAPI service for storing,
importing, and serving vector and raster geospatial data, paired with an
OpenLayers/React frontend for browsing a layer tree, styling layers, viewing
attribute tables, and editing features — the same workflow a desktop tool
like QGIS offers, delivered over HTTP so any browser can use it.

## Quickstart

```bash
# 1. PostGIS (port 5401) — added when the database layer lands
docker compose up -d postgres

# 2. Backend API (port 1316)
cd gis-platform/backend
python -m venv .venv
.venv/Scripts/activate          # Windows;  source .venv/bin/activate on POSIX
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 1316

# 3. Web frontend (port 1317) — added when the frontend module lands
cd gis-platform/frontend
npm install
npm run dev -- --port 1317
```

With the backend running, `curl http://localhost:1316/api/v1/health` returns
`{"status":"ok","environment":"development"}` (also reachable unversioned at
`/health` for container/load-balancer probes), and
`http://localhost:1316/docs` renders the interactive OpenAPI page.

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
├── backend/
│   ├── pyproject.toml
│   ├── requirements.lock.txt        # exact versions frozen from pip install -e ".[dev]"
│   ├── .env.example
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py                  # create_app() and module-level app
│   │   ├── core/
│   │   │   ├── __init__.py
│   │   │   ├── config.py            # Settings, get_settings()
│   │   │   ├── logging.py           # configure_logging()
│   │   │   └── errors.py            # AppError hierarchy, error envelope
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
│       ├── test_errors.py
│       └── test_health.py
└── docs/
    └── 01-architecture-overview.md
```

## Documentation

| Doc                                                            | Covers |
|------------------------------------------------------------------|--------|
| [`docs/01-architecture-overview.md`](docs/01-architecture-overview.md) | The three tiers, the layered backend, the error envelope, configuration, and how to run the API. |

## Quality gate

Run from `gis-platform/backend/`, with the virtual environment activated:

```bash
ruff check . && ruff format --check . && mypy app && pytest
```

All four must pass before any change to this module is considered done.
