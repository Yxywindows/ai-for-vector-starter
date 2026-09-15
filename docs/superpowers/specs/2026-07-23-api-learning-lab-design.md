> 历史设计/计划记录：保留原始上下文，不作为当前功能清单或执行指令。当前实现请从 [文档目录](../../README.md) 阅读；下文的待办和完成状态仅代表当时记录。

# API Learning Lab — Design

**Date:** 2026-07-23
**Status:** Approved
**Goal:** A standalone, hands-on module for practicing REST API design and implementation concepts (HTTP structure, headers, path/query params, request body, multipart upload, CRUD, DB-to-API field mapping, dynamic queries) in a single ~90-minute session. Not a production system — optimized for readability and teaching value over robustness.

## Non-goals

- No production hardening (no real JWT validation, no rate limiting, no migrations framework).
- No changes to the existing `backend/` (FastAPI) or `frontend/` (React) apps — this is fully additive.
- No frontend UI for this module — interaction happens via curl / Postman / browser (FastAPI's auto-generated `/docs` Swagger UI also works out of the box for free).

## Integration point

New top-level folder `api-learning-lab/`, sibling to `backend/` and `frontend/` at the repo root. Nothing in the existing codebase is imported, modified, or depended upon.

## Tech stack & runtime topology

- **Language/framework:** Python + FastAPI, consistent with the existing repo's backend stack (chosen over Spring Boot despite the original request phrasing being Spring-flavored — see decision log below).
- **Database access:** raw SQL via `psycopg2`, parameterized queries (`%s` placeholders). No ORM — the point is to see a query parameter become a `WHERE` clause directly, not to abstract it away.
- **Containerization scope:** only Postgres + pgAdmin run in Docker (`docker-compose.yml`). The FastAPI app runs locally via its own virtualenv and `uvicorn`, mirroring how the existing `backend/` app is run (`uvicorn app.main:app --reload`), just on a different port.
- **Ports** (chosen to avoid collision with the existing stack and any local Postgres):
  - FastAPI app: `8000`
  - Postgres: `5433` (mapped from container's `5432`)
  - pgAdmin: `5050`
- **Isolation:** own `requirements.txt`, own venv, own `uploads/` directory (gitignored) for physically stored uploaded files.

## Directory layout

```
api-learning-lab/
├── docker-compose.yml          # postgres + pgadmin only
├── database/
│   └── init.sql                # schema + ~60 seed dataset rows + ~25 dataset_file rows
├── backend/
│   ├── requirements.txt
│   ├── .env.example             # DB connection settings
│   └── app/
│       ├── main.py              # FastAPI app, CORS, router registration
│       ├── db.py                # psycopg2 connection pool helper
│       ├── auth.py              # header-based auth dependency
│       ├── controller/
│       │   ├── dataset_controller.py   # /api/datasets... (path, query, body, CRUD)
│       │   └── upload_controller.py    # /api/datasets/{id}/files (multipart)
│       ├── entity/
│       │   ├── dataset.py              # Pydantic models (request/response shapes)
│       │   └── dataset_file.py
│       ├── repository/
│       │   ├── dataset_repository.py    # raw SQL, one readable query per method
│       │   └── dataset_file_repository.py
│       └── service/
│           ├── dataset_service.py       # business logic between controller & repository
│           └── file_service.py          # multipart handling + disk storage
│   └── uploads/                # actual uploaded file bytes land here (gitignored)
├── docs/
│   ├── 01-http-basic.md
│   ├── 02-request-components.md
│   ├── 03-rest-api-design.md
│   ├── 04-multipart-upload.md
│   └── 05-learning-plan.md
└── examples/
    ├── curl-examples.sh
    └── postman-collection.json
```

Layer responsibilities (kept literal, even though FastAPI doesn't require this separation, because the point is to *practice* layered design):
- **controller** — HTTP concerns only: reads path/query/header/body, calls a service method, returns a response. No SQL, no business logic.
- **entity** — Pydantic models defining the shape of data in and out (the "DB field ↔ API field" mapping lives here, e.g. DB `resource_type` ↔ JSON `resourceType`).
- **service** — orchestration/business logic (e.g. "does this dataset exist before updating," "build the file's stored path").
- **repository** — the only layer that touches SQL. Each method is a single, readable, parameterized query.

## Data model

### `dataset`
`id bigserial PK`, `title varchar`, `description text`, `resource_type varchar`, `publish_year integer`, `status varchar`, `price numeric`, `is_public boolean`, `tags jsonb`, `metadata jsonb`, `location jsonb`, `created_time timestamp`, `updated_time timestamp`, `file_size bigint`.

### `dataset_file`
`id bigserial PK`, `dataset_id bigint FK → dataset.id`, `file_name varchar`, `file_path varchar`, `file_type varchar`, `file_size bigint`, `created_time timestamp`.

### Seed data
`database/init.sql` inserts **60 `dataset` rows** across four realistic domains — remote sensing, ocean observation, weather, ship trajectory — each with domain-appropriate, meaningful JSONB:
- Remote sensing `metadata`: `{"sensor": "SAR", "resolution": "10m", "coordinateSystem": "EPSG:4326"}`
- Ocean observation `metadata`: `{"buoy_id": "...", "depth_m": ..., "parameter": "sea_surface_temperature"}`
- Weather `metadata`: `{"station": "...", "elevation_m": ..., "variable": "precipitation"}`
- Ship trajectory `metadata`: `{"vessel_type": "cargo", "mmsi": "...", "sampling_interval_s": 30}`
- `tags`: e.g. `["remote-sensing", "ocean", "satellite"]`
- `location`: e.g. `{"province": "Guangdong", "region": "South China Sea"}`

Plus **~25 `dataset_file` rows** attached to a subset of datasets, so the file-listing endpoint returns real data without requiring an upload first.

## API design

| Method | Path | HTTP concept demonstrated |
|---|---|---|
| GET | `/api/datasets/{id}` | Path parameter — identify one resource |
| GET | `/api/datasets?page=&pageSize=&keyword=&type=&year=&status=&sortBy=&sortOrder=` | Query parameters — dynamic filter/paginate/sort |
| POST | `/api/datasets` | Request body — create, requires auth headers |
| PUT | `/api/datasets/{id}` | Path (which resource) + body (what changes) together |
| DELETE | `/api/datasets/{id}` | Path only, requires auth headers |
| POST | `/api/datasets/{id}/files` | Multipart — file + metadata fields together |
| GET | `/api/datasets/{id}/files` | List files for a dataset, to verify an upload landed (small addition beyond the original request, approved) |

### Query parameter semantics
- `keyword` → fuzzy match on `title` (`ILIKE '%...%'`)
- `year` → exact match on `publish_year`
- `status` → exact match on `status`
- `type` (`resourceType`) → exact match on `resource_type`
- `page`/`pageSize` → `LIMIT`/`OFFSET`
- `sortBy`/`sortOrder` → whitelisted column + `ASC`/`DESC` only (never interpolate raw column names into SQL)

### Header-based auth simulation
`POST`, `PUT`, `DELETE` require:
- `Authorization: Bearer <token>`
- `X-Organization-ID: <any value>`

Missing or malformed → `401`. Values are **echoed back** in the response body (e.g. `"createdBy": "<token>"`) purely for observability — never used to filter or scope query results (per the original requirement that headers must not drive business filtering). `GET` endpoints stay open — a deliberate, observable contrast between public reads and authenticated writes.

### Multipart upload
`POST /api/datasets/{id}/files` accepts `multipart/form-data` with a `file` part plus optional metadata form fields. The service layer streams the file to `uploads/{dataset_id}/{filename}` on local disk and the repository inserts a row into `dataset_file` recording name/path/type/size.

### Teaching comments
Every controller method includes a comment block explaining which HTTP concept it demonstrates and the resulting SQL/behavior, adapted from the requested Java-style block into Python docstring/comment form, e.g.:

```python
# ================================
# Query Parameter Example
#
# URL: GET /api/datasets?year=2025
# Purpose: Filter datasets by conditions.
# Database: WHERE publish_year = %s
# ================================
```

## Documentation content

- **01-http-basic.md** — what HTTP is, anatomy of a request (method/URL/headers/body), simple real-world examples.
- **02-request-components.md** — Header vs Path vs Query vs Body vs Multipart, using the mnemonic: Path = who, Query = what conditions, Header = who am I, Body = what data, Multipart = upload files.
- **03-rest-api-design.md** — the pipeline from DB column → entity field → controller parameter → SQL query, using this project's actual `dataset` table as the running example.
- **04-multipart-upload.md** — why JSON can't carry binary files, what `multipart/form-data` actually is on the wire.
- **05-learning-plan.md** — the 90-minute schedule (0–20 read HTTP structure, 20–40 call existing APIs, 40–60 modify query conditions, 60–80 build a new endpoint, 80–90 practice file upload), referencing the concrete endpoints/files built here.

All docs are written after the code exists, so every example in them is copy-pasteable and actually works.

## Testing artifacts

- `examples/curl-examples.sh` — one example per concept: GET with query params, POST with JSON body, PUT, DELETE, multipart upload — runnable against `localhost:8000` once the app is up.
- `examples/postman-collection.json` — importable collection mirroring the same requests, with the auth headers pre-filled as example values.

## Decision log (from clarifying questions)

1. **Stack:** Python/FastAPI (matches existing repo), not Java/Spring Boot — folder names (`controller/entity/repository/service`) kept as requested for conceptual clarity even though FastAPI doesn't enforce that layering.
2. **DB access:** raw SQL via `psycopg2`, not an ORM — keeps the parameter→SQL mapping fully visible, which is the explicit learning goal.
3. **Dockerization scope:** only Postgres + pgAdmin containerized; the API runs locally via venv, consistent with how the existing backend already runs.
