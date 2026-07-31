from __future__ import annotations

import psutil

from app.core.config import get_settings
from app.resources.dataset_pool import get_raster_pool
from app.schemas.system import ImportLimits, MemoryReport


def memory_report() -> MemoryReport:
    settings = get_settings()
    return MemoryReport(
        raster_pool=get_raster_pool().stats(),
        feature_bbox_limit=settings.feature_bbox_limit,
        attribute_page_max=settings.attribute_page_max,
        process_rss_bytes=int(psutil.Process().memory_info().rss),
    )


def import_limits() -> ImportLimits:
    settings = get_settings()
    return ImportLimits(
        allowed_extensions=settings.import_allowed_extensions,
        max_file_bytes=settings.import_max_file_bytes,
        max_features=settings.import_max_features,
        preview_max_features=settings.import_preview_max_features,
    )
