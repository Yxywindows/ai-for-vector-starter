"""Engine-neutral symbology. The client compiles this into OpenLayers styles;
the raster tiler reads the raster half directly. Nothing here knows about OL."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import Field, TypeAdapter, model_validator

from app.schemas.base import APIModel

HEX_COLOR = Field(pattern=r"^#[0-9a-fA-F]{6}$")


class FillStyle(APIModel):
    color: str = Field(default="#3b82f6", pattern=r"^#[0-9a-fA-F]{6}$")
    opacity: float = Field(default=0.6, ge=0.0, le=1.0)


class StrokeStyle(APIModel):
    color: str = Field(default="#1e3a8a", pattern=r"^#[0-9a-fA-F]{6}$")
    width: float = Field(default=1.0, ge=0.0, le=20.0)
    dash: list[float] | None = None


class MarkerStyle(APIModel):
    shape: Literal["circle", "square", "triangle"] = "circle"
    radius: float = Field(default=5.0, gt=0.0, le=50.0)


class LabelStyle(APIModel):
    field: str
    color: str = Field(default="#111827", pattern=r"^#[0-9a-fA-F]{6}$")
    size: int = Field(default=12, ge=6, le=48)
    halo_color: str = Field(default="#ffffff", pattern=r"^#[0-9a-fA-F]{6}$")


class ColorStop(APIModel):
    """One entry in a categorized or graduated renderer.

    Categorized stops carry `value`; graduated stops carry `min`/`max`.
    """

    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    value: str | float | None = None
    min: float | None = None
    max: float | None = None
    label: str | None = None

    @model_validator(mode="after")
    def _bounds_must_ascend(self) -> ColorStop:
        if self.min is not None and self.max is not None and self.min > self.max:
            raise ValueError("min must be less than or equal to max")
        return self


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


type Renderer = Annotated[
    SingleRenderer | CategorizedRenderer | GraduatedRenderer,
    Field(discriminator="type"),
]


class VectorStyle(APIModel):
    kind: Literal["vector"] = "vector"
    renderer: Renderer = SingleRenderer()
    fill: FillStyle = FillStyle()
    stroke: StrokeStyle = StrokeStyle()
    marker: MarkerStyle = MarkerStyle()
    label: LabelStyle | None = None


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


type StyleSpec = Annotated[VectorStyle | RasterStyle, Field(discriminator="kind")]

_STYLE_ADAPTER: TypeAdapter[StyleSpec] = TypeAdapter(StyleSpec)


def parse_style(raw: dict[str, Any] | None) -> StyleSpec | None:
    """An empty JSONB `{}` means 'no style saved yet', not 'invalid style'."""
    if not raw:
        return None
    return _STYLE_ADAPTER.validate_python(raw)


def default_style_for(kind: str) -> StyleSpec:
    return RasterStyle() if kind == "raster" else VectorStyle()
