from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import DateTime, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.config import get_settings
from app.db.base import Base

if TYPE_CHECKING:
    from app.models.layer import Layer

_SCHEMA = get_settings().metadata_schema


class Project(Base):
    """A saved map: a view state plus an ordered set of layers."""

    __tablename__ = "project"
    __table_args__ = {"schema": _SCHEMA}  # noqa: RUF012 -- SQLAlchemy declarative convention

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    view: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    layers: Mapped[list[Layer]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="Layer.z_index",
        lazy="selectin",
    )
