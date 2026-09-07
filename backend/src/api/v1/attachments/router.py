"""Attachment HTTP endpoints — image/PDF upload / download / delete.

Byte-matches the Express `/api/attachments` contract (`server/attachments.js`): one base64
file per request, server-side allowlist + magic-byte validation, a 4 MB per-file cap, a 50 MB
per-user byte quota, object keys scoped by `user_id` and re-guarded with `assert_owned`, and
the `{error:{message}}` / `{ok:true}` envelopes. Text is never uploaded (it travels inline);
office and deck uploads take their own branches, rendered to a form the model can read before
anything is stored.

A PDF is additionally admitted by PAGE COUNT (`MAX_PDF_PAGES`) — bytes cannot stand in for
pages, and the window charge a document carries is sized to the cap rather than to its size.
"""

from __future__ import annotations

import base64
import binascii
import re
import uuid
from typing import Annotated, Any, Final

import sqlalchemy as sa
import structlog
from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse

from src.api.deps import CurrentUser, DbSession
from src.api.v1.attachments.schemas import UploadResponse

# The one media type admitted and charged as a document. Imported rather than re-spelled:
# `_shared.resolve_binaries` is what decides a stored ref IS a document, so a second copy here
# could drift from the definition the send route actually enforces.
from src.api.v1.conversations._shared import PDF_MEDIA_TYPE
from src.core.errors import AppApiError
from src.db.models.attachment import MAX_ATTACHMENT_NAME, Attachment
from src.db.models.conversation import Conversation
from src.db.models.user import User
from src.schemas import AUTH_401, ErrorEnvelope, OkResponse, error_responses
from src.services.extract.deck import (
    DeckConvertError,
    convert_deck_to_pdf,
    deck_attachments_enabled,
)
from src.services.extract.office import (
    OFFICE_MEDIA_TYPES,
    PPTX_MEDIA_TYPE,
    office_format_for,
)
from src.services.extract.zip_safety import FileParseError
from src.services.media.magic import ALLOWED_MEDIA, magic_matches
from src.services.parse.governor import run_parse
from src.services.ratelimit import rate_limit
from src.services.storage import (
    ObjectStorage,
    StorageError,
    StorageNotFoundError,
    assert_owned,
    attachment_key,
    get_storage,
)

logger = structlog.get_logger()

router = APIRouter(prefix="/attachments", tags=["attachments"])

# Client-minted attachment id shape (Express `ID_RE`) — a safe object-key token.
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")

# Per-file decoded cap (Express `ATTACHMENT_MAX_BYTES`) and per-user total (Express
# `ATTACHMENT_TOTAL_CAP`), plus the request-body ceiling (Express mount `limit:'6mb'`).
ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024
ATTACHMENT_TOTAL_CAP = 50 * 1024 * 1024
_BODY_LIMIT_BYTES = 6 * 1024 * 1024


MAX_PDF_PAGES: Final = 30
"""How long a document may be, in pages, and the byte cap above cannot express it.

A text PDF runs about 1.3 KB a page and a scanned one about 300 KB, so the same 4 MB spans
roughly 13 pages to 3,200. The document that pushed a conversation to 77% of its hard context
limit was 79 KB — comfortably inside every size bound the platform had.

THE NUMBER IS PAIRED WITH `usage/context_window.NOMINAL_PDF_TOKENS`, which charges every
admitted PDF what the LARGEST admissible one costs (~2,500 tokens a page, measured). Raising
this cap without raising that charge re-opens exactly the hole it closes: a document admitted
here that the window guard cannot honestly cover. Thirty pages covers the large majority of
business documents and still leaves room for a document plus a real build conversation."""

PDF_TOO_LONG_TEXT: Final = (
    f"That document is too long to work with. Try one under {MAX_PDF_PAGES} pages."
)
"""The ONE sentence every failure of the page check gives the citizen.

IT IS ONE SENTENCE FOR THREE OUTCOMES — over the cap, unreadable, and too slow to read — and
that is a decision, not an oversight. There is nothing true and useful the platform can tell
someone about a PDF it could not read, and any second sentence would have to reach for the
vocabulary this one exists to keep out: page objects, parsers, cross-reference tables, bytes.
The real cause is logged server-side, which is where an operator can act on it: the citizen
gets the sentence and no internals, the log gets the detail.

It is built from `MAX_PDF_PAGES` so the number a citizen is told and the number enforced cannot
drift apart."""

PDF_TOO_LONG_CODE: Final = "PDF_TOO_LONG"
"""The machine-readable code beside `PDF_TOO_LONG_TEXT`, so a client can branch on the page
cap without string-matching prose."""

PDF_LOCKED_TEXT: Final = (
    "That document is password-protected. Remove the password and upload it again."
)
"""THE ONE PDF FAILURE THE CITIZEN CAN ACT ON, so it is the one that does not get the sentence
above. A locked document is a fact about THEIR file, not about the platform — and telling
someone holding a three-page locked invoice that it is "too long to work with, try one under 30
pages" is advice that cannot be followed. They would shorten the document and be refused again,
learning nothing. `attachmentInput.ts` already records this rule for the format refusals:
advice is only honest while it leads somewhere.

It names no parser, no encryption scheme and no internal state, so it keeps the property the
collapsed sentence exists for."""

PDF_LOCKED_CODE: Final = "PDF_ENCRYPTED"
"""Mirrors `parse/parsers.py::PDF_ENCRYPTED_CODE` — the child raises it, this route maps it."""

# The allowlist + magic-byte prefixes live in `src.services.media.magic` — the SINGLE source of
# truth shared with every other path that can put bytes in front of the model, so a block the
# upload path would reject cannot slip in through one of them. `ALLOWED_MEDIA` / `magic_matches`
# imported above.

# Attachment limiter (Express: ~30/min, POST + DELETE only; GET is never limited).
ATTACHMENT_RATE_LIMIT = 30
ATTACHMENT_RATE_WINDOW_SECONDS = 60


def storage_dependency() -> ObjectStorage:
    """The configured object store. A dependency (not a bare `get_storage()` at the callsite)
    so tests override it with an in-memory fake via `dependency_overrides`."""
    return get_storage()


async def _attachment_rate_key(user: CurrentUser) -> str:
    return f"attachment:{user.id}"


_attachment_limiter = rate_limit(
    _attachment_rate_key,
    limit=ATTACHMENT_RATE_LIMIT,
    window_seconds=ATTACHMENT_RATE_WINDOW_SECONDS,
    message="Too many attachment requests. Please slow down.",
)

# Every attachments route authenticates via `current_user` (bare HTTPException 401 ->
# `{"detail"}`), so each documents 401 via the shared `AUTH_401` (DetailBody) spec.

Storage = Annotated[ObjectStorage, Depends(storage_dependency)]


def _validate_attachment_bytes(media_type: str, b64: Any) -> str | None:
    """Validate an image/PDF upload against the allowlist + magic bytes (+ WebP form-type),
    matching Express `validateAttachmentBytes`. Returns the error string, or None if valid."""
    if not isinstance(b64, str) or not b64:
        return "Invalid attachment: missing bytes."
    magic = ALLOWED_MEDIA.get(media_type)
    if magic is None:
        return f"Unsupported attachment type: {media_type}. Allowed: PNG, JPEG, GIF, WebP, PDF."
    # 24 base64 chars → 18 bytes: enough for any magic prefix + the WebP form-type at offset 8.
    try:
        prefix = base64.b64decode(b64[:24])
    except (binascii.Error, ValueError):  # fmt: skip  # ruff py314 strips parens
        prefix = b""
    if not magic_matches(prefix, magic):
        return f"Attachment bytes do not match the declared type {media_type}."
    if media_type == "image/webp" and prefix[8:12] != b"WEBP":
        return "Attachment bytes do not match the declared type image/webp."
    return None


def _attachment_name(value: Any) -> str:
    """The client-supplied display name. Absent (or `null`) → `""`, the column's defined default
    — name is optional. A PRESENT non-string is a client bug: coercing it stored a nameless
    attachment and silently lost the filename the SPA renders. Over-long is rejected HERE —
    the column is `String(MAX_ATTACHMENT_NAME)`, so letting it through 500s at the DB."""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise AppApiError(400, "name must be a string.")
    if len(value) > MAX_ATTACHMENT_NAME:
        raise AppApiError(400, f"name must be at most {MAX_ATTACHMENT_NAME} characters.")
    return value


def _sniff_media_type(data: bytes) -> str | None:
    """Reverse-lookup the media type from the magic bytes (only allowlisted/validated bytes
    are ever stored), matching Express `sniffMediaType`. None → application/octet-stream."""
    for media, magic in ALLOWED_MEDIA.items():
        if magic_matches(data, magic):
            if media == "image/webp" and data[8:12] != b"WEBP":
                continue
            return media
    return None


async def _resolve_conversation_link(
    db: DbSession, user_id: uuid.UUID, raw: Any
) -> uuid.UUID | None:
    """Resolve an optional client-supplied `conversationId` to an OWNED conversation's id.

    Absent (or explicit `null`) → `None` and the row stores `conversation_id = NULL`, so a
    client that sends no conversationId keeps working. Resolving a PRESENT one is referential
    integrity, NOT the tenancy boundary — the row is written and read under the caller's own
    `user_id` either way; what it buys is that an upload cannot be hung off a stranger's, or a
    nonexistent, conversation."""
    if raw is None:
        return None
    if not isinstance(raw, str) or not _ID_RE.match(raw):
        raise AppApiError(400, "Invalid conversation id.")
    try:
        cid = uuid.UUID(raw)
    except ValueError:
        # An ID_RE-valid token that isn't a UUID can key no stored conversation.
        raise AppApiError(404, "Conversation not found.") from None
    owned = await db.scalar(
        sa.select(Conversation.id).where(Conversation.id == cid, Conversation.user_id == user_id)
    )
    if owned is None:
        raise AppApiError(404, "Conversation not found.")
    return cid


async def _store_attachment_bytes(
    db: DbSession,
    storage: ObjectStorage,
    user_id: uuid.UUID,
    attachment_id: str,
    media_type: str,
    name: str,
    conversation_id: uuid.UUID | None,
    data: bytes,
) -> dict[str, Any]:
    """Enforce the per-user quota and store the bytes owner-scoped; return the Express file-part
    ref. Idempotent on a repeated id (reuses the row + key). Raises `AppApiError(413)` on an
    over-quota write. NOTE: the quota check-then-store has a concurrent-overspend window (as in
    the daily gate) — hardening deferred.

    `conversation_id` is stamped on the CREATE branch. On an idempotent re-upload it re-links
    only when a link is SUPPLIED — a re-upload that carries no conversationId never clobbers an
    existing link to NULL (the link is set-once-then-refreshable, never silently dropped)."""
    size = len(data)
    used_raw = await db.scalar(
        sa.select(sa.func.coalesce(sa.func.sum(Attachment.size), 0)).where(
            Attachment.user_id == user_id
        )
    )
    used = int(used_raw or 0)
    existing = await db.scalar(
        sa.select(Attachment).where(
            Attachment.user_id == user_id, Attachment.attachment_id == attachment_id
        )
    )
    old_size = existing.size if existing is not None else 0
    if used - old_size + size > ATTACHMENT_TOTAL_CAP:
        raise AppApiError(
            413,
            "Attachment storage is full. Remove some attachments and try again.",
            code="ATTACHMENT_STORE_FULL",
        )

    if existing is not None:
        key = existing.storage_key
    else:
        key = attachment_key(user_id, uuid.uuid7())
    # Store the bytes first; only then persist the row (a failed put leaves no dangling row).
    await storage.put(key, data, content_type=media_type)
    if existing is not None:
        existing.media_type, existing.name, existing.size = media_type, name, size
        if conversation_id is not None:
            existing.conversation_id = conversation_id
    else:
        db.add(
            Attachment(
                user_id=user_id,
                attachment_id=attachment_id,
                media_type=media_type,
                name=name,
                size=size,
                storage_key=key,
                conversation_id=conversation_id,
            )
        )
    await db.commit()
    return {
        "attachmentId": attachment_id,
        "key": key,
        "mediaType": media_type,
        "size": size,
        "name": name,
    }


def _decode_bounded(b64: Any) -> bytes:
    """Decode a base64 body and enforce the 4 MB decoded cap (shared by office/deck).
    Raises `AppApiError`."""
    if not isinstance(b64, str) or not b64:
        raise AppApiError(400, "Invalid attachment: missing bytes.")
    try:
        data = base64.b64decode(b64, validate=False)
    except (binascii.Error, ValueError):  # fmt: skip  # ruff py314 strips parens
        raise AppApiError(400, "Invalid attachment: missing bytes.") from None
    if len(data) > ATTACHMENT_MAX_BYTES:
        raise AppApiError(413, "Attachment is too large (max 4 MB).")
    return data


async def _assert_pdf_within_page_cap(data: bytes, name: str) -> None:
    """Refuse a PDF longer than `MAX_PDF_PAGES`, BEFORE anything is stored.

    ★ THE COUNT RUNS IN THE KILLABLE GOVERNOR, NEVER IN THIS HANDLER, and that is the load-
    bearing half of this function. The standing rule for uploads is explicit — treat them as
    untrusted, validate at the boundary, SANDBOX PARSING — and a PDF is the worst-behaved
    thing this route accepts: a Flate bomb, a circular object graph, a
    cross-reference stream declaring millions of entries are all reachable inside 4 MB, and the
    last of those costs eight kilobytes and tens of seconds. Read on the event loop, one upload
    stalls the worker serving every other citizen's request. Read through `run_parse`, it is a
    fresh spawned child with a wall-clock deadline and an address-space rlimit, terminated when
    it overruns. `_handle_office_upload` next door takes the same route for the same reason.

    EVERY FAILURE WEARS ONE ANSWER. Over the cap, unreadable, killed at the deadline, contained
    OOM — all four are `PDF_TOO_LONG_TEXT` and a 413. The alternative is telling a citizen
    which of the platform's internal failure modes their file hit, which is both useless to
    them and the internals leak that same rule forbids; the distinguishing detail goes to
    the log instead — `pdf_page_check_failed` (the parser's `code`/`status`) or
    `pdf_over_page_cap` (`pages`/`cap`).

    THOSE TWO EVENTS ARE THE COMPENSATING CONTROL the collapse was traded for, so they are
    pinned by a test rather than left to good intentions. They go through STRUCTLOG, like every
    other module here: nothing in this process configures stdlib `logging` (`main.py` wires
    structlog to a `PrintLogger`, and uvicorn's config names only the `uvicorn*` loggers), so a
    `logging.getLogger(__name__)` line would be dropped at the root or reach `lastResort`, whose
    bare `%(message)s` strips exactly the fields an operator came for."""
    try:
        counted = await run_parse(data, "count_pdf_pages", name, None)
        pages = counted["pageCount"]
    except FileParseError as exc:
        logger.warning("pdf_page_check_failed", code=exc.code, status=exc.status)
        # The locked arm is the one exception to the collapse above, and only this one: it is a
        # 415 rather than a 413 because nothing about the file's SIZE was the problem.
        if exc.code == PDF_LOCKED_CODE:
            raise AppApiError(415, PDF_LOCKED_TEXT, code=PDF_LOCKED_CODE) from exc
        raise AppApiError(413, PDF_TOO_LONG_TEXT, code=PDF_TOO_LONG_CODE) from exc
    if not isinstance(pages, int) or pages > MAX_PDF_PAGES:
        logger.info("pdf_over_page_cap", pages=pages, cap=MAX_PDF_PAGES)
        raise AppApiError(413, PDF_TOO_LONG_TEXT, code=PDF_TOO_LONG_CODE)


async def _handle_office_upload(
    db: DbSession,
    storage: ObjectStorage,
    user: User,
    attachment_id: str,
    media_type: str,
    name: str,
    conversation_id: uuid.UUID | None,
    body: dict[str, Any],
) -> JSONResponse:
    """docx/xlsx: extract to Markdown BEFORE storing (a corrupt file is rejected without orphaning
    an object), then store the original bytes and return the `kind:'office'` part.

    The extraction runs in the shared killable parse governor (`run_parse`) — NOT in-process —
    so an untrusted docx/xlsx whose compressed bytes pass the 4 MB cap but inflate to gigabytes
    can never OOM the shared API worker; a contained OOM/timeout maps to 413, a corrupt file
    to 400."""
    data = _decode_bounded(body.get("base64"))
    office_format = office_format_for(media_type)
    if office_format is None:
        raise AppApiError(400, f"Unsupported Office type: {media_type}")
    kind = "extract_word" if office_format == "word" else "extract_excel"
    try:
        extracted = await run_parse(data, kind, name, None)
    except FileParseError as exc:
        raise AppApiError(exc.status, str(exc), code=exc.code) from exc
    ref = await _store_attachment_bytes(
        db, storage, user.id, attachment_id, media_type, name, conversation_id, data
    )
    return JSONResponse(
        status_code=201,
        content={
            "attachment": {
                **ref,
                "kind": "office",
                "format": extracted["format"],
                "text": extracted["text"],
                "truncated": extracted["truncated"],
                "truncationNote": extracted["truncationNote"],
            }
        },
    )


async def _handle_deck_upload(
    db: DbSession,
    storage: ObjectStorage,
    user: User,
    attachment_id: str,
    media_type: str,
    name: str,
    conversation_id: uuid.UUID | None,
    body: dict[str, Any],
) -> JSONResponse:
    """pptx: gated on a configured Gotenberg. Convert FIRST (validates structure/zip-bomb/page-cap
    without storing), then store the original .pptx and the derived PDF. Azure-hosted Foundry has
    no Files API, so a deck cannot be handed over by reference: the PDF lives in the object store
    and the chat path rehydrates and inlines it. Deck is off by default (unset GOTENBERG_URL)."""
    if not deck_attachments_enabled():
        raise AppApiError(501, "PowerPoint attachments aren't enabled.")
    data = _decode_bounded(body.get("base64"))
    try:
        converted = await convert_deck_to_pdf(data, name=name)
    except DeckConvertError as exc:
        raise AppApiError(exc.status, str(exc), code=exc.code) from exc
    ref = await _store_attachment_bytes(
        db, storage, user.id, attachment_id, media_type, name, conversation_id, data
    )
    pdf_key = f"{ref['key']}.pdf"
    await storage.put(pdf_key, converted.pdf, content_type="application/pdf")
    return JSONResponse(
        status_code=201,
        content={
            "attachment": {
                **ref,
                "kind": "deck",
                "pdfFileId": pdf_key,
                "pageCount": converted.page_count,
                "truncated": False,
            }
        },
    )


@router.post(
    "",
    status_code=201,
    response_model=UploadResponse,
    dependencies=[Depends(_attachment_limiter)],
    responses=error_responses(
        (400, ErrorEnvelope, "Invalid attachment id, conversation id, name, type, or bytes"),
        (404, ErrorEnvelope, "conversationId not found (or not owned by the caller)"),
        (413, ErrorEnvelope, "Attachment too large, over the PDF page cap, or storage full"),
        # DECLARED BECAUSE IT IS RAISED — the locked-PDF arm above answers 415, and a status the
        # route really sends but the schema never mentions is the generated client's problem
        # later. It is 415 and not 413 for the reason given there: nothing about the SIZE was
        # wrong. (This route's own contract test asserts a SUBSET, so it did not catch the gap.)
        (415, ErrorEnvelope, "The PDF is password-protected and cannot be read"),
        (501, ErrorEnvelope, "PowerPoint attachments are not enabled"),
        (429, ErrorEnvelope, "Too many attachment requests"),
        AUTH_401,
    ),
)
async def upload_attachment(
    request: Request, user: CurrentUser, db: DbSession, storage: Storage
) -> JSONResponse:
    # Body-size ceiling (Express mount `limit:'6mb'`) — refuse a huge body before buffering it.
    content_length = request.headers.get("content-length")
    if (
        content_length is not None
        and content_length.isdigit()
        and int(content_length) > _BODY_LIMIT_BYTES
    ):
        raise AppApiError(413, "Attachment request is too large.")

    try:
        body: Any = await request.json()
    except (ValueError, TypeError):  # fmt: skip  # ruff py314 strips parens
        body = {}
    if not isinstance(body, dict):
        body = {}

    attachment_id = body.get("attachmentId")
    if not isinstance(attachment_id, str) or not _ID_RE.match(attachment_id):
        raise AppApiError(400, "Invalid attachment id.")
    media_type = body.get("mediaType")
    if not isinstance(media_type, str):
        raise AppApiError(400, "mediaType is required.")
    if media_type.startswith("text/"):
        raise AppApiError(400, "Text attachments are sent inline, not uploaded.")
    # Parsed ONCE here, before the branch, so every upload kind shares the same contract. The
    # optional conversation link is resolved owner-scoped here too (a bad conversationId 404s
    # before any bytes are parsed or stored — no orphaned object on the reject path).
    name = _attachment_name(body.get("name"))
    conversation_id = await _resolve_conversation_link(db, user.id, body.get("conversationId"))
    if media_type in OFFICE_MEDIA_TYPES:
        return await _handle_office_upload(
            db, storage, user, attachment_id, media_type, name, conversation_id, body
        )
    if media_type == PPTX_MEDIA_TYPE:
        return await _handle_deck_upload(
            db, storage, user, attachment_id, media_type, name, conversation_id, body
        )

    b64 = body.get("base64")
    err = _validate_attachment_bytes(media_type, b64)
    if err is not None:
        raise AppApiError(400, err)
    # Validation guarantees a non-empty str; this redundant narrow satisfies the type checker.
    if not isinstance(b64, str):
        raise AppApiError(400, "Invalid attachment: missing bytes.")
    try:
        data = base64.b64decode(b64, validate=False)
    except (binascii.Error, ValueError):  # fmt: skip  # ruff py314 strips parens
        raise AppApiError(
            400, f"Attachment bytes do not match the declared type {media_type}."
        ) from None
    if len(data) > ATTACHMENT_MAX_BYTES:
        raise AppApiError(413, "Attachment is too large (max 4 MB).")
    # AFTER the magic-byte and size checks and BEFORE the store, so a refused document leaves
    # no object and no row — the ordering `_handle_office_upload` already keeps. The arm is
    # split on media type rather than run for everything: an image's cost does not scale with
    # its page count (it has none), and charging every screenshot a subprocess spawn would be
    # a real regression in the common path.
    if media_type == PDF_MEDIA_TYPE:
        await _assert_pdf_within_page_cap(data, name)

    ref = await _store_attachment_bytes(
        db, storage, user.id, attachment_id, media_type, name, conversation_id, data
    )
    kind = "document" if media_type == PDF_MEDIA_TYPE else "image"
    return JSONResponse(status_code=201, content={"attachment": {**ref, "kind": kind}})


async def _safe_delete_pdf(storage: ObjectStorage, pdf_key: str) -> None:
    """Best-effort delete of a deck's derived `{key}.pdf` sibling — a genuine store error is
    swallowed (never fails the parent delete); a missing object is already idempotent."""
    try:
        await storage.delete(pdf_key)
    except StorageError:
        pass


async def _load_owned(db: DbSession, user_id: uuid.UUID, attachment_id: str) -> Attachment | None:
    result: Attachment | None = await db.scalar(
        sa.select(Attachment).where(
            Attachment.user_id == user_id, Attachment.attachment_id == attachment_id
        )
    )
    return result


@router.get(
    "/{attachment_id}",
    # Returns raw bytes (`Response`) — no response_model. Errors still documented.
    responses=error_responses(
        (400, ErrorEnvelope, "Invalid attachment id"),
        (404, ErrorEnvelope, "Attachment not found"),
        AUTH_401,
    ),
)
async def download_attachment(
    attachment_id: str, user: CurrentUser, db: DbSession, storage: Storage
) -> Response:
    if not _ID_RE.match(attachment_id):
        raise AppApiError(400, "Invalid attachment id.")
    att = await _load_owned(db, user.id, attachment_id)
    if att is None:
        raise AppApiError(404, "Attachment not found.")
    assert_owned(att.storage_key, user.id)
    try:
        data = await storage.get(att.storage_key)
    except StorageNotFoundError:
        raise AppApiError(404, "Attachment not found.") from None
    # Content-Type is SNIFFED from the bytes (not the stored media_type), matching Express.
    media = _sniff_media_type(data) or "application/octet-stream"
    return Response(
        content=data, media_type=media, headers={"Cache-Control": "private, max-age=3600"}
    )


@router.delete(
    "/{attachment_id}",
    response_model=OkResponse,
    dependencies=[Depends(_attachment_limiter)],
    responses=error_responses(
        (400, ErrorEnvelope, "Invalid attachment id"),
        (429, ErrorEnvelope, "Too many attachment requests"),
        AUTH_401,
    ),
)
async def delete_attachment(
    attachment_id: str, user: CurrentUser, db: DbSession, storage: Storage
) -> JSONResponse:
    if not _ID_RE.match(attachment_id):
        raise AppApiError(400, "Invalid attachment id.")
    att = await _load_owned(db, user.id, attachment_id)
    if att is not None:
        assert_owned(att.storage_key, user.id)
        await storage.delete(att.storage_key)  # idempotent on a missing object
        # A deck attachment also wrote a derived `{key}.pdf` sibling — sweep it best-effort
        # so it doesn't leak (idempotent on a missing object; never fails the delete).
        if att.media_type == PPTX_MEDIA_TYPE:
            await _safe_delete_pdf(storage, att.storage_key + ".pdf")
        await db.delete(att)
        await db.commit()
    # Delete is always idempotent and 200, even when the id is unknown (Express behavior).
    return JSONResponse(content={"ok": True})
