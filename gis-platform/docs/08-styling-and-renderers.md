# 08 · Styling and Renderers

The style spec follows the QGIS symbology model: a **renderer** decides
*which* symbol a feature gets — every feature gets the same one (`single`),
one per distinct attribute value (`categorized`), or one per numeric range
(`graduated`) — and the **symbol** (fill, stroke, marker, label) decides what
that symbol actually looks like. The renderer answers "which style?"; the
symbol answers "what does that style draw?". They're independent axes: any
renderer can be paired with any symbol.

## Why the style spec is engine-neutral

A layer's `style` is stored as `JSONB` on the `layer` row (see
`02-spatial-data-model.md`) and read by two very different renderers: the
browser's OpenLayers map, which compiles it into `ol/style` objects, and the
server-side raster tiler (`06-raster-tiling-and-cog.md`), which reads the
raster half directly to build a `rio-tiler` colormap/rescale request. Neither
of those concerns appears in `app/schemas/style.py` — the module has no
import of `ol`, no import of `rio_tiler`, nothing that couples the shape of
the data to how any particular renderer draws it. That's deliberate: the
schema is the contract the two renderers agree on, not an implementation
detail of either one.

## The three renderers

```python
class SingleRenderer(APIModel):
    type: Literal["single"] = "single"


class CategorizedRenderer(APIModel):
    type: Literal["categorized"] = "categorized"
    field: str = Field(min_length=1)
    categories: list[ColorStop] = Field(min_length=1)
    fallback_color: str = Field(default="#9ca3af", pattern=r"^#[0-9a-fA-F]{6}$")


class GraduatedRenderer(APIModel):
    type: Literal["graduated"] = "graduated"
    field: str = Field(min_length=1)
    method: Literal["equal_interval", "quantile", "natural_breaks"] = "equal_interval"
    classes: list[ColorStop] = Field(min_length=1)
```

**`single`** — every feature in the layer draws with the same `fill` /
`stroke` / `marker`. No `field` needed; it's the default for a layer with no
style saved yet:

```json
{ "kind": "vector", "renderer": { "type": "single" } }
```

**`categorized`** — one `ColorStop` per distinct value of `field`, anything
that doesn't match a listed value falls back to `fallback_color`:

```json
{
  "kind": "vector",
  "renderer": {
    "type": "categorized",
    "field": "road_class",
    "categories": [
      { "value": "motorway", "color": "#dc2626", "label": "Motorway" },
      { "value": "residential", "color": "#f59e0b", "label": "Residential" }
    ],
    "fallbackColor": "#9ca3af"
  }
}
```

**`graduated`** — `field` is numeric, buckets are `min`/`max` ranges rather
than discrete values, and `method` records how those breaks were computed
(equal interval, quantile, or natural breaks/Jenks):

```json
{
  "kind": "vector",
  "renderer": {
    "type": "graduated",
    "field": "population",
    "method": "quantile",
    "classes": [
      {"min": 0,      "max": 10000,  "color": "#eff6ff", "label": "< 10k"},
      {"min": 10000,  "max": 100000, "color": "#60a5fa", "label": "10k–100k"},
      {"min": 100000, "max": null,   "color": "#1d4ed8", "label": "> 100k"}
    ]
  },
  "stroke": {"color": "#1e3a8a", "width": 0.5}
}
```

The same `ColorStop` model backs both `categorized` and `graduated`
categories — it just uses different fields (`value` for categorized,
`min`/`max` for graduated) — and a model validator rejects an inverted
range up front:

```python
@model_validator(mode="after")
def _bounds_must_ascend(self) -> ColorStop:
    if self.min is not None and self.max is not None and self.min > self.max:
        raise ValueError("min must be less than or equal to max")
    return self
```

## Raster styling is different

A raster layer has no features to bucket by attribute — a `renderer` doesn't
apply. Instead `RasterStyle` describes which bands feed the display and how
their raw sample values map to a displayable range:

```python
class RasterStyle(APIModel):
    kind: Literal["raster"] = "raster"
    bands: list[int] = Field(default=[1], min_length=1, max_length=4)
    rescale: list[tuple[float, float]] | None = None
    colormap: str | None = None
    opacity: float = Field(default=1.0, ge=0.0, le=1.0)

    @model_validator(mode="after")
    def _rescale_matches_bands(self) -> RasterStyle:
        if self.rescale is not None and len(self.rescale) != len(self.bands):
            raise ValueError("rescale must supply one (min, max) pair per band")
        return self
```

- **`bands`** — which 1-indexed band(s) to read: one band for a greyscale or
  colormapped single-band raster (e.g. elevation), three for an RGB
  composite.
- **`rescale`** — one `(min, max)` pair per band, in the raster's *native*
  data range. This exists because `rescale` is not cosmetic: an 8-bit RGB
  orthophoto already has values in `0–255` and a display can show it as-is,
  but a 16-bit or floating-point raster (elevation in meters, a
  reflectance band, a temperature grid) has no natural mapping to the
  0–255 range a PNG/WebP tile needs. `rescale` is that mapping — the tiler
  (`06-raster-tiling-and-cog.md`) linearly stretches each band's
  `[min, max]` to `[0, 255]` before encoding the tile. Omit it and the
  tiler falls back to the band's own data type range, which is usually
  wrong for anything that isn't already 8-bit.
- **`colormap`** — a named colormap (e.g. `"viridis"`) applied to a single
  band after rescaling, for continuous single-band data like elevation or
  NDVI.
- The validator enforces the one invariant that matters here: if `rescale`
  is given at all, it must supply exactly one pair per entry in `bands` — a
  raster style that rescales the wrong number of bands is caught at parse
  time, not by rio-tiler throwing at request time.

## Discriminated unions

```python
type LayerSource = Annotated[
    PostgisSource | RasterFileSource | XyzSource | MvtSource,
    Field(discriminator="type"),
]
```

```python
type StyleSpec = Annotated[VectorStyle | RasterStyle, Field(discriminator="kind")]
```

Both `LayerSource` and `StyleSpec` are unions of models that share a literal
tag field (`type` for sources, `kind` for styles). `Field(discriminator=...)`
tells Pydantic to read that one field first and validate against exactly the
matching branch, instead of trying every member of the union in order and
reporting whichever one happened to fail last. Two consequences follow
directly from that: an unrecognized tag (e.g. `{"type": "shapefile"}`, which
matches none of `PostgisSource` / `RasterFileSource` / `XyzSource` /
`MvtSource`) fails fast with a single `union_tag_invalid` error naming the
tags it did expect, rather than a wall of per-branch errors; and a raw dict
that *does* carry a recognized tag is validated only against that one model,
so a `postgis` source with a typo'd field name reports that typo directly
instead of also failing to look like a raster file, an XYZ endpoint, and an
MVT source.

## camelCase on the wire

```python
class APIModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        from_attributes=True,
        extra="forbid",
    )
```

Every model in `app/schemas/` inherits `APIModel`. `alias_generator=to_camel`
means each field's wire name is generated from its Python name automatically
(`source_layer` → `sourceLayer`), `populate_by_name=True` means the model
still accepts the Python snake_case name when constructed in code, and
`from_attributes=True` lets `LayerRead.model_validate(...)` read straight off
a SQLAlchemy `Layer` instance's snake_case attributes. `extra="forbid"` means
an unexpected field on the wire is a validation error, not silently dropped.

The round trip is proven directly, not just asserted by inspection:

```python
def test_source_round_trips_to_camel_case() -> None:
    source = MvtSource(type="mvt", url="https://tiles/{z}/{x}/{y}.pbf", source_layer="water")
    assert source.model_dump(by_alias=True) == {
        "type": "mvt",
        "url": "https://tiles/{z}/{x}/{y}.pbf",
        "sourceLayer": "water",
    }
```

`source_layer` goes in, `sourceLayer` comes out — this is the exact
translation Task 14's hand-written TypeScript mirrors depend on staying
stable.
