# 09 · Editing and Transactions

Every endpoint before this one only read from PostGIS tables the platform
does not own. This chapter is the first time a client can change one: `POST
/layers/{layer_id}/features`, `PATCH /layers/{layer_id}/features/{feature_id}`
and `DELETE /layers/{layer_id}/features/{feature_id}`.

QGIS's own editing model is useful as a contrast, because it makes a choice
this platform deliberately does not repeat. A QGIS edit session buffers
every change — new features, moved vertices, attribute edits, deletions —
entirely in memory on the client, and nothing reaches the database until the
user clicks "Save Edits" (a single `commitChanges()` that either applies the
whole buffer or rejects all of it). That buys offline editing and an
explicit undo/redo stack, at the cost of a client that must reconcile its
buffer against whatever the layer looks like by the time it commits.

This platform commits per request instead: each `POST`/`PATCH`/`DELETE` is
its own transaction, applied or rejected immediately, with the
authoritative row handed back in the response. The buffering QGIS does
client-side is not this task's problem — it belongs to the browser client
(task 21), which can hold pending edits locally and call these endpoints
however it likes (immediately per change, or batched before a "save"
button) without the server's transaction model changing shape either way.

## Three guards

`app/services/edit_service.py` opens with the docstring that is the actual
design of this module, quoted verbatim:

> Three guards stand between a request body and an UPDATE statement:
>
> 1. The column must be in `editable_columns` — not the primary key, not the
>    geometry column, not a generated or identity column.
> 2. The column name must pass `validate_identifier` on the way into SQL.
> 3. The geometry must survive `ST_GeomFromGeoJSON` and `ST_IsValid` before
>    anything is written.
>
> Each request is one transaction, managed by `app.db.session.get_session`
> — this module never calls `session.commit()` or `session.rollback()`. A
> SQL statement that PostgreSQL rejects (a malformed GeoJSON literal, a
> constraint violation) aborts the *database* transaction, though, and
> nothing else in this session can run until that is cleared. Each such
> statement is therefore wrapped in its own `session.begin_nested()`
> (SAVEPOINT): on failure only that SAVEPOINT unwinds, clearing the aborted
> state without touching whatever the request-scoped transaction already
> holds. A plain `session.rollback()` would reach further than that — it
> would discard the transaction the route depends on to see its own prior
> work — so this module never calls it.

Each guard is independently necessary — none of the other two can stand in
for it.

**Guard 1 — the allowlist.** `editable_columns` asks the catalog what
columns actually exist and excludes exactly three kinds: the geometry
column (it has its own typed path), the id column (identity is not user
data), and anything the catalog itself marks non-editable (generated or
identity columns — see `03-postgis-and-dynamic-sql.md`'s `ColumnInfo.editable`).

```python
async def editable_columns(session: AsyncSession, source: PostgisSource) -> set[str]:
    columns = await catalog_repository.list_columns(session, source.schema_name, source.table_name)
    return {
        column.name
        for column in columns
        if column.editable
        and column.name != source.geometry_column
        and column.name != source.id_column
    }
```

The request body is then checked against that set before any SQL is built:

```python
def _reject_unwritable(properties: dict[str, Any], allowed: set[str]) -> None:
    offending = sorted(set(properties) - allowed)
    if offending:
        raise InvalidRequestError(
            "One or more properties are not writable on this layer",
            details={"rejected": offending, "editable": sorted(allowed)},
        )
```

This is the guard that stops `{"properties": {"fid": 99}}` and
`{"properties": {"injected": 1}}` — a column that simply is not in the
allowlist is rejected here, before `app/repositories/feature_repository.py`
ever sees the key. Note that `"injected"` is a perfectly legal SQL
identifier by the grammar in `app/db/identifiers.py` — guard 2 would let it
through untouched. It is guard 1 alone that knows this table has no such
column.

**Guard 2 — the identifier grammar.** Every column name that survives
guard 1 still has to become a fragment of SQL text (`UPDATE ... SET
"population" = :p_0`), and `validate_identifier` (from `app/db/identifiers.py`,
`03-postgis-and-dynamic-sql.md`) is what makes that safe — it accepts only
lowercase ASCII, digits and underscore, and rejects everything else
outright. This is called from `feature_repository.insert_feature` and
`update_feature_row`, one call per key, right where each name is quoted
into the statement.

**Guard 3 — geometry validity.** Column names are one axis of attack; a
malformed or self-intersecting geometry is a different one entirely, and is
checked by asking the database itself — see the next section.

## Why PostGIS validates the geometry

Python has no PostGIS-compatible geometry validator, and building one would
mean maintaining a second implementation of "what is a valid geometry"
alongside the one that actually matters: PostGIS's own, which is the thing
that will store the value and the thing every read from this table will
later trust. Any Python-side check risks disagreeing with storage — either
rejecting something PostGIS would have accepted, or (worse) accepting
something PostGIS's own constraint machinery would not have. `geometry_is_valid`
asks PostGIS directly, with the identical function PostGIS itself would use:

```python
async def geometry_is_valid(session: AsyncSession, geojson: str) -> tuple[bool, str | None]:
    """Ask PostGIS, not Python: it is the thing that will store the geometry."""
    row = (
        (
            await session.execute(
                text(
                    """
                SELECT ST_IsValid(g) AS valid, ST_IsValidReason(g) AS reason
                FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON(:geojson), 4326) AS g) AS parsed
                """
                ),
                {"geojson": geojson},
            )
        )
        .mappings()
        .one()
    )
    return bool(row["valid"]), None if row["valid"] else str(row["reason"])
```

`ST_GeomFromGeoJSON` parses the wire payload; `ST_IsValid` runs the OGC
simple-features validity test (no self-intersections, no duplicate rings,
correctly wound polygons, and so on); `ST_IsValidReason` explains a failure
in human terms. `_validated_geojson` in `edit_service.py` calls this before
`create_feature` or `update_feature` ever attempts an INSERT or UPDATE, and
turns a `False` result into a 422:

```python
async def _validated_geojson(session: AsyncSession, geometry: dict[str, Any] | None) -> str | None:
    if geometry is None:
        return None
    payload = json.dumps(geometry)
    try:
        async with session.begin_nested():
            valid, reason = await feature_repository.geometry_is_valid(session, payload)
    except (DataError, IntegrityError, InternalError) as exc:
        raise InvalidRequestError(
            "Geometry could not be parsed as GeoJSON",
            details={"reason": str(exc.orig)[:300] if exc.orig else None},
        ) from exc
    if not valid:
        raise InvalidRequestError("Geometry is not valid", details={"reason": reason})
    return payload
```

Two failure modes, both handled: a *syntactically* broken payload (`{"type":
"Nonsense", "coordinates": [1, 2]}`) makes `ST_GeomFromGeoJSON` itself raise
at the database level — observed in this codebase as
`sqlalchemy.exc.InternalError` wrapping
`asyncpg.exceptions.InternalServerError: invalid GeoJson representation`,
which is why `InternalError` sits in that `except` tuple alongside
`DataError`/`IntegrityError`. A *geometrically* invalid payload — one that
parses fine but fails the simple-features test — is the `if not valid`
branch instead.

### Worked example: the bow-tie polygon

`tests/test_editing_api.py::test_invalid_geometry_is_rejected` sends a
self-intersecting polygon — two triangles sharing the point (0.5, 0.5),
classic bow-tie shape:

```python
bowtie = {
    "type": "Polygon",
    "coordinates": [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]],
}
```

Running exactly the query `geometry_is_valid` runs, against this payload,
PostGIS returns `valid = false` and
`reason = "Self-intersection[0.5 0.5]"`.

`ST_IsValid` is `false`, and `ST_IsValidReason` names the self-intersection
and gives its coordinates — the exact point where the two triangles cross.
The API turns this into `422 {"error": {"code": "invalid_request",
"message": "Geometry is not valid", "details": {"reason":
"Self-intersection[0.5 0.5]"}}}`. Nothing about this message is invented by
the application; it is PostGIS's own diagnostic, passed through unchanged.

## RETURNING instead of a second SELECT

Every write function ends its statement with a `RETURNING` clause built
from one shared template:

```python
RETURNING_SQL = """
    RETURNING {fid}::text AS fid,
              ST_AsGeoJSON(ST_Transform({geom}, 4326)) AS geometry,
              to_jsonb({tbl}) - :geom_key - :id_key AS properties
"""
```

An `INSERT` or `UPDATE` followed by a separate `SELECT` to fetch the row
the client should see is two round trips to the database and a race: between
the write and the read, a trigger, a `DEFAULT`, a sequence-assigned id, or a
concurrent write from someone else could all change what that second
`SELECT` sees, so the response would describe a row that may no longer
exist in that exact shape. `RETURNING` instead asks Postgres for the
post-write row *as part of the same statement* — same transaction, same
snapshot, one round trip, and provably the row that was actually written
rather than a row fetched moments later. This matters concretely for
`insert_feature`: the client never sends `fid` (it is server-assigned by
the table's `serial` sequence), so `RETURNING "fid"::text AS fid` is the
only way the response can report the id PostGIS just chose. The geometry is
reprojected back to 4326 in the same clause (`ST_AsGeoJSON(ST_Transform(...,
4326))`) for the same reason every read path does — storage SRID is
whatever the table declares; the wire is always 4326 — and `to_jsonb({tbl})
- :geom_key - :id_key` produces `properties` as "every column except the
two already surfaced separately," identical to the read path in
`04-feature-streaming.md`, so a newly imported table with different
attribute columns needs no code change here either.

## Never writable

| Column | Why it is excluded |
| --- | --- |
| The primary key (`fid`, or whatever the layer's `id_column` is) | Identity is not user data — the platform's contract is that this value is server-assigned and stable; letting a client relabel a row's identity would break every other endpoint that references features by id. |
| The geometry column, as an attribute | It has its own typed, validated path (`FeatureWrite.geometry` / `FeaturePatch.geometry`, gated by `_validated_geojson`). Accepting it as a plain string inside `properties` (as `test_cannot_write_the_geometry_column_as_an_attribute` tries with `"geometry": "POINT(0 0)"`) would bypass `ST_IsValid` entirely. |
| Generated or identity columns | `catalog_repository.list_columns` marks these `editable=False` because the database computes their value; a client-supplied value would either be silently overwritten or rejected by Postgres, and either way the platform should not offer the client something it cannot actually control. |

## Transactions

Every request is one transaction, and the boundary is owned entirely by
`app/db/session.py::get_session` (`SessionDep`), not by this module:

```python
async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
```

`edit_service.py` never calls `session.commit()` — consistent with every
other service in this codebase — and, as explained above, does not call
`session.rollback()` either: a bare `rollback()` would unwind the whole
request-scoped transaction, including work this same request already did
(the layer lookup, the catalog check), which is more than a single failed
write should ever have to discard. Instead, each statement that PostgreSQL
could reject runs inside its own `session.begin_nested()` — a SAVEPOINT.
When PostGIS rejects a geometry, the nested block's own `__aexit__` issues
`ROLLBACK TO SAVEPOINT`, which undoes only that statement and clears the
aborted-transaction state, leaving everything else in the session exactly
as it was. A failed edit aborts before any write is attempted at all in the
common case — `_validated_geojson` runs and can raise before either
`insert_feature` or `update_feature_row` is ever called — so "a partially
applied edit is not possible" holds both for the ordinary rejection path
and for the rarer case of a constraint violation surfacing from the
`INSERT`/`UPDATE` itself.

`tests/test_editing_api.py::test_a_rejected_edit_leaves_the_row_unchanged`
is the test for exactly this guarantee — a single `PATCH` that tries to
change `population` *and* supplies a broken geometry in the same request:

```python
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

If the guard order were wrong — properties written before geometry is
validated — this test would catch it directly: `population` would read back
as `1`, not the seeded `21540000`. That is not a hypothetical; reordering
the code to write `population` first and validate geometry second (as a
deliberate check while building this module) makes this exact assertion
fail with `assert 1 == 21540000`. The test is not merely checking that the
`PATCH` returned an error status — it re-reads the row through a completely
independent path (`GET /attributes`, in a separate service module) and
confirms the value PostgreSQL actually holds never moved.

## What is deliberately missing

There is no optimistic concurrency control here — no `If-Match`, no version
column, no comparison against the row a client last read before sending its
edit. Two clients editing the same feature at the same time will silently
overwrite one another; whichever `PATCH` reaches Postgres last wins, and the
first client's change is gone without any signal that it happened.

This is a deliberate omission, not an oversight: optimistic concurrency
needs somewhere to keep a version — a column that increments (or a
timestamp that advances) on every write, checked and compared on the next
write. This platform's editable tables are not owned by it; they are
existing PostGIS tables registered or imported from elsewhere (`03-postgis-and-dynamic-sql.md`,
`02-spatial-data-model.md`), so adding a version column would mean altering
someone else's schema, which is exactly the kind of one-way, invasive
change this platform avoids making to tables it does not own.

If last-write-wins ever becomes a real problem, two paths exist without
requiring a schema change up front:

- **Compare Postgres's own `xmin` system column.** Every row carries a
  hidden `xmin` (the id of the transaction that last wrote it), already
  present on every table with no migration required. A client could send
  back the `xmin` it last read; the `UPDATE`'s `WHERE` clause would include
  `AND xmin = :expected_xmin`, and `update_feature_row` already reports
  `row is None` as "nothing matched" — the same code path currently used
  for "no such feature" would also cover "someone else changed it first,"
  though the two would need distinguishing in the response.
- **An app-owned edit log**, external to the tables being edited: a
  metadata-schema table (alongside `gis.layer`/`gis.project`) recording
  who changed which feature and when, checked before a write is applied.
  More machinery than `xmin`, but it does not require the edited table to
  cooperate at all, and it gives the platform an audit trail as a side
  effect.

Either is a real design decision with its own trade-offs — this task ships
neither, and says so here rather than leaving the gap to be discovered
later as a bug report.
