"""Task handlers: what each task kind actually does.

The registry keeps handler code out of the task domain — the worker looks
a handler up by `task.kind` and gives it a `TaskContext`. A handler:

* reports real progress at real boundaries (`report`), never on a timer;
* calls `check_cancelled()` at every point where stopping is safe;
* returns a JSON-serializable result dict on success;
* raises `AppError` subclasses for structured, actionable failures.

Registering a new task type is one decorated async function; nothing in
the worker, the API or the frontend changes.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import anyio
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import InvalidRequestError
from app.models.task import Task
from app.services import task_service


class TaskCancelledError(Exception):
    """Raised by `check_cancelled` when cancellation was requested."""


@dataclass
class TaskContext:
    session: AsyncSession
    task: Task

    async def report(self, progress: float, stage: str, message: str | None = None) -> None:
        """Persist real progress. Commits so pollers see it immediately."""
        self.task.progress = max(0.0, min(1.0, progress))
        self.task.stage = stage
        task_service.append_log(self.task, message or stage)
        await self.session.commit()
        await self.session.refresh(self.task)

    async def check_cancelled(self) -> None:
        """Cooperative cancellation point. Reads the flag fresh from the
        database — the cancel request arrives through another session."""
        await self.session.refresh(self.task, ["cancel_requested", "state"])
        if self.task.cancel_requested:
            raise TaskCancelledError


Handler = Callable[[TaskContext], Awaitable[dict[str, Any] | None]]

_REGISTRY: dict[str, Handler] = {}


def register(kind: str) -> Callable[[Handler], Handler]:
    def decorator(handler: Handler) -> Handler:
        _REGISTRY[kind] = handler
        return handler

    return decorator


def get_handler(kind: str) -> Handler | None:
    return _REGISTRY.get(kind)


def registered_kinds() -> list[str]:
    return sorted(_REGISTRY)


@register("vector_import")
async def vector_import(ctx: TaskContext) -> dict[str, Any]:
    """Import a previously-uploaded vector file as a new layer.

    Same read/normalize/write pipeline as the synchronous endpoint —
    `write_frame_and_register` keeps its transactional drop-on-failure
    guarantee — with progress at each real stage boundary and a
    cancellation checkpoint between stages.
    """
    # Imported lazily: vector_import_service records task provenance via
    # task_service, so a module-level import here would be a cycle.
    from app.services import vector_import_service
    from app.services.upload_service import slugify_table_name

    params = ctx.task.params
    upload_path = params.get("uploadPath")
    if not upload_path or not Path(upload_path).exists():
        raise InvalidRequestError(
            "The uploaded file for this import no longer exists",
            details={"uploadPath": upload_path},
        )
    name = str(params.get("name") or Path(upload_path).stem)
    source_filename = str(params.get("sourceFilename") or Path(upload_path).name)

    await ctx.report(0.05, "reading", f"reading {source_filename}")
    # _read_frame also normalizes (EPSG:4326, `geometry` column) — same
    # single pipeline as the synchronous endpoint.
    frame = await anyio.to_thread.run_sync(vector_import_service._read_frame, Path(upload_path))
    await ctx.check_cancelled()

    await ctx.report(0.55, "writing", f"writing {len(frame)} features")
    table_name = slugify_table_name(source_filename)
    layer = await vector_import_service.write_frame_and_register(
        ctx.session,
        ctx.task.project_id,
        frame,
        layer_name=name,
        table_name=table_name,
        source_filename=source_filename,
    )

    await ctx.report(0.95, "finishing")
    ctx.task.layer_id = layer.id
    Path(upload_path).unlink(missing_ok=True)  # inputs are only kept for retry
    return {
        "layerId": str(layer.id),
        "featureCount": layer.feature_count,
        "layerName": layer.name,
    }
