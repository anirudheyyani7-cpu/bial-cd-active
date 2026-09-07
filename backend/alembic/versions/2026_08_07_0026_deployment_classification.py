"""record the data-classification declaration that authorised each deploy

Revision ID: 0026_deployment_classification
Revises: 0025_deployments
Create Date: 2026-08-07

One-click publish is gated on a six-question data-classification questionnaire; at or above
the score threshold the deploy proceeds with no human in the loop, which makes the answers
the only thing standing between a generated app and production.

WHY THIS EXISTS: two columns, not one. `classification` is the JSONB declaration, keyed by
the questionnaire's own field names (booleans would make every wording change a schema
conversation); `classification_score` is the total that actually authorised the deploy,
STORED rather than recomputed, because recomputing later would report what TODAY's weights
say about an OLD declaration — silently rewriting the reason a past deploy was allowed.
PER DEPLOY, NOT PER APP: the agent edits the app between deploys, so a declaration on
`app_registry` would keep describing a version no longer running. Both columns are nullable
and deliberately NOT back-filled — `NULL` means "never asked" (true for pre-gate rows); an
all-False default would claim a declaration nobody made. A refused deploy writes NOTHING:
the gate runs before the claim, so refusal has no deployment to attach to and is audited
(`audit_log`, action `deploy`) instead.

Hand-finalized.
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0026_deployment_classification"
down_revision: str | None = "0025_deployments"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "deployments",
        sa.Column("classification", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column("deployments", sa.Column("classification_score", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("deployments", "classification_score")
    op.drop_column("deployments", "classification")
