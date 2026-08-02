from __future__ import annotations

import uuid
from typing import Literal

from pydantic import Field

from app.schemas.base import APIModel

OUTPUT_NAME = Field(min_length=1, max_length=200)


class BufferParams(APIModel):
    layer_id: uuid.UUID
    distance_meters: float = Field(gt=0, le=10_000_000)
    output_name: str = OUTPUT_NAME


class ClipParams(APIModel):
    layer_id: uuid.UUID
    mask_layer_id: uuid.UUID
    output_name: str = OUTPUT_NAME


class IntersectionParams(APIModel):
    layer_id: uuid.UUID
    other_layer_id: uuid.UUID
    output_name: str = OUTPUT_NAME


class DissolveParams(APIModel):
    layer_id: uuid.UUID
    by_field: str | None = None
    output_name: str = OUTPUT_NAME


class SpatialJoinParams(APIModel):
    target_layer_id: uuid.UUID
    join_layer_id: uuid.UUID
    predicate: Literal["intersects", "contains", "within"] = "intersects"
    output_name: str = OUTPUT_NAME


class ValidateRepairParams(APIModel):
    layer_id: uuid.UUID
    output_name: str = OUTPUT_NAME


class PointInPolygonParams(APIModel):
    points_layer_id: uuid.UUID
    polygons_layer_id: uuid.UUID
    output_name: str = OUTPUT_NAME
