from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from app.schemas.base import APIModel

TaskState = Literal["queued", "running", "succeeded", "failed", "cancelling", "cancelled"]


class TaskRead(APIModel):
    id: uuid.UUID
    project_id: uuid.UUID
    project_name: str | None = None
    layer_id: uuid.UUID | None
    kind: str
    state: TaskState
    progress: float
    stage: str | None
    params: dict[str, Any]
    result: dict[str, Any] | None
    error: dict[str, Any] | None
    retry_of: uuid.UUID | None
    retryable: bool = False
    cancel_requested: bool
    provenance: dict[str, Any]
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    updated_at: datetime
    duration_ms: int | None = None


class TaskPage(APIModel):
    items: list[TaskRead]
    total: int
    page: int
    page_size: int


class TaskLogEntry(APIModel):
    ts: str
    level: str
    message: str


class TaskLogs(APIModel):
    task_id: uuid.UUID
    entries: list[TaskLogEntry]
