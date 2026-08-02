from __future__ import annotations

import psutil
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.layer import Layer
from app.models.project import Project
from app.resources.dataset_pool import get_raster_pool
from app.schemas.system import ImportLimits, MemoryReport, OverviewLayer, SystemOverview


def memory_report() -> MemoryReport:
    settings = get_settings()
    return MemoryReport(
        raster_pool=get_raster_pool().stats(),
        feature_bbox_limit=settings.feature_bbox_limit,
        attribute_page_max=settings.attribute_page_max,
        process_rss_bytes=int(psutil.Process().memory_info().rss),
    )


async def overview(session: AsyncSession) -> SystemOverview:
    """Dashboard numbers in three grouped queries — no per-project fanout."""
    project_count = (await session.execute(select(func.count(Project.id)))).scalar_one()
    by_kind_rows = (
        await session.execute(select(Layer.kind, func.count(Layer.id)).group_by(Layer.kind))
    ).all()
    feature_total = (
        await session.execute(select(func.coalesce(func.sum(Layer.feature_count), 0)))
    ).scalar_one()
    recent = (
        (
            await session.execute(
                select(Layer, Project.name)
                .join(Project, Project.id == Layer.project_id)
                .order_by(Layer.created_at.desc())
                .limit(8)
            )
        )
        .tuples()
        .all()
    )
    return SystemOverview(
        project_count=int(project_count),
        layer_count=sum(count for _, count in by_kind_rows),
        layers_by_kind={kind: int(count) for kind, count in by_kind_rows},
        feature_total=int(feature_total or 0),
        recent_layers=[
            OverviewLayer(
                id=layer.id,
                name=layer.name,
                kind=layer.kind,
                geometry_type=layer.geometry_type,
                feature_count=layer.feature_count,
                project_id=layer.project_id,
                project_name=project_name,
                created_at=layer.created_at,
            )
            for layer, project_name in recent
        ],
    )


def import_limits() -> ImportLimits:
    settings = get_settings()
    return ImportLimits(
        allowed_extensions=settings.import_allowed_extensions,
        max_file_bytes=settings.import_max_file_bytes,
        max_features=settings.import_max_features,
        preview_max_features=settings.import_preview_max_features,
    )
