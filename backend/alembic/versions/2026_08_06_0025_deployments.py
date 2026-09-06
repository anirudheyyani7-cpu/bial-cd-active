"""add the deployments table for one-click publish

Revision ID: 0025_deployments
Revises: 0024_messages_native_reset
Create Date: 2026-08-06

WHY THIS EXISTS
A citizen can publish a generated app with one click, no admin approval — but
`app_registry.deployed_*` is written only by the approval-gated `mark-deployed`
runbook, so a self-deployed app (which stays `draft`) is never described by it.
Publish gets its own append-only lineage instead: one row per ATTEMPT, so a
failed deploy never overwrites the record of what is still serving traffic.

`image_digest` is the load-bearing column: the reconciler may only promote a row
when ARM reports that digest live, and may never delete a container app it cannot
prove it created; the same digest is the rollback target.

`uq_deployments_one_in_flight` is a PARTIAL unique index (at most one `running`
row per app) enforced by `ON CONFLICT ... WHERE status = 'running' DO NOTHING`,
in Postgres rather than in-process, because the pipeline runs for minutes across
control-plane restarts.

`ON DELETE CASCADE` from `app_registry` means a row cannot outlive its app —
read `container_app_name` out of the row BEFORE the delete commits, or the
running Azure container becomes an orphan no sweeper can find.
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0025_deployments"
down_revision: str | None = "0024_messages_native_reset"
branch_labels: str | None = None
depends_on: str | None = None

# The native deployment_status enum. create_type=False so THIS migration owns
# the lifecycle: explicit .create() in upgrade, .drop() in downgrade.
deployment_status = postgresql.ENUM(
    "running",
    "succeeded",
    "failed",
    name="deployment_status",
    create_type=False,
)


def upgrade() -> None:
    deployment_status.create(op.get_bind(), checkfirst=True)
    op.create_table(
        "deployments",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        # OwnedByUserMixin — the single-tenant ownership boundary.
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("app_id", sa.Uuid(), nullable=False),
        sa.Column(
            "status",
            deployment_status,
            server_default="running",
            nullable=False,
        ),
        sa.Column("step", sa.String(length=32), server_default="claimed", nullable=False),
        sa.Column("head_sha", sa.String(length=40), nullable=True),
        sa.Column("image_digest", sa.String(length=80), nullable=True),
        sa.Column("acr_run_id", sa.String(length=64), nullable=True),
        sa.Column("container_app_name", sa.String(length=32), nullable=True),
        sa.Column("revision_name", sa.String(length=64), nullable=True),
        sa.Column("url", sa.String(length=2083), nullable=True),
        sa.Column("failure_code", sa.String(length=64), nullable=True),
        sa.Column("failure_detail", sa.Text(), nullable=True),
        sa.Column(
            "heartbeat_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.ForeignKeyConstraint(["app_id"], ["app_registry.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_deployments_user_id"), "deployments", ["user_id"], unique=False)
    op.create_index(op.f("ix_deployments_app_id"), "deployments", ["app_id"], unique=False)
    # The concurrency guard. `postgresql_where` is what makes it partial — without it this
    # would forbid an app from ever being deployed twice.
    op.create_index(
        "uq_deployments_one_in_flight",
        "deployments",
        ["app_id"],
        unique=True,
        postgresql_where=sa.text("status = 'running'"),
    )


def downgrade() -> None:
    op.drop_index("uq_deployments_one_in_flight", table_name="deployments")
    op.drop_index(op.f("ix_deployments_app_id"), table_name="deployments")
    op.drop_index(op.f("ix_deployments_user_id"), table_name="deployments")
    op.drop_table("deployments")
    deployment_status.drop(op.get_bind(), checkfirst=True)
