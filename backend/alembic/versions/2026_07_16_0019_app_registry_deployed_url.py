"""record the deployed app's URL on app_registry

Revision ID: 0019_app_registry_deployed_url
Revises: 0018_app_registry_submissions
Create Date: 2026-07-16
One nullable column — `deployed_url` — completing 0018's manual-runbook marker
(`deployed_submission_id`/`deployed_at`): the superadmin pastes the go-live runbook's address
and the owner gets a "Live" link. DATA, not automation — nothing derives, probes, or verifies
it. Nullable because every existing row predates the column; `String(2083)` mirrors
`MAX_DEPLOYED_URL`/pydantic `HttpUrl`'s own `max_length`. `downgrade` drops the column and the
URLs with it, re-typed from the runbook, never reconstructed. Hand-finalized.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision: str = "0019_app_registry_deployed_url"
down_revision: str | None = "0018_app_registry_submissions"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column("app_registry", sa.Column("deployed_url", sa.String(length=2083), nullable=True))


def downgrade() -> None:
    op.drop_column("app_registry", "deployed_url")
