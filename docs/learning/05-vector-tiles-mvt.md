# 05 · Vector Tiles (MVT)

`04-feature-streaming.md` covers `GET /layers/{layer_id}/features` — the
bbox-windowed, honest-about-truncation GeoJSON path. That path exists because
editing needs exact geometry: every coordinate round-trips, nothing is
simplified, nothing is clipped mid-shape. It is the wrong tool for *display*
of a dense layer, though. A road network with a million rows means a million
rows of GeoJSON text shipped to the browser, parsed, and drawn, over and over,
every time the map pans — even though only a screenful of pixels can ever be
visible at once.

This chapter covers the second vector read path: `GET
/layers/{layer_id}/tiles/{z}/{x}/{y}.mvt`, which asks PostGIS to pre-clip and
pre-encode exactly the geometry a single 256×256 tile needs, as a compact
protobuf blob (Mapbox Vector Tile format), and hands that blob back
unmodified so OpenLayers can decode and draw it directly. Tiles are
pre-clipped, pre-simplified to the tile's own resolution, cacheable by URL
(the same `z/x/y` always produces the same bytes for an unchanged layer), and
bounded in size — a tile is never "the whole layer," it is always "this one
256×256 square." GeoJSON is better for editing because it round-trips exact
geometry; tiles are better for display because they never send more geometry
than a screen can show. Both paths exist in this platform, on purpose, backed
by the same table.

## The tile pyramid

Web map tiles are addressed `z/x/y` in the standard XYZ scheme: zoom level
`z` divides the world into `2^z` tiles per axis, and `x`/`y` count tile
columns/rows from the origin at the **top-left** (`0,0` is the northwest
corner, not the southwest — this is XYZ, not TMS). At `z=0` there is exactly
one tile covering the whole world; at `z=1`, four; at `z=10`, `2^10 = 1024`
per axis. `app/services/tile_service.py` enforces this shape before any SQL
runs, and nowhere else re-derives it — Task 12's raster tile endpoint reuses
this function unchanged:

```python
MAX_ZOOM = 24


def validate_tile_coords(z: int, x: int, y: int) -> None:
    if not 0 <= z <= MAX_ZOOM:
        raise InvalidRequestError("Zoom out of range", details={"z": z, "maxZoom": MAX_ZOOM})
    span = 1 << z
    if not (0 <= x < span and 0 <= y < span):
        raise InvalidRequestError(
            "Tile coordinate out of range for this zoom",
            details={"z": z, "x": x, "y": y, "tilesPerAxis": span},
        )
```

`tests/test_tile_coords.py` is the parametrised test that pins this shape
down — every accepted coordinate is actually inside the pyramid for its zoom,
every rejected one is one step outside it:

```python
@pytest.mark.parametrize(("z", "x", "y"), [(0, 0, 0), (1, 1, 1), (10, 1023, 0), (24, 0, 0)])
def test_accepts_coordinates_inside_the_pyramid(z: int, x: int, y: int) -> None:
    validate_tile_coords(z, x, y)  # must not raise


@pytest.mark.parametrize(
    ("z", "x", "y"),
    [
        (-1, 0, 0),
        (25, 0, 0),
        (0, 1, 0),  # z0 has exactly one tile
        (0, 0, 1),
        (1, 2, 0),
        (1, 0, 2),
        (10, -1, 0),
        (10, 0, -1),
    ],
)
def test_rejects_coordinates_outside_the_pyramid(z: int, x: int, y: int) -> None:
    with pytest.raises(InvalidRequestError):
        validate_tile_coords(z, x, y)
```

`(10, 1023, 0)` is accepted because `1023 == 2**10 - 1`, the last valid
column at that zoom; `(0, 1, 0)` is rejected because `z=0` has exactly one
tile, so any nonzero `x` or `y` is already outside the pyramid. `z=24` is
accepted, `z=25` is not — `MAX_ZOOM` is the boundary, not a soft cap.

## `ST_TileEnvelope` and `ST_AsMVTGeom`

`app/repositories/tile_repository.py` builds one CTE pipeline per tile
request:

```sql
WITH bounds AS (
    SELECT ST_TileEnvelope(:z, :x, :y) AS envelope_3857
),
clipped AS (
    SELECT ST_AsMVTGeom(
               ST_Transform(t."geometry", 3857),
               bounds.envelope_3857,
               :extent, :buffer, true
           ) AS geom,
           t."fid"::text AS fid
           , t."name", t."population"
    FROM "gis_data"."test_cities" AS t, bounds
    WHERE t."geometry" && ST_Transform(bounds.envelope_3857, CAST(:srid AS integer))
)
SELECT COALESCE(ST_AsMVT(clipped, :layer_name, :extent, 'geom'), ''::bytea)
FROM clipped
WHERE geom IS NOT NULL
```

`ST_TileEnvelope(z, x, y)` computes the tile's bounding box directly in
**EPSG:3857** (Web Mercator) — the CRS every MVT tile is defined in,
regardless of the table's storage SRID. `ST_AsMVTGeom(geom, bounds, extent,
buffer, clip)` then does the actual per-feature work, and each argument earns
its place:

- **`geom`** — the row's geometry, already reprojected to 3857 (`ST_Transform(t."geometry", 3857)`), since `ST_AsMVTGeom` expects both the geometry and the bounds it's clipped against in the same CRS.
- **`bounds`** — the tile's own envelope, so clipping happens against exactly this tile's square, not the whole table's extent.
- **`extent = 4096`** (`MVT_EXTENT`) — the internal resolution the tile's coordinates are quantized to. MVT geometry isn't stored in map units; it's stored as integers from `0` to `extent` within the tile square, so `4096` is how many discrete positions a coordinate can land on inside one tile — enough resolution that quantization error is invisible on screen, small enough to keep the encoded tile compact.
- **`buffer = 64`** (`MVT_BUFFER`) — extra margin, in the same `extent` units, added *outside* the tile's four edges before clipping. Without it, a point icon or line whose true position straddles a tile seam gets clipped exactly at the boundary, and renders as half a symbol on each of the two adjacent tiles. The buffer keeps enough of the neighbouring geometry that OpenLayers can draw it whole even where it crosses into the next tile's territory.
- **`clip = true`** — actually cut geometry down to `bounds` (expanded by `buffer`) rather than passing whole features through. Without this a feature that merely touches the tile would be encoded in full, defeating the entire point of per-tile bounding.

## Why columns, not jsonb

`app/repositories/tile_repository.py`'s module docstring, quoted verbatim:

> Attribute columns are expanded explicitly rather than passed as one jsonb
> value, because `ST_AsMVT` maps each *column* to an MVT attribute; a single
> jsonb column would arrive in the client as one opaque string.

and the code that expands them, using the same `validate_identifier` gate
every other dynamic-SQL path in this codebase uses (`03-postgis-and-dynamic-sql.md`):

```python
attribute_select = "".join(
    f", t.{quote(validate_identifier(column))}"
    for column in columns
    if column != source.id_column
)
```

`columns` comes from `feature_repository.attribute_columns` (Task 8) — every
column on the table except the geometry column — so a newly imported table
needs no code change here to have all its attributes readable in a tile,
exactly as the GeoJSON path already works. `ST_AsMVT` treats every column in
the row type it's handed (other than the ones named as `geom_name` and,
optionally, `feature_id_name`) as a first-class MVT attribute — a `jsonb`
blob passed as a single column, by contrast, would be a single MVT attribute
whose value is a JSON-text string, opaque to anything that isn't specifically
written to parse it back apart. `id_column` (`fid`) is selected and carried
through the same way — as a plain `::text` attribute alongside `name` and
`population` — rather than as `ST_AsMVT`'s optional `feature_id_name`
argument. That argument became a real dead end during implementation: it
requires the source column to be `int2`/`int4`/`int8`. Passing the id
straight through as intended (`t."fid"::text AS fid`, named as
`feature_id_name`) fails against live PostGIS with
`mvt_agg_transfn: Could not find column 'fid' of integer type` the moment the
column is text-typed — and `id_column` is not guaranteed to be an integer for
every PostGIS layer (a text or UUID primary key is equally valid per
`PostgisSource`). So `fid` rides as an ordinary attribute instead, identical
treatment to every other column, and still enough for the frontend to
identify a clicked feature.

## Still index-driven

```sql
WHERE t."geometry" && ST_Transform(bounds.envelope_3857, CAST(:srid AS integer))
```

is the same trick as `04-feature-streaming.md`'s bbox query, applied to a
tile instead of an arbitrary viewport rectangle: the predicate transforms the
*envelope* into the table's storage SRID, and leaves `t.{geom}` untouched, so
the GIST index built on that exact column can answer `&&` directly. Writing
`ST_Transform(t.{geom}, 3857) && bounds.envelope` instead — transforming the
geometry side — would force Postgres to compute `ST_Transform` for every row
in the table before it could even test the box overlap, making the index
unusable. `CAST(:srid AS integer)` is required for the same reason
`04-feature-streaming.md` documents it: `ST_Transform` is overloaded on
`(geometry, integer)` and `(geometry, text)`, and a bare `:srid` bind lets
asyncpg's own parameter-type inference resolve the wrong overload.

### Evidence: the index is actually used

The seeded 3-row `gis_data.test_cities` fixture is too small for the planner
to ever prefer an index over a sequential scan (correctly — scanning 3 rows
is cheaper than an index probe). Against a synthetic 200,000-row table built
for this check (`gis_data.test_cities_big_mvt`, dropped again immediately
after), the shipped predicate produces an index scan:

```
EXPLAIN (ANALYZE, COSTS OFF)
-- ST_TileEnvelope(6, 32, 32) as the bounds, correct form:
-- WHERE t.geometry && ST_Transform(bounds.envelope_3857, CAST(4326 AS integer))

Aggregate (actual time=1.623..1.624 rows=1 loops=1)
  ->  Bitmap Heap Scan on test_cities_big_mvt t (actual time=0.665..1.332 rows=95 loops=1)
        Recheck Cond: (geometry && '0103...'::geometry)
        Filter: (st_asmvtgeom(st_transform(geometry, 3857), 'BOX(...)'::box2d, 4096, 64, true) IS NOT NULL)
        Heap Blocks: exact=95
        ->  Bitmap Index Scan on ix_test_cities_big_mvt_geometry (actual time=0.261..0.261 rows=95 loops=1)
              Index Cond: (geometry && '0103...'::geometry)
Planning Time: 14.187 ms
Execution Time: 1.767 ms
```

`Bitmap Index Scan on ix_test_cities_big_mvt_geometry` is the GIST index
answering `Index Cond: (geometry && ...)` directly — no sequential scan, no
per-row `ST_Transform`. Swapping in the wrong form of the predicate — `WHERE
ST_Transform(t.geometry, 3857) && bounds.envelope_3857`, transforming the
geometry column instead of the envelope — against the exact same table and
tile confirms what breaks:

```
Finalize Aggregate (actual time=254.475..261.167 rows=1 loops=1)
  ->  Gather (actual time=254.266..260.961 rows=2 loops=1)
        Workers Planned: 1
        Workers Launched: 1
        ->  Partial Aggregate (actual time=239.624..239.625 rows=1 loops=2)
              ->  Parallel Seq Scan on test_cities_big_mvt t (actual time=182.765..239.315 rows=48 loops=2)
                    Filter: ((st_transform(geometry, 3857) && '0103...'::geometry) AND (st_asmvtgeom(...) IS NOT NULL))
                    Rows Removed by Filter: 99952
Planning Time: 7.583 ms
Execution Time: 280.643 ms
```

Both forms return the same tile; the wrong one costs a `Parallel Seq Scan`
over all 200,000 rows and is roughly 160× slower (280ms vs 1.8ms) on this
table. Neither query errors, neither test in `test_vector_tiles_api.py`
distinguishes them — the difference is purely in the `EXPLAIN` plan, which is
exactly why the predicate's shape matters more than whether the tests pass.

## Caching

```python
def tile_etag(layer: Layer, z: int, x: int, y: int) -> str:
    """Changes whenever the layer row changes, so a style or rename busts the cache."""
    seed = f"{layer.id}:{layer.updated_at.isoformat()}:{z}/{x}/{y}"
    return f'W/"{hashlib.sha256(seed.encode()).hexdigest()[:32]}"'
```

The ETag is seeded from `layer.updated_at` — the `Layer` model's `onupdate=
func.now()` column — rather than from the tile's own content, so it costs
nothing to compute: no need to render the tile just to find out whether it
changed. It is marked **weak** (`W/"..."`) because it is *not* a
byte-for-byte content hash — it asserts "this tile is semantically
equivalent to the last one for this layer/coordinate," which holds as long as
neither the layer row nor its underlying table changed, not "these exact
bytes are reproduced." Renaming a layer or changing its style bumps
`updated_at`, which changes every tile's ETag for that layer in one stroke,
without touching a single cached tile explicitly. The route compares the
incoming `If-None-Match` header against the freshly computed ETag and returns
`304 Not Modified` — with the ETag header repeated, no body — on a match, so
a client that already has the current tile never re-downloads it:

```python
if request.headers.get("if-none-match") == etag:
    return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers={"ETag": etag})
```

`Cache-Control: public, max-age=60` is deliberately short. A long `max-age`
would let a browser or intermediate cache serve a stale tile for hours after
a layer's style or data changed, with no way to force a refresh short of a
hard reload; 60 seconds bounds how long a rename or restyle takes to become
visible almost everywhere, while still meaningfully reducing repeat requests
during normal panning and zooming within that window. The ETag/`304` path
handles the common case (unchanged tile, revalidated cheaply); the short
`max-age` bounds the worst case (changed tile, cache not yet revalidated).

## Empty tiles

`render_mvt` returns `b""` — literally zero bytes — when no feature survives
the tile's `WHERE` clause and clip: with zero rows reaching the aggregate,
`ST_AsMVT` itself already returns a zero-length `bytea`, confirmed directly
against the live database (`COALESCE(..., ''::bytea)` is a defensive
fallback, not the thing actually firing). The route treats that as `204 No
Content` rather than a `200` with an empty-but-technically-valid body:

```python
headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL}
if not blob:
    return Response(status_code=status.HTTP_204_NO_CONTENT, headers=headers)
return Response(content=blob, media_type=MVT_MEDIA_TYPE, headers=headers)
```

`204` lets OpenLayers treat the response as "nothing here" from the HTTP
layer alone, without ever attempting to protobuf-decode a body — a `200`
with a zero-length (or, on some PostGIS versions, header-only) MVT blob would
have to be handed to the protobuf decoder to discover it carries no
features, for no benefit: the outcome ("draw nothing for this tile") is
identical either way, and deciding it from the status code is strictly
cheaper and cannot be misread as a decode failure.
