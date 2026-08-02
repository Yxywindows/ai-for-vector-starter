from __future__ import annotations

import uuid
from typing import Literal

from pydantic import Field

from app.schemas.attribute import AttributeFilter
from app.schemas.base import APIModel

VectorExportFormat = Literal["geojson", "csv", "gpkg", "shp"]


class VectorExportParams(APIModel):
    layer_id: uuid.UUID
    format: VectorExportFormat
    # None means every attribute column; the geometry always rides along
    # (as WKT for CSV).
    fields: list[str] | None = None
    crs: int = Field(default=4326, ge=1, le=999999)
    filters: list[AttributeFilter] | None = None
    feature_ids: list[str] | None = Field(default=None, max_length=10_000)
    bbox: list[float] | None = Field(default=None, min_length=4, max_length=4)
    filename: str | None = Field(default=None, max_length=120)


class RasterExportParams(APIModel):
    layer_id: uuid.UUID
    format: Literal["gtiff"] = "gtiff"
    filename: str | None = Field(default=None, max_length=120)
