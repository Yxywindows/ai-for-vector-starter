# 07 · Memory Management

A GIS leaks memory in three distinct places, not one. The server can hold
too many open raster/vector dataset handles at once. A single feature or
tile request can, if unbounded, try to hand back an entire table's worth of
geometry. And a browser tab that never forgets anything it has ever fetched
grows without limit the longer a session runs. These are three different
resources, owned by three different pieces of the system, and a single
global "cache size" setting would not fix any of them — a raster pool limit
does nothing for an unbounded feature query, and a bbox row cap does
nothing for a browser that never evicts old tiles. Each layer needs its own
bound, enforced where that resource actually lives. This chapter is where
all three are drawn together.

## Layer 1 — server dataset handles

`app/resources/dataset_pool.py`'s `DatasetPool`, quoted in full because
every sentence of it is a real constraint this task's own bug-hunting
confirmed, not decoration:

```python
"""An async LRU pool of expensive, non-thread-safe dataset handles.

Opening a GeoTIFF is not free: GDAL parses the header, the internal tiling
scheme and the overview table. At one open per tile request a raster layer
would spend most of its time in `open()`. The pool keeps handles alive
between requests, bounded two ways — `max_open` (how many at once) and
`idle_ttl` (how long an unused one may linger).

Access is EXCLUSIVE per key. A rasterio dataset is not thread-safe, and
tile reads run on worker threads, so two concurrent reads of the same file
must serialise. Different files never block each other. The trade-off is
deliberate: correctness over per-file concurrency. Scaling one file across
cores would need N handles per key, which is future work.

Every handle also gets its own dedicated single-worker thread, used for
*both* its open and its close, and for nothing else. This is not a
generic thread-pool nicety: rasterio ties a dataset's GDAL environment to
the OS thread that opened it (confirmed empirically -- opening on one
thread and closing on another raises `rasterio.errors.EnvError: No GDAL
environment exists`), and a shared, reused worker pool such as
`anyio.to_thread.run_sync` cannot guarantee a handle's open and its later
close land on the same thread once there is real concurrent activity. A
one-thread-per-entry executor makes that guarantee explicit rather than
accidental.

Different keys' OPENS run fully in parallel, each on its own thread and
outside `self._guard` (see `_checkout`) -- a slow or network-backed open
for one key never delays another key's checkout. Closes do not have that
property yet: `_close_entry` (used by `_enforce_capacity`, `evict_idle`
and `close_all`) and `_close_losing_handle` (used by `_checkout`'s
same-key-race path) are both awaited while `self._guard` is held, so
closes are still serialised against each other and against every other
key's checkout. This matters less in practice than it would for opens --
a close has no header/tiling/overview parsing to do -- but it is a real,
known asymmetry, not a fixed one. Extending the guard-release this pool
already gives opens to closes as well is future work.
"""
```

The distinction in that last paragraph is not academic: `_checkout`'s own
same-key-race path (`_close_losing_handle`) runs on exactly the path Step
4b introduced, under exactly the guard Step 4b was written to stop opens
from blocking on. Opens got the fix; closes did not, on purpose, because
they cost far less to serialise.

and its live counter:

```python
    def stats(self) -> PoolStats:
        return PoolStats(
            open_handles=len(self._entries),
            max_open=self._max_open,
            idle_ttl_seconds=self._idle_ttl,
            hits=self._hits,
            misses=self._misses,
            evictions=self._evictions,
            keys=list(self._entries.keys()),
        )
```

`max_open` and `idle_ttl` bound two different things. `max_open` bounds
*concurrency*: however many distinct rasters are actively being requested
right now, the pool never holds open more than `max_open` of them at once —
past that, the least-recently-used idle entry is evicted to make room.
`idle_ttl` bounds *staleness*: a handle nobody has touched in `idle_ttl`
seconds is closed even if the pool is nowhere near `max_open`, so a raster
that was popular an hour ago does not sit open forever on the strength of
one old request. Neither setting alone is enough — `max_open` alone would
keep a cold handle open indefinitely as long as nothing forced it out;
`idle_ttl` alone would let a sudden burst of distinct rasters open
unboundedly many handles before any of them go idle long enough to evict.

An in-use handle is never evicted by either mechanism — `_enforce_capacity`
explicitly skips any entry with `in_use > 0`, and `evict_idle` only
considers entries with `in_use == 0`. Task 11's test for exactly this,
still passing unchanged:

```python
async def test_a_handle_in_use_is_never_closed_by_eviction() -> None:
    pool, _opened, closed, _clock = make_pool(max_open=1)

    async def hold() -> None:
        async with pool.acquire("held"):
            await asyncio.sleep(0.05)

    holder = asyncio.create_task(hold())
    await asyncio.sleep(0.01)
    async with pool.acquire("other"):
        pass
    await holder
    assert "held" not in closed or closed.index("held") > 0
```

With `max_open=1`, acquiring `"other"` while `"held"` is still in flight
would, without this guarantee, evict the handle a concurrent request is
actively reading from — closing a file out from under an in-progress read.
The pool accepts going one entry over `max_open` for a moment instead.

## Layer 2 — the wire

`04-feature-streaming.md` covers this in full; the short version: a bbox
feature query can match far more rows than any viewport can usefully show,
so `GET /layers/{layer_id}/features` caps how many it returns, and reports
honestly whenever it had to cut the response short rather than silently
returning a partial result that looks complete. The cap and the honesty are
both server-side and both mandatory — a client cannot opt out of either.

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

```python
    truncated: bool = Field(
        description="True when more features intersect the bbox than the cap allowed"
    )
```

The principle this enforces: the server never sends an unbounded result
set, and never hides that it truncated one. `clamp_limit` is the bound;
`truncated` is the honesty — a client that silently receives 2000 of
200,000 features and renders them as if they were the whole layer is lying
to whoever is looking at the map, so the response says so instead of
staying quiet about it.

## Layer 3 — the browser

Layers 1 and 2 bound what the *server* holds and sends. Neither one stops a
browser tab from accumulating tiles and feature payloads across an entire
session, panning and zooming its way to holding far more decoded imagery
and GeoJSON in memory than any one viewport needs at once. That bound is
the browser's own: `LayerMemoryManager` in
`web/src/map/memory/LayerMemoryManager.ts`. Its docstring is the design:

> Memory layer 3 of 3: the browser.
>
> Every tile and every feature payload is weighed on arrival and charged to
> the layer that asked for it. When the total crosses the budget, the least
> recently used layer's cached data is dropped — `onEvict` clears the OL
> source, so the bytes are actually released rather than merely uncounted.
>
> Two things are never evicted: a pinned layer (the one being edited or
> inspected) and the most recently touched layer when it alone exceeds the
> whole budget. Without the second rule a single layer larger than the whole
> budget would be cleared and immediately refetched, forever.

The shape is deliberately the same one Layer 1 already uses server-side (a
bounded, attributed, LRU-evicting cache with an exemption for what is
actively in use) — the browser needs the same discipline the server already
has, for the same reason.

### The two never-evict rules

Pinning is the obvious one: the layer the user is editing or inspecting is
exempt, because clearing it mid-edit would throw away the very features the
edit buffer refers to. The second rule is subtler, and it exists for the
pathological case where the most recently used layer is *by itself* bigger
than the whole budget. Evicting it would gain nothing durable — OpenLayers
would refetch it on the next render, it would blow the budget again, and the
manager would clear it again, forever. The test pins the behaviour down:

```ts
it('never evicts the most recently touched layer, even unpinned', () => {
  const manager = makeManager(100)
  manager.register('a', vi.fn())
  now = 1
  manager.record('a', 900)
  expect(manager.enforce()).toEqual([])
})
```

The guard is deliberately narrow: when the newest layer fits within the
budget, it is an ordinary eviction candidate like any other — protecting it
unconditionally would let one pinned layer plus one recent layer hold the
whole budget hostage.

### Measuring what the browser actually downloaded

Byte counts are only observable if the client does its own fetching. The
default OpenLayers image-tile loader sets `img.src = url` and lets the
browser fetch the image internally — no JavaScript ever sees the response
size. So the instrumented loader fetches the tile itself, weighs the blob,
and only then hands it to the `<img>` via an object URL:

```ts
export function instrumentTileSource(
  source: XYZ,
  layerId: string,
  manager: LayerMemoryManager,
): void {
  source.setTileLoadFunction((tile, src) => {
    const image = (tile as ImageTile).getImage() as HTMLImageElement
    fetch(src)
      .then((response) => (response.ok ? response.blob() : Promise.reject(response.status)))
      .then((blob) => {
        manager.record(layerId, blob.size)
        const objectUrl = URL.createObjectURL(blob)
        image.onload = () => URL.revokeObjectURL(objectUrl)
        image.onerror = () => URL.revokeObjectURL(objectUrl)
        image.src = objectUrl
      })
      .catch(() => {
        // A 204 (empty tile) or a network failure: leave the tile blank.
        image.src = ''
      })
  })
}
```

MVT tiles get the same treatment (`instrumentVectorTileSource` measures the
protobuf's `byteLength` before handing it to the format), and bbox feature
payloads are weighed in the loader that fetched them (`onFeatureBytes`
reports `JSON.stringify(collection).length`).

### Eviction must free bytes, not just stop counting them

Each layer registers an `onEvict` callback that clears the actual OL source
cache, chosen per source kind in `layerFactory.ts`:

```ts
// tile sources (raster XYZ and basemaps): drop the tile cache, reload lazily
deps.memory.register(layer.id, () => tileSource.refresh())
// MVT: drop the loaded tiles
deps.memory.register(layer.id, () => vectorTileSource.clear())
// PostGIS vector: drop features without firing per-feature remove events
deps.memory.register(layer.id, () => vectorSource.clear(true))
```

`refresh()` on a tile source empties its internal tile cache and refetches
only what the current viewport still needs; `clear(true)` drops a vector
source's features in one batch. Without these callbacks the manager would
zero its ledger while the browser kept every decoded tile alive — the
accounting would look healthy precisely when it had stopped being true.

## Observability

The two server layers are visible through one endpoint, `GET
/api/v1/system/memory`; the browser layer reports alongside it in the
client's memory panel, which polls this endpoint and renders both ledgers
side by side:

```json
{
  "rasterPool": {
    "openHandles": 0,
    "maxOpen": 8,
    "idleTtlSeconds": 300.0,
    "hits": 0,
    "misses": 0,
    "evictions": 0,
    "keys": []
  },
  "featureBboxLimit": 2000,
  "attributePageMax": 500,
  "processRssBytes": 166383616
}
```

from the schema that shapes it:

```python
class PoolStats(APIModel):
    open_handles: int
    max_open: int
    idle_ttl_seconds: float
    hits: int
    misses: int
    evictions: int
    keys: list[str]


class MemoryReport(APIModel):
    raster_pool: PoolStats
    feature_bbox_limit: int
    attribute_page_max: int
    process_rss_bytes: int
```

`rasterPool` and the two feature/attribute caps are this project's own
bookkeeping about what it *intends* to bound. `processRssBytes` — the
process's actual resident set size, read via `psutil.Process().memory_info().rss`
in `app/services/system_service.py` — is the reality check against which
those numbers are read: if `openHandles` stays comfortably under `maxOpen`
but `processRssBytes` keeps climbing anyway, the leak is somewhere this
bookkeeping does not cover, not in the raster pool. Bookkeeping that always
looks healthy is only useful insofar as it agrees with what the OS actually
measures.

## Tuning

| Setting                          | Default | Symptom that should make you change it                                                                 |
| --------------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `GIS_RASTER_POOL_MAX_OPEN`        | `8`     | High `evictions` alongside frequent `misses` in `rasterPool` — more distinct rasters are being requested concurrently than the pool can keep resident, so handles thrash open/closed instead of being reused. |
| `GIS_RASTER_POOL_IDLE_TTL_SECONDS`| `300.0` | Raster handles (and their underlying file descriptors) staying open long after traffic to that layer has stopped — lower it; or popular layers being closed and reopened between bursts of otherwise-steady traffic — raise it. |
| `GIS_FEATURE_BBOX_LIMIT`          | `2000`  | Clients routinely hitting `truncated: true` on ordinary viewports (raise it, if the server and network can bear larger responses), or feature responses large enough to visibly slow the map down (lower it). |
| `GIS_ATTRIBUTE_PAGE_MAX`          | `500`   | The attribute table UI feels sluggish loading a page (lower it), or users are paging through attribute tables far more than expected because each page is too small to be useful (raise it). |
