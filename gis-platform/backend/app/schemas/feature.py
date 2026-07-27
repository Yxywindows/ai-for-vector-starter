"""GeoJSON wire types plus the bbox query parameter.

`truncated` is deliberately part of the response, not a header: a client
that silently receives 2000 of 200000 features and draws them as if they
were the whole layer is lying to its user. QGIS shows a feature-limit
warning; so does this.
"""

from __future__ import annotations

from typing import Any, Literal, Self

from pydantic import Field

from app.core.errors import InvalidRequestError
from app.schemas.base import APIModel

LON_LIMIT = 180.0
LAT_LIMIT = 90.0


class BBox(APIModel):
    minx: float
    miny: float
    maxx: float
    maxy: float

    @classmethod
    def parse(cls, raw: str) -> Self:
        parts = [part.strip() for part in (raw or "").split(",")]
        if len(parts) != 4:
            raise InvalidRequestError(
                "bbox must be 'minx,miny,maxx,maxy' in EPSG:4326", details={"bbox": raw}
            )
        try:
            minx, miny, maxx, maxy = (float(part) for part in parts)
        except ValueError as exc:
            raise InvalidRequestError("bbox values must be numbers", details={"bbox": raw}) from exc
        if minx >= maxx or miny >= maxy:
            raise InvalidRequestError(
                "bbox min values must be smaller than max values", details={"bbox": raw}
            )
        if not (-LON_LIMIT <= minx <= LON_LIMIT and -LON_LIMIT <= maxx <= LON_LIMIT):
            raise InvalidRequestError("bbox longitude out of range", details={"bbox": raw})
        if not (-LAT_LIMIT <= miny <= LAT_LIMIT and -LAT_LIMIT <= maxy <= LAT_LIMIT):
            raise InvalidRequestError("bbox latitude out of range", details={"bbox": raw})
        return cls(minx=minx, miny=miny, maxx=maxx, maxy=maxy)

    @property
    def as_params(self) -> dict[str, float]:
        return {"minx": self.minx, "miny": self.miny, "maxx": self.maxx, "maxy": self.maxy}


class Feature(APIModel):
    type: Literal["Feature"] = "Feature"
    id: str
    geometry: dict[str, Any] | None
    properties: dict[str, Any]


class FeatureCollection(APIModel):
    type: Literal["FeatureCollection"] = "FeatureCollection"
    features: list[Feature]
    returned: int = Field(description="Number of features in this response")
    limit: int = Field(description="Server-applied cap for this request")
    truncated: bool = Field(
        description="True when more features intersect the bbox than the cap allowed"
    )
