"""The in-process task worker.

One asyncio loop per process, no broker: the deployment is a single
backend, and a jobs table plus `FOR UPDATE SKIP LOCKED` claiming is
reliable there — and stays correct if a second worker process ever
appears. Tests never run the loop; they drive `run_once` with their own
session, which makes every lifecycle test deterministic.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import suppress

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, InvalidRequestError
from app.models.task import Task
from app.services import task_service
from app.services.task_handlers import TaskCancelledError, TaskContext, get_handler

logger = logging.getLogger(__name__)

_wake = asyncio.Event()


def notify() -> None:
    """Called after a task is queued so the worker skips its poll delay."""
    _wake.set()


async def recover_interrupted(session: AsyncSession) -> int:
    """Startup pass: work that was mid-flight when the process died cannot
    resume (handlers are not checkpointed), so it fails honestly — and
    retryably — instead of sitting in `running` forever."""
    result = await session.execute(
        update(Task)
        .where(Task.state.in_(("running", "cancelling")))
        .values(
            state="failed",
            error={
                "code": "interrupted",
                "message": "The backend restarted while this task was executing",
                "details": {"recoveredAtStartup": True},
            },
            finished_at=task_service._now(),
        )
        # The startup session is fresh and holds no identity-mapped Task
        # instances; skipping synchronization avoids the async-unfriendly
        # in-memory bookkeeping entirely. Anyone else re-reads from SQL.
        .execution_options(synchronize_session=False)
    )
    await session.commit()
    count = getattr(result, "rowcount", 0) or 0
    if count:
        logger.warning("Marked %d interrupted task(s) as failed at startup", count)
    return count


async def _claim(session: AsyncSession) -> Task | None:
    task = (
        await session.execute(
            select(Task)
            .where(Task.state == "queued")
            .order_by(Task.created_at, Task.id)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
    ).scalar_one_or_none()
    if task is None:
        return None
    task.state = "running"
    task.started_at = task_service._now()
    task_service.append_log(task, "started")
    await session.commit()
    await session.refresh(task)
    return task


async def run_once(session: AsyncSession) -> bool:
    """Claim and execute at most one queued task. Returns True if one ran."""
    task = await _claim(session)
    if task is None:
        return False

    handler = get_handler(task.kind)
    ctx = TaskContext(session=session, task=task)
    try:
        if handler is None:
            raise InvalidRequestError(
                f"No handler is registered for task kind '{task.kind}'",
                details={"kind": task.kind},
            )
        result = await handler(ctx)
    except TaskCancelledError:
        await session.refresh(task)
        task.state = "cancelled"
        task.finished_at = task_service._now()
        task_service.append_log(task, "cancelled at a checkpoint")
    except AppError as exc:
        await _mark_failed(session, task, task_service.error_envelope(exc))
    except Exception as exc:
        logger.exception("Task %s (%s) crashed", task.id, task.kind)
        await _mark_failed(
            session,
            task,
            {"code": "internal_error", "message": str(exc), "details": {"kind": task.kind}},
        )
    else:
        # The handler may have finished after a cancel request it chose to
        # honor by completing; cancelling -> succeeded is a legal end.
        await session.refresh(task, ["state"])
        task.result = result
        task.state = "succeeded"
        task.progress = 1.0
        task.stage = "completed"
        task.finished_at = task_service._now()
        task_service.append_log(task, "succeeded")
    await session.commit()
    return True


async def _mark_failed(session: AsyncSession, task: Task, error: dict[str, object]) -> None:
    # The handler may have left the session in a failed transaction state.
    with suppress(Exception):
        await session.rollback()
    await session.refresh(task)
    task.state = "failed"
    task.error = error
    task.finished_at = task_service._now()
    task_service.append_log(task, f"failed: {error.get('message', 'unknown error')}", "error")


async def run_worker(stop: asyncio.Event, poll_seconds: float) -> None:
    from app.db.session import SessionLocal

    logger.info("Task worker started (poll %.1fs)", poll_seconds)
    while not stop.is_set():
        did_work = False
        try:
            async with SessionLocal() as session:
                did_work = await run_once(session)
        except Exception:
            logger.exception("Task worker iteration failed")
        if not did_work:
            with suppress(asyncio.TimeoutError):
                await asyncio.wait_for(_wake.wait(), timeout=poll_seconds)
            _wake.clear()
    logger.info("Task worker stopped")
