"""background task table + import-provenance backfill

Revision ID: 0003
Revises: 0002
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "task",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("layer_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("kind", sa.String(length=40), nullable=False),
        sa.Column("state", sa.String(length=12), nullable=False),
        sa.Column("progress", sa.Float(), nullable=False),
        sa.Column("stage", sa.String(length=80), nullable=True),
        sa.Column("params", postgresql.JSONB(), nullable=False),
        sa.Column("result", postgresql.JSONB(), nullable=True),
        sa.Column("error", postgresql.JSONB(), nullable=True),
        sa.Column("logs", postgresql.JSONB(), nullable=False),
        sa.Column("retry_of", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("cancel_requested", sa.Boolean(), nullable=False),
        sa.Column("provenance", postgresql.JSONB(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["gis.project.id"],
            name=op.f("fk_task_project_id_project"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["layer_id"],
            ["gis.layer.id"],
            name=op.f("fk_task_layer_id_layer"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["retry_of"],
            ["gis.task.id"],
            name=op.f("fk_task_retry_of_task"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_task")),
        sa.CheckConstraint(
            "state IN ('queued', 'running', 'succeeded', 'failed', 'cancelling', 'cancelled')",
            name=op.f("ck_task_task_state"),
        ),
        sa.CheckConstraint("progress >= 0 AND progress <= 1", name=op.f("ck_task_task_progress")),
        schema="gis",
    )
    op.create_index(
        "ix_task_project_created", "task", ["project_id", "created_at"], unique=False, schema="gis"
    )
    op.create_index("ix_task_state", "task", ["state"], unique=False, schema="gis")

    # Migrate existing import provenance into the shared representation:
    # every layer that recorded a source file becomes one succeeded
    # vector_import task, timestamped from the layer itself.
    op.execute(
        """
        INSERT INTO gis.task
            (id, project_id, layer_id, kind, state, progress, stage, params, result,
             logs, cancel_requested, provenance, created_at, started_at, finished_at,
             updated_at)
        SELECT gen_random_uuid(), l.project_id, l.id, 'vector_import', 'succeeded', 1.0,
               'completed', '{}'::jsonb,
               jsonb_build_object('layerId', l.id::text, 'featureCount', l.feature_count),
               '[]'::jsonb, false,
               jsonb_build_object('sourceFilename', l.source_filename,
                                  'migratedFromLayer', true),
               l.created_at, l.created_at, l.created_at, l.created_at
        FROM gis.layer AS l
        WHERE l.source_filename IS NOT NULL
        """
    )


def downgrade() -> None:
    op.drop_index("ix_task_state", table_name="task", schema="gis")
    op.drop_index("ix_task_project_created", table_name="task", schema="gis")
    op.drop_table("task", schema="gis")
