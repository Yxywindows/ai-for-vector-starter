from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, CheckConstraint, DateTime, Float, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.config import get_settings
from app.db.base import Base

_SCHEMA = get_settings().metadata_schema

TASK_STATES = ("queued", "running", "succeeded", "failed", "cancelling", "cancelled")


class Task(Base):
    """One background execution: import, analysis, preprocessing or export.

    A single shared representation for every task type — handlers differ,
    the lifecycle, storage, listing, cancellation and retry do not. Rows
    are never deleted by the system: history is the point.
    """

    __tablename__ = "task"
    # Server-generated values (created_at, and updated_at's onupdate) come
    # back via RETURNING at flush time instead of expiring the attribute —
    # an expired column on an async session cannot be lazy-loaded from a
    # plain attribute read (MissingGreenlet), and task rows are re-read
    # constantly right after mutation.
    __mapper_args__ = {"eager_defaults": True}  # noqa: RUF012
    __table_args__ = (
        CheckConstraint(
            "state IN ('queued', 'running', 'succeeded', 'failed', 'cancelling', 'cancelled')",
            name="task_state",
        ),
        CheckConstraint("progress >= 0 AND progress <= 1", name="task_progress"),
        Index("ix_task_project_created", "project_id", "created_at"),
        Index("ix_task_state", "state"),
        {"schema": _SCHEMA},
    )

    id: Mapped[uuid.UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True)
    project_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey(f"{_SCHEMA}.project.id", ondelete="CASCADE"),
        nullable=False,
    )
    # The dataset a finished task produced or operated on. SET NULL rather
    # than CASCADE: deleting a layer must not erase execution history.
    layer_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey(f"{_SCHEMA}.layer.id", ondelete="SET NULL"),
        nullable=True,
    )
    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    state: Mapped[str] = mapped_column(String(12), nullable=False, default="queued")
    progress: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    stage: Mapped[str | None] = mapped_column(String(80), nullable=True)
    params: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    result: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    error: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    logs: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list)
    retry_of: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey(f"{_SCHEMA}.task.id", ondelete="SET NULL"),
        nullable=True,
    )
    cancel_requested: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    provenance: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
