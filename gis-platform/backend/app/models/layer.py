from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.config import get_settings
from app.db.base import Base

if TYPE_CHECKING:
    from app.models.project import Project

_SCHEMA = get_settings().metadata_schema

LAYER_KINDS = ("vector", "raster", "vector_tile", "basemap")


class Layer(Base):
    """One entry in the layer tree. `source` and `style` are validated by Pydantic."""

    __tablename__ = "layer"
    __table_args__ = (
        UniqueConstraint("project_id", "name", name="uq_layer_project_id"),
        CheckConstraint(
            "kind IN ('vector', 'raster', 'vector_tile', 'basemap')", name="layer_kind"
        ),
        CheckConstraint("opacity >= 0 AND opacity <= 1", name="layer_opacity"),
        {"schema": _SCHEMA},
    )

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey(f"{_SCHEMA}.project.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    source: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    style: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    visible: Mapped[bool] = mapped_column(nullable=False, default=True)
    opacity: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    z_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    extent: Mapped[list[float] | None] = mapped_column(JSONB, nullable=True)
    feature_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    srid: Mapped[int | None] = mapped_column(Integer, nullable=True)
    geometry_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    project: Mapped[Project] = relationship(back_populates="layers")
