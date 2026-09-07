"""link attachments to their conversation

Revision ID: 0021_attachment_conv_link
Revises: 0020_drop_app_registry_name
Create Date: 2026-07-21

WHY THIS EXISTS. `attachments` had no link to anything but a client-minted token buried in a
message's `parts` JSONB — a file uploaded and never sent had no delete path and consumed the
owner's quota forever. This adds a nullable `conversation_id` FK, populated at upload time, as
a referential backstop for an orphan reclaimer.

The FK is `ON DELETE SET NULL`, deliberately NOT the `ON DELETE CASCADE` that
`conversations.project_id` uses: CASCADE would destroy the attachment ROW while its object-store
blob survives — manufacturing the permanent orphan this migration exists to prevent. Blob-aware
cleanup stays with `services/conversations/delete.py`.

NULL means *legacy* (existing rows, unbackfilled), never *never-sent* — eligibility is decided by
the `parts` reference scan. `downgrade` is a schema-only round-trip: it reconstructs no link data.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision: str = "0021_attachment_conv_link"
down_revision: str | None = "0020_drop_app_registry_name"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column("attachments", sa.Column("conversation_id", sa.Uuid(), nullable=True))
    op.create_index(
        op.f("ix_attachments_conversation_id"), "attachments", ["conversation_id"], unique=False
    )
    op.create_foreign_key(
        "attachments_conversation_id_fkey",
        "attachments",
        "conversations",
        ["conversation_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("attachments_conversation_id_fkey", "attachments", type_="foreignkey")
    op.drop_index(op.f("ix_attachments_conversation_id"), table_name="attachments")
    op.drop_column("attachments", "conversation_id")
