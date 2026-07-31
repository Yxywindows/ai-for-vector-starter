"""Where a layer's data actually comes from. One model per provider kind."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import Field, TypeAdapter

from app.schemas.base import APIModel

IDENT = Field(pattern=r"^[a-z_][a-z0-9_]{0,62}$")


class PostgisSource(APIModel):
    """A table in PostGIS. Either created by import, or registered in place."""

    type: Literal["postgis"] = "postgis"
    schema_name: str = IDENT
    table_name: str = IDENT
    geometry_column: str = IDENT
    id_column: str = IDENT
    srid: int = Field(ge=1, le=999999)


class RasterFileSource(APIModel):
    type: Literal["raster_file"] = "raster_file"
    path: str
    band_count: int = Field(ge=1)
    nodata: float | None = None
    is_cog: bool = False


class XyzSource(APIModel):
    type: Literal["xyz"] = "xyz"
    url: str
    attribution: str | None = None


class MvtSource(APIModel):
    type: Literal["mvt"] = "mvt"
    url: str
    source_layer: str | None = None


type LayerSource = Annotated[
    PostgisSource | RasterFileSource | XyzSource | MvtSource,
    Field(discriminator="type"),
]

_SOURCE_ADAPTER: TypeAdapter[LayerSource] = TypeAdapter(LayerSource)


def parse_source(raw: dict[str, Any]) -> LayerSource:
    """Validate a raw JSONB `source` column into its concrete model."""
    return _SOURCE_ADAPTER.validate_python(raw)
