# Web GIS Platform (QGIS-like) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-contained, production-shaped web GIS platform prototype — modelled on QGIS's desktop concepts (layer tree, attribute table, symbology, editing session) but delivered as a PostGIS-backed FastAPI service plus an OpenLayers/React client.

**Architecture:** A single `gis-platform/` product with three tiers. **PostGIS** is the store of truth: the platform owns a `gis` schema (projects, layers, styles) and an ingest schema `gis_data` (imported vector tables); externally-owned PostGIS tables can be registered in place. The **FastAPI backend** is layered `routes → services → repositories → models/schemas`, uses async SQLAlchemy 2.0 for its own schema and validated-identifier raw SQL for dynamic geospatial queries over arbitrary user tables (`ST_AsMVT`, `ST_AsGeoJSON`, bbox reads, edits). Raster is served as XYZ PNG tiles by rio-tiler over COGs, through an LRU pool of open dataset handles. The **React/TypeScript client** renders everything through one OpenLayers `Map`, driving raster, vector and vector-tile layers from a single `LayerRead` record, with a client-side byte-budget memory manager that accounts for every tile and feature payload and evicts LRU.

Memory management is deliberately three-layered, matching the three places a GIS actually leaks: server dataset handles (LRU pool with idle TTL), the wire (bbox-windowed feature streaming with hard caps and an explicit `truncated` flag), and the browser (per-layer byte accounting with pinning and LRU eviction).

**Tech Stack:** Python 3.12 · FastAPI · SQLAlchemy 2.0 (async, asyncpg) · Alembic · Pydantic v2 / pydantic-settings · PostgreSQL 16 + PostGIS 3.4 · rasterio / rio-tiler / rio-cogeo · geopandas / pyogrio / shapely · pytest + pytest-asyncio + httpx · ruff + mypy — React 19 · TypeScript 5.7 (strict) · Vite 8 · OpenLayers 10 · Zustand 5 · TanStack Query 5 · Vitest + Testing Library · ESLint flat config + Prettier · Docker Compose.

## Global Constraints

These apply to **every** task. Do not restate them per task; do not violate them.

- **Module root:** everything lives under `gis-platform/`. It is standalone — it does **not** import from, extend, or restructure `api-learning-lab/`, `backend/`, or `frontend/`. Those directories are never modified.
- **Ports:** API `1316`, web dev server `1317`, PostGIS `5401`, pgAdmin `5051`. Never reuse `1314`, `1315`, or `5400` (already taken by existing modules).
- **Database:** PostgreSQL `16`, PostGIS `3.4`, image `postgis/postgis:16-3.4`. Database `gis_platform`, test database `gis_platform_test`, user `gis`, password `gis`.
- **Schemas:** `gis` = platform-owned metadata. `gis_data` = tables created by file import. Externally-owned tables stay in their own schema and are never written to by DDL.
- **API prefix:** all endpoints are under `/api/v1`. No unversioned routes except `/health`.
- **JSON casing:** the wire is `camelCase`, Python is `snake_case`. Every request/response model inherits `APIModel` (`alias_generator=to_camel`, `populate_by_name=True`). TypeScript types mirror the camelCase wire shape exactly.
- **Error envelope:** every non-2xx response from application code is `{"error": {"code": str, "message": str, "details": object | null}}`. `code` is a stable snake_case string.
- **CRS:** the wire is always **EPSG:4326** (GeoJSON, bbox params, extents). Vector tiles are **EPSG:3857**. Storage SRID is whatever the table declares; conversion happens in SQL at the boundary. Never assume 4326 storage.
- **Dynamic SQL:** a SQL identifier that came from user input may only reach a query after passing `validate_identifier()` **and** being confirmed to exist in the catalog. Values are always bind parameters. There are no exceptions to this rule.
- **Transactions — one request, one transaction, committed at the boundary (revised during Task 5):** services **never** call `session.commit()`. The request-scoped unit of work in `app/db/session.py` commits once on success and rolls back on exception, and every route depends on it through the shared alias `SessionDep = Annotated[AsyncSession, Depends(get_session, scope="function")]`. The `scope="function"` argument is load-bearing, not decoration: without it FastAPI tears the dependency down *after* the response is sent, so a failing commit is swallowed and the client receives a `2xx` describing data that was rolled back. Always take `session: SessionDep` in a route; never `Depends(get_session)` directly. Services use `flush()` / `refresh()` when they need generated values. This replaces the per-service commits shown in some later task code blocks — if a code block in this plan calls `await session.commit()` in a service, that call is obsolete; drop it and let the request boundary commit.
- **Blocking I/O:** rasterio, geopandas, and pyogrio calls are blocking and must run via `anyio.to_thread.run_sync`. Never call them directly on the event loop.
- **PROJ data (verified hazard on this machine):** a system-wide `PROJ_LIB` left behind by another GDAL/PROJ install makes **every rasterio CRS lookup fail** with `proj.db contains DATABASE.LAYOUT.VERSION.MINOR = 2 whereas a number >= 6 is expected`. Measured blast radius: `rasterio` and `rio-tiler` break; `pyproj`/`geopandas` are unaffected (they prefer their own bundled data). The remedy must run **before rasterio is first imported** — setting the variable afterwards does not help, because PROJ has already built its context. Task 7 installs the shim (`app/core/geo_env.py`, invoked from `app/__init__.py`); nothing before Task 7 imports rasterio, so earlier tasks are unaffected.
- **Python version floors** (`pyproject.toml` uses floors; exact versions are frozen into `requirements.lock.txt` after install): `fastapi>=0.139`, `uvicorn[standard]>=0.51`, `pydantic>=2.13`, `pydantic-settings>=2.7`, `sqlalchemy>=2.0.36`, `alembic>=1.14`, `asyncpg>=0.30`, `psycopg[binary]>=3.2`, `geoalchemy2>=0.16`, `geopandas>=1.0`, `pyogrio>=0.10`, `shapely>=2.0`, `rasterio>=1.4`, `rio-tiler>=7.0`, `rio-cogeo>=5.3`, `psutil>=6.1`, `python-multipart>=0.0.20`. Dev: `pytest>=8.3`, `pytest-asyncio>=0.25`, `httpx>=0.28`, `ruff>=0.8`, `mypy>=1.14`.
- **Node version floors** (`package.json`): `ol@^10.3.0`, `react@^19.2.0`, `react-dom@^19.2.0`, `zustand@^5.0.0`, `@tanstack/react-query@^5.62.0`. Dev: `typescript@^5.7.0`, `vite@^8.1.0`, `@vitejs/plugin-react@^6.0.0`, `vitest@^3.0.0`, `jsdom@^25.0.0`, `@testing-library/react@^16.1.0`, `@testing-library/user-event@^14.5.0`, `eslint@^9.17.0`, `typescript-eslint@^8.18.0`, `prettier@^3.4.0`.
- **Test database:** the backend suite runs against `gis_platform_test`, never the dev database. From Task 2 onward **every** `pytest` invocation is prefixed with the test URL. Define it once and reuse it verbatim:
  ```bash
  export GIS_DATABASE_URL=postgresql+asyncpg://gis:gis@localhost:5401/gis_platform_test
  ```
  Task text writes bare `pytest ...`; that always means "with `GIS_DATABASE_URL` exported as above". `tests/conftest.py` therefore reads `get_settings().database_url` directly and performs no string rewriting — if the variable is unset, the suite must fail loudly rather than silently touch the dev database.
- **Quality gate — every task must end green:** `ruff check . && ruff format --check . && mypy app && pytest` (backend tasks, with `GIS_DATABASE_URL` exported) or `npm run lint && npm run typecheck && npm run test -- --run` (frontend tasks). A task is not done if any of these fail.
- **Commit style:** Conventional Commits (`feat:`, `test:`, `fix:`, `docs:`, `chore:`). Commit at the end of every task, and at the intermediate commit points the task specifies.
- **Docs:** learning-oriented Markdown lives in `gis-platform/docs/`, numbered `NN-topic.md`. A doc is written in the same task as the code it explains, and must quote the real code/SQL that shipped — never a paraphrase.
- **Working directory:** backend commands run from `gis-platform/backend/`; frontend commands run from `gis-platform/web/`. Docker commands run from `gis-platform/`.

---

## File Structure

```
gis-platform/
├── docker-compose.yml                 postgis + pgadmin + api + web
├── .env.example
├── README.md
├── docs/                              learning-oriented markdown (see per-task doc steps)
│   ├── 01-architecture-overview.md
│   ├── 02-spatial-data-model.md
│   ├── 03-postgis-and-dynamic-sql.md
│   ├── 04-feature-streaming.md
│   ├── 05-vector-tiles-mvt.md
│   ├── 06-raster-tiling-and-cog.md
│   ├── 07-memory-management.md
│   ├── 08-styling-and-renderers.md
│   └── 09-editing-and-transactions.md
├── backend/
│   ├── pyproject.toml                 deps, ruff, mypy, pytest config
│   ├── Dockerfile
│   ├── alembic.ini
│   ├── migrations/                    alembic env + versions
│   ├── app/
│   │   ├── main.py                    app factory, middleware, lifespan
│   │   ├── core/
│   │   │   ├── config.py              Settings (pydantic-settings)
│   │   │   ├── logging.py             dictConfig + request-id filter
│   │   │   └── errors.py              AppError hierarchy + handlers
│   │   ├── db/
│   │   │   ├── base.py                DeclarativeBase + naming convention
│   │   │   ├── session.py             async engine, sessionmaker, get_session
│   │   │   ├── sync_engine.py         sync engine for geopandas bulk import
│   │   │   └── identifiers.py         validate_identifier / quote / qualified
│   │   ├── models/                    SQLAlchemy: project.py, layer.py
│   │   ├── schemas/                   Pydantic: base, source, style, layer,
│   │   │                              project, feature, field, tile, system
│   │   ├── repositories/              layer_repo, project_repo, catalog_repo,
│   │   │                              feature_repo, tile_repo
│   │   ├── services/                  layer_svc, project_svc, catalog_svc,
│   │   │                              vector_import_svc, raster_import_svc,
│   │   │                              feature_svc, tile_svc, raster_tile_svc,
│   │   │                              system_svc
│   │   ├── resources/
│   │   │   └── dataset_pool.py        generic async LRU handle pool
│   │   └── api/v1/
│   │       ├── router.py              aggregates route modules
│   │       └── routes/                health, projects, layers, catalog,
│   │                                  imports, features, tiles, system
│   └── tests/                         mirrors app/ layout
└── web/
    ├── package.json  vite.config.ts  tsconfig.json  eslint.config.js
    ├── Dockerfile
    └── src/
        ├── main.tsx  App.tsx
        ├── api/                       client.ts, types.ts, layers.ts,
        │                              features.ts, catalog.ts, system.ts
        ├── app/                       AppShell.tsx, queryClient.ts
        ├── map/
        │   ├── MapProvider.tsx        holds the single ol/Map
        │   ├── MapCanvas.tsx
        │   ├── layerFactory.ts        LayerRead -> ol layer
        │   ├── styleCompiler.ts       StyleSpec -> ol style function (pure)
        │   ├── featureLoader.ts       bbox loading strategy + accounting
        │   └── memory/
        │       ├── LayerMemoryManager.ts   pure LRU byte budget
        │       └── instrumentation.ts      tileLoadFunction wrappers
        ├── state/layerStore.ts        zustand: order, visibility, selection
        └── features/
            ├── layers/LayerPanel.tsx  + AddLayerDialog.tsx
            ├── attributes/AttributeTable.tsx
            ├── styling/StyleEditor.tsx + ramps.ts
            ├── editing/EditToolbar.tsx + editSession.ts
            └── memory/MemoryPanel.tsx
```

**Phases.** Tasks 1–4 = foundation + layer registry. 5–7 = data ingress. 8–12 = data egress + memory. 13 = editing. 14–16 = client foundation. 17–21 = client features. Each phase ends on a working, demoable system.

---

## Task 1: Backend Skeleton, Config, Logging, Error Envelope

**Files:**
- Create: `gis-platform/backend/pyproject.toml`
- Create: `gis-platform/backend/app/__init__.py`
- Create: `gis-platform/backend/app/core/__init__.py`
- Create: `gis-platform/backend/app/core/config.py`
- Create: `gis-platform/backend/app/core/logging.py`
- Create: `gis-platform/backend/app/core/errors.py`
- Create: `gis-platform/backend/app/api/__init__.py`, `app/api/v1/__init__.py`, `app/api/v1/routes/__init__.py`
- Create: `gis-platform/backend/app/api/v1/router.py`
- Create: `gis-platform/backend/app/api/v1/routes/health.py`
- Create: `gis-platform/backend/app/main.py`
- Create: `gis-platform/backend/.env.example`
- Create: `gis-platform/backend/tests/__init__.py`
- Test: `gis-platform/backend/tests/test_errors.py`, `gis-platform/backend/tests/test_health.py`
- Create: `gis-platform/docs/01-architecture-overview.md`
- Create: `gis-platform/README.md`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `app.core.config.Settings` (pydantic-settings, env prefix `GIS_`) and `get_settings() -> Settings` (lru_cached).
  - `app.core.errors.AppError(message: str, *, details: dict | None = None)` with class attrs `status_code: int`, `code: str`; subclasses `NotFoundError` (404 `not_found`), `ConflictError` (409 `conflict`), `InvalidRequestError` (422 `invalid_request`), `UnsupportedFormatError` (415 `unsupported_format`), `PayloadTooLargeError` (413 `payload_too_large`), `UpstreamDataError` (502 `upstream_data_error`).
  - `app.core.errors.register_exception_handlers(app: FastAPI) -> None`.
  - `app.main.create_app() -> FastAPI` and module-level `app`.
  - `app.api.v1.router.api_router: APIRouter` — every later task registers its routes here.

- [ ] **Step 1: Create the package layout and `pyproject.toml`**

```bash
mkdir -p gis-platform/backend/app/core gis-platform/backend/app/api/v1/routes gis-platform/backend/tests gis-platform/docs
touch gis-platform/backend/app/__init__.py gis-platform/backend/app/core/__init__.py \
      gis-platform/backend/app/api/__init__.py gis-platform/backend/app/api/v1/__init__.py \
      gis-platform/backend/app/api/v1/routes/__init__.py gis-platform/backend/tests/__init__.py
```

`gis-platform/backend/pyproject.toml`:

```toml
[project]
name = "gis-platform-backend"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.139",
    "uvicorn[standard]>=0.51",
    "pydantic>=2.13",
    "pydantic-settings>=2.7",
    "sqlalchemy>=2.0.36",
    "alembic>=1.14",
    "asyncpg>=0.30",
    "psycopg[binary]>=3.2",
    "geoalchemy2>=0.16",
    "geopandas>=1.0",
    "pyogrio>=0.10",
    "shapely>=2.0",
    "rasterio>=1.4",
    "rio-tiler>=7.0",
    "rio-cogeo>=5.3",
    "psutil>=6.1",
    "python-multipart>=0.0.20",
    "anyio>=4.7",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.3",
    "pytest-asyncio>=0.25",
    "httpx>=0.28",
    "ruff>=0.8",
    "mypy>=1.14",
]

[build-system]
requires = ["setuptools>=75"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
include = ["app*"]

[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "N", "UP", "B", "A", "C4", "SIM", "RUF"]

[tool.mypy]
python_version = "3.12"
strict = true
plugins = ["pydantic.mypy"]
warn_unused_ignores = true

[[tool.mypy.overrides]]
module = ["geopandas.*", "pyogrio.*", "rasterio.*", "rio_tiler.*", "rio_cogeo.*", "shapely.*"]
ignore_missing_imports = true

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
filterwarnings = ["error::DeprecationWarning"]
```

- [ ] **Step 2: Install the toolchain**

```bash
cd gis-platform/backend
python -m venv .venv
.venv/Scripts/activate          # Windows;  source .venv/bin/activate on POSIX
pip install -e ".[dev]"
```

Expected: install succeeds. `rasterio`/`pyogrio` ship binary wheels with GDAL — no system GDAL needed.

- [ ] **Step 3: Write the failing test for the error envelope**

`gis-platform/backend/tests/test_errors.py`:

```python
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.errors import (
    AppError,
    ConflictError,
    NotFoundError,
    register_exception_handlers,
)


def _app() -> FastAPI:
    app = FastAPI()
    register_exception_handlers(app)

    @app.get("/missing")
    def missing() -> None:
        raise NotFoundError("Layer 7 not found", details={"layerId": 7})

    @app.get("/conflict")
    def conflict() -> None:
        raise ConflictError("Name already used")

    @app.get("/boom")
    def boom() -> None:
        raise RuntimeError("unexpected")

    return app


def test_app_error_becomes_envelope_with_status_and_code() -> None:
    client = TestClient(_app())
    response = client.get("/missing")
    assert response.status_code == 404
    assert response.json() == {
        "error": {
            "code": "not_found",
            "message": "Layer 7 not found",
            "details": {"layerId": 7},
        }
    }


def test_conflict_error_uses_its_own_status_and_code() -> None:
    client = TestClient(_app())
    response = client.get("/conflict")
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "conflict"
    assert response.json()["error"]["details"] is None


def test_unexpected_exception_is_masked_as_internal_error() -> None:
    client = TestClient(_app(), raise_server_exceptions=False)
    response = client.get("/boom")
    assert response.status_code == 500
    assert response.json() == {
        "error": {"code": "internal_error", "message": "Internal server error", "details": None}
    }


def test_base_app_error_defaults() -> None:
    error = AppError("something")
    assert error.status_code == 500
    assert error.code == "internal_error"
    assert error.details is None
```

- [ ] **Step 4: Run it and confirm it fails**

Run: `pytest tests/test_errors.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.core.errors'`.

- [ ] **Step 5: Implement `app/core/errors.py`**

```python
"""Application error hierarchy and the single JSON error envelope."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger(__name__)


class AppError(Exception):
    """Base class for every error this application raises deliberately."""

    status_code: int = 500
    code: str = "internal_error"

    def __init__(self, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details


class NotFoundError(AppError):
    status_code = 404
    code = "not_found"


class ConflictError(AppError):
    status_code = 409
    code = "conflict"


class InvalidRequestError(AppError):
    status_code = 422
    code = "invalid_request"


class UnsupportedFormatError(AppError):
    status_code = 415
    code = "unsupported_format"


class PayloadTooLargeError(AppError):
    status_code = 413
    code = "payload_too_large"


class UpstreamDataError(AppError):
    status_code = 502
    code = "upstream_data_error"


def _envelope(code: str, message: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "details": details}}


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> JSONResponse:
        if exc.status_code >= 500:
            logger.exception("Application error: %s", exc.message)
        return JSONResponse(
            status_code=exc.status_code,
            content=_envelope(exc.code, exc.message, exc.details),
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content=_envelope(
                "invalid_request",
                "Request validation failed",
                {"errors": exc.errors()},
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=_envelope("http_error", str(exc.detail), None),
        )

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled exception", exc_info=exc)
        return JSONResponse(
            status_code=500,
            content=_envelope("internal_error", "Internal server error", None),
        )
```

- [ ] **Step 6: Run the error tests and confirm they pass**

Run: `pytest tests/test_errors.py -v`
Expected: 4 passed.

- [ ] **Step 7: Implement `app/core/config.py`**

```python
"""Typed application settings, loaded from environment / .env with prefix GIS_."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_prefix="GIS_", extra="ignore", case_sensitive=False
    )

    environment: str = "development"
    log_level: str = "INFO"
    api_prefix: str = "/api/v1"
    cors_origins: list[str] = ["http://localhost:1317"]

    # Async URL used by the app; the sync URL is derived from it in db/sync_engine.py.
    database_url: str = "postgresql+asyncpg://gis:gis@localhost:5401/gis_platform"
    db_pool_size: int = 10
    db_max_overflow: int = 5
    db_echo: bool = False

    # Filesystem
    data_dir: Path = Path("var/data")
    upload_max_bytes: int = 512 * 1024 * 1024

    # Schemas the platform owns
    metadata_schema: str = "gis"
    import_schema: str = "gis_data"

    # Memory guard rails
    feature_bbox_limit: int = 2000
    attribute_page_max: int = 500
    raster_pool_max_open: int = 8
    raster_pool_idle_ttl_seconds: float = 300.0

    @property
    def raster_dir(self) -> Path:
        return self.data_dir / "rasters"

    @property
    def upload_tmp_dir(self) -> Path:
        return self.data_dir / "tmp"


@lru_cache
def get_settings() -> Settings:
    return Settings()
```

`gis-platform/backend/.env.example`:

```
GIS_ENVIRONMENT=development
GIS_LOG_LEVEL=INFO
GIS_DATABASE_URL=postgresql+asyncpg://gis:gis@localhost:5401/gis_platform
GIS_DATA_DIR=var/data
GIS_CORS_ORIGINS=["http://localhost:1317"]
```

- [ ] **Step 8: Implement `app/core/logging.py`**

```python
"""Logging configuration: one JSON-ish line per record, request id when present."""

from __future__ import annotations

import logging
from logging.config import dictConfig

FORMAT = "%(asctime)s %(levelname)-8s %(name)s %(message)s"


def configure_logging(level: str) -> None:
    dictConfig(
        {
            "version": 1,
            "disable_existing_loggers": False,
            "formatters": {"default": {"format": FORMAT}},
            "handlers": {
                "console": {
                    "class": "logging.StreamHandler",
                    "formatter": "default",
                    "stream": "ext://sys.stdout",
                }
            },
            "root": {"handlers": ["console"], "level": level.upper()},
            "loggers": {
                "uvicorn.access": {"handlers": ["console"], "level": "INFO", "propagate": False},
                "sqlalchemy.engine": {"level": "WARNING"},
            },
        }
    )
    logging.getLogger(__name__).debug("Logging configured at %s", level)
```

- [ ] **Step 9: Write the failing health test**

`gis-platform/backend/tests/test_health.py`:

```python
from fastapi.testclient import TestClient

from app.main import create_app


def test_health_reports_ok_and_environment() -> None:
    client = TestClient(create_app())
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["environment"] == "development"


def test_unknown_route_uses_error_envelope() -> None:
    client = TestClient(create_app())
    response = client.get("/api/v1/nope")
    assert response.status_code == 404
    assert set(response.json()["error"]) == {"code", "message", "details"}
```

- [ ] **Step 10: Run it and confirm it fails**

Run: `pytest tests/test_health.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.main'`.

- [ ] **Step 11: Implement the health route, the v1 router, and the app factory**

`app/api/v1/routes/health.py`:

```python
from fastapi import APIRouter

from app.core.config import Settings, get_settings

router = APIRouter(tags=["system"])


@router.get("/health")
def health() -> dict[str, str]:
    settings: Settings = get_settings()
    return {"status": "ok", "environment": settings.environment}
```

`app/api/v1/router.py`:

```python
from fastapi import APIRouter

from app.api.v1.routes import health

api_router = APIRouter()
api_router.include_router(health.router)
```

`app/main.py`:

```python
"""Application factory. Import-time side effects are kept to zero on purpose."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.router import api_router
from app.core.config import Settings, get_settings
from app.core.errors import register_exception_handlers
from app.core.logging import configure_logging


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = get_settings()
    settings.raster_dir.mkdir(parents=True, exist_ok=True)
    settings.upload_tmp_dir.mkdir(parents=True, exist_ok=True)
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level)

    app = FastAPI(
        title="GIS Platform API",
        version="0.1.0",
        description="PostGIS-backed web GIS: layers, tiles, attributes, styling, editing.",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    register_exception_handlers(app)
    app.include_router(api_router, prefix=settings.api_prefix)
    return app


app = create_app()
```

- [ ] **Step 12: Run the whole gate**

Run: `pytest -v && ruff check . && ruff format --check . && mypy app`
Expected: 6 tests pass; ruff and mypy report no issues. Fix anything they flag before continuing.

- [ ] **Step 13: Smoke-run the server**

```bash
uvicorn app.main:app --reload --port 1316
```
Then in another shell: `curl http://localhost:1316/api/v1/health`
Expected: `{"status":"ok","environment":"development"}`. Also open `http://localhost:1316/docs` and confirm the OpenAPI page renders. Stop the server.

- [ ] **Step 14: Write `gis-platform/docs/01-architecture-overview.md`**

Sections and required content:
- `# 01 · Architecture Overview` — one paragraph on the QGIS concepts being mapped: layer tree, data provider, renderer, attribute table, edit buffer.
- `## The three tiers` — a diagram fenced as text showing browser (OpenLayers) → FastAPI → PostGIS/COG files, with the ports 1317 / 1316 / 5401 labelled.
- `## Why layered backend` — table with four rows: `routes` (HTTP shape only, no SQL), `services` (business rules, orchestration, transactions), `repositories` (the only place SQL is written), `models/schemas` (SQLAlchemy tables vs Pydantic wire contracts).
- `## Two kinds of SQL` — explain the split: SQLAlchemy ORM for the platform's own fixed `gis` schema; validated raw SQL for arbitrary user tables, because the table and column names are data, not code. Forward-reference `03-postgis-and-dynamic-sql.md`.
- `## The error envelope` — paste the real `_envelope` function and one example response.
- `## Configuration` — paste the real `Settings` class and explain the `GIS_` prefix and `.env`.
- `## Running it` — the venv + `pip install -e ".[dev]"` + uvicorn commands from Steps 2 and 13.

- [ ] **Step 15: Write `gis-platform/README.md`**

Must contain: one-paragraph product description; the `docker compose up -d postgres` / backend / web quickstart with the real ports; the directory tree from the **File Structure** section of this plan; a table of contents linking every file in `docs/`; and the quality-gate commands from **Global Constraints**.

- [ ] **Step 16: Commit**

```bash
cd gis-platform
git add backend/pyproject.toml backend/.env.example backend/app backend/tests docs/01-architecture-overview.md README.md
git commit -m "feat: scaffold GIS platform backend with config, logging and error envelope"
```

---

## Task 2: PostGIS Container, ORM Models, Migrations, Test Database

**Files:**
- Create: `gis-platform/docker-compose.yml`
- Create: `gis-platform/.env.example`
- Create: `gis-platform/backend/app/db/__init__.py`
- Create: `gis-platform/backend/app/db/base.py`
- Create: `gis-platform/backend/app/db/session.py`
- Create: `gis-platform/backend/app/models/__init__.py`
- Create: `gis-platform/backend/app/models/project.py`
- Create: `gis-platform/backend/app/models/layer.py`
- Create: `gis-platform/backend/alembic.ini`
- Create: `gis-platform/backend/migrations/env.py`
- Create: `gis-platform/backend/migrations/script.py.mako`
- Create: `gis-platform/backend/migrations/versions/0001_initial_schema.py`
- Create: `gis-platform/backend/tests/conftest.py`
- Test: `gis-platform/backend/tests/test_models.py`
- Create: `gis-platform/docs/02-spatial-data-model.md`

**Interfaces:**
- Consumes: `get_settings()` from Task 1.
- Produces:
  - `app.db.base.Base` — `DeclarativeBase` with the naming convention below.
  - `app.db.session.engine`, `app.db.session.SessionLocal: async_sessionmaker[AsyncSession]`, `app.db.session.get_session() -> AsyncIterator[AsyncSession]` (FastAPI dependency).
  - `app.models.project.Project` with columns `id: UUID`, `name: str`, `view: dict`, `created_at`, `updated_at`, relationship `layers: list[Layer]` ordered by `z_index`.
  - `app.models.layer.Layer` with columns `id: UUID`, `project_id: UUID`, `name: str`, `kind: str`, `source: dict`, `style: dict`, `visible: bool`, `opacity: float`, `z_index: int`, `extent: list[float] | None`, `feature_count: int | None`, `srid: int | None`, `geometry_type: str | None`, `created_at`, `updated_at`.
  - Test fixtures: `db_session: AsyncSession` (per-test, rolled back), `client: AsyncClient` (httpx against the app with `get_session` overridden).

- [ ] **Step 1: Write `gis-platform/docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgis/postgis:16-3.4
    container_name: gis-platform-postgres
    environment:
      POSTGRES_DB: gis_platform
      POSTGRES_USER: gis
      POSTGRES_PASSWORD: gis
    ports:
      - "5401:5432"
    volumes:
      - gis_platform_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U gis -d gis_platform"]
      interval: 5s
      timeout: 5s
      retries: 10

  pgadmin:
    image: dpage/pgadmin4:latest
    container_name: gis-platform-pgadmin
    environment:
      PGADMIN_DEFAULT_EMAIL: admin@example.com
      PGADMIN_DEFAULT_PASSWORD: admin
      PGADMIN_CONFIG_SERVER_MODE: "False"
    ports:
      - "5051:80"
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  gis_platform_pgdata:
```

`gis-platform/.env.example`:

```
POSTGRES_DB=gis_platform
POSTGRES_USER=gis
POSTGRES_PASSWORD=gis
```

- [ ] **Step 2: Start the database and verify PostGIS is available**

```bash
cd gis-platform
docker compose up -d postgres
docker compose exec postgres psql -U gis -d gis_platform -c "SELECT postgis_full_version();"
```
Expected: a `POSTGIS="3.4..."` version string. Also create the test database now:

```bash
docker compose exec postgres psql -U gis -d postgres -c "CREATE DATABASE gis_platform_test OWNER gis;"
```

- [ ] **Step 3: Implement `app/db/base.py` and `app/db/session.py`**

`app/db/base.py`:

```python
"""Declarative base with an explicit constraint naming convention.

Alembic can only autogenerate stable DROP/ALTER statements when every
constraint has a deterministic name, so the convention is set once, here.
"""

from __future__ import annotations

from sqlalchemy import MetaData
from sqlalchemy.orm import DeclarativeBase

NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_name)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)
```

`app/db/session.py`:

```python
from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings

_settings = get_settings()

engine = create_async_engine(
    _settings.database_url,
    echo=_settings.db_echo,
    pool_size=_settings.db_pool_size,
    max_overflow=_settings.db_max_overflow,
    pool_pre_ping=True,
)

SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency. One session per request; commit is the service's job."""
    async with SessionLocal() as session:
        yield session
```

- [ ] **Step 4: Write the failing model test**

`gis-platform/backend/tests/test_models.py`:

```python
import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.layer import Layer
from app.models.project import Project


async def _project(session: AsyncSession, name: str = "Demo") -> Project:
    project = Project(name=name, view={"center": [0, 0], "zoom": 2})
    session.add(project)
    await session.flush()
    return project


async def test_layer_defaults_are_sane(db_session: AsyncSession) -> None:
    project = await _project(db_session)
    layer = Layer(project_id=project.id, name="Roads", kind="vector", source={"type": "postgis"})
    db_session.add(layer)
    await db_session.flush()

    assert layer.visible is True
    assert layer.opacity == 1.0
    assert layer.z_index == 0
    assert layer.style == {}
    assert layer.extent is None
    assert layer.created_at is not None


async def test_layer_name_is_unique_per_project(db_session: AsyncSession) -> None:
    project = await _project(db_session)
    db_session.add(Layer(project_id=project.id, name="Roads", kind="vector", source={}))
    await db_session.flush()
    db_session.add(Layer(project_id=project.id, name="Roads", kind="vector", source={}))
    with pytest.raises(IntegrityError):
        await db_session.flush()


async def test_same_layer_name_allowed_in_different_projects(db_session: AsyncSession) -> None:
    first = await _project(db_session, "A")
    second = await _project(db_session, "B")
    db_session.add(Layer(project_id=first.id, name="Roads", kind="vector", source={}))
    db_session.add(Layer(project_id=second.id, name="Roads", kind="vector", source={}))
    await db_session.flush()  # must not raise


async def test_deleting_project_cascades_to_layers(db_session: AsyncSession) -> None:
    project = await _project(db_session)
    db_session.add(Layer(project_id=project.id, name="Roads", kind="vector", source={}))
    await db_session.flush()

    await db_session.delete(project)
    await db_session.flush()

    remaining = (await db_session.execute(select(Layer))).scalars().all()
    assert remaining == []


async def test_layer_kind_is_constrained(db_session: AsyncSession) -> None:
    project = await _project(db_session)
    db_session.add(Layer(project_id=project.id, name="Bad", kind="nonsense", source={}))
    with pytest.raises(IntegrityError):
        await db_session.flush()
```

- [ ] **Step 5: Run it and confirm it fails**

Run: `pytest tests/test_models.py -v`
Expected: FAIL — `fixture 'db_session' not found` / `ModuleNotFoundError: app.models.layer`.

- [ ] **Step 6: Implement the ORM models**

`app/models/project.py`:

```python
from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import DateTime, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.config import get_settings
from app.db.base import Base

if TYPE_CHECKING:
    from app.models.layer import Layer

_SCHEMA = get_settings().metadata_schema


class Project(Base):
    """A saved map: a view state plus an ordered set of layers."""

    __tablename__ = "project"
    __table_args__ = {"schema": _SCHEMA}

    id: Mapped[uuid.UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    view: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    layers: Mapped[list[Layer]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="Layer.z_index",
        lazy="selectin",
    )
```

`app/models/layer.py`:

```python
from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.config import get_settings
from app.db.base import Base

if TYPE_CHECKING:
    from app.models.project import Project

_SCHEMA = get_settings().metadata_schema

LAYER_KINDS = ("vector", "raster", "vector_tile", "basemap")


class Layer(Base):
    """One entry in the layer tree. `source` and `style` are validated by Pydantic."""

    __tablename__ = "layer"
    __table_args__ = (
        UniqueConstraint("project_id", "name", name="uq_layer_project_id"),
        CheckConstraint(
            "kind IN ('vector', 'raster', 'vector_tile', 'basemap')", name="layer_kind"
        ),
        CheckConstraint("opacity >= 0 AND opacity <= 1", name="layer_opacity"),
        {"schema": _SCHEMA},
    )

    id: Mapped[uuid.UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey(f"{_SCHEMA}.project.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    source: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    style: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    visible: Mapped[bool] = mapped_column(nullable=False, default=True)
    opacity: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    z_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    extent: Mapped[list[float] | None] = mapped_column(JSONB, nullable=True)
    feature_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    srid: Mapped[int | None] = mapped_column(Integer, nullable=True)
    geometry_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    project: Mapped[Project] = relationship(back_populates="layers")
```

`app/models/__init__.py`:

```python
from app.models.layer import Layer
from app.models.project import Project

__all__ = ["Layer", "Project"]
```

- [ ] **Step 7: Implement `tests/conftest.py`**

```python
"""Test fixtures.

The suite runs against a real PostGIS database (`gis_platform_test`) because
almost everything interesting here IS SQL. Schema is created once per session
with `create_all`; per-test isolation comes from an outer transaction that is
rolled back, so tests never see each other's rows.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, AsyncSession, create_async_engine

from app.core.config import get_settings
from app.db.base import Base
from app.db.session import get_session
from app.main import create_app

TEST_DATABASE_URL = get_settings().database_url

if not TEST_DATABASE_URL.endswith("/gis_platform_test"):
    raise RuntimeError(
        "Refusing to run the suite against a non-test database. "
        "Export GIS_DATABASE_URL=postgresql+asyncpg://gis:gis@localhost:5401/gis_platform_test"
    )


@pytest.fixture(scope="session")
def anyio_backend() -> str:
    return "asyncio"


@pytest_asyncio.fixture(scope="session")
async def engine() -> AsyncIterator[AsyncEngine]:
    import app.models  # noqa: F401  -- registers mappers on Base.metadata

    test_engine = create_async_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    settings = get_settings()
    async with test_engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
        await conn.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{settings.metadata_schema}"'))
        await conn.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{settings.import_schema}"'))
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    yield test_engine
    await test_engine.dispose()


@pytest_asyncio.fixture
async def db_connection(engine: AsyncEngine) -> AsyncIterator[AsyncConnection]:
    connection = await engine.connect()
    transaction = await connection.begin()
    try:
        yield connection
    finally:
        await transaction.rollback()
        await connection.close()


@pytest_asyncio.fixture
async def db_session(db_connection: AsyncConnection) -> AsyncIterator[AsyncSession]:
    session = AsyncSession(
        bind=db_connection, expire_on_commit=False, join_transaction_mode="create_savepoint"
    )
    try:
        yield session
    finally:
        await session.close()


@pytest_asyncio.fixture
async def client(db_session: AsyncSession) -> AsyncIterator[AsyncClient]:
    app = create_app()

    async def _override() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = _override
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http_client:
        yield http_client
    app.dependency_overrides.clear()
```

- [ ] **Step 8: Run the model tests and confirm they pass**

Run: `pytest tests/test_models.py -v`
Expected: 5 passed. If `test_layer_kind_is_constrained` fails, the `CheckConstraint` name/expression is wrong — fix the model, not the test.

- [ ] **Step 9: Wire up Alembic**

```bash
cd gis-platform/backend
alembic init -t async migrations
```

Then edit `alembic.ini` — set:

```ini
script_location = migrations
prepend_sys_path = .
# leave sqlalchemy.url empty; env.py reads it from Settings
sqlalchemy.url =
```

Replace the config block in `migrations/env.py` with:

```python
import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy.ext.asyncio import async_engine_from_config
from sqlalchemy import pool

from app.core.config import get_settings
from app.db.base import Base
import app.models  # noqa: F401  -- import for autogenerate

config = context.config
settings = get_settings()
config.set_main_option("sqlalchemy.url", settings.database_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata
VERSION_SCHEMA = settings.metadata_schema


def include_object(obj, name, type_, reflected, compare_to):
    """Only manage the schemas this platform owns."""
    if type_ == "table" and obj.schema not in (settings.metadata_schema, settings.import_schema):
        return False
    return True


def do_run_migrations(connection):
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        include_schemas=True,
        include_object=include_object,
        version_table_schema=VERSION_SCHEMA,
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations():
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online():
    asyncio.run(run_async_migrations())


run_migrations_online()
```

- [ ] **Step 10: Author the initial migration by hand**

`migrations/versions/0001_initial_schema.py` — hand-written rather than autogenerated because it must create the extension and both schemas *before* the tables:

```python
"""initial schema

Revision ID: 0001
Revises:
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")
    op.execute('CREATE SCHEMA IF NOT EXISTS "gis"')
    op.execute('CREATE SCHEMA IF NOT EXISTS "gis_data"')

    op.create_table(
        "project",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("view", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_project"),
        schema="gis",
    )

    op.create_table(
        "layer",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("source", postgresql.JSONB(), nullable=False),
        sa.Column("style", postgresql.JSONB(), nullable=False),
        sa.Column("visible", sa.Boolean(), nullable=False),
        sa.Column("opacity", sa.Float(), nullable=False),
        sa.Column("z_index", sa.Integer(), nullable=False),
        sa.Column("extent", postgresql.JSONB(), nullable=True),
        sa.Column("feature_count", sa.Integer(), nullable=True),
        sa.Column("srid", sa.Integer(), nullable=True),
        sa.Column("geometry_type", sa.String(length=50), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ["project_id"], ["gis.project.id"],
            name="fk_layer_project_id_project", ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_layer"),
        sa.UniqueConstraint("project_id", "name", name="uq_layer_project_id"),
        sa.CheckConstraint(
            "kind IN ('vector', 'raster', 'vector_tile', 'basemap')", name="ck_layer_layer_kind"
        ),
        sa.CheckConstraint("opacity >= 0 AND opacity <= 1", name="ck_layer_layer_opacity"),
        schema="gis",
    )
    op.create_index("ix_layer_project_id", "layer", ["project_id"], schema="gis")


def downgrade() -> None:
    op.drop_index("ix_layer_project_id", table_name="layer", schema="gis")
    op.drop_table("layer", schema="gis")
    op.drop_table("project", schema="gis")
```

- [ ] **Step 11: Apply the migration to the dev database and prove it round-trips**

```bash
alembic upgrade head
docker compose -f ../docker-compose.yml exec postgres psql -U gis -d gis_platform -c "\dt gis.*"
alembic downgrade base
alembic upgrade head
```
Expected: `\dt gis.*` lists `gis.layer` and `gis.project`; downgrade then upgrade both succeed with no error.

- [ ] **Step 12: Verify the migration matches the models**

```bash
alembic revision --autogenerate -m "drift check"
```
Expected: the generated file's `upgrade()` body is empty (only `pass`). If it isn't, the migration and models disagree — reconcile them, then **delete the drift-check file**:

```bash
rm migrations/versions/*drift_check*.py
```

- [ ] **Step 13: Run the full gate**

Run: `pytest -v && ruff check . && ruff format --check . && mypy app`
Expected: all green.

- [ ] **Step 14: Write `gis-platform/docs/02-spatial-data-model.md`**

Sections and required content:
- `# 02 · Spatial Data Model` — why the platform stores *metadata about* geodata rather than the geodata itself in its own tables.
- `## Three schemas, three owners` — table: `gis` (platform metadata, migrated by Alembic), `gis_data` (tables created by import; Alembic never touches their DDL), *user schemas* (registered read/write in place, never created or dropped by us).
- `## The `layer` table` — paste the real `Layer` model. Explain each of `source`, `style`, `extent`, `srid`, `geometry_type`, and why `source`/`style` are `JSONB` validated by Pydantic instead of columns (the shape varies by layer kind; forward-reference Task 3).
- `## Cascade and uniqueness` — quote `uq_layer_project_id` and the `ondelete="CASCADE"` FK, and paste the two tests that prove them.
- `## Test isolation without truncating` — paste the `db_connection` / `db_session` fixtures and explain outer transaction + `join_transaction_mode="create_savepoint"`.
- `## Migrations` — the `alembic upgrade head` / `downgrade base` round trip and the autogenerate drift check from Step 12, presented as the standing rule for schema changes.

- [ ] **Step 15: Commit**

```bash
cd gis-platform
git add docker-compose.yml .env.example backend/alembic.ini backend/migrations backend/app/db backend/app/models backend/tests docs/02-spatial-data-model.md
git commit -m "feat: add PostGIS compose stack, layer/project models and Alembic baseline"
```

---

## Task 3: Wire Contracts — `APIModel`, `LayerSource`, `StyleSpec`

**Files:**
- Create: `gis-platform/backend/app/schemas/__init__.py`
- Create: `gis-platform/backend/app/schemas/base.py`
- Create: `gis-platform/backend/app/schemas/source.py`
- Create: `gis-platform/backend/app/schemas/style.py`
- Create: `gis-platform/backend/app/schemas/layer.py`
- Create: `gis-platform/backend/app/schemas/project.py`
- Test: `gis-platform/backend/tests/test_schemas.py`
- Create: `gis-platform/docs/08-styling-and-renderers.md`

**Interfaces:**
- Consumes: `AppError` subclasses (Task 1); `Layer` / `Project` ORM models (Task 2, via `from_attributes`).
- Produces:
  - `app.schemas.base.APIModel` — base for every wire model (`alias_generator=to_camel`, `populate_by_name=True`, `from_attributes=True`).
  - `app.schemas.source.PostgisSource(type='postgis', schema_name, table_name, geometry_column, id_column, srid)`, `RasterFileSource(type='raster_file', path, band_count, nodata, is_cog)`, `XyzSource(type='xyz', url, attribution)`, `MvtSource(type='mvt', url, source_layer)`, and the discriminated alias `LayerSource`. Helper `parse_source(raw: dict) -> LayerSource`.
  - `app.schemas.style.StyleSpec` = discriminated union of `VectorStyle(kind='vector', renderer, fill, stroke, marker, label)` and `RasterStyle(kind='raster', bands, rescale, colormap, opacity)`; renderers `SingleRenderer(type='single')`, `CategorizedRenderer(type='categorized', field, categories, fallback_color)`, `GraduatedRenderer(type='graduated', field, method, classes)`; leaf models `FillStyle(color, opacity)`, `StrokeStyle(color, width, dash)`, `MarkerStyle(shape, radius)`, `LabelStyle(field, color, size, halo_color)`, `ColorStop(value, min, max, color, label)`. Helper `parse_style(raw: dict) -> StyleSpec | None` and `default_style_for(kind: str) -> StyleSpec`.
  - `app.schemas.layer.LayerCreate`, `LayerUpdate`, `LayerRead`; `app.schemas.project.ProjectCreate`, `ProjectUpdate`, `ProjectRead`, `MapView`, `LayerReorder`.

- [ ] **Step 1: Write the failing schema tests**

`gis-platform/backend/tests/test_schemas.py`:

```python
import pytest
from pydantic import ValidationError

from app.schemas.layer import LayerCreate, LayerRead
from app.schemas.source import MvtSource, PostgisSource, parse_source
from app.schemas.style import (
    CategorizedRenderer,
    GraduatedRenderer,
    RasterStyle,
    VectorStyle,
    default_style_for,
    parse_style,
)


def test_source_union_dispatches_on_type() -> None:
    source = parse_source(
        {
            "type": "postgis",
            "schemaName": "gis_data",
            "tableName": "roads",
            "geometryColumn": "geometry",
            "idColumn": "fid",
            "srid": 4326,
        }
    )
    assert isinstance(source, PostgisSource)
    assert source.table_name == "roads"


def test_source_union_rejects_unknown_type() -> None:
    with pytest.raises(ValidationError):
        parse_source({"type": "shapefile", "path": "/tmp/x.shp"})


def test_source_round_trips_to_camel_case() -> None:
    source = MvtSource(type="mvt", url="https://tiles/{z}/{x}/{y}.pbf", source_layer="water")
    assert source.model_dump(by_alias=True) == {
        "type": "mvt",
        "url": "https://tiles/{z}/{x}/{y}.pbf",
        "sourceLayer": "water",
    }


def test_vector_style_defaults_to_single_renderer() -> None:
    style = default_style_for("vector")
    assert isinstance(style, VectorStyle)
    assert style.renderer.type == "single"
    assert style.fill.color.startswith("#")
    assert 0.0 <= style.fill.opacity <= 1.0


def test_raster_style_defaults() -> None:
    style = default_style_for("raster")
    assert isinstance(style, RasterStyle)
    assert style.bands == [1]
    assert style.opacity == 1.0


def test_categorized_renderer_requires_a_field_and_categories() -> None:
    with pytest.raises(ValidationError):
        CategorizedRenderer(type="categorized", field="", categories=[])


def test_graduated_renderer_rejects_inverted_class_bounds() -> None:
    with pytest.raises(ValidationError):
        GraduatedRenderer(
            type="graduated",
            field="pop",
            classes=[{"min": 100, "max": 10, "color": "#ff0000"}],
        )


def test_colour_must_be_a_hex_triplet() -> None:
    with pytest.raises(ValidationError):
        VectorStyle(kind="vector", fill={"color": "rebeccapurple"})


def test_parse_style_returns_none_for_empty_jsonb() -> None:
    assert parse_style({}) is None


def test_layer_create_defaults_style_when_omitted() -> None:
    payload = LayerCreate(
        name="Roads",
        kind="vector",
        source={
            "type": "postgis",
            "schemaName": "gis_data",
            "tableName": "roads",
            "geometryColumn": "geometry",
            "idColumn": "fid",
            "srid": 4326,
        },
    )
    assert payload.style is not None
    assert payload.style.kind == "vector"


def test_layer_read_serialises_camel_case_from_orm_attributes() -> None:
    class FakeLayer:
        id = "8b1b0e0e-0000-4000-8000-000000000000"
        project_id = "8b1b0e0e-0000-4000-8000-000000000001"
        name = "Roads"
        kind = "vector"
        source = {
            "type": "postgis",
            "schemaName": "gis_data",
            "tableName": "roads",
            "geometryColumn": "geometry",
            "idColumn": "fid",
            "srid": 4326,
        }
        style = {"kind": "vector"}
        visible = True
        opacity = 1.0
        z_index = 3
        extent = [-180.0, -90.0, 180.0, 90.0]
        feature_count = 42
        srid = 4326
        geometry_type = "MULTILINESTRING"

    dumped = LayerRead.model_validate(FakeLayer()).model_dump(by_alias=True)
    assert dumped["zIndex"] == 3
    assert dumped["featureCount"] == 42
    assert dumped["geometryType"] == "MULTILINESTRING"
    assert "z_index" not in dumped
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pytest tests/test_schemas.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.schemas.source'`.

- [ ] **Step 3: Implement `app/schemas/base.py`**

```python
"""Every wire model inherits APIModel: snake_case in Python, camelCase on the wire."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class APIModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        from_attributes=True,
        extra="forbid",
    )
```

- [ ] **Step 4: Implement `app/schemas/source.py`**

```python
"""Where a layer's data actually comes from. One model per provider kind."""

from __future__ import annotations

from typing import Annotated, Any, Literal, TypeAlias

from pydantic import Field, TypeAdapter

from app.schemas.base import APIModel

IDENT = Field(pattern=r"^[a-z_][a-z0-9_]{0,62}$")


class PostgisSource(APIModel):
    """A table in PostGIS. Either created by import, or registered in place."""

    type: Literal["postgis"] = "postgis"
    schema_name: str = IDENT
    table_name: str = IDENT
    geometry_column: str = IDENT
    id_column: str = IDENT
    srid: int = Field(ge=1, le=999999)


class RasterFileSource(APIModel):
    type: Literal["raster_file"] = "raster_file"
    path: str
    band_count: int = Field(ge=1)
    nodata: float | None = None
    is_cog: bool = False


class XyzSource(APIModel):
    type: Literal["xyz"] = "xyz"
    url: str
    attribution: str | None = None


class MvtSource(APIModel):
    type: Literal["mvt"] = "mvt"
    url: str
    source_layer: str | None = None


LayerSource: TypeAlias = Annotated[
    PostgisSource | RasterFileSource | XyzSource | MvtSource,
    Field(discriminator="type"),
]

_SOURCE_ADAPTER: TypeAdapter[LayerSource] = TypeAdapter(LayerSource)


def parse_source(raw: dict[str, Any]) -> LayerSource:
    """Validate a raw JSONB `source` column into its concrete model."""
    return _SOURCE_ADAPTER.validate_python(raw)
```

Note the identifier `pattern` on `PostgisSource`: it is the *first* of the two gates from **Global Constraints**. The second (catalog existence) arrives in Task 5.

- [ ] **Step 5: Implement `app/schemas/style.py`**

```python
"""Engine-neutral symbology. The client compiles this into OpenLayers styles;
the raster tiler reads the raster half directly. Nothing here knows about OL."""

from __future__ import annotations

from typing import Annotated, Any, Literal, TypeAlias

from pydantic import Field, TypeAdapter, model_validator

from app.schemas.base import APIModel

HEX_COLOR = Field(pattern=r"^#[0-9a-fA-F]{6}$")


class FillStyle(APIModel):
    color: str = Field(default="#3b82f6", pattern=r"^#[0-9a-fA-F]{6}$")
    opacity: float = Field(default=0.6, ge=0.0, le=1.0)


class StrokeStyle(APIModel):
    color: str = Field(default="#1e3a8a", pattern=r"^#[0-9a-fA-F]{6}$")
    width: float = Field(default=1.0, ge=0.0, le=20.0)
    dash: list[float] | None = None


class MarkerStyle(APIModel):
    shape: Literal["circle", "square", "triangle"] = "circle"
    radius: float = Field(default=5.0, gt=0.0, le=50.0)


class LabelStyle(APIModel):
    field: str
    color: str = Field(default="#111827", pattern=r"^#[0-9a-fA-F]{6}$")
    size: int = Field(default=12, ge=6, le=48)
    halo_color: str = Field(default="#ffffff", pattern=r"^#[0-9a-fA-F]{6}$")


class ColorStop(APIModel):
    """One entry in a categorized or graduated renderer.

    Categorized stops carry `value`; graduated stops carry `min`/`max`.
    """

    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    value: str | float | None = None
    min: float | None = None
    max: float | None = None
    label: str | None = None

    @model_validator(mode="after")
    def _bounds_must_ascend(self) -> ColorStop:
        if self.min is not None and self.max is not None and self.min > self.max:
            raise ValueError("min must be less than or equal to max")
        return self


class SingleRenderer(APIModel):
    type: Literal["single"] = "single"


class CategorizedRenderer(APIModel):
    type: Literal["categorized"] = "categorized"
    field: str = Field(min_length=1)
    categories: list[ColorStop] = Field(min_length=1)
    fallback_color: str = Field(default="#9ca3af", pattern=r"^#[0-9a-fA-F]{6}$")


class GraduatedRenderer(APIModel):
    type: Literal["graduated"] = "graduated"
    field: str = Field(min_length=1)
    method: Literal["equal_interval", "quantile", "natural_breaks"] = "equal_interval"
    classes: list[ColorStop] = Field(min_length=1)


Renderer: TypeAlias = Annotated[
    SingleRenderer | CategorizedRenderer | GraduatedRenderer,
    Field(discriminator="type"),
]


class VectorStyle(APIModel):
    kind: Literal["vector"] = "vector"
    renderer: Renderer = SingleRenderer()
    fill: FillStyle = FillStyle()
    stroke: StrokeStyle = StrokeStyle()
    marker: MarkerStyle = MarkerStyle()
    label: LabelStyle | None = None


class RasterStyle(APIModel):
    kind: Literal["raster"] = "raster"
    bands: list[int] = Field(default=[1], min_length=1, max_length=4)
    rescale: list[tuple[float, float]] | None = None
    colormap: str | None = None
    opacity: float = Field(default=1.0, ge=0.0, le=1.0)

    @model_validator(mode="after")
    def _rescale_matches_bands(self) -> RasterStyle:
        if self.rescale is not None and len(self.rescale) != len(self.bands):
            raise ValueError("rescale must supply one (min, max) pair per band")
        return self


StyleSpec: TypeAlias = Annotated[VectorStyle | RasterStyle, Field(discriminator="kind")]

_STYLE_ADAPTER: TypeAdapter[StyleSpec] = TypeAdapter(StyleSpec)


def parse_style(raw: dict[str, Any] | None) -> StyleSpec | None:
    """An empty JSONB `{}` means 'no style saved yet', not 'invalid style'."""
    if not raw:
        return None
    return _STYLE_ADAPTER.validate_python(raw)


def default_style_for(kind: str) -> StyleSpec:
    return RasterStyle() if kind == "raster" else VectorStyle()
```

- [ ] **Step 6: Implement `app/schemas/layer.py` and `app/schemas/project.py`**

`app/schemas/layer.py`:

```python
from __future__ import annotations

import uuid
from typing import Literal

from pydantic import Field, model_validator

from app.schemas.base import APIModel
from app.schemas.source import LayerSource
from app.schemas.style import StyleSpec, default_style_for

LayerKind = Literal["vector", "raster", "vector_tile", "basemap"]


class LayerCreate(APIModel):
    name: str = Field(min_length=1, max_length=200)
    kind: LayerKind
    source: LayerSource
    style: StyleSpec | None = None
    visible: bool = True
    opacity: float = Field(default=1.0, ge=0.0, le=1.0)

    @model_validator(mode="after")
    def _fill_default_style(self) -> LayerCreate:
        if self.style is None:
            object.__setattr__(self, "style", default_style_for(self.kind))
        return self


class LayerUpdate(APIModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    style: StyleSpec | None = None
    visible: bool | None = None
    opacity: float | None = Field(default=None, ge=0.0, le=1.0)


class LayerRead(APIModel):
    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    kind: LayerKind
    source: LayerSource
    style: StyleSpec | None
    visible: bool
    opacity: float
    z_index: int
    extent: list[float] | None
    feature_count: int | None
    srid: int | None
    geometry_type: str | None
```

`app/schemas/project.py`:

```python
from __future__ import annotations

import uuid

from pydantic import Field

from app.schemas.base import APIModel
from app.schemas.layer import LayerRead


class MapView(APIModel):
    center: tuple[float, float] = (0.0, 0.0)
    zoom: float = Field(default=2.0, ge=0.0, le=24.0)
    projection: str = "EPSG:3857"


class ProjectCreate(APIModel):
    name: str = Field(min_length=1, max_length=200)
    view: MapView = MapView()


class ProjectUpdate(APIModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    view: MapView | None = None


class ProjectRead(APIModel):
    id: uuid.UUID
    name: str
    view: MapView
    layers: list[LayerRead] = []


class ProjectSummary(APIModel):
    id: uuid.UUID
    name: str
    layer_count: int


class LayerReorder(APIModel):
    layer_ids: list[uuid.UUID] = Field(min_length=1)
```

`app/schemas/__init__.py`: leave empty (import from the concrete modules, so mypy keeps the dependency graph honest).

- [ ] **Step 7: Run the schema tests and confirm they pass**

Run: `pytest tests/test_schemas.py -v`
Expected: 11 passed.

Note on `test_layer_create_defaults_style_when_omitted`: if `object.__setattr__` trips because the model is not frozen, replace the validator body with a plain assignment `self.style = default_style_for(self.kind)` and re-run.

- [ ] **Step 8: Run the full gate**

Run: `pytest -v && ruff check . && ruff format --check . && mypy app`
Expected: all green.

- [ ] **Step 9: Write `gis-platform/docs/08-styling-and-renderers.md`**

Sections and required content:
- `# 08 · Styling and Renderers` — the QGIS symbology model in one paragraph: a renderer decides *which* symbol a feature gets; the symbol decides what it looks like.
- `## Why the style spec is engine-neutral` — the style is stored in Postgres and consumed by two very different renderers (OpenLayers in the browser, rio-tiler on the server). Nothing in `style.py` imports either.
- `## The three renderers` — paste `SingleRenderer`, `CategorizedRenderer`, `GraduatedRenderer` and give one worked JSON example each, e.g.:

```json
{
  "kind": "vector",
  "renderer": {
    "type": "graduated",
    "field": "population",
    "method": "quantile",
    "classes": [
      {"min": 0,      "max": 10000,  "color": "#eff6ff", "label": "< 10k"},
      {"min": 10000,  "max": 100000, "color": "#60a5fa", "label": "10k–100k"},
      {"min": 100000, "max": null,   "color": "#1d4ed8", "label": "> 100k"}
    ]
  },
  "stroke": {"color": "#1e3a8a", "width": 0.5}
}
```

- `## Raster styling is different` — paste `RasterStyle`, explain `bands` / `rescale` / `colormap` and why `rescale` exists (16-bit and float rasters have no natural 0–255 mapping); forward-reference `06-raster-tiling-and-cog.md`.
- `## Discriminated unions` — paste `LayerSource` and `StyleSpec`, and explain that `Field(discriminator=...)` gives a single-branch parse and a clean error instead of trying every member.
- `## camelCase on the wire` — paste `APIModel` and the `test_source_round_trips_to_camel_case` test as the proof.

- [ ] **Step 10: Commit**

```bash
cd gis-platform
git add backend/app/schemas backend/tests/test_schemas.py docs/08-styling-and-renderers.md
git commit -m "feat: add layer source and style spec wire contracts"
```

---

## Task 4: Project and Layer CRUD API

**Files:**
- Create: `gis-platform/backend/app/repositories/__init__.py`
- Create: `gis-platform/backend/app/repositories/project_repository.py`
- Create: `gis-platform/backend/app/repositories/layer_repository.py`
- Create: `gis-platform/backend/app/services/__init__.py`
- Create: `gis-platform/backend/app/services/project_service.py`
- Create: `gis-platform/backend/app/services/layer_service.py`
- Create: `gis-platform/backend/app/api/v1/routes/projects.py`
- Create: `gis-platform/backend/app/api/v1/routes/layers.py`
- Modify: `gis-platform/backend/app/api/v1/router.py`
- Test: `gis-platform/backend/tests/test_projects_api.py`, `gis-platform/backend/tests/test_layers_api.py`

**Interfaces:**
- Consumes: `Project`/`Layer` models (Task 2); `ProjectCreate`, `ProjectUpdate`, `ProjectRead`, `ProjectSummary`, `LayerReorder`, `LayerCreate`, `LayerUpdate`, `LayerRead` (Task 3); `get_session` (Task 2); `NotFoundError`, `ConflictError`, `InvalidRequestError` (Task 1).
- Produces:
  - `app.repositories.project_repository`: `async create(session, name, view) -> Project`, `get(session, project_id) -> Project | None`, `list_summaries(session) -> list[tuple[Project, int]]` (one aggregate query, not per-project loads), `update(session, project, **fields) -> Project`, `delete(session, project) -> None`.
  - `app.repositories.layer_repository`: `async create(session, project_id, **fields) -> Layer`, `get(session, layer_id) -> Layer | None`, `list_for_project(session, project_id) -> list[Layer]`, `next_z_index(session, project_id) -> int`, `update(session, layer, **fields) -> Layer`, `delete(session, layer) -> None`, `set_z_indexes(session, project_id, ordered_ids) -> None`.
  - `app.services.layer_service`: `async get_layer_or_404(session, layer_id) -> Layer`, `create_layer(session, project_id, payload) -> Layer`, `update_layer(session, layer_id, payload) -> Layer`, `delete_layer(session, layer_id) -> None`, `reorder(session, project_id, layer_ids) -> list[Layer]`. **Every later backend task calls `get_layer_or_404` rather than hitting the repository directly.**
  - `app.services.layer_service.require_postgis_source(layer) -> PostgisSource` — raises `InvalidRequestError` if the layer is not PostGIS-backed. Used by Tasks 8, 9, 10, 13.
  - Endpoints: `GET/POST /projects`, `GET/PATCH/DELETE /projects/{project_id}`, `GET/POST /projects/{project_id}/layers`, `POST /projects/{project_id}/layers/reorder`, `GET/PATCH/DELETE /layers/{layer_id}`.

- [ ] **Step 1: Write the failing project API test**

`gis-platform/backend/tests/test_projects_api.py`:

```python
from httpx import AsyncClient


async def test_create_project_returns_camel_case_and_defaults(client: AsyncClient) -> None:
    response = await client.post("/api/v1/projects", json={"name": "City Plan"})
    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "City Plan"
    assert body["view"] == {"center": [0.0, 0.0], "zoom": 2.0, "projection": "EPSG:3857"}
    assert body["layers"] == []


async def test_get_missing_project_returns_error_envelope(client: AsyncClient) -> None:
    missing = "8b1b0e0e-0000-4000-8000-0000000000ff"
    response = await client.get(f"/api/v1/projects/{missing}")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_list_projects_reports_layer_count(client: AsyncClient) -> None:
    created = (await client.post("/api/v1/projects", json={"name": "A"})).json()
    added = await client.post(
        f"/api/v1/projects/{created['id']}/layers",
        json={
            "name": "Roads",
            "kind": "basemap",
            "source": {"type": "xyz", "url": "https://tiles/{z}/{x}/{y}.png"},
        },
    )
    assert added.status_code == 201
    listing = (await client.get("/api/v1/projects")).json()
    assert listing == [{"id": created["id"], "name": "A", "layerCount": 1}]


async def test_list_projects_reports_zero_for_an_empty_project(client: AsyncClient) -> None:
    created = (await client.post("/api/v1/projects", json={"name": "Empty"})).json()
    listing = (await client.get("/api/v1/projects")).json()
    assert listing == [{"id": created["id"], "name": "Empty", "layerCount": 0}]


async def test_patch_project_view(client: AsyncClient) -> None:
    created = (await client.post("/api/v1/projects", json={"name": "A"})).json()
    response = await client.patch(
        f"/api/v1/projects/{created['id']}",
        json={"view": {"center": [116.4, 39.9], "zoom": 10.0, "projection": "EPSG:3857"}},
    )
    assert response.status_code == 200
    assert response.json()["view"]["center"] == [116.4, 39.9]


async def test_delete_project_removes_it(client: AsyncClient) -> None:
    created = (await client.post("/api/v1/projects", json={"name": "A"})).json()
    assert (await client.delete(f"/api/v1/projects/{created['id']}")).status_code == 204
    assert (await client.get(f"/api/v1/projects/{created['id']}")).status_code == 404
```

Note: `test_list_projects_reports_layer_count` asserts the created layer is actually counted (`layerCount == 1`), and `test_list_projects_reports_zero_for_an_empty_project` covers the zero case separately. The pair matters because a summary that silently reports 0 would look identical to a summary computed from a broken aggregate.

- [ ] **Step 2: Write the failing layer API test**

`gis-platform/backend/tests/test_layers_api.py`:

```python
import pytest
from httpx import AsyncClient

BASEMAP = {
    "name": "OSM",
    "kind": "basemap",
    "source": {"type": "xyz", "url": "https://tile.example/{z}/{x}/{y}.png"},
}


@pytest.fixture
async def project_id(client: AsyncClient) -> str:
    return (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]


async def test_create_layer_assigns_next_z_index(client: AsyncClient, project_id: str) -> None:
    first = await client.post(f"/api/v1/projects/{project_id}/layers", json=BASEMAP)
    assert first.status_code == 201
    assert first.json()["zIndex"] == 0

    second = await client.post(
        f"/api/v1/projects/{project_id}/layers", json={**BASEMAP, "name": "OSM 2"}
    )
    assert second.json()["zIndex"] == 1


async def test_create_layer_fills_a_default_style(client: AsyncClient, project_id: str) -> None:
    body = (await client.post(f"/api/v1/projects/{project_id}/layers", json=BASEMAP)).json()
    assert body["style"]["kind"] == "vector"
    assert body["style"]["renderer"]["type"] == "single"


async def test_duplicate_layer_name_in_project_is_a_conflict(
    client: AsyncClient, project_id: str
) -> None:
    await client.post(f"/api/v1/projects/{project_id}/layers", json=BASEMAP)
    duplicate = await client.post(f"/api/v1/projects/{project_id}/layers", json=BASEMAP)
    assert duplicate.status_code == 409
    assert duplicate.json()["error"]["code"] == "conflict"


async def test_patch_layer_updates_visibility_opacity_and_style(
    client: AsyncClient, project_id: str
) -> None:
    layer = (await client.post(f"/api/v1/projects/{project_id}/layers", json=BASEMAP)).json()
    response = await client.patch(
        f"/api/v1/layers/{layer['id']}",
        json={
            "visible": False,
            "opacity": 0.4,
            "style": {"kind": "vector", "fill": {"color": "#ff0000", "opacity": 0.9}},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["visible"] is False
    assert body["opacity"] == 0.4
    assert body["style"]["fill"]["color"] == "#ff0000"


async def test_patch_layer_rejects_invalid_style(client: AsyncClient, project_id: str) -> None:
    layer = (await client.post(f"/api/v1/projects/{project_id}/layers", json=BASEMAP)).json()
    response = await client.patch(
        f"/api/v1/layers/{layer['id']}", json={"style": {"kind": "vector", "opacity": "loud"}}
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


async def test_reorder_rewrites_z_indexes(client: AsyncClient, project_id: str) -> None:
    a = (await client.post(f"/api/v1/projects/{project_id}/layers", json=BASEMAP)).json()
    b = (
        await client.post(
            f"/api/v1/projects/{project_id}/layers", json={**BASEMAP, "name": "B"}
        )
    ).json()
    c = (
        await client.post(
            f"/api/v1/projects/{project_id}/layers", json={**BASEMAP, "name": "C"}
        )
    ).json()

    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/reorder",
        json={"layerIds": [c["id"], a["id"], b["id"]]},
    )
    assert response.status_code == 200
    assert [layer["name"] for layer in response.json()] == ["C", "OSM", "B"]
    assert [layer["zIndex"] for layer in response.json()] == [0, 1, 2]


async def test_reorder_rejects_a_partial_id_list(client: AsyncClient, project_id: str) -> None:
    a = (await client.post(f"/api/v1/projects/{project_id}/layers", json=BASEMAP)).json()
    await client.post(f"/api/v1/projects/{project_id}/layers", json={**BASEMAP, "name": "B"})

    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/reorder", json={"layerIds": [a["id"]]}
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


async def test_project_detail_returns_layers_in_z_order(
    client: AsyncClient, project_id: str
) -> None:
    await client.post(f"/api/v1/projects/{project_id}/layers", json=BASEMAP)
    await client.post(f"/api/v1/projects/{project_id}/layers", json={**BASEMAP, "name": "B"})
    body = (await client.get(f"/api/v1/projects/{project_id}")).json()
    assert [layer["name"] for layer in body["layers"]] == ["OSM", "B"]


async def test_delete_layer(client: AsyncClient, project_id: str) -> None:
    layer = (await client.post(f"/api/v1/projects/{project_id}/layers", json=BASEMAP)).json()
    assert (await client.delete(f"/api/v1/layers/{layer['id']}")).status_code == 204
    assert (await client.get(f"/api/v1/layers/{layer['id']}")).status_code == 404
```

- [ ] **Step 3: Run both tests and confirm they fail**

Run: `pytest tests/test_projects_api.py tests/test_layers_api.py -v`
Expected: FAIL — every request returns 404 because the routes do not exist yet.

- [ ] **Step 4: Implement the repositories**

`app/repositories/project_repository.py`:

```python
"""SQL for gis.project. No business rules live here."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.layer import Layer
from app.models.project import Project


async def create(session: AsyncSession, *, name: str, view: dict[str, Any]) -> Project:
    project = Project(name=name, view=view)
    session.add(project)
    await session.flush()
    await session.refresh(project)
    return project


async def get(session: AsyncSession, project_id: uuid.UUID) -> Project | None:
    result = await session.execute(select(Project).where(Project.id == project_id))
    return result.scalar_one_or_none()


async def list_summaries(session: AsyncSession) -> list[tuple[Project, int]]:
    stmt = (
        select(Project, func.count(Layer.id))
        .outerjoin(Layer, Layer.project_id == Project.id)
        .group_by(Project.id)
        .order_by(Project.created_at)
    )
    result = await session.execute(stmt)
    return [(project, count) for project, count in result.all()]


async def update(session: AsyncSession, project: Project, **fields: Any) -> Project:
    for key, value in fields.items():
        setattr(project, key, value)
    await session.flush()
    await session.refresh(project)
    return project


async def delete(session: AsyncSession, project: Project) -> None:
    await session.delete(project)
    await session.flush()
```

`app/repositories/layer_repository.py`:

```python
"""SQL for gis.layer."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.layer import Layer


async def create(session: AsyncSession, **fields: Any) -> Layer:
    layer = Layer(**fields)
    session.add(layer)
    await session.flush()
    await session.refresh(layer)
    return layer


async def get(session: AsyncSession, layer_id: uuid.UUID) -> Layer | None:
    result = await session.execute(select(Layer).where(Layer.id == layer_id))
    return result.scalar_one_or_none()


async def list_for_project(session: AsyncSession, project_id: uuid.UUID) -> list[Layer]:
    result = await session.execute(
        select(Layer).where(Layer.project_id == project_id).order_by(Layer.z_index)
    )
    return list(result.scalars().all())


async def next_z_index(session: AsyncSession, project_id: uuid.UUID) -> int:
    result = await session.execute(
        select(func.coalesce(func.max(Layer.z_index) + 1, 0)).where(Layer.project_id == project_id)
    )
    return int(result.scalar_one())


async def name_exists(session: AsyncSession, project_id: uuid.UUID, name: str) -> bool:
    result = await session.execute(
        select(func.count()).select_from(Layer).where(
            Layer.project_id == project_id, Layer.name == name
        )
    )
    return int(result.scalar_one()) > 0


async def update(session: AsyncSession, layer: Layer, **fields: Any) -> Layer:
    for key, value in fields.items():
        setattr(layer, key, value)
    await session.flush()
    await session.refresh(layer)
    return layer


async def delete(session: AsyncSession, layer: Layer) -> None:
    await session.delete(layer)
    await session.flush()


async def set_z_indexes(
    session: AsyncSession, project_id: uuid.UUID, ordered_ids: list[uuid.UUID]
) -> None:
    layers = {layer.id: layer for layer in await list_for_project(session, project_id)}
    for position, layer_id in enumerate(ordered_ids):
        layers[layer_id].z_index = position
    await session.flush()
```

- [ ] **Step 5: Implement the services**

`app/services/project_service.py`:

```python
from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFoundError
from app.models.project import Project
from app.repositories import project_repository
from app.schemas.project import ProjectCreate, ProjectSummary, ProjectUpdate


async def get_or_404(session: AsyncSession, project_id: uuid.UUID) -> Project:
    project = await project_repository.get(session, project_id)
    if project is None:
        raise NotFoundError(f"Project {project_id} not found", details={"projectId": str(project_id)})
    return project


async def create_project(session: AsyncSession, payload: ProjectCreate) -> Project:
    project = await project_repository.create(
        session, name=payload.name, view=payload.view.model_dump(by_alias=True)
    )
    await session.commit()
    await session.refresh(project)
    return project


async def list_projects(session: AsyncSession) -> list[ProjectSummary]:
    rows = await project_repository.list_summaries(session)
    return [
        ProjectSummary(id=project.id, name=project.name, layer_count=count)
        for project, count in rows
    ]


async def update_project(
    session: AsyncSession, project_id: uuid.UUID, payload: ProjectUpdate
) -> Project:
    project = await get_or_404(session, project_id)
    fields = {}
    if payload.name is not None:
        fields["name"] = payload.name
    if payload.view is not None:
        fields["view"] = payload.view.model_dump(by_alias=True)
    project = await project_repository.update(session, project, **fields)
    await session.commit()
    await session.refresh(project)
    return project


async def delete_project(session: AsyncSession, project_id: uuid.UUID) -> None:
    project = await get_or_404(session, project_id)
    await project_repository.delete(session, project)
    await session.commit()
```

`app/services/layer_service.py`:

```python
from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ConflictError, InvalidRequestError, NotFoundError
from app.models.layer import Layer
from app.repositories import layer_repository
from app.schemas.layer import LayerCreate, LayerUpdate
from app.schemas.source import PostgisSource, parse_source
from app.services import project_service


async def get_layer_or_404(session: AsyncSession, layer_id: uuid.UUID) -> Layer:
    layer = await layer_repository.get(session, layer_id)
    if layer is None:
        raise NotFoundError(f"Layer {layer_id} not found", details={"layerId": str(layer_id)})
    return layer


def require_postgis_source(layer: Layer) -> PostgisSource:
    """Feature reads, attribute tables, MVT and editing all need a real table."""
    source = parse_source(layer.source)
    if not isinstance(source, PostgisSource):
        raise InvalidRequestError(
            f"Layer {layer.id} is not backed by a PostGIS table",
            details={"layerId": str(layer.id), "sourceType": source.type},
        )
    return source


async def create_layer(
    session: AsyncSession, project_id: uuid.UUID, payload: LayerCreate
) -> Layer:
    await project_service.get_or_404(session, project_id)
    if await layer_repository.name_exists(session, project_id, payload.name):
        raise ConflictError(
            f"A layer named {payload.name!r} already exists in this project",
            details={"name": payload.name},
        )
    layer = await layer_repository.create(
        session,
        project_id=project_id,
        name=payload.name,
        kind=payload.kind,
        source=payload.source.model_dump(by_alias=True),
        style=payload.style.model_dump(by_alias=True) if payload.style else {},
        visible=payload.visible,
        opacity=payload.opacity,
        z_index=await layer_repository.next_z_index(session, project_id),
    )
    await session.commit()
    await session.refresh(layer)
    return layer


async def update_layer(
    session: AsyncSession, layer_id: uuid.UUID, payload: LayerUpdate
) -> Layer:
    layer = await get_layer_or_404(session, layer_id)
    fields: dict[str, object] = {}
    if payload.name is not None and payload.name != layer.name:
        if await layer_repository.name_exists(session, layer.project_id, payload.name):
            raise ConflictError(
                f"A layer named {payload.name!r} already exists in this project",
                details={"name": payload.name},
            )
        fields["name"] = payload.name
    if payload.style is not None:
        fields["style"] = payload.style.model_dump(by_alias=True)
    if payload.visible is not None:
        fields["visible"] = payload.visible
    if payload.opacity is not None:
        fields["opacity"] = payload.opacity

    layer = await layer_repository.update(session, layer, **fields)
    await session.commit()
    await session.refresh(layer)
    return layer


async def delete_layer(session: AsyncSession, layer_id: uuid.UUID) -> None:
    layer = await get_layer_or_404(session, layer_id)
    await layer_repository.delete(session, layer)
    await session.commit()


async def reorder(
    session: AsyncSession, project_id: uuid.UUID, layer_ids: list[uuid.UUID]
) -> list[Layer]:
    await project_service.get_or_404(session, project_id)
    existing = {layer.id for layer in await layer_repository.list_for_project(session, project_id)}
    requested = set(layer_ids)
    if existing != requested or len(layer_ids) != len(requested):
        raise InvalidRequestError(
            "layerIds must list every layer in the project exactly once",
            details={
                "missing": sorted(str(i) for i in existing - requested),
                "unknown": sorted(str(i) for i in requested - existing),
            },
        )
    await layer_repository.set_z_indexes(session, project_id, layer_ids)
    await session.commit()
    return await layer_repository.list_for_project(session, project_id)
```

- [ ] **Step 6: Implement the routes**

`app/api/v1/routes/projects.py`:

```python
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
from app.schemas.layer import LayerCreate, LayerRead
from app.schemas.project import (
    LayerReorder,
    ProjectCreate,
    ProjectRead,
    ProjectSummary,
    ProjectUpdate,
)
from app.services import layer_service, project_service

router = APIRouter(prefix="/projects", tags=["projects"])


@router.post("", response_model=ProjectRead, status_code=status.HTTP_201_CREATED)
async def create_project(
    payload: ProjectCreate, session: AsyncSession = Depends(get_session)
) -> ProjectRead:
    project = await project_service.create_project(session, payload)
    return ProjectRead.model_validate(project)


@router.get("", response_model=list[ProjectSummary])
async def list_projects(session: AsyncSession = Depends(get_session)) -> list[ProjectSummary]:
    return await project_service.list_projects(session)


@router.get("/{project_id}", response_model=ProjectRead)
async def get_project(
    project_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> ProjectRead:
    project = await project_service.get_or_404(session, project_id)
    return ProjectRead.model_validate(project)


@router.patch("/{project_id}", response_model=ProjectRead)
async def update_project(
    project_id: uuid.UUID,
    payload: ProjectUpdate,
    session: AsyncSession = Depends(get_session),
) -> ProjectRead:
    project = await project_service.update_project(session, project_id, payload)
    return ProjectRead.model_validate(project)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> None:
    await project_service.delete_project(session, project_id)


@router.get("/{project_id}/layers", response_model=list[LayerRead])
async def list_layers(
    project_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> list[LayerRead]:
    project = await project_service.get_or_404(session, project_id)
    return [LayerRead.model_validate(layer) for layer in project.layers]


@router.post(
    "/{project_id}/layers", response_model=LayerRead, status_code=status.HTTP_201_CREATED
)
async def create_layer(
    project_id: uuid.UUID,
    payload: LayerCreate,
    session: AsyncSession = Depends(get_session),
) -> LayerRead:
    layer = await layer_service.create_layer(session, project_id, payload)
    return LayerRead.model_validate(layer)


@router.post("/{project_id}/layers/reorder", response_model=list[LayerRead])
async def reorder_layers(
    project_id: uuid.UUID,
    payload: LayerReorder,
    session: AsyncSession = Depends(get_session),
) -> list[LayerRead]:
    layers = await layer_service.reorder(session, project_id, payload.layer_ids)
    return [LayerRead.model_validate(layer) for layer in layers]
```

`app/api/v1/routes/layers.py`:

```python
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
from app.schemas.layer import LayerRead, LayerUpdate
from app.services import layer_service

router = APIRouter(prefix="/layers", tags=["layers"])


@router.get("/{layer_id}", response_model=LayerRead)
async def get_layer(
    layer_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> LayerRead:
    layer = await layer_service.get_layer_or_404(session, layer_id)
    return LayerRead.model_validate(layer)


@router.patch("/{layer_id}", response_model=LayerRead)
async def update_layer(
    layer_id: uuid.UUID,
    payload: LayerUpdate,
    session: AsyncSession = Depends(get_session),
) -> LayerRead:
    layer = await layer_service.update_layer(session, layer_id, payload)
    return LayerRead.model_validate(layer)


@router.delete("/{layer_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_layer(
    layer_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> None:
    await layer_service.delete_layer(session, layer_id)
```

Update `app/api/v1/router.py`:

```python
from fastapi import APIRouter

from app.api.v1.routes import health, layers, projects

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(projects.router)
api_router.include_router(layers.router)
```

- [ ] **Step 7: Run the API tests and confirm they pass**

Run: `pytest tests/test_projects_api.py tests/test_layers_api.py -v`
Expected: 15 passed.

If `test_patch_layer_rejects_invalid_style` returns 422 with `code == "http_error"` instead of `"invalid_request"`, the `RequestValidationError` handler is not registered — check `register_exception_handlers` order in Task 1.

- [ ] **Step 8: Run the full gate and commit**

Run: `pytest -v && ruff check . && ruff format --check . && mypy app`
Expected: all green.

```bash
cd gis-platform
git add backend/app/repositories backend/app/services backend/app/api backend/tests
git commit -m "feat: add project and layer CRUD with ordering"
```

- [ ] **Step 9: Manual smoke check**

```bash
cd gis-platform/backend
alembic upgrade head
uvicorn app.main:app --port 1316 &
curl -s -X POST localhost:1316/api/v1/projects -H 'content-type: application/json' -d '{"name":"Demo"}'
curl -s localhost:1316/api/v1/projects
```
Expected: the POST returns a project with `"layers": []`; the GET returns one summary with `"layerCount": 0`. Keep the returned project id — later manual checks reuse it. Stop the server.

---

## Task 5: Safe Dynamic SQL and PostGIS Catalog Introspection

**Files:**
- Create: `gis-platform/backend/app/db/identifiers.py`
- Create: `gis-platform/backend/app/repositories/catalog_repository.py`
- Create: `gis-platform/backend/app/services/catalog_service.py`
- Create: `gis-platform/backend/app/schemas/catalog.py`
- Create: `gis-platform/backend/app/api/v1/routes/catalog.py`
- Modify: `gis-platform/backend/app/api/v1/router.py`
- Test: `gis-platform/backend/tests/test_identifiers.py`, `gis-platform/backend/tests/test_catalog_api.py`
- Create: `gis-platform/backend/tests/fixtures/__init__.py`, `gis-platform/backend/tests/fixtures/spatial.py`
- Create: `gis-platform/docs/03-postgis-and-dynamic-sql.md`

**Interfaces:**
- Consumes: `InvalidRequestError`, `NotFoundError` (Task 1); `get_session` (Task 2); `PostgisSource`, `LayerCreate` (Task 3); `layer_service.create_layer` (Task 4).
- Produces:
  - `app.db.identifiers.validate_identifier(name: str) -> str` (raises `InvalidRequestError`), `quote(name: str) -> str` → `"name"`, `qualified(schema: str, table: str) -> str` → `"schema"."table"`, `quote_list(names: Iterable[str]) -> str` → `"a", "b"`.
  - `app.repositories.catalog_repository`: `async list_geometry_tables(session) -> list[GeometryTableRow]`, `find_primary_key(session, schema, table) -> str | None`, `table_exists(session, schema, table) -> bool`, `column_exists(session, schema, table, column) -> bool`, `compute_extent_4326(session, source) -> list[float] | None`, `count_rows(session, source) -> int`, `list_columns(session, schema, table) -> list[ColumnRow]`.
  - `app.schemas.catalog.GeometryTableInfo(schema_name, table_name, geometry_column, srid, geometry_type, primary_key, estimated_rows)`, `RegisterTableRequest(schema_name, table_name, geometry_column, id_column, name)`, `ColumnInfo(name, data_type, nullable, editable)`.
  - `app.services.catalog_service`: `async list_tables(session) -> list[GeometryTableInfo]`, `verify_source(session, source) -> None` (**the second gate: catalog existence**; every task that runs dynamic SQL calls this), `register_table(session, project_id, request) -> Layer`.
  - Endpoints: `GET /connections/postgis/tables`, `POST /projects/{project_id}/layers/from-postgis`.
  - Test fixture `seeded_spatial_table` (in `tests/fixtures/spatial.py`, re-exported from `conftest.py`) creating `gis_data.test_cities` with columns `fid` (PK), `name` (text), `population` (int), `geometry` (Point, 4326) and 3 rows; yields a `PostgisSource`. **Tasks 8, 9, 10 and 13 all build on this fixture.**

- [ ] **Step 1: Write the failing identifier tests**

`gis-platform/backend/tests/test_identifiers.py`:

```python
import pytest

from app.core.errors import InvalidRequestError
from app.db.identifiers import qualified, quote, quote_list, validate_identifier


@pytest.mark.parametrize("name", ["roads", "_private", "a1", "gis_data", "x" * 63])
def test_accepts_plain_lowercase_identifiers(name: str) -> None:
    assert validate_identifier(name) == name


@pytest.mark.parametrize(
    "name",
    [
        "",
        "1roads",
        "Roads",
        "roads;DROP TABLE gis.layer",
        'roads" OR "1"="1',
        "roads-2",
        "roads table",
        "x" * 64,
        "café",
    ],
)
def test_rejects_anything_else(name: str) -> None:
    with pytest.raises(InvalidRequestError):
        validate_identifier(name)


def test_rejects_non_string_input() -> None:
    with pytest.raises(InvalidRequestError):
        validate_identifier(None)  # type: ignore[arg-type]


def test_quote_wraps_in_double_quotes() -> None:
    assert quote("roads") == '"roads"'


def test_qualified_builds_schema_qualified_name() -> None:
    assert qualified("gis_data", "roads") == '"gis_data"."roads"'


def test_quote_list_joins_validated_names() -> None:
    assert quote_list(["fid", "name"]) == '"fid", "name"'


def test_quote_list_rejects_a_poisoned_entry() -> None:
    with pytest.raises(InvalidRequestError):
        quote_list(["fid", 'name" , (SELECT 1) AS "x'])
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pytest tests/test_identifiers.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.db.identifiers'`.

- [ ] **Step 3: Implement `app/db/identifiers.py`**

```python
"""The only sanctioned way to put a user-supplied name into SQL.

Table and column names cannot be bind parameters, so they must be
interpolated. That is safe here only because `validate_identifier` accepts
a deliberately tiny grammar — lowercase ASCII, digits and underscore, max
63 characters, never starting with a digit. Anything else is rejected
outright rather than escaped, so there is no escaping bug to get wrong.

This is gate one of two. Gate two is `catalog_service.verify_source`,
which confirms the name actually exists in the catalog.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

from app.core.errors import InvalidRequestError

_IDENTIFIER = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")


def validate_identifier(name: str) -> str:
    if not isinstance(name, str) or _IDENTIFIER.fullmatch(name) is None:
        raise InvalidRequestError(
            "Invalid SQL identifier",
            details={
                "value": name if isinstance(name, str) else repr(name),
                "expected": "lowercase letters, digits and underscore; 1-63 chars; "
                "must not start with a digit",
            },
        )
    return name


def quote(name: str) -> str:
    return f'"{validate_identifier(name)}"'


def qualified(schema: str, table: str) -> str:
    return f"{quote(schema)}.{quote(table)}"


def quote_list(names: Iterable[str]) -> str:
    return ", ".join(quote(name) for name in names)
```

- [ ] **Step 4: Run the identifier tests and confirm they pass**

Run: `pytest tests/test_identifiers.py -v`
Expected: 18 passed (parametrised cases counted individually).

- [ ] **Step 5: Add the spatial test fixture**

`gis-platform/backend/tests/fixtures/spatial.py`:

```python
"""A real PostGIS table for the tests that exercise dynamic SQL."""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.source import PostgisSource

CREATE = """
CREATE TABLE gis_data.test_cities (
    fid        serial PRIMARY KEY,
    name       text NOT NULL,
    population integer,
    geometry   geometry(Point, 4326)
)
"""

SEED = """
INSERT INTO gis_data.test_cities (name, population, geometry) VALUES
    ('Beijing',  21540000, ST_SetSRID(ST_MakePoint(116.4074, 39.9042), 4326)),
    ('Shanghai', 24870000, ST_SetSRID(ST_MakePoint(121.4737, 31.2304), 4326)),
    ('Lhasa',      560000, ST_SetSRID(ST_MakePoint( 91.1409, 29.6450), 4326))
"""


@pytest_asyncio.fixture
async def seeded_spatial_table(db_session: AsyncSession) -> AsyncIterator[PostgisSource]:
    await db_session.execute(text("DROP TABLE IF EXISTS gis_data.test_cities"))
    await db_session.execute(text(CREATE))
    await db_session.execute(text(SEED))
    await db_session.execute(
        text("CREATE INDEX ix_test_cities_geometry ON gis_data.test_cities USING GIST (geometry)")
    )
    await db_session.flush()
    yield PostgisSource(
        schema_name="gis_data",
        table_name="test_cities",
        geometry_column="geometry",
        id_column="fid",
        srid=4326,
    )
    # The outer transaction rollback in `db_connection` removes the table.
```

Add to the bottom of `tests/conftest.py`:

```python
from tests.fixtures.spatial import seeded_spatial_table  # noqa: E402, F401
```

- [ ] **Step 6: Write the failing catalog API test**

`gis-platform/backend/tests/test_catalog_api.py`:

```python
from httpx import AsyncClient

from app.schemas.source import PostgisSource


async def test_lists_geometry_tables_including_the_seeded_one(
    client: AsyncClient, seeded_spatial_table: PostgisSource
) -> None:
    response = await client.get("/api/v1/connections/postgis/tables")
    assert response.status_code == 200
    tables = response.json()
    match = next(t for t in tables if t["tableName"] == "test_cities")
    assert match["schemaName"] == "gis_data"
    assert match["geometryColumn"] == "geometry"
    assert match["srid"] == 4326
    assert match["geometryType"] == "POINT"
    assert match["primaryKey"] == "fid"


async def test_catalog_hides_postgis_internal_schemas(client: AsyncClient) -> None:
    tables = (await client.get("/api/v1/connections/postgis/tables")).json()
    assert all(t["schemaName"] not in {"topology", "tiger", "pg_catalog"} for t in tables)


async def test_register_table_creates_a_layer_with_extent_and_count(
    client: AsyncClient, seeded_spatial_table: PostgisSource
) -> None:
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/from-postgis",
        json={
            "schemaName": "gis_data",
            "tableName": "test_cities",
            "geometryColumn": "geometry",
            "idColumn": "fid",
            "name": "Cities",
        },
    )
    assert response.status_code == 201
    layer = response.json()
    assert layer["kind"] == "vector"
    assert layer["srid"] == 4326
    assert layer["featureCount"] == 3
    assert layer["geometryType"] == "POINT"
    minx, miny, maxx, maxy = layer["extent"]
    assert 91.0 < minx < 91.2
    assert 29.6 < miny < 29.7
    assert 121.4 < maxx < 121.5
    assert 39.9 < maxy < 40.0
    assert layer["source"]["type"] == "postgis"


async def test_register_rejects_an_unknown_table(client: AsyncClient) -> None:
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/from-postgis",
        json={
            "schemaName": "gis_data",
            "tableName": "no_such_table",
            "geometryColumn": "geometry",
            "idColumn": "fid",
            "name": "Nope",
        },
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_register_rejects_an_unknown_geometry_column(
    client: AsyncClient, seeded_spatial_table: PostgisSource
) -> None:
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/from-postgis",
        json={
            "schemaName": "gis_data",
            "tableName": "test_cities",
            "geometryColumn": "shape",
            "idColumn": "fid",
            "name": "Nope",
        },
    )
    assert response.status_code == 404


async def test_register_rejects_an_injection_shaped_name(client: AsyncClient) -> None:
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/from-postgis",
        json={
            "schemaName": "gis_data",
            "tableName": "test_cities; DROP TABLE gis.layer",
            "geometryColumn": "geometry",
            "idColumn": "fid",
            "name": "Evil",
        },
    )
    assert response.status_code == 422
    # And the platform tables are still there.
    assert (await client.get("/api/v1/projects")).status_code == 200
```

- [ ] **Step 7: Run it and confirm it fails**

Run: `pytest tests/test_catalog_api.py -v`
Expected: FAIL — 404 on `/api/v1/connections/postgis/tables`.

- [ ] **Step 8: Implement `app/schemas/catalog.py`**

```python
from __future__ import annotations

from pydantic import Field

from app.schemas.base import APIModel

IDENT = Field(pattern=r"^[a-z_][a-z0-9_]{0,62}$")


class GeometryTableInfo(APIModel):
    schema_name: str
    table_name: str
    geometry_column: str
    srid: int
    geometry_type: str
    primary_key: str | None
    estimated_rows: int


class RegisterTableRequest(APIModel):
    schema_name: str = IDENT
    table_name: str = IDENT
    geometry_column: str = IDENT
    id_column: str = IDENT
    name: str = Field(min_length=1, max_length=200)


class ColumnInfo(APIModel):
    name: str
    data_type: str
    nullable: bool
    editable: bool
```

- [ ] **Step 9: Implement `app/repositories/catalog_repository.py`**

```python
"""Reads of the PostgreSQL/PostGIS catalog, plus geometry statistics.

Everything here that interpolates a name has already passed
`validate_identifier`; values are always bind parameters.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.identifiers import qualified, quote
from app.schemas.catalog import ColumnInfo, GeometryTableInfo
from app.schemas.source import PostgisSource

HIDDEN_SCHEMAS = ("pg_catalog", "information_schema", "topology", "tiger", "tiger_data")

_LIST_TABLES = text(
    """
    SELECT g.f_table_schema  AS schema_name,
           g.f_table_name    AS table_name,
           g.f_geometry_column AS geometry_column,
           g.srid            AS srid,
           g.type            AS geometry_type,
           COALESCE(c.reltuples, 0)::bigint AS estimated_rows
    FROM geometry_columns g
    LEFT JOIN pg_class c
           ON c.oid = to_regclass(quote_ident(g.f_table_schema) || '.'
                                  || quote_ident(g.f_table_name))
    WHERE g.f_table_schema <> ALL(:hidden)
    ORDER BY g.f_table_schema, g.f_table_name
    """
)

_PRIMARY_KEY = text(
    """
    SELECT a.attname AS name
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = to_regclass(:qname) AND i.indisprimary
    ORDER BY a.attnum
    LIMIT 1
    """
)

_TABLE_EXISTS = text("SELECT to_regclass(:qname) IS NOT NULL AS present")

_COLUMNS = text(
    """
    SELECT column_name AS name,
           data_type   AS data_type,
           is_nullable = 'YES' AS nullable,
           is_generated = 'NEVER' AND identity_generation IS NULL AS editable
    FROM information_schema.columns
    WHERE table_schema = :schema AND table_name = :table
    ORDER BY ordinal_position
    """
)


async def list_geometry_tables(session: AsyncSession) -> list[GeometryTableInfo]:
    result = await session.execute(_LIST_TABLES, {"hidden": list(HIDDEN_SCHEMAS)})
    rows = result.mappings().all()
    tables: list[GeometryTableInfo] = []
    for row in rows:
        primary_key = await find_primary_key(session, row["schema_name"], row["table_name"])
        tables.append(
            GeometryTableInfo(
                schema_name=row["schema_name"],
                table_name=row["table_name"],
                geometry_column=row["geometry_column"],
                srid=row["srid"],
                geometry_type=row["geometry_type"],
                primary_key=primary_key,
                estimated_rows=max(int(row["estimated_rows"]), 0),
            )
        )
    return tables


async def find_primary_key(session: AsyncSession, schema: str, table: str) -> str | None:
    result = await session.execute(_PRIMARY_KEY, {"qname": qualified(schema, table)})
    row = result.mappings().one_or_none()
    return None if row is None else str(row["name"])


async def table_exists(session: AsyncSession, schema: str, table: str) -> bool:
    result = await session.execute(_TABLE_EXISTS, {"qname": qualified(schema, table)})
    return bool(result.scalar_one())


async def list_columns(session: AsyncSession, schema: str, table: str) -> list[ColumnInfo]:
    result = await session.execute(
        _COLUMNS, {"schema": validate_schema(schema), "table": validate_table(table)}
    )
    return [ColumnInfo.model_validate(dict(row)) for row in result.mappings().all()]


def validate_schema(schema: str) -> str:
    from app.db.identifiers import validate_identifier

    return validate_identifier(schema)


def validate_table(table: str) -> str:
    from app.db.identifiers import validate_identifier

    return validate_identifier(table)


async def geometry_metadata(
    session: AsyncSession, source: PostgisSource
) -> dict[str, Any] | None:
    """SRID and geometry type as declared in geometry_columns."""
    result = await session.execute(
        text(
            """
            SELECT srid, type AS geometry_type
            FROM geometry_columns
            WHERE f_table_schema = :schema
              AND f_table_name = :table
              AND f_geometry_column = :geom
            """
        ),
        {
            "schema": source.schema_name,
            "table": source.table_name,
            "geom": source.geometry_column,
        },
    )
    row = result.mappings().one_or_none()
    return None if row is None else dict(row)


async def compute_extent_4326(
    session: AsyncSession, source: PostgisSource
) -> list[float] | None:
    """Bounding box in EPSG:4326, or None for an empty / all-null table."""
    sql = text(
        f"""
        SELECT ST_XMin(box) AS minx, ST_YMin(box) AS miny,
               ST_XMax(box) AS maxx, ST_YMax(box) AS maxy
        FROM (
            SELECT ST_Extent(ST_Transform({quote(source.geometry_column)}, 4326)) AS box
            FROM {qualified(source.schema_name, source.table_name)}
        ) AS extent
        """
    )
    row = (await session.execute(sql)).mappings().one()
    if row["minx"] is None:
        return None
    return [float(row["minx"]), float(row["miny"]), float(row["maxx"]), float(row["maxy"])]


async def count_rows(session: AsyncSession, source: PostgisSource) -> int:
    sql = text(f"SELECT count(*) FROM {qualified(source.schema_name, source.table_name)}")
    return int((await session.execute(sql)).scalar_one())
```

- [ ] **Step 10: Implement `app/services/catalog_service.py`**

```python
from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFoundError
from app.models.layer import Layer
from app.repositories import catalog_repository
from app.schemas.catalog import GeometryTableInfo, RegisterTableRequest
from app.schemas.layer import LayerCreate
from app.schemas.source import PostgisSource
from app.services import layer_service


async def list_tables(session: AsyncSession) -> list[GeometryTableInfo]:
    return await catalog_repository.list_geometry_tables(session)


async def verify_source(session: AsyncSession, source: PostgisSource) -> None:
    """Gate two: the validated names must actually name a real table and columns.

    Called by every service that runs dynamic SQL against a layer's table, so
    a layer whose table was dropped fails with 404 instead of a SQL error.
    """
    if not await catalog_repository.table_exists(
        session, source.schema_name, source.table_name
    ):
        raise NotFoundError(
            f"Table {source.schema_name}.{source.table_name} does not exist",
            details={"schemaName": source.schema_name, "tableName": source.table_name},
        )
    columns = {
        column.name
        for column in await catalog_repository.list_columns(
            session, source.schema_name, source.table_name
        )
    }
    missing = {source.geometry_column, source.id_column} - columns
    if missing:
        raise NotFoundError(
            "Column not found on table",
            details={
                "schemaName": source.schema_name,
                "tableName": source.table_name,
                "missing": sorted(missing),
            },
        )


async def register_table(
    session: AsyncSession, project_id: uuid.UUID, request: RegisterTableRequest
) -> Layer:
    probe = PostgisSource(
        schema_name=request.schema_name,
        table_name=request.table_name,
        geometry_column=request.geometry_column,
        id_column=request.id_column,
        srid=4326,
    )
    await verify_source(session, probe)

    metadata = await catalog_repository.geometry_metadata(session, probe)
    if metadata is None:
        raise NotFoundError(
            "Column is not registered in geometry_columns",
            details={
                "schemaName": request.schema_name,
                "tableName": request.table_name,
                "geometryColumn": request.geometry_column,
            },
        )

    source = probe.model_copy(update={"srid": int(metadata["srid"])})
    extent = await catalog_repository.compute_extent_4326(session, source)
    feature_count = await catalog_repository.count_rows(session, source)

    layer = await layer_service.create_layer(
        session,
        project_id,
        LayerCreate(name=request.name, kind="vector", source=source),
    )
    from app.repositories import layer_repository

    layer = await layer_repository.update(
        session,
        layer,
        srid=source.srid,
        geometry_type=str(metadata["geometry_type"]),
        extent=extent,
        feature_count=feature_count,
    )
    await session.commit()
    await session.refresh(layer)
    return layer
```

- [ ] **Step 11: Implement `app/api/v1/routes/catalog.py` and register it**

```python
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
from app.schemas.catalog import GeometryTableInfo, RegisterTableRequest
from app.schemas.layer import LayerRead
from app.services import catalog_service

router = APIRouter(tags=["catalog"])


@router.get("/connections/postgis/tables", response_model=list[GeometryTableInfo])
async def list_postgis_tables(
    session: AsyncSession = Depends(get_session),
) -> list[GeometryTableInfo]:
    return await catalog_service.list_tables(session)


@router.post(
    "/projects/{project_id}/layers/from-postgis",
    response_model=LayerRead,
    status_code=status.HTTP_201_CREATED,
)
async def register_postgis_table(
    project_id: uuid.UUID,
    payload: RegisterTableRequest,
    session: AsyncSession = Depends(get_session),
) -> LayerRead:
    layer = await catalog_service.register_table(session, project_id, payload)
    return LayerRead.model_validate(layer)
```

Add `catalog` to `app/api/v1/router.py`'s imports and `include_router` calls.

- [ ] **Step 12: Run the catalog tests and confirm they pass**

Run: `pytest tests/test_catalog_api.py -v`
Expected: 6 passed.

If `test_register_rejects_an_injection_shaped_name` returns 404 instead of 422, the `RegisterTableRequest` `pattern` is missing — Pydantic must reject it before any service code runs.

- [ ] **Step 13: Run the full gate and commit**

Run: `pytest -v && ruff check . && ruff format --check . && mypy app`
Expected: all green.

```bash
cd gis-platform
git add backend/app/db/identifiers.py backend/app/repositories/catalog_repository.py \
        backend/app/services/catalog_service.py backend/app/schemas/catalog.py \
        backend/app/api/v1/routes/catalog.py backend/app/api/v1/router.py backend/tests
git commit -m "feat: add validated dynamic SQL identifiers and PostGIS catalog introspection"
```

- [ ] **Step 14: Write `gis-platform/docs/03-postgis-and-dynamic-sql.md`**

Sections and required content:
- `# 03 · PostGIS and Dynamic SQL` — the core problem stated plainly: this application does not know its own table names at compile time, because the tables belong to the user.
- `## Why bind parameters are not enough` — show that `SELECT * FROM :table` is not valid SQL, so the name must be interpolated, and that interpolation is where injection lives.
- `## Gate one: an allowlist grammar` — paste `validate_identifier` and its regex. Emphasise *reject, don't escape*: there is no escaping code to get wrong. Paste the parametrised rejection test as evidence.
- `## Gate two: catalog existence` — paste `verify_source` and explain that it turns a dropped table into a clean 404 and blocks any name that passed the regex but names nothing.
- `## Reading the catalog` — paste `_LIST_TABLES` and explain `geometry_columns` (a PostGIS view), `to_regclass` (returns NULL instead of raising for unknown names), and `pg_class.reltuples` (an estimate, hence `estimatedRows`).
- `## Finding the primary key` — paste `_PRIMARY_KEY` and explain why editing needs a stable single-column key.
- `## Extent and count` — paste `compute_extent_4326`, explain `ST_Extent` + `ST_Transform` to 4326 and why the wire is always 4326 (Global Constraints).
- `## The rule` — restate: *validated identifier + catalog check + bind parameters for values*. Every later chapter that writes SQL refers back here.

---

## Task 6: Vector File Import into PostGIS

**Files:**
- Create: `gis-platform/backend/app/db/sync_engine.py`
- Create: `gis-platform/backend/app/services/upload_service.py`
- Create: `gis-platform/backend/app/services/vector_import_service.py`
- Create: `gis-platform/backend/app/api/v1/routes/imports.py`
- Modify: `gis-platform/backend/app/api/v1/router.py`
- Test: `gis-platform/backend/tests/test_upload_service.py`, `gis-platform/backend/tests/test_vector_import.py`

**Interfaces:**
- Consumes: `Settings` (Task 1); `PayloadTooLargeError`, `UnsupportedFormatError`, `UpstreamDataError`, `InvalidRequestError` (Task 1); `validate_identifier` (Task 5); `catalog_repository`, `catalog_service.verify_source` (Task 5); `layer_service.create_layer` (Task 4).
- Produces:
  - `app.db.sync_engine.get_sync_engine() -> Engine` — a lazily-built, `NullPool` SQLAlchemy **sync** engine on the `postgresql+psycopg://` URL, used only by geopandas bulk writes.
  - `app.services.upload_service.save_upload(upload: UploadFile, dest_dir: Path, max_bytes: int) -> Path` — streams to disk in 1 MiB chunks, raises `PayloadTooLargeError` past the cap, returns the written path.
  - `app.services.upload_service.slugify_table_name(filename: str) -> str` — lowercase ASCII slug, `_`-separated, truncated to 40 chars, prefixed `t_` if it would start with a digit, suffixed with an 8-char uuid hex; always passes `validate_identifier`.
  - `app.services.vector_import_service.import_vector_file(session, project_id, upload, layer_name) -> Layer` — writes `gis_data.<slug>` and returns the created `Layer`.
  - Endpoint `POST /projects/{project_id}/layers/import` (multipart: `file`, optional `name`).

- [ ] **Step 1: Write the failing upload-service tests**

`gis-platform/backend/tests/test_upload_service.py`:

```python
import io
from pathlib import Path

import pytest
from fastapi import UploadFile

from app.core.errors import PayloadTooLargeError
from app.db.identifiers import validate_identifier
from app.services.upload_service import save_upload, slugify_table_name


def _upload(name: str, payload: bytes) -> UploadFile:
    return UploadFile(filename=name, file=io.BytesIO(payload))


async def test_save_upload_writes_bytes_and_keeps_the_extension(tmp_path: Path) -> None:
    path = await save_upload(_upload("cities.geojson", b"{}"), tmp_path, max_bytes=1024)
    assert path.parent == tmp_path
    assert path.suffix == ".geojson"
    assert path.read_bytes() == b"{}"


async def test_save_upload_rejects_oversize_payloads_before_finishing(tmp_path: Path) -> None:
    with pytest.raises(PayloadTooLargeError):
        await save_upload(_upload("big.geojson", b"x" * 5000), tmp_path, max_bytes=1024)
    assert list(tmp_path.iterdir()) == []  # partial file is cleaned up


async def test_save_upload_rejects_a_traversal_filename(tmp_path: Path) -> None:
    path = await save_upload(_upload("../../evil.geojson", b"{}"), tmp_path, max_bytes=1024)
    assert path.parent == tmp_path
    assert ".." not in path.name


@pytest.mark.parametrize(
    ("filename", "prefix"),
    [
        ("Cities of China.geojson", "cities_of_china_"),
        ("2024-roads.zip", "t_2024_roads_"),
        ("café.gpkg", "caf_"),
    ],
)
def test_slugify_produces_a_valid_unique_identifier(filename: str, prefix: str) -> None:
    name = slugify_table_name(filename)
    assert validate_identifier(name) == name
    assert name.startswith(prefix)
    assert name != slugify_table_name(filename)  # uuid suffix makes it unique


def test_slugify_truncates_long_names() -> None:
    name = slugify_table_name("a" * 200 + ".geojson")
    assert len(name) <= 63
    assert validate_identifier(name) == name
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pytest tests/test_upload_service.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.upload_service'`.

- [ ] **Step 3: Implement `app/services/upload_service.py`**

```python
"""Streaming upload to disk, plus safe table-name derivation.

Uploads are never read fully into memory: a 2 GB GeoTIFF must not become a
2 GB bytes object. The size cap is enforced while streaming, so a hostile
client cannot fill the disk by lying about Content-Length.
"""

from __future__ import annotations

import re
import unicodedata
import uuid
from pathlib import Path

from fastapi import UploadFile

from app.core.errors import PayloadTooLargeError
from app.db.identifiers import validate_identifier

CHUNK_SIZE = 1024 * 1024
_NON_WORD = re.compile(r"[^a-z0-9]+")
_MAX_SLUG_BODY = 40


async def save_upload(upload: UploadFile, dest_dir: Path, max_bytes: int) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    original = Path(upload.filename or "upload.bin").name  # strips any traversal
    suffix = "".join(Path(original).suffixes[-2:])  # keeps .shp.zip style pairs
    target = dest_dir / f"{uuid.uuid4().hex}{suffix or Path(original).suffix}"

    written = 0
    try:
        with target.open("wb") as sink:
            while chunk := await upload.read(CHUNK_SIZE):
                written += len(chunk)
                if written > max_bytes:
                    raise PayloadTooLargeError(
                        "Upload exceeds the configured size limit",
                        details={"maxBytes": max_bytes},
                    )
                sink.write(chunk)
    except Exception:
        target.unlink(missing_ok=True)
        raise
    return target


def slugify_table_name(filename: str) -> str:
    """Derive a guaranteed-valid, collision-free table name from a filename."""
    stem = Path(Path(filename).name).stem
    ascii_stem = unicodedata.normalize("NFKD", stem).encode("ascii", "ignore").decode()
    body = _NON_WORD.sub("_", ascii_stem.lower()).strip("_")[:_MAX_SLUG_BODY]
    if not body:
        body = "layer"
    if body[0].isdigit():
        body = f"t_{body}"
    return validate_identifier(f"{body}_{uuid.uuid4().hex[:8]}")
```

- [ ] **Step 4: Run the upload tests and confirm they pass**

Run: `pytest tests/test_upload_service.py -v`
Expected: 8 passed.

Note on `test_slugify_produces_a_valid_unique_identifier` with `café.gpkg`: NFKD normalisation drops the accent to `cafe`, so assert `caf_`-prefixed only if that matches; if the implementation yields `cafe_`, update the parametrise entry to `"cafe_"` — the test documents real behaviour, so fix whichever side is wrong after observing it once.

- [ ] **Step 5: Implement `app/db/sync_engine.py`**

```python
"""A synchronous engine, used only for geopandas' bulk `to_postgis` write.

geopandas has no async path. Rather than reimplement its type mapping, the
import runs on a worker thread against a short-lived sync engine. NullPool
keeps it from holding connections between imports.
"""

from __future__ import annotations

from functools import lru_cache

from sqlalchemy import Engine, create_engine
from sqlalchemy.pool import NullPool

from app.core.config import get_settings


@lru_cache
def get_sync_engine() -> Engine:
    url = get_settings().database_url.replace("+asyncpg", "+psycopg")
    return create_engine(url, poolclass=NullPool, future=True)
```

- [ ] **Step 6: Write the failing vector-import test**

`gis-platform/backend/tests/test_vector_import.py`:

```python
import json

import pytest
from httpx import AsyncClient

GEOJSON = {
    "type": "FeatureCollection",
    "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3/CRS84"}},
    "features": [
        {
            "type": "Feature",
            "properties": {"name": "Beijing", "population": 21540000},
            "geometry": {"type": "Point", "coordinates": [116.4074, 39.9042]},
        },
        {
            "type": "Feature",
            "properties": {"name": "Lhasa", "population": 560000},
            "geometry": {"type": "Point", "coordinates": [91.1409, 29.6450]},
        },
    ],
}


@pytest.fixture
async def project_id(client: AsyncClient) -> str:
    return (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]


async def test_import_geojson_creates_a_layer_backed_by_a_new_table(
    client: AsyncClient, project_id: str
) -> None:
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/import",
        files={"file": ("cities.geojson", json.dumps(GEOJSON), "application/geo+json")},
        data={"name": "Cities"},
    )
    assert response.status_code == 201, response.text
    layer = response.json()
    assert layer["kind"] == "vector"
    assert layer["name"] == "Cities"
    assert layer["featureCount"] == 2
    assert layer["srid"] == 4326
    assert layer["geometryType"].endswith("POINT")
    assert layer["source"]["type"] == "postgis"
    assert layer["source"]["schemaName"] == "gis_data"
    assert layer["source"]["tableName"].startswith("cities_")
    assert layer["source"]["idColumn"] == "fid"
    assert layer["extent"][0] == pytest.approx(91.1409, abs=1e-4)


async def test_imported_table_is_queryable_through_the_catalog(
    client: AsyncClient, project_id: str
) -> None:
    layer = (
        await client.post(
            f"/api/v1/projects/{project_id}/layers/import",
            files={"file": ("cities.geojson", json.dumps(GEOJSON), "application/geo+json")},
        )
    ).json()
    tables = (await client.get("/api/v1/connections/postgis/tables")).json()
    match = next(t for t in tables if t["tableName"] == layer["source"]["tableName"])
    assert match["primaryKey"] == "fid"
    assert match["srid"] == 4326


async def test_import_defaults_the_layer_name_to_the_filename(
    client: AsyncClient, project_id: str
) -> None:
    layer = (
        await client.post(
            f"/api/v1/projects/{project_id}/layers/import",
            files={"file": ("my cities.geojson", json.dumps(GEOJSON), "application/geo+json")},
        )
    ).json()
    assert layer["name"] == "my cities"


async def test_import_rejects_an_unsupported_extension(
    client: AsyncClient, project_id: str
) -> None:
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/import",
        files={"file": ("notes.txt", b"hello", "text/plain")},
    )
    assert response.status_code == 415
    assert response.json()["error"]["code"] == "unsupported_format"


async def test_import_rejects_a_file_with_no_crs(client: AsyncClient, project_id: str) -> None:
    crsless = {"type": "FeatureCollection", "features": GEOJSON["features"]}
    payload = json.dumps(crsless)
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/import",
        files={"file": ("nocrs.geojson", payload, "application/geo+json")},
    )
    # GeoJSON without a CRS member is CRS84 by spec, so this must succeed.
    assert response.status_code == 201
    assert response.json()["srid"] == 4326


async def test_import_rejects_unreadable_content(client: AsyncClient, project_id: str) -> None:
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/import",
        files={"file": ("broken.geojson", b"{not json", "application/geo+json")},
    )
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "upstream_data_error"
```

**Important:** these tests write to `gis_data` through a *separate* sync connection, so the outer-transaction rollback in `db_session` cannot undo the created table. The import service must therefore drop its table on failure, and the test module must clean up. Add this fixture at the top of the test module:

```python
@pytest.fixture(autouse=True)
async def drop_imported_tables():
    yield
    from sqlalchemy import text

    from app.db.sync_engine import get_sync_engine

    with get_sync_engine().begin() as conn:
        rows = conn.execute(
            text(
                "SELECT tablename FROM pg_tables "
                "WHERE schemaname = 'gis_data' AND tablename <> 'test_cities'"
            )
        ).scalars().all()
        for table in rows:
            conn.execute(text(f'DROP TABLE IF EXISTS gis_data."{table}" CASCADE'))
```

No configuration change is needed: `get_sync_engine()` derives its URL from the same `Settings.database_url` that `conftest.py` already asserts points at `gis_platform_test` (see **Global Constraints → Test database**). Both engines therefore target the test database automatically.

- [ ] **Step 7: Run it and confirm it fails**

Run: `pytest tests/test_vector_import.py -v`
Expected: FAIL — 404 on the import route.

- [ ] **Step 8: Implement `app/services/vector_import_service.py`**

```python
"""Read a vector file with pyogrio/geopandas and land it in gis_data.

Everything blocking (GDAL reads, the bulk INSERT) runs on a worker thread.
The table is created first and the layer row second; if the layer row fails
the table is dropped, so a failed import leaves nothing behind.
"""

from __future__ import annotations

import logging
import shutil
import uuid
import zipfile
from pathlib import Path
from typing import Any

import anyio
import geopandas as gpd
from fastapi import UploadFile
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import UnsupportedFormatError, UpstreamDataError
from app.db.identifiers import qualified, quote
from app.db.sync_engine import get_sync_engine
from app.models.layer import Layer
from app.repositories import catalog_repository, layer_repository
from app.schemas.layer import LayerCreate
from app.schemas.source import PostgisSource
from app.services import layer_service
from app.services.upload_service import save_upload, slugify_table_name

logger = logging.getLogger(__name__)

SUPPORTED_SUFFIXES = {".geojson", ".json", ".gpkg", ".zip", ".shp", ".gml", ".kml"}
GEOMETRY_COLUMN = "geometry"
ID_COLUMN = "fid"


def _resolve_dataset_path(path: Path) -> Path:
    """Unzip a shapefile/gpkg bundle and return the actual dataset to open."""
    if path.suffix.lower() != ".zip":
        return path
    extract_dir = path.with_suffix("")
    extract_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path) as archive:
        for member in archive.namelist():
            if Path(member).is_absolute() or ".." in Path(member).parts:
                raise UpstreamDataError("Archive contains an unsafe path", details={"entry": member})
        archive.extractall(extract_dir)
    for pattern in ("**/*.shp", "**/*.gpkg", "**/*.geojson"):
        matches = sorted(extract_dir.glob(pattern))
        if matches:
            return matches[0]
    raise UnsupportedFormatError(
        "Archive contains no .shp, .gpkg or .geojson dataset",
        details={"filename": path.name},
    )


def _read_and_write(path: Path, table_name: str) -> dict[str, Any]:
    """Blocking half of the import. Runs on a worker thread."""
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
    if frame.crs is None:
        frame = frame.set_crs(4326)  # GeoJSON without a CRS member is CRS84
    frame = frame.to_crs(4326)
    frame = frame.rename_geometry(GEOMETRY_COLUMN)

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
    qualified_name = qualified(settings.import_schema, table_name)
    with engine.begin() as conn:
        conn.execute(text(f"ALTER TABLE {qualified_name} ADD PRIMARY KEY ({quote(ID_COLUMN)})"))
        conn.execute(
            text(
                f"CREATE INDEX {quote('ix_' + table_name + '_geom')} "
                f"ON {qualified_name} USING GIST ({quote(GEOMETRY_COLUMN)})"
            )
        )
    return {
        "feature_count": int(len(frame)),
        "geometry_type": str(frame.geom_type.iloc[0]).upper(),
        "extent": [float(value) for value in frame.total_bounds],
    }


def _drop_table(table_name: str) -> None:
    settings = get_settings()
    with get_sync_engine().begin() as conn:
        conn.execute(text(f"DROP TABLE IF EXISTS {qualified(settings.import_schema, table_name)}"))


async def import_vector_file(
    session: AsyncSession,
    project_id: uuid.UUID,
    upload: UploadFile,
    layer_name: str | None,
) -> Layer:
    settings = get_settings()
    original_name = Path(upload.filename or "upload").name
    if Path(original_name).suffix.lower() not in SUPPORTED_SUFFIXES:
        raise UnsupportedFormatError(
            "Unsupported vector format",
            details={"filename": original_name, "supported": sorted(SUPPORTED_SUFFIXES)},
        )

    work_dir = settings.upload_tmp_dir / uuid.uuid4().hex
    saved = await save_upload(upload, work_dir, settings.upload_max_bytes)
    table_name = slugify_table_name(original_name)

    try:
        stats = await anyio.to_thread.run_sync(_read_and_write, saved, table_name)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

    source = PostgisSource(
        schema_name=settings.import_schema,
        table_name=table_name,
        geometry_column=GEOMETRY_COLUMN,
        id_column=ID_COLUMN,
        srid=4326,
    )
    try:
        layer = await layer_service.create_layer(
            session,
            project_id,
            LayerCreate(name=layer_name or Path(original_name).stem, kind="vector", source=source),
        )
        metadata = await catalog_repository.geometry_metadata(session, source)
        layer = await layer_repository.update(
            session,
            layer,
            srid=4326,
            geometry_type=(
                str(metadata["geometry_type"]) if metadata else stats["geometry_type"]
            ),
            extent=stats["extent"],
            feature_count=stats["feature_count"],
        )
        return layer
    except Exception:
        # The table was written on a separate SYNC connection and already
        # committed, so the request-scoped rollback cannot undo it. Drop it
        # explicitly or a failed import leaves an orphan table behind.
        logger.exception("Layer registration failed; dropping imported table %s", table_name)
        await anyio.to_thread.run_sync(_drop_table, table_name)
        raise
```

- [ ] **Step 9: Implement `app/api/v1/routes/imports.py` and register it**

```python
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, File, Form, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
from app.schemas.layer import LayerRead
from app.services import vector_import_service

router = APIRouter(prefix="/projects/{project_id}/layers", tags=["imports"])


@router.post("/import", response_model=LayerRead, status_code=status.HTTP_201_CREATED)
async def import_vector(
    project_id: uuid.UUID,
    file: UploadFile = File(..., description="GeoJSON, GeoPackage, or zipped Shapefile"),
    name: str | None = Form(default=None),
    session: AsyncSession = Depends(get_session),
) -> LayerRead:
    layer = await vector_import_service.import_vector_file(session, project_id, file, name)
    return LayerRead.model_validate(layer)
```

Register `imports.router` in `app/api/v1/router.py`.

- [ ] **Step 10: Run the import tests and confirm they pass**

Run: `pytest tests/test_vector_import.py -v`
Expected: 6 passed.

If `test_import_rejects_unreadable_content` returns 500 instead of 502, the GDAL exception is escaping `_read_and_write`'s `try` — widen the `except Exception` there.

- [ ] **Step 11: Run the full gate and commit**

Run: `pytest -v && ruff check . && ruff format --check . && mypy app`
Expected: all green.

```bash
cd gis-platform
git add backend/app/db/sync_engine.py backend/app/services/upload_service.py \
        backend/app/services/vector_import_service.py backend/app/api backend/tests
git commit -m "feat: import GeoJSON, GeoPackage and zipped Shapefiles into PostGIS"
```

---

## Task 7: Raster Import with COG Conversion

**Files:**
- Create: `gis-platform/backend/app/core/geo_env.py`
- Modify: `gis-platform/backend/app/__init__.py`
- Create: `gis-platform/backend/app/services/raster_import_service.py`
- Modify: `gis-platform/backend/app/api/v1/routes/imports.py`
- Test: `gis-platform/backend/tests/test_geo_env.py`, `gis-platform/backend/tests/test_raster_import.py`
- Create: `gis-platform/backend/tests/fixtures/raster.py`
- Modify: `gis-platform/backend/tests/conftest.py`

**Interfaces:**
- Consumes: `save_upload` (Task 6); `layer_service.create_layer` (Task 4); `RasterFileSource`, `RasterStyle` (Task 3); `Settings.raster_dir` (Task 1).
- Produces:
  - `app.core.geo_env.configure_proj() -> Path | None` — points `PROJ_LIB`/`PROJ_DATA` at rasterio's bundled `proj_data` and returns the path used (or `None` if the bundle is absent). Invoked from `app/__init__.py` so it runs before any `app.*` module imports rasterio.
  - `app.services.raster_import_service.import_raster_file(session, project_id, upload, layer_name) -> Layer` — validates with rasterio, converts to COG when needed, stores under `settings.raster_dir`, creates the layer with `RasterFileSource` and a `RasterStyle` whose `rescale` is seeded from band statistics.
  - `app.services.raster_import_service.resolve_raster_path(source: RasterFileSource) -> Path` — resolves `source.path` **inside** `settings.raster_dir` and raises `InvalidRequestError` on escape. **Task 12 uses this.**
  - Endpoint `POST /projects/{project_id}/layers/import-raster` (multipart: `file`, optional `name`).
  - Test fixture `sample_geotiff(tmp_path) -> Path` in `tests/fixtures/raster.py` — a 64×64 uint8 single-band GeoTIFF in EPSG:4326 covering `[100, 30, 101, 31]`.

- [ ] **Step 0a: Write the failing PROJ shim test**

`gis-platform/backend/tests/test_geo_env.py`:

```python
import os
import sysconfig
from pathlib import Path

from app.core.geo_env import configure_proj


def test_points_proj_at_the_bundled_rasterio_database() -> None:
    bundle = configure_proj()
    expected = Path(sysconfig.get_paths()["purelib"]) / "rasterio" / "proj_data"
    assert bundle == expected
    assert (bundle / "proj.db").is_file()
    assert os.environ["PROJ_LIB"] == str(expected)
    assert os.environ["PROJ_DATA"] == str(expected)


def test_is_idempotent() -> None:
    first = configure_proj()
    assert configure_proj() == first


def test_rasterio_can_resolve_epsg_codes_after_configuration() -> None:
    """The regression this shim exists for: a stale system PROJ_LIB makes
    every rasterio CRS lookup raise CRSError."""
    from rasterio.warp import transform_bounds

    minx, miny, maxx, maxy = transform_bounds("EPSG:4326", "EPSG:3857", 100, 30, 101, 31)
    assert 11_000_000 < minx < 11_300_000
    assert 3_400_000 < miny < 3_600_000
    assert maxx > minx
    assert maxy > miny
```

- [ ] **Step 0b: Run it and confirm it fails**

Run: `pytest tests/test_geo_env.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.core.geo_env'`.

- [ ] **Step 0c: Implement the shim and invoke it from the package root**

`gis-platform/backend/app/core/geo_env.py`:

```python
"""Make rasterio use the PROJ database shipped inside its own wheel.

A system-wide ``PROJ_LIB`` left behind by an unrelated GDAL/PROJ install --
PostgreSQL's bundled PostGIS is the usual culprit on Windows -- silently
wins over the wheel's own data directory. Every rasterio CRS lookup then
fails with "proj.db contains DATABASE.LAYOUT.VERSION.MINOR = 2 whereas a
number >= 6 is expected", which surfaces as an unhelpful CRSError deep
inside raster import or tiling.

This must run *before* rasterio is first imported: PROJ reads the variable
while building its context, so setting it afterwards has no effect. That is
why ``app/__init__.py`` calls it at package-import time rather than the
FastAPI lifespan, which runs far too late.

``pyproj`` (and therefore geopandas) is unaffected either way -- it resolves
its own bundled data independently -- so this narrows to rasterio and
rio-tiler.
"""

from __future__ import annotations

import os
import sysconfig
from pathlib import Path


def configure_proj() -> Path | None:
    """Point PROJ at rasterio's bundled database. Returns the path, or None."""
    bundle = Path(sysconfig.get_paths()["purelib"]) / "rasterio" / "proj_data"
    if not (bundle / "proj.db").is_file():
        return None
    os.environ["PROJ_LIB"] = str(bundle)
    os.environ["PROJ_DATA"] = str(bundle)
    return bundle
```

`gis-platform/backend/app/__init__.py` — replace its (empty) contents with:

```python
"""GIS platform backend.

The PROJ shim runs at package import, before any module can pull in
rasterio. See app/core/geo_env.py for why the ordering matters.
"""

from app.core.geo_env import configure_proj

configure_proj()
```

- [ ] **Step 0d: Run it and confirm it passes**

Run: `pytest tests/test_geo_env.py -v`
Expected: 3 passed.

Then confirm the shim did not disturb anything already built: `pytest`
Expected: every test from Tasks 1–6 still passes.

- [ ] **Step 1: Add the raster test fixture**

`gis-platform/backend/tests/fixtures/raster.py`:

```python
"""Synthesise a small GeoTIFF so raster tests need no binary assets in git."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_bounds

BOUNDS = (100.0, 30.0, 101.0, 31.0)
SIZE = 64


@pytest.fixture
def sample_geotiff(tmp_path: Path) -> Path:
    path = tmp_path / "sample.tif"
    data = np.tile(np.arange(SIZE, dtype="uint8"), (SIZE, 1))
    profile = {
        "driver": "GTiff",
        "height": SIZE,
        "width": SIZE,
        "count": 1,
        "dtype": "uint8",
        "crs": "EPSG:4326",
        "transform": from_bounds(*BOUNDS, SIZE, SIZE),
        "nodata": 0,
    }
    with rasterio.open(path, "w", **profile) as dataset:
        dataset.write(data, 1)
    return path


@pytest.fixture
def sample_geotiff_no_crs(tmp_path: Path) -> Path:
    path = tmp_path / "nocrs.tif"
    data = np.zeros((SIZE, SIZE), dtype="uint8")
    with rasterio.open(
        path, "w", driver="GTiff", height=SIZE, width=SIZE, count=1, dtype="uint8"
    ) as dataset:
        dataset.write(data, 1)
    return path
```

Add to `tests/conftest.py`:

```python
from tests.fixtures.raster import sample_geotiff, sample_geotiff_no_crs  # noqa: E402, F401
```

- [ ] **Step 2: Write the failing raster import test**

`gis-platform/backend/tests/test_raster_import.py`:

```python
from pathlib import Path

import pytest
import rasterio
from httpx import AsyncClient

from app.core.config import get_settings
from app.core.errors import InvalidRequestError
from app.schemas.source import RasterFileSource
from app.services.raster_import_service import resolve_raster_path


@pytest.fixture
async def project_id(client: AsyncClient) -> str:
    return (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]


async def test_import_geotiff_creates_a_raster_layer(
    client: AsyncClient, project_id: str, sample_geotiff: Path
) -> None:
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/import-raster",
        files={"file": ("sample.tif", sample_geotiff.read_bytes(), "image/tiff")},
        data={"name": "Elevation"},
    )
    assert response.status_code == 201, response.text
    layer = response.json()
    assert layer["kind"] == "raster"
    assert layer["name"] == "Elevation"
    assert layer["source"]["type"] == "rasterFile" or layer["source"]["type"] == "raster_file"
    assert layer["source"]["bandCount"] == 1
    assert layer["source"]["isCog"] is True
    assert layer["extent"] == pytest.approx([100.0, 30.0, 101.0, 31.0], abs=1e-6)
    assert layer["srid"] == 4326
    assert layer["style"]["kind"] == "raster"
    assert layer["style"]["bands"] == [1]
    assert layer["style"]["rescale"] is not None


async def test_imported_raster_is_a_valid_cog_on_disk(
    client: AsyncClient, project_id: str, sample_geotiff: Path
) -> None:
    layer = (
        await client.post(
            f"/api/v1/projects/{project_id}/layers/import-raster",
            files={"file": ("sample.tif", sample_geotiff.read_bytes(), "image/tiff")},
        )
    ).json()
    path = get_settings().raster_dir / Path(layer["source"]["path"]).name
    assert path.exists()
    with rasterio.open(path) as dataset:
        assert dataset.crs.to_epsg() == 4326
        assert dataset.count == 1


async def test_import_rejects_a_raster_without_a_crs(
    client: AsyncClient, project_id: str, sample_geotiff_no_crs: Path
) -> None:
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/import-raster",
        files={"file": ("nocrs.tif", sample_geotiff_no_crs.read_bytes(), "image/tiff")},
    )
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "upstream_data_error"


async def test_import_rejects_a_non_raster_extension(
    client: AsyncClient, project_id: str
) -> None:
    response = await client.post(
        f"/api/v1/projects/{project_id}/layers/import-raster",
        files={"file": ("cities.geojson", b"{}", "application/geo+json")},
    )
    assert response.status_code == 415


def test_resolve_raster_path_blocks_directory_escape() -> None:
    with pytest.raises(InvalidRequestError):
        resolve_raster_path(
            RasterFileSource(path="../../etc/passwd", band_count=1, is_cog=True)
        )


def test_resolve_raster_path_returns_a_path_inside_the_data_dir(
    client: AsyncClient,
) -> None:
    settings = get_settings()
    (settings.raster_dir / "ok.tif").parent.mkdir(parents=True, exist_ok=True)
    (settings.raster_dir / "ok.tif").write_bytes(b"")
    resolved = resolve_raster_path(RasterFileSource(path="ok.tif", band_count=1, is_cog=True))
    assert resolved == (settings.raster_dir / "ok.tif").resolve()
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pytest tests/test_raster_import.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.raster_import_service'`.

- [ ] **Step 4: Implement `app/services/raster_import_service.py`**

```python
"""Validate an uploaded raster, normalise it to a COG, and register a layer.

Cloud-Optimized GeoTIFF is not a nicety here: it is what makes
`/tiles/{z}/{x}/{y}.png` cheap. A COG has internal tiling and overviews, so
rio-tiler reads a few kilobytes per tile instead of decoding the whole
image. Non-COG uploads are converted once at import rather than paid for on
every tile request.
"""

from __future__ import annotations

import logging
import shutil
import uuid
from pathlib import Path
from typing import Any

import anyio
import rasterio
from fastapi import UploadFile
from rasterio.warp import transform_bounds
from rio_cogeo.cogeo import cog_translate, cog_validate
from rio_cogeo.profiles import cog_profiles
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import InvalidRequestError, UnsupportedFormatError, UpstreamDataError
from app.models.layer import Layer
from app.repositories import layer_repository
from app.schemas.layer import LayerCreate
from app.schemas.source import RasterFileSource
from app.schemas.style import RasterStyle
from app.services import layer_service
from app.services.upload_service import save_upload

logger = logging.getLogger(__name__)

SUPPORTED_SUFFIXES = {".tif", ".tiff", ".vrt", ".img", ".jp2"}


def resolve_raster_path(source: RasterFileSource) -> Path:
    """Turn a stored relative path into an absolute one, refusing to escape."""
    root = get_settings().raster_dir.resolve()
    candidate = (root / source.path).resolve()
    if not candidate.is_relative_to(root):
        raise InvalidRequestError(
            "Raster path escapes the data directory", details={"path": source.path}
        )
    return candidate


def _inspect_and_normalise(saved: Path, target: Path) -> dict[str, Any]:
    """Blocking half: validate, convert to COG, read stats. Worker thread."""
    try:
        with rasterio.open(saved) as dataset:
            if dataset.crs is None:
                raise UpstreamDataError(
                    "Raster has no CRS; cannot place it on a map",
                    details={"filename": saved.name},
                )
            bounds_4326 = transform_bounds(dataset.crs, "EPSG:4326", *dataset.bounds, densify_pts=21)
            band_count = int(dataset.count)
            nodata = None if dataset.nodata is None else float(dataset.nodata)
            statistics = [dataset.statistics(band, approx=True) for band in dataset.indexes]
    except UpstreamDataError:
        raise
    except Exception as exc:
        raise UpstreamDataError(
            "Could not read the uploaded raster",
            details={"filename": saved.name, "reason": str(exc)[:400]},
        ) from exc

    target.parent.mkdir(parents=True, exist_ok=True)
    already_cog, _errors, _warnings = cog_validate(saved, quiet=True)
    if already_cog:
        shutil.copyfile(saved, target)
    else:
        logger.info("Converting %s to COG", saved.name)
        cog_translate(saved, target, cog_profiles.get("deflate"), quiet=True, in_memory=False)

    return {
        "band_count": band_count,
        "nodata": nodata,
        "extent": [float(value) for value in bounds_4326],
        "rescale": [(float(stat.min), float(stat.max)) for stat in statistics],
    }


async def import_raster_file(
    session: AsyncSession,
    project_id: uuid.UUID,
    upload: UploadFile,
    layer_name: str | None,
) -> Layer:
    settings = get_settings()
    original_name = Path(upload.filename or "upload").name
    if Path(original_name).suffix.lower() not in SUPPORTED_SUFFIXES:
        raise UnsupportedFormatError(
            "Unsupported raster format",
            details={"filename": original_name, "supported": sorted(SUPPORTED_SUFFIXES)},
        )

    work_dir = settings.upload_tmp_dir / uuid.uuid4().hex
    saved = await save_upload(upload, work_dir, settings.upload_max_bytes)
    stored_name = f"{uuid.uuid4().hex}.tif"
    target = settings.raster_dir / stored_name

    try:
        info = await anyio.to_thread.run_sync(_inspect_and_normalise, saved, target)
    except Exception:
        target.unlink(missing_ok=True)
        raise
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

    source = RasterFileSource(
        path=stored_name,
        band_count=info["band_count"],
        nodata=info["nodata"],
        is_cog=True,
    )
    style = RasterStyle(bands=[1], rescale=[info["rescale"][0]])

    try:
        layer = await layer_service.create_layer(
            session,
            project_id,
            LayerCreate(
                name=layer_name or Path(original_name).stem,
                kind="raster",
                source=source,
                style=style,
            ),
        )
        layer = await layer_repository.update(
            session, layer, srid=4326, extent=info["extent"], geometry_type=None
        )
        return layer
    except Exception:
        # The COG is already on disk and no database rollback removes it.
        target.unlink(missing_ok=True)
        raise
```

- [ ] **Step 5: Add the route**

Append to `app/api/v1/routes/imports.py`:

```python
from app.services import raster_import_service


@router.post("/import-raster", response_model=LayerRead, status_code=status.HTTP_201_CREATED)
async def import_raster(
    project_id: uuid.UUID,
    file: UploadFile = File(..., description="GeoTIFF / COG"),
    name: str | None = Form(default=None),
    session: AsyncSession = Depends(get_session),
) -> LayerRead:
    layer = await raster_import_service.import_raster_file(session, project_id, file, name)
    return LayerRead.model_validate(layer)
```

- [ ] **Step 6: Run the raster tests and confirm they pass**

Run: `pytest tests/test_raster_import.py -v`
Expected: 6 passed.

Two likely mismatches to settle now, once, against observed behaviour:
- `layer["source"]["type"]`: `to_camel` turns the *field names* camelCase but `type` is a `Literal` **value**, so it stays `"raster_file"`. Delete the `or` from the assertion and keep `== "raster_file"`.
- `cog_validate` returns a 3-tuple in rio-cogeo ≥ 5; if the installed version returns a bool, adjust the unpacking.

- [ ] **Step 7: Add a cleanup fixture so imported rasters do not accumulate**

Add to `tests/conftest.py`:

```python
@pytest.fixture(autouse=True)
def _clean_raster_dir() -> Iterator[None]:
    raster_dir = get_settings().raster_dir
    before = set(raster_dir.glob("*")) if raster_dir.exists() else set()
    yield
    if raster_dir.exists():
        for path in set(raster_dir.glob("*")) - before:
            path.unlink(missing_ok=True)
```

- [ ] **Step 8: Run the full gate and commit**

Run: `pytest -v && ruff check . && ruff format --check . && mypy app`
Expected: all green.

```bash
cd gis-platform
git add backend/app/services/raster_import_service.py backend/app/api/v1/routes/imports.py backend/tests
git commit -m "feat: import GeoTIFF rasters with automatic COG conversion"
```

- [ ] **Step 9: Manual smoke check**

```bash
cd gis-platform/backend
uvicorn app.main:app --port 1316 &
PROJECT=$(curl -s -X POST localhost:1316/api/v1/projects -H 'content-type: application/json' -d '{"name":"Smoke"}' | python -c "import sys,json;print(json.load(sys.stdin)['id'])")
curl -s -X POST "localhost:1316/api/v1/projects/$PROJECT/layers/import" -F "file=@../../some-cities.geojson"
```
Expected: a 201 with a `source.tableName` starting with the filename slug. Confirm in psql that `gis_data.<table>` exists with a `fid` primary key and a GIST index. Stop the server.

---

## Task 8: BBOX Feature Streaming (Memory Layer 2 of 3)

**Files:**
- Create: `gis-platform/backend/app/schemas/feature.py`
- Create: `gis-platform/backend/app/repositories/feature_repository.py`
- Create: `gis-platform/backend/app/services/feature_service.py`
- Create: `gis-platform/backend/app/api/v1/routes/features.py`
- Modify: `gis-platform/backend/app/api/v1/router.py`
- Test: `gis-platform/backend/tests/test_bbox_parsing.py`, `gis-platform/backend/tests/test_features_api.py`
- Create: `gis-platform/docs/04-feature-streaming.md`

**Interfaces:**
- Consumes: `PostgisSource` (Task 3); `qualified`, `quote` (Task 5); `catalog_service.verify_source`, `catalog_repository.list_columns` (Task 5); `layer_service.get_layer_or_404`, `require_postgis_source` (Task 4); `Settings.feature_bbox_limit` (Task 1).
- Produces:
  - `app.schemas.feature.BBox(minx, miny, maxx, maxy)` with `classmethod parse(raw: str) -> BBox` (comma-separated, 4326, raises `InvalidRequestError`) and `property as_params -> dict[str, float]`.
  - `app.schemas.feature.FeatureCollection(type='FeatureCollection', features, truncated, limit, returned)` and `Feature(type='Feature', id, geometry, properties)`.
  - `app.repositories.feature_repository.read_in_bbox(session, source, bbox, limit) -> list[dict]` — returns `limit + 1` rows at most so the caller can detect truncation. Also `attribute_columns(session, source) -> list[str]` (all columns except the geometry column).
  - `app.services.feature_service.get_features(session, layer_id, bbox, limit) -> FeatureCollection`.
  - Endpoint `GET /layers/{layer_id}/features?bbox=&limit=`.

- [ ] **Step 1: Write the failing bbox parsing test**

`gis-platform/backend/tests/test_bbox_parsing.py`:

```python
import pytest

from app.core.errors import InvalidRequestError
from app.schemas.feature import BBox


def test_parses_a_well_formed_bbox() -> None:
    bbox = BBox.parse("100.0,30.0,101.0,31.0")
    assert (bbox.minx, bbox.miny, bbox.maxx, bbox.maxy) == (100.0, 30.0, 101.0, 31.0)


def test_tolerates_whitespace() -> None:
    assert BBox.parse(" 100 , 30 , 101 , 31 ").maxy == 31.0


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "1,2,3",
        "1,2,3,4,5",
        "a,b,c,d",
        "101,30,100,31",  # minx > maxx
        "100,31,101,30",  # miny > maxy
        "-181,0,10,10",  # outside the 4326 domain
        "0,-91,10,10",
        "0,0,181,10",
        "0,0,10,91",
    ],
)
def test_rejects_malformed_or_impossible_boxes(raw: str) -> None:
    with pytest.raises(InvalidRequestError):
        BBox.parse(raw)


def test_as_params_names_match_the_sql_bindings() -> None:
    assert BBox.parse("1,2,3,4").as_params == {"minx": 1.0, "miny": 2.0, "maxx": 3.0, "maxy": 4.0}
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pytest tests/test_bbox_parsing.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.schemas.feature'`.

- [ ] **Step 3: Implement `app/schemas/feature.py`**

```python
"""GeoJSON wire types plus the bbox query parameter.

`truncated` is deliberately part of the response, not a header: a client
that silently receives 2000 of 200000 features and draws them as if they
were the whole layer is lying to its user. QGIS shows a feature-limit
warning; so does this.
"""

from __future__ import annotations

from typing import Any, Literal, Self

from pydantic import Field

from app.core.errors import InvalidRequestError
from app.schemas.base import APIModel

LON_LIMIT = 180.0
LAT_LIMIT = 90.0


class BBox(APIModel):
    minx: float
    miny: float
    maxx: float
    maxy: float

    @classmethod
    def parse(cls, raw: str) -> Self:
        parts = [part.strip() for part in (raw or "").split(",")]
        if len(parts) != 4:
            raise InvalidRequestError(
                "bbox must be 'minx,miny,maxx,maxy' in EPSG:4326", details={"bbox": raw}
            )
        try:
            minx, miny, maxx, maxy = (float(part) for part in parts)
        except ValueError as exc:
            raise InvalidRequestError(
                "bbox values must be numbers", details={"bbox": raw}
            ) from exc
        if minx >= maxx or miny >= maxy:
            raise InvalidRequestError(
                "bbox min values must be smaller than max values", details={"bbox": raw}
            )
        if not (-LON_LIMIT <= minx <= LON_LIMIT and -LON_LIMIT <= maxx <= LON_LIMIT):
            raise InvalidRequestError("bbox longitude out of range", details={"bbox": raw})
        if not (-LAT_LIMIT <= miny <= LAT_LIMIT and -LAT_LIMIT <= maxy <= LAT_LIMIT):
            raise InvalidRequestError("bbox latitude out of range", details={"bbox": raw})
        return cls(minx=minx, miny=miny, maxx=maxx, maxy=maxy)

    @property
    def as_params(self) -> dict[str, float]:
        return {"minx": self.minx, "miny": self.miny, "maxx": self.maxx, "maxy": self.maxy}


class Feature(APIModel):
    type: Literal["Feature"] = "Feature"
    id: str
    geometry: dict[str, Any] | None
    properties: dict[str, Any]


class FeatureCollection(APIModel):
    type: Literal["FeatureCollection"] = "FeatureCollection"
    features: list[Feature]
    returned: int = Field(description="Number of features in this response")
    limit: int = Field(description="Server-applied cap for this request")
    truncated: bool = Field(
        description="True when more features intersect the bbox than the cap allowed"
    )
```

- [ ] **Step 4: Run the bbox tests and confirm they pass**

Run: `pytest tests/test_bbox_parsing.py -v`
Expected: 13 passed.

- [ ] **Step 5: Write the failing feature API test**

`gis-platform/backend/tests/test_features_api.py`:

```python
import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.source import PostgisSource


@pytest.fixture
async def cities_layer(
    client: AsyncClient, seeded_spatial_table: PostgisSource
) -> dict:
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    return (
        await client.post(
            f"/api/v1/projects/{project_id}/layers/from-postgis",
            json={
                "schemaName": "gis_data",
                "tableName": "test_cities",
                "geometryColumn": "geometry",
                "idColumn": "fid",
                "name": "Cities",
            },
        )
    ).json()


async def test_bbox_returns_only_intersecting_features(
    client: AsyncClient, cities_layer: dict
) -> None:
    # A box around Lhasa only.
    response = await client.get(
        f"/api/v1/layers/{cities_layer['id']}/features", params={"bbox": "90,29,92,30"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["type"] == "FeatureCollection"
    assert body["returned"] == 1
    assert body["truncated"] is False
    assert [f["properties"]["name"] for f in body["features"]] == ["Lhasa"]


async def test_features_are_geojson_in_4326_without_the_geometry_column_in_properties(
    client: AsyncClient, cities_layer: dict
) -> None:
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/features", params={"bbox": "-180,-90,180,90"}
        )
    ).json()
    feature = next(f for f in body["features"] if f["properties"]["name"] == "Beijing")
    assert feature["geometry"]["type"] == "Point"
    assert feature["geometry"]["coordinates"] == pytest.approx([116.4074, 39.9042], abs=1e-4)
    assert "geometry" not in feature["properties"]
    assert "fid" not in feature["properties"]
    assert feature["id"] == "1"
    assert feature["properties"]["population"] == 21540000


async def test_limit_is_honoured_and_truncation_is_reported(
    client: AsyncClient, cities_layer: dict
) -> None:
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/features",
            params={"bbox": "-180,-90,180,90", "limit": 2},
        )
    ).json()
    assert body["returned"] == 2
    assert body["limit"] == 2
    assert body["truncated"] is True


async def test_limit_is_clamped_to_the_server_cap(
    client: AsyncClient, cities_layer: dict
) -> None:
    response = await client.get(
        f"/api/v1/layers/{cities_layer['id']}/features",
        params={"bbox": "-180,-90,180,90", "limit": 999999},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


async def test_missing_bbox_is_rejected(client: AsyncClient, cities_layer: dict) -> None:
    response = await client.get(f"/api/v1/layers/{cities_layer['id']}/features")
    assert response.status_code == 422


async def test_features_on_a_non_postgis_layer_is_a_clear_error(client: AsyncClient) -> None:
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    layer = (
        await client.post(
            f"/api/v1/projects/{project_id}/layers",
            json={
                "name": "OSM",
                "kind": "basemap",
                "source": {"type": "xyz", "url": "https://t/{z}/{x}/{y}.png"},
            },
        )
    ).json()
    response = await client.get(
        f"/api/v1/layers/{layer['id']}/features", params={"bbox": "0,0,1,1"}
    )
    assert response.status_code == 422
    assert "not backed by a PostGIS table" in response.json()["error"]["message"]


async def test_features_on_a_dropped_table_is_a_404(
    client: AsyncClient, cities_layer: dict, db_session: AsyncSession
) -> None:
    await db_session.execute(text("DROP TABLE gis_data.test_cities"))
    await db_session.flush()
    response = await client.get(
        f"/api/v1/layers/{cities_layer['id']}/features", params={"bbox": "0,0,1,1"}
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_reprojects_from_a_non_4326_table(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    await db_session.execute(
        text(
            """
            CREATE TABLE gis_data.test_webmerc (
                fid serial PRIMARY KEY,
                name text,
                geometry geometry(Point, 3857)
            )
            """
        )
    )
    await db_session.execute(
        text(
            "INSERT INTO gis_data.test_webmerc (name, geometry) VALUES "
            "('Origin', ST_SetSRID(ST_MakePoint(0, 0), 3857))"
        )
    )
    await db_session.flush()

    project_id = (await client.post("/api/v1/projects", json={"name": "P2"})).json()["id"]
    layer = (
        await client.post(
            f"/api/v1/projects/{project_id}/layers/from-postgis",
            json={
                "schemaName": "gis_data",
                "tableName": "test_webmerc",
                "geometryColumn": "geometry",
                "idColumn": "fid",
                "name": "WebMerc",
            },
        )
    ).json()
    assert layer["srid"] == 3857

    body = (
        await client.get(
            f"/api/v1/layers/{layer['id']}/features", params={"bbox": "-1,-1,1,1"}
        )
    ).json()
    assert body["returned"] == 1
    assert body["features"][0]["geometry"]["coordinates"] == pytest.approx([0.0, 0.0], abs=1e-9)
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `pytest tests/test_features_api.py -v`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 7: Implement `app/repositories/feature_repository.py`**

```python
"""Reads of feature geometry and attributes from an arbitrary PostGIS table.

Two deliberate choices:

* `&&` (bounding-box overlap) rather than `ST_Intersects`. A viewport query
  wants "might be visible", and `&&` is answered directly from the GIST
  index without an exact geometry test. Fetching a handful of extra features
  at the tile edge costs far less than an exact intersection over the table.
* The envelope is transformed into the table's SRID, not the geometry into
  4326. Transforming the geometry would make the index unusable.
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.identifiers import qualified, quote
from app.repositories import catalog_repository
from app.schemas.feature import BBox
from app.schemas.source import PostgisSource


async def attribute_columns(session: AsyncSession, source: PostgisSource) -> list[str]:
    columns = await catalog_repository.list_columns(
        session, source.schema_name, source.table_name
    )
    return [column.name for column in columns if column.name != source.geometry_column]


async def read_in_bbox(
    session: AsyncSession, source: PostgisSource, bbox: BBox, limit: int
) -> list[dict[str, Any]]:
    geom = quote(source.geometry_column)
    fid = quote(source.id_column)
    table = qualified(source.schema_name, source.table_name)

    sql = text(
        f"""
        SELECT t.{fid}::text AS fid,
               ST_AsGeoJSON(ST_Transform(t.{geom}, 4326)) AS geometry,
               to_jsonb(t) - :geom_key - :id_key AS properties
        FROM {table} AS t
        WHERE t.{geom} && ST_Transform(
                  ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326), :srid
              )
        ORDER BY t.{fid}
        LIMIT :limit
        """
    )
    params: dict[str, Any] = {
        **bbox.as_params,
        "srid": source.srid,
        "geom_key": source.geometry_column,
        "id_key": source.id_column,
        "limit": limit + 1,  # one extra row is how truncation is detected
    }
    rows = (await session.execute(sql, params)).mappings().all()
    return [
        {
            "fid": row["fid"],
            "geometry": json.loads(row["geometry"]) if row["geometry"] else None,
            "properties": dict(row["properties"] or {}),
        }
        for row in rows
    ]
```

- [ ] **Step 8: Implement `app/services/feature_service.py`**

```python
from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import InvalidRequestError
from app.repositories import feature_repository
from app.schemas.feature import BBox, Feature, FeatureCollection
from app.services import catalog_service, layer_service


def clamp_limit(requested: int | None) -> int:
    """A client may ask for fewer than the cap, never more."""
    cap = get_settings().feature_bbox_limit
    if requested is None:
        return cap
    if requested < 1 or requested > cap:
        raise InvalidRequestError(
            "limit must be between 1 and the server cap",
            details={"requested": requested, "max": cap},
        )
    return requested


async def get_features(
    session: AsyncSession, layer_id: uuid.UUID, bbox: BBox, limit: int | None
) -> FeatureCollection:
    layer = await layer_service.get_layer_or_404(session, layer_id)
    source = layer_service.require_postgis_source(layer)
    await catalog_service.verify_source(session, source)

    effective = clamp_limit(limit)
    rows = await feature_repository.read_in_bbox(session, source, bbox, effective)
    truncated = len(rows) > effective
    visible = rows[:effective]

    return FeatureCollection(
        features=[
            Feature(id=row["fid"], geometry=row["geometry"], properties=row["properties"])
            for row in visible
        ],
        returned=len(visible),
        limit=effective,
        truncated=truncated,
    )
```

- [ ] **Step 9: Implement `app/api/v1/routes/features.py` and register it**

```python
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
from app.schemas.feature import BBox, FeatureCollection
from app.services import feature_service

router = APIRouter(prefix="/layers/{layer_id}", tags=["features"])


@router.get("/features", response_model=FeatureCollection)
async def read_features(
    layer_id: uuid.UUID,
    bbox: str = Query(..., description="minx,miny,maxx,maxy in EPSG:4326"),
    limit: int | None = Query(default=None, ge=1),
    session: AsyncSession = Depends(get_session),
) -> FeatureCollection:
    return await feature_service.get_features(session, layer_id, BBox.parse(bbox), limit)
```

Register `features.router` in `app/api/v1/router.py`.

- [ ] **Step 10: Run the feature tests and confirm they pass**

Run: `pytest tests/test_features_api.py -v`
Expected: 8 passed.

If `test_limit_is_clamped_to_the_server_cap` returns 200, `clamp_limit` is being bypassed — the route must **not** apply `le=` on the query parameter, because the error envelope should come from `InvalidRequestError`, not FastAPI's validator.

- [ ] **Step 11: Run the full gate and commit**

Run: `pytest -v && ruff check . && ruff format --check . && mypy app`

```bash
cd gis-platform
git add backend/app/schemas/feature.py backend/app/repositories/feature_repository.py \
        backend/app/services/feature_service.py backend/app/api backend/tests
git commit -m "feat: stream features by bbox with an explicit truncation flag"
```

- [ ] **Step 12: Write `gis-platform/docs/04-feature-streaming.md`**

Sections and required content:
- `# 04 · Feature Streaming` — the failure this prevents: `SELECT * FROM roads` on a national road network is a browser tab that dies.
- `## Windowing by viewport` — paste `read_in_bbox` and walk the query.
- `## Why `&&` and not `ST_Intersects`` — paste the docstring reasoning verbatim; explain the GIST index and that an exact test is unnecessary for "might be visible".
- `## Transform the envelope, not the column` — explain that `ST_Transform(t.geom, 4326) && envelope` would make the index unusable, and that this is the single most common performance mistake in PostGIS viewport queries. Show both forms side by side.
- `## Detecting truncation with LIMIT n+1` — paste the `limit + 1` line and the `truncated` computation in `get_features`. Explain why a `COUNT(*)` would be wrong (a second full scan) and why silently truncating would be worse.
- `## The cap is the server's, not the client's` — paste `clamp_limit` and `Settings.feature_bbox_limit`.
- `## This is memory layer 2 of 3` — one paragraph and a forward reference to `07-memory-management.md`, naming the other two layers (server dataset pool, browser byte budget).

---

## Task 9: Attribute Table — Fields, Paging, Sorting, Filtering

**Files:**
- Create: `gis-platform/backend/app/schemas/attribute.py`
- Modify: `gis-platform/backend/app/repositories/feature_repository.py`
- Create: `gis-platform/backend/app/services/attribute_service.py`
- Modify: `gis-platform/backend/app/api/v1/routes/features.py`
- Test: `gis-platform/backend/tests/test_attributes_api.py`

**Interfaces:**
- Consumes: `catalog_repository.list_columns`, `verify_source` (Task 5); `layer_service.get_layer_or_404`, `require_postgis_source` (Task 4); `quote`, `quote_list`, `qualified` (Task 5); `Settings.attribute_page_max` (Task 1).
- Produces:
  - `app.schemas.attribute.AttributeFilter(field, op, value)` where `op ∈ {eq, neq, gt, gte, lt, lte, like, in, isnull, notnull}`; `AttributePage(columns, rows, page, page_size, total)`; `FieldList(fields: list[ColumnInfo], id_column, geometry_column)`.
  - `app.repositories.feature_repository.read_attribute_page(session, source, columns, filters, sort_by, sort_order, page, page_size) -> tuple[list[dict], int]`.
  - `app.services.attribute_service.get_fields(session, layer_id) -> FieldList`, `get_page(session, layer_id, page, page_size, sort_by, sort_order, filters_raw) -> AttributePage`.
  - Endpoints `GET /layers/{layer_id}/fields`, `GET /layers/{layer_id}/attributes`.

- [ ] **Step 1: Write the failing attribute API test**

`gis-platform/backend/tests/test_attributes_api.py`:

```python
import json

import pytest
from httpx import AsyncClient

from app.schemas.source import PostgisSource


@pytest.fixture
async def cities_layer(client: AsyncClient, seeded_spatial_table: PostgisSource) -> dict:
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    return (
        await client.post(
            f"/api/v1/projects/{project_id}/layers/from-postgis",
            json={
                "schemaName": "gis_data",
                "tableName": "test_cities",
                "geometryColumn": "geometry",
                "idColumn": "fid",
                "name": "Cities",
            },
        )
    ).json()


async def test_fields_excludes_geometry_and_marks_the_key(
    client: AsyncClient, cities_layer: dict
) -> None:
    body = (await client.get(f"/api/v1/layers/{cities_layer['id']}/fields")).json()
    names = [field["name"] for field in body["fields"]]
    assert names == ["fid", "name", "population"]
    assert body["idColumn"] == "fid"
    assert body["geometryColumn"] == "geometry"
    population = next(f for f in body["fields"] if f["name"] == "population")
    assert population["dataType"] == "integer"
    assert population["editable"] is True


async def test_attribute_page_returns_rows_and_total(
    client: AsyncClient, cities_layer: dict
) -> None:
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/attributes",
            params={"page": 1, "pageSize": 2},
        )
    ).json()
    assert body["total"] == 3
    assert body["page"] == 1
    assert body["pageSize"] == 2
    assert len(body["rows"]) == 2
    assert body["columns"] == ["fid", "name", "population"]
    assert "geometry" not in body["rows"][0]


async def test_second_page_returns_the_remainder(
    client: AsyncClient, cities_layer: dict
) -> None:
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/attributes",
            params={"page": 2, "pageSize": 2},
        )
    ).json()
    assert len(body["rows"]) == 1


async def test_sorting_by_a_real_column(client: AsyncClient, cities_layer: dict) -> None:
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/attributes",
            params={"sortBy": "population", "sortOrder": "desc"},
        )
    ).json()
    assert [row["name"] for row in body["rows"]] == ["Shanghai", "Beijing", "Lhasa"]


async def test_sorting_by_an_unknown_column_is_rejected(
    client: AsyncClient, cities_layer: dict
) -> None:
    response = await client.get(
        f"/api/v1/layers/{cities_layer['id']}/attributes", params={"sortBy": "nope"}
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


async def test_sort_by_injection_attempt_is_rejected(
    client: AsyncClient, cities_layer: dict
) -> None:
    response = await client.get(
        f"/api/v1/layers/{cities_layer['id']}/attributes",
        params={"sortBy": "population; DROP TABLE gis.layer"},
    )
    assert response.status_code == 422
    assert (await client.get("/api/v1/projects")).status_code == 200


async def test_structured_filter_narrows_the_result(
    client: AsyncClient, cities_layer: dict
) -> None:
    filters = json.dumps([{"field": "population", "op": "gte", "value": 1000000}])
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/attributes", params={"filters": filters}
        )
    ).json()
    assert body["total"] == 2
    assert {row["name"] for row in body["rows"]} == {"Beijing", "Shanghai"}


async def test_like_filter_is_parameterised(client: AsyncClient, cities_layer: dict) -> None:
    filters = json.dumps([{"field": "name", "op": "like", "value": "%hai"}])
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/attributes", params={"filters": filters}
        )
    ).json()
    assert [row["name"] for row in body["rows"]] == ["Shanghai"]


async def test_in_filter_accepts_a_list(client: AsyncClient, cities_layer: dict) -> None:
    filters = json.dumps([{"field": "name", "op": "in", "value": ["Lhasa", "Beijing"]}])
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/attributes", params={"filters": filters}
        )
    ).json()
    assert body["total"] == 2


async def test_filter_on_an_unknown_field_is_rejected(
    client: AsyncClient, cities_layer: dict
) -> None:
    filters = json.dumps([{"field": "secret", "op": "eq", "value": 1}])
    response = await client.get(
        f"/api/v1/layers/{cities_layer['id']}/attributes", params={"filters": filters}
    )
    assert response.status_code == 422


async def test_unknown_operator_is_rejected(client: AsyncClient, cities_layer: dict) -> None:
    filters = json.dumps([{"field": "name", "op": "regex", "value": ".*"}])
    response = await client.get(
        f"/api/v1/layers/{cities_layer['id']}/attributes", params={"filters": filters}
    )
    assert response.status_code == 422


async def test_page_size_is_capped(client: AsyncClient, cities_layer: dict) -> None:
    response = await client.get(
        f"/api/v1/layers/{cities_layer['id']}/attributes", params={"pageSize": 100000}
    )
    assert response.status_code == 422
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pytest tests/test_attributes_api.py -v`
Expected: FAIL — 404 on `/fields`.

- [ ] **Step 3: Implement `app/schemas/attribute.py`**

```python
from __future__ import annotations

import json
from typing import Any, Literal, Self

from pydantic import Field, ValidationError

from app.core.errors import InvalidRequestError
from app.schemas.base import APIModel
from app.schemas.catalog import ColumnInfo

FilterOp = Literal["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "in", "isnull", "notnull"]

# op -> SQL fragment template. `{col}` is a validated identifier; `:p` is a bind.
OPERATOR_SQL: dict[str, str] = {
    "eq": "{col} = :{p}",
    "neq": "{col} IS DISTINCT FROM :{p}",
    "gt": "{col} > :{p}",
    "gte": "{col} >= :{p}",
    "lt": "{col} < :{p}",
    "lte": "{col} <= :{p}",
    "like": "{col}::text LIKE :{p}",
    "ilike": "{col}::text ILIKE :{p}",
    "in": "{col} = ANY(:{p})",
    "isnull": "{col} IS NULL",
    "notnull": "{col} IS NOT NULL",
}

VALUELESS_OPS = {"isnull", "notnull"}


class AttributeFilter(APIModel):
    field: str = Field(min_length=1)
    op: FilterOp
    value: Any = None

    @classmethod
    def parse_list(cls, raw: str | None) -> list[Self]:
        if not raw:
            return []
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise InvalidRequestError(
                "filters must be a JSON array", details={"filters": raw}
            ) from exc
        if not isinstance(payload, list):
            raise InvalidRequestError("filters must be a JSON array", details={"filters": raw})
        try:
            return [cls.model_validate(item) for item in payload]
        except ValidationError as exc:
            raise InvalidRequestError(
                "Invalid filter", details={"errors": exc.errors()}
            ) from exc


class FieldList(APIModel):
    fields: list[ColumnInfo]
    id_column: str
    geometry_column: str


class AttributePage(APIModel):
    columns: list[str]
    rows: list[dict[str, Any]]
    page: int
    page_size: int
    total: int
```

- [ ] **Step 4: Extend `app/repositories/feature_repository.py`**

Append:

```python
from app.db.identifiers import quote_list, validate_identifier
from app.schemas.attribute import OPERATOR_SQL, VALUELESS_OPS, AttributeFilter


def build_where(
    filters: list[AttributeFilter], allowed: set[str]
) -> tuple[str, dict[str, Any]]:
    """Compose a WHERE clause from validated fields and bound values.

    The field name is validated twice — against the allowlist regex and
    against the set of columns that actually exist on this table — and the
    operator can only be one of the fixed keys of OPERATOR_SQL. The value is
    always a bind parameter, never text.
    """
    from app.core.errors import InvalidRequestError

    clauses: list[str] = []
    params: dict[str, Any] = {}
    for index, item in enumerate(filters):
        if item.field not in allowed:
            raise InvalidRequestError(
                "Unknown filter field",
                details={"field": item.field, "allowed": sorted(allowed)},
            )
        template = OPERATOR_SQL[item.op]
        placeholder = f"f{index}"
        clauses.append(
            template.format(col=quote(validate_identifier(item.field)), p=placeholder)
        )
        if item.op not in VALUELESS_OPS:
            if item.op == "in":
                if not isinstance(item.value, list) or not item.value:
                    raise InvalidRequestError(
                        "The 'in' operator needs a non-empty list",
                        details={"field": item.field},
                    )
                params[placeholder] = item.value
            else:
                params[placeholder] = item.value
    return (" AND ".join(clauses) if clauses else "TRUE"), params


async def read_attribute_page(
    session: AsyncSession,
    source: PostgisSource,
    columns: list[str],
    filters: list[AttributeFilter],
    sort_by: str,
    sort_order: str,
    page: int,
    page_size: int,
) -> tuple[list[dict[str, Any]], int]:
    table = qualified(source.schema_name, source.table_name)
    where, params = build_where(filters, set(columns))
    direction = "DESC" if sort_order.lower() == "desc" else "ASC"
    order = f"{quote(validate_identifier(sort_by))} {direction}"

    total = int(
        (
            await session.execute(text(f"SELECT count(*) FROM {table} WHERE {where}"), params)
        ).scalar_one()
    )
    rows = (
        await session.execute(
            text(
                f"""
                SELECT {quote_list(columns)}
                FROM {table}
                WHERE {where}
                ORDER BY {order}, {quote(source.id_column)} ASC
                LIMIT :limit OFFSET :offset
                """
            ),
            {**params, "limit": page_size, "offset": (page - 1) * page_size},
        )
    ).mappings().all()
    return [dict(row) for row in rows], total
```

- [ ] **Step 5: Implement `app/services/attribute_service.py`**

```python
from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import InvalidRequestError
from app.repositories import catalog_repository, feature_repository
from app.schemas.attribute import AttributeFilter, AttributePage, FieldList
from app.services import catalog_service, layer_service


async def _source_and_columns(session: AsyncSession, layer_id: uuid.UUID):
    layer = await layer_service.get_layer_or_404(session, layer_id)
    source = layer_service.require_postgis_source(layer)
    await catalog_service.verify_source(session, source)
    columns = await feature_repository.attribute_columns(session, source)
    return source, columns


async def get_fields(session: AsyncSession, layer_id: uuid.UUID) -> FieldList:
    layer = await layer_service.get_layer_or_404(session, layer_id)
    source = layer_service.require_postgis_source(layer)
    await catalog_service.verify_source(session, source)
    all_columns = await catalog_repository.list_columns(
        session, source.schema_name, source.table_name
    )
    return FieldList(
        fields=[column for column in all_columns if column.name != source.geometry_column],
        id_column=source.id_column,
        geometry_column=source.geometry_column,
    )


async def get_page(
    session: AsyncSession,
    layer_id: uuid.UUID,
    page: int,
    page_size: int,
    sort_by: str | None,
    sort_order: str,
    filters_raw: str | None,
) -> AttributePage:
    source, columns = await _source_and_columns(session, layer_id)

    cap = get_settings().attribute_page_max
    if page < 1 or page_size < 1 or page_size > cap:
        raise InvalidRequestError(
            "Invalid paging", details={"page": page, "pageSize": page_size, "maxPageSize": cap}
        )

    effective_sort = sort_by or source.id_column
    if effective_sort not in columns:
        raise InvalidRequestError(
            "Unknown sort column", details={"sortBy": effective_sort, "allowed": columns}
        )
    if sort_order.lower() not in {"asc", "desc"}:
        raise InvalidRequestError("sortOrder must be 'asc' or 'desc'", details={"sortOrder": sort_order})

    filters = AttributeFilter.parse_list(filters_raw)
    rows, total = await feature_repository.read_attribute_page(
        session, source, columns, filters, effective_sort, sort_order, page, page_size
    )
    return AttributePage(
        columns=columns, rows=rows, page=page, page_size=page_size, total=total
    )
```

- [ ] **Step 6: Add the routes**

Append to `app/api/v1/routes/features.py`:

```python
from app.schemas.attribute import AttributePage, FieldList
from app.services import attribute_service


@router.get("/fields", response_model=FieldList)
async def read_fields(
    layer_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> FieldList:
    return await attribute_service.get_fields(session, layer_id)


@router.get("/attributes", response_model=AttributePage)
async def read_attributes(
    layer_id: uuid.UUID,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, alias="pageSize", ge=1),
    sort_by: str | None = Query(default=None, alias="sortBy"),
    sort_order: str = Query(default="asc", alias="sortOrder"),
    filters: str | None = Query(default=None, description="JSON array of {field, op, value}"),
    session: AsyncSession = Depends(get_session),
) -> AttributePage:
    return await attribute_service.get_page(
        session, layer_id, page, page_size, sort_by, sort_order, filters
    )
```

- [ ] **Step 7: Run the attribute tests and confirm they pass**

Run: `pytest tests/test_attributes_api.py -v`
Expected: 12 passed.

If `test_in_filter_accepts_a_list` fails with an asyncpg type error, the `= ANY(:p)` bind needs an explicit array type — wrap the parameter as `sqlalchemy.bindparam(placeholder, expanding=False)` with `postgresql.ARRAY(sqlalchemy.Text)`, or switch the template to `{col}::text = ANY(:{p})` and stringify the list values in `build_where`.

- [ ] **Step 8: Run the full gate and commit**

Run: `pytest -v && ruff check . && ruff format --check . && mypy app`

```bash
cd gis-platform
git add backend/app/schemas/attribute.py backend/app/repositories/feature_repository.py \
        backend/app/services/attribute_service.py backend/app/api/v1/routes/features.py backend/tests
git commit -m "feat: add paged, sorted and filtered attribute table endpoints"
```

- [ ] **Step 9: Extend `gis-platform/docs/03-postgis-and-dynamic-sql.md`**

Append a section `## Filtering without string-building` containing: the `OPERATOR_SQL` table pasted verbatim; the `build_where` function; and a paragraph explaining the three-part rule that makes it safe — the **field** is checked against the live column list, the **operator** can only be a key of a fixed dict, and the **value** is always a bind parameter. Paste `test_sort_by_injection_attempt_is_rejected` as the proof.

---

## Task 10: Vector Tiles via `ST_AsMVT`

**Files:**
- Create: `gis-platform/backend/app/repositories/tile_repository.py`
- Create: `gis-platform/backend/app/services/tile_service.py`
- Create: `gis-platform/backend/app/api/v1/routes/tiles.py`
- Modify: `gis-platform/backend/app/api/v1/router.py`
- Test: `gis-platform/backend/tests/test_tile_coords.py`, `gis-platform/backend/tests/test_vector_tiles_api.py`
- Create: `gis-platform/docs/05-vector-tiles-mvt.md`

**Interfaces:**
- Consumes: `PostgisSource` (Task 3); `qualified`, `quote`, `validate_identifier` (Task 5); `feature_repository.attribute_columns` (Task 8); `layer_service.get_layer_or_404`, `require_postgis_source` (Task 4); `catalog_service.verify_source` (Task 5).
- Produces:
  - `app.services.tile_service.validate_tile_coords(z: int, x: int, y: int) -> None` — raises `InvalidRequestError` outside `0 <= z <= 24` and `0 <= x,y < 2**z`. **Task 12 reuses this.**
  - `app.repositories.tile_repository.render_mvt(session, source, columns, z, x, y, layer_name) -> bytes` — returns `b""` for an empty tile.
  - `app.services.tile_service.get_vector_tile(session, layer_id, z, x, y) -> bytes` and `tile_etag(layer, z, x, y) -> str`.
  - Endpoint `GET /layers/{layer_id}/tiles/{z}/{x}/{y}.mvt` returning `application/vnd.mapbox-vector-tile`, `204` for empty tiles, `ETag` + `Cache-Control: public, max-age=60`.

- [ ] **Step 1: Write the failing tile-coordinate test**

`gis-platform/backend/tests/test_tile_coords.py`:

```python
import pytest

from app.core.errors import InvalidRequestError
from app.services.tile_service import validate_tile_coords


@pytest.mark.parametrize(("z", "x", "y"), [(0, 0, 0), (1, 1, 1), (10, 1023, 0), (24, 0, 0)])
def test_accepts_coordinates_inside_the_pyramid(z: int, x: int, y: int) -> None:
    validate_tile_coords(z, x, y)  # must not raise


@pytest.mark.parametrize(
    ("z", "x", "y"),
    [
        (-1, 0, 0),
        (25, 0, 0),
        (0, 1, 0),   # z0 has exactly one tile
        (0, 0, 1),
        (1, 2, 0),
        (1, 0, 2),
        (10, -1, 0),
        (10, 0, -1),
    ],
)
def test_rejects_coordinates_outside_the_pyramid(z: int, x: int, y: int) -> None:
    with pytest.raises(InvalidRequestError):
        validate_tile_coords(z, x, y)
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pytest tests/test_tile_coords.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.tile_service'`.

- [ ] **Step 3: Write the failing vector-tile API test**

`gis-platform/backend/tests/test_vector_tiles_api.py`:

```python
import pytest
from httpx import AsyncClient

from app.schemas.source import PostgisSource


@pytest.fixture
async def cities_layer(client: AsyncClient, seeded_spatial_table: PostgisSource) -> dict:
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    return (
        await client.post(
            f"/api/v1/projects/{project_id}/layers/from-postgis",
            json={
                "schemaName": "gis_data",
                "tableName": "test_cities",
                "geometryColumn": "geometry",
                "idColumn": "fid",
                "name": "Cities",
            },
        )
    ).json()


async def test_world_tile_contains_the_seeded_features(
    client: AsyncClient, cities_layer: dict
) -> None:
    response = await client.get(f"/api/v1/layers/{cities_layer['id']}/tiles/0/0/0.mvt")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/vnd.mapbox-vector-tile"
    assert len(response.content) > 0
    # MVT is protobuf; the layer name is stored as a plain string in the blob.
    assert b"Cities" in response.content or b"default" in response.content
    assert b"population" in response.content


async def test_empty_tile_returns_204(client: AsyncClient, cities_layer: dict) -> None:
    # Zoom 5 tile over the mid-Atlantic — no seeded city is there.
    response = await client.get(f"/api/v1/layers/{cities_layer['id']}/tiles/5/13/15.mvt")
    assert response.status_code == 204
    assert response.content == b""


async def test_tile_sets_cache_headers_and_an_etag(
    client: AsyncClient, cities_layer: dict
) -> None:
    response = await client.get(f"/api/v1/layers/{cities_layer['id']}/tiles/0/0/0.mvt")
    assert response.headers["cache-control"] == "public, max-age=60"
    assert response.headers["etag"]


async def test_matching_if_none_match_returns_304(
    client: AsyncClient, cities_layer: dict
) -> None:
    first = await client.get(f"/api/v1/layers/{cities_layer['id']}/tiles/0/0/0.mvt")
    etag = first.headers["etag"]
    second = await client.get(
        f"/api/v1/layers/{cities_layer['id']}/tiles/0/0/0.mvt",
        headers={"if-none-match": etag},
    )
    assert second.status_code == 304


async def test_out_of_range_tile_is_rejected(client: AsyncClient, cities_layer: dict) -> None:
    response = await client.get(f"/api/v1/layers/{cities_layer['id']}/tiles/0/5/5.mvt")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


async def test_tiles_on_a_non_postgis_layer_are_rejected(client: AsyncClient) -> None:
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    layer = (
        await client.post(
            f"/api/v1/projects/{project_id}/layers",
            json={
                "name": "OSM",
                "kind": "basemap",
                "source": {"type": "xyz", "url": "https://t/{z}/{x}/{y}.png"},
            },
        )
    ).json()
    response = await client.get(f"/api/v1/layers/{layer['id']}/tiles/0/0/0.mvt")
    assert response.status_code == 422
```

- [ ] **Step 4: Run it and confirm it fails**

Run: `pytest tests/test_vector_tiles_api.py -v`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 5: Implement `app/repositories/tile_repository.py`**

```python
"""Vector tile generation inside PostGIS.

`ST_AsMVT` is an aggregate: it consumes a row set whose geometry column has
already been clipped to the tile by `ST_AsMVTGeom`, and emits one protobuf
blob. Doing this in the database rather than in Python means the geometry
never leaves Postgres as GeoJSON text — for a dense layer that is the
difference between kilobytes and megabytes per tile.

Attribute columns are expanded explicitly rather than passed as one jsonb
value, because `ST_AsMVT` maps each *column* to an MVT attribute; a single
jsonb column would arrive in the client as one opaque string.
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.identifiers import qualified, quote, validate_identifier
from app.schemas.source import PostgisSource

MVT_EXTENT = 4096
MVT_BUFFER = 64


async def render_mvt(
    session: AsyncSession,
    source: PostgisSource,
    columns: list[str],
    z: int,
    x: int,
    y: int,
    layer_name: str,
) -> bytes:
    geom = quote(source.geometry_column)
    fid = quote(source.id_column)
    table = qualified(source.schema_name, source.table_name)
    attribute_select = "".join(
        f", t.{quote(validate_identifier(column))}"
        for column in columns
        if column != source.id_column
    )

    sql = text(
        f"""
        WITH bounds AS (
            SELECT ST_TileEnvelope(:z, :x, :y) AS envelope_3857
        ),
        clipped AS (
            SELECT ST_AsMVTGeom(
                       ST_Transform(t.{geom}, 3857),
                       bounds.envelope_3857,
                       :extent, :buffer, true
                   ) AS geom,
                   t.{fid}::text AS fid
                   {attribute_select}
            FROM {table} AS t, bounds
            WHERE t.{geom} && ST_Transform(bounds.envelope_3857, :srid)
        )
        SELECT COALESCE(ST_AsMVT(clipped, :layer_name, :extent, 'geom', 'fid'), ''::bytea)
        FROM clipped
        WHERE geom IS NOT NULL
        """
    )
    result = await session.execute(
        sql,
        {
            "z": z,
            "x": x,
            "y": y,
            "extent": MVT_EXTENT,
            "buffer": MVT_BUFFER,
            "srid": source.srid,
            "layer_name": layer_name,
        },
    )
    blob = result.scalar_one_or_none()
    return bytes(blob) if blob else b""
```

- [ ] **Step 6: Implement `app/services/tile_service.py`**

```python
from __future__ import annotations

import hashlib
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import InvalidRequestError
from app.models.layer import Layer
from app.repositories import feature_repository, tile_repository
from app.services import catalog_service, layer_service

MAX_ZOOM = 24


def validate_tile_coords(z: int, x: int, y: int) -> None:
    if not 0 <= z <= MAX_ZOOM:
        raise InvalidRequestError(
            "Zoom out of range", details={"z": z, "maxZoom": MAX_ZOOM}
        )
    span = 1 << z
    if not (0 <= x < span and 0 <= y < span):
        raise InvalidRequestError(
            "Tile coordinate out of range for this zoom",
            details={"z": z, "x": x, "y": y, "tilesPerAxis": span},
        )


def tile_etag(layer: Layer, z: int, x: int, y: int) -> str:
    """Changes whenever the layer row changes, so a style or rename busts the cache."""
    seed = f"{layer.id}:{layer.updated_at.isoformat()}:{z}/{x}/{y}"
    return f'W/"{hashlib.sha256(seed.encode()).hexdigest()[:32]}"'


async def get_vector_tile(
    session: AsyncSession, layer_id: uuid.UUID, z: int, x: int, y: int
) -> tuple[bytes, Layer]:
    validate_tile_coords(z, x, y)
    layer = await layer_service.get_layer_or_404(session, layer_id)
    source = layer_service.require_postgis_source(layer)
    await catalog_service.verify_source(session, source)
    columns = await feature_repository.attribute_columns(session, source)
    blob = await tile_repository.render_mvt(session, source, columns, z, x, y, layer.name)
    return blob, layer
```

- [ ] **Step 7: Implement `app/api/v1/routes/tiles.py` and register it**

```python
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Path, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
from app.services import tile_service

router = APIRouter(prefix="/layers/{layer_id}/tiles", tags=["tiles"])

MVT_MEDIA_TYPE = "application/vnd.mapbox-vector-tile"
CACHE_CONTROL = "public, max-age=60"


@router.get(
    "/{z}/{x}/{y}.mvt",
    response_class=Response,
    responses={
        200: {"content": {MVT_MEDIA_TYPE: {}}},
        204: {"description": "No features in this tile"},
        304: {"description": "Not modified"},
    },
)
async def vector_tile(
    request: Request,
    layer_id: uuid.UUID,
    z: int = Path(...),
    x: int = Path(...),
    y: int = Path(...),
    session: AsyncSession = Depends(get_session),
) -> Response:
    blob, layer = await tile_service.get_vector_tile(session, layer_id, z, x, y)
    etag = tile_service.tile_etag(layer, z, x, y)
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers={"ETag": etag})
    headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL}
    if not blob:
        return Response(status_code=status.HTTP_204_NO_CONTENT, headers=headers)
    return Response(content=blob, media_type=MVT_MEDIA_TYPE, headers=headers)
```

Register `tiles.router` in `app/api/v1/router.py`.

- [ ] **Step 8: Run the tile tests and confirm they pass**

Run: `pytest tests/test_tile_coords.py tests/test_vector_tiles_api.py -v`
Expected: 18 passed (12 parametrised coordinate cases + 6 API cases).

If `test_empty_tile_returns_204` returns 200 with a tiny non-empty blob, `ST_AsMVT` produced a header-only tile — tighten the check in the route to `len(blob) <= 2` rather than falsy, and update the repository docstring to say so.

- [ ] **Step 9: Run the full gate and commit**

Run: `pytest -v && ruff check . && ruff format --check . && mypy app`

```bash
cd gis-platform
git add backend/app/repositories/tile_repository.py backend/app/services/tile_service.py \
        backend/app/api/v1/routes/tiles.py backend/app/api/v1/router.py backend/tests
git commit -m "feat: serve vector tiles with ST_AsMVT, ETags and 204 for empty tiles"
```

- [ ] **Step 10: Write `gis-platform/docs/05-vector-tiles-mvt.md`**

Sections and required content:
- `# 05 · Vector Tiles (MVT)` — when to prefer tiles over GeoJSON: tiles are pre-clipped, pre-simplified, cacheable and bounded in size; GeoJSON is better for editing because it round-trips exact geometry. Both paths exist in this platform, on purpose.
- `## The tile pyramid` — `2^z` tiles per axis, XYZ origin top-left, and paste `validate_tile_coords` with the parametrised test.
- `## `ST_TileEnvelope` and `ST_AsMVTGeom`` — paste the CTE and explain each argument of `ST_AsMVTGeom(geom, bounds, extent, buffer, clip)`: 4096 units of internal resolution, a 64-unit buffer so symbols straddling the seam are not clipped mid-icon, `clip=true`.
- `## Why columns, not jsonb` — paste `attribute_select` and the docstring paragraph explaining that `ST_AsMVT` maps columns to MVT attributes.
- `## Still index-driven` — point out that the `WHERE t.geom && ST_Transform(envelope, :srid)` line is the same trick as `04-feature-streaming.md`, and cross-link.
- `## Caching` — paste `tile_etag`, explain the weak ETag seeded from `layer.updated_at` (renaming or restyling the layer invalidates every tile), the `304` path, and why `max-age` is short.
- `## Empty tiles` — why `204` rather than an empty `200`: OpenLayers treats it as "nothing here" without attempting a protobuf parse.

---

## Task 11: Server Dataset Handle Pool (Memory Layer 1 of 3)

**Files:**
- Create: `gis-platform/backend/app/resources/__init__.py`
- Create: `gis-platform/backend/app/resources/dataset_pool.py`
- Create: `gis-platform/backend/app/schemas/system.py`
- Create: `gis-platform/backend/app/services/system_service.py`
- Create: `gis-platform/backend/app/api/v1/routes/system.py`
- Modify: `gis-platform/backend/app/api/v1/router.py`, `gis-platform/backend/app/main.py`
- Test: `gis-platform/backend/tests/test_dataset_pool.py`, `gis-platform/backend/tests/test_system_api.py`

**Interfaces:**
- Consumes: `Settings.raster_pool_max_open`, `Settings.raster_pool_idle_ttl_seconds`, `Settings.feature_bbox_limit`, `Settings.attribute_page_max` (Task 1).
- Produces:
  - `app.resources.dataset_pool.DatasetPool[T]` — generic async LRU pool. Constructor `DatasetPool(factory: Callable[[str], T], closer: Callable[[T], None], max_open: int, idle_ttl: float, clock: Callable[[], float] = time.monotonic)`. Methods: `acquire(key) -> AsyncContextManager[T]` (**exclusive** per key), `async evict_idle() -> int`, `async close_all() -> None`, `stats() -> PoolStats`.
  - `app.schemas.system.PoolStats(open_handles, max_open, idle_ttl_seconds, hits, misses, evictions, keys)`, `MemoryReport(raster_pool, feature_bbox_limit, attribute_page_max, process_rss_bytes)`.
  - `app.resources.dataset_pool.raster_pool` — module-level singleton wired to rio-tiler in Task 12; created here with a placeholder factory that raises, and replaced in Task 12.
  - Endpoint `GET /system/memory`.
  - `close_all()` is called from the app's lifespan shutdown.

- [ ] **Step 1: Write the failing pool tests (pure, no rasterio)**

`gis-platform/backend/tests/test_dataset_pool.py`:

```python
import asyncio

import pytest

from app.resources.dataset_pool import DatasetPool


class FakeHandle:
    def __init__(self, key: str) -> None:
        self.key = key
        self.closed = False


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def make_pool(max_open: int = 2, idle_ttl: float = 60.0):
    opened: list[str] = []
    closed: list[str] = []

    def factory(key: str) -> FakeHandle:
        opened.append(key)
        return FakeHandle(key)

    def closer(handle: FakeHandle) -> None:
        handle.closed = True
        closed.append(handle.key)

    clock = FakeClock()
    pool = DatasetPool(
        factory=factory, closer=closer, max_open=max_open, idle_ttl=idle_ttl, clock=clock
    )
    return pool, opened, closed, clock


async def test_first_acquire_opens_and_second_reuses() -> None:
    pool, opened, _closed, _clock = make_pool()
    async with pool.acquire("a") as handle:
        assert handle.key == "a"
    async with pool.acquire("a") as handle_again:
        assert handle_again is handle
    assert opened == ["a"]
    assert pool.stats().hits == 1
    assert pool.stats().misses == 1


async def test_exceeding_max_open_evicts_the_least_recently_used() -> None:
    pool, _opened, closed, _clock = make_pool(max_open=2)
    async with pool.acquire("a"):
        pass
    async with pool.acquire("b"):
        pass
    async with pool.acquire("a"):  # touches 'a', so 'b' is now the LRU
        pass
    async with pool.acquire("c"):
        pass
    assert closed == ["b"]
    assert pool.stats().open_handles == 2
    assert set(pool.stats().keys) == {"a", "c"}
    assert pool.stats().evictions == 1


async def test_a_handle_in_use_is_never_closed_by_eviction() -> None:
    pool, _opened, closed, _clock = make_pool(max_open=1)

    async def hold() -> None:
        async with pool.acquire("held"):
            await asyncio.sleep(0.05)

    holder = asyncio.create_task(hold())
    await asyncio.sleep(0.01)
    async with pool.acquire("other"):
        pass
    await holder
    assert "held" not in closed or closed.index("held") > 0


async def test_acquire_is_exclusive_per_key() -> None:
    pool, _opened, _closed, _clock = make_pool()
    order: list[str] = []

    async def worker(tag: str) -> None:
        async with pool.acquire("shared"):
            order.append(f"enter-{tag}")
            await asyncio.sleep(0.02)
            order.append(f"exit-{tag}")

    await asyncio.gather(worker("1"), worker("2"))
    # Never interleaved: each enter is immediately followed by its own exit.
    assert order[0].startswith("enter")
    assert order[1] == order[0].replace("enter", "exit")


async def test_different_keys_do_not_block_each_other() -> None:
    pool, _opened, _closed, _clock = make_pool(max_open=4)
    started = asyncio.Event()

    async def slow() -> None:
        async with pool.acquire("slow"):
            started.set()
            await asyncio.sleep(0.05)

    task = asyncio.create_task(slow())
    await started.wait()
    async with pool.acquire("fast") as handle:  # must not wait for 'slow'
        assert handle.key == "fast"
    await task


async def test_idle_handles_are_evicted_after_the_ttl() -> None:
    pool, _opened, closed, clock = make_pool(max_open=8, idle_ttl=30.0)
    async with pool.acquire("a"):
        pass
    clock.advance(10)
    assert await pool.evict_idle() == 0
    clock.advance(25)
    assert await pool.evict_idle() == 1
    assert closed == ["a"]
    assert pool.stats().open_handles == 0


async def test_close_all_closes_everything_and_resets_stats_keys() -> None:
    pool, _opened, closed, _clock = make_pool(max_open=4)
    for key in ("a", "b", "c"):
        async with pool.acquire(key):
            pass
    await pool.close_all()
    assert sorted(closed) == ["a", "b", "c"]
    assert pool.stats().open_handles == 0
    assert pool.stats().keys == []


async def test_a_failing_factory_does_not_leave_a_ghost_entry() -> None:
    def factory(key: str) -> FakeHandle:
        raise OSError("cannot open")

    pool = DatasetPool(
        factory=factory, closer=lambda handle: None, max_open=2, idle_ttl=60.0
    )
    with pytest.raises(OSError):
        async with pool.acquire("broken"):
            pass
    assert pool.stats().open_handles == 0
    assert pool.stats().keys == []
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pytest tests/test_dataset_pool.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.resources.dataset_pool'`.

- [ ] **Step 3: Implement `app/schemas/system.py`**

```python
from __future__ import annotations

from app.schemas.base import APIModel


class PoolStats(APIModel):
    open_handles: int
    max_open: int
    idle_ttl_seconds: float
    hits: int
    misses: int
    evictions: int
    keys: list[str]


class MemoryReport(APIModel):
    raster_pool: PoolStats
    feature_bbox_limit: int
    attribute_page_max: int
    process_rss_bytes: int
```

- [ ] **Step 4: Implement `app/resources/dataset_pool.py`**

```python
"""An async LRU pool of expensive, non-thread-safe dataset handles.

Opening a GeoTIFF is not free: GDAL parses the header, the internal tiling
scheme and the overview table. At one open per tile request a raster layer
would spend most of its time in `open()`. The pool keeps handles alive
between requests, bounded two ways — `max_open` (how many at once) and
`idle_ttl` (how long an unused one may linger).

Access is EXCLUSIVE per key. A rasterio dataset is not thread-safe, and
tile reads run on worker threads, so two concurrent reads of the same file
must serialise. Different files never block each other. The trade-off is
deliberate: correctness over per-file concurrency. Scaling one file across
cores would need N handles per key, which is future work.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import OrderedDict
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Generic, TypeVar

from app.schemas.system import PoolStats

logger = logging.getLogger(__name__)

T = TypeVar("T")


@dataclass
class _Entry(Generic[T]):
    handle: T
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    in_use: int = 0
    last_used: float = 0.0


class DatasetPool(Generic[T]):
    def __init__(
        self,
        *,
        factory: Callable[[str], T],
        closer: Callable[[T], None],
        max_open: int,
        idle_ttl: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._factory = factory
        self._closer = closer
        self._max_open = max_open
        self._idle_ttl = idle_ttl
        self._clock = clock
        self._entries: OrderedDict[str, _Entry[T]] = OrderedDict()
        self._guard = asyncio.Lock()
        self._hits = 0
        self._misses = 0
        self._evictions = 0

    @asynccontextmanager
    async def acquire(self, key: str) -> AsyncIterator[T]:
        entry = await self._checkout(key)
        try:
            async with entry.lock:
                yield entry.handle
        finally:
            async with self._guard:
                entry.in_use -= 1
                entry.last_used = self._clock()
                self._entries.move_to_end(key)
                await self._enforce_capacity()

    async def _checkout(self, key: str) -> _Entry[T]:
        async with self._guard:
            entry = self._entries.get(key)
            if entry is not None:
                self._hits += 1
                entry.in_use += 1
                entry.last_used = self._clock()
                self._entries.move_to_end(key)
                return entry

            self._misses += 1
            try:
                handle = self._factory(key)
            except Exception:
                logger.exception("Failed to open dataset %s", key)
                raise
            entry = _Entry(handle=handle, in_use=1, last_used=self._clock())
            self._entries[key] = entry
            await self._enforce_capacity()
            return entry

    async def _enforce_capacity(self) -> None:
        """Caller must hold self._guard. Closes idle handles, oldest first."""
        for key in list(self._entries.keys()):
            if len(self._entries) <= self._max_open:
                return
            entry = self._entries[key]
            if entry.in_use > 0:
                continue  # never close a handle someone is reading
            self._close_entry(key, entry)
            self._evictions += 1

    def _close_entry(self, key: str, entry: _Entry[T]) -> None:
        try:
            self._closer(entry.handle)
        except Exception:  # a failing close must not poison the pool
            logger.exception("Failed to close dataset %s", key)
        finally:
            self._entries.pop(key, None)

    async def evict_idle(self) -> int:
        now = self._clock()
        removed = 0
        async with self._guard:
            for key in list(self._entries.keys()):
                entry = self._entries[key]
                if entry.in_use == 0 and now - entry.last_used >= self._idle_ttl:
                    self._close_entry(key, entry)
                    self._evictions += 1
                    removed += 1
        return removed

    async def close_all(self) -> None:
        async with self._guard:
            for key in list(self._entries.keys()):
                self._close_entry(key, self._entries[key])

    def stats(self) -> PoolStats:
        return PoolStats(
            open_handles=len(self._entries),
            max_open=self._max_open,
            idle_ttl_seconds=self._idle_ttl,
            hits=self._hits,
            misses=self._misses,
            evictions=self._evictions,
            keys=list(self._entries.keys()),
        )
```

- [ ] **Step 5: Run the pool tests and confirm they pass**

Run: `pytest tests/test_dataset_pool.py -v`
Expected: 8 passed.

If `test_exceeding_max_open_evicts_the_least_recently_used` reports `closed == []`, `_enforce_capacity` is running before the new entry is inserted — it must run *after*, as written.

- [ ] **Step 6: Implement the system endpoint**

`app/services/system_service.py`:

```python
from __future__ import annotations

import psutil

from app.core.config import get_settings
from app.resources.dataset_pool import get_raster_pool
from app.schemas.system import MemoryReport


def memory_report() -> MemoryReport:
    settings = get_settings()
    return MemoryReport(
        raster_pool=get_raster_pool().stats(),
        feature_bbox_limit=settings.feature_bbox_limit,
        attribute_page_max=settings.attribute_page_max,
        process_rss_bytes=int(psutil.Process().memory_info().rss),
    )
```

Append to `app/resources/dataset_pool.py`:

```python
_raster_pool: DatasetPool[object] | None = None


def set_raster_pool(pool: DatasetPool[object]) -> None:
    global _raster_pool
    _raster_pool = pool


def get_raster_pool() -> DatasetPool[object]:
    if _raster_pool is None:
        raise RuntimeError("Raster pool has not been initialised")
    return _raster_pool
```

`app/api/v1/routes/system.py`:

```python
from fastapi import APIRouter

from app.schemas.system import MemoryReport
from app.services import system_service

router = APIRouter(prefix="/system", tags=["system"])


@router.get("/memory", response_model=MemoryReport)
def memory() -> MemoryReport:
    return system_service.memory_report()
```

Register `system.router` in `app/api/v1/router.py`.

- [ ] **Step 7: Wire the pool into the app lifespan**

Modify `app/main.py`'s `lifespan` to build and tear down the pool. The factory is a placeholder here and is replaced in Task 12:

```python
from app.resources.dataset_pool import DatasetPool, get_raster_pool, set_raster_pool


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = get_settings()
    settings.raster_dir.mkdir(parents=True, exist_ok=True)
    settings.upload_tmp_dir.mkdir(parents=True, exist_ok=True)

    from app.services.raster_tile_service import close_reader, open_reader

    set_raster_pool(
        DatasetPool(
            factory=open_reader,
            closer=close_reader,
            max_open=settings.raster_pool_max_open,
            idle_ttl=settings.raster_pool_idle_ttl_seconds,
        )
    )
    try:
        yield
    finally:
        await get_raster_pool().close_all()
```

Because `app.services.raster_tile_service` does not exist yet, create a minimal stub now so the app still starts, and replace it in Task 12:

`app/services/raster_tile_service.py` (stub):

```python
"""Placeholder replaced in Task 12."""

from __future__ import annotations

from typing import Any


def open_reader(key: str) -> Any:
    raise NotImplementedError("Raster tiling arrives in Task 12")


def close_reader(handle: Any) -> None:
    handle.close()
```

- [ ] **Step 8: Write and run the system API test**

`gis-platform/backend/tests/test_system_api.py`:

```python
from httpx import AsyncClient


async def test_memory_report_shape(client: AsyncClient) -> None:
    response = await client.get("/api/v1/system/memory")
    assert response.status_code == 200
    body = response.json()
    assert body["rasterPool"]["maxOpen"] == 8
    assert body["rasterPool"]["openHandles"] == 0
    assert body["featureBboxLimit"] == 2000
    assert body["attributePageMax"] == 500
    assert body["processRssBytes"] > 0
```

**Note:** the `client` fixture builds the app with `create_app()` but httpx's `ASGITransport` does not run lifespan. Update the `client` fixture in `conftest.py` to use `httpx.ASGITransport` together with `asgi_lifespan`-style manual startup — simplest correct fix, add to `conftest.py`:

```python
from contextlib import asynccontextmanager  # noqa: E402


@pytest_asyncio.fixture
async def client(db_session: AsyncSession) -> AsyncIterator[AsyncClient]:
    app = create_app()

    async def _override() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = _override
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as http_client:
            yield http_client
    app.dependency_overrides.clear()
```

Run: `pytest tests/test_system_api.py -v`
Expected: 1 passed.

- [ ] **Step 9: Run the full gate and commit**

Run: `pytest -v && ruff check . && ruff format --check . && mypy app`

```bash
cd gis-platform
git add backend/app/resources backend/app/schemas/system.py backend/app/services/system_service.py \
        backend/app/services/raster_tile_service.py backend/app/api backend/app/main.py backend/tests
git commit -m "feat: add bounded LRU dataset handle pool and system memory endpoint"
```

---

## Task 12: Raster Tiles and Statistics via rio-tiler

**Files:**
- Modify: `gis-platform/backend/app/services/raster_tile_service.py` (replace the Task 11 stub)
- Modify: `gis-platform/backend/app/api/v1/routes/tiles.py`
- Modify: `gis-platform/backend/app/api/v1/routes/features.py` (statistics endpoint)
- Test: `gis-platform/backend/tests/test_raster_tiles_api.py`
- Create: `gis-platform/docs/06-raster-tiling-and-cog.md`
- Create: `gis-platform/docs/07-memory-management.md`

**Interfaces:**
- Consumes: `DatasetPool`, `get_raster_pool` (Task 11); `resolve_raster_path` (Task 7); `RasterStyle` (Task 3); `validate_tile_coords`, `tile_etag` (Task 10); `layer_service.get_layer_or_404` (Task 4).
- Produces:
  - `app.services.raster_tile_service.open_reader(key: str) -> Reader`, `close_reader(reader: Reader) -> None` — the real pool factory/closer.
  - `app.services.raster_tile_service.render_png(session, layer_id, z, x, y) -> tuple[bytes | None, Layer]` — `None` means the tile is outside the raster.
  - `app.services.raster_tile_service.band_statistics(session, layer_id) -> RasterStatistics`.
  - `app.schemas.system.BandStatistics(band, min, max, mean, std, percentile_2, percentile_98)` and `RasterStatistics(bands: list[BandStatistics])`.
  - Endpoints `GET /layers/{layer_id}/tiles/{z}/{x}/{y}.png`, `GET /layers/{layer_id}/statistics`.

- [ ] **Step 1: Write the failing raster tile test**

`gis-platform/backend/tests/test_raster_tiles_api.py`:

```python
from pathlib import Path

import pytest
from httpx import AsyncClient


@pytest.fixture
async def raster_layer(client: AsyncClient, sample_geotiff: Path) -> dict:
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    return (
        await client.post(
            f"/api/v1/projects/{project_id}/layers/import-raster",
            files={"file": ("sample.tif", sample_geotiff.read_bytes(), "image/tiff")},
            data={"name": "Sample"},
        )
    ).json()


async def test_tile_covering_the_raster_returns_a_png(
    client: AsyncClient, raster_layer: dict
) -> None:
    # The sample covers 100..101E, 30..31N. At z=8 that is tile x=214, y=110 (approx).
    response = await client.get(f"/api/v1/layers/{raster_layer['id']}/tiles/0/0/0.png")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.content[:8] == b"\x89PNG\r\n\x1a\n"


async def test_tile_outside_the_raster_returns_204(
    client: AsyncClient, raster_layer: dict
) -> None:
    # A z=8 tile over the Atlantic, far from 100E/30N.
    response = await client.get(f"/api/v1/layers/{raster_layer['id']}/tiles/8/120/120.png")
    assert response.status_code == 204


async def test_raster_tile_sets_cache_headers(
    client: AsyncClient, raster_layer: dict
) -> None:
    response = await client.get(f"/api/v1/layers/{raster_layer['id']}/tiles/0/0/0.png")
    assert response.headers["cache-control"] == "public, max-age=60"
    assert response.headers["etag"]


async def test_out_of_range_raster_tile_is_rejected(
    client: AsyncClient, raster_layer: dict
) -> None:
    response = await client.get(f"/api/v1/layers/{raster_layer['id']}/tiles/0/9/9.png")
    assert response.status_code == 422


async def test_png_tiles_on_a_vector_layer_are_rejected(client: AsyncClient) -> None:
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    layer = (
        await client.post(
            f"/api/v1/projects/{project_id}/layers",
            json={
                "name": "OSM",
                "kind": "basemap",
                "source": {"type": "xyz", "url": "https://t/{z}/{x}/{y}.png"},
            },
        )
    ).json()
    response = await client.get(f"/api/v1/layers/{layer['id']}/tiles/0/0/0.png")
    assert response.status_code == 422


async def test_statistics_reports_per_band_ranges(
    client: AsyncClient, raster_layer: dict
) -> None:
    body = (await client.get(f"/api/v1/layers/{raster_layer['id']}/statistics")).json()
    assert len(body["bands"]) == 1
    band = body["bands"][0]
    assert band["band"] == 1
    assert band["min"] >= 0
    assert band["max"] <= 255
    assert band["max"] > band["min"]
    assert band["percentile98"] >= band["percentile2"]


async def test_the_pool_reports_a_handle_after_serving_tiles(
    client: AsyncClient, raster_layer: dict
) -> None:
    await client.get(f"/api/v1/layers/{raster_layer['id']}/tiles/0/0/0.png")
    stats = (await client.get("/api/v1/system/memory")).json()["rasterPool"]
    assert stats["openHandles"] == 1
    assert stats["misses"] >= 1

    await client.get(f"/api/v1/layers/{raster_layer['id']}/tiles/0/0/0.png")
    stats_again = (await client.get("/api/v1/system/memory")).json()["rasterPool"]
    assert stats_again["hits"] >= 1
    assert stats_again["openHandles"] == 1  # reused, not reopened
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pytest tests/test_raster_tiles_api.py -v`
Expected: FAIL — `NotImplementedError: Raster tiling arrives in Task 12`, or 404 on the `.png` route.

- [ ] **Step 3: Add the statistics schemas**

Append to `app/schemas/system.py`:

```python
class BandStatistics(APIModel):
    band: int
    min: float
    max: float
    mean: float
    std: float
    percentile2: float
    percentile98: float


class RasterStatistics(APIModel):
    bands: list[BandStatistics]
```

- [ ] **Step 4: Replace `app/services/raster_tile_service.py`**

```python
"""XYZ PNG tiles from COGs, read through the bounded dataset pool.

rio-tiler does the windowed read: given a tile's Web Mercator bounds it
picks the right overview level and reads only the bytes that intersect. All
of that is blocking file I/O, so every call is dispatched to a worker
thread; the pool's per-key lock guarantees only one thread touches a given
rasterio dataset at a time.
"""

from __future__ import annotations

import uuid

import anyio
from rio_tiler.colormap import cmap
from rio_tiler.io import Reader
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import InvalidRequestError, UpstreamDataError
from app.models.layer import Layer
from app.resources.dataset_pool import get_raster_pool
from app.schemas.source import RasterFileSource, parse_source
from app.schemas.style import RasterStyle, parse_style
from app.schemas.system import BandStatistics, RasterStatistics
from app.services import layer_service
from app.services.raster_import_service import resolve_raster_path
from app.services.tile_service import validate_tile_coords

TILE_SIZE = 256


def open_reader(key: str) -> Reader:
    """Pool factory. `key` is the absolute path of a raster on disk.

    NOTE: `DatasetPool._checkout` calls this synchronously **while holding the
    pool's global guard**, so a slow `Reader(...)` open blocks every other
    key's checkout — not just this key's. Task 11's pool deliberately keeps
    different keys independent, and a blocking factory partially undoes that.
    See the task step below: the open must not run on the event loop under the
    guard.
    """
    return Reader(key)


def close_reader(reader: Reader) -> None:
    reader.close()


def _require_raster_source(layer: Layer) -> RasterFileSource:
    source = parse_source(layer.source)
    if not isinstance(source, RasterFileSource):
        raise InvalidRequestError(
            f"Layer {layer.id} is not backed by a raster file",
            details={"layerId": str(layer.id), "sourceType": source.type},
        )
    return source


def _raster_style(layer: Layer, source: RasterFileSource) -> RasterStyle:
    style = parse_style(layer.style)
    if isinstance(style, RasterStyle):
        return style
    return RasterStyle(bands=list(range(1, min(source.band_count, 3) + 1)))


async def render_png(
    session: AsyncSession, layer_id: uuid.UUID, z: int, x: int, y: int
) -> tuple[bytes | None, Layer]:
    validate_tile_coords(z, x, y)
    layer = await layer_service.get_layer_or_404(session, layer_id)
    source = _require_raster_source(layer)
    style = _raster_style(layer, source)
    path = str(resolve_raster_path(source))

    def _read(reader: Reader) -> bytes | None:
        if not reader.tile_exists(x, y, z):
            return None
        image = reader.tile(x, y, z, indexes=style.bands, tilesize=TILE_SIZE)
        if style.rescale:
            image.rescale(in_range=[tuple(pair) for pair in style.rescale])
        colormap = None
        if style.colormap:
            try:
                colormap = cmap.get(style.colormap)
            except (KeyError, ValueError) as exc:
                raise InvalidRequestError(
                    "Unknown colormap",
                    details={"colormap": style.colormap},
                ) from exc
        return bytes(image.render(img_format="PNG", colormap=colormap))

    try:
        async with get_raster_pool().acquire(path) as reader:
            return await anyio.to_thread.run_sync(_read, reader), layer
    except (InvalidRequestError, UpstreamDataError):
        raise
    except FileNotFoundError as exc:
        raise UpstreamDataError(
            "Raster file is missing from disk", details={"path": source.path}
        ) from exc


async def band_statistics(session: AsyncSession, layer_id: uuid.UUID) -> RasterStatistics:
    layer = await layer_service.get_layer_or_404(session, layer_id)
    source = _require_raster_source(layer)
    path = str(resolve_raster_path(source))

    def _read(reader: Reader) -> RasterStatistics:
        raw = reader.statistics()
        bands: list[BandStatistics] = []
        for index, (_name, stat) in enumerate(raw.items(), start=1):
            bands.append(
                BandStatistics(
                    band=index,
                    min=float(stat.min),
                    max=float(stat.max),
                    mean=float(stat.mean),
                    std=float(stat.std),
                    percentile2=float(stat.percentile_2),
                    percentile98=float(stat.percentile_98),
                )
            )
        return RasterStatistics(bands=bands)

    async with get_raster_pool().acquire(path) as reader:
        return await anyio.to_thread.run_sync(_read, reader)
```

- [ ] **Step 4b: Keep a slow raster open from blocking every other layer**

Raised by the Task 11 review and carried forward: `DatasetPool._checkout` calls
the factory synchronously while holding the pool's global `_guard`. With the
Task 11 placeholder that was harmless (it raised immediately), but `Reader(path)`
does real file I/O — parsing the header, the tiling scheme and the overview
table. Opening one large or network-backed raster would therefore stall the
checkout of **every** key, undoing the "different keys do not block each other"
property Task 11's strengthened test protects.

Fix it in the pool, not by working around it here:

- In `app/resources/dataset_pool.py`, make `_checkout` await the factory off the
  event loop instead of calling it under the guard. `anyio.to_thread.run_sync`
  is already the project's idiom for blocking work. The guard must not be held
  across that await — re-check for a racing insert on the same key after the
  factory returns, and if another coroutine won the race, close the loser's
  handle with `self._closer` rather than leaking it.
- Keep `factory` a plain synchronous `Callable[[str], T]`; the pool owns the
  threading decision, not its callers.
- Add a test proving it: a factory that blocks on a `threading.Event` for one
  key must not delay a *different* key's checkout. Model it on the rewritten
  `test_different_keys_do_not_block_each_other` — gate on an event and assert
  the other key completes, rather than asserting elapsed milliseconds.
- Re-run the Task 11 pool tests; all of them must still pass, including
  exclusivity, in-use-eviction safety and the ghost-entry case. The ghost-entry
  test matters most here: a factory that throws must still leave nothing behind
  now that insertion happens after an await.

- [ ] **Step 5: Add the routes**

Append to `app/api/v1/routes/tiles.py`:

```python
from app.services import raster_tile_service

PNG_MEDIA_TYPE = "image/png"


@router.get(
    "/{z}/{x}/{y}.png",
    response_class=Response,
    responses={
        200: {"content": {PNG_MEDIA_TYPE: {}}},
        204: {"description": "Tile is outside the raster"},
        304: {"description": "Not modified"},
    },
)
async def raster_tile(
    request: Request,
    layer_id: uuid.UUID,
    z: int = Path(...),
    x: int = Path(...),
    y: int = Path(...),
    session: AsyncSession = Depends(get_session),
) -> Response:
    png, layer = await raster_tile_service.render_png(session, layer_id, z, x, y)
    etag = tile_service.tile_etag(layer, z, x, y)
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers={"ETag": etag})
    headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL}
    if png is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT, headers=headers)
    return Response(content=png, media_type=PNG_MEDIA_TYPE, headers=headers)
```

Append to `app/api/v1/routes/features.py`:

```python
from app.schemas.system import RasterStatistics
from app.services import raster_tile_service


@router.get("/statistics", response_model=RasterStatistics)
async def read_statistics(
    layer_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> RasterStatistics:
    return await raster_tile_service.band_statistics(session, layer_id)
```

- [ ] **Step 6: Run the raster tile tests and confirm they pass**

Run: `pytest tests/test_raster_tiles_api.py -v`
Expected: 7 passed.

Two things to settle against observed behaviour:
- `reader.statistics()` returns a dict keyed by band name (`"b1"`); if the attribute names differ from `percentile_2` / `percentile_98`, print one entry and map the real field names.
- If `test_tile_outside_the_raster_returns_204` fails because `tile_exists` is `True` for a distant tile, the raster's bounds are being interpreted in the wrong CRS — check `resolve_raster_path` returns the COG, not the original upload.

- [ ] **Step 7: Run the full gate and commit**

Run: `pytest -v && ruff check . && ruff format --check . && mypy app`

```bash
cd gis-platform
git add backend/app/services/raster_tile_service.py backend/app/schemas/system.py backend/app/api backend/tests
git commit -m "feat: serve raster XYZ tiles and band statistics through the pooled reader"
```

- [ ] **Step 8: Write `gis-platform/docs/06-raster-tiling-and-cog.md`**

Sections and required content:
- `# 06 · Raster Tiling and COG` — the problem: a 4 GB GeoTIFF cannot be shipped to a browser, and re-decoding it per tile cannot be afforded either.
- `## What makes a GeoTIFF "cloud-optimized"` — internal tiling (512×512 blocks instead of scanline stripes) plus overviews (pre-built pyramids). Explain that together these let a reader fetch a bounded byte range for any (z, x, y).
- `## Converting at import, once` — paste the `cog_validate` / `cog_translate` block from `raster_import_service._inspect_and_normalise` and state the trade: one slow import, then cheap tiles forever.
- `## Reading a tile` — paste `_read` from `render_png`; explain `tile_exists` (avoids rendering blank PNGs for tiles outside the footprint) and `indexes` (band selection).
- `## Rescaling` — why a uint16 or float32 raster renders black without `rescale`, and how `RasterStyle.rescale` is seeded from band statistics at import. Cross-link `08-styling-and-renderers.md`.
- `## Blocking I/O on an async server` — paste the `anyio.to_thread.run_sync(_read, reader)` line and explain that a blocking read on the event loop would stall every other request.
- `## Why the handle is exclusive` — rasterio datasets are not thread-safe; paste the `DatasetPool` docstring paragraph and state the concurrency trade-off explicitly, including the "N handles per key" future work.

- [ ] **Step 9: Write `gis-platform/docs/07-memory-management.md`**

This is the chapter that ties the three layers together. Sections and required content:
- `# 07 · Memory Management` — the framing: a GIS leaks in three distinct places, and each needs its own bound. A single global cache size does not fix any of them.
- `## Layer 1 — server dataset handles` — paste the `DatasetPool` class docstring and `stats()`. Explain `max_open` vs `idle_ttl` (one bounds concurrency, the other bounds staleness) and why an in-use handle is never evicted. Paste `test_a_handle_in_use_is_never_closed_by_eviction`.
- `## Layer 2 — the wire` — summarise `04-feature-streaming.md` in three sentences and paste `clamp_limit` plus the `truncated` flag. State the principle: the server never sends an unbounded result set, and never hides that it truncated.
- `## Layer 3 — the browser` — a forward reference to Task 18's `LayerMemoryManager`, describing the contract now: every tile and feature payload is measured, attributed to a layer, and evicted LRU under a byte budget; the layer currently being viewed is pinned.
- `## Observability` — paste the `/api/v1/system/memory` response shape and the `MemoryReport` schema. Explain that `processRssBytes` is the reality check against which the other numbers are read.
- `## Tuning` — a table of every relevant setting (`GIS_RASTER_POOL_MAX_OPEN`, `GIS_RASTER_POOL_IDLE_TTL_SECONDS`, `GIS_FEATURE_BBOX_LIMIT`, `GIS_ATTRIBUTE_PAGE_MAX`) with its default and the symptom that should make you change it.

---

## Task 13: Feature Editing — Create, Update, Delete

**Files:**
- Modify: `gis-platform/backend/app/schemas/feature.py`
- Modify: `gis-platform/backend/app/repositories/feature_repository.py`
- Create: `gis-platform/backend/app/services/edit_service.py`
- Modify: `gis-platform/backend/app/api/v1/routes/features.py`
- Test: `gis-platform/backend/tests/test_editing_api.py`
- Create: `gis-platform/docs/09-editing-and-transactions.md`

**Interfaces:**
- Consumes: `catalog_repository.list_columns`, `verify_source` (Task 5); `layer_service.get_layer_or_404`, `require_postgis_source` (Task 4); `feature_repository.attribute_columns` (Task 8); `qualified`, `quote`, `validate_identifier` (Task 5); `Feature` (Task 8).
- Produces:
  - `app.schemas.feature.FeatureWrite(geometry: dict | None, properties: dict[str, Any])` and `FeaturePatch(geometry: dict | None = None, properties: dict[str, Any] | None = None)`.
  - `app.services.edit_service.editable_columns(session, source) -> set[str]` — all columns except the geometry column, the id column, and any generated/identity column.
  - `app.services.edit_service.create_feature(session, layer_id, payload) -> Feature`, `update_feature(session, layer_id, feature_id, payload) -> Feature`, `delete_feature(session, layer_id, feature_id) -> None`.
  - `app.repositories.feature_repository.insert_feature`, `update_feature_row`, `delete_feature_row`, `read_one` — each returns the affected row in the same `{fid, geometry, properties}` shape as `read_in_bbox`.
  - Endpoints `POST /layers/{layer_id}/features`, `PATCH /layers/{layer_id}/features/{feature_id}`, `DELETE /layers/{layer_id}/features/{feature_id}`.

- [ ] **Step 1: Write the failing editing test**

`gis-platform/backend/tests/test_editing_api.py`:

```python
import pytest
from httpx import AsyncClient

from app.schemas.source import PostgisSource

POINT = {"type": "Point", "coordinates": [113.2644, 23.1291]}


@pytest.fixture
async def cities_layer(client: AsyncClient, seeded_spatial_table: PostgisSource) -> dict:
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    return (
        await client.post(
            f"/api/v1/projects/{project_id}/layers/from-postgis",
            json={
                "schemaName": "gis_data",
                "tableName": "test_cities",
                "geometryColumn": "geometry",
                "idColumn": "fid",
                "name": "Cities",
            },
        )
    ).json()


async def test_create_feature_returns_the_stored_row(
    client: AsyncClient, cities_layer: dict
) -> None:
    response = await client.post(
        f"/api/v1/layers/{cities_layer['id']}/features",
        json={"geometry": POINT, "properties": {"name": "Guangzhou", "population": 18700000}},
    )
    assert response.status_code == 201, response.text
    feature = response.json()
    assert feature["type"] == "Feature"
    assert feature["properties"]["name"] == "Guangzhou"
    assert feature["geometry"]["coordinates"] == pytest.approx([113.2644, 23.1291], abs=1e-6)
    assert feature["id"]  # server-assigned


async def test_created_feature_is_visible_to_a_bbox_read(
    client: AsyncClient, cities_layer: dict
) -> None:
    await client.post(
        f"/api/v1/layers/{cities_layer['id']}/features",
        json={"geometry": POINT, "properties": {"name": "Guangzhou", "population": 1}},
    )
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/features", params={"bbox": "113,23,114,24"}
        )
    ).json()
    assert [f["properties"]["name"] for f in body["features"]] == ["Guangzhou"]


async def test_patch_updates_attributes_only(client: AsyncClient, cities_layer: dict) -> None:
    response = await client.patch(
        f"/api/v1/layers/{cities_layer['id']}/features/1",
        json={"properties": {"population": 22000000}},
    )
    assert response.status_code == 200
    feature = response.json()
    assert feature["properties"]["population"] == 22000000
    assert feature["properties"]["name"] == "Beijing"  # untouched
    assert feature["geometry"]["coordinates"] == pytest.approx([116.4074, 39.9042], abs=1e-4)


async def test_patch_updates_geometry_only(client: AsyncClient, cities_layer: dict) -> None:
    response = await client.patch(
        f"/api/v1/layers/{cities_layer['id']}/features/1", json={"geometry": POINT}
    )
    assert response.status_code == 200
    feature = response.json()
    assert feature["geometry"]["coordinates"] == pytest.approx([113.2644, 23.1291], abs=1e-6)
    assert feature["properties"]["name"] == "Beijing"


async def test_patch_with_an_empty_body_is_rejected(
    client: AsyncClient, cities_layer: dict
) -> None:
    response = await client.patch(f"/api/v1/layers/{cities_layer['id']}/features/1", json={})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


async def test_cannot_write_the_primary_key(client: AsyncClient, cities_layer: dict) -> None:
    response = await client.patch(
        f"/api/v1/layers/{cities_layer['id']}/features/1", json={"properties": {"fid": 99}}
    )
    assert response.status_code == 422
    assert "fid" in str(response.json()["error"]["details"])


async def test_cannot_write_the_geometry_column_as_an_attribute(
    client: AsyncClient, cities_layer: dict
) -> None:
    response = await client.patch(
        f"/api/v1/layers/{cities_layer['id']}/features/1",
        json={"properties": {"geometry": "POINT(0 0)"}},
    )
    assert response.status_code == 422


async def test_cannot_write_an_unknown_column(client: AsyncClient, cities_layer: dict) -> None:
    response = await client.patch(
        f"/api/v1/layers/{cities_layer['id']}/features/1",
        json={"properties": {"injected": 1}},
    )
    assert response.status_code == 422


async def test_invalid_geometry_is_rejected(client: AsyncClient, cities_layer: dict) -> None:
    bowtie = {
        "type": "Polygon",
        "coordinates": [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]],
    }
    response = await client.patch(
        f"/api/v1/layers/{cities_layer['id']}/features/1", json={"geometry": bowtie}
    )
    assert response.status_code == 422
    assert "geometry" in response.json()["error"]["message"].lower()


async def test_malformed_geojson_geometry_is_rejected(
    client: AsyncClient, cities_layer: dict
) -> None:
    response = await client.patch(
        f"/api/v1/layers/{cities_layer['id']}/features/1",
        json={"geometry": {"type": "Nonsense", "coordinates": [1, 2]}},
    )
    assert response.status_code == 422


async def test_patching_a_missing_feature_is_a_404(
    client: AsyncClient, cities_layer: dict
) -> None:
    response = await client.patch(
        f"/api/v1/layers/{cities_layer['id']}/features/9999",
        json={"properties": {"population": 1}},
    )
    assert response.status_code == 404


async def test_delete_removes_the_row(client: AsyncClient, cities_layer: dict) -> None:
    assert (
        await client.delete(f"/api/v1/layers/{cities_layer['id']}/features/3")
    ).status_code == 204
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/features", params={"bbox": "-180,-90,180,90"}
        )
    ).json()
    assert "Lhasa" not in [f["properties"]["name"] for f in body["features"]]


async def test_deleting_a_missing_feature_is_a_404(
    client: AsyncClient, cities_layer: dict
) -> None:
    assert (
        await client.delete(f"/api/v1/layers/{cities_layer['id']}/features/9999")
    ).status_code == 404


async def test_editing_a_non_postgis_layer_is_rejected(client: AsyncClient) -> None:
    project_id = (await client.post("/api/v1/projects", json={"name": "P"})).json()["id"]
    layer = (
        await client.post(
            f"/api/v1/projects/{project_id}/layers",
            json={
                "name": "OSM",
                "kind": "basemap",
                "source": {"type": "xyz", "url": "https://t/{z}/{x}/{y}.png"},
            },
        )
    ).json()
    response = await client.post(
        f"/api/v1/layers/{layer['id']}/features",
        json={"geometry": POINT, "properties": {}},
    )
    assert response.status_code == 422


async def test_a_rejected_edit_leaves_the_row_unchanged(
    client: AsyncClient, cities_layer: dict
) -> None:
    await client.patch(
        f"/api/v1/layers/{cities_layer['id']}/features/1",
        json={"properties": {"population": 1}, "geometry": {"type": "Nonsense"}},
    )
    body = (
        await client.get(
            f"/api/v1/layers/{cities_layer['id']}/attributes",
            params={"filters": '[{"field": "fid", "op": "eq", "value": 1}]'},
        )
    ).json()
    assert body["rows"][0]["population"] == 21540000
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pytest tests/test_editing_api.py -v`
Expected: FAIL — 405/404, the write routes do not exist.

- [ ] **Step 3: Extend `app/schemas/feature.py`**

Append:

```python
class FeatureWrite(APIModel):
    """Body for POST /features. Geometry is required on create."""

    geometry: dict[str, Any]
    properties: dict[str, Any] = Field(default_factory=dict)


class FeaturePatch(APIModel):
    """Body for PATCH. Omitting a key means 'leave it alone'; both omitted is an error."""

    geometry: dict[str, Any] | None = None
    properties: dict[str, Any] | None = None
```

- [ ] **Step 4: Extend `app/repositories/feature_repository.py`**

Append:

```python
GEOMETRY_SQL = (
    "ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(:geojson), 4326), :srid)"
)

RETURNING_SQL = """
    RETURNING {fid}::text AS fid,
              ST_AsGeoJSON(ST_Transform({geom}, 4326)) AS geometry,
              to_jsonb({tbl}) - :geom_key - :id_key AS properties
"""


def _row_to_feature(row: Any) -> dict[str, Any]:
    return {
        "fid": row["fid"],
        "geometry": json.loads(row["geometry"]) if row["geometry"] else None,
        "properties": dict(row["properties"] or {}),
    }


async def geometry_is_valid(session: AsyncSession, geojson: str) -> tuple[bool, str | None]:
    """Ask PostGIS, not Python: it is the thing that will store the geometry."""
    row = (
        await session.execute(
            text(
                """
                SELECT ST_IsValid(g) AS valid, ST_IsValidReason(g) AS reason
                FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON(:geojson), 4326) AS g) AS parsed
                """
            ),
            {"geojson": geojson},
        )
    ).mappings().one()
    return bool(row["valid"]), None if row["valid"] else str(row["reason"])


async def read_one(
    session: AsyncSession, source: PostgisSource, feature_id: str
) -> dict[str, Any] | None:
    geom = quote(source.geometry_column)
    fid = quote(source.id_column)
    table = qualified(source.schema_name, source.table_name)
    row = (
        await session.execute(
            text(
                f"""
                SELECT t.{fid}::text AS fid,
                       ST_AsGeoJSON(ST_Transform(t.{geom}, 4326)) AS geometry,
                       to_jsonb(t) - :geom_key - :id_key AS properties
                FROM {table} AS t
                WHERE t.{fid}::text = :fid
                """
            ),
            {
                "fid": feature_id,
                "geom_key": source.geometry_column,
                "id_key": source.id_column,
            },
        )
    ).mappings().one_or_none()
    return None if row is None else _row_to_feature(row)


async def insert_feature(
    session: AsyncSession,
    source: PostgisSource,
    geojson: str,
    properties: dict[str, Any],
) -> dict[str, Any]:
    geom = quote(source.geometry_column)
    fid = quote(source.id_column)
    table = qualified(source.schema_name, source.table_name)
    alias = quote(source.table_name)

    names = [quote(validate_identifier(key)) for key in properties]
    placeholders = [f":p_{index}" for index in range(len(properties))]
    params: dict[str, Any] = {
        f"p_{index}": value for index, value in enumerate(properties.values())
    }
    params.update(
        {
            "geojson": geojson,
            "srid": source.srid,
            "geom_key": source.geometry_column,
            "id_key": source.id_column,
        }
    )

    columns = ", ".join([*names, geom])
    values = ", ".join([*placeholders, GEOMETRY_SQL])
    returning = RETURNING_SQL.format(fid=fid, geom=geom, tbl=alias)
    row = (
        await session.execute(
            text(f"INSERT INTO {table} AS {alias} ({columns}) VALUES ({values}) {returning}"),
            params,
        )
    ).mappings().one()
    return _row_to_feature(row)


async def update_feature_row(
    session: AsyncSession,
    source: PostgisSource,
    feature_id: str,
    geojson: str | None,
    properties: dict[str, Any] | None,
) -> dict[str, Any] | None:
    geom = quote(source.geometry_column)
    fid = quote(source.id_column)
    table = qualified(source.schema_name, source.table_name)
    alias = quote(source.table_name)

    assignments: list[str] = []
    params: dict[str, Any] = {
        "fid": feature_id,
        "srid": source.srid,
        "geom_key": source.geometry_column,
        "id_key": source.id_column,
    }
    for index, (key, value) in enumerate((properties or {}).items()):
        assignments.append(f"{quote(validate_identifier(key))} = :p_{index}")
        params[f"p_{index}"] = value
    if geojson is not None:
        assignments.append(f"{geom} = {GEOMETRY_SQL}")
        params["geojson"] = geojson

    returning = RETURNING_SQL.format(fid=fid, geom=geom, tbl=alias)
    row = (
        await session.execute(
            text(
                f"UPDATE {table} AS {alias} SET {', '.join(assignments)} "
                f"WHERE {alias}.{fid}::text = :fid {returning}"
            ),
            params,
        )
    ).mappings().one_or_none()
    return None if row is None else _row_to_feature(row)


async def delete_feature_row(
    session: AsyncSession, source: PostgisSource, feature_id: str
) -> bool:
    fid = quote(source.id_column)
    table = qualified(source.schema_name, source.table_name)
    result = await session.execute(
        text(f"DELETE FROM {table} WHERE {fid}::text = :fid"), {"fid": feature_id}
    )
    return (result.rowcount or 0) > 0
```

- [ ] **Step 5: Implement `app/services/edit_service.py`**

```python
"""Write path for features.

Three guards stand between a request body and an UPDATE statement:

1. The column must be in `editable_columns` — not the primary key, not the
   geometry column, not a generated or identity column.
2. The column name must pass `validate_identifier` on the way into SQL.
3. The geometry must survive `ST_GeomFromGeoJSON` and `ST_IsValid` before
   anything is written.

Each request is one transaction. A geometry that fails validation aborts
the whole statement, so a partially-applied edit is not possible.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from sqlalchemy.exc import DataError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import InvalidRequestError, NotFoundError
from app.repositories import catalog_repository, feature_repository
from app.schemas.feature import Feature, FeaturePatch, FeatureWrite
from app.schemas.source import PostgisSource
from app.services import catalog_service, layer_service


async def editable_columns(session: AsyncSession, source: PostgisSource) -> set[str]:
    columns = await catalog_repository.list_columns(
        session, source.schema_name, source.table_name
    )
    return {
        column.name
        for column in columns
        if column.editable
        and column.name != source.geometry_column
        and column.name != source.id_column
    }


def _reject_unwritable(properties: dict[str, Any], allowed: set[str]) -> None:
    offending = sorted(set(properties) - allowed)
    if offending:
        raise InvalidRequestError(
            "One or more properties are not writable on this layer",
            details={"rejected": offending, "editable": sorted(allowed)},
        )


async def _validated_geojson(session: AsyncSession, geometry: dict[str, Any] | None) -> str | None:
    if geometry is None:
        return None
    payload = json.dumps(geometry)
    try:
        valid, reason = await feature_repository.geometry_is_valid(session, payload)
    except (DataError, IntegrityError) as exc:
        await session.rollback()
        raise InvalidRequestError(
            "Geometry could not be parsed as GeoJSON",
            details={"reason": str(exc.orig)[:300] if exc.orig else None},
        ) from exc
    if not valid:
        raise InvalidRequestError("Geometry is not valid", details={"reason": reason})
    return payload


async def _resolve(session: AsyncSession, layer_id: uuid.UUID) -> PostgisSource:
    layer = await layer_service.get_layer_or_404(session, layer_id)
    source = layer_service.require_postgis_source(layer)
    await catalog_service.verify_source(session, source)
    return source


async def create_feature(
    session: AsyncSession, layer_id: uuid.UUID, payload: FeatureWrite
) -> Feature:
    source = await _resolve(session, layer_id)
    allowed = await editable_columns(session, source)
    _reject_unwritable(payload.properties, allowed)
    geojson = await _validated_geojson(session, payload.geometry)
    assert geojson is not None  # geometry is required on create

    try:
        row = await feature_repository.insert_feature(
            session, source, geojson, payload.properties
        )
    except IntegrityError as exc:
        await session.rollback()
        raise InvalidRequestError(
            "Insert violates a table constraint",
            details={"reason": str(exc.orig)[:300] if exc.orig else None},
        ) from exc
    return Feature(id=row["fid"], geometry=row["geometry"], properties=row["properties"])


async def update_feature(
    session: AsyncSession, layer_id: uuid.UUID, feature_id: str, payload: FeaturePatch
) -> Feature:
    if payload.geometry is None and not payload.properties:
        raise InvalidRequestError("Provide 'geometry', 'properties', or both")

    source = await _resolve(session, layer_id)
    allowed = await editable_columns(session, source)
    if payload.properties:
        _reject_unwritable(payload.properties, allowed)
    geojson = await _validated_geojson(session, payload.geometry)

    try:
        row = await feature_repository.update_feature_row(
            session, source, feature_id, geojson, payload.properties
        )
    except (IntegrityError, DataError) as exc:
        await session.rollback()
        raise InvalidRequestError(
            "Update violates a table constraint",
            details={"reason": str(exc.orig)[:300] if exc.orig else None},
        ) from exc
    if row is None:
        raise NotFoundError(
            f"Feature {feature_id} not found",
            details={"layerId": str(layer_id), "featureId": feature_id},
        )
    return Feature(id=row["fid"], geometry=row["geometry"], properties=row["properties"])


async def delete_feature(
    session: AsyncSession, layer_id: uuid.UUID, feature_id: str
) -> None:
    source = await _resolve(session, layer_id)
    deleted = await feature_repository.delete_feature_row(session, source, feature_id)
    if not deleted:
        raise NotFoundError(
            f"Feature {feature_id} not found",
            details={"layerId": str(layer_id), "featureId": feature_id},
        )
```

**On the `await session.rollback()` calls in the error paths above:** they predate the request-scoped unit of work and are now redundant — raising any exception makes the request boundary roll back. Evaluate whether to keep them. Keeping one is defensible only where the session must be usable *after* the error (it is not here — every path raises immediately); otherwise a service reaching into transaction state contradicts the transaction constraint. Whichever you choose, say why in your report.

- [ ] **Step 6: Add the routes**

Append to `app/api/v1/routes/features.py`:

```python
from fastapi import status

from app.schemas.feature import Feature, FeaturePatch, FeatureWrite
from app.services import edit_service


@router.post("/features", response_model=Feature, status_code=status.HTTP_201_CREATED)
async def create_feature(
    layer_id: uuid.UUID,
    payload: FeatureWrite,
    session: AsyncSession = Depends(get_session),
) -> Feature:
    return await edit_service.create_feature(session, layer_id, payload)


@router.patch("/features/{feature_id}", response_model=Feature)
async def update_feature(
    layer_id: uuid.UUID,
    feature_id: str,
    payload: FeaturePatch,
    session: AsyncSession = Depends(get_session),
) -> Feature:
    return await edit_service.update_feature(session, layer_id, feature_id, payload)


@router.delete("/features/{feature_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_feature(
    layer_id: uuid.UUID,
    feature_id: str,
    session: AsyncSession = Depends(get_session),
) -> None:
    await edit_service.delete_feature(session, layer_id, feature_id)
```

- [ ] **Step 7: Run the editing tests and confirm they pass**

Run: `pytest tests/test_editing_api.py -v`
Expected: 15 passed.

Likely adjustments, to be settled once against observed behaviour:
- `ST_GeomFromGeoJSON` on `{"type": "Nonsense"}` raises at the database level. If the error surfaces as `sqlalchemy.exc.InternalError` rather than `DataError`, widen the `except` tuple in `_validated_geojson` to include it.
- `await session.rollback()` inside the error path will also roll back the test's outer savepoint. If that breaks `test_a_rejected_edit_leaves_the_row_unchanged`, remove the explicit `rollback()` calls — the session is discarded per request anyway, and the outer transaction already isolates tests.

- [ ] **Step 8: Run the full gate and commit**

Run: `pytest -v && ruff check . && ruff format --check . && mypy app`
Expected: all green. This is the last backend task — the full suite should now be well over 100 tests.

```bash
cd gis-platform
git add backend/app/schemas/feature.py backend/app/repositories/feature_repository.py \
        backend/app/services/edit_service.py backend/app/api/v1/routes/features.py backend/tests
git commit -m "feat: add feature create, update and delete with column and geometry guards"
```

- [ ] **Step 9: Write `gis-platform/docs/09-editing-and-transactions.md`**

Sections and required content:
- `# 09 · Editing and Transactions` — the QGIS edit session compared with this design: QGIS buffers edits locally and commits on demand; this platform commits per request and buffers on the client (forward-reference Task 21).
- `## Three guards` — paste the `edit_service` module docstring and then each guard with its code: `editable_columns`, `_reject_unwritable`, `_validated_geojson`.
- `## Why PostGIS validates the geometry` — paste `geometry_is_valid` and explain that `ST_IsValid`/`ST_IsValidReason` is the same check the database would apply on write, so validating anywhere else risks disagreeing with storage. Include the bow-tie polygon from the test as a worked example and quote the reason string PostGIS returns.
- `## RETURNING instead of a second SELECT` — paste `RETURNING_SQL` and explain that it gives the client the authoritative post-write row (defaults, triggers, sequence-assigned ids) in one round trip.
- `## Never writable` — a short list with the reason for each: primary key (identity is not user data), geometry column as an attribute (it has a typed path), generated/identity columns (the database owns them).
- `## Transactions` — one request, one transaction; `session.commit()` only on the success path; a failed geometry aborts before any write. Paste `test_a_rejected_edit_leaves_the_row_unchanged`.
- `## What is deliberately missing` — no optimistic concurrency control. Explain why: it would need a version column on tables the platform does not own. State the consequence (last write wins) and the options if it were needed (`xmin` system column comparison, or an app-owned edit log).

---

## Task 14: Web Client Scaffold and Typed API Layer

**Files:**
- Create: `gis-platform/web/package.json`, `tsconfig.json`, `tsconfig.node.json`, `vite.config.ts`, `eslint.config.js`, `.prettierrc`, `index.html`
- Create: `gis-platform/web/src/main.tsx`, `src/App.tsx`, `src/index.css`
- Create: `gis-platform/web/src/api/types.ts`, `src/api/client.ts`, `src/api/layers.ts`, `src/api/features.ts`, `src/api/catalog.ts`, `src/api/system.ts`
- Create: `gis-platform/web/src/app/queryClient.ts`, `src/app/AppShell.tsx`
- Create: `gis-platform/web/vitest.setup.ts`
- Test: `gis-platform/web/src/api/client.test.ts`

**Interfaces:**
- Consumes: the backend API from Tasks 4–13 (contract only, no code import).
- Produces:
  - `src/api/types.ts` — TypeScript mirrors of every wire model: `LayerKind`, `LayerSource` (discriminated on `type`), `StyleSpec` / `VectorStyle` / `RasterStyle` / `Renderer` / `ColorStop` / `FillStyle` / `StrokeStyle` / `MarkerStyle` / `LabelStyle`, `Layer`, `Project`, `ProjectSummary`, `MapView`, `FeatureCollection`, `GeoFeature`, `FieldList`, `ColumnInfo`, `AttributePage`, `AttributeFilter`, `GeometryTableInfo`, `MemoryReport`, `RasterStatistics`, `ApiError`.
  - `src/api/client.ts` — `apiFetch<T>(path: string, init?: RequestInit): Promise<T>`, `ApiError` class with `status`, `code`, `message`, `details`; `API_BASE` constant.
  - `src/api/layers.ts` — `listProjects`, `createProject`, `getProject`, `updateProject`, `createLayer`, `updateLayer`, `deleteLayer`, `reorderLayers`, `importVector`, `importRaster`, `registerPostgisTable`.
  - `src/api/features.ts` — `getFeatures`, `getFields`, `getAttributes`, `createFeature`, `updateFeature`, `deleteFeature`, `tileUrl(layerId, ext)`.
  - `src/api/catalog.ts` — `listPostgisTables`. `src/api/system.ts` — `getMemoryReport`, `getRasterStatistics`.
  - npm scripts: `dev`, `build`, `preview`, `lint`, `typecheck`, `test`, `format`.

- [ ] **Step 1: Scaffold the project**

```bash
cd gis-platform
npm create vite@latest web -- --template react-ts
cd web
npm install ol zustand @tanstack/react-query
npm install -D vitest jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom prettier eslint typescript-eslint @eslint/js eslint-plugin-react-hooks
```

- [ ] **Step 2: Configure the toolchain**

`gis-platform/web/package.json` — replace `scripts` with:

```json
{
  "scripts": {
    "dev": "vite --port 1317",
    "build": "tsc -b && vite build",
    "preview": "vite preview --port 1317",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest",
    "format": "prettier --write \"src/**/*.{ts,tsx,css}\""
  }
}
```

`gis-platform/web/vite.config.ts`:

```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 1317,
    proxy: {
      '/api': { target: 'http://localhost:1316', changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
    css: false,
  },
})
```

`gis-platform/web/vitest.setup.ts`:

```ts
import '@testing-library/jest-dom/vitest'
```

`gis-platform/web/tsconfig.json` — ensure `strict` mode and the Vitest globals:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "vitest.setup.ts", "vite.config.ts"]
}
```

`gis-platform/web/eslint.config.js`:

```js
import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'coverage'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
)
```

`gis-platform/web/.prettierrc`:

```json
{ "semi": false, "singleQuote": true, "printWidth": 100, "trailingComma": "all" }
```

- [ ] **Step 3: Write the failing API client test**

`gis-platform/web/src/api/client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, apiFetch } from './client'

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const response = new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
}

afterEach(() => vi.restoreAllMocks())

describe('apiFetch', () => {
  it('returns the parsed body on success', async () => {
    mockFetch(200, { id: 'abc', name: 'Roads' })
    await expect(apiFetch<{ name: string }>('/layers/abc')).resolves.toEqual({
      id: 'abc',
      name: 'Roads',
    })
  })

  it('prefixes the API base path', async () => {
    const spy = mockFetch(200, {})
    await apiFetch('/projects')
    expect(spy.mock.calls[0]?.[0]).toBe('/api/v1/projects')
  })

  it('returns undefined for 204 responses', async () => {
    mockFetch(204, null)
    await expect(apiFetch('/layers/abc')).resolves.toBeUndefined()
  })

  it('throws an ApiError carrying the envelope code and details', async () => {
    mockFetch(404, {
      error: { code: 'not_found', message: 'Layer 7 not found', details: { layerId: 7 } },
    })
    const error = await apiFetch('/layers/7').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(404)
    expect((error as ApiError).code).toBe('not_found')
    expect((error as ApiError).message).toBe('Layer 7 not found')
    expect((error as ApiError).details).toEqual({ layerId: 7 })
  })

  it('falls back to a generic message when the body is not an envelope', async () => {
    const response = new Response('<html>502</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    const error = (await apiFetch('/layers').catch((caught: unknown) => caught)) as ApiError
    expect(error.status).toBe(502)
    expect(error.code).toBe('http_error')
    expect(error.message).toContain('502')
  })

  it('sends JSON bodies with the right content type', async () => {
    const spy = mockFetch(200, {})
    await apiFetch('/projects', { method: 'POST', json: { name: 'P' } })
    const init = spy.mock.calls[0]?.[1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"name":"P"}')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
  })

  it('does not set a content type for FormData bodies', async () => {
    const spy = mockFetch(200, {})
    const form = new FormData()
    form.append('file', new Blob(['x']), 'a.geojson')
    await apiFetch('/import', { method: 'POST', body: form })
    const init = spy.mock.calls[0]?.[1] as RequestInit
    expect(new Headers(init.headers).get('content-type')).toBeNull()
  })
})
```

- [ ] **Step 4: Run it and confirm it fails**

Run: `npm run test -- --run src/api/client.test.ts`
Expected: FAIL — cannot resolve `./client`.

- [ ] **Step 5: Implement `src/api/client.ts`**

```ts
export const API_BASE = '/api/v1'

export interface ApiErrorEnvelope {
  error: { code: string; message: string; details: unknown }
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown

  constructor(status: number, code: string, message: string, details: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface ApiRequestInit extends Omit<RequestInit, 'body'> {
  body?: BodyInit | null
  /** Convenience: serialised to JSON with the correct content type. */
  json?: unknown
}

function isEnvelope(value: unknown): value is ApiErrorEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const candidate = (value as { error?: unknown }).error
  return typeof candidate === 'object' && candidate !== null && 'code' in candidate
}

export async function apiFetch<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const { json, headers, ...rest } = init
  const finalHeaders = new Headers(headers)
  let body = rest.body

  if (json !== undefined) {
    body = JSON.stringify(json)
    finalHeaders.set('content-type', 'application/json')
  }

  const response = await fetch(`${API_BASE}${path}`, { ...rest, body, headers: finalHeaders })

  if (response.status === 204) return undefined as T

  const contentType = response.headers.get('content-type') ?? ''
  const payload: unknown = contentType.includes('application/json')
    ? await response.json()
    : await response.text()

  if (!response.ok) {
    if (isEnvelope(payload)) {
      throw new ApiError(
        response.status,
        payload.error.code,
        payload.error.message,
        payload.error.details,
      )
    }
    throw new ApiError(
      response.status,
      'http_error',
      `Request failed with status ${response.status}`,
      payload,
    )
  }

  return payload as T
}
```

- [ ] **Step 6: Run the client test and confirm it passes**

Run: `npm run test -- --run src/api/client.test.ts`
Expected: 7 passed.

- [ ] **Step 7: Implement `src/api/types.ts`**

```ts
export type LayerKind = 'vector' | 'raster' | 'vector_tile' | 'basemap'

export interface PostgisSource {
  type: 'postgis'
  schemaName: string
  tableName: string
  geometryColumn: string
  idColumn: string
  srid: number
}
export interface RasterFileSource {
  type: 'raster_file'
  path: string
  bandCount: number
  nodata: number | null
  isCog: boolean
}
export interface XyzSource {
  type: 'xyz'
  url: string
  attribution: string | null
}
export interface MvtSource {
  type: 'mvt'
  url: string
  sourceLayer: string | null
}
export type LayerSource = PostgisSource | RasterFileSource | XyzSource | MvtSource

export interface FillStyle {
  color: string
  opacity: number
}
export interface StrokeStyle {
  color: string
  width: number
  dash: number[] | null
}
export interface MarkerStyle {
  shape: 'circle' | 'square' | 'triangle'
  radius: number
}
export interface LabelStyle {
  field: string
  color: string
  size: number
  haloColor: string
}
export interface ColorStop {
  color: string
  value: string | number | null
  min: number | null
  max: number | null
  label: string | null
}
export interface SingleRenderer {
  type: 'single'
}
export interface CategorizedRenderer {
  type: 'categorized'
  field: string
  categories: ColorStop[]
  fallbackColor: string
}
export interface GraduatedRenderer {
  type: 'graduated'
  field: string
  method: 'equal_interval' | 'quantile' | 'natural_breaks'
  classes: ColorStop[]
}
export type Renderer = SingleRenderer | CategorizedRenderer | GraduatedRenderer

export interface VectorStyle {
  kind: 'vector'
  renderer: Renderer
  fill: FillStyle
  stroke: StrokeStyle
  marker: MarkerStyle
  label: LabelStyle | null
}
export interface RasterStyle {
  kind: 'raster'
  bands: number[]
  rescale: [number, number][] | null
  colormap: string | null
  opacity: number
}
export type StyleSpec = VectorStyle | RasterStyle

export type Extent = [number, number, number, number]

export interface Layer {
  id: string
  projectId: string
  name: string
  kind: LayerKind
  source: LayerSource
  style: StyleSpec | null
  visible: boolean
  opacity: number
  zIndex: number
  extent: Extent | null
  featureCount: number | null
  srid: number | null
  geometryType: string | null
}

export interface MapView {
  center: [number, number]
  zoom: number
  projection: string
}
export interface Project {
  id: string
  name: string
  view: MapView
  layers: Layer[]
}
export interface ProjectSummary {
  id: string
  name: string
  layerCount: number
}

export interface GeoFeature {
  type: 'Feature'
  id: string
  geometry: GeoJSON.Geometry | null
  properties: Record<string, unknown>
}
export interface FeatureCollection {
  type: 'FeatureCollection'
  features: GeoFeature[]
  returned: number
  limit: number
  truncated: boolean
}

export interface ColumnInfo {
  name: string
  dataType: string
  nullable: boolean
  editable: boolean
}
export interface FieldList {
  fields: ColumnInfo[]
  idColumn: string
  geometryColumn: string
}
export interface AttributeFilter {
  field: string
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'in' | 'isnull' | 'notnull'
  value?: unknown
}
export interface AttributePage {
  columns: string[]
  rows: Record<string, unknown>[]
  page: number
  pageSize: number
  total: number
}

export interface GeometryTableInfo {
  schemaName: string
  tableName: string
  geometryColumn: string
  srid: number
  geometryType: string
  primaryKey: string | null
  estimatedRows: number
}

export interface PoolStats {
  openHandles: number
  maxOpen: number
  idleTtlSeconds: number
  hits: number
  misses: number
  evictions: number
  keys: string[]
}
export interface MemoryReport {
  rasterPool: PoolStats
  featureBboxLimit: number
  attributePageMax: number
  processRssBytes: number
}
export interface BandStatistics {
  band: number
  min: number
  max: number
  mean: number
  std: number
  percentile2: number
  percentile98: number
}
export interface RasterStatistics {
  bands: BandStatistics[]
}
```

`GeoJSON.Geometry` needs the ambient types: `npm install -D @types/geojson`.

- [ ] **Step 8: Implement the endpoint modules**

`src/api/layers.ts`:

```ts
import { apiFetch } from './client'
import type { Layer, MapView, Project, ProjectSummary, StyleSpec } from './types'

export const listProjects = () => apiFetch<ProjectSummary[]>('/projects')

export const createProject = (name: string) =>
  apiFetch<Project>('/projects', { method: 'POST', json: { name } })

export const getProject = (projectId: string) => apiFetch<Project>(`/projects/${projectId}`)

export const updateProject = (projectId: string, patch: { name?: string; view?: MapView }) =>
  apiFetch<Project>(`/projects/${projectId}`, { method: 'PATCH', json: patch })

export const createLayer = (projectId: string, body: Record<string, unknown>) =>
  apiFetch<Layer>(`/projects/${projectId}/layers`, { method: 'POST', json: body })

export const updateLayer = (
  layerId: string,
  patch: { name?: string; visible?: boolean; opacity?: number; style?: StyleSpec },
) => apiFetch<Layer>(`/layers/${layerId}`, { method: 'PATCH', json: patch })

export const deleteLayer = (layerId: string) =>
  apiFetch<void>(`/layers/${layerId}`, { method: 'DELETE' })

export const reorderLayers = (projectId: string, layerIds: string[]) =>
  apiFetch<Layer[]>(`/projects/${projectId}/layers/reorder`, { method: 'POST', json: { layerIds } })

export const registerPostgisTable = (
  projectId: string,
  body: {
    schemaName: string
    tableName: string
    geometryColumn: string
    idColumn: string
    name: string
  },
) => apiFetch<Layer>(`/projects/${projectId}/layers/from-postgis`, { method: 'POST', json: body })

function uploadForm(file: File, name?: string): FormData {
  const form = new FormData()
  form.append('file', file)
  if (name) form.append('name', name)
  return form
}

export const importVector = (projectId: string, file: File, name?: string) =>
  apiFetch<Layer>(`/projects/${projectId}/layers/import`, {
    method: 'POST',
    body: uploadForm(file, name),
  })

export const importRaster = (projectId: string, file: File, name?: string) =>
  apiFetch<Layer>(`/projects/${projectId}/layers/import-raster`, {
    method: 'POST',
    body: uploadForm(file, name),
  })
```

`src/api/features.ts`:

```ts
import { API_BASE, apiFetch } from './client'
import type {
  AttributeFilter,
  AttributePage,
  Extent,
  FeatureCollection,
  FieldList,
  GeoFeature,
} from './types'

export const getFeatures = (layerId: string, bbox: Extent, limit?: number) => {
  const params = new URLSearchParams({ bbox: bbox.join(',') })
  if (limit) params.set('limit', String(limit))
  return apiFetch<FeatureCollection>(`/layers/${layerId}/features?${params}`)
}

export const getFields = (layerId: string) => apiFetch<FieldList>(`/layers/${layerId}/fields`)

export const getAttributes = (
  layerId: string,
  options: {
    page?: number
    pageSize?: number
    sortBy?: string
    sortOrder?: 'asc' | 'desc'
    filters?: AttributeFilter[]
  } = {},
) => {
  const params = new URLSearchParams()
  if (options.page) params.set('page', String(options.page))
  if (options.pageSize) params.set('pageSize', String(options.pageSize))
  if (options.sortBy) params.set('sortBy', options.sortBy)
  if (options.sortOrder) params.set('sortOrder', options.sortOrder)
  if (options.filters?.length) params.set('filters', JSON.stringify(options.filters))
  return apiFetch<AttributePage>(`/layers/${layerId}/attributes?${params}`)
}

export const createFeature = (
  layerId: string,
  body: { geometry: GeoJSON.Geometry; properties: Record<string, unknown> },
) => apiFetch<GeoFeature>(`/layers/${layerId}/features`, { method: 'POST', json: body })

export const updateFeature = (
  layerId: string,
  featureId: string,
  patch: { geometry?: GeoJSON.Geometry; properties?: Record<string, unknown> },
) =>
  apiFetch<GeoFeature>(`/layers/${layerId}/features/${featureId}`, {
    method: 'PATCH',
    json: patch,
  })

export const deleteFeature = (layerId: string, featureId: string) =>
  apiFetch<void>(`/layers/${layerId}/features/${featureId}`, { method: 'DELETE' })

/** Template URL for OpenLayers tile sources. */
export const tileUrl = (layerId: string, ext: 'mvt' | 'png') =>
  `${API_BASE}/layers/${layerId}/tiles/{z}/{x}/{y}.${ext}`
```

`src/api/catalog.ts`:

```ts
import { apiFetch } from './client'
import type { GeometryTableInfo } from './types'

export const listPostgisTables = () =>
  apiFetch<GeometryTableInfo[]>('/connections/postgis/tables')
```

`src/api/system.ts`:

```ts
import { apiFetch } from './client'
import type { MemoryReport, RasterStatistics } from './types'

export const getMemoryReport = () => apiFetch<MemoryReport>('/system/memory')

export const getRasterStatistics = (layerId: string) =>
  apiFetch<RasterStatistics>(`/layers/${layerId}/statistics`)
```

- [ ] **Step 9: Implement the app shell**

`src/app/queryClient.ts`:

```ts
import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
})
```

`src/app/AppShell.tsx` — a three-region layout that later tasks fill in:

```tsx
import type { ReactNode } from 'react'

interface AppShellProps {
  sidebar: ReactNode
  map: ReactNode
  bottom: ReactNode
  inspector?: ReactNode
}

export function AppShell({ sidebar, map, bottom, inspector }: AppShellProps) {
  return (
    <div className="app-shell">
      <aside className="app-shell__sidebar">{sidebar}</aside>
      <main className="app-shell__main">
        <div className="app-shell__map">{map}</div>
        <div className="app-shell__bottom">{bottom}</div>
      </main>
      {inspector ? <aside className="app-shell__inspector">{inspector}</aside> : null}
    </div>
  )
}
```

`src/index.css` — add the grid (keep the Vite defaults above it):

```css
:root {
  --panel-bg: #f8fafc;
  --panel-border: #e2e8f0;
  --text: #0f172a;
  --accent: #2563eb;
}

body {
  margin: 0;
  color: var(--text);
  font: 14px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif;
}

.app-shell {
  display: grid;
  grid-template-columns: 300px 1fr auto;
  height: 100vh;
}

.app-shell__sidebar,
.app-shell__inspector {
  overflow-y: auto;
  background: var(--panel-bg);
  border-right: 1px solid var(--panel-border);
}

.app-shell__inspector {
  width: 320px;
  border-right: none;
  border-left: 1px solid var(--panel-border);
}

.app-shell__main {
  display: grid;
  grid-template-rows: 1fr 260px;
  min-width: 0;
}

.app-shell__map {
  position: relative;
  min-height: 0;
}

.app-shell__bottom {
  border-top: 1px solid var(--panel-border);
  overflow: auto;
  background: #fff;
}
```

`src/main.tsx`:

```tsx
import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { queryClient } from './app/queryClient'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
```

`src/App.tsx` — a placeholder replaced in Task 17:

```tsx
import { useQuery } from '@tanstack/react-query'

import { listProjects } from './api/layers'
import { AppShell } from './app/AppShell'

export function App() {
  const projects = useQuery({ queryKey: ['projects'], queryFn: listProjects })

  return (
    <AppShell
      sidebar={<div style={{ padding: 12 }}>Projects: {projects.data?.length ?? '…'}</div>}
      map={<div style={{ padding: 12 }}>Map goes here</div>}
      bottom={<div style={{ padding: 12 }}>Attribute table goes here</div>}
    />
  )
}
```

Delete the Vite starter files that are now unused: `src/App.css`, `src/assets/react.svg`.

- [ ] **Step 10: Run the gate**

Run: `npm run lint && npm run typecheck && npm run test -- --run`
Expected: all green, 7 tests pass.

- [ ] **Step 11: Verify the dev server talks to the backend**

```bash
# terminal 1
cd gis-platform/backend && uvicorn app.main:app --reload --port 1316
# terminal 2
cd gis-platform/web && npm run dev
```
Open `http://localhost:1317`. Expected: the sidebar shows `Projects: N` with the real count from Task 4's smoke check — proving the proxy, the client and the error envelope all line up. Stop both.

- [ ] **Step 12: Commit**

```bash
cd gis-platform
git add web
git commit -m "feat: scaffold the web client with a typed API layer and app shell"
```

---

## Task 15: OpenLayers Map and Layer Factory

**Files:**
- Create: `gis-platform/web/src/map/MapProvider.tsx`
- Create: `gis-platform/web/src/map/MapCanvas.tsx`
- Create: `gis-platform/web/src/map/layerFactory.ts`
- Create: `gis-platform/web/src/map/featureLoader.ts`
- Create: `gis-platform/web/src/map/syncLayers.ts`
- Modify: `gis-platform/web/src/App.tsx`, `src/index.css`
- Test: `gis-platform/web/src/map/layerFactory.test.ts`, `src/map/syncLayers.test.ts`

**Interfaces:**
- Consumes: `Layer`, `Extent`, `LayerSource` (Task 14); `tileUrl`, `getFeatures` (Task 14).
- Produces:
  - `src/map/layerFactory.ts` — `createOlLayer(layer: Layer, deps: LayerFactoryDeps): BaseLayer`, where `LayerFactoryDeps = { onFeatureBytes?: (layerId: string, bytes: number) => void; onTileBytes?: (layerId: string, bytes: number) => void; onTruncated?: (layerId: string, truncated: boolean) => void }`. Sets `layer_id`, `layer_kind` and `editable` properties on every OL layer. **Task 18 supplies the byte callbacks; Task 21 reads `editable`.**
  - `src/map/layerFactory.ts` — `applyLayerProperties(olLayer: BaseLayer, layer: Layer): void` (visibility, opacity, zIndex, style function).
  - `src/map/featureLoader.ts` — `createBboxLoader(layerId, deps)` returning an OL `FeatureLoader` that fetches `/features` and reports byte counts and truncation.
  - `src/map/syncLayers.ts` — `syncLayers(map: Map, layers: Layer[], deps): void` — reconciles the OL layer collection against the server list: adds new, removes gone, updates changed, never recreates an unchanged layer.
  - `src/map/MapProvider.tsx` — `MapProvider` + `useMap(): Map | null`.
  - `src/map/MapCanvas.tsx` — mounts the map into a div and drives `syncLayers`.

- [ ] **Step 1: Write the failing layer factory test**

`gis-platform/web/src/map/layerFactory.test.ts`:

```ts
import ImageLayer from 'ol/layer/Image'
import TileLayer from 'ol/layer/Tile'
import VectorLayer from 'ol/layer/Vector'
import VectorTileLayer from 'ol/layer/VectorTile'
import VectorSource from 'ol/source/Vector'
import VectorTileSource from 'ol/source/VectorTile'
import XYZ from 'ol/source/XYZ'
import { describe, expect, it } from 'vitest'

import type { Layer } from '../api/types'
import { applyLayerProperties, createOlLayer } from './layerFactory'

const base = {
  id: 'l1',
  projectId: 'p1',
  style: null,
  visible: true,
  opacity: 1,
  zIndex: 0,
  extent: null,
  featureCount: null,
  srid: 4326,
  geometryType: null,
} satisfies Partial<Layer>

const postgisLayer: Layer = {
  ...base,
  name: 'Roads',
  kind: 'vector',
  source: {
    type: 'postgis',
    schemaName: 'gis_data',
    tableName: 'roads',
    geometryColumn: 'geometry',
    idColumn: 'fid',
    srid: 4326,
  },
} as Layer

const rasterLayer: Layer = {
  ...base,
  name: 'DEM',
  kind: 'raster',
  source: { type: 'raster_file', path: 'a.tif', bandCount: 1, nodata: null, isCog: true },
} as Layer

const basemapLayer: Layer = {
  ...base,
  name: 'OSM',
  kind: 'basemap',
  source: { type: 'xyz', url: 'https://tile/{z}/{x}/{y}.png', attribution: '© OSM' },
} as Layer

const mvtLayer: Layer = {
  ...base,
  name: 'Water',
  kind: 'vector_tile',
  source: { type: 'mvt', url: 'https://tiles/{z}/{x}/{y}.pbf', sourceLayer: 'water' },
} as Layer

describe('createOlLayer', () => {
  it('builds a VectorLayer with a bbox-loading source for a PostGIS layer', () => {
    const olLayer = createOlLayer(postgisLayer, {})
    expect(olLayer).toBeInstanceOf(VectorLayer)
    expect((olLayer as VectorLayer).getSource()).toBeInstanceOf(VectorSource)
    expect(olLayer.get('editable')).toBe(true)
  })

  it('builds a TileLayer pointed at the raster tile endpoint', () => {
    const olLayer = createOlLayer(rasterLayer, {})
    expect(olLayer).toBeInstanceOf(TileLayer)
    const source = (olLayer as TileLayer<XYZ>).getSource()
    expect(source).toBeInstanceOf(XYZ)
    expect(source?.getUrls()?.[0]).toBe('/api/v1/layers/l1/tiles/{z}/{x}/{y}.png')
    expect(olLayer.get('editable')).toBe(false)
  })

  it('builds a TileLayer from a remote XYZ basemap url', () => {
    const olLayer = createOlLayer(basemapLayer, {})
    const source = (olLayer as TileLayer<XYZ>).getSource()
    expect(source?.getUrls()?.[0]).toBe('https://tile/{z}/{x}/{y}.png')
  })

  it('builds a VectorTileLayer for an MVT source', () => {
    const olLayer = createOlLayer(mvtLayer, {})
    expect(olLayer).toBeInstanceOf(VectorTileLayer)
    expect((olLayer as VectorTileLayer).getSource()).toBeInstanceOf(VectorTileSource)
  })

  it('tags every layer with its server id and kind', () => {
    const olLayer = createOlLayer(postgisLayer, {})
    expect(olLayer.get('layer_id')).toBe('l1')
    expect(olLayer.get('layer_kind')).toBe('vector')
  })

  it('never returns an ImageLayer (nothing here is single-image)', () => {
    for (const layer of [postgisLayer, rasterLayer, basemapLayer, mvtLayer]) {
      expect(createOlLayer(layer, {})).not.toBeInstanceOf(ImageLayer)
    }
  })
})

describe('applyLayerProperties', () => {
  it('mirrors visibility, opacity and z-index onto the OL layer', () => {
    const olLayer = createOlLayer(postgisLayer, {})
    applyLayerProperties(olLayer, { ...postgisLayer, visible: false, opacity: 0.25, zIndex: 7 })
    expect(olLayer.getVisible()).toBe(false)
    expect(olLayer.getOpacity()).toBe(0.25)
    expect(olLayer.getZIndex()).toBe(7)
  })

  it('is idempotent', () => {
    const olLayer = createOlLayer(postgisLayer, {})
    applyLayerProperties(olLayer, postgisLayer)
    applyLayerProperties(olLayer, postgisLayer)
    expect(olLayer.getOpacity()).toBe(1)
  })
})
```

- [ ] **Step 2: Write the failing reconciliation test**

`gis-platform/web/src/map/syncLayers.test.ts`:

```ts
import Map from 'ol/Map'
import View from 'ol/View'
import { describe, expect, it } from 'vitest'

import type { Layer } from '../api/types'
import { syncLayers } from './syncLayers'

function makeLayer(id: string, zIndex: number, overrides: Partial<Layer> = {}): Layer {
  return {
    id,
    projectId: 'p1',
    name: `Layer ${id}`,
    kind: 'basemap',
    source: { type: 'xyz', url: `https://tile/${id}/{z}/{x}/{y}.png`, attribution: null },
    style: null,
    visible: true,
    opacity: 1,
    zIndex,
    extent: null,
    featureCount: null,
    srid: null,
    geometryType: null,
    ...overrides,
  } as Layer
}

function makeMap(): Map {
  return new Map({ view: new View({ center: [0, 0], zoom: 2 }) })
}

const ids = (map: Map) => map.getLayers().getArray().map((l) => l.get('layer_id') as string)

describe('syncLayers', () => {
  it('adds layers that are new', () => {
    const map = makeMap()
    syncLayers(map, [makeLayer('a', 0), makeLayer('b', 1)], {})
    expect(ids(map)).toEqual(['a', 'b'])
  })

  it('removes layers that disappeared from the server list', () => {
    const map = makeMap()
    syncLayers(map, [makeLayer('a', 0), makeLayer('b', 1)], {})
    syncLayers(map, [makeLayer('a', 0)], {})
    expect(ids(map)).toEqual(['a'])
  })

  it('reuses the existing OL layer instance when a layer is unchanged', () => {
    const map = makeMap()
    syncLayers(map, [makeLayer('a', 0)], {})
    const first = map.getLayers().item(0)
    syncLayers(map, [makeLayer('a', 0)], {})
    expect(map.getLayers().item(0)).toBe(first)
  })

  it('updates visibility and opacity in place without recreating the layer', () => {
    const map = makeMap()
    syncLayers(map, [makeLayer('a', 0)], {})
    const first = map.getLayers().item(0)
    syncLayers(map, [makeLayer('a', 0, { visible: false, opacity: 0.3 })], {})
    expect(map.getLayers().item(0)).toBe(first)
    expect(first.getVisible()).toBe(false)
    expect(first.getOpacity()).toBe(0.3)
  })

  it('recreates the layer when its source changes', () => {
    const map = makeMap()
    syncLayers(map, [makeLayer('a', 0)], {})
    const first = map.getLayers().item(0)
    syncLayers(
      map,
      [
        makeLayer('a', 0, {
          source: { type: 'xyz', url: 'https://other/{z}/{x}/{y}.png', attribution: null },
        }),
      ],
      {},
    )
    expect(map.getLayers().item(0)).not.toBe(first)
  })

  it('applies z-index so draw order follows the server order', () => {
    const map = makeMap()
    syncLayers(map, [makeLayer('a', 0), makeLayer('b', 1), makeLayer('c', 2)], {})
    const byId = Object.fromEntries(
      map.getLayers().getArray().map((l) => [l.get('layer_id') as string, l.getZIndex()]),
    )
    expect(byId).toEqual({ a: 0, b: 1, c: 2 })
  })

  it('handles an empty layer list', () => {
    const map = makeMap()
    syncLayers(map, [makeLayer('a', 0)], {})
    syncLayers(map, [], {})
    expect(ids(map)).toEqual([])
  })
})
```

- [ ] **Step 3: Run both and confirm they fail**

Run: `npm run test -- --run src/map`
Expected: FAIL — cannot resolve `./layerFactory` / `./syncLayers`.

- [ ] **Step 4: Implement `src/map/featureLoader.ts`**

```ts
import type { Feature } from 'ol'
import GeoJSON from 'ol/format/GeoJSON'
import type { FeatureLoader } from 'ol/featureloader'
import { transformExtent } from 'ol/proj'
import type VectorSource from 'ol/source/Vector'

import { getFeatures } from '../api/features'
import type { Extent } from '../api/types'

export interface LoaderDeps {
  onFeatureBytes?: (layerId: string, bytes: number) => void
  onTruncated?: (layerId: string, truncated: boolean) => void
}

const format = new GeoJSON({ dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' })

/**
 * A bbox loading strategy: OpenLayers calls this with the current view
 * extent, we ask the server for just that window, and we tell the memory
 * manager how many bytes arrived. `truncated` is surfaced so the UI can warn
 * that the map is showing a sample, not the layer.
 */
export function createBboxLoader(layerId: string, deps: LoaderDeps): FeatureLoader {
  return function loader(this: VectorSource, extent, _resolution, projection, success, failure) {
    const wgs84 = transformExtent(extent, projection, 'EPSG:4326') as Extent
    const clamped: Extent = [
      Math.max(wgs84[0], -180),
      Math.max(wgs84[1], -90),
      Math.min(wgs84[2], 180),
      Math.min(wgs84[3], 90),
    ]

    getFeatures(layerId, clamped)
      .then((collection) => {
        deps.onFeatureBytes?.(layerId, JSON.stringify(collection).length)
        deps.onTruncated?.(layerId, collection.truncated)
        const features = format.readFeatures(collection) as Feature[]
        features.forEach((feature) => feature.set('layer_id', layerId))
        this.addFeatures(features)
        success?.(features)
      })
      .catch((error: unknown) => {
        console.error(`Failed to load features for layer ${layerId}`, error)
        failure?.()
      })
  }
}
```

- [ ] **Step 5: Implement `src/map/layerFactory.ts`**

```ts
import type BaseLayer from 'ol/layer/Base'
import TileLayer from 'ol/layer/Tile'
import VectorLayer from 'ol/layer/Vector'
import VectorTileLayer from 'ol/layer/VectorTile'
import MVT from 'ol/format/MVT'
import { bbox as bboxStrategy } from 'ol/loadingstrategy'
import VectorSource from 'ol/source/Vector'
import VectorTileSource from 'ol/source/VectorTile'
import XYZ from 'ol/source/XYZ'

import { tileUrl } from '../api/features'
import type { Layer } from '../api/types'
import { createBboxLoader, type LoaderDeps } from './featureLoader'
import { compileStyle } from './styleCompiler'

export interface LayerFactoryDeps extends LoaderDeps {
  onTileBytes?: (layerId: string, bytes: number) => void
}

/** A layer is editable only when its geometry lives in a PostGIS table. */
function isEditable(layer: Layer): boolean {
  return layer.source.type === 'postgis'
}

function tagLayer(olLayer: BaseLayer, layer: Layer): BaseLayer {
  olLayer.set('layer_id', layer.id)
  olLayer.set('layer_kind', layer.kind)
  olLayer.set('editable', isEditable(layer))
  return olLayer
}

export function createOlLayer(layer: Layer, deps: LayerFactoryDeps): BaseLayer {
  const source = layer.source

  if (source.type === 'postgis') {
    const vectorSource = new VectorSource({
      format: undefined,
      strategy: bboxStrategy,
      loader: createBboxLoader(layer.id, deps),
    })
    const olLayer = new VectorLayer({ source: vectorSource, style: compileStyle(layer.style) })
    return tagLayer(applyLayerProperties(olLayer, layer), layer)
  }

  if (source.type === 'mvt') {
    const vectorTileSource = new VectorTileSource({
      format: new MVT(),
      url: source.url,
    })
    const olLayer = new VectorTileLayer({
      source: vectorTileSource,
      style: compileStyle(layer.style),
    })
    return tagLayer(applyLayerProperties(olLayer, layer), layer)
  }

  if (source.type === 'raster_file') {
    const olLayer = new TileLayer({
      source: new XYZ({ url: tileUrl(layer.id, 'png'), crossOrigin: 'anonymous' }),
    })
    return tagLayer(applyLayerProperties(olLayer, layer), layer)
  }

  const olLayer = new TileLayer({
    source: new XYZ({
      url: source.url,
      attributions: source.attribution ?? undefined,
      crossOrigin: 'anonymous',
    }),
  })
  return tagLayer(applyLayerProperties(olLayer, layer), layer)
}

export function applyLayerProperties<T extends BaseLayer>(olLayer: T, layer: Layer): T {
  olLayer.setVisible(layer.visible)
  olLayer.setOpacity(layer.opacity)
  olLayer.setZIndex(layer.zIndex)
  if (olLayer instanceof VectorLayer || olLayer instanceof VectorTileLayer) {
    olLayer.setStyle(compileStyle(layer.style))
  }
  return olLayer
}
```

Task 16 implements `compileStyle`. Create a temporary stub now so this task's tests can run, and replace it in Task 16:

`src/map/styleCompiler.ts` (stub):

```ts
import type { StyleLike } from 'ol/style/Style'

import type { StyleSpec } from '../api/types'

export function compileStyle(_style: StyleSpec | null): StyleLike | undefined {
  return undefined
}
```

- [ ] **Step 6: Implement `src/map/syncLayers.ts`**

```ts
import type Map from 'ol/Map'
import type BaseLayer from 'ol/layer/Base'

import type { Layer } from '../api/types'
import { applyLayerProperties, createOlLayer, type LayerFactoryDeps } from './layerFactory'

/**
 * Reconcile the map's layer collection against the server's list.
 *
 * Recreating every OL layer on each render would throw away loaded features
 * and tile caches — the exact memory the platform works hardest to manage.
 * So a layer is rebuilt only when its *source* changes; everything else
 * (visibility, opacity, order, style) is applied in place.
 */
function sourceFingerprint(layer: Layer): string {
  return JSON.stringify(layer.source)
}

function styleFingerprint(layer: Layer): string {
  return JSON.stringify(layer.style)
}

export function syncLayers(map: Map, layers: Layer[], deps: LayerFactoryDeps): void {
  const collection = map.getLayers()
  const existing = new Map<string, BaseLayer>()
  for (const olLayer of collection.getArray()) {
    const id = olLayer.get('layer_id') as string | undefined
    if (id) existing.set(id, olLayer)
  }

  const wanted = new Set(layers.map((layer) => layer.id))
  for (const [id, olLayer] of existing) {
    if (!wanted.has(id)) {
      collection.remove(olLayer)
      existing.delete(id)
    }
  }

  for (const layer of layers) {
    const current = existing.get(layer.id)
    if (!current) {
      const created = createOlLayer(layer, deps)
      created.set('source_fingerprint', sourceFingerprint(layer))
      created.set('style_fingerprint', styleFingerprint(layer))
      collection.push(created)
      continue
    }

    if (current.get('source_fingerprint') !== sourceFingerprint(layer)) {
      collection.remove(current)
      const rebuilt = createOlLayer(layer, deps)
      rebuilt.set('source_fingerprint', sourceFingerprint(layer))
      rebuilt.set('style_fingerprint', styleFingerprint(layer))
      collection.push(rebuilt)
      continue
    }

    applyLayerProperties(current, layer)
    current.set('style_fingerprint', styleFingerprint(layer))
  }
}
```

**Note:** `syncLayers` shadows the OL `Map` import with the JS `Map` constructor. Rename the OL import to `import type OlMap from 'ol/Map'` and use `OlMap` in the signature.

- [ ] **Step 7: Implement the map components**

`src/map/MapProvider.tsx`:

```tsx
import OlMap from 'ol/Map'
import View from 'ol/View'
import { fromLonLat } from 'ol/proj'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

const MapContext = createContext<OlMap | null>(null)

export function useMap(): OlMap | null {
  return useContext(MapContext)
}

interface MapProviderProps {
  center: [number, number]
  zoom: number
  children: ReactNode
}

export function MapProvider({ center, zoom, children }: MapProviderProps) {
  const [map] = useState(
    () => new OlMap({ view: new View({ center: fromLonLat(center), zoom }), layers: [] }),
  )

  useEffect(() => () => map.setTarget(undefined), [map])

  const value = useMemo(() => map, [map])
  return <MapContext.Provider value={value}>{children}</MapContext.Provider>
}
```

`src/map/MapCanvas.tsx`:

```tsx
import { useEffect, useRef } from 'react'

import type { Layer } from '../api/types'
import type { LayerFactoryDeps } from './layerFactory'
import { useMap } from './MapProvider'
import { syncLayers } from './syncLayers'

interface MapCanvasProps {
  layers: Layer[]
  deps?: LayerFactoryDeps
}

export function MapCanvas({ layers, deps = {} }: MapCanvasProps) {
  const map = useMap()
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!map || !container.current) return
    map.setTarget(container.current)
    return () => map.setTarget(undefined)
  }, [map])

  useEffect(() => {
    if (map) syncLayers(map, layers, deps)
  }, [map, layers, deps])

  return <div ref={container} className="map-canvas" />
}
```

Add to `src/index.css`:

```css
.map-canvas {
  position: absolute;
  inset: 0;
}
```

Import OpenLayers' stylesheet in `src/main.tsx`: `import 'ol/ol.css'`.

- [ ] **Step 8: Wire the map into `App.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query'

import { getProject, listProjects } from './api/layers'
import { AppShell } from './app/AppShell'
import { MapCanvas } from './map/MapCanvas'
import { MapProvider } from './map/MapProvider'

export function App() {
  const projects = useQuery({ queryKey: ['projects'], queryFn: listProjects })
  const projectId = projects.data?.[0]?.id
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId!),
    enabled: Boolean(projectId),
  })

  const layers = project.data?.layers ?? []
  const view = project.data?.view

  return (
    <MapProvider center={view?.center ?? [0, 0]} zoom={view?.zoom ?? 2}>
      <AppShell
        sidebar={<div style={{ padding: 12 }}>{layers.length} layers</div>}
        map={<MapCanvas layers={layers} />}
        bottom={<div style={{ padding: 12 }}>Attribute table goes here</div>}
      />
    </MapProvider>
  )
}
```

- [ ] **Step 9: Run the map tests and confirm they pass**

Run: `npm run test -- --run src/map`
Expected: 15 passed (8 factory + 7 sync).

Two likely adjustments:
- `VectorSource` with `format: undefined` may fail typechecking; drop the `format` key entirely — the loader adds features directly.
- OL's `Map` constructed without a target in jsdom is fine, but if `new Map()` throws on missing `document`, add `/** @vitest-environment jsdom */` at the top of `syncLayers.test.ts`.

- [ ] **Step 10: Run the gate and commit**

Run: `npm run lint && npm run typecheck && npm run test -- --run`

```bash
cd gis-platform
git add web/src/map web/src/App.tsx web/src/main.tsx web/src/index.css
git commit -m "feat: render layers with OpenLayers via a source-driven layer factory"
```

---

## Task 16: Style Compiler — `StyleSpec` to OpenLayers

**Files:**
- Modify: `gis-platform/web/src/map/styleCompiler.ts` (replace the Task 15 stub)
- Create: `gis-platform/web/src/features/styling/ramps.ts`
- Test: `gis-platform/web/src/map/styleCompiler.test.ts`

**Interfaces:**
- Consumes: `StyleSpec`, `VectorStyle`, `Renderer`, `ColorStop` (Task 14).
- Produces:
  - `src/map/styleCompiler.ts` — `compileStyle(spec: StyleSpec | null): StyleLike | undefined`, `hexToRgba(hex: string, opacity: number): string`, `resolveColor(renderer: Renderer, properties: Record<string, unknown>, fallback: string): string`.
  - `src/features/styling/ramps.ts` — `RAMPS: Record<RampName, string[]>` with `RampName = 'viridis' | 'blues' | 'oranges' | 'spectral' | 'greys'`; `sampleRamp(name: RampName, count: number): string[]`; `buildGraduatedClasses(min, max, count, ramp): ColorStop[]`; `buildCategorizedClasses(values, ramp): ColorStop[]`. **Task 20 uses all four.**

- [ ] **Step 1: Write the failing style compiler test**

`gis-platform/web/src/map/styleCompiler.test.ts`:

```ts
import type { FeatureLike } from 'ol/Feature'
import Style from 'ol/style/Style'
import { describe, expect, it } from 'vitest'

import type { VectorStyle } from '../api/types'
import { compileStyle, hexToRgba } from './styleCompiler'

function fakeFeature(properties: Record<string, unknown>): FeatureLike {
  return {
    get: (key: string) => properties[key],
    getGeometry: () => ({ getType: () => 'Point' }),
  } as unknown as FeatureLike
}

const singleStyle: VectorStyle = {
  kind: 'vector',
  renderer: { type: 'single' },
  fill: { color: '#3b82f6', opacity: 0.6 },
  stroke: { color: '#1e3a8a', width: 2, dash: null },
  marker: { shape: 'circle', radius: 5 },
  label: null,
}

function styleFor(spec: VectorStyle, properties: Record<string, unknown> = {}): Style {
  const compiled = compileStyle(spec)
  expect(typeof compiled).toBe('function')
  const result = (compiled as (f: FeatureLike, r: number) => Style)(fakeFeature(properties), 1)
  return result
}

describe('hexToRgba', () => {
  it('converts a hex triplet and opacity to an rgba string', () => {
    expect(hexToRgba('#3b82f6', 0.5)).toBe('rgba(59, 130, 246, 0.5)')
  })

  it('clamps opacity into 0..1', () => {
    expect(hexToRgba('#000000', 2)).toBe('rgba(0, 0, 0, 1)')
    expect(hexToRgba('#000000', -1)).toBe('rgba(0, 0, 0, 0)')
  })

  it('falls back to grey for a malformed colour', () => {
    expect(hexToRgba('nonsense', 1)).toBe('rgba(156, 163, 175, 1)')
  })
})

describe('compileStyle', () => {
  it('returns undefined for a null spec so OL uses its default', () => {
    expect(compileStyle(null)).toBeUndefined()
  })

  it('returns undefined for a raster spec (rasters are styled server-side)', () => {
    expect(
      compileStyle({ kind: 'raster', bands: [1], rescale: null, colormap: null, opacity: 1 }),
    ).toBeUndefined()
  })

  it('applies fill, stroke and radius for a single-symbol renderer', () => {
    const style = styleFor(singleStyle)
    expect(style.getFill()?.getColor()).toBe('rgba(59, 130, 246, 0.6)')
    expect(style.getStroke()?.getColor()).toBe('rgba(30, 58, 138, 1)')
    expect(style.getStroke()?.getWidth()).toBe(2)
    expect(style.getImage()).toBeTruthy()
  })

  it('passes the dash array through', () => {
    const style = styleFor({ ...singleStyle, stroke: { ...singleStyle.stroke, dash: [4, 2] } })
    expect(style.getStroke()?.getLineDash()).toEqual([4, 2])
  })

  it('picks the matching category colour', () => {
    const spec: VectorStyle = {
      ...singleStyle,
      renderer: {
        type: 'categorized',
        field: 'landuse',
        fallbackColor: '#9ca3af',
        categories: [
          { color: '#ff0000', value: 'urban', min: null, max: null, label: null },
          { color: '#00ff00', value: 'forest', min: null, max: null, label: null },
        ],
      },
    }
    expect(styleFor(spec, { landuse: 'forest' }).getFill()?.getColor()).toBe(
      'rgba(0, 255, 0, 0.6)',
    )
  })

  it('uses the fallback colour when no category matches', () => {
    const spec: VectorStyle = {
      ...singleStyle,
      renderer: {
        type: 'categorized',
        field: 'landuse',
        fallbackColor: '#9ca3af',
        categories: [{ color: '#ff0000', value: 'urban', min: null, max: null, label: null }],
      },
    }
    expect(styleFor(spec, { landuse: 'water' }).getFill()?.getColor()).toBe(
      'rgba(156, 163, 175, 0.6)',
    )
  })

  it('compares category values loosely so numeric fields still match', () => {
    const spec: VectorStyle = {
      ...singleStyle,
      renderer: {
        type: 'categorized',
        field: 'code',
        fallbackColor: '#9ca3af',
        categories: [{ color: '#ff0000', value: 3, min: null, max: null, label: null }],
      },
    }
    expect(styleFor(spec, { code: '3' }).getFill()?.getColor()).toBe('rgba(255, 0, 0, 0.6)')
  })

  it('selects the graduated class containing the value', () => {
    const spec: VectorStyle = {
      ...singleStyle,
      renderer: {
        type: 'graduated',
        field: 'pop',
        method: 'equal_interval',
        classes: [
          { color: '#eff6ff', min: 0, max: 100, value: null, label: null },
          { color: '#60a5fa', min: 100, max: 1000, value: null, label: null },
          { color: '#1d4ed8', min: 1000, max: null, value: null, label: null },
        ],
      },
    }
    expect(styleFor(spec, { pop: 500 }).getFill()?.getColor()).toBe('rgba(96, 165, 250, 0.6)')
    expect(styleFor(spec, { pop: 5000 }).getFill()?.getColor()).toBe('rgba(29, 78, 216, 0.6)')
  })

  it('treats a class boundary as belonging to the upper class', () => {
    const spec: VectorStyle = {
      ...singleStyle,
      renderer: {
        type: 'graduated',
        field: 'pop',
        method: 'equal_interval',
        classes: [
          { color: '#eff6ff', min: 0, max: 100, value: null, label: null },
          { color: '#60a5fa', min: 100, max: 1000, value: null, label: null },
        ],
      },
    }
    expect(styleFor(spec, { pop: 100 }).getFill()?.getColor()).toBe('rgba(96, 165, 250, 0.6)')
  })

  it('falls back for a non-numeric value under a graduated renderer', () => {
    const spec: VectorStyle = {
      ...singleStyle,
      renderer: {
        type: 'graduated',
        field: 'pop',
        method: 'equal_interval',
        classes: [{ color: '#eff6ff', min: 0, max: 100, value: null, label: null }],
      },
    }
    expect(styleFor(spec, { pop: 'unknown' }).getFill()?.getColor()).toBe(
      'rgba(156, 163, 175, 0.6)',
    )
  })

  it('adds a text style when a label field is configured', () => {
    const style = styleFor(
      { ...singleStyle, label: { field: 'name', color: '#111827', size: 12, haloColor: '#ffffff' } },
      { name: 'Beijing' },
    )
    expect(style.getText()?.getText()).toBe('Beijing')
    expect(style.getText()?.getFont()).toContain('12px')
  })

  it('omits the text style when the label field is empty on this feature', () => {
    const style = styleFor(
      { ...singleStyle, label: { field: 'name', color: '#111827', size: 12, haloColor: '#ffffff' } },
      {},
    )
    expect(style.getText()?.getText()).toBeFalsy()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run test -- --run src/map/styleCompiler.test.ts`
Expected: FAIL — `compileStyle` returns `undefined` for every input (the Task 15 stub).

- [ ] **Step 3: Implement `src/features/styling/ramps.ts`**

```ts
import type { ColorStop } from '../../api/types'

export type RampName = 'viridis' | 'blues' | 'oranges' | 'spectral' | 'greys'

/** Five anchor colours per ramp; `sampleRamp` interpolates between them. */
export const RAMPS: Record<RampName, string[]> = {
  viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
  blues: ['#eff6ff', '#bfdbfe', '#60a5fa', '#2563eb', '#1e3a8a'],
  oranges: ['#fff7ed', '#fed7aa', '#fb923c', '#ea580c', '#7c2d12'],
  spectral: ['#d53e4f', '#fc8d59', '#ffffbf', '#99d594', '#3288bd'],
  greys: ['#f8fafc', '#cbd5e1', '#94a3b8', '#475569', '#0f172a'],
}

function parseHex(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!match?.[1]) return [156, 163, 175]
  const value = Number.parseInt(match[1], 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function toHex([r, g, b]: [number, number, number]): string {
  const part = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

export function sampleRamp(name: RampName, count: number): string[] {
  const anchors = RAMPS[name]
  if (count <= 0) return []
  if (count === 1) return [anchors[Math.floor(anchors.length / 2)]!]

  return Array.from({ length: count }, (_unused, index) => {
    const position = (index / (count - 1)) * (anchors.length - 1)
    const lower = Math.floor(position)
    const upper = Math.min(lower + 1, anchors.length - 1)
    const t = position - lower
    const a = parseHex(anchors[lower]!)
    const b = parseHex(anchors[upper]!)
    return toHex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t])
  })
}

export function buildGraduatedClasses(
  min: number,
  max: number,
  count: number,
  ramp: RampName,
): ColorStop[] {
  const colors = sampleRamp(ramp, count)
  const step = (max - min) / count
  return colors.map((color, index) => {
    const lower = min + step * index
    const upper = index === count - 1 ? null : min + step * (index + 1)
    return {
      color,
      min: lower,
      max: upper,
      value: null,
      label: upper === null ? `≥ ${lower.toFixed(1)}` : `${lower.toFixed(1)} – ${upper.toFixed(1)}`,
    }
  })
}

export function buildCategorizedClasses(
  values: (string | number)[],
  ramp: RampName,
): ColorStop[] {
  const unique = [...new Set(values)]
  const colors = sampleRamp(ramp, unique.length)
  return unique.map((value, index) => ({
    color: colors[index] ?? '#9ca3af',
    value,
    min: null,
    max: null,
    label: String(value),
  }))
}
```

- [ ] **Step 4: Replace `src/map/styleCompiler.ts`**

```ts
import type { FeatureLike } from 'ol/Feature'
import Circle from 'ol/style/Circle'
import Fill from 'ol/style/Fill'
import RegularShape from 'ol/style/RegularShape'
import Stroke from 'ol/style/Stroke'
import Style, { type StyleLike } from 'ol/style/Style'
import Text from 'ol/style/Text'

import type { Renderer, StyleSpec, VectorStyle } from '../api/types'

const FALLBACK = '#9ca3af'

export function hexToRgba(hex: string, opacity: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  const value = Number.parseInt(match?.[1] ?? '9ca3af', 16)
  const alpha = Math.min(1, Math.max(0, opacity))
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`
}

/**
 * Which colour a feature gets. Categorized compares loosely (`String(a) ===
 * String(b)`) because a numeric column arriving as a string from MVT
 * attributes should still match a numeric category. Graduated treats a class
 * as `[min, max)` so a value sitting exactly on a boundary lands in the upper
 * class, and an open-ended final class (`max: null`) catches the tail.
 */
export function resolveColor(
  renderer: Renderer,
  properties: (key: string) => unknown,
  fallback: string,
): string {
  if (renderer.type === 'single') return fallback

  const raw = properties(renderer.field)

  if (renderer.type === 'categorized') {
    const match = renderer.categories.find(
      (category) => String(category.value) === String(raw),
    )
    return match?.color ?? renderer.fallbackColor
  }

  const numeric = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(numeric)) return FALLBACK

  const match = renderer.classes.find((cls) => {
    const lower = cls.min ?? Number.NEGATIVE_INFINITY
    const upper = cls.max ?? Number.POSITIVE_INFINITY
    return numeric >= lower && numeric < upper
  })
  return match?.color ?? FALLBACK
}

function buildImage(spec: VectorStyle, fillColor: string) {
  const fill = new Fill({ color: hexToRgba(fillColor, spec.fill.opacity) })
  const stroke = new Stroke({
    color: hexToRgba(spec.stroke.color, 1),
    width: spec.stroke.width,
  })
  const { shape, radius } = spec.marker

  if (shape === 'circle') return new Circle({ radius, fill, stroke })
  if (shape === 'square') {
    return new RegularShape({ points: 4, radius, angle: Math.PI / 4, fill, stroke })
  }
  return new RegularShape({ points: 3, radius, angle: 0, fill, stroke })
}

function compileVector(spec: VectorStyle): StyleLike {
  return (feature: FeatureLike) => {
    const read = (key: string) => feature.get(key)
    const color = resolveColor(spec.renderer, read, spec.fill.color)

    const style = new Style({
      fill: new Fill({ color: hexToRgba(color, spec.fill.opacity) }),
      stroke: new Stroke({
        color: hexToRgba(spec.stroke.color, 1),
        width: spec.stroke.width,
        lineDash: spec.stroke.dash ?? undefined,
      }),
      image: buildImage(spec, color),
    })

    if (spec.label) {
      const value = read(spec.label.field)
      style.setText(
        new Text({
          text: value === null || value === undefined ? '' : String(value),
          font: `${spec.label.size}px system-ui, sans-serif`,
          fill: new Fill({ color: hexToRgba(spec.label.color, 1) }),
          stroke: new Stroke({ color: hexToRgba(spec.label.haloColor, 1), width: 3 }),
          offsetY: -(spec.marker.radius + spec.label.size * 0.6),
          overflow: true,
        }),
      )
    }

    return style
  }
}

/** Raster symbology is applied server-side by rio-tiler, so there is nothing to compile. */
export function compileStyle(spec: StyleSpec | null): StyleLike | undefined {
  if (!spec || spec.kind !== 'vector') return undefined
  return compileVector(spec)
}
```

- [ ] **Step 5: Run the style tests and confirm they pass**

Run: `npm run test -- --run src/map/styleCompiler.test.ts`
Expected: 15 passed.

If `it('omits the text style when the label field is empty on this feature')` fails because `getText()` returns `undefined` rather than an empty string, relax the assertion to `expect(style.getText()?.getText() || '').toBe('')` — both encode "nothing is drawn".

- [ ] **Step 6: Add a ramp test**

`gis-platform/web/src/features/styling/ramps.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { buildCategorizedClasses, buildGraduatedClasses, RAMPS, sampleRamp } from './ramps'

describe('sampleRamp', () => {
  it('returns exactly the requested number of colours', () => {
    expect(sampleRamp('viridis', 7)).toHaveLength(7)
  })

  it('returns valid hex triplets', () => {
    for (const color of sampleRamp('spectral', 9)) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('starts and ends on the ramp anchors', () => {
    const colors = sampleRamp('blues', 5)
    expect(colors[0]).toBe(RAMPS.blues[0])
    expect(colors.at(-1)).toBe(RAMPS.blues.at(-1))
  })

  it('handles the degenerate counts', () => {
    expect(sampleRamp('greys', 0)).toEqual([])
    expect(sampleRamp('greys', 1)).toHaveLength(1)
  })
})

describe('buildGraduatedClasses', () => {
  it('covers the range contiguously with an open-ended top class', () => {
    const classes = buildGraduatedClasses(0, 100, 4, 'blues')
    expect(classes).toHaveLength(4)
    expect(classes[0]?.min).toBe(0)
    expect(classes[0]?.max).toBe(25)
    expect(classes[1]?.min).toBe(25)
    expect(classes.at(-1)?.max).toBeNull()
  })

  it('labels each class', () => {
    expect(buildGraduatedClasses(0, 10, 2, 'blues')[0]?.label).toBe('0.0 – 5.0')
  })
})

describe('buildCategorizedClasses', () => {
  it('deduplicates values and assigns one colour each', () => {
    const classes = buildCategorizedClasses(['a', 'b', 'a', 'c'], 'viridis')
    expect(classes.map((c) => c.value)).toEqual(['a', 'b', 'c'])
    expect(new Set(classes.map((c) => c.color)).size).toBe(3)
  })
})
```

Run: `npm run test -- --run src/features/styling/ramps.test.ts`
Expected: 7 passed.

- [ ] **Step 7: Run the gate and commit**

Run: `npm run lint && npm run typecheck && npm run test -- --run`

```bash
cd gis-platform
git add web/src/map/styleCompiler.ts web/src/map/styleCompiler.test.ts web/src/features/styling
git commit -m "feat: compile the engine-neutral style spec into OpenLayers styles"
```

- [ ] **Step 8: Extend `gis-platform/docs/08-styling-and-renderers.md`**

Append a section `## Compiling the spec in the browser` containing: the `compileVector` function; the `resolveColor` docstring pasted verbatim; a short explanation of why OpenLayers wants a *style function* rather than a static style (the colour depends on the feature's attributes, which the renderer only knows at draw time); and a paragraph noting that raster symbology compiles to nothing here because it is applied server-side by rio-tiler — cross-link `06-raster-tiling-and-cog.md`.

---

## Task 17: Layer Panel — Tree, Visibility, Opacity, Reorder, Add

**Files:**
- Create: `gis-platform/web/src/state/layerStore.ts`
- Create: `gis-platform/web/src/features/layers/useLayerMutations.ts`
- Create: `gis-platform/web/src/features/layers/LayerPanel.tsx`
- Create: `gis-platform/web/src/features/layers/AddLayerDialog.tsx`
- Create: `gis-platform/web/src/features/layers/reorder.ts`
- Modify: `gis-platform/web/src/App.tsx`, `src/index.css`
- Test: `gis-platform/web/src/features/layers/reorder.test.ts`, `src/state/layerStore.test.ts`, `src/features/layers/LayerPanel.test.tsx`

**Interfaces:**
- Consumes: `Layer`, `GeometryTableInfo` (Task 14); `updateLayer`, `deleteLayer`, `reorderLayers`, `importVector`, `importRaster`, `registerPostgisTable` (Task 14); `listPostgisTables` (Task 14); `useMap` (Task 15).
- Produces:
  - `src/state/layerStore.ts` — zustand store `useLayerStore` with `{ projectId, selectedLayerId, selectedFeatureIds, truncatedLayerIds, setProjectId, selectLayer, selectFeatures, toggleFeature, clearSelection, setTruncated }`. **Tasks 19, 20 and 21 all read `selectedLayerId`; Task 19 owns `selectedFeatureIds`.**
  - `src/features/layers/reorder.ts` — `moveItem<T>(items: T[], from: number, to: number): T[]`.
  - `src/features/layers/useLayerMutations.ts` — `useLayerMutations(projectId)` returning `{ setVisible, setOpacity, rename, remove, reorder, importFile, addPostgisTable }`, each a TanStack `useMutation` that invalidates `['project', projectId]`.
  - `src/features/layers/LayerPanel.tsx` — `<LayerPanel projectId layers />`.
  - `src/features/layers/AddLayerDialog.tsx` — `<AddLayerDialog projectId open onClose />`.

- [ ] **Step 1: Write the failing reorder and store tests**

`gis-platform/web/src/features/layers/reorder.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { moveItem } from './reorder'

describe('moveItem', () => {
  it('moves an item down', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
  })

  it('moves an item up', () => {
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
  })

  it('is a no-op when from equals to', () => {
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate the input', () => {
    const input = ['a', 'b', 'c']
    moveItem(input, 0, 2)
    expect(input).toEqual(['a', 'b', 'c'])
  })

  it('clamps out-of-range indices instead of producing holes', () => {
    expect(moveItem(['a', 'b'], 0, 9)).toEqual(['b', 'a'])
    expect(moveItem(['a', 'b'], -5, 1)).toEqual(['b', 'a'])
  })
})
```

`gis-platform/web/src/state/layerStore.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'

import { useLayerStore } from './layerStore'

const reset = () =>
  useLayerStore.setState({
    projectId: null,
    selectedLayerId: null,
    selectedFeatureIds: [],
    truncatedLayerIds: [],
  })

beforeEach(reset)

describe('layerStore', () => {
  it('selecting a layer clears the feature selection', () => {
    useLayerStore.getState().selectFeatures(['1', '2'])
    useLayerStore.getState().selectLayer('layer-a')
    expect(useLayerStore.getState().selectedLayerId).toBe('layer-a')
    expect(useLayerStore.getState().selectedFeatureIds).toEqual([])
  })

  it('re-selecting the same layer keeps the feature selection', () => {
    useLayerStore.getState().selectLayer('layer-a')
    useLayerStore.getState().selectFeatures(['1'])
    useLayerStore.getState().selectLayer('layer-a')
    expect(useLayerStore.getState().selectedFeatureIds).toEqual(['1'])
  })

  it('toggleFeature adds then removes', () => {
    useLayerStore.getState().toggleFeature('7')
    expect(useLayerStore.getState().selectedFeatureIds).toEqual(['7'])
    useLayerStore.getState().toggleFeature('7')
    expect(useLayerStore.getState().selectedFeatureIds).toEqual([])
  })

  it('setTruncated records and clears per layer without duplicates', () => {
    useLayerStore.getState().setTruncated('a', true)
    useLayerStore.getState().setTruncated('a', true)
    expect(useLayerStore.getState().truncatedLayerIds).toEqual(['a'])
    useLayerStore.getState().setTruncated('a', false)
    expect(useLayerStore.getState().truncatedLayerIds).toEqual([])
  })

  it('clearSelection clears features but keeps the active layer', () => {
    useLayerStore.getState().selectLayer('layer-a')
    useLayerStore.getState().selectFeatures(['1'])
    useLayerStore.getState().clearSelection()
    expect(useLayerStore.getState().selectedLayerId).toBe('layer-a')
    expect(useLayerStore.getState().selectedFeatureIds).toEqual([])
  })
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm run test -- --run src/features/layers/reorder.test.ts src/state/layerStore.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/features/layers/reorder.ts` and `src/state/layerStore.ts`**

`src/features/layers/reorder.ts`:

```ts
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  const last = items.length - 1
  const source = Math.min(Math.max(from, 0), last)
  const target = Math.min(Math.max(to, 0), last)
  if (source === target) return [...items]

  const next = [...items]
  const [moved] = next.splice(source, 1)
  next.splice(target, 0, moved as T)
  return next
}
```

`src/state/layerStore.ts`:

```ts
import { create } from 'zustand'

interface LayerState {
  projectId: string | null
  selectedLayerId: string | null
  selectedFeatureIds: string[]
  truncatedLayerIds: string[]
  setProjectId: (projectId: string | null) => void
  selectLayer: (layerId: string | null) => void
  selectFeatures: (featureIds: string[]) => void
  toggleFeature: (featureId: string) => void
  clearSelection: () => void
  setTruncated: (layerId: string, truncated: boolean) => void
}

/**
 * UI state only. Everything the server owns — the layer list itself — lives
 * in TanStack Query, so there is exactly one source of truth per fact.
 */
export const useLayerStore = create<LayerState>((set) => ({
  projectId: null,
  selectedLayerId: null,
  selectedFeatureIds: [],
  truncatedLayerIds: [],

  setProjectId: (projectId) => set({ projectId }),

  selectLayer: (layerId) =>
    set((state) =>
      state.selectedLayerId === layerId
        ? { selectedLayerId: layerId }
        : { selectedLayerId: layerId, selectedFeatureIds: [] },
    ),

  selectFeatures: (featureIds) => set({ selectedFeatureIds: featureIds }),

  toggleFeature: (featureId) =>
    set((state) => ({
      selectedFeatureIds: state.selectedFeatureIds.includes(featureId)
        ? state.selectedFeatureIds.filter((id) => id !== featureId)
        : [...state.selectedFeatureIds, featureId],
    })),

  clearSelection: () => set({ selectedFeatureIds: [] }),

  setTruncated: (layerId, truncated) =>
    set((state) => {
      const without = state.truncatedLayerIds.filter((id) => id !== layerId)
      return { truncatedLayerIds: truncated ? [...without, layerId] : without }
    }),
}))
```

- [ ] **Step 4: Run those two tests and confirm they pass**

Run: `npm run test -- --run src/features/layers/reorder.test.ts src/state/layerStore.test.ts`
Expected: 10 passed.

- [ ] **Step 5: Write the failing LayerPanel test**

`gis-platform/web/src/features/layers/LayerPanel.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as layersApi from '../../api/layers'
import type { Layer } from '../../api/types'
import { useLayerStore } from '../../state/layerStore'
import { LayerPanel } from './LayerPanel'

function makeLayer(id: string, name: string, zIndex: number): Layer {
  return {
    id,
    projectId: 'p1',
    name,
    kind: 'vector',
    source: {
      type: 'postgis',
      schemaName: 'gis_data',
      tableName: name.toLowerCase(),
      geometryColumn: 'geometry',
      idColumn: 'fid',
      srid: 4326,
    },
    style: null,
    visible: true,
    opacity: 1,
    zIndex,
    extent: null,
    featureCount: 12,
    srid: 4326,
    geometryType: 'POINT',
  } as Layer
}

const layers = [makeLayer('a', 'Roads', 0), makeLayer('b', 'Cities', 1)]

function renderPanel(overrides: Layer[] = layers) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <LayerPanel projectId="p1" layers={overrides} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  useLayerStore.setState({
    projectId: 'p1',
    selectedLayerId: null,
    selectedFeatureIds: [],
    truncatedLayerIds: [],
  })
})

afterEach(() => vi.restoreAllMocks())

describe('LayerPanel', () => {
  it('lists layers with the topmost first', () => {
    renderPanel()
    const names = screen.getAllByTestId('layer-name').map((el) => el.textContent)
    expect(names).toEqual(['Cities', 'Roads'])
  })

  it('shows the feature count and geometry type', () => {
    renderPanel()
    expect(screen.getAllByText(/12 features/)).toHaveLength(2)
    expect(screen.getAllByText(/POINT/)).toHaveLength(2)
  })

  it('toggling visibility calls updateLayer', async () => {
    const spy = vi.spyOn(layersApi, 'updateLayer').mockResolvedValue(layers[0]!)
    renderPanel()
    await userEvent.click(screen.getAllByLabelText(/toggle visibility/i)[0]!)
    await waitFor(() => expect(spy).toHaveBeenCalledWith('b', { visible: false }))
  })

  it('changing opacity calls updateLayer with the new value', async () => {
    const spy = vi.spyOn(layersApi, 'updateLayer').mockResolvedValue(layers[0]!)
    renderPanel()
    const slider = screen.getAllByLabelText(/opacity/i)[0]!
    await userEvent.clear(slider)
    fireOpacity(slider, 0.4)
    await waitFor(() => expect(spy).toHaveBeenCalledWith('b', { opacity: 0.4 }))
  })

  it('clicking a layer selects it in the store', async () => {
    renderPanel()
    await userEvent.click(screen.getByText('Roads'))
    expect(useLayerStore.getState().selectedLayerId).toBe('a')
  })

  it('removing a layer asks the API', async () => {
    const spy = vi.spyOn(layersApi, 'deleteLayer').mockResolvedValue(undefined)
    renderPanel()
    await userEvent.click(screen.getAllByLabelText(/remove layer/i)[0]!)
    await waitFor(() => expect(spy).toHaveBeenCalledWith('b'))
  })

  it('moving a layer up posts the full new order', async () => {
    const spy = vi.spyOn(layersApi, 'reorderLayers').mockResolvedValue(layers)
    renderPanel()
    // Displayed order is [Cities(b), Roads(a)]; move Roads up.
    await userEvent.click(screen.getAllByLabelText(/move layer up/i)[1]!)
    await waitFor(() => expect(spy).toHaveBeenCalledWith('p1', ['a', 'b']))
  })

  it('warns when a layer was truncated', () => {
    useLayerStore.setState({ truncatedLayerIds: ['a'] })
    renderPanel()
    expect(screen.getByRole('status')).toHaveTextContent(/showing a subset/i)
  })

  it('renders an empty state with no layers', () => {
    renderPanel([])
    expect(screen.getByText(/no layers yet/i)).toBeInTheDocument()
  })
})

/** `userEvent` cannot drag a range input; set the value and fire change. */
function fireOpacity(element: HTMLElement, value: number) {
  const input = element as HTMLInputElement
  input.value = String(value)
  input.dispatchEvent(new Event('change', { bubbles: true }))
}
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `npm run test -- --run src/features/layers/LayerPanel.test.tsx`
Expected: FAIL — cannot resolve `./LayerPanel`.

- [ ] **Step 7: Implement `src/features/layers/useLayerMutations.ts`**

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query'

import {
  deleteLayer,
  importRaster,
  importVector,
  registerPostgisTable,
  reorderLayers,
  updateLayer,
} from '../../api/layers'
import type { StyleSpec } from '../../api/types'

export function useLayerMutations(projectId: string) {
  const queryClient = useQueryClient()
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['project', projectId] })
  }

  const setVisible = useMutation({
    mutationFn: ({ layerId, visible }: { layerId: string; visible: boolean }) =>
      updateLayer(layerId, { visible }),
    onSuccess: invalidate,
  })

  const setOpacity = useMutation({
    mutationFn: ({ layerId, opacity }: { layerId: string; opacity: number }) =>
      updateLayer(layerId, { opacity }),
    onSuccess: invalidate,
  })

  const rename = useMutation({
    mutationFn: ({ layerId, name }: { layerId: string; name: string }) =>
      updateLayer(layerId, { name }),
    onSuccess: invalidate,
  })

  const setStyle = useMutation({
    mutationFn: ({ layerId, style }: { layerId: string; style: StyleSpec }) =>
      updateLayer(layerId, { style }),
    onSuccess: invalidate,
  })

  const remove = useMutation({
    mutationFn: (layerId: string) => deleteLayer(layerId),
    onSuccess: invalidate,
  })

  const reorder = useMutation({
    mutationFn: (layerIds: string[]) => reorderLayers(projectId, layerIds),
    onSuccess: invalidate,
  })

  const importFile = useMutation({
    mutationFn: ({ file, name }: { file: File; name?: string }) => {
      const isRaster = /\.(tif|tiff|vrt|img|jp2)$/i.test(file.name)
      return isRaster ? importRaster(projectId, file, name) : importVector(projectId, file, name)
    },
    onSuccess: invalidate,
  })

  const addPostgisTable = useMutation({
    mutationFn: (body: {
      schemaName: string
      tableName: string
      geometryColumn: string
      idColumn: string
      name: string
    }) => registerPostgisTable(projectId, body),
    onSuccess: invalidate,
  })

  return { setVisible, setOpacity, rename, setStyle, remove, reorder, importFile, addPostgisTable }
}
```

- [ ] **Step 8: Implement `src/features/layers/LayerPanel.tsx`**

```tsx
import { useState } from 'react'

import type { Layer } from '../../api/types'
import { useLayerStore } from '../../state/layerStore'
import { AddLayerDialog } from './AddLayerDialog'
import { moveItem } from './reorder'
import { useLayerMutations } from './useLayerMutations'

interface LayerPanelProps {
  projectId: string
  layers: Layer[]
}

export function LayerPanel({ projectId, layers }: LayerPanelProps) {
  const mutations = useLayerMutations(projectId)
  const selectedLayerId = useLayerStore((state) => state.selectedLayerId)
  const selectLayer = useLayerStore((state) => state.selectLayer)
  const truncatedLayerIds = useLayerStore((state) => state.truncatedLayerIds)
  const [dialogOpen, setDialogOpen] = useState(false)

  // The panel shows the topmost layer first, which is the reverse of z-index.
  const ordered = [...layers].sort((a, b) => b.zIndex - a.zIndex)

  const move = (displayIndex: number, delta: number) => {
    const next = moveItem(ordered, displayIndex, displayIndex + delta)
    // Convert display order (top first) back to ascending z-index order.
    mutations.reorder.mutate([...next].reverse().map((layer) => layer.id))
  }

  return (
    <div className="layer-panel">
      <header className="layer-panel__header">
        <h2>Layers</h2>
        <button type="button" onClick={() => setDialogOpen(true)}>
          Add layer
        </button>
      </header>

      {ordered.length === 0 ? (
        <p className="layer-panel__empty">No layers yet. Add one to get started.</p>
      ) : (
        <ul className="layer-panel__list">
          {ordered.map((layer, index) => (
            <li
              key={layer.id}
              className={
                layer.id === selectedLayerId ? 'layer-item layer-item--selected' : 'layer-item'
              }
            >
              <div className="layer-item__row">
                <input
                  type="checkbox"
                  checked={layer.visible}
                  aria-label={`Toggle visibility of ${layer.name}`}
                  onChange={(event) =>
                    mutations.setVisible.mutate({
                      layerId: layer.id,
                      visible: event.target.checked,
                    })
                  }
                />
                <button
                  type="button"
                  className="layer-item__name"
                  data-testid="layer-name"
                  onClick={() => selectLayer(layer.id)}
                >
                  {layer.name}
                </button>
                <button
                  type="button"
                  aria-label={`Move layer up: ${layer.name}`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move layer down: ${layer.name}`}
                  disabled={index === ordered.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={`Remove layer: ${layer.name}`}
                  onClick={() => mutations.remove.mutate(layer.id)}
                >
                  ×
                </button>
              </div>

              <div className="layer-item__meta">
                {layer.featureCount !== null ? `${layer.featureCount} features` : layer.kind}
                {layer.geometryType ? ` · ${layer.geometryType}` : ''}
              </div>

              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={layer.opacity}
                aria-label={`Opacity of ${layer.name}`}
                onChange={(event) =>
                  mutations.setOpacity.mutate({
                    layerId: layer.id,
                    opacity: Number(event.target.value),
                  })
                }
              />

              {truncatedLayerIds.includes(layer.id) ? (
                <p role="status" className="layer-item__warning">
                  Showing a subset — zoom in to see every feature.
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <AddLayerDialog
        projectId={projectId}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
      />
    </div>
  )
}
```

- [ ] **Step 9: Implement `src/features/layers/AddLayerDialog.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { listPostgisTables } from '../../api/catalog'
import { useLayerMutations } from './useLayerMutations'

interface AddLayerDialogProps {
  projectId: string
  open: boolean
  onClose: () => void
}

export function AddLayerDialog({ projectId, open, onClose }: AddLayerDialogProps) {
  const mutations = useLayerMutations(projectId)
  const [tab, setTab] = useState<'file' | 'postgis'>('file')
  const tables = useQuery({
    queryKey: ['postgis-tables'],
    queryFn: listPostgisTables,
    enabled: open && tab === 'postgis',
  })

  if (!open) return null

  return (
    <div className="dialog" role="dialog" aria-label="Add layer">
      <div className="dialog__tabs">
        <button type="button" onClick={() => setTab('file')} aria-pressed={tab === 'file'}>
          Upload file
        </button>
        <button type="button" onClick={() => setTab('postgis')} aria-pressed={tab === 'postgis'}>
          PostGIS table
        </button>
      </div>

      {tab === 'file' ? (
        <label className="dialog__field">
          GeoJSON, GeoPackage, zipped Shapefile or GeoTIFF
          <input
            type="file"
            accept=".geojson,.json,.gpkg,.zip,.shp,.tif,.tiff"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) mutations.importFile.mutate({ file }, { onSuccess: onClose })
            }}
          />
        </label>
      ) : (
        <ul className="dialog__tables">
          {tables.isLoading ? <li>Loading…</li> : null}
          {tables.data?.map((table) => (
            <li key={`${table.schemaName}.${table.tableName}`}>
              <button
                type="button"
                disabled={!table.primaryKey}
                title={table.primaryKey ? undefined : 'Table has no primary key'}
                onClick={() =>
                  mutations.addPostgisTable.mutate(
                    {
                      schemaName: table.schemaName,
                      tableName: table.tableName,
                      geometryColumn: table.geometryColumn,
                      idColumn: table.primaryKey ?? 'id',
                      name: table.tableName,
                    },
                    { onSuccess: onClose },
                  )
                }
              >
                {table.schemaName}.{table.tableName} · {table.geometryType} · ~
                {table.estimatedRows} rows
              </button>
            </li>
          ))}
        </ul>
      )}

      {mutations.importFile.isError ? (
        <p role="alert">{(mutations.importFile.error as Error).message}</p>
      ) : null}

      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  )
}
```

- [ ] **Step 10: Add the styles and wire the panel into `App.tsx`**

Append to `src/index.css`:

```css
.layer-panel { padding: 12px; }
.layer-panel__header { display: flex; align-items: center; justify-content: space-between; }
.layer-panel__list { list-style: none; margin: 0; padding: 0; }
.layer-item { padding: 8px; border-bottom: 1px solid var(--panel-border); }
.layer-item--selected { background: #e0e7ff; }
.layer-item__row { display: flex; align-items: center; gap: 6px; }
.layer-item__name { flex: 1; text-align: left; background: none; border: none; cursor: pointer; font: inherit; }
.layer-item__meta { color: #64748b; font-size: 12px; }
.layer-item__warning { color: #b45309; font-size: 12px; margin: 4px 0 0; }
.dialog { position: fixed; inset: 20% 30%; background: #fff; border: 1px solid var(--panel-border); padding: 16px; z-index: 10; overflow: auto; }
.dialog__tables { list-style: none; padding: 0; max-height: 300px; overflow: auto; }
```

In `src/App.tsx`, replace the sidebar placeholder with `<LayerPanel projectId={projectId!} layers={layers} />` (rendered only when `projectId` exists), and call `useLayerStore.getState().setProjectId(projectId ?? null)` in an effect.

- [ ] **Step 11: Run the panel test and confirm it passes**

Run: `npm run test -- --run src/features/layers`
Expected: 14 passed (5 reorder + 9 panel).

If `test('changing opacity …')` does not fire, React's synthetic `onChange` for a range input listens for the `input` event — dispatch `new Event('input', { bubbles: true })` instead, and update the helper.

- [ ] **Step 12: Run the gate and commit**

Run: `npm run lint && npm run typecheck && npm run test -- --run`

```bash
cd gis-platform
git add web/src/state web/src/features/layers web/src/App.tsx web/src/index.css
git commit -m "feat: add the layer panel with visibility, opacity, ordering and add-layer flows"
```

---

## Task 18: Client Memory Manager and Memory Panel (Memory Layer 3 of 3)

**Files:**
- Create: `gis-platform/web/src/map/memory/LayerMemoryManager.ts`
- Create: `gis-platform/web/src/map/memory/instrumentation.ts`
- Create: `gis-platform/web/src/map/memory/useLayerMemory.ts`
- Create: `gis-platform/web/src/features/memory/MemoryPanel.tsx`
- Modify: `gis-platform/web/src/map/layerFactory.ts`, `src/map/MapCanvas.tsx`, `src/App.tsx`, `src/index.css`
- Test: `gis-platform/web/src/map/memory/LayerMemoryManager.test.ts`, `src/features/memory/MemoryPanel.test.tsx`

**Interfaces:**
- Consumes: `LayerFactoryDeps` (Task 15); `getMemoryReport` (Task 14); `useLayerStore` (Task 17).
- Produces:
  - `src/map/memory/LayerMemoryManager.ts` — class with `register(layerId, onEvict)`, `unregister(layerId)`, `record(layerId, bytes)`, `reset(layerId)`, `touch(layerId)`, `setPinned(layerId, pinned)`, `enforce(): string[]` (returns evicted ids), `usage(): LayerUsage[]`, `get totalBytes`, `get budgetBytes`. `LayerUsage = { layerId: string; bytes: number; lastUsed: number; pinned: boolean }`. Constructor `new LayerMemoryManager({ budgetBytes?, clock? })`.
  - `src/map/memory/instrumentation.ts` — `instrumentTileSource(source, layerId, manager)` and `instrumentVectorTileSource(source, layerId, manager)`, which replace the source's tile load function with one that measures bytes.
  - `src/map/memory/useLayerMemory.ts` — `useLayerMemory()` returning `{ manager, usage, totalBytes, budgetBytes, refresh }`.
  - `src/features/memory/MemoryPanel.tsx` — `<MemoryPanel />` showing client usage per layer and the server `MemoryReport`.

- [ ] **Step 1: Write the failing memory manager test**

`gis-platform/web/src/map/memory/LayerMemoryManager.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LayerMemoryManager } from './LayerMemoryManager'

let now = 0
const clock = () => now

function makeManager(budgetBytes = 1000) {
  now = 0
  return new LayerMemoryManager({ budgetBytes, clock })
}

beforeEach(() => {
  now = 0
})

describe('LayerMemoryManager', () => {
  it('accumulates bytes per layer', () => {
    const manager = makeManager()
    manager.register('a', vi.fn())
    manager.record('a', 100)
    manager.record('a', 50)
    expect(manager.usage()).toEqual([
      expect.objectContaining({ layerId: 'a', bytes: 150 }),
    ])
    expect(manager.totalBytes).toBe(150)
  })

  it('ignores records for unregistered layers', () => {
    const manager = makeManager()
    manager.record('ghost', 100)
    expect(manager.totalBytes).toBe(0)
  })

  it('does nothing while under budget', () => {
    const manager = makeManager(1000)
    manager.register('a', vi.fn())
    manager.record('a', 400)
    expect(manager.enforce()).toEqual([])
  })

  it('evicts the least recently used layer when over budget', () => {
    const manager = makeManager(1000)
    const onEvictA = vi.fn()
    const onEvictB = vi.fn()
    manager.register('a', onEvictA)
    manager.register('b', onEvictB)

    now = 1
    manager.record('a', 600)
    now = 2
    manager.record('b', 600)

    expect(manager.enforce()).toEqual(['a'])
    expect(onEvictA).toHaveBeenCalledOnce()
    expect(onEvictB).not.toHaveBeenCalled()
    expect(manager.totalBytes).toBe(600)
  })

  it('keeps evicting until it is back under budget', () => {
    const manager = makeManager(500)
    for (const id of ['a', 'b', 'c']) manager.register(id, vi.fn())
    now = 1
    manager.record('a', 300)
    now = 2
    manager.record('b', 300)
    now = 3
    manager.record('c', 300)

    expect(manager.enforce()).toEqual(['a', 'b'])
    expect(manager.totalBytes).toBe(300)
  })

  it('never evicts a pinned layer', () => {
    const manager = makeManager(500)
    manager.register('a', vi.fn())
    manager.register('b', vi.fn())
    manager.setPinned('a', true)
    now = 1
    manager.record('a', 400)
    now = 2
    manager.record('b', 400)

    expect(manager.enforce()).toEqual(['b'])
    expect(manager.totalBytes).toBe(400)
  })

  it('never evicts the most recently touched layer, even unpinned', () => {
    const manager = makeManager(100)
    manager.register('a', vi.fn())
    now = 1
    manager.record('a', 900)
    expect(manager.enforce()).toEqual([])
  })

  it('stops evicting when only pinned layers remain', () => {
    const manager = makeManager(100)
    manager.register('a', vi.fn())
    manager.register('b', vi.fn())
    manager.setPinned('a', true)
    manager.setPinned('b', true)
    now = 1
    manager.record('a', 500)
    now = 2
    manager.record('b', 500)
    expect(manager.enforce()).toEqual([])
    expect(manager.totalBytes).toBe(1000)
  })

  it('reset zeroes one layer without touching the others', () => {
    const manager = makeManager()
    manager.register('a', vi.fn())
    manager.register('b', vi.fn())
    manager.record('a', 100)
    manager.record('b', 200)
    manager.reset('a')
    expect(manager.totalBytes).toBe(200)
  })

  it('unregister removes the layer from the accounting', () => {
    const manager = makeManager()
    manager.register('a', vi.fn())
    manager.record('a', 100)
    manager.unregister('a')
    expect(manager.usage()).toEqual([])
    expect(manager.totalBytes).toBe(0)
  })

  it('touch updates recency without adding bytes', () => {
    const manager = makeManager(1000)
    manager.register('a', vi.fn())
    manager.register('b', vi.fn())
    now = 1
    manager.record('a', 600)
    now = 2
    manager.record('b', 600)
    now = 3
    manager.touch('a') // 'a' is now the newest, so 'b' should go

    expect(manager.enforce()).toEqual(['b'])
  })

  it('usage is sorted by bytes descending', () => {
    const manager = makeManager()
    manager.register('a', vi.fn())
    manager.register('b', vi.fn())
    manager.record('a', 10)
    manager.record('b', 90)
    expect(manager.usage().map((entry) => entry.layerId)).toEqual(['b', 'a'])
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run test -- --run src/map/memory`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/map/memory/LayerMemoryManager.ts`**

```ts
export interface LayerUsage {
  layerId: string
  bytes: number
  lastUsed: number
  pinned: boolean
}

interface Entry {
  bytes: number
  lastUsed: number
  pinned: boolean
  onEvict: () => void
}

export interface LayerMemoryManagerOptions {
  /** Default 128 MiB — roughly what a tab can hold before scrolling gets janky. */
  budgetBytes?: number
  clock?: () => number
}

const DEFAULT_BUDGET = 128 * 1024 * 1024

/**
 * Memory layer 3 of 3: the browser.
 *
 * Every tile and every feature payload is weighed on arrival and charged to
 * the layer that asked for it. When the total crosses the budget, the least
 * recently used layer's cached data is dropped — `onEvict` clears the OL
 * source, so the bytes are actually released rather than merely uncounted.
 *
 * Two things are never evicted: a pinned layer (the one being edited or
 * inspected) and the most recently touched layer. Without the second rule a
 * single layer larger than the whole budget would be cleared and immediately
 * refetched, forever.
 */
export class LayerMemoryManager {
  private readonly entries = new Map<string, Entry>()
  private readonly clock: () => number
  readonly budgetBytes: number

  constructor(options: LayerMemoryManagerOptions = {}) {
    this.budgetBytes = options.budgetBytes ?? DEFAULT_BUDGET
    this.clock = options.clock ?? (() => performance.now())
  }

  register(layerId: string, onEvict: () => void): void {
    const existing = this.entries.get(layerId)
    this.entries.set(layerId, {
      bytes: existing?.bytes ?? 0,
      lastUsed: existing?.lastUsed ?? this.clock(),
      pinned: existing?.pinned ?? false,
      onEvict,
    })
  }

  unregister(layerId: string): void {
    this.entries.delete(layerId)
  }

  record(layerId: string, bytes: number): void {
    const entry = this.entries.get(layerId)
    if (!entry) return
    entry.bytes += bytes
    entry.lastUsed = this.clock()
  }

  reset(layerId: string): void {
    const entry = this.entries.get(layerId)
    if (entry) entry.bytes = 0
  }

  touch(layerId: string): void {
    const entry = this.entries.get(layerId)
    if (entry) entry.lastUsed = this.clock()
  }

  setPinned(layerId: string, pinned: boolean): void {
    const entry = this.entries.get(layerId)
    if (entry) entry.pinned = pinned
  }

  get totalBytes(): number {
    let total = 0
    for (const entry of this.entries.values()) total += entry.bytes
    return total
  }

  usage(): LayerUsage[] {
    return [...this.entries.entries()]
      .map(([layerId, entry]) => ({
        layerId,
        bytes: entry.bytes,
        lastUsed: entry.lastUsed,
        pinned: entry.pinned,
      }))
      .sort((a, b) => b.bytes - a.bytes)
  }

  /** Evict LRU-first until under budget. Returns the ids that were evicted. */
  enforce(): string[] {
    const evicted: string[] = []
    if (this.totalBytes <= this.budgetBytes) return evicted

    const newest = [...this.entries.entries()].reduce<string | null>(
      (best, [layerId, entry]) =>
        best === null || entry.lastUsed > (this.entries.get(best)?.lastUsed ?? -Infinity)
          ? layerId
          : best,
      null,
    )

    const candidates = [...this.entries.entries()]
      .filter(([layerId, entry]) => !entry.pinned && layerId !== newest && entry.bytes > 0)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)

    for (const [layerId, entry] of candidates) {
      if (this.totalBytes <= this.budgetBytes) break
      entry.bytes = 0
      entry.onEvict()
      evicted.push(layerId)
    }
    return evicted
  }
}
```

- [ ] **Step 4: Run the manager test and confirm it passes**

Run: `npm run test -- --run src/map/memory/LayerMemoryManager.test.ts`
Expected: 12 passed.

- [ ] **Step 5: Implement `src/map/memory/instrumentation.ts`**

```ts
import type { ImageTile } from 'ol'
import type VectorTile from 'ol/VectorTile'
import type VectorTileSource from 'ol/source/VectorTile'
import type XYZ from 'ol/source/XYZ'

import type { LayerMemoryManager } from './LayerMemoryManager'

/**
 * Replace a raster source's tile loader with one that fetches the PNG itself,
 * measures the blob, and hands the bytes to the tile via an object URL. The
 * default loader sets `img.src` directly, which gives no size information at
 * all — this is the only place the real byte count is observable.
 */
export function instrumentTileSource(
  source: XYZ,
  layerId: string,
  manager: LayerMemoryManager,
): void {
  source.setTileLoadFunction((tile, src) => {
    const image = (tile as ImageTile).getImage() as HTMLImageElement
    fetch(src)
      .then((response) => (response.ok ? response.blob() : Promise.reject(response.status)))
      .then((blob) => {
        manager.record(layerId, blob.size)
        const objectUrl = URL.createObjectURL(blob)
        image.onload = () => URL.revokeObjectURL(objectUrl)
        image.onerror = () => URL.revokeObjectURL(objectUrl)
        image.src = objectUrl
      })
      .catch(() => {
        // A 204 (empty tile) or a network failure: leave the tile blank.
        image.src = ''
      })
  })
}

/** Same idea for MVT: measure the protobuf before handing it to the format. */
export function instrumentVectorTileSource(
  source: VectorTileSource,
  layerId: string,
  manager: LayerMemoryManager,
): void {
  source.setTileLoadFunction((tile, url) => {
    const vectorTile = tile as VectorTile
    vectorTile.setLoader((extent, _resolution, projection) => {
      fetch(url)
        .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(response.status)))
        .then((buffer) => {
          manager.record(layerId, buffer.byteLength)
          const format = vectorTile.getFormat()
          vectorTile.setFeatures(
            format.readFeatures(buffer, { extent, featureProjection: projection }),
          )
        })
        .catch(() => vectorTile.setFeatures([]))
    })
  })
}
```

- [ ] **Step 6: Wire instrumentation into the layer factory**

In `src/map/layerFactory.ts`, add `memory?: LayerMemoryManager` to `LayerFactoryDeps` and, for each branch:

```ts
// raster_file and xyz branches, after constructing `source`:
if (deps.memory) {
  deps.memory.register(layer.id, () => source.refresh())
  instrumentTileSource(source, layer.id, deps.memory)
}

// mvt branch:
if (deps.memory) {
  deps.memory.register(layer.id, () => vectorTileSource.clear())
  instrumentVectorTileSource(vectorTileSource, layer.id, deps.memory)
}

// postgis branch:
if (deps.memory) {
  deps.memory.register(layer.id, () => vectorSource.clear(true))
}
```

`source.refresh()` on a tile source clears its cache and reloads on the next render — that is the eviction. `vectorSource.clear(true)` drops features without firing per-feature events.

- [ ] **Step 7: Implement `src/map/memory/useLayerMemory.ts` and wire it in**

```ts
import { useCallback, useEffect, useRef, useState } from 'react'

import { LayerMemoryManager, type LayerUsage } from './LayerMemoryManager'

const ENFORCE_INTERVAL_MS = 2000

export function useLayerMemory() {
  const managerRef = useRef<LayerMemoryManager>()
  managerRef.current ??= new LayerMemoryManager()
  const manager = managerRef.current

  const [usage, setUsage] = useState<LayerUsage[]>([])
  const [totalBytes, setTotalBytes] = useState(0)

  const refresh = useCallback(() => {
    manager.enforce()
    setUsage(manager.usage())
    setTotalBytes(manager.totalBytes)
  }, [manager])

  useEffect(() => {
    const timer = window.setInterval(refresh, ENFORCE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  return { manager, usage, totalBytes, budgetBytes: manager.budgetBytes, refresh }
}
```

In `App.tsx`, call `useLayerMemory()`, pass `{ memory: manager, onFeatureBytes: (id, bytes) => manager.record(id, bytes), onTruncated: setTruncated }` as `MapCanvas`'s `deps`, and pin the selected layer with an effect: `manager.setPinned(selectedLayerId, true)` on change, unpinning the previous one.

Memoise the `deps` object with `useMemo` so `MapCanvas`'s sync effect does not re-run every render.

- [ ] **Step 8: Write and run the MemoryPanel test**

`gis-platform/web/src/features/memory/MemoryPanel.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as systemApi from '../../api/system'
import { MemoryPanel } from './MemoryPanel'

const usage = [
  { layerId: 'a', bytes: 2_500_000, lastUsed: 1, pinned: true },
  { layerId: 'b', bytes: 500_000, lastUsed: 2, pinned: false },
]

const names = new Map([
  ['a', 'Roads'],
  ['b', 'Cities'],
])

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryPanel usage={usage} totalBytes={3_000_000} budgetBytes={10_000_000} names={names} />
    </QueryClientProvider>,
  )
}

afterEach(() => vi.restoreAllMocks())

describe('MemoryPanel', () => {
  it('renders per-layer usage in human units, largest first', () => {
    vi.spyOn(systemApi, 'getMemoryReport').mockResolvedValue({
      rasterPool: {
        openHandles: 2,
        maxOpen: 8,
        idleTtlSeconds: 300,
        hits: 5,
        misses: 3,
        evictions: 1,
        keys: [],
      },
      featureBboxLimit: 2000,
      attributePageMax: 500,
      processRssBytes: 120_000_000,
    })
    renderPanel()
    const rows = screen.getAllByTestId('memory-row').map((row) => row.textContent)
    expect(rows[0]).toContain('Roads')
    expect(rows[0]).toContain('2.4 MB')
    expect(rows[1]).toContain('Cities')
  })

  it('marks pinned layers', () => {
    vi.spyOn(systemApi, 'getMemoryReport').mockRejectedValue(new Error('offline'))
    renderPanel()
    expect(screen.getByLabelText(/Roads is pinned/i)).toBeInTheDocument()
  })

  it('shows the budget as a percentage', () => {
    vi.spyOn(systemApi, 'getMemoryReport').mockRejectedValue(new Error('offline'))
    renderPanel()
    expect(screen.getByText(/30%/)).toBeInTheDocument()
  })

  it('shows the server pool stats once loaded', async () => {
    vi.spyOn(systemApi, 'getMemoryReport').mockResolvedValue({
      rasterPool: {
        openHandles: 2,
        maxOpen: 8,
        idleTtlSeconds: 300,
        hits: 5,
        misses: 3,
        evictions: 1,
        keys: [],
      },
      featureBboxLimit: 2000,
      attributePageMax: 500,
      processRssBytes: 120_000_000,
    })
    renderPanel()
    await waitFor(() => expect(screen.getByText(/2 \/ 8 open/)).toBeInTheDocument())
    expect(screen.getByText(/114\.4 MB/)).toBeInTheDocument()
  })
})
```

`src/features/memory/MemoryPanel.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query'

import { getMemoryReport } from '../../api/system'
import type { LayerUsage } from '../../map/memory/LayerMemoryManager'

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

interface MemoryPanelProps {
  usage: LayerUsage[]
  totalBytes: number
  budgetBytes: number
  names: Map<string, string>
}

export function MemoryPanel({ usage, totalBytes, budgetBytes, names }: MemoryPanelProps) {
  const server = useQuery({
    queryKey: ['system-memory'],
    queryFn: getMemoryReport,
    refetchInterval: 5000,
  })
  const percent = Math.round((totalBytes / budgetBytes) * 100)

  return (
    <section className="memory-panel">
      <h3>Memory</h3>
      <p>
        Browser: {formatBytes(totalBytes)} of {formatBytes(budgetBytes)} ({percent}%)
      </p>
      <ul className="memory-panel__list">
        {usage.map((entry) => (
          <li key={entry.layerId} data-testid="memory-row">
            <span>{names.get(entry.layerId) ?? entry.layerId}</span>
            <span>{formatBytes(entry.bytes)}</span>
            {entry.pinned ? (
              <span aria-label={`${names.get(entry.layerId) ?? entry.layerId} is pinned`}>📌</span>
            ) : null}
          </li>
        ))}
      </ul>

      {server.data ? (
        <>
          <h4>Server</h4>
          <p>
            Raster handles: {server.data.rasterPool.openHandles} / {server.data.rasterPool.maxOpen}{' '}
            open
          </p>
          <p>
            Hits {server.data.rasterPool.hits} · misses {server.data.rasterPool.misses} · evictions{' '}
            {server.data.rasterPool.evictions}
          </p>
          <p>Process RSS: {formatBytes(server.data.processRssBytes)}</p>
        </>
      ) : null}
    </section>
  )
}
```

Run: `npm run test -- --run src/features/memory`
Expected: 4 passed. Render the panel in `App.tsx`'s `inspector` slot, passing a `names` map built from the layer list.

- [ ] **Step 9: Run the gate and commit**

Run: `npm run lint && npm run typecheck && npm run test -- --run`

```bash
cd gis-platform
git add web/src/map/memory web/src/features/memory web/src/map/layerFactory.ts web/src/App.tsx web/src/index.css
git commit -m "feat: add browser byte accounting with LRU eviction and a memory panel"
```

- [ ] **Step 10: Extend `gis-platform/docs/07-memory-management.md`**

Replace the placeholder `## Layer 3 — the browser` section with the real implementation: paste the `LayerMemoryManager` class docstring; explain the two never-evict rules and why the second one exists (paste `test('never evicts the most recently touched layer, even unpinned')`); paste `instrumentTileSource` and explain that the default OL loader sets `img.src` directly, which is why byte counts are only observable through a custom loader; and paste the eviction callbacks from `layerFactory` (`source.refresh()` vs `vectorSource.clear(true)`), noting that eviction must actually free the bytes, not merely stop counting them.

---

## Task 19: Attribute Table Panel with Inline Editing and Map Selection

**Files:**
- Create: `gis-platform/web/src/features/attributes/useAttributes.ts`
- Create: `gis-platform/web/src/features/attributes/AttributeTable.tsx`
- Create: `gis-platform/web/src/features/attributes/coerce.ts`
- Create: `gis-platform/web/src/map/selection.ts`
- Modify: `gis-platform/web/src/App.tsx`, `src/index.css`
- Test: `gis-platform/web/src/features/attributes/coerce.test.ts`, `src/features/attributes/AttributeTable.test.tsx`

**Interfaces:**
- Consumes: `getFields`, `getAttributes`, `updateFeature`, `deleteFeature` (Task 14); `useLayerStore` (Task 17); `useMap` (Task 15); `ColumnInfo`, `AttributePage`, `AttributeFilter` (Task 14).
- Produces:
  - `src/features/attributes/coerce.ts` — `coerceValue(raw: string, dataType: string): unknown` mapping a text input to the type the column expects; `formatValue(value: unknown): string`.
  - `src/features/attributes/useAttributes.ts` — `useAttributes(layerId)` returning `{ fields, page, isLoading, error, setPage, setSort, setFilters, sortBy, sortOrder, pageNumber, pageSize, saveCell, removeRow }`.
  - `src/features/attributes/AttributeTable.tsx` — `<AttributeTable layerId />`.
  - `src/map/selection.ts` — `highlightFeatures(map, layerId, featureIds)` and `zoomToFeature(map, layerId, featureId)`, both operating on the OL layer tagged with `layer_id`.

- [ ] **Step 1: Write the failing coercion test**

`gis-platform/web/src/features/attributes/coerce.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { coerceValue, formatValue } from './coerce'

describe('coerceValue', () => {
  it('parses integers', () => {
    expect(coerceValue('42', 'integer')).toBe(42)
    expect(coerceValue('42', 'bigint')).toBe(42)
  })

  it('parses reals', () => {
    expect(coerceValue('3.5', 'double precision')).toBe(3.5)
    expect(coerceValue('3.5', 'numeric')).toBe(3.5)
  })

  it('parses booleans from the usual spellings', () => {
    expect(coerceValue('true', 'boolean')).toBe(true)
    expect(coerceValue('FALSE', 'boolean')).toBe(false)
    expect(coerceValue('1', 'boolean')).toBe(true)
  })

  it('leaves text alone', () => {
    expect(coerceValue('  Beijing  ', 'text')).toBe('  Beijing  ')
  })

  it('maps an empty string to null for every type', () => {
    expect(coerceValue('', 'integer')).toBeNull()
    expect(coerceValue('', 'text')).toBeNull()
  })

  it('throws for a non-numeric value in a numeric column', () => {
    expect(() => coerceValue('abc', 'integer')).toThrow(/number/i)
  })

  it('throws for an unparseable boolean', () => {
    expect(() => coerceValue('maybe', 'boolean')).toThrow(/boolean/i)
  })

  it('parses JSON columns', () => {
    expect(coerceValue('{"a":1}', 'jsonb')).toEqual({ a: 1 })
    expect(() => coerceValue('{oops', 'jsonb')).toThrow(/json/i)
  })
})

describe('formatValue', () => {
  it('renders null as an empty string', () => {
    expect(formatValue(null)).toBe('')
    expect(formatValue(undefined)).toBe('')
  })

  it('stringifies objects', () => {
    expect(formatValue({ a: 1 })).toBe('{"a":1}')
  })

  it('passes primitives through', () => {
    expect(formatValue(42)).toBe('42')
    expect(formatValue(true)).toBe('true')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails, then implement `coerce.ts`**

Run: `npm run test -- --run src/features/attributes/coerce.test.ts` → FAIL (module not found).

```ts
const INTEGER_TYPES = new Set(['integer', 'bigint', 'smallint'])
const REAL_TYPES = new Set(['double precision', 'numeric', 'real', 'decimal'])
const JSON_TYPES = new Set(['json', 'jsonb'])
const TRUE_VALUES = new Set(['true', 't', '1', 'yes'])
const FALSE_VALUES = new Set(['false', 'f', '0', 'no'])

/**
 * A table cell is always edited as text, but PostgreSQL wants the real type.
 * Coercion happens here rather than on the server so the user gets an
 * immediate, specific error instead of a 422 round trip.
 */
export function coerceValue(raw: string, dataType: string): unknown {
  if (raw === '') return null
  const type = dataType.toLowerCase()

  if (INTEGER_TYPES.has(type)) {
    const value = Number(raw)
    if (!Number.isInteger(value)) throw new Error(`"${raw}" is not a whole number`)
    return value
  }

  if (REAL_TYPES.has(type)) {
    const value = Number(raw)
    if (!Number.isFinite(value)) throw new Error(`"${raw}" is not a number`)
    return value
  }

  if (type === 'boolean') {
    const normalised = raw.trim().toLowerCase()
    if (TRUE_VALUES.has(normalised)) return true
    if (FALSE_VALUES.has(normalised)) return false
    throw new Error(`"${raw}" is not a boolean`)
  }

  if (JSON_TYPES.has(type)) {
    try {
      return JSON.parse(raw)
    } catch {
      throw new Error(`"${raw}" is not valid JSON`)
    }
  }

  return raw
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
```

Run again: 11 passed.

- [ ] **Step 3: Write the failing AttributeTable test**

`gis-platform/web/src/features/attributes/AttributeTable.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as featuresApi from '../../api/features'
import { useLayerStore } from '../../state/layerStore'
import { AttributeTable } from './AttributeTable'

const fields = {
  fields: [
    { name: 'fid', dataType: 'integer', nullable: false, editable: false },
    { name: 'name', dataType: 'text', nullable: true, editable: true },
    { name: 'population', dataType: 'integer', nullable: true, editable: true },
  ],
  idColumn: 'fid',
  geometryColumn: 'geometry',
}

const page = {
  columns: ['fid', 'name', 'population'],
  rows: [
    { fid: 1, name: 'Beijing', population: 21540000 },
    { fid: 2, name: 'Lhasa', population: 560000 },
  ],
  page: 1,
  pageSize: 50,
  total: 2,
}

function renderTable() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <AttributeTable layerId="l1" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  useLayerStore.setState({
    projectId: 'p1',
    selectedLayerId: 'l1',
    selectedFeatureIds: [],
    truncatedLayerIds: [],
  })
  vi.spyOn(featuresApi, 'getFields').mockResolvedValue(fields)
  vi.spyOn(featuresApi, 'getAttributes').mockResolvedValue(page)
})

afterEach(() => vi.restoreAllMocks())

describe('AttributeTable', () => {
  it('renders a header per column and a row per feature', async () => {
    renderTable()
    await screen.findByText('Beijing')
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'fid',
      'name',
      'population',
      '',
    ])
    expect(screen.getAllByRole('row')).toHaveLength(3) // header + 2
  })

  it('shows the total row count', async () => {
    renderTable()
    expect(await screen.findByText(/2 features/i)).toBeInTheDocument()
  })

  it('clicking a header sorts and refetches', async () => {
    renderTable()
    await screen.findByText('Beijing')
    await userEvent.click(screen.getByRole('columnheader', { name: /population/i }))
    await waitFor(() =>
      expect(featuresApi.getAttributes).toHaveBeenLastCalledWith(
        'l1',
        expect.objectContaining({ sortBy: 'population', sortOrder: 'asc' }),
      ),
    )
  })

  it('clicking the same header twice flips the direction', async () => {
    renderTable()
    await screen.findByText('Beijing')
    const header = screen.getByRole('columnheader', { name: /population/i })
    await userEvent.click(header)
    await userEvent.click(header)
    await waitFor(() =>
      expect(featuresApi.getAttributes).toHaveBeenLastCalledWith(
        'l1',
        expect.objectContaining({ sortOrder: 'desc' }),
      ),
    )
  })

  it('editing a cell PATCHes the feature with a coerced value', async () => {
    const spy = vi.spyOn(featuresApi, 'updateFeature').mockResolvedValue({
      type: 'Feature',
      id: '1',
      geometry: null,
      properties: { name: 'Beijing', population: 22000000 },
    })
    renderTable()
    const cell = await screen.findByTestId('cell-1-population')
    await userEvent.dblClick(cell)
    const input = within(cell).getByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, '22000000{Enter}')
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('l1', '1', { properties: { population: 22000000 } }),
    )
  })

  it('shows an inline error and does not PATCH when the value will not coerce', async () => {
    const spy = vi.spyOn(featuresApi, 'updateFeature')
    renderTable()
    const cell = await screen.findByTestId('cell-1-population')
    await userEvent.dblClick(cell)
    const input = within(cell).getByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, 'lots{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent(/not a whole number/i)
    expect(spy).not.toHaveBeenCalled()
  })

  it('does not open an editor on a non-editable column', async () => {
    renderTable()
    const cell = await screen.findByTestId('cell-1-fid')
    await userEvent.dblClick(cell)
    expect(within(cell).queryByRole('textbox')).toBeNull()
  })

  it('escape cancels the edit without patching', async () => {
    const spy = vi.spyOn(featuresApi, 'updateFeature')
    renderTable()
    const cell = await screen.findByTestId('cell-1-name')
    await userEvent.dblClick(cell)
    await userEvent.type(within(cell).getByRole('textbox'), 'X{Escape}')
    expect(spy).not.toHaveBeenCalled()
    expect(cell).toHaveTextContent('Beijing')
  })

  it('selecting a row records the feature id in the store', async () => {
    renderTable()
    await userEvent.click(await screen.findByText('Beijing'))
    expect(useLayerStore.getState().selectedFeatureIds).toEqual(['1'])
  })

  it('deleting a row calls the API', async () => {
    const spy = vi.spyOn(featuresApi, 'deleteFeature').mockResolvedValue(undefined)
    renderTable()
    await screen.findByText('Beijing')
    await userEvent.click(screen.getAllByLabelText(/delete feature/i)[0]!)
    await waitFor(() => expect(spy).toHaveBeenCalledWith('l1', '1'))
  })

  it('renders a prompt when no layer is selected', () => {
    useLayerStore.setState({ selectedLayerId: null })
    renderTable()
    expect(screen.getByText(/select a layer/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 4: Run it and confirm it fails**

Run: `npm run test -- --run src/features/attributes/AttributeTable.test.tsx`
Expected: FAIL — cannot resolve `./AttributeTable`.

- [ ] **Step 5: Implement `src/features/attributes/useAttributes.ts`**

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { deleteFeature, getAttributes, getFields, updateFeature } from '../../api/features'
import type { AttributeFilter } from '../../api/types'

const PAGE_SIZE = 50

export function useAttributes(layerId: string | null) {
  const queryClient = useQueryClient()
  const [pageNumber, setPage] = useState(1)
  const [sortBy, setSortBy] = useState<string | undefined>()
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc')
  const [filters, setFilters] = useState<AttributeFilter[]>([])

  const fields = useQuery({
    queryKey: ['fields', layerId],
    queryFn: () => getFields(layerId!),
    enabled: Boolean(layerId),
  })

  const attributesKey = ['attributes', layerId, pageNumber, sortBy, sortOrder, filters] as const
  const page = useQuery({
    queryKey: attributesKey,
    queryFn: () =>
      getAttributes(layerId!, {
        page: pageNumber,
        pageSize: PAGE_SIZE,
        sortBy,
        sortOrder,
        filters,
      }),
    enabled: Boolean(layerId),
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['attributes', layerId] })
  }

  const saveCell = useMutation({
    mutationFn: ({
      featureId,
      column,
      value,
    }: {
      featureId: string
      column: string
      value: unknown
    }) => updateFeature(layerId!, featureId, { properties: { [column]: value } }),
    onSuccess: invalidate,
  })

  const removeRow = useMutation({
    mutationFn: (featureId: string) => deleteFeature(layerId!, featureId),
    onSuccess: invalidate,
  })

  const setSort = (column: string) => {
    if (column === sortBy) {
      setSortOrder((current) => (current === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortBy(column)
      setSortOrder('asc')
    }
    setPage(1)
  }

  return {
    fields: fields.data,
    page: page.data,
    isLoading: fields.isLoading || page.isLoading,
    error: (fields.error ?? page.error) as Error | null,
    pageNumber,
    pageSize: PAGE_SIZE,
    sortBy,
    sortOrder,
    setPage,
    setSort,
    setFilters,
    saveCell,
    removeRow,
  }
}
```

- [ ] **Step 6: Implement `src/features/attributes/AttributeTable.tsx`**

```tsx
import { useState } from 'react'

import type { ColumnInfo } from '../../api/types'
import { useLayerStore } from '../../state/layerStore'
import { coerceValue, formatValue } from './coerce'
import { useAttributes } from './useAttributes'

interface AttributeTableProps {
  layerId: string | null
}

interface EditingCell {
  featureId: string
  column: string
  draft: string
}

export function AttributeTable({ layerId }: AttributeTableProps) {
  const selectedLayerId = useLayerStore((state) => state.selectedLayerId)
  const effectiveLayerId = layerId ?? selectedLayerId
  const selectFeatures = useLayerStore((state) => state.selectFeatures)
  const selectedFeatureIds = useLayerStore((state) => state.selectedFeatureIds)

  const table = useAttributes(effectiveLayerId)
  const [editing, setEditing] = useState<EditingCell | null>(null)
  const [cellError, setCellError] = useState<string | null>(null)

  if (!effectiveLayerId) {
    return <p className="attribute-table__empty">Select a layer to see its attributes.</p>
  }
  if (table.isLoading) return <p className="attribute-table__empty">Loading…</p>
  if (table.error) return <p role="alert">{table.error.message}</p>
  if (!table.fields || !table.page) return null

  const byName = new globalThis.Map<string, ColumnInfo>(
    table.fields.fields.map((field) => [field.name, field]),
  )
  const idColumn = table.fields.idColumn
  const totalPages = Math.max(1, Math.ceil(table.page.total / table.pageSize))

  const commit = () => {
    if (!editing) return
    const column = byName.get(editing.column)
    if (!column) return
    try {
      const value = coerceValue(editing.draft, column.dataType)
      setCellError(null)
      table.saveCell.mutate({ featureId: editing.featureId, column: editing.column, value })
      setEditing(null)
    } catch (error) {
      setCellError((error as Error).message)
    }
  }

  return (
    <div className="attribute-table">
      <header className="attribute-table__header">
        <span>{table.page.total} features</span>
        <span>
          <button
            type="button"
            disabled={table.pageNumber <= 1}
            onClick={() => table.setPage(table.pageNumber - 1)}
          >
            ‹
          </button>
          Page {table.pageNumber} / {totalPages}
          <button
            type="button"
            disabled={table.pageNumber >= totalPages}
            onClick={() => table.setPage(table.pageNumber + 1)}
          >
            ›
          </button>
        </span>
      </header>

      {cellError ? <p role="alert">{cellError}</p> : null}

      <table>
        <thead>
          <tr>
            {table.page.columns.map((column) => (
              <th
                key={column}
                scope="col"
                onClick={() => table.setSort(column)}
                aria-sort={
                  table.sortBy === column
                    ? table.sortOrder === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : 'none'
                }
              >
                {column}
              </th>
            ))}
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {table.page.rows.map((row) => {
            const featureId = String(row[idColumn])
            const selected = selectedFeatureIds.includes(featureId)
            return (
              <tr
                key={featureId}
                className={selected ? 'is-selected' : undefined}
                onClick={() => selectFeatures([featureId])}
              >
                {table.page!.columns.map((column) => {
                  const isEditing =
                    editing?.featureId === featureId && editing.column === column
                  const editable = byName.get(column)?.editable ?? false
                  return (
                    <td
                      key={column}
                      data-testid={`cell-${featureId}-${column}`}
                      onDoubleClick={() => {
                        if (!editable) return
                        setCellError(null)
                        setEditing({ featureId, column, draft: formatValue(row[column]) })
                      }}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          type="text"
                          value={editing.draft}
                          onChange={(event) =>
                            setEditing({ ...editing, draft: event.target.value })
                          }
                          onBlur={commit}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') commit()
                            if (event.key === 'Escape') {
                              setEditing(null)
                              setCellError(null)
                            }
                          }}
                        />
                      ) : (
                        formatValue(row[column])
                      )}
                    </td>
                  )
                })}
                <td>
                  <button
                    type="button"
                    aria-label={`Delete feature ${featureId}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      table.removeRow.mutate(featureId)
                    }}
                  >
                    ×
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 7: Implement `src/map/selection.ts` and wire selection to the map**

```ts
import type OlMap from 'ol/Map'
import VectorLayer from 'ol/layer/Vector'
import type VectorSource from 'ol/source/Vector'

function findVectorLayer(map: OlMap, layerId: string): VectorLayer<VectorSource> | null {
  for (const layer of map.getLayers().getArray()) {
    if (layer.get('layer_id') === layerId && layer instanceof VectorLayer) {
      return layer as VectorLayer<VectorSource>
    }
  }
  return null
}

/** Selection is a feature property the style compiler can read; no second layer. */
export function highlightFeatures(map: OlMap, layerId: string, featureIds: string[]): void {
  const layer = findVectorLayer(map, layerId)
  const source = layer?.getSource()
  if (!source) return
  const wanted = new Set(featureIds)
  for (const feature of source.getFeatures()) {
    feature.set('__selected', wanted.has(String(feature.getId() ?? feature.get('fid'))))
  }
  layer?.changed()
}

export function zoomToFeature(map: OlMap, layerId: string, featureId: string): void {
  const source = findVectorLayer(map, layerId)?.getSource()
  const feature = source
    ?.getFeatures()
    .find((candidate) => String(candidate.getId() ?? candidate.get('fid')) === featureId)
  const extent = feature?.getGeometry()?.getExtent()
  if (extent) map.getView().fit(extent, { maxZoom: 16, duration: 250, padding: [40, 40, 40, 40] })
}
```

In `App.tsx`, add an effect that calls `highlightFeatures(map, selectedLayerId, selectedFeatureIds)` whenever either changes, and render `<AttributeTable layerId={selectedLayerId} />` in the `bottom` slot.

- [ ] **Step 8: Run the attribute tests and confirm they pass**

Run: `npm run test -- --run src/features/attributes`
Expected: 22 passed (11 coerce + 11 table).

If `it('renders a header per column and a row per feature')` fails on the trailing `''` header, give the actions column an `aria-label` and update the assertion to match — either is fine, but the test and the markup must agree.

- [ ] **Step 9: Run the gate and commit**

Run: `npm run lint && npm run typecheck && npm run test -- --run`

```bash
cd gis-platform
git add web/src/features/attributes web/src/map/selection.ts web/src/App.tsx web/src/index.css
git commit -m "feat: add the attribute table with inline editing and map selection sync"
```

---

## Task 20: Style Editor Panel

**Files:**
- Create: `gis-platform/web/src/features/styling/StyleEditor.tsx`
- Create: `gis-platform/web/src/features/styling/defaults.ts`
- Modify: `gis-platform/web/src/App.tsx`, `src/index.css`
- Test: `gis-platform/web/src/features/styling/defaults.test.ts`, `src/features/styling/StyleEditor.test.tsx`

**Interfaces:**
- Consumes: `Layer`, `StyleSpec`, `VectorStyle`, `RasterStyle`, `ColorStop` (Task 14); `useLayerMutations().setStyle` (Task 17); `RAMPS`, `sampleRamp`, `buildGraduatedClasses`, `buildCategorizedClasses` (Task 16); `getFields`, `getAttributes` (Task 14); `getRasterStatistics` (Task 14).
- Produces:
  - `src/features/styling/defaults.ts` — `defaultVectorStyle(): VectorStyle`, `defaultRasterStyle(): RasterStyle`, `withRenderer(style, renderer): VectorStyle`, `distinctValues(rows, field): (string | number)[]`, `numericRange(rows, field): [number, number] | null`.
  - `src/features/styling/StyleEditor.tsx` — `<StyleEditor projectId layer />`.

- [ ] **Step 1: Write the failing defaults test**

`gis-platform/web/src/features/styling/defaults.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { defaultRasterStyle, defaultVectorStyle, distinctValues, numericRange } from './defaults'

describe('defaultVectorStyle', () => {
  it('is a valid single-symbol vector style', () => {
    const style = defaultVectorStyle()
    expect(style.kind).toBe('vector')
    expect(style.renderer.type).toBe('single')
    expect(style.fill.color).toMatch(/^#[0-9a-f]{6}$/)
    expect(style.stroke.width).toBeGreaterThan(0)
    expect(style.label).toBeNull()
  })

  it('returns a fresh object each call so edits do not leak', () => {
    const first = defaultVectorStyle()
    first.fill.color = '#ff0000'
    expect(defaultVectorStyle().fill.color).not.toBe('#ff0000')
  })
})

describe('defaultRasterStyle', () => {
  it('renders band 1 at full opacity by default', () => {
    const style = defaultRasterStyle()
    expect(style.kind).toBe('raster')
    expect(style.bands).toEqual([1])
    expect(style.opacity).toBe(1)
    expect(style.rescale).toBeNull()
  })
})

describe('distinctValues', () => {
  it('returns unique, non-null values in first-seen order', () => {
    const rows = [{ k: 'a' }, { k: 'b' }, { k: 'a' }, { k: null }]
    expect(distinctValues(rows, 'k')).toEqual(['a', 'b'])
  })

  it('caps the result so a high-cardinality column cannot explode the UI', () => {
    const rows = Array.from({ length: 500 }, (_unused, index) => ({ k: index }))
    expect(distinctValues(rows, 'k').length).toBeLessThanOrEqual(50)
  })
})

describe('numericRange', () => {
  it('returns the min and max of the numeric values', () => {
    expect(numericRange([{ v: 3 }, { v: 1 }, { v: 9 }], 'v')).toEqual([1, 9])
  })

  it('ignores non-numeric entries', () => {
    expect(numericRange([{ v: 3 }, { v: 'x' }, { v: null }], 'v')).toEqual([3, 3])
  })

  it('returns null when no numeric value is present', () => {
    expect(numericRange([{ v: 'x' }], 'v')).toBeNull()
  })
})
```

- [ ] **Step 2: Implement `src/features/styling/defaults.ts`**

```ts
import type { RasterStyle, Renderer, VectorStyle } from '../../api/types'

const MAX_CATEGORIES = 50

export function defaultVectorStyle(): VectorStyle {
  return {
    kind: 'vector',
    renderer: { type: 'single' },
    fill: { color: '#3b82f6', opacity: 0.6 },
    stroke: { color: '#1e3a8a', width: 1, dash: null },
    marker: { shape: 'circle', radius: 5 },
    label: null,
  }
}

export function defaultRasterStyle(): RasterStyle {
  return { kind: 'raster', bands: [1], rescale: null, colormap: null, opacity: 1 }
}

export function withRenderer(style: VectorStyle, renderer: Renderer): VectorStyle {
  return { ...style, renderer }
}

export function distinctValues(
  rows: Record<string, unknown>[],
  field: string,
): (string | number)[] {
  const seen: (string | number)[] = []
  const set = new Set<string>()
  for (const row of rows) {
    const value = row[field]
    if (value === null || value === undefined) continue
    if (typeof value !== 'string' && typeof value !== 'number') continue
    const key = String(value)
    if (set.has(key)) continue
    set.add(key)
    seen.push(value)
    if (seen.length >= MAX_CATEGORIES) break
  }
  return seen
}

export function numericRange(
  rows: Record<string, unknown>[],
  field: string,
): [number, number] | null {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const row of rows) {
    const value = Number(row[field])
    if (!Number.isFinite(value)) continue
    min = Math.min(min, value)
    max = Math.max(max, value)
  }
  return Number.isFinite(min) ? [min, max] : null
}
```

Run: `npm run test -- --run src/features/styling/defaults.test.ts` → 8 passed.

- [ ] **Step 3: Write the failing StyleEditor test**

`gis-platform/web/src/features/styling/StyleEditor.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as featuresApi from '../../api/features'
import * as layersApi from '../../api/layers'
import * as systemApi from '../../api/system'
import type { Layer } from '../../api/types'
import { StyleEditor } from './StyleEditor'

const vectorLayer = {
  id: 'l1',
  projectId: 'p1',
  name: 'Cities',
  kind: 'vector',
  source: {
    type: 'postgis',
    schemaName: 'gis_data',
    tableName: 'cities',
    geometryColumn: 'geometry',
    idColumn: 'fid',
    srid: 4326,
  },
  style: null,
  visible: true,
  opacity: 1,
  zIndex: 0,
  extent: null,
  featureCount: 3,
  srid: 4326,
  geometryType: 'POINT',
} as Layer

const rasterLayer = {
  ...vectorLayer,
  id: 'l2',
  kind: 'raster',
  source: { type: 'raster_file', path: 'a.tif', bandCount: 1, nodata: null, isCog: true },
} as Layer

function renderEditor(layer: Layer) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <StyleEditor projectId="p1" layer={layer} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.spyOn(featuresApi, 'getFields').mockResolvedValue({
    fields: [
      { name: 'fid', dataType: 'integer', nullable: false, editable: false },
      { name: 'name', dataType: 'text', nullable: true, editable: true },
      { name: 'population', dataType: 'integer', nullable: true, editable: true },
    ],
    idColumn: 'fid',
    geometryColumn: 'geometry',
  })
  vi.spyOn(featuresApi, 'getAttributes').mockResolvedValue({
    columns: ['fid', 'name', 'population'],
    rows: [
      { fid: 1, name: 'Beijing', population: 100 },
      { fid: 2, name: 'Lhasa', population: 900 },
    ],
    page: 1,
    pageSize: 500,
    total: 2,
  })
})

afterEach(() => vi.restoreAllMocks())

describe('StyleEditor (vector)', () => {
  it('starts on the single-symbol renderer', async () => {
    renderEditor(vectorLayer)
    expect(await screen.findByLabelText(/renderer/i)).toHaveValue('single')
  })

  it('changing the fill colour saves the style', async () => {
    const spy = vi.spyOn(layersApi, 'updateLayer').mockResolvedValue(vectorLayer)
    renderEditor(vectorLayer)
    const picker = await screen.findByLabelText(/fill colour/i)
    await userEvent.clear(picker)
    fireColor(picker, '#ff0000')
    await userEvent.click(screen.getByRole('button', { name: /apply/i }))
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(
        'l1',
        expect.objectContaining({
          style: expect.objectContaining({ fill: expect.objectContaining({ color: '#ff0000' }) }),
        }),
      ),
    )
  })

  it('switching to categorized offers the layer fields', async () => {
    renderEditor(vectorLayer)
    await userEvent.selectOptions(await screen.findByLabelText(/renderer/i), 'categorized')
    const field = await screen.findByLabelText(/classify by/i)
    expect(within(field).getAllByRole('option').map((o) => o.textContent)).toContain('population')
  })

  it('classifying builds one class per distinct value', async () => {
    renderEditor(vectorLayer)
    await userEvent.selectOptions(await screen.findByLabelText(/renderer/i), 'categorized')
    await userEvent.selectOptions(await screen.findByLabelText(/classify by/i), 'name')
    await userEvent.click(screen.getByRole('button', { name: /classify/i }))
    await waitFor(() => expect(screen.getAllByTestId('class-row')).toHaveLength(2))
  })

  it('graduated classification builds the requested number of classes', async () => {
    renderEditor(vectorLayer)
    await userEvent.selectOptions(await screen.findByLabelText(/renderer/i), 'graduated')
    await userEvent.selectOptions(await screen.findByLabelText(/classify by/i), 'population')
    await userEvent.click(screen.getByRole('button', { name: /classify/i }))
    await waitFor(() => expect(screen.getAllByTestId('class-row')).toHaveLength(5))
  })

  it('warns when a graduated classification finds no numeric values', async () => {
    renderEditor(vectorLayer)
    await userEvent.selectOptions(await screen.findByLabelText(/renderer/i), 'graduated')
    await userEvent.selectOptions(await screen.findByLabelText(/classify by/i), 'name')
    await userEvent.click(screen.getByRole('button', { name: /classify/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/no numeric values/i)
  })
})

describe('StyleEditor (raster)', () => {
  it('shows band and rescale controls, not vector controls', async () => {
    vi.spyOn(systemApi, 'getRasterStatistics').mockResolvedValue({
      bands: [
        { band: 1, min: 0, max: 255, mean: 100, std: 20, percentile2: 5, percentile98: 250 },
      ],
    })
    renderEditor(rasterLayer)
    expect(await screen.findByLabelText(/colour map/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/marker shape/i)).toBeNull()
  })

  it('fills the rescale range from band statistics', async () => {
    vi.spyOn(systemApi, 'getRasterStatistics').mockResolvedValue({
      bands: [
        { band: 1, min: 0, max: 255, mean: 100, std: 20, percentile2: 5, percentile98: 250 },
      ],
    })
    renderEditor(rasterLayer)
    await userEvent.click(await screen.findByRole('button', { name: /from statistics/i }))
    await waitFor(() => expect(screen.getByLabelText(/minimum/i)).toHaveValue(5))
    expect(screen.getByLabelText(/maximum/i)).toHaveValue(250)
  })
})

function fireColor(element: HTMLElement, value: string) {
  const input = element as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
```

Add `import { within } from '@testing-library/react'` to the import list.

- [ ] **Step 4: Run it and confirm it fails, then implement `StyleEditor.tsx`**

Run: `npm run test -- --run src/features/styling/StyleEditor.test.tsx` → FAIL (module not found).

```tsx
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { getAttributes, getFields } from '../../api/features'
import { getRasterStatistics } from '../../api/system'
import type { Layer, RasterStyle, StyleSpec, VectorStyle } from '../../api/types'
import { useLayerMutations } from '../layers/useLayerMutations'
import { defaultRasterStyle, defaultVectorStyle, distinctValues, numericRange } from './defaults'
import { buildCategorizedClasses, buildGraduatedClasses, RAMPS, type RampName } from './ramps'

const SAMPLE_SIZE = 500
const GRADUATED_CLASSES = 5

interface StyleEditorProps {
  projectId: string
  layer: Layer
}

export function StyleEditor({ projectId, layer }: StyleEditorProps) {
  const mutations = useLayerMutations(projectId)
  const isRaster = layer.kind === 'raster'

  const [draft, setDraft] = useState<StyleSpec>(
    layer.style ?? (isRaster ? defaultRasterStyle() : defaultVectorStyle()),
  )
  const [ramp, setRamp] = useState<RampName>('viridis')
  const [classifyField, setClassifyField] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  const fields = useQuery({
    queryKey: ['fields', layer.id],
    queryFn: () => getFields(layer.id),
    enabled: !isRaster,
  })
  const sample = useQuery({
    queryKey: ['style-sample', layer.id],
    queryFn: () => getAttributes(layer.id, { page: 1, pageSize: SAMPLE_SIZE }),
    enabled: !isRaster,
  })
  const statistics = useQuery({
    queryKey: ['raster-statistics', layer.id],
    queryFn: () => getRasterStatistics(layer.id),
    enabled: isRaster,
  })

  const apply = () => mutations.setStyle.mutate({ layerId: layer.id, style: draft })

  if (isRaster) {
    const raster = draft as RasterStyle
    const band = statistics.data?.bands[0]
    const [min, max] = raster.rescale?.[0] ?? [0, 255]

    return (
      <section className="style-editor">
        <h3>Style · {layer.name}</h3>

        <label>
          Colour map
          <select
            value={raster.colormap ?? ''}
            onChange={(event) =>
              setDraft({ ...raster, colormap: event.target.value || null })
            }
          >
            <option value="">Greyscale</option>
            {['viridis', 'magma', 'terrain', 'rdylbu'].map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <label>
          Minimum
          <input
            type="number"
            value={min}
            onChange={(event) =>
              setDraft({ ...raster, rescale: [[Number(event.target.value), max]] })
            }
          />
        </label>
        <label>
          Maximum
          <input
            type="number"
            value={max}
            onChange={(event) =>
              setDraft({ ...raster, rescale: [[min, Number(event.target.value)]] })
            }
          />
        </label>

        <button
          type="button"
          disabled={!band}
          onClick={() =>
            band && setDraft({ ...raster, rescale: [[band.percentile2, band.percentile98]] })
          }
        >
          From statistics
        </button>

        <button type="button" onClick={apply}>
          Apply
        </button>
      </section>
    )
  }

  const vector = draft as VectorStyle
  const rows = sample.data?.rows ?? []

  const classify = () => {
    setProblem(null)
    if (!classifyField) {
      setProblem('Choose a field first.')
      return
    }
    if (vector.renderer.type === 'categorized') {
      const values = distinctValues(rows, classifyField)
      if (values.length === 0) {
        setProblem('That field has no values in the sample.')
        return
      }
      setDraft({
        ...vector,
        renderer: {
          type: 'categorized',
          field: classifyField,
          categories: buildCategorizedClasses(values, ramp),
          fallbackColor: '#9ca3af',
        },
      })
      return
    }
    const range = numericRange(rows, classifyField)
    if (!range) {
      setProblem('That field has no numeric values in the sample.')
      return
    }
    setDraft({
      ...vector,
      renderer: {
        type: 'graduated',
        field: classifyField,
        method: 'equal_interval',
        classes: buildGraduatedClasses(range[0], range[1], GRADUATED_CLASSES, ramp),
      },
    })
  }

  const classes =
    vector.renderer.type === 'categorized'
      ? vector.renderer.categories
      : vector.renderer.type === 'graduated'
        ? vector.renderer.classes
        : []

  return (
    <section className="style-editor">
      <h3>Style · {layer.name}</h3>

      <label>
        Renderer
        <select
          value={vector.renderer.type}
          onChange={(event) => {
            const type = event.target.value as 'single' | 'categorized' | 'graduated'
            setProblem(null)
            setDraft({
              ...vector,
              renderer:
                type === 'single'
                  ? { type: 'single' }
                  : type === 'categorized'
                    ? {
                        type: 'categorized',
                        field: classifyField,
                        categories: [],
                        fallbackColor: '#9ca3af',
                      }
                    : {
                        type: 'graduated',
                        field: classifyField,
                        method: 'equal_interval',
                        classes: [],
                      },
            })
          }}
        >
          <option value="single">Single symbol</option>
          <option value="categorized">Categorized</option>
          <option value="graduated">Graduated</option>
        </select>
      </label>

      {vector.renderer.type !== 'single' ? (
        <>
          <label>
            Classify by
            <select
              value={classifyField}
              onChange={(event) => setClassifyField(event.target.value)}
            >
              <option value="">Choose a field…</option>
              {fields.data?.fields.map((field) => (
                <option key={field.name} value={field.name}>
                  {field.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            Colour ramp
            <select value={ramp} onChange={(event) => setRamp(event.target.value as RampName)}>
              {Object.keys(RAMPS).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>

          <button type="button" onClick={classify}>
            Classify
          </button>

          <ul className="style-editor__classes">
            {classes.map((stop, index) => (
              <li key={index} data-testid="class-row">
                <input
                  type="color"
                  value={stop.color}
                  aria-label={`Colour for class ${index + 1}`}
                  onChange={(event) => {
                    const next = [...classes]
                    next[index] = { ...stop, color: event.target.value }
                    setDraft({
                      ...vector,
                      renderer:
                        vector.renderer.type === 'categorized'
                          ? { ...vector.renderer, categories: next }
                          : { ...(vector.renderer as never), classes: next },
                    })
                  }}
                />
                <span>{stop.label ?? String(stop.value ?? '')}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <label>
        Fill colour
        <input
          type="color"
          value={vector.fill.color}
          onChange={(event) =>
            setDraft({ ...vector, fill: { ...vector.fill, color: event.target.value } })
          }
        />
      </label>

      <label>
        Fill opacity
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={vector.fill.opacity}
          onChange={(event) =>
            setDraft({ ...vector, fill: { ...vector.fill, opacity: Number(event.target.value) } })
          }
        />
      </label>

      <label>
        Outline colour
        <input
          type="color"
          value={vector.stroke.color}
          onChange={(event) =>
            setDraft({ ...vector, stroke: { ...vector.stroke, color: event.target.value } })
          }
        />
      </label>

      <label>
        Outline width
        <input
          type="number"
          min={0}
          max={20}
          step={0.5}
          value={vector.stroke.width}
          onChange={(event) =>
            setDraft({ ...vector, stroke: { ...vector.stroke, width: Number(event.target.value) } })
          }
        />
      </label>

      <label>
        Marker shape
        <select
          value={vector.marker.shape}
          onChange={(event) =>
            setDraft({
              ...vector,
              marker: {
                ...vector.marker,
                shape: event.target.value as VectorStyle['marker']['shape'],
              },
            })
          }
        >
          <option value="circle">Circle</option>
          <option value="square">Square</option>
          <option value="triangle">Triangle</option>
        </select>
      </label>

      <label>
        Label field
        <select
          value={vector.label?.field ?? ''}
          onChange={(event) =>
            setDraft({
              ...vector,
              label: event.target.value
                ? {
                    field: event.target.value,
                    color: '#111827',
                    size: 12,
                    haloColor: '#ffffff',
                  }
                : null,
            })
          }
        >
          <option value="">No labels</option>
          {fields.data?.fields.map((field) => (
            <option key={field.name} value={field.name}>
              {field.name}
            </option>
          ))}
        </select>
      </label>

      {problem ? <p role="alert">{problem}</p> : null}

      <button type="button" onClick={apply}>
        Apply
      </button>
    </section>
  )
}
```

- [ ] **Step 5: Run the style editor tests and confirm they pass**

Run: `npm run test -- --run src/features/styling`
Expected: 22 passed (7 ramps + 8 defaults + ~8 editor).

If `it('warns when a graduated classification finds no numeric values')` shows the wrong message, align the copy in `classify()` with the test's `/no numeric values/i` — the test states the contract.

- [ ] **Step 6: Render the editor and run the gate**

In `App.tsx`, render `<StyleEditor projectId={projectId} layer={selectedLayer} />` above `<MemoryPanel />` in the inspector slot when a layer is selected.

Run: `npm run lint && npm run typecheck && npm run test -- --run`

```bash
cd gis-platform
git add web/src/features/styling web/src/App.tsx web/src/index.css
git commit -m "feat: add the style editor with categorized and graduated classification"
```

---

## Task 21: Map Editing Tools — Draw, Modify, Delete, Snap

**Files:**
- Create: `gis-platform/web/src/features/editing/editSession.ts`
- Create: `gis-platform/web/src/features/editing/useEditSession.ts`
- Create: `gis-platform/web/src/features/editing/EditToolbar.tsx`
- Modify: `gis-platform/web/src/App.tsx`, `src/index.css`
- Test: `gis-platform/web/src/features/editing/editSession.test.ts`, `src/features/editing/EditToolbar.test.tsx`
- Modify: `gis-platform/docs/09-editing-and-transactions.md`

**Interfaces:**
- Consumes: `createFeature`, `updateFeature`, `deleteFeature` (Task 14); `useMap` (Task 15); `useLayerStore` (Task 17); `Layer` (Task 14).
- Produces:
  - `src/features/editing/editSession.ts` — `geometryTypeToDrawType(geometryType: string | null): 'Point' | 'LineString' | 'Polygon' | null`; `featureToGeoJson(feature: Feature): GeoJSON.Geometry`; `EditQueue` class with `enqueue(op)`, `pending: EditOperation[]`, `flush(handlers): Promise<FlushResult>`, `discard()`. `EditOperation = { kind: 'create'; tempId: string; geometry } | { kind: 'update'; featureId: string; geometry } | { kind: 'delete'; featureId: string }`.
  - `src/features/editing/useEditSession.ts` — `useEditSession(layer)` returning `{ mode, setMode, pendingCount, save, discard, isSaving, error }`, attaching/detaching OL `Draw`, `Modify`, `Snap` and a click-to-delete handler.
  - `src/features/editing/EditToolbar.tsx` — `<EditToolbar layer />`.

- [ ] **Step 1: Write the failing edit session test**

`gis-platform/web/src/features/editing/editSession.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import { EditQueue, geometryTypeToDrawType } from './editSession'

const POINT: GeoJSON.Geometry = { type: 'Point', coordinates: [1, 2] }

describe('geometryTypeToDrawType', () => {
  it('maps PostGIS geometry types to OL draw types', () => {
    expect(geometryTypeToDrawType('POINT')).toBe('Point')
    expect(geometryTypeToDrawType('MULTIPOINT')).toBe('Point')
    expect(geometryTypeToDrawType('LINESTRING')).toBe('LineString')
    expect(geometryTypeToDrawType('MULTILINESTRING')).toBe('LineString')
    expect(geometryTypeToDrawType('POLYGON')).toBe('Polygon')
    expect(geometryTypeToDrawType('MULTIPOLYGON')).toBe('Polygon')
  })

  it('is case insensitive', () => {
    expect(geometryTypeToDrawType('Point')).toBe('Point')
  })

  it('returns null for an unknown or missing type', () => {
    expect(geometryTypeToDrawType('GEOMETRYCOLLECTION')).toBeNull()
    expect(geometryTypeToDrawType(null)).toBeNull()
  })
})

describe('EditQueue', () => {
  it('starts empty', () => {
    expect(new EditQueue().pending).toEqual([])
  })

  it('collapses repeated updates to the same feature', () => {
    const queue = new EditQueue()
    queue.enqueue({ kind: 'update', featureId: '1', geometry: POINT })
    queue.enqueue({
      kind: 'update',
      featureId: '1',
      geometry: { type: 'Point', coordinates: [9, 9] },
    })
    expect(queue.pending).toHaveLength(1)
    expect((queue.pending[0] as { geometry: GeoJSON.Point }).geometry.coordinates).toEqual([9, 9])
  })

  it('a delete supersedes a pending update for the same feature', () => {
    const queue = new EditQueue()
    queue.enqueue({ kind: 'update', featureId: '1', geometry: POINT })
    queue.enqueue({ kind: 'delete', featureId: '1' })
    expect(queue.pending).toEqual([{ kind: 'delete', featureId: '1' }])
  })

  it('deleting a not-yet-saved creation just drops it', () => {
    const queue = new EditQueue()
    queue.enqueue({ kind: 'create', tempId: 't1', geometry: POINT })
    queue.enqueue({ kind: 'delete', featureId: 't1' })
    expect(queue.pending).toEqual([])
  })

  it('flush calls one handler per operation in order', async () => {
    const queue = new EditQueue()
    queue.enqueue({ kind: 'create', tempId: 't1', geometry: POINT })
    queue.enqueue({ kind: 'update', featureId: '2', geometry: POINT })
    queue.enqueue({ kind: 'delete', featureId: '3' })

    const handlers = {
      create: vi.fn().mockResolvedValue('10'),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    }
    const result = await queue.flush(handlers)

    expect(handlers.create).toHaveBeenCalledWith(POINT)
    expect(handlers.update).toHaveBeenCalledWith('2', POINT)
    expect(handlers.remove).toHaveBeenCalledWith('3')
    expect(result.succeeded).toBe(3)
    expect(result.failures).toEqual([])
    expect(queue.pending).toEqual([])
  })

  it('keeps failed operations queued and reports them', async () => {
    const queue = new EditQueue()
    queue.enqueue({ kind: 'update', featureId: '2', geometry: POINT })
    queue.enqueue({ kind: 'delete', featureId: '3' })

    const handlers = {
      create: vi.fn(),
      update: vi.fn().mockRejectedValue(new Error('geometry is not valid')),
      remove: vi.fn().mockResolvedValue(undefined),
    }
    const result = await queue.flush(handlers)

    expect(result.succeeded).toBe(1)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.message).toMatch(/not valid/)
    expect(queue.pending).toHaveLength(1)
    expect(queue.pending[0]).toMatchObject({ kind: 'update', featureId: '2' })
  })

  it('discard empties the queue', () => {
    const queue = new EditQueue()
    queue.enqueue({ kind: 'delete', featureId: '1' })
    queue.discard()
    expect(queue.pending).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and confirm it fails, then implement `editSession.ts`**

Run: `npm run test -- --run src/features/editing/editSession.test.ts` → FAIL.

```ts
import type { Feature } from 'ol'
import GeoJSON from 'ol/format/GeoJSON'

export type DrawType = 'Point' | 'LineString' | 'Polygon'

const DRAW_TYPES: Record<string, DrawType> = {
  point: 'Point',
  multipoint: 'Point',
  linestring: 'LineString',
  multilinestring: 'LineString',
  polygon: 'Polygon',
  multipolygon: 'Polygon',
}

export function geometryTypeToDrawType(geometryType: string | null): DrawType | null {
  if (!geometryType) return null
  return DRAW_TYPES[geometryType.toLowerCase()] ?? null
}

const format = new GeoJSON({ dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' })

export function featureToGeoJson(feature: Feature): GeoJSON.Geometry {
  const geometry = feature.getGeometry()
  if (!geometry) throw new Error('Feature has no geometry')
  return format.writeGeometryObject(geometry) as GeoJSON.Geometry
}

export type EditOperation =
  | { kind: 'create'; tempId: string; geometry: GeoJSON.Geometry }
  | { kind: 'update'; featureId: string; geometry: GeoJSON.Geometry }
  | { kind: 'delete'; featureId: string }

export interface FlushHandlers {
  create: (geometry: GeoJSON.Geometry) => Promise<string>
  update: (featureId: string, geometry: GeoJSON.Geometry) => Promise<void>
  remove: (featureId: string) => Promise<void>
}

export interface FlushResult {
  succeeded: number
  failures: Error[]
}

/**
 * A QGIS-style edit buffer.
 *
 * Edits accumulate locally so a user can drag a vertex twenty times without
 * twenty PATCHes, and can abandon the whole session. The queue collapses
 * redundant work: repeated updates to one feature keep only the last
 * geometry, a delete supersedes a pending update, and deleting something
 * that was never saved simply removes it from the queue.
 *
 * On flush, failures stay queued. A geometry the server rejects should not
 * silently vanish from the user's pending list.
 */
export class EditQueue {
  private operations: EditOperation[] = []

  get pending(): EditOperation[] {
    return [...this.operations]
  }

  enqueue(operation: EditOperation): void {
    if (operation.kind === 'update') {
      const index = this.operations.findIndex(
        (existing) =>
          (existing.kind === 'update' && existing.featureId === operation.featureId) ||
          (existing.kind === 'create' && existing.tempId === operation.featureId),
      )
      if (index >= 0) {
        const existing = this.operations[index]!
        this.operations[index] =
          existing.kind === 'create'
            ? { ...existing, geometry: operation.geometry }
            : operation
        return
      }
      this.operations.push(operation)
      return
    }

    if (operation.kind === 'delete') {
      const createdIndex = this.operations.findIndex(
        (existing) => existing.kind === 'create' && existing.tempId === operation.featureId,
      )
      if (createdIndex >= 0) {
        this.operations.splice(createdIndex, 1)
        return
      }
      this.operations = this.operations.filter(
        (existing) => !(existing.kind === 'update' && existing.featureId === operation.featureId),
      )
      this.operations.push(operation)
      return
    }

    this.operations.push(operation)
  }

  async flush(handlers: FlushHandlers): Promise<FlushResult> {
    const failures: Error[] = []
    const stillPending: EditOperation[] = []
    let succeeded = 0

    for (const operation of this.operations) {
      try {
        if (operation.kind === 'create') await handlers.create(operation.geometry)
        else if (operation.kind === 'update')
          await handlers.update(operation.featureId, operation.geometry)
        else await handlers.remove(operation.featureId)
        succeeded += 1
      } catch (error) {
        failures.push(error as Error)
        stillPending.push(operation)
      }
    }

    this.operations = stillPending
    return { succeeded, failures }
  }

  discard(): void {
    this.operations = []
  }
}
```

Run again: 11 passed.

- [ ] **Step 3: Implement `src/features/editing/useEditSession.ts`**

```ts
import type { Feature } from 'ol'
import { Draw, Modify, Snap } from 'ol/interaction'
import VectorLayer from 'ol/layer/Vector'
import type VectorSource from 'ol/source/Vector'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { createFeature, deleteFeature, updateFeature } from '../../api/features'
import type { Layer } from '../../api/types'
import { useMap } from '../../map/MapProvider'
import { EditQueue, featureToGeoJson, geometryTypeToDrawType } from './editSession'

export type EditMode = 'off' | 'draw' | 'modify' | 'delete'

export function useEditSession(layer: Layer | null) {
  const map = useMap()
  const queue = useMemo(() => new EditQueue(), [layer?.id])
  const [mode, setMode] = useState<EditMode>('off')
  const [pendingCount, setPendingCount] = useState(0)
  const [isSaving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tempCounter = useRef(0)

  const source = useMemo<VectorSource | null>(() => {
    if (!map || !layer) return null
    for (const olLayer of map.getLayers().getArray()) {
      if (olLayer.get('layer_id') === layer.id && olLayer instanceof VectorLayer) {
        return olLayer.getSource() as VectorSource
      }
    }
    return null
  }, [map, layer])

  const bump = useCallback(() => setPendingCount(queue.pending.length), [queue])

  useEffect(() => {
    if (!map || !source || !layer || mode === 'off') return

    const interactions: (Draw | Modify | Snap)[] = []
    const snap = new Snap({ source })

    if (mode === 'draw') {
      const drawType = geometryTypeToDrawType(layer.geometryType)
      if (!drawType) {
        setError('This layer has a geometry type that cannot be drawn.')
        return
      }
      const draw = new Draw({ source, type: drawType })
      draw.on('drawend', (event) => {
        tempCounter.current += 1
        const tempId = `temp-${tempCounter.current}`
        event.feature.setId(tempId)
        queue.enqueue({ kind: 'create', tempId, geometry: featureToGeoJson(event.feature) })
        bump()
      })
      interactions.push(draw)
    }

    if (mode === 'modify') {
      const modify = new Modify({ source })
      modify.on('modifyend', (event) => {
        for (const feature of event.features.getArray() as Feature[]) {
          const featureId = String(feature.getId() ?? feature.get('fid'))
          queue.enqueue({ kind: 'update', featureId, geometry: featureToGeoJson(feature) })
        }
        bump()
      })
      interactions.push(modify)
    }

    interactions.push(snap)
    interactions.forEach((interaction) => map.addInteraction(interaction))

    let onClick: ((event: { pixel: number[] }) => void) | null = null
    if (mode === 'delete') {
      onClick = (event) => {
        map.forEachFeatureAtPixel(event.pixel as [number, number], (candidate) => {
          const feature = candidate as Feature
          const featureId = String(feature.getId() ?? feature.get('fid'))
          queue.enqueue({ kind: 'delete', featureId })
          source.removeFeature(feature)
          bump()
          return true
        })
      }
      map.on('click', onClick as never)
    }

    return () => {
      interactions.forEach((interaction) => map.removeInteraction(interaction))
      if (onClick) map.un('click', onClick as never)
    }
  }, [map, source, layer, mode, queue, bump])

  const save = useCallback(async () => {
    if (!layer) return
    setSaving(true)
    setError(null)
    const result = await queue.flush({
      create: async (geometry) => {
        const created = await createFeature(layer.id, { geometry, properties: {} })
        return created.id
      },
      update: async (featureId, geometry) => {
        await updateFeature(layer.id, featureId, { geometry })
      },
      remove: async (featureId) => {
        await deleteFeature(layer.id, featureId)
      },
    })
    setSaving(false)
    bump()
    if (result.failures.length > 0) {
      setError(
        `${result.failures.length} edit(s) failed: ${result.failures[0]?.message ?? 'unknown error'}`,
      )
    } else {
      source?.refresh()
    }
  }, [layer, queue, source, bump])

  const discard = useCallback(() => {
    queue.discard()
    bump()
    setError(null)
    source?.refresh()
  }, [queue, source, bump])

  return { mode, setMode, pendingCount, save, discard, isSaving, error }
}
```

- [ ] **Step 4: Implement `src/features/editing/EditToolbar.tsx` and its test**

```tsx
import type { Layer } from '../../api/types'
import { useEditSession, type EditMode } from './useEditSession'

const MODES: { value: EditMode; label: string }[] = [
  { value: 'off', label: 'Browse' },
  { value: 'draw', label: 'Draw' },
  { value: 'modify', label: 'Modify' },
  { value: 'delete', label: 'Delete' },
]

interface EditToolbarProps {
  layer: Layer | null
}

export function EditToolbar({ layer }: EditToolbarProps) {
  const session = useEditSession(layer)
  const editable = layer?.source.type === 'postgis'

  if (!layer) return null
  if (!editable) {
    return <p className="edit-toolbar edit-toolbar--disabled">This layer is not editable.</p>
  }

  return (
    <div className="edit-toolbar" role="toolbar" aria-label="Editing tools">
      {MODES.map((entry) => (
        <button
          key={entry.value}
          type="button"
          aria-pressed={session.mode === entry.value}
          onClick={() => session.setMode(entry.value)}
        >
          {entry.label}
        </button>
      ))}

      <span data-testid="pending-count">{session.pendingCount} pending</span>

      <button
        type="button"
        disabled={session.pendingCount === 0 || session.isSaving}
        onClick={() => void session.save()}
      >
        {session.isSaving ? 'Saving…' : 'Save edits'}
      </button>
      <button
        type="button"
        disabled={session.pendingCount === 0 || session.isSaving}
        onClick={session.discard}
      >
        Discard
      </button>

      {session.error ? <p role="alert">{session.error}</p> : null}
    </div>
  )
}
```

`gis-platform/web/src/features/editing/EditToolbar.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { Layer } from '../../api/types'
import { MapProvider } from '../../map/MapProvider'
import { EditToolbar } from './EditToolbar'

const postgisLayer = {
  id: 'l1',
  projectId: 'p1',
  name: 'Cities',
  kind: 'vector',
  source: {
    type: 'postgis',
    schemaName: 'gis_data',
    tableName: 'cities',
    geometryColumn: 'geometry',
    idColumn: 'fid',
    srid: 4326,
  },
  style: null,
  visible: true,
  opacity: 1,
  zIndex: 0,
  extent: null,
  featureCount: 3,
  srid: 4326,
  geometryType: 'POINT',
} as Layer

const basemapLayer = {
  ...postgisLayer,
  id: 'l2',
  kind: 'basemap',
  source: { type: 'xyz', url: 'https://t/{z}/{x}/{y}.png', attribution: null },
} as Layer

function renderToolbar(layer: Layer | null) {
  return render(
    <MapProvider center={[0, 0]} zoom={2}>
      <EditToolbar layer={layer} />
    </MapProvider>,
  )
}

describe('EditToolbar', () => {
  it('renders nothing without a layer', () => {
    const { container } = renderToolbar(null)
    expect(container).toBeEmptyDOMElement()
  })

  it('refuses to edit a non-PostGIS layer', () => {
    renderToolbar(basemapLayer)
    expect(screen.getByText(/not editable/i)).toBeInTheDocument()
  })

  it('starts in browse mode', () => {
    renderToolbar(postgisLayer)
    expect(screen.getByRole('button', { name: 'Browse' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('switching mode updates the pressed state', async () => {
    renderToolbar(postgisLayer)
    await userEvent.click(screen.getByRole('button', { name: 'Draw' }))
    expect(screen.getByRole('button', { name: 'Draw' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Browse' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('save and discard are disabled with nothing pending', () => {
    renderToolbar(postgisLayer)
    expect(screen.getByRole('button', { name: /save edits/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /discard/i })).toBeDisabled()
  })

  it('shows the pending count', () => {
    renderToolbar(postgisLayer)
    expect(screen.getByTestId('pending-count')).toHaveTextContent('0 pending')
  })
})
```

- [ ] **Step 5: Run the editing tests and confirm they pass**

Run: `npm run test -- --run src/features/editing`
Expected: 17 passed (11 queue + 6 toolbar).

- [ ] **Step 6: Render the toolbar and run the full gate**

In `App.tsx`, render `<EditToolbar layer={selectedLayer} />` as an overlay above the map (absolutely positioned inside `.app-shell__map`). Add to `src/index.css`:

```css
.edit-toolbar {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 2;
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.95);
  border: 1px solid var(--panel-border);
  border-radius: 4px;
}
.edit-toolbar button[aria-pressed='true'] { background: var(--accent); color: #fff; }
.edit-toolbar--disabled { color: #64748b; }
```

Run: `npm run lint && npm run typecheck && npm run test -- --run`
Expected: all green — the complete web suite.

```bash
cd gis-platform
git add web/src/features/editing web/src/App.tsx web/src/index.css
git commit -m "feat: add draw, modify, delete and snapping with a buffered edit session"
```

- [ ] **Step 7: Extend `gis-platform/docs/09-editing-and-transactions.md`**

Append a section `## The client edit buffer` containing: the `EditQueue` class docstring pasted verbatim; the three collapse rules with the tests that prove them (`test('a delete supersedes a pending update for the same feature')` and `test('deleting a not-yet-saved creation just drops it')`); an explanation of why failures stay queued rather than being dropped; and a short comparison table of QGIS's edit session versus this one (buffer location, commit trigger, conflict handling, undo scope).

- [ ] **Step 8: Full-stack manual verification**

```bash
cd gis-platform
docker compose up -d postgres
cd backend && alembic upgrade head && uvicorn app.main:app --reload --port 1316 &
cd ../web && npm run dev
```

Walk the whole product at `http://localhost:1317` and confirm each of these:
1. Create a project; add an XYZ basemap layer.
2. Import a GeoJSON file → it appears in the layer panel with a feature count and draws on the map.
3. Import a GeoTIFF → it draws as raster tiles; the memory panel shows one open server handle.
4. Register an existing PostGIS table from the Add Layer dialog.
5. Toggle visibility, change opacity, reorder layers — the map updates and the order persists across a reload.
6. Open the attribute table, sort by a column, edit a cell, confirm the value persists after a reload.
7. Style the vector layer graduated by a numeric field — the map recolours.
8. Enter Draw mode, add a feature, Save edits — it appears in the attribute table.
9. Enter Modify mode, drag a vertex, Save — the geometry persists.
10. Enter Delete mode, click a feature, Save — it disappears from the table.
11. Pan and zoom around a large layer; the memory panel's browser total rises and then plateaus at the budget rather than growing without bound.

Fix anything that fails before declaring the prototype done. Stop both servers.

- [ ] **Step 9: Final commit**

```bash
cd gis-platform
git add docs README.md
git commit -m "docs: complete the GIS platform learning documentation"
```

---

## Self-Review

Run through this before declaring the plan complete.

**Spec coverage.** Every item the request named maps to tasks:

| Requirement | Tasks |
|---|---|
| Layer management | 2 (model), 4 (CRUD + ordering), 15 (map sync), 17 (panel) |
| Memory management | 11 (server pool), 8 (bbox streaming), 18 (browser budget), 12 (docs) |
| Vector data reading | 6 (import), 8 (bbox GeoJSON), 15 (OL vector layer) |
| Raster data reading | 7 (import + COG), 12 (XYZ tiles + statistics), 15 (OL tile layer) |
| Vector tiles | 10 (`ST_AsMVT` endpoint), 15 (`VectorTileLayer` + remote MVT source) |
| PostgreSQL connectivity | 2 (engine/session), 5 (introspection + register in place), 6 (import target) |
| Map editing | 13 (backend create/update/delete), 21 (draw/modify/delete/snap) |
| Attribute table editing | 9 (fields + paging + filtering), 13 (write path), 19 (panel with inline editing) |
| Styling / colour schemes | 3 (spec), 16 (compiler + ramps), 20 (editor), 12 (raster colormap) |
| Learning documentation | Docs steps in Tasks 1, 2, 3, 5, 8, 9, 10, 12, 16, 18, 21 → nine numbered chapters |

**Known gaps, stated deliberately.** The plan does not include authentication, multi-user concurrency control on feature edits (documented in `09-editing-and-transactions.md` under "What is deliberately missing"), undo/redo beyond the edit buffer, print/export layouts, or WMS/WFS consumption. These are out of scope for a prototype and are not silently dropped — each is named where it would naturally belong.

**Type consistency checks performed.** `PostgisSource` field names (`schema_name`/`schemaName`, `table_name`, `geometry_column`, `id_column`, `srid`) are identical in Task 3, Task 5, Task 8, Task 10, Task 13 and `src/api/types.ts`. `layer_service.get_layer_or_404` and `require_postgis_source` are defined once in Task 4 and consumed unchanged in Tasks 5, 8, 9, 10, 12, 13. `LayerFactoryDeps` is introduced in Task 15 and extended (not renamed) in Task 18. `validate_tile_coords` and `tile_etag` are defined in Task 10 and reused verbatim in Task 12. `resolve_raster_path` is defined in Task 7 and used in Task 12.

**Two stubs are created and later replaced, on purpose** — both are flagged in the task that creates them and in the task that replaces them: `app/services/raster_tile_service.py` (Task 11 stub → Task 12 real) and `src/map/styleCompiler.ts` (Task 15 stub → Task 16 real). Do not skip the replacement steps.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-26-web-gis-platform.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
