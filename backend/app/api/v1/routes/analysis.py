from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.routes.tasks import _to_read
from app.db.session import SessionDep
from app.schemas.analysis import (
    BufferParams,
    ClipParams,
    DissolveParams,
    IntersectionParams,
    PointInPolygonParams,
    SpatialJoinParams,
    ValidateRepairParams,
)
from app.schemas.base import APIModel
from app.schemas.task import TaskRead

# Importing the service registers every analysis handler with the task
# registry; the routes below only queue tasks.
from app.services import (
    analysis_service,  # noqa: F401
    project_service,
    task_service,
    task_worker,
)

router = APIRouter(prefix="/projects/{project_id}/analysis", tags=["analysis"])


async def _submit(
    session: AsyncSession,
    project_id: uuid.UUID,
    tool: str,
    params: APIModel,
    provenance: dict[str, Any],
) -> TaskRead:
    project = await project_service.get_or_404(session, project_id)
    task = await task_service.create_task(
        session,
        project_id=project_id,
        kind=f"analysis_{tool}",
        params=params.model_dump(mode="json"),
        provenance={"tool": tool, **provenance},
    )
    task_worker.notify()
    return _to_read(task, project.name)


@router.post("/buffer", response_model=TaskRead, status_code=status.HTTP_202_ACCEPTED)
async def submit_buffer(
    project_id: uuid.UUID, payload: BufferParams, session: SessionDep
) -> TaskRead:
    return await _submit(
        session, project_id, "buffer", payload, {"outputName": payload.output_name}
    )


@router.post("/clip", response_model=TaskRead, status_code=status.HTTP_202_ACCEPTED)
async def submit_clip(project_id: uuid.UUID, payload: ClipParams, session: SessionDep) -> TaskRead:
    return await _submit(session, project_id, "clip", payload, {"outputName": payload.output_name})


@router.post("/intersection", response_model=TaskRead, status_code=status.HTTP_202_ACCEPTED)
async def submit_intersection(
    project_id: uuid.UUID, payload: IntersectionParams, session: SessionDep
) -> TaskRead:
    return await _submit(
        session, project_id, "intersection", payload, {"outputName": payload.output_name}
    )


@router.post("/dissolve", response_model=TaskRead, status_code=status.HTTP_202_ACCEPTED)
async def submit_dissolve(
    project_id: uuid.UUID, payload: DissolveParams, session: SessionDep
) -> TaskRead:
    return await _submit(
        session, project_id, "dissolve", payload, {"outputName": payload.output_name}
    )


@router.post("/spatial-join", response_model=TaskRead, status_code=status.HTTP_202_ACCEPTED)
async def submit_spatial_join(
    project_id: uuid.UUID, payload: SpatialJoinParams, session: SessionDep
) -> TaskRead:
    return await _submit(
        session, project_id, "spatial_join", payload, {"outputName": payload.output_name}
    )


@router.post("/validate-repair", response_model=TaskRead, status_code=status.HTTP_202_ACCEPTED)
async def submit_validate_repair(
    project_id: uuid.UUID, payload: ValidateRepairParams, session: SessionDep
) -> TaskRead:
    return await _submit(
        session, project_id, "validate_repair", payload, {"outputName": payload.output_name}
    )


@router.post("/point-in-polygon", response_model=TaskRead, status_code=status.HTTP_202_ACCEPTED)
async def submit_point_in_polygon(
    project_id: uuid.UUID, payload: PointInPolygonParams, session: SessionDep
) -> TaskRead:
    return await _submit(
        session, project_id, "point_in_polygon", payload, {"outputName": payload.output_name}
    )
