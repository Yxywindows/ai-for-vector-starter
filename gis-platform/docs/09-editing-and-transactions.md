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
> Each request is one transaction, managed entirely by
> `app.db.session.get_session` -- this module never calls `session.commit()`
> or `session.rollback()`. Every error path below raises immediately after
> the statement that failed, so nothing else runs on this session before the
> request boundary rolls the whole thing back; there is no partial state
> for this module to clean up itself.
>
> A statement PostgreSQL rejects can surface as more than one SQLAlchemy
> exception type. `IntegrityError` covers constraint violations (`NOT NULL`,
> a foreign key) and gets its own message below. Everything else PostgreSQL
> can reject a statement for -- a GeoJSON type PostGIS's parser refuses, a
> geometry whose type doesn't match the column's typmod (a Polygon into a
> `geometry(Point, 4326)` column), a value that doesn't cast to the target
> column's type -- is caught via `DBAPIError`, the common base every
> DBAPI-level error inherits from. This matters concretely with the asyncpg
> dialect: its SQLAlchemy translation table has no entry for `DataError`, so
> SQLSTATE class 22 errors (numeric/text conversion failures, the typmod
> mismatch above) surface as a bare `DBAPIError`, not `DataError` -- catching
> only `(IntegrityError, DataError)`, as an earlier version of this module
> did, leaves that whole class of ordinary, client-triggerable input errors
> unhandled and returning 500.

Each guard is independently necessary — none of the other two can stand in
for it. The three guards are not the whole story, though: they reject
everything they know how to check for in Python, before any SQL runs. What
happens when a request passes all three and PostgreSQL rejects it anyway is
its own section, below ("A statement PostgreSQL rejects").

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
        valid, reason = await feature_repository.geometry_is_valid(session, payload)
    except DBAPIError as exc:
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
`asyncpg.exceptions.InternalServerError: invalid GeoJson representation`.
`InternalError` is a subclass of `DBAPIError`, which is what this `except`
actually names (see "A statement PostgreSQL rejects" below for why). A
*geometrically* invalid payload — one that parses fine but fails the
simple-features test — is the `if not valid` branch instead.

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

## A statement PostgreSQL rejects

`ST_IsValid` only tells the whole story for the geometry column. A request
can pass all three guards — writable columns, legal identifiers, a valid
geometry — and PostgreSQL can still reject the `INSERT`/`UPDATE`/`DELETE`
itself: a `NOT NULL` column with no value supplied, a valid-but-wrong-shaped
geometry (a Polygon posted against a column declared `geometry(Point,
4326)`), a value that doesn't cast to its column's type, a `DELETE` blocked
by a foreign key on a table this platform does not own and so does not
control the constraints of. None of that is this module's business to
predict in Python; it is PostgreSQL's own constraint machinery, and the
only reliable way to know about a rejection is to attempt the statement and
catch what comes back.

What comes back is not one exception type. `create_feature`, `update_feature`
and `delete_feature` each wrap their write in the same two-branch pattern —
shown here for `create_feature`:

```python
    try:
        row = await feature_repository.insert_feature(session, source, geojson, payload.properties)
    except IntegrityError as exc:
        raise InvalidRequestError(
            "Insert violates a table constraint",
            details={"reason": str(exc.orig)[:300] if exc.orig else None},
        ) from exc
    except DBAPIError as exc:
        raise InvalidRequestError(
            "Insert rejected by the database",
            details={"reason": str(exc.orig)[:300] if exc.orig else None},
        ) from exc
```

`IntegrityError` is checked first and gets its own message, for constraint
violations specifically (`NOT NULL`, a foreign key). `DBAPIError` — the
common base every DBAPI-level error inherits from, `IntegrityError`
included — catches everything else. That second branch is not defensive
padding: an earlier version of this module caught only `(IntegrityError,
DataError)`, on the reasonable-looking assumption that those two together
covered "constraint violation" and "bad data." They do not, under the
asyncpg dialect specifically — SQLAlchemy's asyncpg translation table has
no entry for `DataError` at all, so every SQLSTATE class-22 error (numeric
and text conversion failures — exactly the typmod mismatch below) falls
through to a bare `DBAPIError` instead. A square polygon posted against
`test_cities.geometry` (`geometry(Point, 4326)`) demonstrates this
concretely — it is OGC-valid, so `ST_IsValid` accepts it, and the rejection
only happens once PostGIS's typmod check runs at the `INSERT`/`UPDATE`
itself:

```
>>> INSERT INTO gis_data.test_cities (name, geometry) VALUES ('X', <square polygon>)
asyncpg.exceptions.InvalidParameterValueError: Geometry type (Polygon) does not match column type (Point)
-- surfaces as sqlalchemy.exc.DBAPIError, NOT sqlalchemy.exc.DataError
```

With only `(IntegrityError, DataError)` in the `except` tuple, that
`DBAPIError` was uncaught, propagated past every layer of this codebase's
own error handling, and became a bare `500 {"error": {"code":
"internal_error"}}` — for a request that was never anything but an ordinary,
client-triggerable mistake. `tests/test_editing_api.py` has three tests for
this class of failure now: `test_a_not_null_violation_is_a_422_not_a_500`
(an `IntegrityError`, already caught before this fix — kept as coverage for
a branch that previously had none), `test_a_geometry_type_mismatch_is_a_422_not_a_500`
(the `DBAPIError` case above, confirmed to 500 against the old handler
before the fix), and `test_a_foreign_key_restricted_delete_is_a_422_not_a_500`
(`delete_feature` had no `except` at all before this fix — any database
rejection of a `DELETE`, not just a foreign key, was unconditionally a 500).

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

## Keeping the primary-key index usable

`PATCH`/`DELETE` both operate on exactly one feature, found by its id, and
that lookup should cost an index probe, not a scan of the whole table.
Whether it does depends entirely on how the `WHERE` clause is shaped:

```python
def _id_predicate(fid: str, data_type: str, alias: str | None = None) -> str:
    column = f"{alias}.{fid}" if alias else fid
    if data_type in _INTEGER_TYPES:
        return f"{column} = CAST(:fid AS text)::{data_type}"
    return f"{column} = :fid"
```

This module's first version wrote `{fid}::text = :fid` — casting the
*column* to text, so it could compare against `feature_id: str` (every
route takes the id as a string; a URL path segment always is one). That
defeats the primary key's own btree index: a plain index on `fid` is built
on the column's real `integer` values, not their text representation, so a
predicate that runs a function on `fid` before comparing it is a predicate
Postgres cannot answer from that index at all — every single-feature
`PATCH`/`DELETE` was a sequential scan, on a table this platform does not
own and cannot add an index to without altering someone else's schema.
`_id_predicate` casts the *parameter* instead, leaving `fid` bare on the
left of `=` — the same principle `04-feature-streaming.md` documents for
the bbox predicate: transform the one side that is cheap to transform,
never the indexed column.

The double cast — `CAST(:fid AS text)::<type>`, not the more obvious
`CAST(:fid AS integer)` — exists for the same reason the bbox query casts
`:srid` explicitly (`03-postgis-and-dynamic-sql.md`): Postgres's own
parameter-type inference gets the wrong answer if left to guess.
`CAST(:fid AS integer)` makes Postgres infer the *placeholder itself* as
`integer`, and asyncpg then rejects the Python `str` that `feature_id`
actually is (`invalid input for query argument: 'str' object cannot be
interpreted as an integer`) — confirmed against the live database, not
assumed. Casting to `text` first matches what is actually bound, and only
then converts to the column's type. A `text`/`uuid` id column skips the
cast entirely: a bare `=` against a column of known type has no overload to
disambiguate (unlike `ST_Transform`'s two signatures), so Postgres infers
the parameter's type correctly with nothing extra.

### Evidence: the index is actually used

Against a synthetic 200,000-row copy of `test_cities` (`04-feature-streaming.md`'s
own evidence section explains why the 3-row fixture can't demonstrate
this — the planner correctly prefers a sequential scan on a table that
small):

```
EXPLAIN (ANALYZE, COSTS OFF)
UPDATE gis_data.test_cities_big AS "test_cities_big" SET population = 999
WHERE "test_cities_big"."fid" = CAST(:fid AS text)::integer

Update on test_cities_big (actual time=0.119..0.119 rows=0 loops=1)
  ->  Index Scan using test_cities_big_pkey on test_cities_big (actual time=0.009..0.010 rows=1 loops=1)
        Index Cond: (fid = 100000)
Planning Time: 0.189 ms
Execution Time: 0.190 ms
```

against the predicate this module shipped with first:

```
EXPLAIN (ANALYZE, COSTS OFF)
SELECT * FROM gis_data.test_cities_big AS t WHERE t."fid"::text = :fid

Gather (actual time=13.072..22.726 rows=1 loops=1)
  Workers Planned: 1
  Workers Launched: 1
  ->  Parallel Seq Scan on test_cities_big t (actual time=11.177..14.972 rows=0 loops=2)
        Filter: ((fid)::text = '100000'::text)
        Rows Removed by Filter: 100000
Planning Time: 0.140 ms
Execution Time: 22.746 ms
```

`Index Scan using test_cities_big_pkey`, `Index Cond: (fid = 100000)` — the
predicate reaches the primary key's own index directly, at roughly 100x the
speed of the `Parallel Seq Scan` the column-cast version fell back to, and
that gap only widens as the table grows: the index scan's cost barely
depends on table size, the sequential scan's cost is linear in it. No test
in this suite exercises a table large enough to fail if this regressed —
`EXPLAIN` here is the only evidence that would ever catch it.

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

`edit_service.py` never calls `session.commit()` or `session.rollback()` —
consistent with every other service in this codebase. That is a real
constraint, not an accident of how this module happens to be written: every
error path here raises immediately after the statement that failed (`_validated_geojson`
can raise before `insert_feature`/`update_feature_row` is ever called at
all; each `except` block in the previous section raises as soon as the
write itself fails), so nothing else ever runs on the session before the
exception reaches the request boundary above. `get_session` owning the
whole transaction is not just tidy layering, then — it is sufficient,
because this module never needs the session to be usable *after* an error,
only before one.

An earlier version of this module wrapped every risky statement in its own
`session.begin_nested()` (a SAVEPOINT), reasoning that a bare
`session.rollback()` would discard more of the request than a single failed
write should. That reasoning doesn't hold up under scrutiny, though: since
every error path raises immediately, this module was never actually going
to call `session.rollback()` in the first place — a service reaching into
transaction state to protect against a call it makes nowhere in its own
code is solving a problem this module doesn't have. The "poisoned
transaction" the SAVEPOINTs were guarding against was real, but it was a
gap in the *test harness*, not in this service: `tests/conftest.py`'s
`client` fixture originally overrode `get_session` with a bare `yield
db_session` — no commit, no rollback, shared across every request in a
test — so a statement PostgreSQL rejected left that shared session poisoned
for every later request in the same test. The fix belongs there, and that
is where it now lives:

```python
async def _override() -> AsyncIterator[AsyncSession]:
    async with db_session.begin_nested():
        yield db_session
```

Each request gets its own SAVEPOINT — released on success, rolled back to
on exception — mirroring `get_session`'s real commit/rollback contract
without requiring an actual `COMMIT` the outer test transaction can't
afford to allow. This module itself is back to owning no transaction state
at all, which is what the constraint asked for from the start.

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

This is not, despite an earlier draft of this chapter claiming otherwise,
a test of `edit_service.py`'s *own* guard ordering. It was written to be
one — the reasoning was "properties are written before geometry is
validated" would leave `population` at `1`. That was true under an earlier
version of `tests/conftest.py`'s `client` fixture, where a failed request's
writes stayed visible in the shared session because nothing rolled them
back. It stopped being true the moment that fixture started wrapping each
request in its own `session.begin_nested()` (the section above): reordering
`update_feature` to write `population` before validating geometry — checked
directly, by making that exact change and running this exact test — still
passes. The mutated write happens, `_validated_geojson` then raises, the
request boundary (the fixture's SAVEPOINT in tests, `get_session`'s real
rollback in production) unwinds everything done in that request including
the mutated write, and the follow-up `GET` still reads `21540000`. Guard
*order* inside this module is good practice — it avoids attempting a write
Postgres would only reject anyway — but it is not what makes "a rejected
edit leaves the row unchanged" true. The request boundary is what makes
that true, unconditionally, regardless of what order this module's
functions run in.

What this test does prove, correctly: a `PATCH` that both changes an
attribute and supplies a broken geometry leaves the row exactly as it was,
re-read through a completely independent path (`GET /attributes`, in a
separate service module) rather than trusting the `PATCH` response's error
status alone.

That test, like every other test in `tests/test_editing_api.py`, goes
through `conftest.py`'s `client` fixture — the test-only override just
described, not the real `get_session`. Nothing in the suite had ever
exercised the production rollback-on-exception path — `get_session`'s own
`except Exception: await session.rollback(); raise` — through an actual
editing route. `tests/test_session.py::test_an_unhandled_error_after_a_write_rolls_back_that_write`
closes that gap: it builds the real app with no dependency override at all,
registers a real (non-transactional, genuinely committed) scratch table,
calls the real `POST /layers/{id}/features`, and forces a failure that has
nothing to do with the database — a monkeypatched `Feature(...)` raising
`RuntimeError` — *after* `create_feature`'s `INSERT` has already executed.
It then checks row survival through `engine.connect()`, a connection with
no relationship at all to the one the request used, so a `count() == 0`
there is only possible if the request's write was genuinely rolled back at
the database, not merely uncommitted within some still-open session.

`count() == 0` alone still leaves one gap: it reads the same whether the
`INSERT` ran and was rolled back, or `insert_feature` was never reached at
all — a refactor moving `Feature(...)` ahead of it in `create_feature`
would make the test pass vacuously, for the wrong reason. The test closes
that gap too, using a property specific to Postgres: `serial` sequences are
not transactional, so a value `nextval()` hands out during a rolled-back
`INSERT` is never returned. The test primes the table's sequence once,
records its position, runs the monkeypatched request, and asserts the
sequence *advanced* even though the row did not persist — direct evidence
the `INSERT` statement genuinely executed, not just that the final state
looks as if it hadn't. Checked directly: reproducing the "`Feature(...)`
moved ahead of the `INSERT`" refactor makes `count() == 0` pass exactly as
before, but fails this sequence assertion with `assert 1 > 1`.

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

## The client edit buffer

The server side of editing is one request, one transaction. The client side
is deliberately not one edit, one request. `EditQueue` in
`web/src/features/editing/editSession.ts` sits between the map interactions
and the API:

> A QGIS-style edit buffer.
>
> Edits accumulate locally so a user can drag a vertex twenty times without
> twenty PATCHes, and can abandon the whole session. The queue collapses
> redundant work: repeated updates to one feature keep only the last
> geometry, a delete supersedes a pending update, and deleting something
> that was never saved simply removes it from the queue.
>
> On flush, failures stay queued. A geometry the server rejects should not
> silently vanish from the user's pending list.

The three collapse rules are each pinned by a test. Repeated updates keep
only the last geometry; the other two:

```ts
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
```

The last one matters most: a feature that was drawn and then deleted before
ever being saved must produce *zero* requests — sending a create followed by
a delete would briefly materialise a row another user could see.

Why failures stay queued: `flush` runs every operation, collects the
rejections, and puts only the failed operations back. Succeeded work is not
retried; failed work is not forgotten. The user sees "1 edit(s) failed"
with the server's message, still has the edit pending, and can fix or
discard it deliberately. Dropping the failure would mean a rejected
geometry disappears with no trace; blocking on the first failure would hold
hostage the edits the server was happy with.

### Compared with QGIS's edit session

| | QGIS | This platform |
|---|---|---|
| Buffer location | In-process undo stack per layer | `EditQueue` in the browser tab |
| Commit trigger | Toggle editing off / "Save Layer Edits" | The "Save edits" button flushes the queue |
| Conflict handling | Last write wins on commit | Last write wins; no lock, no version check (see "What is deliberately missing") |
| Undo scope | Full multi-step undo/redo within the session | Discard-all only; a saved flush cannot be undone |

The shape is the same — accumulate locally, commit explicitly, abandon
freely — with a much smaller undo story: QGIS can step backwards through
individual edits, while this buffer only offers "discard everything not yet
saved". That is a prototype boundary, not an architectural one; the queue
already holds discrete operations, so per-operation undo would be an
extension of the same structure rather than a rewrite.
