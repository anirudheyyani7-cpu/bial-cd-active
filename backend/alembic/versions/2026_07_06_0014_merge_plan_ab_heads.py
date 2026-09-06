"""merge two divergent migration heads

Revision ID: 0014_merge_plan_ab_heads
Revises: 0007_attachments, 0013_clear_data_token
Create Date: 2026-07-06

Reconciles the two Alembic tips from parallel migration work: one chain ends at
``0007_attachments``, the other at ``0013_clear_data_token``, both branching off
``0003_audit_logs``. Without this merge, ``alembic upgrade head`` fails with
"Multiple head revisions are present". Pure merge revision, no schema change;
the single-head invariant is guarded by ``tests/test_alembic_single_head.py``.
"""

from __future__ import annotations

revision: str = "0014_merge_plan_ab_heads"
down_revision: tuple[str, str] = ("0007_attachments", "0013_clear_data_token")
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    """No-op: this revision only reconciles two divergent heads into one."""


def downgrade() -> None:
    """No-op: reverting re-exposes the two independent heads."""
