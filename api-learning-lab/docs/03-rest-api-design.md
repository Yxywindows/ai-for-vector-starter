# 03 — REST API Design: From Database Table to API

## The pipeline

Every field you can read or write through this API traces back through four layers:

```
Database column          Entity (Pydantic model)      Controller parameter        SQL
─────────────────       ───────────────────────       ─────────────────────       ──────────────────────
resource_type   VARCHAR   resourceType: str      <-->   type_: str | None    -->   WHERE resource_type = %s
publish_year    INTEGER   publishYear: int|None  <-->   year: int | None     -->   WHERE publish_year = %s
is_public       BOOLEAN   isPublic: bool         <-->   (in DatasetCreate)   -->   INSERT ... is_public ...
metadata        JSONB     metadata: dict         <-->   (in DatasetCreate)   -->   INSERT ... metadata::jsonb ...
```

Two naming conventions meet here on purpose: SQL/Postgres convention is `snake_case` (`resource_type`), JSON/JavaScript convention is `camelCase` (`resourceType`). The **entity layer is where that translation happens** — see `dataset_to_api()` in `backend/app/entity/dataset.py`, which is a literal field-by-field mapping from one to the other. Nothing above the entity layer (the controller, the client) ever needs to know the DB uses snake_case.

## Walking one field end-to-end

Take `publish_year` / `publishYear` / `year` through a real request:

1. **Database column**: `dataset.publish_year INTEGER` (`database/init.sql`)
2. **Entity**: `dataset_to_api()` reads `row["publish_year"]` and emits `"publishYear"` in the JSON response (`backend/app/entity/dataset.py`)
3. **Controller parameter**: the query param is literally called `year` in the URL (`GET /api/datasets?year=2023`), read by `list_datasets()` in `backend/app/controller/dataset_controller.py`
4. **Service**: passes `year` straight through to the repository (`backend/app/service/dataset_service.py`)
5. **SQL**: `dataset_repository.search()` turns it into `WHERE publish_year = %s` with `year` as the bound parameter (`backend/app/repository/dataset_repository.py`)

Try it and watch the response:

```bash
curl -s "http://localhost:8000/api/datasets?year=2023&pageSize=2" | python -m json.tool
```

## The four layers, and why they're separate

- **Controller** — only knows about HTTP (reads path/query/header/body, returns a dict). It never writes SQL.
- **Entity** — only knows about shapes (what a valid `DatasetCreate` body looks like, how a DB row becomes an API response). It has no logic.
- **Service** — the business rules glue: "does this dataset exist before I update it", "only touch the columns the client actually sent". No SQL, no HTTP.
- **Repository** — the *only* place SQL exists. Each function is one query.

This separation means you can change how a request arrives (say, add a new query param) without touching SQL, or change a query's performance characteristics without touching the controller. Each layer can be understood on its own.

## Dynamic queries: the interesting part

`GET /api/datasets` doesn't have one fixed SQL query — it builds one based on which query params showed up. Open `backend/app/repository/dataset_repository.py`'s `search()` function and note:

- Every filter (`keyword`, `resource_type`, `year`, `status`) is optional and independent — the `WHERE` clause is assembled piece by piece only from filters that were actually supplied.
- `sortBy` is validated against a whitelist (`SORTABLE_COLUMNS`) before being used in `ORDER BY` — **never** interpolate a caller-supplied column name directly into SQL, or a client could pass something like `id; DROP TABLE dataset` as a "column name". All actual values (the ones that go in `WHERE`/`LIMIT`) go through `%s` placeholders, which `psycopg2` escapes safely — but placeholders can't parameterize identifiers like column names, which is exactly why the whitelist exists.

Try building your own filter combination and watch which parts of the SQL change:

```bash
curl -s "http://localhost:8000/api/datasets?type=ocean-observation&status=published&sortBy=price&sortOrder=asc" | python -m json.tool
```

Next: [04-multipart-upload.md](./04-multipart-upload.md) — the one endpoint that doesn't fit the JSON-body pattern.
