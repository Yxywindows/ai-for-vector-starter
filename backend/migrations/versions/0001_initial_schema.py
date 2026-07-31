"""initial schema

Revision ID: 0001
Revises:
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")
    op.execute('CREATE SCHEMA IF NOT EXISTS "gis"')
    op.execute('CREATE SCHEMA IF NOT EXISTS "gis_data"')

    op.create_table(
        "project",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("view", postgresql.JSONB(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_project")),
        schema="gis",
    )

    op.create_table(
        "layer",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("source", postgresql.JSONB(), nullable=False),
        sa.Column("style", postgresql.JSONB(), nullable=False),
        sa.Column("visible", sa.Boolean(), nullable=False),
        sa.Column("opacity", sa.Float(), nullable=False),
        sa.Column("z_index", sa.Integer(), nullable=False),
        sa.Column("extent", postgresql.JSONB(), nullable=True),
        sa.Column("feature_count", sa.Integer(), nullable=True),
        sa.Column("srid", sa.Integer(), nullable=True),
        sa.Column("geometry_type", sa.String(length=50), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["gis.project.id"],
            name=op.f("fk_layer_project_id_project"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_layer")),
        sa.UniqueConstraint("project_id", "name", name=op.f("uq_layer_project_id")),
        sa.CheckConstraint(
            "kind IN ('vector', 'raster', 'vector_tile', 'basemap')",
            name=op.f("ck_layer_layer_kind"),
        ),
        sa.CheckConstraint("opacity >= 0 AND opacity <= 1", name=op.f("ck_layer_layer_opacity")),
        schema="gis",
    )
    op.create_index(
        op.f("ix_layer_project_id"), "layer", ["project_id"], unique=False, schema="gis"
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_layer_project_id"), table_name="layer", schema="gis")
    op.drop_table("layer", schema="gis")
    op.drop_table("project", schema="gis")
