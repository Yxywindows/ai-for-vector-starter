from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, status
from fastapi.responses import FileResponse

from app.api.v1.routes.tasks import _to_read
from app.core.errors import ConflictError, NotFoundError
from app.db.session import SessionDep
from app.schemas.export import RasterExportParams, VectorExportParams
from app.schemas.task import TaskRead

# Importing the service registers the export handlers with the registry.
from app.services import export_service, project_service, task_service, task_worker

router = APIRouter(tags=["exports"])

MEDIA_TYPES = {
    ".geojson": "application/geo+json",
    ".csv": "text/csv",
    ".gpkg": "application/geopackage+sqlite3",
    ".zip": "application/zip",
    ".tif": "image/tiff",
}


@router.post(
    "/projects/{project_id}/exports/vector",
    response_model=TaskRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def submit_vector_export(
    project_id: uuid.UUID, payload: VectorExportParams, session: SessionDep
) -> TaskRead:
    project = await project_service.get_or_404(session, project_id)
    task = await task_service.create_task(
        session,
        project_id=project_id,
        kind="export_vector",
        params=payload.model_dump(mode="json"),
        provenance={"format": payload.format, "layerId": str(payload.layer_id)},
    )
    task_worker.notify()
    return _to_read(task, project.name)


@router.post(
    "/projects/{project_id}/exports/raster",
    response_model=TaskRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def submit_raster_export(
    project_id: uuid.UUID, payload: RasterExportParams, session: SessionDep
) -> TaskRead:
    project = await project_service.get_or_404(session, project_id)
    task = await task_service.create_task(
        session,
        project_id=project_id,
        kind="export_raster",
        params=payload.model_dump(mode="json"),
        provenance={"format": payload.format, "layerId": str(payload.layer_id)},
    )
    task_worker.notify()
    return _to_read(task, project.name)


@router.get("/tasks/{task_id}/download")
async def download_export(task_id: uuid.UUID, session: SessionDep) -> FileResponse:
    task = await task_service.get_task_or_404(session, task_id)
    if not task.kind.startswith("export_"):
        raise ConflictError(
            "Only export tasks have downloads", details={"kind": task.kind}
        )
    if task.state != "succeeded" or not task.result:
        raise ConflictError(
            "This export has not finished", details={"state": task.state}
        )
    path = export_service.export_dir() / str(task.result["file"])
    if not path.exists():
        raise NotFoundError(
            "The export file is no longer on disk", details={"file": task.result["file"]}
        )

    # Download state: remember the last time someone fetched this file.
    task.provenance = {
        **task.provenance,
        "lastDownloadedAt": datetime.now(UTC).isoformat(),
    }
    await session.flush()

    return FileResponse(
        path,
        media_type=MEDIA_TYPES.get(path.suffix, "application/octet-stream"),
        filename=str(task.result.get("downloadName") or path.name),
    )
