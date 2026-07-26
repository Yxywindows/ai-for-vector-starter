from __future__ import annotations

import uuid
from typing import Literal

from pydantic import Field, model_validator

from app.schemas.base import APIModel
from app.schemas.source import LayerSource
from app.schemas.style import StyleSpec, default_style_for

LayerKind = Literal["vector", "raster", "vector_tile", "basemap"]


class LayerCreate(APIModel):
    name: str = Field(min_length=1, max_length=200)
    kind: LayerKind
    source: LayerSource
    style: StyleSpec | None = None
    visible: bool = True
    opacity: float = Field(default=1.0, ge=0.0, le=1.0)

    @model_validator(mode="after")
    def _fill_default_style(self) -> LayerCreate:
        if self.style is None:
            object.__setattr__(self, "style", default_style_for(self.kind))
        return self


class LayerUpdate(APIModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    style: StyleSpec | None = None
    visible: bool | None = None
    opacity: float | None = Field(default=None, ge=0.0, le=1.0)


class LayerRead(APIModel):
    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    kind: LayerKind
    source: LayerSource
    style: StyleSpec | None
    visible: bool
    opacity: float
    z_index: int
    extent: list[float] | None
    feature_count: int | None
    srid: int | None
    geometry_type: str | None
