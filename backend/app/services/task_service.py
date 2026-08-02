"""Task domain logic, independent of any handler.

Creation, listing, detail, cancellation and retry live here; what a task
*does* lives in `task_handlers`. State changes go through
`task_lifecycle.assert_transition`, so an illegal move is a 409, never a
silently corrupted row.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import AppError, ConflictError, InvalidRequestError, NotFoundError
from app.models.project import Project
from app.models.task import Task
from app.services import task_lifecycle

logger = logging.getLogger(__name__)

MAX_LOG_ENTRIES = 200


def _now() -> datetime:
    return datetime.now(tz=UTC)


def error_envelope(exc: AppError) -> dict[str, Any]:
    """The same {code, message, details} shape the HTTP envelope uses."""
    return {"code": exc.code, "message": exc.message, "details": exc.details}


async def record_failure_detached(
    *,
    project_id: uuid.UUID,
    kind: str,
    provenance: dict[str, Any],
    started_at: datetime,
    error: dict[str, Any],
) -> None:
    """Record a synchronous execution's failure on a separate session.

    The request session is about to roll back with the failure that is
    being recorded — a row written through it would vanish. Best-effort:
    failing to write history must never mask the original error.
    """
    try:
        from app.db.session import SessionLocal

        async with SessionLocal() as session:
            await record_finished(
                session,
                project_id=project_id,
                kind=kind,
                provenance=provenance,
                started_at=started_at,
                error=error,
            )
            await session.commit()
    except Exception:
        logger.exception("Could not record a failed %s task", kind)


def append_log(task: Task, message: str, level: str = "info") -> None:
    entry = {"ts": _now().isoformat(), "level": level, "message": message}
    # JSONB columns need a new list object for the ORM to notice the change.
    task.logs = [*task.logs[-(MAX_LOG_ENTRIES - 1) :], entry]


async def create_task(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    kind: str,
    params: dict[str, Any],
    provenance: dict[str, Any] | None = None,
    retry_of: uuid.UUID | None = None,
) -> Task:
    task = Task(
        id=uuid.uuid4(),
        project_id=project_id,
        kind=kind,
        state="queued",
        progress=0.0,
        params=params,
        logs=[],
        provenance=provenance or {},
        retry_of=retry_of,
    )
    append_log(task, f"queued as {kind}")
    session.add(task)
    await session.flush()
    # Server-side defaults (created_at, updated_at) expire on flush; load
    # them eagerly so later sync attribute access never lazy-loads.
    await session.refresh(task)
    return task


async def record_finished(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    kind: str,
    provenance: dict[str, Any],
    started_at: datetime,
    layer_id: uuid.UUID | None = None,
    result: dict[str, Any] | None = None,
    error: dict[str, Any] | None = None,
) -> Task:
    """Record a synchronously-executed task after the fact.

    The existing import endpoints run inside the request; their history
    still belongs in the shared task table, as an already-terminal row.
    """
    finished = _now()
    state = "failed" if error is not None else "succeeded"
    task = Task(
        id=uuid.uuid4(),
        project_id=project_id,
        layer_id=layer_id,
        kind=kind,
        state=state,
        progress=1.0 if error is None else 0.0,
        stage="completed" if error is None else "failed",
        params={},
        result=result,
        error=error,
        logs=[],
        provenance={**provenance, "executedInRequest": True},
        created_at=started_at,
        started_at=started_at,
        finished_at=finished,
    )
    append_log(task, f"{kind} executed synchronously: {state}")
    session.add(task)
    await session.flush()
    await session.refresh(task)
    return task


async def get_task_or_404(session: AsyncSession, task_id: uuid.UUID) -> Task:
    task = await session.get(Task, task_id)
    if task is None:
        raise NotFoundError(f"Task {task_id} not found", details={"taskId": str(task_id)})
    return task


async def list_tasks(
    session: AsyncSession,
    *,
    project_id: uuid.UUID | None,
    kind: str | None,
    state: str | None,
    created_after: datetime | None,
    page: int,
    page_size: int,
) -> tuple[list[tuple[Task, str]], int]:
    cap = get_settings().task_page_max
    if page < 1 or page_size < 1 or page_size > cap:
        raise InvalidRequestError(
            "Invalid paging", details={"page": page, "pageSize": page_size, "maxPageSize": cap}
        )

    conditions = []
    if project_id is not None:
        conditions.append(Task.project_id == project_id)
    if kind is not None:
        conditions.append(Task.kind == kind)
    if state is not None:
        if state not in task_lifecycle.TRANSITIONS:
            raise InvalidRequestError(
                "Unknown state filter",
                details={"state": state, "allowed": sorted(task_lifecycle.TRANSITIONS)},
            )
        conditions.append(Task.state == state)
    if created_after is not None:
        conditions.append(Task.created_at >= created_after)

    total = (await session.execute(select(func.count(Task.id)).where(*conditions))).scalar_one()
    rows = (
        (
            await session.execute(
                select(Task, Project.name)
                .join(Project, Project.id == Task.project_id)
                .where(*conditions)
                # Stable ordering: created_at can collide, id cannot.
                .order_by(Task.created_at.desc(), Task.id.desc())
                .limit(page_size)
                .offset((page - 1) * page_size)
            )
        )
        .tuples()
        .all()
    )
    return list(rows), int(total)


async def request_cancel(session: AsyncSession, task_id: uuid.UUID) -> Task:
    task = await get_task_or_404(session, task_id)
    if task.state == "queued":
        task_lifecycle.assert_transition(task.state, "cancelled")
        task.state = "cancelled"
        task.cancel_requested = True
        task.finished_at = _now()
        append_log(task, "cancelled before it started")
    elif task.state == "running":
        task_lifecycle.assert_transition(task.state, "cancelling")
        task.state = "cancelling"
        task.cancel_requested = True
        append_log(task, "cancellation requested")
    elif task.state == "cancelling":
        pass  # idempotent: already on its way out
    else:
        raise ConflictError(
            f"A {task.state} task cannot be cancelled",
            details={"taskId": str(task_id), "state": task.state},
        )
    await session.flush()
    await session.refresh(task)
    return task


def is_retryable(task: Task) -> bool:
    """A task can be retried when it ended without success AND its inputs
    still exist. Synchronously-recorded history has no re-runnable params;
    an async import needs its uploaded file to still be on disk."""
    if task.state not in {"failed", "cancelled"}:
        return False
    if not task.params:
        return False
    upload = task.params.get("uploadPath")
    return upload is None or Path(upload).exists()


async def retry_task(session: AsyncSession, task_id: uuid.UUID) -> Task:
    original = await get_task_or_404(session, task_id)
    if original.state not in {"failed", "cancelled"}:
        raise ConflictError(
            f"Only failed or cancelled tasks can be retried; this one is {original.state}",
            details={"taskId": str(task_id), "state": original.state},
        )
    if not is_retryable(original):
        raise InvalidRequestError(
            "This task's inputs are no longer available to retry",
            details={"taskId": str(task_id)},
        )
    fresh = await create_task(
        session,
        project_id=original.project_id,
        kind=original.kind,
        params=dict(original.params),
        provenance={**original.provenance, "retryOf": str(original.id)},
        retry_of=original.id,
    )
    append_log(fresh, f"retry of {original.id}")
    await session.flush()
    await session.refresh(fresh)
    return fresh


def duration_ms(task: Task) -> int | None:
    if task.started_at is None:
        return None
    end = task.finished_at or _now()
    return int((end - task.started_at).total_seconds() * 1000)
