"""drop app_registry.current_code — its one remaining reader is gone (#191)

Revision ID: 0039_drop_current_code
Revises: 0038_app_previous_status
Create Date: 2026-09-08

`current_code` was code continuity's original store (KD-9, R21), but the seed-on-open /
write-back-on-build pair it was built for died with the `conversations.code` column in
migration 0024 — code truth moved to the sandbox's file tree and the build snapshots, and
`test_code_continuity.py` already pinned this column as write-less ("submit deliberately
does not backstop it either"). The column survived that migration only because it still had
ONE reader: `services/projects/describe.py`, the project-description generator reached
through `POST /{project_id}/description:generate`. #191 deletes that endpoint outright
(superseding #27 rather than fixing it — #27's own options both kept the endpoint working,
this does not) as part of making project descriptions required and author-written. With that
reader gone, the column has neither a writer nor a reader and nothing left to justify keeping
it.

DESTRUCTIVE + SCHEMA-ONLY ROUND-TRIP, mirroring 0020's own `app_registry` column drop:
`downgrade` recreates the column's STRUCTURE (`JSONB`, nullable), not its data. Any code a row
still carried in `current_code` is gone on the drop and is NOT reconstructed on downgrade —
consistent with `test_code_continuity.py`'s own finding that the column reads as `NULL` for
every project built on this branch, since nothing has written it since 0024.
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "0039_drop_current_code"
down_revision: str | None = "0038_app_previous_status"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.drop_column("app_registry", "current_code")


def downgrade() -> None:
    op.add_column(
        "app_registry",
        sa.Column("current_code", JSONB(), nullable=True),
    )
