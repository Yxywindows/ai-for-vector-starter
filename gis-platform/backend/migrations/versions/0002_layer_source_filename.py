"""add layer.source_filename

Revision ID: 0002
Revises: 0001
"""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "layer",
        sa.Column("source_filename", sa.String(length=255), nullable=True),
        schema="gis",
    )


def downgrade() -> None:
    op.drop_column("layer", "source_filename", schema="gis")
