from __future__ import annotations

import uuid
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, File, Form, Query, UploadFile, status

from app.core.config import get_settings
from app.core.errors import ConflictError, UnsupportedFormatError
from app.db.session import SessionDep
from app.models.project import Project
from app.models.task import Task
from app.schemas.task import TaskLogEntry, TaskLogs, TaskPage, TaskRead
from app.services import project_service, task_service, task_worker
from app.services.upload_service import save_upload
from app.services.vector_import_service import SUPPORTED_SUFFIXES

router = APIRouter(tags=["tasks"])


def _to_read(task: Task, project_name: str | None = None) -> TaskRead:
    return TaskRead(
        id=task.id,
        project_id=task.project_id,
        project_name=project_name,
        layer_id=task.layer_id,
        kind=task.kind,
        state=task.state,  # constrained to TaskState values by the DB check
        progress=task.progress,
        stage=task.stage,
        params=task.params,
        result=task.result,
        error=task.error,
        retry_of=task.retry_of,
        retryable=task_service.is_retryable(task),
        cancel_requested=task.cancel_requested,
        provenance=task.provenance,
        created_at=task.created_at,
        started_at=task.started_at,
        finished_at=task.finished_at,
        updated_at=task.updated_at,
        duration_ms=task_service.duration_ms(task),
    )


@router.post(
    "/projects/{project_id}/tasks/import",
    response_model=TaskRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def submit_import_task(
    project_id: uuid.UUID,
    session: SessionDep,
    file: Annotated[UploadFile, File()],
    name: Annotated[str | None, Form()] = None,
) -> TaskRead:
    """Queue a vector import as a background task.

    The synchronous /layers/import endpoint stays for small files; this is
    the path for anything long enough to outlive a request comfortably.
    """
    project = await project_service.get_or_404(session, project_id)
    settings = get_settings()
    original_name = Path(file.filename or "upload").name
    if Path(original_name).suffix.lower() not in SUPPORTED_SUFFIXES:
        raise UnsupportedFormatError(
            "Unsupported vector format",
            details={"filename": original_name, "supported": sorted(SUPPORTED_SUFFIXES)},
        )

    # The upload outlives the request on purpose: the handler reads it,
    # and a failed task keeps it so retry has something to retry.
    work_dir = settings.upload_tmp_dir / "tasks" / uuid.uuid4().hex
    saved = await save_upload(file, work_dir, settings.upload_max_bytes)

    task = await task_service.create_task(
        session,
        project_id=project_id,
        kind="vector_import",
        params={
            "uploadPath": str(saved),
            "name": name or Path(original_name).stem,
            "sourceFilename": original_name,
        },
        provenance={"sourceFilename": original_name, "submittedVia": "task-api"},
    )
    task_worker.notify()
    return _to_read(task, project.name)


@router.get("/tasks", response_model=TaskPage)
async def list_tasks(
    session: SessionDep,
    project_id: Annotated[uuid.UUID | None, Query(alias="projectId")] = None,
    kind: Annotated[str | None, Query(alias="type")] = None,
    state: Annotated[str | None, Query()] = None,
    created_after: Annotated[datetime | None, Query(alias="createdAfter")] = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(alias="pageSize", ge=1)] = 20,
) -> TaskPage:
    rows, total = await task_service.list_tasks(
        session,
        project_id=project_id,
        kind=kind,
        state=state,
        created_after=created_after,
        page=page,
        page_size=page_size,
    )
    return TaskPage(
        items=[_to_read(task, project_name) for task, project_name in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/tasks/{task_id}", response_model=TaskRead)
async def get_task(task_id: uuid.UUID, session: SessionDep) -> TaskRead:
    task = await task_service.get_task_or_404(session, task_id)
    project = await session.get(Project, task.project_id)
    return _to_read(task, project.name if project else None)


@router.get("/tasks/{task_id}/logs", response_model=TaskLogs)
async def get_task_logs(task_id: uuid.UUID, session: SessionDep) -> TaskLogs:
    task = await task_service.get_task_or_404(session, task_id)
    return TaskLogs(
        task_id=task.id,
        entries=[TaskLogEntry.model_validate(entry) for entry in task.logs],
    )


@router.post(
    "/tasks/{task_id}/cancel", response_model=TaskRead, status_code=status.HTTP_202_ACCEPTED
)
async def cancel_task(task_id: uuid.UUID, session: SessionDep) -> TaskRead:
    task = await task_service.request_cancel(session, task_id)
    return _to_read(task)


@router.post("/tasks/{task_id}/retry", response_model=TaskRead, status_code=status.HTTP_201_CREATED)
async def retry_task(task_id: uuid.UUID, session: SessionDep) -> TaskRead:
    task = await task_service.retry_task(session, task_id)
    task_worker.notify()
    return _to_read(task)


@router.get("/tasks/{task_id}/result")
async def get_task_result(task_id: uuid.UUID, session: SessionDep) -> dict[str, Any]:
    task = await task_service.get_task_or_404(session, task_id)
    if task.state != "succeeded":
        raise ConflictError(
            "This task has no result yet",
            details={"taskId": str(task_id), "state": task.state},
        )
    return task.result or {}
