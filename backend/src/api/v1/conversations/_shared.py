"""The turn plumbing the conversation routes run on.

The underscore in the FILE name marks it as internal to `api/v1` — it is plumbing, not a route
module — while every NAME it exports is public, because it genuinely has more than one caller:
the send route, the transition route, and the test fixtures that bind `chat_model` and
`billing_session_factory`.
"""

from __future__ import annotations

import base64
import re
import uuid
from collections.abc import Sequence
from typing import Annotated

import sqlalchemy as sa
from fastapi import Depends
from pydantic import Field, model_validator
from pydantic_ai import BinaryContent
from pydantic_ai.models import Model
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.config import settings
from src.core.errors import AppApiError
from src.db.base import async_session_factory
from src.db.models.conversation import Conversation
from src.schemas import CamelModel
from src.services.agent.model import build_foundry_model
from src.services.messages.store import (
    AttachmentRehydrationError,
    Rehydrator,
    attachment_rehydrator,
)
from src.services.storage import ObjectStorage, StorageUnconfiguredError, get_storage

# --- message bounds -----------------------------------------------------------------------
#
# Message-shape bounds. Generous by intent: a citizen developer pasting a long spec is normal
# traffic, and the real cost gate is the daily token limit, not a byte ceiling.
#
# THIS NUMBER SITS FAR ABOVE THE BROWSER'S OWN CAP ON PURPOSE, AND THEY ARE NOT TWO SPELLINGS
# OF ONE RULE. The composer caps what a person can TYPE, which is a courtesy — it stops
# someone pasting a novel and waiting to find out it was too much. This is the platform's own
# SAFETY limit on what may be stored, and the server keeps its own precisely so it does not
# inherit a number chosen for a text box: the handoff materialises a plan the browser never
# typed, and a build's first message is written by the server, not by a keyboard.
#
# Both halves are refusals, never trims. A message cut at a ceiling is one the citizen believes
# they sent whole, and the platform has no way to tell them otherwise afterwards.
#
# So: raising the browser cap toward this one is a decision, not a tidy-up, and lowering this
# one to match the browser would silently break the server-materialised paths. If you are here
# to collapse two numbers into one, that is the reason not to.
MAX_MESSAGE_TEXT_CHARS = 64_000
MAX_ATTACHMENT_TEXT_CHARS = 600_000

# THE FILE COUNT IS THE ONE EXCEPTION TO THE PARAGRAPH ABOVE, and #214 R7b is why it moved.
#
# That argument is about TEXT: the server writes messages nobody typed — the plan handoff, a
# build's first message — so its text ceiling must sit above a number chosen for a text box.
# None of those paths attaches a FILE. `TurnMessage` is constructed nowhere in `src/`; it only
# ever arrives from a browser, and the plan prompt says in words that the build chat receives no
# attachments. So the reason the two text numbers differ has never applied to this one, and it
# sat at 8 against a composer that offers 5 — the stricter number being the one that is not the
# trust boundary, which is the wrong way round.
#
# IT BOUNDS THE SUM, not each list, and that is the substance rather than the value. As two
# independent `max_length` bounds this admitted eight text blocks AND eight ids on one message —
# sixteen files against a browser cap of five. The check that makes it true is in
# `_bounded_and_non_empty`; the per-list bound stays as a cheap structural guard so a single
# oversized list is refused before the sum is computed.
MAX_FILES_PER_MESSAGE = 5

# The historical name, kept as the per-list structural bound. Equal to the total by
# construction: a single list may not exceed what the whole message may carry.
MAX_ATTACHMENT_BLOCKS = MAX_FILES_PER_MESSAGE

# An attachment id is a `secrets.token_urlsafe` value — never a path or a raw UUID.
ATTACHMENT_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")

# --- the build-in-flight refusal ------------------------------------------------------------
#
# Citizen copy — this text reaches the user verbatim in a 409 body. It says what is happening and
# when they get the chat back, and names nothing internal (no session, no mode, no lock).
#
# It lives HERE, beside the other shared plumbing, because more than one route refuses this way:
# the send route and the plan→build handoff. A gate that exists on only one of two live entry
# points is not a gate — it is a detour sign, which is the lesson the retired relay taught by
# needing its own copy of this constant.
BUILD_IN_FLIGHT_MSG = (
    "The assistant is building your app right now. Chat opens back up as soon as it finishes."
)

# What may enter the prompt as a BINARY: vision content only. Everything else travels as
# `attachment_texts`.
VISION_MEDIA_PREFIX = "image/"
PDF_MEDIA_TYPE = "application/pdf"

# --- the per-document limit, and why it is gone -------------------------------------------
#
# THERE IS NO DOCUMENT COUNT ANY MORE (#214 R7c). It was two, and it shipped in the batch-1
# burndown as the stopgap that stopped a 61-page PDF blowing the context budget (#194). The real
# fix was the 30-page cap and the flat charge sized to it; both stay. The count was the belt
# beside those braces.
#
# It goes because a citizen attaching five files should not have to know which of them the
# platform considers expensive. One rule governs every attachment on a message now —
# `MAX_FILES_PER_MESSAGE`, any mix of formats — the same reasoning that sends a spreadsheet to
# the code lane at every size rather than above a threshold.
#
# WHAT REPLACES IT IS NOT ANOTHER COUNT. A message the conversation cannot hold is refused on the
# room it needs, before it is sent (R10). The failure this guarded against was never really "too
# many documents": it was a citizen landing on a context-limit refusal whose only advice is to
# start a new chat, which then refuses the identical message.


# --- dependencies -------------------------------------------------------------------------

# The billing/agent session factory — a dependency (like storage) so tests bind it to the
# rolled-back test session instead of committing to the real DB.
BillingSessionFactory = async_sessionmaker[AsyncSession]


def chat_model() -> Model | None:
    """The Foundry-backed Pydantic AI model, or None when Foundry isn't configured (dev/test
    boot without it). A dependency so tests inject a `TestModel` via `dependency_overrides`."""
    if settings.foundry is None:
        return None
    return build_foundry_model(settings.foundry)


def billing_session_factory() -> BillingSessionFactory:
    """The session factory the disconnect-safe drain uses (its own session, decoupled from the
    request). A dependency so tests bind it to the rolled-back test session."""
    return async_session_factory


def chat_storage() -> ObjectStorage | None:
    """The object store, or None when unconfigured — NEVER an eager raising `Depends` (the
    eager-Depends learning: a raise here would 500 every text-only turn on a storage-less
    boot). The None arm fails IN-BODY, typed, exactly where refs are actually needed: sending
    an attachment id → 503; loading a history that carries stored references → the
    rehydrator's own typed failure."""
    try:
        return get_storage()
    except StorageUnconfiguredError:
        return None


ModelDep = Annotated[Model | None, Depends(chat_model)]
SessionFactoryDep = Annotated[BillingSessionFactory, Depends(billing_session_factory)]
StorageDep = Annotated[ObjectStorage | None, Depends(chat_storage)]


# --- the wire message ---------------------------------------------------------------------


class TurnMessage(CamelModel):
    """The new message — the ONLY content the browser sends.

    `attachment_texts` are complete, client-built `<attachment …>…</attachment>` fence blocks:
    inline text files (whose bytes are never uploaded) and office extractions (whose bytes are
    stored but never model-visible). They are opaque text to this route — fencing/neutralizing
    happened where the content was assembled, and redaction happens at the persistence seam.
    `attachment_ids` are owned references to STORED binaries (image/PDF), resolved to base64
    server-side at send."""

    text: str = Field(max_length=MAX_MESSAGE_TEXT_CHARS)
    attachment_texts: list[str] = Field(default_factory=list, max_length=MAX_ATTACHMENT_BLOCKS)
    attachment_ids: list[str] = Field(default_factory=list, max_length=MAX_ATTACHMENT_BLOCKS)

    @model_validator(mode="after")
    def _bounded_and_non_empty(self) -> TurnMessage:
        # ONE NUMBER FOR THE WHOLE MESSAGE, any mix of formats (#214 R7b). The two lists carry
        # the same thing from a citizen's point of view — files they attached — so counting them
        # apart let a message hold twice what the composer offered. A citizen should not have to
        # know which of their five files the platform files under which list.
        if len(self.attachment_texts) + len(self.attachment_ids) > MAX_FILES_PER_MESSAGE:
            raise ValueError(f"a message may carry at most {MAX_FILES_PER_MESSAGE} attachments")
        for block in self.attachment_texts:
            if len(block) > MAX_ATTACHMENT_TEXT_CHARS:
                raise ValueError("an attachment text block is too large")
        for attachment_id in self.attachment_ids:
            if not ATTACHMENT_ID_RE.fullmatch(attachment_id):
                raise ValueError("an attachment id is invalid")
        return self


# --- turn preparation ---------------------------------------------------------------------


async def resolve_conversation_or_404(
    db: AsyncSession, user_id: uuid.UUID, conversation_id: uuid.UUID
) -> Conversation:
    """The turn's owner-scoped conversation row. Conversations are created BEFORE the first turn
    (`POST /v1/conversations`), so there is no None arm to keep: an unknown id is a client bug, a
    cross-user id is indistinguishable from it, and both get the same non-leaking 404."""
    conversation: Conversation | None = await db.scalar(
        sa.select(Conversation).where(
            Conversation.id == conversation_id, Conversation.user_id == user_id
        )
    )
    if conversation is None:
        raise AppApiError(404, "Conversation not found.")
    return conversation


def history_rehydrator(
    db: AsyncSession, storage: ObjectStorage | None, user_id: uuid.UUID
) -> Rehydrator:
    """The rehydrator `load_history` swaps stored reference markers through. With storage
    unconfigured it fails TYPED — and only if the history actually carries a reference, so a
    text-only conversation on a storage-less boot keeps working."""
    if storage is not None:
        return attachment_rehydrator(db, storage, user_id)

    async def unconfigured(attachment_ids: Sequence[str]) -> dict[str, tuple[str, str]]:
        if not attachment_ids:
            return {}
        raise AttachmentRehydrationError(
            "an attached file could not be read (file storage is not configured)"
        )

    return unconfigured


async def resolve_binaries(
    db: AsyncSession, storage: ObjectStorage | None, user_id: uuid.UUID, attachment_ids: list[str]
) -> list[BinaryContent]:
    """Owned attachment refs → base64-backed `BinaryContent` for the model prompt. Rides the
    store's own rehydrator — owner-scoped row, magic re-check, authoritative media type — then
    gates on WHAT may enter the prompt: only image/PDF vision content. Office originals and
    anything else are a 400 (their content travels as `attachmentTexts`), and an unknown/foreign
    id fails the same typed way the rehydrator words it.

    It no longer counts documents. That gate was `MAX_PDF_BLOCKS`, removed by #214 R7c — one
    file count now governs every format, and the room a message needs is checked before it is
    sent rather than by refusing a second PDF here."""
    if not attachment_ids:
        return []
    if storage is None:
        raise AppApiError(503, "File storage is not configured.")
    rehydrate = attachment_rehydrator(db, storage, user_id)
    try:
        resolved = await rehydrate(attachment_ids)
    except AttachmentRehydrationError as exc:
        raise AppApiError(400, str(exc)) from None
    binaries: list[BinaryContent] = []
    for attachment_id in attachment_ids:
        data_b64, media_type = resolved[attachment_id]
        if not (media_type.startswith(VISION_MEDIA_PREFIX) or media_type == PDF_MEDIA_TYPE):
            raise AppApiError(
                400,
                "an attached file of this type cannot be sent to the assistant as a file; "
                "its extracted text travels with the message instead",
            )
        binaries.append(
            BinaryContent(
                data=base64.b64decode(data_b64), media_type=media_type, identifier=attachment_id
            )
        )
    return binaries


def prompt_content(
    message: TurnMessage, binaries: list[BinaryContent]
) -> str | list[str | BinaryContent]:
    """The turn's user content: binaries first, fenced attachment text next, the typed prose
    LAST (Anthropic's documented files-before-text vision ordering — the shape the deleted
    `BuildSpec` also pinned). A plain text-only message stays a bare string (the historical
    single-string shape)."""
    if not binaries and not message.attachment_texts:
        return message.text
    return [*binaries, *message.attachment_texts, message.text]
