"""add the project_databases registry for per-project PostgreSQL isolation

Revision ID: 0022_project_database_registry
Revises: 0021_attachment_conv_link
Create Date: 2026-07-21

WHY THIS EXISTS
Generated apps move off the shared `data_records` plane onto a database of their own. The
platform owns each database's LIFECYCLE — create, sever, drop — while the app owns its
contents, so the control plane needs one durable fact per project: which database and role
were provisioned, the role's password (encrypted at rest), and whether provisioning finished.

`db_ready` is the TERMINAL marker, written in its own later commit. The provisioner inserts
the row first (`db_ready = false`), runs the DDL on a separate AUTOCOMMIT connection, then
flips the flag — so a crash mid-sequence reads as not-ready and the next ensure re-runs it.
The UNIQUE constraint on `project_id` lets `INSERT ... ON CONFLICT DO NOTHING RETURNING`
elect exactly one racer. `db_name`/`role_name` are stored, not re-derived, so teardown and
the orphan reconciler still work on rows minted under an earlier name scheme.

There is no `user_id` column: `projects` is the ownership anchor, every user-scoped query
reaches this table through it, and `ON DELETE CASCADE` guarantees the registry row can never
outlive its project. The databases live OUTSIDE Alembic's world — this migration creates
only the registry; Drizzle owns everything inside each per-project database. Hand-finalized.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision: str = "0022_project_database_registry"
down_revision: str | None = "0021_attachment_conv_link"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table(
        "project_databases",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("db_name", sa.String(length=63), nullable=False),
        sa.Column("role_name", sa.String(length=63), nullable=False),
        sa.Column("password_encrypted", sa.Text(), nullable=False),
        sa.Column("db_ready", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("provisioned_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", name="uq_project_databases_project"),
    )


def downgrade() -> None:
    op.drop_table("project_databases")
