"""Persist an edited, in-memory import draft.

Validation runs to completion over every feature *before* a frame is built or
a table is created. That ordering is what makes "roll back everything if any
feature fails" true: a rejected draft never reaches a write at all. If a write
fails anyway, `write_frame_and_register`'s drop-on-failure guard removes the
freshly created table -- and because the table is always new, dropping it is
equivalent to a rollback, with no partial state either way.

There is one bulk insert, not one insert per feature.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

import anyio
import geopandas as gpd
from shapely.geometry import shape
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import AppError, ConflictError, InvalidRequestError
from app.schemas.import_draft import FeatureIssue, ImportDraftRequest, ImportResult
from app.schemas.layer import LayerRead
from app.services import vector_import_service
from app.services.geojson_validation import validate_feature_collection
from app.services.upload_service import slugify_table_name


def _max_features() -> int:
    """Indirection so a test can lower the limit without rebuilding Settings."""
    return get_settings().import_max_features


def _build_frame(features: list[dict[str, Any]]) -> gpd.GeoDataFrame:
    """Blocking. Runs on a worker thread.

    Property dicts go in as-is: no renaming, no coercion, no dropping of keys
    the frame's other rows lack. pandas fills a missing key with NaN, which
    to_postgis writes as SQL NULL -- the same thing "absent" means here.
    """
    geometries = [shape(item["geometry"]) for item in features]
    properties = [dict(item["properties"]) for item in features]
    return gpd.GeoDataFrame(properties, geometry=geometries, crs="EPSG:4326")


async def import_draft(
    session: AsyncSession, project_id: uuid.UUID, request: ImportDraftRequest
) -> ImportResult:
    from app.services import task_service

    started = task_service._now()
    provenance = {"sourceFilename": request.source_filename, "submittedVia": "draft-import"}
    try:
        return await _import_draft_inner(session, project_id, request, started, provenance)
    except AppError as exc:
        await task_service.record_failure_detached(
            project_id=project_id,
            kind="draft_import",
            provenance=provenance,
            started_at=started,
            error=task_service.error_envelope(exc),
        )
        raise


async def _import_draft_inner(
    session: AsyncSession,
    project_id: uuid.UUID,
    request: ImportDraftRequest,
    started: datetime,
    provenance: dict[str, Any],
) -> ImportResult:
    from app.services import task_service

    outcome = validate_feature_collection(request.feature_collection, max_features=_max_features())
    if outcome.errors:
        raise InvalidRequestError(
            "The import draft failed validation",
            details={
                "errors": [
                    FeatureIssue.of(issue).model_dump(by_alias=True) for issue in outcome.errors
                ]
            },
        )

    frame = await anyio.to_thread.run_sync(_build_frame, outcome.features)
    frame = vector_import_service.normalize_frame(frame)

    try:
        layer = await vector_import_service.write_frame_and_register(
            session,
            project_id,
            frame,
            layer_name=request.name,
            table_name=slugify_table_name(request.source_filename),
            source_filename=request.source_filename,
        )
    except IntegrityError as exc:
        raise ConflictError(
            "A layer with this name already exists in the project",
            details={"name": request.name},
        ) from exc

    warnings = [FeatureIssue.of(issue) for issue in outcome.warnings]
    await task_service.record_finished(
        session,
        project_id=project_id,
        kind="draft_import",
        provenance=provenance,
        started_at=started,
        layer_id=layer.id,
        result={
            "layerId": str(layer.id),
            "featureCount": len(outcome.features),
            "layerName": layer.name,
        },
    )
    return ImportResult(
        layer=LayerRead.model_validate(layer),
        imported_count=len(outcome.features),
        rejected_count=0,
        warning_count=len(warnings),
        errors=[],
        warnings=warnings,
    )
