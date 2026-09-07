"""The `project_databases` table — one row per project that has (or is getting) its own
PostgreSQL database and login role.

A dedicated table, not columns on `projects`: absence is clean (no row = never provisioned); the
row doubles as the CONCURRENCY CLAIM (`INSERT ... ON CONFLICT DO NOTHING RETURNING` on
`project_id` elects one racer for the external DDL); the encrypted password stays off the row
every listing selects.

`db_ready` is the TERMINAL marker, committed LAST after every external step succeeds — a crash
mid-sequence must read as not-ready so the next ensure re-runs it whole; flipped early it would
claim a wall that does not exist. `db_name`/`role_name` are STORED, not derived, so teardown
outlives a derivation change.

WHY THIS EXISTS. No `OwnedByUserMixin` here: `projects` is the ownership anchor, so every
user-facing query reaches this table through a join — the `user_id` predicate lives there and is
never dropped here.
"""

from __future__ import annotations

import uuid
from datetime import datetime

import sqlalchemy as sa
from sqlalchemy.orm import Mapped, mapped_column

from src.db.base import Base
from src.db.mixins import TimestampMixin, UUIDv7PrimaryKeyMixin

# PostgreSQL's identifier cap. The derived names are 40/41 chars (`names.py`), so the
# column is sized to the server's own ceiling rather than to today's prefix.
MAX_PG_IDENTIFIER = 63


class ProjectDatabase(UUIDv7PrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "project_databases"

    # One database per project, forever — this constraint IS the claim that serializes
    # concurrent provisioning (`ON CONFLICT ON CONSTRAINT ... DO NOTHING`).
    __table_args__ = (sa.UniqueConstraint("project_id", name="uq_project_databases_project"),)

    project_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid,
        sa.ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    # The provisioned database and its owning login role, as actually created.
    db_name: Mapped[str] = mapped_column(sa.String(MAX_PG_IDENTIFIER), nullable=False)
    role_name: Mapped[str] = mapped_column(sa.String(MAX_PG_IDENTIFIER), nullable=False)
    # Fernet token for the role's password (`services/appdb/secrets.py`). Encrypted at rest
    # because one role serves BOTH the sandbox and the deployed app, so it cannot be reset
    # on demand without cutting the live deployment off; reset survives only as the
    # deliberate rotation/leak-response lever. Text, not LargeBinary: a Fernet token is
    # urlsafe-base64 ASCII, and text keeps it greppable-out-of-a-dump-free of encoding games.
    password_encrypted: Mapped[str] = mapped_column(sa.Text, nullable=False)
    # THE terminal marker. False = the external sequence has not completed; the next ensure
    # re-runs all of it. Never set in the same commit as the claim.
    db_ready: Mapped[bool] = mapped_column(
        sa.Boolean, nullable=False, server_default=sa.text("false")
    )
    # Stamped in the same UPDATE that flips `db_ready`; NULL until then.
    provisioned_at: Mapped[datetime | None] = mapped_column(
        sa.DateTime(timezone=True), nullable=True
    )
