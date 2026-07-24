# API Learning Lab

A standalone, hands-on module for practicing REST API design and implementation: HTTP structure, headers, path/query parameters, request bodies, multipart upload, CRUD, and dynamic queries. Fully separate from the rest of this repo — nothing here is imported by or affects the main `backend/`/`frontend/` apps.

Not a production system. Optimized for a single ~90-minute learning session — see [`docs/05-learning-plan.md`](docs/05-learning-plan.md).

## Setup

**1. Start Postgres + pgAdmin**

```bash
cd api-learning-lab
docker compose up -d
```

- Postgres: `localhost:5433` (db `api_learning`, user `learning_user`, password `learning_pass`) — seeded automatically from `database/init.sql` with 60 datasets + 25 files on first start.
- pgAdmin: http://localhost:5050 (login `admin@example.com` / `admin`) — optional, for browsing the tables visually.

**2. Start the API**

```bash
cd api-learning-lab/backend
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS/Linux
pip install -r requirements.txt
copy .env.example .env          # Windows: copy, macOS/Linux: cp
uvicorn app.main:app --reload --port 8000
```

Confirm it's up:

```bash
curl http://localhost:8000/api/health
```

Swagger UI (auto-generated, browsable API docs): http://localhost:8000/docs

## Resetting the seed data

If you've created/updated/deleted rows while practicing and want to start over from the original 60 datasets / 25 files:

```bash
docker compose down -v
docker compose up -d
```

`-v` removes the Postgres data volume, so `init.sql` reseeds from scratch on next start.

## Where to go next

- [`docs/01-http-basic.md`](docs/01-http-basic.md) — what HTTP is, request structure
- [`docs/02-request-components.md`](docs/02-request-components.md) — header vs path vs query vs body vs multipart
- [`docs/03-rest-api-design.md`](docs/03-rest-api-design.md) — database field → entity → controller → SQL
- [`docs/04-multipart-upload.md`](docs/04-multipart-upload.md) — why JSON can't upload files
- [`docs/05-learning-plan.md`](docs/05-learning-plan.md) — the 90-minute schedule
- [`examples/curl-examples.sh`](examples/curl-examples.sh) and [`examples/postman-collection.json`](examples/postman-collection.json) — runnable examples for every endpoint

## Structure

```
api-learning-lab/
├── docker-compose.yml       # Postgres + pgAdmin only
├── database/init.sql        # schema + seed data
├── backend/
│   └── app/
│       ├── main.py
│       ├── controller/      # HTTP layer (path/query/header/body handling)
│       ├── entity/          # request/response models, DB-row <-> API-field mapping
│       ├── repository/      # the only layer with SQL
│       └── service/         # business logic between controller and repository
├── docs/                    # the 5 concept write-ups above
└── examples/                # curl script + Postman collection
```
