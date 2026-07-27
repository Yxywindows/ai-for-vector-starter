from __future__ import annotations

import psutil

from app.core.config import get_settings
from app.resources.dataset_pool import get_raster_pool
from app.schemas.system import MemoryReport


def memory_report() -> MemoryReport:
    settings = get_settings()
    return MemoryReport(
        raster_pool=get_raster_pool().stats(),
        feature_bbox_limit=settings.feature_bbox_limit,
        attribute_page_max=settings.attribute_page_max,
        process_rss_bytes=int(psutil.Process().memory_info().rss),
    )
