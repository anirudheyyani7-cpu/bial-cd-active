"""POST/GET/DELETE /v1/attachments — validation, magic bytes, quota, owner-scoped
keys, rate limit. Byte-stable with the Express `/api/attachments` contract.
"""

from __future__ import annotations

import base64
import datetime
import io
import re
import struct
import time
import uuid
import zipfile

from openpyxl import Workbook
from sqlalchemy import select
from structlog.testing import capture_logs

from src.api.v1.attachments.router import (
    ATTACHMENT_LANES_SENTENCE,
    ATTACHMENT_TOTAL_CAP,
    MAX_ATTACHMENTS_PER_CONVERSATION,
    MAX_PDF_PAGES,
)
from src.config import settings
from src.db.models.attachment import Attachment
from src.services.attachments import reclaim_orphaned_attachments
from src.services.auth.session_jwt import mint_session_jwt
from src.services.media.lanes import EXCEL_MEDIA_TYPE
from tests.factories import ConversationFactory, ProjectFactory, UserFactory
from tests.pdfs import locked_pdf, pdf_with_pages, restricted_pdf, unreadable_pdf, xref_bomb_pdf

_TTL = settings.auth.access_ttl_seconds

_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
# A REAL one-page PDF, not just the magic prefix: a PDF upload is parsed for its page
# count, so magic-valid rubbish is refused rather than stored. `unreadable_pdf()` is that case,
# tested by name below.
_PDF = pdf_with_pages(1)


def _lying_zip(entries: dict[str, bytes], declared_uncompressed: int) -> bytes:
    """A real archive whose central directory DECLARES a huge uncompressed size.

    The bomb pre-filter sums the declared sizes and never inflates to check, precisely because
    they are attacker-controllable - so an overstated size is the threat, not a cheat.
    """
    raw = _zip_with(entries)
    cdh = raw.index(bytes([0x50, 0x4B, 0x01, 0x02]))  # first central-directory header
    return raw[: cdh + 24] + struct.pack("<I", declared_uncompressed) + raw[cdh + 28 :]


def _zip_with(entries: dict[str, bytes]) -> bytes:
    """A real ZIP. The code lane runs `assert_zip_not_bomb`, which reads the archive's own central
    directory, so a hand-built PK prefix is refused before any structure check."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for entry_name, body in entries.items():
            archive.writestr(entry_name, body)
    return buffer.getvalue()


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def _cookie(jwt: str) -> dict[str, str]:
    return {"Cookie": f"session={jwt}"}


async def _auth(db_session):
    user = await UserFactory.create(db_session)
    return _cookie(mint_session_jwt(user.id, user.token_version, _TTL)), user


# --- upload happy path + download ---------------------------------------------


async def test_upload_image_then_download(client, db_session, fake_storage) -> None:
    headers, user = await _auth(db_session)
    resp = await client.post(
        "/v1/attachments",
        headers=headers,
        json={
            "attachmentId": "att_1",
            "name": "shot.png",
            "mediaType": "image/png",
            "base64": _b64(_PNG),
        },
    )
    assert resp.status_code == 201
    att = resp.json()["attachment"]
    assert att["attachmentId"] == "att_1"
    assert att["mediaType"] == "image/png"
    assert att["size"] == len(_PNG)
    assert att["name"] == "shot.png"
    assert att["kind"] == "image"
    assert att["key"].startswith(f"att/{user.id}/")

    dl = await client.get("/v1/attachments/att_1", headers=headers)
    assert dl.status_code == 200
    assert dl.content == _PNG
    assert dl.headers["content-type"] == "image/png"
    assert dl.headers["cache-control"] == "private, max-age=3600"


async def test_upload_pdf_is_document_kind(client, db_session) -> None:
    headers, _ = await _auth(db_session)
    resp = await client.post(
        "/v1/attachments",
        headers=headers,
        json={"attachmentId": "att_pdf", "mediaType": "application/pdf", "base64": _b64(_PDF)},
    )
    assert resp.status_code == 201
    assert resp.json()["attachment"]["kind"] == "document"


# --- upload validation --------------------------------------------------------


async def test_wrong_magic_rejected(client, db_session) -> None:
    headers, _ = await _auth(db_session)
    resp = await client.post(
        "/v1/attachments",
        headers=headers,
        json={"attachmentId": "att_x", "mediaType": "image/png", "base64": _b64(_PDF)},
    )
    assert resp.status_code == 400
    assert resp.json() == {
        "error": {"message": "Attachment bytes do not match the declared type image/png."}
    }


async def test_unsupported_type_rejected(client, db_session) -> None:
    headers, _ = await _auth(db_session)
    resp = await client.post(
        "/v1/attachments",
        headers=headers,
        json={"attachmentId": "att_x", "mediaType": "image/tiff", "base64": _b64(_PNG)},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["message"].startswith("Unsupported attachment type: image/tiff.")


async def test_text_type_rejected(client, db_session) -> None:
    headers, _ = await _auth(db_session)
    resp = await client.post(
        "/v1/attachments",
        headers=headers,
        json={"attachmentId": "att_x", "mediaType": "text/plain", "base64": _b64(b"hi")},
    )
    # `text/plain` STAYS REFUSED, and that is a withdrawal rather than an oversight: it works on
    # the branch today and stops. The mechanism argument died with the inline lane — under the
    # routing rule a .txt is simply a file that code reads, exactly like a .csv — so the refusal
    # rests on the surviving reason alone: no client requirement names it, and every format costs
    # a reader arm, refusal copy, a test and a line in the help page.
    assert resp.status_code == 400
    assert "not supported" in resp.json()["error"]["message"]
    # And it carries the ONE sentence, so a citizen meets the same words here as in the composer.
    assert ATTACHMENT_LANES_SENTENCE in resp.json()["error"]["message"]


async def test_a_csv_is_no_longer_refused_as_inline_text(client, db_session, fake_storage) -> None:
    """★ THE `text/*` REFUSAL INVERTS FOR THE DELIMITED FORMATS (#214).

    It used to refuse every text type because text rode inside the prompt rather than being
    uploaded. That lane is gone: every attachment is an uploaded file with a stored identity,
    which is what lets a chip be rebuilt on reload for every format by one fix.
    """
    headers, _ = await _auth(db_session)

    resp = await client.post(
        "/v1/attachments",
        headers=headers,
        json={
            "attachmentId": "att_csv",
            "name": "movements.csv",
            "mediaType": "text/csv",
            "base64": _b64(b"badge,name\n1,Asha\n"),
        },
    )

    assert resp.status_code == 201, resp.text


async def test_a_workbook_is_admitted_and_a_renamed_archive_is_not(
    client, db_session, fake_storage
) -> None:
    """All OOXML shares the ZIP signature, so the OPC part is the only discriminator there is —
    without it a renamed `.zip` is stored as a workbook the reader then cannot open."""
    headers, _ = await _auth(db_session)
    # A REAL archive. `assert_zip_not_bomb` runs on this lane and reads the ZIP own
    # central directory, so a hand-built PK prefix is refused before any structure
    # check even matters - the guard working, not a fixture problem.
    workbook = _zip_with({"xl/workbook.xml": b"<workbook/>"})

    ok = await client.post(
        "/v1/attachments",
        headers=headers,
        json={
            "attachmentId": "att_xlsx",
            "name": "book.xlsx",
            "mediaType": EXCEL_MEDIA_TYPE,
            "base64": _b64(workbook),
        },
    )
    assert ok.status_code == 201, ok.text

    refused = await client.post(
        "/v1/attachments",
        headers=headers,
        json={
            "attachmentId": "att_zip",
            "name": "book.xlsx",
            "mediaType": EXCEL_MEDIA_TYPE,
            "base64": _b64(_zip_with({"readme.txt": b"not a workbook"})),
        },
    )
    assert refused.status_code == 415, refused.text


async def test_a_password_protected_workbook_is_refused_at_the_door(
    client, db_session, fake_storage
) -> None:
    """★ R6/AE8c. A locked workbook gets the same treatment a locked PDF gets — refused before
    anything is stored, with the password named — rather than being accepted, charged, and failing
    inside the sandbox several turns later where nothing can explain it."""
    headers, _ = await _auth(db_session)
    locked = bytes([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) + bytes(64)

    resp = await client.post(
        "/v1/attachments",
        headers=headers,
        json={
            "attachmentId": "att_locked",
            "name": "salaries.xlsx",
            "mediaType": EXCEL_MEDIA_TYPE,
            "base64": _b64(locked),
        },
    )

    assert resp.status_code == 415, resp.text
    assert "password" in resp.json()["error"]["message"].lower()
    assert fake_storage.objects == {}  # refused BEFORE the store


async def test_invalid_id_rejected(client, db_session) -> None:
    headers, _ = await _auth(db_session)
    resp = await client.post(
        "/v1/attachments",
        headers=headers,
        json={"attachmentId": "bad id!", "mediaType": "image/png", "base64": _b64(_PNG)},
    )
    assert resp.status_code == 400
    assert resp.json() == {"error": {"message": "Invalid attachment id."}}


async def test_missing_media_type_rejected(client, db_session) -> None:
    headers, _ = await _auth(db_session)
    resp = await client.post(
        "/v1/attachments", headers=headers, json={"attachmentId": "att_x", "base64": _b64(_PNG)}
    )
    assert resp.status_code == 400
    assert resp.json() == {"error": {"message": "mediaType is required."}}


async def test_over_size_cap_rejected(client, db_session) -> None:
    headers, _ = await _auth(db_session)
    oversized = b"\x89PNG\r\n\x1a\n" + b"\x00" * (4 * 1024 * 1024)  # just over 4 MB decoded
    resp = await client.post(
        "/v1/attachments",
        headers=headers,
        json={"attachmentId": "att_big", "mediaType": "image/png", "base64": _b64(oversized)},
    )
    assert resp.status_code == 413
    assert resp.json() == {"error": {"message": "Attachment is too large (max 4 MB)."}}


async def test_over_quota_rejected(client, db_session) -> None:
    headers, user = await _auth(db_session)
    near_cap = 50 * 1024 * 1024 - 4
    db_session.add(
        Attachment(
            user_id=user.id,
            attachment_id="att_existing",
            media_type="image/png",
            name="",
            size=near_cap,
            storage_key=f"att/{user.id}/existing",
        )
    )
    await db_session.flush()
    resp = await client.post(
        "/v1/attachments",
        headers=headers,
        json={"attachmentId": "att_new", "mediaType": "image/png", "base64": _b64(_PNG)},
    )
    assert resp.status_code == 413
    body = resp.json()
    assert body["error"]["code"] == "ATTACHMENT_STORE_FULL"


async def test_a_zip_bomb_is_refused_on_the_upload_lane(client, db_session, fake_storage) -> None:
    """★ THE BOUND IS WIRED, NOT MERELY PRESENT (#214 R18b, ordering hazard 3).

    `assert_zip_not_bomb` had three callers, all server-side extraction arms this work deletes,
    and its own suite calls the function DIRECTLY — so that suite proves the algorithm and would
    have stayed green through the guard going completely unwired. The two tests that did prove
    wiring rode the very office kinds being removed.

    This is its replacement on the lane that now carries archives. A 4 MB `.xlsx` can declare 300
    MB uncompressed, and the new path is strictly more exposed than the old one: the office lane
    extracted inside a killable, memory-capped subprocess and never stored a file it could not
    read, while this one stores the archive and hands it to a reader in the citizen's own sandbox,
    where neither that ceiling nor that deadline reaches.

    Mutation receipt: remove the `assert_zip_not_bomb` call from the upload lane and this is the
    only test that goes red.
    """
    headers, _ = await _auth(db_session)
    bomb = _lying_zip({"xl/workbook.xml": b"<workbook/>"}, 400 * 1024 * 1024)

    resp = await client.post(
        "/v1/attachments",
        headers=headers,
        json={
            "attachmentId": "att_bomb",
            "name": "book.xlsx",
            "mediaType": EXCEL_MEDIA_TYPE,
            "base64": _b64(bomb),
        },
    )

    assert resp.status_code == 413, resp.text
    assert fake_storage.objects == {}  # refused BEFORE the store


async def test_the_conversation_count_cap_holds_for_a_chat_not_written_yet(
    client, db_session, fake_storage
) -> None:
    """★ THE CAP WAS BYPASSABLE ON THE ORDINARY PATH (#214 R7b).

    It was gated on `conversation_id is not None`, and an upload whose chat has no row yet stores
    NULL — which, since the first message of every new chat does exactly that, is the common case
    rather than a contrived one. Anything uploading without a link was uncapped.

    It counts the UNLINKED POOL — files that are also still unsent — which is the same population
    the byte budget uses for that case; each file leaves the pool when its message is sent.

    Mutation receipt: restore the `conversation_id is not None` gate and the 21st upload is
    accepted.
    """
    headers, _ = await _auth(db_session)
    for index in range(MAX_ATTACHMENTS_PER_CONVERSATION):
        resp = await client.post(
            "/v1/attachments",
            headers=headers,
            json={
                "attachmentId": f"att_unlinked_{index}",
                "name": "shot.png",
                "mediaType": "image/png",
                "base64": _b64(_PNG),
            },
        )
        assert resp.status_code == 201, resp.text

    over = await client.post(
        "/v1/attachments",
        headers=headers,
        json={
            "attachmentId": "att_unlinked_over",
            "name": "shot.png",
            "mediaType": "image/png",
            "base64": _b64(_PNG),
        },
    )

    assert over.status_code == 413, over.text
    assert over.json()["error"]["code"] == "CONVERSATION_ATTACHMENTS_FULL"


async def test_twenty_files_sent_elsewhere_do_not_block_a_new_chats_first_upload(
    client, db_session, fake_storage
) -> None:
    """★ AGC129'S B4 — the unlinked fallback used to be the whole account.

    The first upload of every new chat is unlinked, because its conversation row is written by the
    first send. Scoped to the account, it was counted against every attachment the citizen had ever
    sent anywhere: twenty files in old chats, and the next new chat's first upload was refused with
    "This conversation has reached its limit of 20 attachments" — on a chat holding zero, naming
    "start a new chat" as the remedy, which was the one move that could not help. The demo account
    had already been past it from rehearsal.

    Mutation receipt: put the account-wide scope back and this upload 413s.
    """
    headers, user = await _auth(db_session)
    elsewhere = await _a_conversation(db_session, user)
    for index in range(MAX_ATTACHMENTS_PER_CONVERSATION):
        db_session.add(
            Attachment(
                user_id=user.id,
                attachment_id=f"att_sent_{index}",
                media_type="image/png",
                name="",
                size=len(_PNG),
                storage_key=f"att/{user.id}/sent_{index}",
                conversation_id=elsewhere.id,
            )
        )
    await db_session.flush()

    resp = await client.post(
        "/v1/attachments",
        headers=headers,
        json={
            "attachmentId": "att_new_chat_first",
            "name": "roster.png",
            "mediaType": "image/png",
            "base64": _b64(_PNG),
            # No conversationId — the first upload of a chat whose row does not exist yet.
        },
    )

    assert resp.status_code == 201, resp.text


async def test_a_csv_is_not_run_through_the_archive_bound(
    client, db_session, fake_storage
) -> None:
    """★ THE CODE LANE IS NOT ALL ARCHIVES, and gating the zip-bomb check on the whole lane
    refused every CSV and TSV at the door.

    The refusal read "Malformed archive (no ZIP end-of-central-directory)" — a true statement
    about a file that was never supposed to be an archive, and unactionable advice to a citizen
    holding an ordinary spreadsheet export. Found by attaching one in the real UI; the test above
    stayed green throughout, because it only ever fed the check an `.xlsx`.

    A delimited file is bytes of text with no central directory to bound. The size cap is its
    bound, and the OOXML half keeps the archive check (asserted directly above).

    Mutation receipt: gate on `is_code_lane` instead of `is_opc_archive` and this goes red with a
    413 naming a ZIP.
    """
    headers, _ = await _auth(db_session)

    resp = await client.post(
        "/v1/attachments",
        headers=headers,
        json={
            "attachmentId": "att_plaincsv",
            "name": "movements.csv",
            "mediaType": "text/csv",
            "base64": _b64(b"badge,name,terminal\n1,Asha,T1\n2,Ravi,T2\n"),
        },
    )

    assert resp.status_code == 201, resp.text
    assert fake_storage.objects  # stored, not refused


# --- the conversation-scoped budgets (#214 R7a/R7b) ---------------------------


async def _a_conversation(db_session, user):
    project = await ProjectFactory.create(db_session, user.id)
    return await ConversationFactory.create(db_session, user.id, project_id=project.id)


async def _upload_into(client, headers, conversation_id, attachment_id, *, size=None):
    data = _PNG if size is None else _PNG + b"\x00" * (size - len(_PNG))
    return await client.post(
        "/v1/attachments",
        headers=headers,
        json={
            "attachmentId": attachment_id,
            "mediaType": "image/png",
            "base64": _b64(data),
            "conversationId": str(conversation_id),
        },
    )


async def test_a_full_conversation_does_not_exhaust_the_account(
    client, db_session, fake_storage
) -> None:
    """AE20 — the whole point of moving the budget (#214 R7a).

    It used to sum every attachment a citizen had ever uploaded, across every conversation, so
    two or three working sessions exhausted a lifetime allowance and the only way to reclaim any
    was to delete whole conversations. Now a full chat is a full chat: the next one has room, and
    "start a new chat" is advice that actually works.

    Mutation receipt: drop the conversation predicate from the budget query and the second
    upload 413s on bytes the other conversation spent.
    """
    headers, user = await _auth(db_session)
    first = await _a_conversation(db_session, user)
    db_session.add(
        Attachment(
            user_id=user.id,
            attachment_id="att_full",
            media_type="image/png",
            name="",
            size=ATTACHMENT_TOTAL_CAP - 8,
            storage_key=f"att/{user.id}/full",
            conversation_id=first.id,
        )
    )
    await db_session.flush()

    # The conversation holding it is full...
    refused = await _upload_into(client, headers, first.id, "att_more")
    assert refused.status_code == 413, refused.text
    assert refused.json()["error"]["code"] == "ATTACHMENT_STORE_FULL"

    # ...and a new one has room. This is the assertion the old per-citizen budget could not pass.
    second = await _a_conversation(db_session, user)
    accepted = await _upload_into(client, headers, second.id, "att_fresh")
    assert accepted.status_code == 201, accepted.text


async def test_a_full_conversation_says_so_and_names_a_way_out(
    client, db_session, fake_storage
) -> None:
    """AE21. The old copy was "Attachment storage is full. Remove some attachments and try
    again." — advice a citizen cannot follow, because nothing lets them remove one attachment
    from an old conversation. The refusal now names the thing that is full and the thing that
    works."""
    headers, user = await _auth(db_session)
    conversation = await _a_conversation(db_session, user)
    db_session.add(
        Attachment(
            user_id=user.id,
            attachment_id="att_full",
            media_type="image/png",
            name="",
            size=ATTACHMENT_TOTAL_CAP - 8,
            storage_key=f"att/{user.id}/full",
            conversation_id=conversation.id,
        )
    )
    await db_session.flush()

    resp = await _upload_into(client, headers, conversation.id, "att_more")

    message = resp.json()["error"]["message"]
    assert "new chat" in message.lower()
    assert "remove some attachments" not in message.lower()


async def test_the_conversation_attachment_count_is_enforced_on_the_server(
    client, db_session, fake_storage
) -> None:
    """AE18 — a cap a reload cannot clear (#214 R7b).

    The browser has had this number since the beginning and it was never enforced here: the
    portal tallies attachments by walking the messages it has loaded, so the count reset to zero
    on every refresh. Nothing on the server disagreed, because nothing on the server counted.

    Mutation receipt: remove the count check and the twenty-first upload is accepted.
    """
    headers, user = await _auth(db_session)
    conversation = await _a_conversation(db_session, user)
    for index in range(MAX_ATTACHMENTS_PER_CONVERSATION):
        db_session.add(
            Attachment(
                user_id=user.id,
                attachment_id=f"att_{index}",
                media_type="image/png",
                name="",
                size=len(_PNG),
                storage_key=f"att/{user.id}/{index}",
                conversation_id=conversation.id,
            )
        )
    await db_session.flush()

    resp = await _upload_into(client, headers, conversation.id, "att_one_too_many")

    assert resp.status_code == 413, resp.text
    assert resp.json()["error"]["code"] == "CONVERSATION_ATTACHMENTS_FULL"


async def test_re_uploading_a_file_the_conversation_already_holds_is_not_a_new_one(
    client, db_session, fake_storage
) -> None:
    """The count must not refuse an idempotent retry. A re-upload of the same id replaces its
    row rather than adding one, so counting it would break the retry the upload path is
    explicitly built to allow — a network hiccup mid-send would then wedge a full conversation
    permanently."""
    headers, user = await _auth(db_session)
    conversation = await _a_conversation(db_session, user)
    for index in range(MAX_ATTACHMENTS_PER_CONVERSATION - 1):
        db_session.add(
            Attachment(
                user_id=user.id,
                attachment_id=f"att_{index}",
                media_type="image/png",
                name="",
                size=len(_PNG),
                storage_key=f"att/{user.id}/{index}",
                conversation_id=conversation.id,
            )
        )
    await db_session.flush()

    first = await _upload_into(client, headers, conversation.id, "att_last")
    assert first.status_code == 201, first.text

    again = await _upload_into(client, headers, conversation.id, "att_last")

    assert again.status_code == 201, again.text


# --- download / delete ownership ----------------------------------------------


async def test_download_missing_404(client, db_session) -> None:
    headers, _ = await _auth(db_session)
    resp = await client.get("/v1/attachments/att_nope", headers=headers)
    assert resp.status_code == 404
    assert resp.json() == {"error": {"message": "Attachment not found."}}


async def test_download_cross_user_denied(client, db_session) -> None:
    headers_a, _ = await _auth(db_session)
    resp = await client.post(
        "/v1/attachments",
        headers=headers_a,
        json={"attachmentId": "att_shared", "mediaType": "image/png", "base64": _b64(_PNG)},
    )
    assert resp.status_code == 201
    # User B has no attachment with that id — owner-scoped lookup returns 404.
    headers_b, _ = await _auth(db_session)
    resp_b = await client.get("/v1/attachments/att_shared", headers=headers_b)
    assert resp_b.status_code == 404


async def test_delete_removes_object_and_row(client, db_session, fake_storage) -> None:
    headers, user = await _auth(db_session)
    await client.post(
        "/v1/attachments",
        headers=headers,
        json={"attachmentId": "att_del", "mediaType": "image/png", "base64": _b64(_PNG)},
    )
    assert len(fake_storage.objects) == 1

    resp = await client.delete("/v1/attachments/att_del", headers=headers)
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert fake_storage.objects == {}
    row = await db_session.scalar(
        select(Attachment).where(
            Attachment.user_id == user.id, Attachment.attachment_id == "att_del"
        )
    )
    assert row is None


async def test_delete_missing_is_idempotent(client, db_session) -> None:
    headers, _ = await _auth(db_session)
    resp = await client.delete("/v1/attachments/att_ghost", headers=headers)
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


async def test_delete_cross_user_is_noop_and_preserves_owner_data(
    client, db_session, fake_storage
) -> None:
    # Destructive-leak guard: B DELETEing A's attachmentId is a 200 no-op AND must NOT
    # touch A's row or blob — the `_load_owned(db, user.id, …)` scope predicate must hold.
    a_headers, user_a = await _auth(db_session)
    await client.post(
        "/v1/attachments",
        headers=a_headers,
        json={"attachmentId": "att_shared", "mediaType": "image/png", "base64": _b64(_PNG)},
    )
    assert len(fake_storage.objects) == 1

    b_headers, _ = await _auth(db_session)
    resp = await client.delete("/v1/attachments/att_shared", headers=b_headers)
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}  # idempotent no-op — B owns nothing

    assert len(fake_storage.objects) == 1
    row = await db_session.scalar(
        select(Attachment).where(
            Attachment.user_id == user_a.id, Attachment.attachment_id == "att_shared"
        )
    )
    assert row is not None


async def test_malformed_base64_rejected(client, db_session) -> None:
    # Exercises the tuple-except branch in _validate_attachment_bytes.
    headers, _ = await _auth(db_session)
    resp = await client.post(
        "/v1/attachments",
        headers=headers,
        json={"attachmentId": "att_b64", "mediaType": "image/png", "base64": "a"},
    )
    assert resp.status_code == 400
    assert "do not match the declared type" in resp.json()["error"]["message"]


def test_attachments_openapi_documents_codes() -> None:
    from src.main import create_app

    paths = create_app().openapi()["paths"]
    upload = set(paths["/v1/attachments"]["post"]["responses"])
    # "415" IS THE POINT OF THIS LINE. The subset operator makes every code here opt-in, so a
    # status the route raises without declaring passes unnoticed — which is exactly what the
    # locked-PDF 415 did until a review caught it. Anything raised gets named here.
    #
    # "501" IS GONE (#214). It was the deck converter's "PowerPoint attachments aren't enabled",
    # and the converter is deleted — a .pptx is stored as itself and read in the sandbox now.
    #
    # AND THIS LINE HAD TO CHANGE, which the retirement inventory predicted it would not: it read
    # the subset operator as making the assertion blind to a NARROWING. It is the opposite way
    # round — the literal set is on the LEFT, so every code named here must be present, and
    # dropping 501 from the route turned this red. The blindness is in the other direction, to a
    # code the route raises without declaring, which is what the comment above is about.
    assert {"400", "401", "404", "413", "415", "429", "500"} <= upload
    dl = set(paths["/v1/attachments/{attachment_id}"]["get"]["responses"])
    assert {"400", "404", "401", "500"} <= dl
    delete = set(paths["/v1/attachments/{attachment_id}"]["delete"]["responses"])
    assert {"400", "429", "401", "500"} <= delete


# --- conversation link --------------------------------------------------------


async def test_upload_links_owned_conversation(client, db_session, fake_storage) -> None:
    headers, user = await _auth(db_session)
    conv = await ConversationFactory.create(db_session, user.id)
    resp = await client.post(
        "/v1/attachments",
        headers=headers,
        json={
            "attachmentId": "att_linked",
            "mediaType": "image/png",
            "base64": _b64(_PNG),
            "conversationId": str(conv.id),
        },
    )
    assert resp.status_code == 201
    row = await db_session.scalar(
        select(Attachment).where(
            Attachment.user_id == user.id, Attachment.attachment_id == "att_linked"
        )
    )
    assert row is not None
    assert row.conversation_id == conv.id


async def test_upload_no_conversation_id_stores_null(client, db_session, fake_storage) -> None:
    # Existing clients that send no conversationId keep working — the nullable path.
    headers, user = await _auth(db_session)
    resp = await client.post(
        "/v1/attachments",
        headers=headers,
        json={"attachmentId": "att_unlinked", "mediaType": "image/png", "base64": _b64(_PNG)},
    )
    assert resp.status_code == 201
    row = await db_session.scalar(
        select(Attachment).where(
            Attachment.user_id == user.id, Attachment.attachment_id == "att_unlinked"
        )
    )
    assert row is not None
    assert row.conversation_id is None


async def test_upload_cross_user_conversation_404(client, db_session, fake_storage) -> None:
    # A well-formed conversationId the caller does NOT own is the same non-leaking 404 as a
    # missing one, and nothing is written or stored.
    a_headers, user_a = await _auth(db_session)
    conv_a = await ConversationFactory.create(db_session, user_a.id)

    b_headers, user_b = await _auth(db_session)
    resp = await client.post(
        "/v1/attachments",
        headers=b_headers,
        json={
            "attachmentId": "att_steal",
            "mediaType": "image/png",
            "base64": _b64(_PNG),
            "conversationId": str(conv_a.id),
        },
    )
    assert resp.status_code == 404
    assert resp.json() == {"error": {"message": "Conversation not found."}}
    assert fake_storage.objects == {}  # nothing stored on the reject path
    row = await db_session.scalar(
        select(Attachment).where(Attachment.attachment_id == "att_steal")
    )
    assert row is None


async def test_upload_for_a_chat_not_written_yet_stores_null(
    client, db_session, fake_storage
) -> None:
    """★ THE FIRST ATTACHMENT OF EVERY NEW CHAT (#214), and it used to be a 404.

    This test previously asserted the opposite — that a well-formed but unknown conversation id
    is refused — and that assertion was wrong about the product rather than about the code. The
    composer mints the id in the BROWSER and navigates to it; the conversation ROW is created by
    the first send, which happens strictly AFTER the file is uploaded (the send route stages the
    row and writes it only once every side-effect-free refusal has passed, R-18). So on the
    opening move of any new chat the id is real, unwritten, and refusing it makes attaching a
    file impossible until the citizen has sent a message without one.

    Found by driving the real UI, not by a test — every suite here passed while the feature's
    first step was broken, because they all attached to a conversation the fixture had already
    committed.

    NULL is the state the column was made nullable for, and the reclaimer reads it as legacy
    rather than as a deletion signal. `code_lane_attachments` still finds the file, by its id.
    """
    headers, _ = await _auth(db_session)
    resp = await client.post(
        "/v1/attachments",
        headers=headers,
        json={
            "attachmentId": "att_newchat",
            "mediaType": "image/png",
            "base64": _b64(_PNG),
            "conversationId": str(uuid.uuid4()),  # well-formed, not written yet
        },
    )

    assert resp.status_code == 201, resp.text
    row = await db_session.scalar(
        select(Attachment).where(Attachment.attachment_id == "att_newchat")
    )
    assert row is not None
    assert row.conversation_id is None
    assert fake_storage.objects  # the bytes were stored, not refused


async def test_upload_malformed_conversation_id_400(client, db_session, fake_storage) -> None:
    headers, _ = await _auth(db_session)
    resp = await client.post(
        "/v1/attachments",
        headers=headers,
        json={
            "attachmentId": "att_badconv",
            "mediaType": "image/png",
            "base64": _b64(_PNG),
            "conversationId": "not a uuid!",  # fails the id token shape
        },
    )
    assert resp.status_code == 400
    assert resp.json() == {"error": {"message": "Invalid conversation id."}}
    assert fake_storage.objects == {}


async def test_upload_rejected_parse_stores_no_object_with_conversation_id(
    client, db_session, fake_storage
) -> None:
    """★ RE-POINTED, NOT DELETED (#214, ordering hazard 4).

    The invariant here is about CONVERSATION LINKING, not about Office: a refused upload must
    leave no orphaned object even when the body carries a valid conversationId. It happened to
    ride the office branch as its vehicle, and that branch is gone — so it is re-pointed onto the
    code lane's own refusal rather than removed with the machinery it borrowed.

    Worth stating because the inventory predicted this test would simply disappear with the
    office arm. It does not: it goes RED, because a corrupt workbook now reaches the new lane and
    is refused there instead. Red is the good outcome — the silent one would have been it passing
    for a different reason and quietly stopping proving anything.
    """
    headers, user = await _auth(db_session)
    conv = await ConversationFactory.create(db_session, user.id)
    resp = await client.post(
        "/v1/attachments",
        headers=headers,
        json={
            "attachmentId": "att_corrupt",
            "name": "book.xlsx",
            "mediaType": EXCEL_MEDIA_TYPE,
            "base64": _b64(_zip_with({"readme.txt": b"not a workbook"})),
            "conversationId": str(conv.id),
        },
    )
    assert resp.status_code == 415
    assert fake_storage.objects == {}


async def test_reclaim_frees_quota_then_upload_succeeds(client, db_session, fake_storage) -> None:
    # A user at the 413 cap whose quota is all never-sent orphans can upload again after a sweep.
    from src.api.v1.attachments.router import ATTACHMENT_TOTAL_CAP

    headers, user = await _auth(db_session)
    near_cap = ATTACHMENT_TOTAL_CAP - 4
    old = datetime.datetime.now(datetime.UTC) - datetime.timedelta(days=30)
    key = f"att/{user.id}/old"
    db_session.add(
        Attachment(
            user_id=user.id,
            attachment_id="att_old",
            media_type="image/png",
            name="",
            size=near_cap,
            storage_key=key,
            created_at=old,
        )
    )
    await db_session.flush()
    fake_storage.objects[key] = b"x"

    over = await client.post(
        "/v1/attachments",
        headers=headers,
        json={"attachmentId": "att_new", "mediaType": "image/png", "base64": _b64(_PNG)},
    )
    assert over.status_code == 413

    result = await reclaim_orphaned_attachments(db_session, fake_storage, user_id=user.id)
    assert result.reclaimed == 1
    assert result.freed_bytes == near_cap
    assert key not in fake_storage.objects

    ok = await client.post(
        "/v1/attachments",
        headers=headers,
        json={"attachmentId": "att_new", "mediaType": "image/png", "base64": _b64(_PNG)},
    )
    assert ok.status_code == 201


# --- rate limit + auth --------------------------------------------------------


async def test_rate_limit_enforced(client, db_session) -> None:
    from src.api.v1.attachments.router import ATTACHMENT_RATE_LIMIT

    headers, _ = await _auth(db_session)
    payload = {"attachmentId": "att_rl", "mediaType": "image/png", "base64": _b64(_PNG)}
    for _ in range(ATTACHMENT_RATE_LIMIT):
        resp = await client.post("/v1/attachments", headers=headers, json=payload)
        assert resp.status_code == 201  # idempotent re-upload of the same id
    blocked = await client.post("/v1/attachments", headers=headers, json=payload)
    assert blocked.status_code == 429
    assert blocked.json() == {
        "error": {"message": "Too many attachment requests. Please slow down."}
    }


# --- office / deck branches ---------------------------------------------------


async def test_upload_non_string_name_400(client, db_session, fake_storage) -> None:
    headers, _ = await _auth(db_session)
    for bad in (123, ["shot.png"], {"n": "x"}):
        resp = await client.post(
            "/v1/attachments",
            headers=headers,
            json={
                "attachmentId": "att_badname",
                "name": bad,
                "mediaType": "image/png",
                "base64": _b64(_PNG),
            },
        )
        assert resp.status_code == 400, bad
        assert resp.json() == {"error": {"message": "name must be a string."}}, bad
    assert fake_storage.objects == {}  # nothing stored


async def test_upload_over_long_name_400(client, db_session, fake_storage) -> None:
    # `Attachment.name` is String(512); 513 is one past the boundary — the check must catch
    # it here, 400ing where the client can fix it, rather than 500ing at the DB flush.
    headers, _ = await _auth(db_session)
    resp = await client.post(
        "/v1/attachments",
        headers=headers,
        json={
            "attachmentId": "att_longname",
            "name": "n" * 513,
            "mediaType": "image/png",
            "base64": _b64(_PNG),
        },
    )
    assert resp.status_code == 400
    assert resp.json() == {"error": {"message": "name must be at most 512 characters."}}
    assert fake_storage.objects == {}  # nothing stored


async def test_upload_absent_name_defaults_to_empty(client, db_session) -> None:
    # Absent (and its `null` spelling) keeps the column's defined "" default — name is optional.
    headers, user = await _auth(db_session)
    resp = await client.post(
        "/v1/attachments",
        headers=headers,
        json={"attachmentId": "att_noname", "mediaType": "image/png", "base64": _b64(_PNG)},
    )
    assert resp.status_code == 201
    assert resp.json()["attachment"]["name"] == ""
    row = await db_session.scalar(
        select(Attachment).where(
            Attachment.user_id == user.id, Attachment.attachment_id == "att_noname"
        )
    )
    assert row is not None and row.name == ""


async def test_office_upload_non_string_name_400(client, db_session) -> None:
    # The name is parsed ONCE at the boundary, so the office branch is covered by the same check.
    headers, _ = await _auth(db_session)
    workbook = Workbook()
    buffer = io.BytesIO()
    workbook.save(buffer)
    resp = await client.post(
        "/v1/attachments",
        headers=headers,
        json={
            "attachmentId": "att_office_badname",
            "mediaType": EXCEL_MEDIA_TYPE,
            "base64": _b64(buffer.getvalue()),
            "name": 42,
        },
    )
    assert resp.status_code == 400
    assert resp.json() == {"error": {"message": "name must be a string."}}


async def test_requires_auth(client) -> None:
    assert (await client.get("/v1/attachments/att_1")).status_code == 401
    assert (await client.post("/v1/attachments", json={})).status_code == 401


# --- the PDF page cap ---------------------------------------------------------
#
# ★ WHAT THIS SECTION IS FOR. A 61-page document measured 153,342 tokens — 77% of the hard
# context limit — while the guardrail recorded it as 1,600, or 0.8%. The guardrail no longer
# guesses at all: it reads what the provider reported for a turn it served
# (`test_context_window.py`). That leaves THIS cap as the only bound acting before the provider
# has seen the file, which is why the page count is checked at admission.
#
# The cap is a PAGE count, not a byte count, and that is the whole reason a parser is involved:
# a text PDF runs ~1.3 KB a page and a scanned one ~300 KB, so the same 4 MB is anywhere from
# 13 to 3,200 pages. The existing 4 MB size cap cannot see the difference; the document that
# blew the limit was 79 KB.


async def _upload_pdf(client, headers, attachment_id: str, data: bytes, name: str = "doc.pdf"):
    return await client.post(
        "/v1/attachments",
        headers=headers,
        json={
            "attachmentId": attachment_id,
            "mediaType": "application/pdf",
            "base64": _b64(data),
            "name": name,
        },
    )


async def test_a_pdf_at_the_page_cap_is_accepted(client, db_session, fake_storage) -> None:
    """★ THE POSITIVE CASE, FIRST. Every other test in this section asserts a refusal, and a
    cap that refused every PDF would satisfy all of them. Exactly at the cap is admitted —
    "under 30 pages" in the refusal means the 30-page document goes through."""
    headers, _ = await _auth(db_session)

    resp = await _upload_pdf(client, headers, "att_cap", pdf_with_pages(MAX_PDF_PAGES))

    assert resp.status_code == 201, resp.text
    assert resp.json()["attachment"]["kind"] == "document"
    assert len(fake_storage.objects) == 1


async def test_a_pdf_one_page_over_the_cap_is_refused_in_plain_words(
    client, db_session, fake_storage
) -> None:
    """One page over, and the sentence a citizen reads.

    THE COPY IS THE ASSERTION, not decoration. The refusal has to name a limit the person can
    act on ("under 30 pages") and must not hand them the platform's vocabulary — no page
    objects, no parser, no bytes, no library name, no traceback. A body that leaks any of those
    is the failure this pins, and it is a security property as much as a copy one —
    internal errors must never be exposed to the frontend."""
    headers, _ = await _auth(db_session)

    resp = await _upload_pdf(client, headers, "att_over", pdf_with_pages(MAX_PDF_PAGES + 1))

    assert resp.status_code == 413, resp.text
    message = resp.json()["error"]["message"]
    assert message == "That document is too long to work with. Try one under 30 pages."
    body = resp.text.lower()
    for leak in ("pypdf", "traceback", "page object", "/type /page", "parse", "byte", "xref"):
        assert leak not in body, leak
    # And nothing was stored: a refused upload leaves no object and no row to reclaim later.
    assert fake_storage.objects == {}
    assert (
        await db_session.scalar(select(Attachment).where(Attachment.attachment_id == "att_over"))
    ) is None


async def test_an_image_never_reaches_the_page_counter(client, db_session, monkeypatch) -> None:
    """A PNG skips the check entirely — the parser is not called at all.

    Not merely "an image still uploads": that would pass with the counter running on every
    upload and quietly answering 1. Every image upload paying a subprocess spawn is a real
    regression in the common path, so the assertion is on the CALL, not on the outcome."""
    import src.api.v1.attachments.router as att_router
    from src.services.parse.governor import run_parse as real_run_parse

    calls: list[str] = []

    async def _spy(buffer, kind, filename, sheet, **kwargs):
        calls.append(kind)
        return await real_run_parse(buffer, kind, filename, sheet, **kwargs)

    monkeypatch.setattr(att_router, "run_parse", _spy)
    headers, _ = await _auth(db_session)

    resp = await client.post(
        "/v1/attachments",
        headers=headers,
        json={"attachmentId": "att_png", "mediaType": "image/png", "base64": _b64(_PNG)},
    )

    assert resp.status_code == 201
    assert calls == []


async def test_a_corrupt_pdf_is_refused_with_the_same_sentence_not_a_500(
    client, db_session, fake_storage
) -> None:
    """Magic-valid bytes that will not parse.

    The 18-byte prefix check passes — `%PDF-1.4` is all it reads — so before the page cap
    existed this was STORED and sent to the model as a document. It must now be refused, and
    refused as a client error rather than as a server one: a 500 here would be the platform
    reporting its own failure for the citizen's malformed file, and would put a stack trace one
    config flag away from the browser.

    It wears the SAME sentence as the over-cap refusal on purpose. There is nothing true and
    useful the platform can tell someone about a PDF it could not read, and a second sentence
    would have to reach for parser vocabulary to say anything at all. The real cause is logged
    server-side, where an operator can act on it."""
    headers, _ = await _auth(db_session)

    resp = await _upload_pdf(client, headers, "att_corrupt", unreadable_pdf())

    assert resp.status_code == 413, resp.text
    assert (
        resp.json()["error"]["message"]
        == "That document is too long to work with. Try one under 30 pages."
    )
    assert fake_storage.objects == {}


async def test_a_locked_pdf_is_told_it_is_locked_not_that_it_is_too_long(
    client, db_session, fake_storage
) -> None:
    """★ THE ONE PDF REFUSAL THE CITIZEN CAN ACT ON, so it is the one that does not get the
    collapsed sentence.

    A password-protected PDF parses far enough to say it is locked and no further, so it lands
    in the same `FileParseError` arm as a corrupt file. Under the collapse that made it "too
    long to work with — try one under 30 pages", which is advice that cannot be followed: this
    fixture is THREE pages. A citizen holding a locked invoice would shorten it, be refused
    again, and learn nothing. That is the shape `attachmentInput.ts` records as advice only
    being honest while it leads somewhere.

    A 415 rather than a 413, because nothing about the file's size was the problem. The
    sentence still names no parser, no encryption scheme and no internal state, so it keeps the
    property the collapsed sentence exists for."""
    headers, _ = await _auth(db_session)

    resp = await _upload_pdf(client, headers, "att_locked", locked_pdf(pages=3))

    assert resp.status_code == 415, resp.text
    body = resp.json()["error"]
    assert body["message"] == (
        "That document is password-protected. Remove the password and upload it again."
    )
    assert body["code"] == "PDF_ENCRYPTED"
    # It must not be told the length is the problem — the document is well under the cap.
    assert "too long" not in body["message"]
    assert "30 pages" not in body["message"]
    # And it leaks nothing about how we found out.
    assert not re.search(r"pypdf|decrypt|encrypt|cipher|/Encrypt|parser", body["message"], re.I)
    # Refused before the store, like every other arm.
    assert fake_storage.objects == {}


async def test_an_encrypted_pdf_cannot_lie_its_way_past_the_page_cap(
    client, db_session, fake_storage
) -> None:
    """★ THE BYPASS THAT DEFEATS THE PAGE CAP, AT THE ROUTE THAT HAS TO CLOSE IT.

    A permission-restricted PDF — empty user password, so every reader including ours opens it
    unasked — whose catalog DECLARES one page and whose page tree carries twenty thousand. It
    costs 120 KB, well inside the 4 MB size cap, and before this check it was admitted: pypdf
    returns the declared `/Count` unwalked for any encrypted file, so the count the cap compared
    against was the uploader's own number.

    Two assertions, and they pull in opposite directions on purpose. It must NOT be refused for
    encryption — the file is perfectly readable and the 415 would be a lie the citizen cannot
    act on — and it MUST be refused for length, which is the true fact about it."""
    headers, _ = await _auth(db_session)

    resp = await _upload_pdf(
        client, headers, "att_encrypted_liar", restricted_pdf(pages=20_000, declares=1)
    )

    assert resp.status_code == 413, resp.text
    body = resp.json()["error"]
    assert body["message"] == "That document is too long to work with. Try one under 30 pages."
    assert "password" not in body["message"].lower()
    # Refused before the store, like every other arm: no object, no row to reclaim later.
    assert fake_storage.objects == {}
    assert (
        await db_session.scalar(
            select(Attachment).where(Attachment.attachment_id == "att_encrypted_liar")
        )
    ) is None


async def test_a_permission_restricted_pdf_is_uploaded_like_any_other_document(
    client, db_session, fake_storage
) -> None:
    """★ THE POSITIVE CASE FOR THE ENCRYPTED PATH, and the one a careless fix breaks.

    "Refuse encrypted PDFs" closes the bypass above and every other test in this file still
    passes — while refusing the ordinary encrypted document an office produces, where
    permissions are set and the user password is left empty. That file opens without a
    password, so there is nothing the citizen could be told to do about it.

    Three pages, honestly declared, and it is stored: encryption is not the question the cap
    asks. Only a file an empty password will not open is refused, and that is `locked_pdf`
    above wearing its own 415."""
    headers, _ = await _auth(db_session)

    resp = await _upload_pdf(client, headers, "att_restricted", restricted_pdf(pages=3))

    assert resp.status_code == 201, resp.text
    assert resp.json()["attachment"]["kind"] == "document"
    assert len(fake_storage.objects) == 1


# THE DECK-CAP TEST WENT WITH THE DECK PATH (#214 R27). It proved that a 60-page deck cleared
# the pptx branch's own 100-page limit while the 30-page upload cap applied to PDFs — two caps
# that disagreed on purpose, because a deck was rendered to PDF by a converter that was never
# deployed. There is no pptx branch and no converter now: a deck is stored as itself and read in
# the sandbox, so it is governed by the size cap like every other code-lane file, and there is no
# second page count for the two to disagree about.


async def test_a_pdf_that_hangs_the_parser_is_killed_and_the_worker_keeps_serving(
    client, db_session, monkeypatch, fake_storage
) -> None:
    """★ THE INVARIANT THAT MAKES THE PAGE COUNT SAFE TO TAKE AT ALL.

    `xref_bomb_pdf()` is 8 KB and takes a reader seven to twelve seconds — inside the 4 MB size
    cap, inside the memory ceiling, unbounded in the only axis neither of them watches. Read on
    the event loop it stalls the worker serving every other citizen's request; read in the
    governor's subprocess it is terminated at the deadline and the request answers.

    The governor is the REAL one — same spawned child, same pypdf, same hostile bytes, really
    killed. Only the deadline is shortened, so the test costs a second instead of ten.

    MUTATION: replace the `run_parse` call in the router with a direct in-process `pypdf` read.
    The patched deadline is then never consulted, the handler blocks for the full parse, and
    this goes red twice over — on the status (the bomb resolves to one page, so it would be
    STORED) and on the elapsed time."""
    import src.api.v1.attachments.router as att_router
    from src.services.parse.governor import run_parse as real_run_parse

    async def _short_deadline(buffer, kind, filename, sheet, **kwargs):
        return await real_run_parse(buffer, kind, filename, sheet, timeout=1.0)

    monkeypatch.setattr(att_router, "run_parse", _short_deadline)
    headers, _ = await _auth(db_session)

    started = time.monotonic()
    resp = await _upload_pdf(client, headers, "att_bomb", xref_bomb_pdf())
    elapsed = time.monotonic() - started

    assert resp.status_code == 413, resp.text
    assert (
        resp.json()["error"]["message"]
        == "That document is too long to work with. Try one under 30 pages."
    )
    assert elapsed < 5.0, f"the request should return at the deadline, took {elapsed:.1f}s"
    assert fake_storage.objects == {}
    # And the worker is still serving: with the real deadline back, the very next upload
    # succeeds. (The shortened one is under the cost of spawning the child at all, so it would
    # refuse an honest document too — which is the reason the product's deadline is 10 s.)
    monkeypatch.undo()
    ok = await _upload_pdf(client, headers, "att_after", pdf_with_pages(1))
    assert ok.status_code == 201, ok.text


# --- the log that pays for the collapsed sentence ------------------------------
#
# ★ WHY THESE TWO TESTS EXIST. `_assert_pdf_within_page_cap` deliberately answers four distinct
# refusals — over the cap, unreadable, killed at the deadline, contained OOM — with ONE citizen-
# facing sentence, and both its docstring and `PDF_TOO_LONG_TEXT`'s justify that collapse by
# promising the real cause reaches the server-side log where an operator can act on it. That
# promise IS the compensating control the collapse was traded for, so it is asserted rather than
# assumed. It was not free: the module logged through stdlib `logging`, which nothing in this
# process configures — the over-cap line vanished at the root and the failure line reached
# `lastResort`, whose bare `%(message)s` dropped `code` and `status` on the floor.
#
# Both assert the FIELDS, not just the event name. An event name alone tells an operator a PDF
# was refused, which they already knew from the 413; the fields are the entire distinguishing
# detail the citizen was not given.


async def test_the_over_cap_refusal_logs_the_pages_and_the_cap(client, db_session) -> None:
    """The over-cap arm names both numbers, so an operator can see a 31-page document met a
    30-page cap without re-deriving either from the refused upload."""
    headers, _ = await _auth(db_session)

    with capture_logs() as logs:
        resp = await _upload_pdf(
            client, headers, "att_log_over", pdf_with_pages(MAX_PDF_PAGES + 1)
        )

    assert resp.status_code == 413, resp.text
    over = [entry for entry in logs if entry["event"] == "pdf_over_page_cap"]
    assert over, f"no pdf_over_page_cap event in {[e['event'] for e in logs]}"
    assert over[0]["pages"] == MAX_PDF_PAGES + 1
    assert over[0]["cap"] == MAX_PDF_PAGES


async def test_the_unreadable_and_locked_refusals_log_the_cause_that_tells_them_apart(
    client, db_session
) -> None:
    """★ THE DISCRIMINATION, not merely the presence of a line.

    A corrupt PDF and a locked one are the same 413/415 shrug to the citizen by design, so the
    log is the ONLY place the two are distinguishable. Two uploads, two different `code`s, and a
    `status` that is the PARSER's (400 — the caller's file, not the platform failing), not the
    413 the citizen was shown. A log line that hardcoded either field, or that carried the event
    name alone, would leave an operator exactly as informed as the refused citizen."""
    headers, _ = await _auth(db_session)

    with capture_logs() as corrupt_logs:
        corrupt = await _upload_pdf(client, headers, "att_log_corrupt", unreadable_pdf())
    with capture_logs() as locked_logs:
        locked = await _upload_pdf(client, headers, "att_log_locked", locked_pdf(pages=3))

    assert corrupt.status_code == 413, corrupt.text
    assert locked.status_code == 415, locked.text

    failures = [
        entry
        for entries in (corrupt_logs, locked_logs)
        for entry in entries
        if entry["event"] == "pdf_page_check_failed"
    ]
    assert len(failures) == 2, f"expected both refusals logged, got {failures}"
    assert [entry["code"] for entry in failures] == ["INVALID_PDF", "PDF_ENCRYPTED"]
    assert [entry["status"] for entry in failures] == [400, 400]
