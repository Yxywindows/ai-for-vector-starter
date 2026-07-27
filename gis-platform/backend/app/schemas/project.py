from __future__ import annotations

import uuid

from pydantic import Field

from app.schemas.base import APIModel
from app.schemas.layer import LayerRead


class MapView(APIModel):
    center: tuple[float, float] = (0.0, 0.0)
    zoom: float = Field(default=2.0, ge=0.0, le=24.0)
    projection: str = "EPSG:3857"


class ProjectCreate(APIModel):
    name: str = Field(min_length=1, max_length=200)
    view: MapView = MapView()


class ProjectUpdate(APIModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    view: MapView | None = None


class ProjectRead(APIModel):
    id: uuid.UUID
    name: str
    view: MapView
    layers: list[LayerRead] = []  # noqa: RUF012 -- Pydantic deep-copies field defaults per instance


class ProjectSummary(APIModel):
    id: uuid.UUID
    name: str
    layer_count: int


class LayerReorder(APIModel):
    layer_ids: list[uuid.UUID] = Field(min_length=1)
