"""add the classification_reviews table for the pre-publish AI review

Revision ID: 0029_classification_reviews
Revises: 0028_deployment_unpublished_at
Create Date: 2026-08-19

WHY THIS EXISTS: the pre-publish review reads an app's last saved code and pre-fills six
data-classification questions; ONE row per app, upserted, stamped with the commit it read
(`head_sha`). Opposite shape from `deployments` (append-only, 0025) deliberately — a review
is only ever a claim about the CURRENT saved version, overwritten wholesale when the version
moves, the stamp making staleness detectable. Durable history lives in the per-run/per-publish
audit records, not here.

`uq_classification_reviews_app` is the one-row-per-app invariant AND the `ON CONFLICT`
inference target, settling the fresh-insert race in Postgres (a restart mid-run can open two
dialogs — same reasoning as `uq_deployments_one_in_flight`).

`attempt` counts runs claimed for the stamped version (reset on version change, incremented
on retry) — the review bypasses the daily token gate, so its real spend bound is the
service-layer cap of three model runs per version, enforceable only against a faithful counter.

verdict/evidence is JSONB for the same reason as `deployments.classification` (0026): the
questionnaire will be reworded/reweighted, and a column-per-question shape would mean a
schema migration every time. Hand-finalized.
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0029_classification_reviews"
down_revision: str | None = "0028_deployment_unpublished_at"
branch_labels: str | None = None
depends_on: str | None = None

# The native classification_review_status enum. create_type=False so THIS
# migration owns the lifecycle: explicit .create() in upgrade, .drop() in downgrade.
classification_review_status = postgresql.ENUM(
    "running",
    "complete",
    "failed",
    name="classification_review_status",
    create_type=False,
)


def upgrade() -> None:
    classification_review_status.create(op.get_bind(), checkfirst=True)
    op.create_table(
        "classification_reviews",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        # OwnedByUserMixin — the single-tenant ownership boundary.
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("app_id", sa.Uuid(), nullable=False),
        # The version stamp: the commit the review read. NOT NULL — a row without a
        # stamp is exactly the un-datable answer this table exists to prevent.
        sa.Column("head_sha", sa.String(length=40), nullable=False),
        sa.Column(
            "status",
            classification_review_status,
            server_default="running",
            nullable=False,
        ),
        sa.Column("attempt", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("verdicts", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("evidence", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("answers_complete", sa.Boolean(), nullable=True),
        sa.Column("failure_code", sa.String(length=64), nullable=True),
        sa.Column("failure_detail", sa.Text(), nullable=True),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        # The four raw token classes, kept split and never re-folded (the documented
        # cache double-count regression) — same discipline as token_usage (0004).
        sa.Column("input_tokens", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("output_tokens", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "cache_read_tokens", sa.BigInteger(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column(
            "cache_write_tokens", sa.BigInteger(), server_default=sa.text("0"), nullable=False
        ),
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
        # ONE ROW PER APP — the whole design, and the claim's conflict target.
        sa.UniqueConstraint("app_id", name="uq_classification_reviews_app"),
    )
    op.create_index(
        op.f("ix_classification_reviews_user_id"),
        "classification_reviews",
        ["user_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_classification_reviews_user_id"), table_name="classification_reviews")
    op.drop_table("classification_reviews")
    classification_review_status.drop(op.get_bind(), checkfirst=True)
