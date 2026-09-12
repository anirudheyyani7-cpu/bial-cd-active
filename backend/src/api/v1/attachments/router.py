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
from src.schemas import AUTH_401, ErrorEnvelope, OkResponse, error_responses
from src.services.extract.zip_safety import FileParseError, assert_zip_not_bomb
from src.services.media.lanes import code_lane_refusal, is_code_lane, is_opc_archive
from src.services.media.magic import ALLOWED_MEDIA, chip_kind_for, magic_matches
from src.services.parse.governor import run_parse
from src.services.ratelimit import rate_limit
from src.services.storage import (
    ObjectStorage,
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
_BODY_LIMIT_BYTES = 6 * 1024 * 1024

# THE STORAGE BUDGET IS PER CONVERSATION, NOT PER CITIZEN (#214 R7a). It used to sum every
# attachment a person had ever uploaded, across every conversation, with no conversation filter
# — a lifetime account budget of roughly a dozen full-size files. Two or three working sessions
# exhausted it, and the only way to reclaim any was to delete whole conversations, because
# nothing lets a citizen remove a single attachment from an old one. The message was "Attachment
# storage is full" with no action behind it.
#
# Scoped to the conversation it becomes something a citizen can act on: this chat is full, a new
# one has room, and starting one is a real remedy rather than advice that changes nothing.
#
# THE TRADE, STATED: this removes the only ceiling on a citizen's TOTAL stored bytes, because
# many conversations now means many budgets. Taken deliberately — a lifetime cap that cannot be
# reclaimed is the worse failure — and worth watching rather than pre-solving.
ATTACHMENT_TOTAL_CAP = 50 * 1024 * 1024

# How many attachments one conversation may hold, counted SERVER-SIDE (#214 R7b). The browser
# has had this number since the beginning and it was never enforced here — the portal's
# `validateConversationAttachmentCap` tallies attachments by walking the messages the browser has
# loaded, so it reset to zero on every page reload. A cap a refresh clears is not a cap.
MAX_ATTACHMENTS_PER_CONVERSATION = 20


ATTACHMENT_LANES_SENTENCE: Final = (
    "Attach a picture or a PDF and I'll look at it; attach a spreadsheet, document or slide "
    "deck and I'll open it with code."
)
"""ONE SENTENCE, EVERYWHERE (#214 R21). The composer, the help page and every unsupported-format
refusal carry these exact words — three sentences that drift is how the removed rule failed. Its
portal twin is `ATTACHMENT_LANES_SENTENCE` in `portal/src/utils/attachmentInput.ts`, and a test
holds the two byte-identical.

IT DESCRIBES WHAT HAPPENS TO A FILE, not which extensions are on a list. A list of ten formats
goes stale the moment the allowlist moves, and tells a citizen nothing about why a spreadsheet
behaves differently from a photograph."""


MAX_PDF_PAGES: Final = 30
"""How long a document may be, in pages, and the byte cap above cannot express it.

A text PDF runs about 1.3 KB a page and a scanned one about 300 KB, so the same 4 MB spans
roughly 13 pages to 3,200. The document that pushed a conversation to 77% of its hard context
limit was 79 KB — comfortably inside every size bound the platform had.

THE NUMBER IS SET FROM WHAT A PAGE COSTS, ~2,500 tokens measured, against the per-conversation
ceiling. Thirty pages is ~75,000 tokens — the large majority of business documents, and still
room for a document plus a real build conversation inside the 500,000 per-conversation ceiling
— with a good deal to spare, now that ceiling is the corrected one. Nothing charges an
admitted document a nominal any more; the window check reads the count the provider returns for
a completed turn, so THIS cap is the only bound that acts before the provider has seen the file.
Raise it and a single upload can fill a conversation on its own, with the refusal arriving one
turn later than the citizen would have wanted it."""

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
    """Validate a MODEL-LANE upload (image/PDF) against the allowlist + magic bytes.

    THE CODE LANE IS NOT CHECKED HERE, and that is the point rather than a gap. `ALLOWED_MEDIA` is
    the magic-byte gate, and it is applied on both paths that end at the
    model — this route, the store's rehydrator and `build_sessions/attachments.py`. Widening it to
    admit Office would make every one of them answer True for a deck, and a spreadsheet would reach
    the model as raw ZIP bytes on whichever path lost its refusal first. Office, CSV and TSV are
    admitted by `code_lane_refusal` instead, which runs only where an attachment is stored, so the
    model-facing consumers keep refusing them without a line changing in either of them.
    """
    if not isinstance(b64, str) or not b64:
        return "Invalid attachment: missing bytes."
    magic = ALLOWED_MEDIA.get(media_type)
    if magic is None:
        return f"Unsupported attachment type: {media_type}. {ATTACHMENT_LANES_SENTENCE}"
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
    `user_id` either way; what it buys is that an upload cannot be hung off a STRANGER's
    conversation.

    ★ A CONVERSATION THAT DOES NOT EXIST YET IS NOT AN ERROR, and getting this wrong made the
    first attachment of every NEW chat impossible (#214). The composer mints the id in the browser
    and navigates to it; the conversation ROW is created by the first send, which by definition
    happens AFTER the file is uploaded — the send route stages that row and writes it only once
    every side-effect-free refusal has passed (R-18). So at upload time the id is real, owned by
    nobody yet, and simply unwritten. Refusing it 404s the opening move of the whole feature.

    It stores `NULL` instead, which is the state this column was made nullable FOR, and nothing
    downstream is weakened: `code_lane_attachments` finds the file by its ID as well as by the
    link precisely because this case exists, and the reclaimer reads NULL as legacy rather than as
    a deletion signal.

    THE STRANGER CHECK IS UNCHANGED, which is why the owner is READ rather than filtered on: a row
    that exists under another user is still a 404. Only genuine absence is admitted.
    """
    if raw is None:
        return None
    if not isinstance(raw, str) or not _ID_RE.match(raw):
        raise AppApiError(400, "Invalid conversation id.")
    try:
        cid = uuid.UUID(raw)
    except ValueError:
        # An ID_RE-valid token that isn't a UUID can key no stored conversation.
        raise AppApiError(404, "Conversation not found.") from None
    owner = await db.scalar(sa.select(Conversation.user_id).where(Conversation.id == cid))
    if owner is None:
        return None  # not written yet — the first send creates it
    if owner != user_id:
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
    # BOTH BUDGETS ARE SCOPED TO THE CONVERSATION when there is one, and to the UNLINKED POOL when
    # there is not (#214, agc129's B4).
    #
    # ★ THE FALLBACK USED TO BE THE WHOLE ACCOUNT, and that refused a new chat's first file for
    # anyone who had attached twenty things anywhere. The first upload of every new chat is
    # unlinked — its conversation row is written by the first send — so it was counted against
    # every sent attachment in every other chat: "This conversation has reached its limit of 20
    # attachments" on a chat holding zero, with "start a new chat" as the remedy, which was the one
    # move that could not help.
    #
    # Scoped to `conversation_id IS NULL`, an unlinked upload competes only with files that are
    # ALSO still unsent. The pool stays bounded — nothing uploaded without a chat is ever free —
    # and every file leaves it the moment the message carrying it is sent
    # (`materialize.adopt_unlinked_attachments`).
    link = (
        Attachment.conversation_id == conversation_id
        if conversation_id is not None
        else Attachment.conversation_id.is_(None)
    )
    scope = [Attachment.user_id == user_id, link]
    used_raw = await db.scalar(
        sa.select(sa.func.coalesce(sa.func.sum(Attachment.size), 0)).where(*scope)
    )
    used = int(used_raw or 0)
    existing = await db.scalar(
        sa.select(Attachment).where(
            Attachment.user_id == user_id, Attachment.attachment_id == attachment_id
        )
    )
    # ONLY A ROW IN THE SAME SCOPE OFFSETS THE SUM. `existing` is looked up by (owner, id) alone,
    # so a row from a DIFFERENT scope was never in `used` — subtracting its size drove the total
    # negative and handed the citizen free headroom. Both scopes reduce to one comparison: the row
    # counts iff its link equals the one being checked, and `None == None` is the unlinked pool.
    # (The previous `conversation_id is None or …` form subtracted a LINKED row's size from the
    # unlinked sum, which would have reopened exactly that hole under the scope above.)
    counts_toward_used = existing is not None and existing.conversation_id == conversation_id
    old_size = existing.size if (existing is not None and counts_toward_used) else 0
    if used - old_size + size > ATTACHMENT_TOTAL_CAP:
        raise AppApiError(
            413,
            "This conversation has no room for more attachments. Start a new chat to add more.",
            code="ATTACHMENT_STORE_FULL",
        )
    # THE COUNT, and only for a file this conversation does not already hold — a re-upload of the
    # same id replaces a row rather than adding one, so counting it would refuse an idempotent
    # retry at the boundary.
    #
    # IT DOES NOT SKIP AN UNLINKED UPLOAD: gated on `conversation_id is not None` the cap was
    # bypassable on the ordinary path, since every new chat's first file is unlinked. It counts the
    # unlinked pool instead — the same population the byte budget above uses for that case.
    if existing is None:
        held = await db.scalar(sa.select(sa.func.count()).select_from(Attachment).where(*scope))
        # `scope` is the conversation when there is one and the unlinked pool when there is not.
        if int(held or 0) + 1 > MAX_ATTACHMENTS_PER_CONVERSATION:
            raise AppApiError(
                413,
                f"This conversation has reached its limit of "
                f"{MAX_ATTACHMENTS_PER_CONVERSATION} attachments. Start a new chat to add more.",
                code="CONVERSATION_ATTACHMENTS_FULL",
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
    # THE `text/*` REFUSAL INVERTS FOR THE TWO DELIMITED FORMATS (#214). It used to refuse every
    # text type, because text rode inside the prompt rather than being uploaded. That lane is
    # gone: every attachment is now an uploaded file with a stored identity, which is what lets a
    # chip be rebuilt on reload for every format by one fix. CSV and TSV are ordinary uploads.
    #
    # `text/plain` stays refused, and that is a WITHDRAWAL rather than an oversight — it works on
    # the branch today and stops. The mechanism argument for refusing it died with the inline
    # lane; the surviving reason is that no client requirement names it, and every format costs a
    # reader arm, refusal copy, a test and a line in the help page.
    if media_type.startswith("text/") and not is_code_lane(media_type):
        raise AppApiError(400, f"That file type is not supported. {ATTACHMENT_LANES_SENTENCE}")
    # Parsed ONCE here, before the branch, so every upload kind shares the same contract. The
    # optional conversation link is resolved owner-scoped here too (a bad conversationId 404s
    # before any bytes are parsed or stored — no orphaned object on the reject path).
    name = _attachment_name(body.get("name"))
    conversation_id = await _resolve_conversation_link(db, user.id, body.get("conversationId"))
    # THE THREE ADMISSION ARMS COLLAPSE INTO TWO (#214). Office and deck each had their own,
    # because each ran a different server-side conversion before storing: docx/xlsx were extracted
    # to Markdown, and a deck was rendered to PDF by a converter that was never deployed. Both are
    # gone. A file is now stored as itself and read where it can actually be read, so what is left
    # is the routing rule and nothing else — the model reads these bytes, or code does.
    b64 = body.get("base64")
    # WHICH LANE, decided once. The model reads images and PDFs itself; code in the workspace
    # reads everything else. Neither branch is a list of extensions the other has to stay in step
    # with — `is_code_lane` is the single answer both use.
    if is_code_lane(media_type):
        if not isinstance(b64, str) or not b64:
            raise AppApiError(400, "Invalid attachment: missing bytes.")
    else:
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
    if is_code_lane(media_type):
        # AFTER the size check and BEFORE the store, like the page cap above: a refused file
        # leaves no object and no row. Password protection is checked in here too, for every
        # format that can carry it — a locked workbook gets the same sentence a locked PDF does,
        # rather than being stored, charged, and failing inside the sandbox several turns later.
        refusal = code_lane_refusal(media_type, name, data)
        if refusal is not None:
            raise AppApiError(415, refusal)
        # THE ARCHIVE BOUND, ON THE HALF OF THE LANE THAT ACTUALLY CARRIES ARCHIVES (R18b).
        # Office files are ZIPs, and a 4 MB one can declare 300 MB uncompressed.
        #
        # `is_opc_archive`, NOT `is_code_lane`, and the difference was a live defect: gated on the
        # whole lane this refused every CSV and TSV with "Malformed archive (no ZIP
        # end-of-central-directory)" — true about a file that was never an archive, and
        # unactionable to a citizen holding a normal spreadsheet export. Delimited files are bytes
        # of text with no central directory to bound; the size cap is their bound.
        #
        # Its previous three
        # callers were all server-side extraction arms that this work deletes, and its own suite
        # calls it directly — so it proves the algorithm and would never have told us it had gone
        # unwired. This path is stricter than what it replaces, not looser: the old office lane
        # extracted inside a killable, memory-capped subprocess and never stored a file it could
        # not read, while this one stores the archive and hands it to a reader in the citizen's
        # own sandbox, where neither that ceiling nor that deadline reaches.
        if is_opc_archive(media_type):
            try:
                assert_zip_not_bomb(data)
            except FileParseError as exc:
                raise AppApiError(413, str(exc)) from None

    ref = await _store_attachment_bytes(
        db, storage, user.id, attachment_id, media_type, name, conversation_id, data
    )
    kind = chip_kind_for(media_type)
    return JSONResponse(status_code=201, content={"attachment": {**ref, "kind": kind}})


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
        # NO DERIVED SIBLING TO SWEEP ANY MORE (#214). A deck used to be rendered to PDF and the
        # `{key}.pdf` stored beside the original, so a delete had to remove both or leak one.
        # Nothing derives anything from an attachment now.
        await db.delete(att)
        await db.commit()
    # Delete is always idempotent and 200, even when the id is unknown (Express behavior).
    return JSONResponse(content={"ok": True})
