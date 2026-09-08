"""a standing rejection that outlives the status it was read from

Revision ID: 0032_rejection_standing
Revises: 0031_token_usage_kind
Create Date: 2026-08-20

WHY THIS EXISTS: A COLUMN, NOT A STATUS READ. Ladder rule 5 — "a rejection is sticky: an
administrator lifts it, a re-roll never" — was derived from mutable `status`: Publish on
a REJECTED app moves it to PENDING and nulls `rejection_note`, and withdraw moves PENDING
to DRAFT, so the row carries no trace a rejection happened and the next clean Publish goes
out unattended — precisely what this rule forbids.

`rejection_standing` separates WHERE the app is in its lifecycle (`status`, which
withdraw may move) from HAS A HUMAN REFUSED IT (this flag, cleared only by an
administrator). `reject` raises it, `approve` lowers it; nothing citizen-side touches it.

BACKFILL covers every row sitting in `rejected` today — the whole of what cutover can
know, since an already re-submitted or withdrawn row left no durable trace to recover.
Those rows keep today's wrong behaviour until rejected again, and nothing worse is
invented by guessing. NOT NULL with a constant server default is metadata-only on PG11+,
kept so a hand-run statement during an incident reads "not rejected" rather than fails.
No downgrade/upgrade round-trip test, following 0030: it burns pg_attribute slots on the
shared test database forever, so the backfill is exercised directly instead.
Hand-finalized.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision: str = "0032_rejection_standing"
down_revision: str | None = "0031_token_usage_kind"
branch_labels: str | None = None
depends_on: str | None = None

# As ONE statement so the test suite can execute EXACTLY what runs here. `status =
# 'rejected'` is the only durable evidence of a refusal that survives to cutover;
# `rejection_standing = false` keeps it idempotent and blind to anything already raised.
BACKFILL_STANDING_REJECTIONS = sa.text(
    "UPDATE app_registry SET rejection_standing = true "
    "WHERE rejection_standing = false AND status = 'rejected'"
)


def upgrade() -> None:
    op.add_column(
        "app_registry",
        sa.Column(
            "rejection_standing",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.execute(BACKFILL_STANDING_REJECTIONS)


def downgrade() -> None:
    op.drop_column("app_registry", "rejection_standing")
