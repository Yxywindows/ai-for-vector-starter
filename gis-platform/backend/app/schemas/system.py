from __future__ import annotations

from app.schemas.base import APIModel


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
