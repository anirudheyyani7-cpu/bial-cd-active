"""The `attachments` table — one row per uploaded image/PDF.

Bytes live in the object store under an owner-scoped key (`att/{user_id}/{uuid}` via
`attachment_key`); this row is the metadata + the per-user quota ledger. Express kept NO
per-attachment doc — only a per-user byte counter (`attachment_usage`) that could drift;
summing `size` here cannot.

The SPA references an attachment by its CLIENT-MINTED `attachment_id` token (Express `ID_RE`,
e.g. `att_<ts>_<rand>` — NOT necessarily a UUID) in message parts and GET/DELETE URLs, so that
token is a separate unique-per-owner column; the UUIDv7 PK is what the traversal-safe object key
is built from.
"""

from __future__ import annotations

import uuid

import sqlalchemy as sa
from sqlalchemy.orm import Mapped, mapped_column

from src.db.base import Base
from src.db.mixins import OwnedByUserMixin, TimestampMixin, UUIDv7PrimaryKeyMixin

# Bounds the client-supplied display name (mirrors `project.MAX_PROJECT_NAME`). Enforced
# at the upload boundary — an over-long name is a 400 there, never a DB-level 500.
MAX_ATTACHMENT_NAME = 512


class Attachment(UUIDv7PrimaryKeyMixin, TimestampMixin, OwnedByUserMixin, Base):
    __tablename__ = "attachments"

    # The client-minted external id is unique per owner (a re-upload of the same id is
    # idempotent — reuses the row + object key rather than orphaning).
    __table_args__ = (
        sa.UniqueConstraint("user_id", "attachment_id", name="uq_attachments_owner_attachment"),
    )

    # The client token the SPA addresses (Express `ID_RE` — bounded, not a UUID).
    attachment_id: Mapped[str] = mapped_column(sa.String(128), nullable=False, index=True)
    media_type: Mapped[str] = mapped_column(sa.String(255), nullable=False)
    name: Mapped[str] = mapped_column(
        sa.String(MAX_ATTACHMENT_NAME), nullable=False, server_default=""
    )
    # Decoded byte count (trusted from the bytes, never a client-claimed size). BigInteger
    # so the per-user SUM over many files never overflows.
    size: Mapped[int] = mapped_column(sa.BigInteger, nullable=False)
    # The object-store key where the bytes live. Stored (not recomputed) so the pointer is
    # explicit and a backfill can carry an existing Express key (`att/{username}/{token}`).
    # Because it is stored rather than derived, download and delete re-check it with
    # `assert_owned` before handing it to the store — owning the ROW says nothing about where
    # the key it carries points.
    storage_key: Mapped[str] = mapped_column(sa.String(512), nullable=False)
    # The conversation this upload was stamped to at upload time — the candidate
    # narrowing + row backstop the never-sent reclaimer needs. NULLABLE and `ON DELETE SET
    # NULL`, DELIBERATELY not the `ON DELETE CASCADE` that `conversations.project_id` uses:
    # CASCADE would destroy this row while its blob survives — the exact permanent orphan the
    # reclaimer exists to prevent. Blob-aware cleanup runs through `conversations/delete.py`;
    # this FK is only a row backstop that NULLs a dangling link. A NULL link means *legacy*
    # (existing rows, or a client that sends no conversationId), NEVER *never-sent* — the
    # reclaimer decides eligibility by the `parts` reference scan, not by this column.
    conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.Uuid,
        sa.ForeignKey("conversations.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
