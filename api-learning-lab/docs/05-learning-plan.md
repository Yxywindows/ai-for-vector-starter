# 05 — 90-Minute Learning Plan

Prerequisite: the lab is running — Postgres + pgAdmin via `docker compose up -d` in `api-learning-lab/`, and the FastAPI app via `uvicorn app.main:app --port 8000` in `api-learning-lab/backend/` (see the top-level `README.md` for exact commands). Confirm with:

```bash
curl http://localhost:8000/api/health
```

## 0–20 min: Understand HTTP request structure

- Read [01-http-basic.md](./01-http-basic.md) and [02-request-components.md](./02-request-components.md).
- Run `curl -i http://localhost:8000/api/datasets/1` and identify, in the actual output: status line, headers, body.
- Open `http://localhost:8000/docs` in a browser — FastAPI's auto-generated Swagger UI. Expand each endpoint and match what you see (path params, query params, request body schema) to what you just read.

**Checkpoint:** you can point at a raw HTTP request and correctly label which part is the path, which is the query string, which is a header, and which is the body.

## 20–40 min: Call existing APIs

- Read [03-rest-api-design.md](./03-rest-api-design.md).
- Work through every example in `examples/curl-examples.sh` (or import `examples/postman-collection.json` into Postman) — GET by id, GET with query filters, POST, PUT, DELETE, and the multipart upload.
- For each one, open the matching controller function (`backend/app/controller/dataset_controller.py` or `upload_controller.py`) and read its teaching comment block before/after running the request.

**Checkpoint:** you've successfully created, updated, and deleted a dataset, and can explain what each layer (controller → service → repository) did with your request.

## 40–60 min: Modify query conditions

Open `backend/app/repository/dataset_repository.py`'s `search()` function and the `SORTABLE_COLUMNS` whitelist. Make one small change, then restart uvicorn (`Ctrl+C`, rerun) and test it with curl:

- Add a new filter — e.g. filter by `isPublic` (`?isPublic=true`). You'll need to: add a query param in the controller, thread it through the service function signature, add a `WHERE is_public = %s` clause in the repository.
- Or: add a new sortable column to `SORTABLE_COLUMNS` (e.g. `"fileSize": "file_size"`) and confirm `?sortBy=fileSize&sortOrder=desc` works.

**Checkpoint:** you've traced a single new query parameter through controller → service → repository → SQL yourself, not just read someone else's.

## 60–80 min: Create a new API

Add a genuinely new endpoint — a good, scoped choice: `GET /api/datasets/stats` returning a count of datasets grouped by `resource_type`.

1. Add `count_by_resource_type()` to `dataset_repository.py` (`SELECT resource_type, COUNT(*) FROM dataset GROUP BY resource_type`).
2. Add a `get_stats()` function to `dataset_service.py` that calls it.
3. Add a `GET /api/datasets/stats` route to `dataset_controller.py` — **note**: register it *before* the `/{dataset_id}` route, or FastAPI will try to parse `"stats"` as a dataset id and fail. This is a real, common REST routing gotcha worth hitting once.
4. Test with `curl http://localhost:8000/api/datasets/stats`.

**Checkpoint:** a working endpoint you designed yourself, following the same controller → service → repository shape as the rest of the app.

## 80–90 min: Practice file upload

- Re-read [04-multipart-upload.md](./04-multipart-upload.md).
- Upload a real file (any small image or CSV on your machine) to a dataset of your choice, then list its files to confirm it's there.
- Bonus if time remains: add a `DELETE /api/datasets/{dataset_id}/files/{file_id}` endpoint yourself, following the same three-layer pattern as everything else (you'll need a `delete()` function in `dataset_file_repository.py`).

**Checkpoint:** you understand why multipart exists and can upload a file end-to-end without copy-pasting the example verbatim.
