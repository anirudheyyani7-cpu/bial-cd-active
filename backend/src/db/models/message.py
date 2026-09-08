"""The `messages` table — one row per persisted NATIVE pydantic-ai batch.

Rebuilt in place by migration 0024 (destructive reset). One row per batch: a Plan-chat turn, a
Build-chat step (crash-safe per step), or a system/lifecycle entry. `payload` is 100% native
`ModelMessagesTypeAdapter` serialization except attachment externalization and secret redaction
(`services/messages/store.py`).

WHY THIS EXISTS — classification lives on the ROW, never in the payload: verified against pinned
pydantic-ai 2.5.0, `UserPromptPart` has no metadata field, an unknown dict silently coerces to
`CachePoint` at the TypeAdapter boundary, and `ModelRequest.metadata` is droppable by upstream's
own history merge. `entry_kind`/`visibility` are SQL predicates instead, filtered by WHERE clause.

`seq` is the server-owned gap-free ordering key (the store's two-writer retry, never a client).
`schema_version` stamps the wire contract; `meta` carries system-entry metadata row-side.
"""

from __future__ import annotations

import uuid
from enum import StrEnum
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from src.db.base import Base
from src.db.mixins import OwnedByUserMixin, TimestampMixin, UUIDv7PrimaryKeyMixin
from src.db.models.conversation import ChatKind, chat_kind_enum


class MessageEntryKind(StrEnum):
    """What kind of batch this row holds. Native PG enum labels.
    * `turn` — a whole Plan-chat turn (user prompt + the run's new messages).
    * `step` — one Build-chat agent step (BRAIN persists per step for crash durability).
    * `system_event` — a lifecycle record (build outcome, provision/quota/stop events).

    THE RETIRED `mode_switch` LABEL: a hidden marker for the old mode-switch endpoint, deleted
    in revision 0035 (a chat's kind is now fixed at creation). The PG label stays, inert —
    removing it would rewrite the largest table for nothing."""

    TURN = "turn"
    STEP = "step"
    SYSTEM_EVENT = "system_event"


class MessageVisibility(StrEnum):
    """Whether the UI projection renders this row. The MODEL sees hidden rows (the history
    loader ignores this column); only projection/display reads filter on it."""

    VISIBLE = "visible"
    HIDDEN = "hidden"


# Native PG enums, shared by the model columns and migration 0024 (`create_type=False` — the
# migration owns CREATE/DROP TYPE). Mirrors `chat_kind_enum`.
message_entry_kind_enum = sa.Enum(
    MessageEntryKind,
    name="message_entry_kind",
    values_callable=lambda enum: [member.value for member in enum],
    create_type=False,
)

message_visibility_enum = sa.Enum(
    MessageVisibility,
    name="message_visibility",
    values_callable=lambda enum: [member.value for member in enum],
    create_type=False,
)


class Message(UUIDv7PrimaryKeyMixin, TimestampMixin, OwnedByUserMixin, Base):
    __tablename__ = "messages"

    __table_args__ = (
        # `seq` is the SOLE per-conversation ordering key — unique so a two-writer collision
        # is a caught IntegrityError the store retries, never silent ordering corruption.
        sa.UniqueConstraint("conversation_id", "seq", name="uq_messages_conversation_seq"),
    )

    # FK to the owning conversation; a deleted conversation cascades its messages away.
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Server-owned, gap-free per-conversation ordering key (max+1 under the unique constraint's
    # protection — `services/messages/store.py` owns allocation and its retry loop).
    seq: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    # The payload serialization contract version (1 = pydantic-ai 2.5.0 native batch with
    # attachment-ref externalization). Bump on any wire-shape-affecting upgrade.
    schema_version: Mapped[int] = mapped_column(
        sa.Integer, server_default=sa.text("1"), nullable=False
    )
    entry_kind: Mapped[MessageEntryKind] = mapped_column(message_entry_kind_enum, nullable=False)
    visibility: Mapped[MessageVisibility] = mapped_column(
        message_visibility_enum,
        nullable=False,
        server_default=sa.text("'visible'::message_visibility"),
    )
    # Which kind of chat the batch ran under — an AUDIT stamp, and deliberately kept even
    # though nothing under `src/` reads it for a decision any more (the per-row stamp is named
    # in as many words, and "what was this row written under" is cheap to keep and impossible
    # to reconstruct later). Renamed from `mode` by revision 0035 rather than reused under the
    # old name: leaving a column called `mode` behind is how a deleted vocabulary survives.
    kind: Mapped[ChatKind] = mapped_column(chat_kind_enum, nullable=False)
    # The native batch: `ModelMessagesTypeAdapter.dump_python(mode="json")` output, with
    # `BinaryContent` externalized to attachment references and secrets redacted. A list of
    # ModelMessage dicts; may be empty for a pure lifecycle entry.
    payload: Mapped[list[Any]] = mapped_column(JSONB, nullable=False)
    # System-entry metadata (build sessionId / startedSeq / previewUrl / status / reason…) —
    # OUTSIDE the payload so the payload stays pure native. NULL for ordinary turns/steps.
    meta: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
