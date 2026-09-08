"""the outcomes that count as success here, counted where an operator can read them

Revision ID: 0033_harness_counters
Revises: 0032_rejection_standing
Create Date: 2026-08-23

WHY THIS EXISTS: there is no metrics system in this deployment, so an outcome is
observable only if the platform writes it down — this is the relational half (the
pinned structlog events in `services/build_sessions/alarms.py` are the other).

A NAME/VALUE ROW, NOT A COLUMN PER COUNTER: a counter that needs a schema change to
exist is a counter that does not get added; with the name as a column, a new counter
is an INSERT. NOT USER-SCOPED, following `worker_passes`'s precedent — these are
deployment properties, not a citizen's, and hold no user data. `app_id`/`build_id`
carry NO foreign key deliberately: a count is a historical fact that must survive its
app being deleted, which is precisely when someone wants to read it.

`served_head` is folded in here (not its own table) because it is only ever read
beside the verdict it explains, already scrubbed/capped at the container boundary.

THE ONLY ALEMBIC REVISION IN EITHER PLAN — a later one chains onto this head and
updates the pinned string in `tests/db/test_suspended_at_migration.py`.

Hand-finalized."""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0033_harness_counters"
down_revision = "0032_rejection_standing"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "harness_counts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(length=64), nullable=False),
        # BIGINT rather than INTEGER: one of these counters is milliseconds and another is
        # tokens, and a 32-bit ceiling on a running total is the kind of thing nobody notices
        # until the day it wraps.
        sa.Column("value", sa.BigInteger(), nullable=False, server_default="1"),
        sa.Column("app_id", sa.Uuid(), nullable=True),
        sa.Column("build_id", sa.Uuid(), nullable=True),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("served_head", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("ix_harness_counts_name", "harness_counts", ["name"])
    op.create_index("ix_harness_counts_app_id", "harness_counts", ["app_id"])
    op.create_index("ix_harness_counts_build_id", "harness_counts", ["build_id"])
    op.create_index("ix_harness_counts_occurred_at", "harness_counts", ["occurred_at"])


def downgrade() -> None:
    op.drop_index("ix_harness_counts_occurred_at", table_name="harness_counts")
    op.drop_index("ix_harness_counts_build_id", table_name="harness_counts")
    op.drop_index("ix_harness_counts_app_id", table_name="harness_counts")
    op.drop_index("ix_harness_counts_name", table_name="harness_counts")
    op.drop_table("harness_counts")
