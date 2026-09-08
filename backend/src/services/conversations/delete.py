"""The commit-less core of a conversation delete, shared by the DELETE endpoint and
the project cascade-delete service.

`delete_conversation` used to sweep object-store blobs INLINE then delete rows, so a
commit failure left blobs destroyed while their rows rolled back. This core instead
deletes the attachment + conversation ROWS inside the caller's transaction and RETURNS
the object-store keys, so a rollback never destroys a blob a restored row still points
at; the caller commits, then best-effort sweeps those keys.

Attachment discovery reads the NATIVE payload: binaries externalize to
`{kind: "bial-attachment-ref", attachment_id}` markers, keyed by `ATTACHMENT_REF_KIND`.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession

from src.db.models.attachment import Attachment
from src.db.models.conversation import Conversation
from src.db.models.message import Message
from src.services.extract.office import PPTX_MEDIA_TYPE
from src.services.messages.store import ATTACHMENT_REF_KIND

# NOTE: a deck part's internal Files-API `pdfFileId` release is deferred with the Foundry
# hosting-mode decision (Azure-hosted Foundry has no Files API to release against; wire it
# here if Anthropic-hosted mode is confirmed).


def _collect_ref_ids(node: Any, ids: set[str]) -> None:
    """Walk one payload tree for attachment reference markers."""
    if isinstance(node, list):
        for item in node:
            _collect_ref_ids(item, ids)
    elif isinstance(node, dict):
        if node.get("kind") == ATTACHMENT_REF_KIND:
            ref = node.get("attachment_id")
            if isinstance(ref, str):
                ids.add(ref)
        for value in node.values():
            _collect_ref_ids(value, ids)


def _referenced_attachment_ids(payloads: Iterable[list[Any] | None]) -> set[str]:
    """Every attachmentId referenced by an externalized-binary marker across the given
    message payloads. The single-conversation and batched cascades — and the never-sent
    reclaimer — share this so their attachment discovery can never drift."""
    ids: set[str] = set()
    for payload in payloads:
        _collect_ref_ids(payload or [], ids)
    return ids


def _blob_keys_for(attachments: Iterable[Attachment]) -> list[str]:
    """The object-store keys to sweep for these attachment rows: each storage key plus, for
    a deck (PPTX) attachment, its derived `{key}.pdf` sibling."""
    blob_keys: list[str] = []
    for attachment in attachments:
        blob_keys.append(attachment.storage_key)
        if attachment.media_type == PPTX_MEDIA_TYPE:
            blob_keys.append(attachment.storage_key + ".pdf")
    return blob_keys


async def gather_and_delete_conversation(
    db: AsyncSession, conversation: Conversation, *, user_id: uuid.UUID
) -> list[str]:
    """Delete a conversation, its messages (DB `ON DELETE CASCADE`), and its attachment
    ROWS inside the caller's transaction; return the object-store keys (attachment blobs
    plus each deck attachment's derived `{key}.pdf` sibling) to sweep AFTER the caller
    commits. Commit-less: the caller owns both the commit and the post-commit blob sweep.
    Owner-scoped by `user_id` — attachments hang off `user_id`, not the
    conversation, so the caller must pass the owning user id, not trust the row."""
    payloads = (
        (
            await db.execute(
                sa.select(Message.payload).where(
                    Message.conversation_id == conversation.id, Message.user_id == user_id
                )
            )
        )
        .scalars()
        .all()
    )
    attachment_ids = _referenced_attachment_ids(payloads)

    blob_keys: list[str] = []
    if attachment_ids:
        attachments = (
            (
                await db.execute(
                    sa.select(Attachment).where(
                        Attachment.user_id == user_id,
                        Attachment.attachment_id.in_(attachment_ids),
                    )
                )
            )
            .scalars()
            .all()
        )
        blob_keys = _blob_keys_for(attachments)
        for attachment in attachments:
            await db.delete(attachment)

    # Delete the conversation; its messages cascade (FK ON DELETE CASCADE).
    await db.delete(conversation)
    return blob_keys


async def gather_and_delete_conversations(
    db: AsyncSession, conversation_ids: Sequence[uuid.UUID], *, user_id: uuid.UUID
) -> list[str]:
    """Batched multi-conversation variant for the project cascade: the SAME
    gather-before-delete ordering and `user_id` owner-scoping as the singular path, but with
    one messages SELECT and one attachments SELECT across ALL the project's conversations
    instead of a per-conversation N+1. GATHERS every blob key while the rows still resolve
    them, then set-based DELETEs the attachment and conversation rows (messages cascade at the
    DB level) — all inside the caller's transaction, so the caller's post-commit sweep still
    runs only after the rows are durably gone (rollback safety)."""
    if not conversation_ids:
        return []

    payload_rows = (
        (
            await db.execute(
                sa.select(Message.payload).where(
                    Message.conversation_id.in_(conversation_ids), Message.user_id == user_id
                )
            )
        )
        .scalars()
        .all()
    )
    attachment_ids = _referenced_attachment_ids(payload_rows)

    blob_keys: list[str] = []
    if attachment_ids:
        attachments = (
            (
                await db.execute(
                    sa.select(Attachment).where(
                        Attachment.user_id == user_id,
                        Attachment.attachment_id.in_(attachment_ids),
                    )
                )
            )
            .scalars()
            .all()
        )
        blob_keys = _blob_keys_for(attachments)
        await db.execute(
            sa.delete(Attachment).where(
                Attachment.user_id == user_id,
                Attachment.attachment_id.in_(attachment_ids),
            )
        )

    # Delete the conversations in one set-based statement; their messages cascade at the DB
    # level (FK ON DELETE CASCADE). The default synchronize_session evaluates the `id IN (…)`
    # predicate against the session so any loaded rows are expunged (parity with the singular
    # path's ORM `db.delete`), matching the project row's own set-based delete in the caller.
    await db.execute(
        sa.delete(Conversation).where(
            Conversation.id.in_(conversation_ids), Conversation.user_id == user_id
        )
    )
    return blob_keys
