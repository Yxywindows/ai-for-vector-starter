# 04 · Feature Streaming

`SELECT * FROM roads` on a national road network is a browser tab that dies.
A vector layer backing a web map can hold hundreds of thousands or millions
of rows; a map viewport can only ever show the handful of features currently
on screen. Every feature-reading endpoint in this codebase therefore starts
from the same constraint: never hand the client more than it asked to see,
and never lie about having done so. This chapter covers the read path —
`GET /layers/{layer_id}/features?bbox=&limit=` — that turns "what's in this
viewport" into bounded, honest GeoJSON.

## Windowing by viewport

`app/repositories/feature_repository.py` is the only place that runs SQL
against an arbitrary layer's table for this endpoint:

```python
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
                  ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326), CAST(:srid AS integer)
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

`geom`, `fid` and `table` are the only interpolated fragments, and each has
already been through `quote`/`qualified` (gate one, `03-postgis-and-dynamic-sql.md`)
before this function is ever reached — `feature_service.get_features` calls
`catalog_service.verify_source` first, so by the time this SQL runs, the
schema, table, geometry column and id column are all confirmed to exist
(gate two). Everything that varies per request — the bbox corners, the
table's SRID, the two JSONB keys to strip, the row cap — is a bind
parameter, never string-interpolated.

Three things happen in the `SELECT` list. `t.{fid}::text AS fid` casts
whatever the primary key's native type is (here, `serial`/`integer`) to text,
so `Feature.id` is always a string regardless of the underlying column type.
`ST_AsGeoJSON(ST_Transform(t.{geom}, 4326))` produces the geometry as GeoJSON
text directly in Postgres, reprojected to the wire CRS. `to_jsonb(t) -
:geom_key - :id_key` takes the *entire row* as a JSON object and subtracts
the geometry and id keys — so `properties` is "every other column," and a
newly imported table with different attribute columns needs no code change
here to be readable. `json.loads(row["geometry"])` and `dict(row["properties"]
or {})` turn the driver-level values back into Python before they're handed
to the `Feature` model.

## Why `&&` and not `ST_Intersects`

From the module docstring, quoted verbatim because it is the reasoning, not
a paraphrase of it:

> Two deliberate choices:
>
> - `&&` (bounding-box overlap) rather than `ST_Intersects`. A viewport query
>   wants "might be visible", and `&&` is answered directly from the GIST
>   index without an exact geometry test. Fetching a handful of extra features
>   at the tile edge costs far less than an exact intersection over the table.
> - The envelope is transformed into the table's SRID, not the geometry into
>   4326. Transforming the geometry would make the index unusable.

A GIST index over a geometry column stores each row's *bounding box*, not
its exact shape. `&&` ("do these two bounding boxes overlap?") is exactly
the question the index can answer without ever touching the row's real
geometry — it's an index probe, full stop. `ST_Intersects` asks a stricter
question — "do these two shapes actually overlap?" — which Postgres answers
by using the same index to find *candidate* rows (via `&&` internally) and
then running an exact, comparatively expensive geometry test against each
candidate's real coordinates to throw out false positives. For a map
viewport, that exactness buys nothing: a road whose bounding box clips the
corner of the visible extent but whose actual line geometry passes just
outside it is a rendering non-issue, not a correctness bug — OpenLayers
either draws slightly outside the viewport (harmless) or the feature gets
cached client-side for the next pan (useful). Paying for the exact test on
every request, over every candidate row, to avoid a cosmetic non-problem is
the wrong trade for an interactive read path.

## Transform the envelope, not the column

The single most common performance mistake in a PostGIS viewport query is
transforming the wrong side of the `&&`:

```sql
-- Wrong: transforms every row's geometry to compare against the envelope.
-- The GIST index stores boxes in the table's native SRID; ST_Transform(t.geom, 4326)
-- produces a *new* geometry that isn't in the index, so Postgres cannot use
-- it to prune rows — it must fall back to computing ST_Transform for every
-- row in the table before it can even test the box overlap.
WHERE ST_Transform(t.geom, 4326) && ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326)

-- Right: transforms the (one) envelope into the table's SRID instead.
-- t.geom on the left is untouched, so the GIST index -- built on exactly
-- that column, in exactly that SRID -- can be probed directly.
WHERE t.geom && ST_Transform(ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326), :srid)
```

The shipped query is the second form: `t.{geom}` is never wrapped in a
function, so the planner can use the GIST index built on that exact column.
`ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326)` builds the viewport
rectangle once, in 4326 (the wire CRS the bbox parameter always arrives in),
and `ST_Transform(..., CAST(:srid AS integer))` reprojects that *one*
rectangle into the table's storage SRID — an O(1) cost paid once per
request, versus reprojecting every candidate row's geometry, which an index
can never speed up because the transformed value doesn't exist until
runtime. (The `CAST(:srid AS integer)` — rather than a bare `:srid` — exists
because `ST_Transform` is overloaded on `(geometry, integer)` *and*
`(geometry, text)`; without an explicit cast, Postgres's own parameter-type
inference for that bind position resolved the wrong overload, and asyncpg
rejected the value at execution time with `invalid input for query
argument: expected str, got int`. The cast makes the intended overload
unambiguous.)

### Evidence: the index is actually used

Against a synthetic 200,000-row version of the seeded table (the fixture's 3
rows are too few for the planner to ever prefer an index over a sequential
scan — correctly, since scanning 3 rows is cheaper than an index probe plus
lookup):

```
EXPLAIN (ANALYZE, COSTS OFF)
SELECT t."fid"::text AS fid, ST_AsGeoJSON(ST_Transform(t."geometry", 4326)) AS geometry,
       to_jsonb(t) - 'geometry' - 'fid' AS properties
FROM gis_data.test_cities_big AS t
WHERE t."geometry" && ST_Transform(ST_MakeEnvelope(90, 29, 92, 30, 4326), CAST(4326 AS integer))
ORDER BY t."fid" LIMIT 2001;

 Limit (actual time=0.779..0.784 rows=8 loops=1)
   ->  Result (actual time=0.778..0.783 rows=8 loops=1)
         ->  Sort (actual time=0.776..0.777 rows=8 loops=1)
               Sort Key: fid
               Sort Method: quicksort  Memory: 26kB
               ->  Bitmap Heap Scan on test_cities_big t (actual time=0.568..0.769 rows=8 loops=1)
                     Recheck Cond: (geometry && '0103...'::geometry)
                     Heap Blocks: exact=8
                     ->  Bitmap Index Scan on ix_test_cities_big_geometry (actual time=0.165..0.165 rows=8 loops=1)
                           Index Cond: (geometry && '0103...'::geometry)
 Planning Time: 0.277 ms
 Execution Time: 0.823 ms
```

`Bitmap Index Scan on ix_test_cities_big_geometry` is the GIST index being
used to find candidate rows directly from `Index Cond: (geometry && ...)` —
no sequential scan, no per-row `ST_Transform`. On the actual 3-row
`gis_data.test_cities` fixture, forcing the planner off its default choice
(`SET enable_seqscan = off`) confirms the *same query* is structurally able
to use the same index:

```
 Limit (actual time=1.299..1.300 rows=1 loops=1)
   ->  Result (actual time=1.297..1.298 rows=1 loops=1)
         ->  Sort (actual time=1.293..1.294 rows=1 loops=1)
               Sort Key: fid
               ->  Index Scan using ix_test_cities_geometry on test_cities t (actual time=1.275..1.277 rows=1 loops=1)
                     Index Cond: (geometry && '0103...'::geometry)
```

The planner's ordinary choice of a sequential scan on 3 rows is correct, not
a regression — Postgres always prefers a seq scan when a table is small
enough that reading it whole is cheaper than the index machinery. The point
of both plans together is that the query is index-shaped: it never wraps
`t.geometry` in a function, so nothing stops the planner from choosing the
index the moment the table is large enough for that choice to pay off — which
is exactly the 200,000-row case above.

## Detecting truncation with `LIMIT n+1`

```python
"limit": limit + 1,  # one extra row is how truncation is detected
```

and in `app/services/feature_service.py`:

```python
effective = clamp_limit(limit)
rows = await feature_repository.read_in_bbox(session, source, bbox, effective)
truncated = len(rows) > effective
visible = rows[:effective]
```

Asking Postgres for `limit + 1` rows and then checking whether the extra one
came back is a single query, O(limit) in the rows Postgres has to touch to
satisfy the `LIMIT` — it stops scanning as soon as it has enough matches (or
exhausts the index). A `COUNT(*)` alternative — run the same `WHERE` clause
twice, once for rows and once for a count — would double the query cost
*and* still be a second full evaluation of the bbox predicate over
potentially the entire matching set, exactly the unbounded scan this
endpoint exists to avoid. `LIMIT n+1` answers "were there more?" with the
same query that already had to run.

The alternative to reporting truncation at all — silently returning
`effective` rows and saying nothing — is worse than either query strategy.
The docstring in `app/schemas/feature.py` states the reasoning directly:

> `truncated` is deliberately part of the response, not a header: a client
> that silently receives 2000 of 200000 features and draws them as if they
> were the whole layer is lying to its user. QGIS shows a feature-limit
> warning; so does this.

A map that quietly drops 99% of a layer's features and renders the rest as
if they were everything is worse than an error — it looks correct while
being wrong. `truncated: bool` in the response body forces every client
(this platform's own frontend, task 18's byte budget, or a third party) to
notice and decide what to do about it — zoom in, tell the user, page further
— rather than finding out by miscounting.

## The cap is the server's, not the client's

```python
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
```

against `Settings.feature_bbox_limit` in `app/core/config.py`:

```python
    # Memory guard rails
    feature_bbox_limit: int = 2000
```

A client may ask for fewer features than the cap — a mobile client
narrowing its own budget, say — but never more: `clamp_limit` raises
`InvalidRequestError` rather than silently clamping an over-cap request down
to the server maximum, because a client that thinks it received the 500,000
features it asked for (when it was actually capped to 2000) is exactly the
silent-truncation failure this whole endpoint exists to prevent — asking for
too much has to be visibly rejected, in the error envelope, not quietly
downgraded. `clamp_limit` is deliberately a plain function rather than a
FastAPI `Query(le=...)` validator: `Query(le=...)` would produce FastAPI's
own `RequestValidationError` shape, not this codebase's `{"error": {"code":
"invalid_request", ...}}` envelope, so `limit` is declared on the route as
`Query(default=None, ge=1)` — a floor, not a ceiling — and the ceiling is
enforced here, where it can raise the right error type.

## This is memory layer 2 of 3

Bounding a single bbox query's row count is necessary but not sufficient:
nothing here stops a client from panning across a large layer thousands of
times and, without any per-request violation, still working the server or
the browser harder than either can sustain. This chapter's cap — capping
*this endpoint's* row count per request and being honest via `truncated`
when it bites — is layer 2 of the platform's three independent memory
guards, detailed together in `07-memory-management.md`: layer 1 is the
server-side dataset pool (task 11) that bounds how many open raster/vector
resources the backend holds at once; layer 3 is the browser's own byte
budget (task 18) that bounds how much GeoJSON the frontend keeps resident
regardless of how many bounded, honest responses like this one it has
accumulated. Each layer bounds a different resource at a different point in
the pipeline; none of them assumes the others will catch what it misses.
