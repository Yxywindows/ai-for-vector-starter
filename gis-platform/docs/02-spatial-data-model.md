# 02 · Spatial Data Model

This platform's own database tables never store geodata itself. A shapefile,
GeoPackage, or raster a user imports lands in its own table in the `gis_data`
schema (created by the import pipeline, one table per dataset, columns and
types chosen at import time) or as a file on disk. What the `gis` schema
stores is *metadata about* that geodata: which layers exist, what they're
called, how they're styled, what order they draw in, which table or file
backs them. The two tables in this schema — `project` and `layer` — are the
platform's own bookkeeping, not a copy of anyone's spatial data.

This split matters because the two kinds of table have fundamentally
different lifecycles. `project` and `layer` have a fixed, known shape the
ORM can declare up front, so they're migrated like any normal application
table. A user's imported dataset has a shape nobody knows until the file is
parsed — arbitrary column names, arbitrary geometry types — so the ORM can't
declare a model for it, and Alembic must never try to manage its DDL.

## Three schemas, three owners

| Schema      | Owns                                              | Who manages its DDL |
|-------------|----------------------------------------------------|----------------------|
| `gis`       | Platform metadata: `project`, `layer`, and whatever future bookkeeping tables the app needs. | Alembic, via migrations in this repo. |
| `gis_data`  | One table per imported dataset, created at import time with column/type names chosen by the file being imported. | The import pipeline (raw, validated SQL) — Alembic creates the *schema* itself (Step 10) but never touches a table inside it. |
| *user schemas* | Existing schemas a user points the platform at to read/write data in place (e.g. a database another application already owns). | The owning application. The platform only ever registers read/write access to what's already there — it never creates or drops a user schema. |

## The `layer` table

```python
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

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
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

- **`source`** (`JSONB`, required) — where the layer's data actually lives:
  a PostGIS table + column for a vector layer, a COG path for a raster, a
  tile URL template for a `vector_tile`/`basemap` layer. The shape is
  different for every `kind`.
- **`style`** (`JSONB`, defaults to `{}`) — the rendering rules (colors,
  symbology, breaks) for that layer. Also `kind`-dependent: a point layer's
  style has nothing in common with a raster's color ramp.
- **`extent`** (`JSONB`, nullable) — `[minx, miny, maxx, maxy]` in EPSG:4326,
  computed once (import time or on demand) so the frontend can zoom-to-layer
  without a full table scan.
- **`srid`** (nullable) — the *storage* SRID of the underlying data. The
  wire format is always EPSG:4326 (see `01-architecture-overview.md`), but
  what's actually stored in PostGIS can be anything; reprojection happens at
  the edge, not in the table.
- **`geometry_type`** (nullable) — `Point` / `LineString` / `Polygon` / etc.
  for a vector layer, `null` for anything else (raster, tile, basemap).

`source` and `style` are `JSONB` columns instead of a fixed set of typed
columns because their *shape* varies by `kind` — a raster's `source` needs a
file path, a PostGIS vector's needs a table/column/SRID triple, and no
single set of nullable columns describes both without either wasting most of
its columns per row or losing type safety entirely. Postgres enforces that
the value is valid JSON; a Pydantic schema (Task 3) enforces that the JSON
matches the shape a given `kind` requires, keyed off the `kind` field itself
— that validation lives in the request/response layer, not the database.

## Cascade and uniqueness

Two rules keep the layer tree consistent, both enforced by Postgres, not
application code:

```python
UniqueConstraint("project_id", "name", name="uq_layer_project_id"),
```

A layer name only has to be unique *within* its project — "Roads" can exist
in two different projects, but not twice in the same one. And:

```python
ForeignKey(f"{_SCHEMA}.project.id", ondelete="CASCADE")
```

Deleting a `Project` deletes every `Layer` that points at it; there is no
such thing as an orphaned layer. Both are proven directly against a real
database, not mocked:

```python
async def test_layer_name_is_unique_per_project(db_session: AsyncSession) -> None:
    project = await _project(db_session)
    db_session.add(Layer(project_id=project.id, name="Roads", kind="vector", source={}))
    await db_session.flush()
    db_session.add(Layer(project_id=project.id, name="Roads", kind="vector", source={}))
    with pytest.raises(IntegrityError):
        await db_session.flush()


async def test_deleting_project_cascades_to_layers(db_session: AsyncSession) -> None:
    project = await _project(db_session)
    db_session.add(Layer(project_id=project.id, name="Roads", kind="vector", source={}))
    await db_session.flush()

    await db_session.delete(project)
    await db_session.flush()

    remaining = (await db_session.execute(select(Layer))).scalars().all()
    assert remaining == []
```

## Test isolation without truncating

The suite runs against a real PostGIS database (`gis_platform_test`) — most
of what's worth testing here *is* SQL (constraints, cascades, uniqueness),
so a mock session would test nothing. Per-test isolation comes from an
outer transaction that's rolled back after every test, not from truncating
tables or recreating them:

```python
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
```

`db_connection` opens one real transaction per test and always rolls it
back in `finally`, regardless of pass or fail. `db_session` binds an
`AsyncSession` to that *same* connection instead of letting it open its own,
so every query the test issues runs inside that one outer transaction.

The subtlety is `join_transaction_mode="create_savepoint"`. Later tasks'
services call `session.commit()` as part of normal request handling — that's
correct production behavior, and the tests shouldn't have to work around it.
Without `create_savepoint`, a `commit()` inside a test would commit the
outer transaction too, and the rollback in `db_connection`'s `finally` would
have nothing left to roll back. With it, SQLAlchemy commits to a `SAVEPOINT`
instead of the real transaction, and starts a new one immediately after —
`session.commit()` looks and behaves like a real commit from the service's
point of view, but the connection is still inside the outer transaction the
whole time, so the final rollback erases everything regardless of how many
times a test (or the code it called) committed.

The `client` fixture layers `AsyncClient` on top of `db_session`, overriding
the `get_session` FastAPI dependency so a request made through the client
and the assertions made after it share that same connection and transaction:

```python
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

## Migrations

Schema changes go through Alembic, never `Base.metadata.create_all` against
a real database (that's only for the test engine's throwaway schema).

**One-time bootstrap on a fresh database.** `env.py` sets
`version_table_schema=VERSION_SCHEMA` so Alembic's own bookkeeping table
lives inside `gis`, alongside the tables it tracks — but Alembic creates
that bookkeeping table *before* running any migration, so on a database
that has never run a migration, the `gis` schema needs to already exist
(see the README Quickstart for the exact command). The migration's own
`CREATE SCHEMA IF NOT EXISTS "gis"` still runs on every `upgrade head`
after that — it's what makes redeploying onto a database that already has
the schema, or recreating it after a `downgrade base`, work without
this bootstrap step.

Separately, this project's database user happens to be named `gis` — the
same as the metadata schema. Postgres's default `search_path` is
`"$user", public, ...`, so without neutralizing that (`ALTER ROLE gis SET
search_path TO public`, also in the README), every object in `gis` is this
connection's *default* schema, and Postgres reflection reports it as
schema-less. That's invisible for normal queries (this app always
schema-qualifies), but it makes `alembic revision --autogenerate` report a
false-positive drop/recreate of the `layer` → `project` foreign key on
every run, because the model's `Layer.project_id` explicitly targets
`"gis.project.id"` while the reflected, already-migrated table reports no
schema at all for that same reference.

The standing rule for every migration, proven for `0001_initial_schema.py`:

```bash
alembic upgrade head
docker compose exec postgres psql -U gis -d gis_platform -c "\dt gis.*"
alembic downgrade base
alembic upgrade head
```

`\dt gis.*` must list every table the migration created; `downgrade base`
then `upgrade head` must both succeed with no error — a migration that can't
be reversed cleanly isn't done. Then autogenerate must agree there's nothing
left to do:

```bash
alembic revision --autogenerate -m "drift check"
```

The generated file's `upgrade()`/`downgrade()` must both be a bare `pass` —
if Alembic finds something to generate, the migration and the models have
drifted apart, and the fix is to reconcile them (not to accept the
autogenerated file). The drift-check file itself is never committed; it
exists only to prove agreement, then gets deleted.
