# 01 · Architecture Overview

This platform reimplements, over HTTP, the same mental model a desktop GIS
like QGIS gives you locally: a **layer tree** (the set of datasets currently
loaded into a map), each layer backed by a **data provider** (the thing that
actually knows how to read PostGIS rows or a raster file), a **renderer**
(the styling rules that turn geometry/pixels into a picture), an **attribute
table** (paged, filterable access to a layer's non-spatial columns), and an
**edit buffer** (pending geometry/attribute changes staged before they are
committed back to storage). Where QGIS keeps all of that in one desktop
process talking to local files and databases, this platform splits it across
a browser client, a stateless API, and a spatial database — the rest of this
document explains how those three pieces fit together.

## The three tiers

```
┌───────────────────────┐        HTTP/JSON        ┌───────────────────────┐        SQL / file I/O        ┌───────────────────────┐
│   Browser (OpenLayers) │ ───────────────────────▶│        FastAPI        │ ─────────────────────────────▶│   PostGIS / COG files │
│   port 1317            │◀─────────────────────── │        port 1316      │◀───────────────────────────── │   port 5401            │
└───────────────────────┘                          └───────────────────────┘                              └───────────────────────┘
   layer tree, map canvas                             routes / services /                                   gis schema (platform),
   attribute table UI                                 repositories / models                                 gis_data schema (user data),
                                                                                                              raster files on disk
```

The browser never talks to PostGIS directly. It renders map tiles and
attribute data it receives from the API, and it stages edits locally before
sending them back as HTTP requests.

## Why layered backend

The backend is organized in layers, each with one job:

| Layer          | Responsibility                                                          |
|-----------------|--------------------------------------------------------------------------|
| `routes`        | HTTP shape only — parse the request, call a service, return a response. No SQL. |
| `services`      | Business rules, orchestration across repositories, transaction boundaries. |
| `repositories`  | The only place SQL is written — ORM queries or validated raw SQL.        |
| `models/schemas`| `models`: SQLAlchemy tables (how data is stored). `schemas`: Pydantic wire contracts (how data is shaped over HTTP). |

Keeping SQL out of routes and services means every query lives in exactly
one place, and swapping how a table is queried never touches HTTP handling
or business logic.

## Two kinds of SQL

The platform's own bookkeeping — layers, styles, users, whatever it needs to
track about itself — lives in a fixed `gis` schema with tables the
SQLAlchemy models declare up front. Because those table and column names are
known at development time, that data is accessed through the SQLAlchemy ORM
like any normal application.

User-imported datasets are different: a user can upload a shapefile or
GeoPackage with arbitrary table and column names chosen at import time, not
at development time. The ORM can't declare a model for a table it doesn't
know about yet, so those tables — living in the `gis_data` schema — are
queried with raw SQL that is built carefully and validated, because here the
table and column names are *data* the request carries, not *code* the
application wrote. Never string-formatted into SQL as data ordinarily would
be. See `03-postgis-and-dynamic-sql.md` for how identifiers are validated
before they're interpolated into a query.

## The error envelope

Every non-2xx response from application code is exactly one shape. It is
built by `_envelope` in `app/core/errors.py`:

```python
def _envelope(code: str, message: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "details": details}}
```

For example, raising `NotFoundError("Layer 7 not found", details={"layerId": 7})`
from a route produces:

```json
{
  "error": {
    "code": "not_found",
    "message": "Layer 7 not found",
    "details": { "layerId": 7 }
  }
}
```

`register_exception_handlers` wires this envelope up for four cases: an
`AppError` subclass raised deliberately (uses its own `status_code`/`code`),
a FastAPI `RequestValidationError` (422, `invalid_request`), a Starlette
`HTTPException` (its own status, `http_error`), and any other unhandled
exception, which is masked as a 500 `internal_error` so internals never leak
to the client.

## Configuration

All configuration is a single typed `Settings` object, loaded from
environment variables (or a `.env` file) with the `GIS_` prefix — e.g.
`GIS_LOG_LEVEL=DEBUG` sets `Settings.log_level`. This keeps every setting
discoverable in one file and type-checked at startup instead of scattered
`os.environ` reads.

```python
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
```

`get_settings()` is `lru_cache`-wrapped, so the whole application shares one
`Settings` instance built once at first access. `.env.example` in
`gis-platform/backend/` documents every variable a developer needs to copy
into their own `.env` before running the app.

## Running it

From `gis-platform/backend/`:

```bash
python -m venv .venv
.venv/Scripts/activate          # Windows;  source .venv/bin/activate on POSIX
pip install -e ".[dev]"
```

Then start the API:

```bash
uvicorn app.main:app --reload --port 1316
```

`curl http://localhost:1316/api/v1/health` should return
`{"status":"ok","environment":"development"}`, and
`http://localhost:1316/docs` renders the interactive OpenAPI page.
