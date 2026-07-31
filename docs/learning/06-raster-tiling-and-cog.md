# 06 · Raster Tiling and COG

A 4 GB GeoTIFF cannot be shipped to a browser — no map client downloads a
multi-gigabyte file before it can draw a single pixel. The obvious fallback,
decoding the whole file fresh on every tile request, is not affordable
either: a raster layer would spend nearly all its time in `open()` and
`read()`, and the server could serve only a handful of concurrent tile
requests before it fell over. This chapter is about the two things that make
`GET /layers/{layer_id}/tiles/{z}/{x}/{y}.png` cheap instead: converting a
raster to a Cloud-Optimized GeoTIFF once, at import, and reading it through
rio-tiler's windowed access on every request after that.

## What makes a GeoTIFF "cloud-optimized"

An ordinary GeoTIFF stores pixels in scanline order — row after row, top to
bottom. Reading a small square out of the middle of the image still means
seeking through (or past) a lot of unrelated rows, because nothing about the
file's layout groups nearby pixels together on disk.

A Cloud-Optimized GeoTIFF (COG) changes that in two ways:

- **Internal tiling** — pixels are stored in fixed-size blocks (this
  project's COGs use 512×512) rather than scanline strips. A block is a
  contiguous byte range, so reading the pixels that cover one map tile means
  reading only the blocks that intersect it, not the whole image.
- **Overviews** — a COG carries pre-built, progressively downsampled copies
  of the image (a pyramid). A low zoom level reads a small overview instead
  of downsampling the full-resolution image on the fly.

Together, these let a reader answer "give me the pixels for tile (z, x, y)"
by fetching a bounded, predictable byte range, regardless of how large the
full raster is. That is the property this whole chapter depends on.

## Converting at import, once

Raster import (`app/services/raster_import_service.py`) checks whether an
uploaded file is already a valid COG and, if not, converts it:

```python
    target.parent.mkdir(parents=True, exist_ok=True)
    already_cog, _errors, _warnings = cog_validate(saved, quiet=True)
    if already_cog:
        shutil.copyfile(saved, target)
    else:
        logger.info("Converting %s to COG", saved.name)
        # `cog_profiles.get` ships without a type annotation even though the
        # module itself is typed (py.typed), so this one call needs a scoped
        # ignore rather than the broader `ignore_missing_imports` override.
        deflate_profile = cog_profiles.get("deflate")  # type: ignore[no-untyped-call]
        cog_translate(saved, target, deflate_profile, quiet=True, in_memory=False)
```

The trade this makes explicit: one import can be slow — `cog_translate`
rewrites the entire raster with internal tiling and builds its overview
pyramid, which for a large file is a real, multi-second (or longer) cost —
in exchange for every tile request after that being cheap. Import happens
once per raster; tiles are requested continuously as users pan and zoom, so
that is exactly the right place to pay the cost.

## Reading a tile

`raster_tile_service.render_png` reads through the pooled `Reader` with this
inner function:

```python
    def _read(reader: Reader) -> bytes | None:
        if not reader.tile_exists(x, y, z):
            return None
        image = reader.tile(x, y, z, indexes=style.bands, tilesize=TILE_SIZE)
        if style.rescale:
            image.rescale(in_range=style.rescale)
        colormap = None
        if style.colormap:
            try:
                colormap = cmap.get(style.colormap)
            # `cmap.get` raises `rio_tiler.errors.InvalidColorMapName` for an
            # unknown name -- confirmed by calling it directly -- which is
            # neither a `KeyError` nor a `ValueError`; both are caught
            # anyway in case a future rio-tiler version or a custom
            # colormap path raises one of those instead.
            except (InvalidColorMapName, KeyError, ValueError) as exc:
                raise InvalidRequestError(
                    "Unknown colormap",
                    details={"colormap": style.colormap},
                ) from exc
        return bytes(image.render(img_format="PNG", colormap=colormap))
```

`reader.tile_exists(x, y, z)` is checked first, and for good reason: a tile
whose bounds fall entirely outside the raster's footprint is not an error,
it is just empty, and rendering a blank PNG for it would waste GDAL work on
every request and every empty tile in the client's viewport. When it is
`False`, `_read` returns `None` without ever calling `reader.tile(...)`;
`render_png` passes that `None` straight through, and the route
(`app/api/v1/routes/tiles.py`) turns it into `204 No Content` rather than a
wasted render and a blank image for the client to decode and discard.

`indexes=style.bands` is band selection: `RasterStyle.bands` (up to four
band numbers) picks which bands of a possibly-multiband raster become the
tile's R/G/B(/A) channels, so a single-band elevation raster and a
three-band RGB orthophoto both render through the same code path — the
difference is entirely in how many band indexes the style lists.

## Rescaling

Pixel values do not arrive as 0–255. A `uint16` raster (common for
satellite imagery) or a `float32` raster (common for continuous data like
elevation or temperature) can hold values far outside the 0–255 range a PNG
channel can represent. Rendered without rescaling, every pixel clamps
toward the low end of that range and the tile comes back solid black —
technically correct, visually useless.

`RasterStyle.rescale` — a `(min, max)` pair per band — is what
`image.rescale(in_range=style.rescale)` uses to linearly map the raster's
real value range onto 0–255 before rendering. It is not something a client
has to supply by hand: raster import seeds it from that band's own
statistics (`RasterStyle(bands=[1], rescale=[info["rescale"][0]])` in
`raster_import_service.import_raster_file`), so a freshly imported layer
renders sensibly by default. See `08-styling-and-renderers.md` for how
`RasterStyle` fits into the engine-neutral style spec more broadly.

## Blocking I/O on an async server

Every rio-tiler call in `_read` above — `tile_exists`, `tile`, `rescale`,
`render` — is synchronous, blocking GDAL work. FastAPI's request handlers
run on a single event loop shared by every concurrent request, so calling
any of that directly inside an `async def` would stall every other
in-flight request for as long as this one tile takes to read:

```python
            return await anyio.to_thread.run_sync(_read, reader), layer
```

Dispatching `_read` to a worker thread via `anyio.to_thread.run_sync` is
what keeps one slow tile read from blocking the other nine requests the
server happens to be serving at the same moment. This is the same idiom
`raster_import_service._inspect_and_normalise` and `raster_tile_service`'s
own `band_statistics` use for their blocking GDAL work.

## Why the handle is exclusive

The tile is read through a `Reader` borrowed from the bounded dataset pool
(`app/resources/dataset_pool.py`, `05-vector-tiles-mvt.md`'s sibling for
raster), not opened fresh per request. From the pool's own docstring,
quoted directly because it is the reasoning, not a summary of it:

> Access is EXCLUSIVE per key. A rasterio dataset is not thread-safe, and
> tile reads run on worker threads, so two concurrent reads of the same file
> must serialise. Different files never block each other. The trade-off is
> deliberate: correctness over per-file concurrency. Scaling one file across
> cores would need N handles per key, which is future work.

Concretely: two requests for different tiles of the *same* layer wait their
turn on that layer's one open `Reader`, one after another — correct, but
not maximally parallel. Two requests for tiles of *different* layers never
wait on each other at all, because each layer gets its own pool entry and
its own lock. That is a deliberate trade, not an oversight: rasterio
datasets genuinely cannot be shared across threads safely, so the choice is
between serialising same-file reads (what this pool does) or opening a
fresh, expensive handle per request (what it exists to avoid). Widening a
single popular layer's throughput further — an "N handles per key" pool
that opens a small number of read-only handles for one hot file and
round-robins across them — is possible future work, not something this task
needed.
