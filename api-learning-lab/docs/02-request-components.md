# 02 — Request Components: Header vs Path vs Query vs Body vs Multipart

The single most useful mental model in this whole lab:

| Component | One-line meaning | Example |
|---|---|---|
| **Path** | Find **who** — identifies one specific resource | `/api/datasets/`**`42`** |
| **Query** | Find **what conditions** — filters/sorts/paginates a collection | `/api/datasets?`**`year=2023&status=published`** |
| **Header** | **Who am I** — identity and request context, not business data | `Authorization: Bearer test-token` |
| **Body** | **What data** I'm submitting — the actual payload | `{"title": "New Dataset", ...}` |
| **Multipart** | **Upload files** — binary data plus form fields, mixed together | `multipart/form-data` with a `file` part |

## Why the distinction matters

It's tempting to shove everything into query params, or everything into the body. REST conventions exist because each component has a job it's suited for:

- **Path parameters** only make sense for identifying a *specific* resource. You can't have an optional path parameter — either the URL matches a route or it doesn't. That's why `/api/datasets/{id}` uses a path param (id is required, you're always asking for exactly one dataset) while filters on the collection endpoint use query params (every filter is optional).

- **Query parameters** are for the collection endpoint (`GET /api/datasets`) to answer "which subset, in what order, which page". They're always optional and don't change what *kind* of thing you're asking for — just which slice of it.

- **Headers** describe the request itself — who's making it, what auth they have, what format they want back — never the resource data. This project's `Authorization` and `X-Organization-ID` headers are a good example: they identify the caller, but (deliberately) never filter which datasets come back. See `dataset_controller.py`'s `create_dataset`/`update_dataset`/`delete_dataset` for where they're checked, and try omitting them:

  ```bash
  curl -i -X DELETE http://localhost:8000/api/datasets/1
  ```

  You'll get a `422` (FastAPI's built-in validation catches the entirely-missing header) — compare that to sending a header with the wrong shape (no `Bearer` prefix), which this project's own code rejects with a `401`.

- **Body** carries the actual resource data for `POST`/`PUT`. It's structured (JSON here), can be arbitrarily large and nested, and is the only place actual business data belongs on a write.

- **Multipart** exists because JSON can't carry raw binary bytes cleanly (see [04-multipart-upload.md](./04-multipart-upload.md) for why). It lets a single request carry a file *and* ordinary form fields side by side.

## Where to see each one in this codebase

| Concept | File | Look for |
|---|---|---|
| Path | `backend/app/controller/dataset_controller.py` | `get_dataset`, `Path(...)` |
| Query | `backend/app/controller/dataset_controller.py` | `list_datasets`, `Query(...)` |
| Header | `backend/app/auth.py` | `require_auth` |
| Body | `backend/app/entity/dataset.py` | `DatasetCreate`, `DatasetUpdate` |
| Multipart | `backend/app/controller/upload_controller.py` | `upload_file`, `File(...)`, `Form(...)` |

Next: [03-rest-api-design.md](./03-rest-api-design.md) — how a database table becomes this API.
