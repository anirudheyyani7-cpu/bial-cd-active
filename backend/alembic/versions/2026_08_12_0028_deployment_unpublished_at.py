"""record when a published app's container was taken down (unpublish)

Revision ID: 0028_deployment_unpublished_at
Revises: 0027_worker_passes
Create Date: 2026-08-12

WHY THIS EXISTS. No lever could take a published app down short of destroying the project: the
manual `disable` runbook needs `status == approved` (a self-deployed app stays `draft`), and the
sandbox reaper never sees it (publish writes nothing to the Redis registry it reads). Published
apps have no auth of their own, so this needed a real fast answer.

A NULLABLE TIMESTAMP, not a fourth `DeploymentStatus` (that enum's three states are load-bearing
for `uq_deployments_one_in_flight`): "is this app live" and "how did the last attempt end" are
different axes, and a `succeeded` deployment can be currently published or taken down either way.

Lives on the deployment ROW, not `app_registry` (as `classification` does in 0026): the newest
row is authoritative, which makes republish free — a later deploy is a NEW row with this column
NULL, so nothing about unpublishing needs undoing.

NEWEST ROW, NOT NEWEST SUCCEEDED ROW. The pipeline creates the container at step 5 and only THEN
awaits the revision, so a FAILED step-6 attempt can still name a live, billing container. The
kill-switch therefore resolves through `store.latest_for_app`, never `last_successful` — a stamp
on a FAILED row is exactly true: THIS attempt's container was torn down. Nullable and never
back-filled: every pre-existing row reads as "still published."
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision: str = "0028_deployment_unpublished_at"
down_revision: str | None = "0027_worker_passes"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "deployments",
        sa.Column("unpublished_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("deployments", "unpublished_at")
