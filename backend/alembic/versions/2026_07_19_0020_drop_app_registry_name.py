"""drop the app_registry.name column

Revision ID: 0020_drop_app_registry_name
Revises: 0019_app_registry_deployed_url
Create Date: 2026-07-19

`name` was never populated on the provision path (both upserts default it to ""), so
the registry rendered "(untitled)" for every app; the display name now comes from
`projects.name` instead. DESTRUCTIVE + SCHEMA-ONLY: `downgrade` recreates the column's
STRUCTURE, not its data — any admin-set name is gone on the drop. A pre-drop count
confirmed zero rows had a non-empty name, so nothing is lost in practice.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision: str = "0020_drop_app_registry_name"
down_revision: str | None = "0019_app_registry_deployed_url"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.drop_column("app_registry", "name")


def downgrade() -> None:
    op.add_column(
        "app_registry",
        sa.Column("name", sa.String(length=120), server_default="", nullable=False),
    )
