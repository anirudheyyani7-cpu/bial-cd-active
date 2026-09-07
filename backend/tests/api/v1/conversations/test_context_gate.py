"""The per-conversation guardrail, at the routes that enforce it.

★ THIS IS THE FILE WHOSE ABSENCE LET THE REGRESSION THROUGH. The old client-side guardrail died
with `ChatPage.tsx` and nothing turned red, because the only tests that covered it were
deleted in the same commit. Meanwhile an administrator had been setting a number in a field
whose help text promised a hard stop, and no call site anywhere — front or back — read it.

Every test here is about the number MEANING something. A gate that refused everything would
satisfy half of them, which is why the first one exists.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import uuid
from typing import Any

import pytest
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    UserPromptPart,
)
from pydantic_ai.models.function import (
    AgentInfo,
    DeltaToolCall,
    DeltaToolCalls,
    FunctionModel,
)
from sqlalchemy import func, select

from src.api.v1.conversations._shared import chat_model as chat_model_dep
from src.db.models.conversation import ChatKind
from src.db.models.message import Message, MessageEntryKind
from src.db.models.token_usage import TokenUsage
from src.db.models.user_limit import UserLimit
from src.main import create_app
from src.services.messages.store import append_batch
from src.services.turns.copy import CHAT_TOO_LONG_CODE, CHAT_TOO_LONG_TEXT
from src.services.turns.plan_options import find_pending
from src.services.usage.limits import (
    CONTEXT_HARD_FLOOR,
    DEFAULT_CONTEXT_HARD,
    SYSTEM_PROMPT_RESERVE,
)
from tests.api.v1.conversations.conftest import _headers
from tests.factories import ConversationFactory, ProjectFactory, UserFactory
from tests.pdfs import pdf_with_pages

# The turn-driving fixtures live in `conftest.py` — four files needed the same four, and
# two of them were the 3rd and 4th copy. Named here rather than autouse there, because the
# other files in this directory drive no turns.
pytestmark = pytest.mark.usefixtures("_fresh_engine", "_override_billing")


@pytest.fixture(autouse=True)
def _a_model(app) -> None:
    """Every test here should be decided by the GUARDRAIL, never by a missing model. Bound for
    all of them so a 503 can never be mistaken for a refusal that worked."""
    from src.api.v1.conversations._shared import chat_model

    async def _stream(_messages: list[ModelMessage], _info: AgentInfo):
        yield "ok"

    app.dependency_overrides[chat_model] = lambda: FunctionModel(stream_function=_stream)


async def _settle(engine: Any, conversation_id: uuid.UUID) -> None:
    state = engine.peek(conversation_id)
    if state is None or state.task is None:
        return
    with contextlib.suppress(asyncio.CancelledError):
        await asyncio.wait_for(state.task, timeout=10)


async def _send(client, user, conversation_id: uuid.UUID, text: str = "carry on"):
    return await client.post(
        f"/v1/conversations/{conversation_id}/turns",
        headers=_headers(user),
        json={"message": {"text": text, "attachmentTexts": [], "attachmentIds": []}},
    )


async def _stuff_the_conversation(db_session, user, conversation, *, tokens: int) -> None:
    """Persist a conversation that MEASURES at roughly `tokens`, through the real store — not a
    stub of it. The gate reads what `load_history` returns, so a history assembled any other way
    would prove the measurement and not the wiring."""
    chars = tokens * 4
    await append_batch(
        db_session,
        user_id=user.id,
        conversation_id=conversation.id,
        messages=[
            ModelRequest(parts=[UserPromptPart(content="q" * (chars // 2))]),
            ModelResponse(parts=[TextPart(content="a" * (chars // 2))]),
        ],
        entry_kind=MessageEntryKind.TURN,
        kind=conversation.kind,
    )
    await db_session.commit()


def _offering_model(call_id: str = "opt-build", plan: str = "Build the visitor log."):
    """A Plan turn whose whole output is the offer call — the shape that leaves a pending card
    for the handoff route to find."""

    async def _stream(_messages: list[ModelMessage], _info: AgentInfo):
        yield DeltaToolCalls(
            {
                0: DeltaToolCall(
                    name="present_plan_options",
                    json_args=json.dumps({"plan": plan}),
                    tool_call_id=call_id,
                )
            }
        )

    return FunctionModel(stream_function=_stream)


def _plain_model() -> FunctionModel:
    """A turn that answers with prose and offers nothing — so the card under test is the one
    the PREVIOUS turn left pending, never a fresh one this turn presented."""

    async def _stream(_messages: list[ModelMessage], _info: AgentInfo):
        yield "here is a revised idea"

    return FunctionModel(stream_function=_stream)


async def _a_conversation(db_session, *, kind: ChatKind = ChatKind.PLAN):
    user = await UserFactory.create(db_session)
    project = await ProjectFactory.create(db_session, user.id)
    conversation = await ConversationFactory.create(
        db_session, user.id, project_id=project.id, kind=kind
    )
    return user, project, conversation


# =============================================================================
# The gate has to let ordinary conversations through
# =============================================================================


async def test_a_short_conversation_starts_a_turn_normally(
    client, db_session, _fresh_engine
) -> None:
    """★ THE POSITIVE CASE, FIRST. Every other test here asserts a refusal, and a gate that
    refused every turn would pass all of them. This is the one that says the guardrail is a
    boundary rather than a wall."""
    user, _project, conversation = await _a_conversation(db_session)
    await _stuff_the_conversation(db_session, user, conversation, tokens=1_000)

    resp = await _send(client, user, conversation.id)

    assert resp.status_code == 202, resp.text
    await _settle(_fresh_engine, conversation.id)


# =============================================================================
# Past the limit: refused, and nothing written
# =============================================================================


async def test_an_over_long_conversation_is_refused_before_anything_persists(
    client, db_session, _fresh_engine
) -> None:
    """The refusal, and the property that makes it safe to refuse at all.

    `enforce_context_limit` runs after `load_history` and before the persist, so a refused
    message leaves NO turn row and NO usage row. Move the gate below the persist and this goes
    red on the counts rather than on the status — which is the failure that matters, because a
    half-recorded turn is a transcript that disagrees with what the citizen saw."""
    user, _project, conversation = await _a_conversation(db_session)
    await _stuff_the_conversation(db_session, user, conversation, tokens=DEFAULT_CONTEXT_HARD)
    rows_before = await db_session.scalar(
        select(func.count()).select_from(Message).where(Message.conversation_id == conversation.id)
    )

    resp = await _send(client, user, conversation.id)

    assert resp.status_code == 413
    body = resp.json()
    assert body["error"]["code"] == CHAT_TOO_LONG_CODE
    assert body["error"]["message"] == CHAT_TOO_LONG_TEXT

    rows_after = await db_session.scalar(
        select(func.count()).select_from(Message).where(Message.conversation_id == conversation.id)
    )
    assert rows_after == rows_before
    usage = await db_session.scalar(
        select(func.count()).select_from(TokenUsage).where(TokenUsage.user_id == user.id)
    )
    assert usage == 0
    # Nothing was claimed either — a refused turn must leave the conversation sendable.
    assert _fresh_engine.peek(conversation.id) is None


async def test_the_refusal_names_the_way_out(client, db_session) -> None:
    """The sentence a citizen reads is written on the SERVER and rendered verbatim, so this
    is where the property is pinned. Two facts, both load-bearing: what to do (start a new
    chat) and that the app survives it — without the second, "too long" reads as "lost"."""
    user, _project, conversation = await _a_conversation(db_session)
    await _stuff_the_conversation(db_session, user, conversation, tokens=DEFAULT_CONTEXT_HARD)

    message = (await _send(client, user, conversation.id)).json()["error"]["message"]

    assert "new chat" in message
    assert "stays exactly as it is" in message
    assert str(DEFAULT_CONTEXT_HARD) not in message  # never quotes the number
    assert "200,000" not in message


# =============================================================================
# The administrator's number is the boundary — the whole point of the unit
# =============================================================================


async def test_an_administrator_override_changes_what_the_platform_accepts(
    client, db_session, _fresh_engine
) -> None:
    """★ THE TEST THAT PROVES THE ADMIN FIELD IS NO LONGER A LIE.

    One size, two users: the default limit sends it, a per-user hard limit set below that
    size refuses it, and nothing else differs — the number is the only thing that changed.
    Without this, a gate hard-wired to `DEFAULT_CONTEXT_HARD` would pass every other test
    here and leave `UsersLimitsPanel.tsx`'s "Hard stop" hint exactly as false as it was."""
    size = 40_000

    allowed_user, _p1, allowed_conv = await _a_conversation(db_session)
    await _stuff_the_conversation(db_session, allowed_user, allowed_conv, tokens=size)
    assert (await _send(client, allowed_user, allowed_conv.id)).status_code == 202
    await _settle(_fresh_engine, allowed_conv.id)

    capped_user, _p2, capped_conv = await _a_conversation(db_session)
    await _stuff_the_conversation(db_session, capped_user, capped_conv, tokens=size)
    db_session.add(UserLimit(user_id=capped_user.id, context_hard_limit=size // 2))
    await db_session.commit()

    refused = await _send(client, capped_user, capped_conv.id)

    assert refused.status_code == 413
    assert refused.json()["error"]["code"] == CHAT_TOO_LONG_CODE


async def test_an_override_above_the_model_window_is_clamped_not_honoured(
    client, db_session
) -> None:
    """`effective_context` caps a hard limit at the model's real window. An administrator cannot
    raise a chat past what the model can actually read, which is what the admin field's own
    "Max 200,000 (model window)" hint promises."""
    user, _project, conversation = await _a_conversation(db_session)
    await _stuff_the_conversation(db_session, user, conversation, tokens=DEFAULT_CONTEXT_HARD)
    db_session.add(UserLimit(user_id=user.id, context_hard_limit=10_000_000))
    await db_session.commit()

    assert (await _send(client, user, conversation.id)).status_code == 413


async def test_a_user_with_no_override_is_governed_by_the_default(client, db_session) -> None:
    user, _project, conversation = await _a_conversation(db_session)
    existing = await db_session.scalar(
        select(func.count()).select_from(UserLimit).where(UserLimit.user_id == user.id)
    )
    assert existing == 0
    # Just past the default, allowing for the reserve the gate holds back.
    await _stuff_the_conversation(
        db_session, user, conversation, tokens=DEFAULT_CONTEXT_HARD - SYSTEM_PROMPT_RESERVE + 10
    )

    assert (await _send(client, user, conversation.id)).status_code == 413


# =============================================================================
# The second door
# =============================================================================


async def test_the_same_refusal_fires_on_the_build_from_plan_path(
    client, app, db_session, _fresh_engine
) -> None:
    """★ THE MOST LIKELY IMPLEMENTATION MISTAKE: `build_it` is the second route that starts
    a turn, and wiring the guardrail to the send route alone lets "Build this plan" walk
    straight past the administrator's number.

    Driven at `CONTEXT_HARD_FLOOR`, the lowest ceiling an administrator can set, against a
    plan deliberately larger than it — anything lower gets silently clamped back up to the
    floor, which would let the plan fit and stop testing the gate at all."""
    # A REAL pending offer, through the genuine engine path — the handoff refuses a press
    # with no card before it reaches any limit, so the GATE has to be what fails this test.
    user, _project, plan_chat = await _a_conversation(db_session)
    # Comfortably past the floor with the reserve added, and under the stored-message
    # ceiling that would refuse the offer for a different reason entirely.
    oversized_plan = "Log every visitor. " * 2_500
    app.dependency_overrides[chat_model_dep] = lambda: _offering_model(plan=oversized_plan)
    planned = await _send(client, user, plan_chat.id, "plan the visitors app")
    assert planned.status_code == 202, planned.text
    await _settle(_fresh_engine, plan_chat.id)

    # NOW the administrator's ceiling arrives, at the lowest value the product will store.
    db_session.add(UserLimit(user_id=user.id, context_hard_limit=CONTEXT_HARD_FLOOR))
    await db_session.commit()
    rows_before = await db_session.scalar(
        select(func.count()).select_from(Message).where(Message.user_id == user.id)
    )

    resp = await client.post(
        f"/v1/conversations/{plan_chat.id}/plan-options/opt-build/build",
        headers=_headers(user),
        json={"chatId": str(uuid.uuid7())},
    )

    # Whatever else this press would have hit, it must not be allowed to start a build for a
    # user whose ceiling it is already past.
    assert resp.status_code == 413, resp.text
    assert resp.json()["error"]["code"] == CHAT_TOO_LONG_CODE
    # And no build chat was created — the offer row is all that is there.
    written = await db_session.scalar(
        select(func.count()).select_from(Message).where(Message.user_id == user.id)
    )
    assert written == rows_before


# =============================================================================
# The contract the browser reads
# =============================================================================


def test_the_refusal_is_documented_on_both_routes() -> None:
    """A refusal nothing documents is one a client is never told to expect. Both doors carry the
    same status, because a browser that had to learn two would learn one."""
    paths = create_app().openapi()["paths"]
    send = paths["/v1/conversations/{conversation_id}/turns"]["post"]
    build = paths["/v1/conversations/{conversation_id}/plan-options/{tool_call_id}/build"]["post"]
    assert "413" in send["responses"]
    assert "413" in build["responses"]


def test_the_code_is_byte_stable() -> None:
    """Nothing in the refusal path is exhaustive — no `Literal` union, no native enum, no
    `assertNever`. Every code is an open string, so a rename is free, silent, and still
    compiles. This is the guard that notices."""
    assert CHAT_TOO_LONG_CODE == "context_hard_limit_exceeded"


async def test_a_refused_turn_does_not_burn_a_pending_plan_card(
    client, app, db_session, _fresh_engine
) -> None:
    """★ THE ORDERING TRAP: `start_turn` resolves a pending plan-options card as an implicit
    "keep refining" once free text passes it — a WRITE the rollback does not cover, because
    `resolve_pending_as_refine` reaches `append_batch`, which owns its own commit. A refusal
    raised after that write leaves the card resolved on disk and the offer silently burned,
    with nothing on screen saying so. The gate sits ABOVE that write for exactly this reason.

    Mutation check: move `enforce_context_limit` back below `resolve_pending_as_refine` and
    this goes red while every other test in this file stays green."""
    user, _project, conversation = await _a_conversation(db_session)
    app.dependency_overrides[chat_model_dep] = lambda: _offering_model()
    assert (await _send(client, user, conversation.id, "plan it")).status_code == 202
    await _settle(_fresh_engine, conversation.id)
    assert await find_pending(db_session, user_id=user.id, conversation_id=conversation.id), (
        "the offer has to be pending, or this test asserts nothing"
    )

    await _stuff_the_conversation(db_session, user, conversation, tokens=DEFAULT_CONTEXT_HARD)

    refused = await _send(client, user, conversation.id, "actually, more like this")
    assert refused.status_code == 413
    assert refused.json()["error"]["code"] == CHAT_TOO_LONG_CODE

    # The card the citizen can still press.
    still_pending = await find_pending(
        db_session, user_id=user.id, conversation_id=conversation.id
    )
    assert still_pending is not None


async def test_an_accepted_turn_still_resolves_a_pending_card(
    client, app, db_session, _fresh_engine
) -> None:
    """The other half, so the fix above cannot be "never resolve anything": free text past a
    pending card, in a conversation comfortably under the limit, still resolves the card."""
    user, _project, conversation = await _a_conversation(db_session)
    app.dependency_overrides[chat_model_dep] = lambda: _offering_model()
    assert (await _send(client, user, conversation.id, "plan it")).status_code == 202
    await _settle(_fresh_engine, conversation.id)
    assert await find_pending(db_session, user_id=user.id, conversation_id=conversation.id)

    app.dependency_overrides[chat_model_dep] = lambda: _plain_model()
    assert (await _send(client, user, conversation.id, "more like this")).status_code == 202
    await _settle(_fresh_engine, conversation.id)

    assert await find_pending(db_session, user_id=user.id, conversation_id=conversation.id) is None


# =============================================================================
# Documents (U6 / D4) — what a PDF costs, at the route that spends it
# =============================================================================
#
# The upload cap next door (`test_attachments.py`) refuses a document longer than 30 pages; the
# window charge (`test_context_window.py`) prices an admitted one at what its pages cost. Both
# are unit-level. What only shows up HERE is what those two numbers do to a real send: the third
# document on one message, and a conversation that already holds two.


@pytest.fixture
def shared_storage(fake_storage, monkeypatch):
    """ONE store for both consumers of it. The upload route takes its store by injected
    dependency; the send route's rehydrator reaches the accessor-level `get_storage()`. The
    directory fixture binds only the first, so a test that uploads and then SENDS the upload
    needs the accessor bound to the same object or the send answers 503 and proves nothing."""
    from src.services.storage import accessor

    monkeypatch.setattr(accessor, "_backend_singleton", fake_storage)
    return fake_storage


async def _upload(client, user, attachment_id: str, media_type: str, data: bytes) -> None:
    resp = await client.post(
        "/v1/attachments",
        headers=_headers(user),
        json={
            "attachmentId": attachment_id,
            "mediaType": media_type,
            "base64": base64.b64encode(data).decode(),
            "name": f"{attachment_id}.bin",
        },
    )
    assert resp.status_code == 201, resp.text


async def _send_with(client, user, conversation_id: uuid.UUID, ids: list[str], text="here"):
    return await client.post(
        f"/v1/conversations/{conversation_id}/turns",
        headers=_headers(user),
        json={"message": {"text": text, "attachmentTexts": [], "attachmentIds": ids}},
    )


async def test_three_documents_on_one_message_are_refused_by_count_not_by_tokens(
    client, db_session, shared_storage
) -> None:
    """★ THE REFUSAL THAT HAD TO BE ITS OWN SENTENCE.

    Three documents is 3 x 75,000 plus the 8,000 reserve — 233,000 against a 200,000 ceiling —
    so the token gate would refuse it anyway, and would refuse it with `CHAT_TOO_LONG_TEXT`.
    That copy says "start a new chat", which here is WRONG ADVICE: the new chat refuses the
    identical message, so the citizen is sent round a loop with no way out. `MAX_ATTACHMENT_BLOCKS`
    meanwhile still advertises eight attachments, so nothing on the way in warned them.

    So the third document is refused by count, before the tokens are counted, with a sentence
    that names the DOCUMENT limit and an action that works. Delete the count check and this
    goes red on the copy — the request still fails, but it fails telling the citizen something
    untrue."""
    user, _project, conversation = await _a_conversation(db_session)
    for index in range(3):
        await _upload(client, user, f"doc_{index}", "application/pdf", pdf_with_pages(2))

    resp = await _send_with(client, user, conversation.id, ["doc_0", "doc_1", "doc_2"])

    assert resp.status_code == 413, resp.text
    body = resp.json()["error"]
    assert body["code"] == "too_many_documents"
    assert body["message"] == (
        "You can send up to 2 documents in one message. Take one out and send again."
    )
    # Emphatically NOT the too-long copy, whose advice does not work here.
    assert body["code"] != CHAT_TOO_LONG_CODE
    assert "new chat" not in body["message"]
    # And nothing was written — the refusal is side-effect-free like every other one above the
    # persist, so the citizen can fix the message and send it again.
    rows = await db_session.scalar(
        select(func.count()).select_from(Message).where(Message.conversation_id == conversation.id)
    )
    assert rows == 0


async def test_two_documents_on_one_message_are_allowed(
    client, db_session, shared_storage, _fresh_engine
) -> None:
    """The boundary, from the permitted side. A cap that refused two would satisfy the test
    above and quietly make the product worse than it was."""
    user, _project, conversation = await _a_conversation(db_session)
    for index in range(2):
        await _upload(client, user, f"pair_{index}", "application/pdf", pdf_with_pages(2))

    resp = await _send_with(client, user, conversation.id, ["pair_0", "pair_1"])

    assert resp.status_code == 202, resp.text
    await _settle(_fresh_engine, conversation.id)


async def test_eight_images_still_send_the_document_cap_is_not_an_attachment_cap(
    client, db_session, shared_storage, _fresh_engine
) -> None:
    """`MAX_ATTACHMENT_BLOCKS` is 8 and stays 8. The new limit counts DOCUMENTS, so a message
    carrying eight screenshots is unaffected — an image is charged 1,600, and eight of them plus
    the reserve is nowhere near the wall. Count binaries instead of documents and this goes red."""
    user, _project, conversation = await _a_conversation(db_session)
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
    for index in range(8):
        await _upload(client, user, f"shot_{index}", "image/png", png)

    resp = await _send_with(client, user, conversation.id, [f"shot_{index}" for index in range(8)])

    assert resp.status_code == 202, resp.text
    await _settle(_fresh_engine, conversation.id)


async def test_a_conversation_that_already_holds_two_documents_is_refused_at_its_next_message(
    client, db_session, shared_storage, _fresh_engine
) -> None:
    """★ THE DEPLOY-TIME CONSEQUENCE, ASSERTED RATHER THAN DISCOVERED.

    The gate re-counts the WHOLE history on every send and stored `BinaryContent` is in it, so
    raising the document charge changes the answer for conversations that already exist. A chat
    holding two documents and a real build conversation is now refused at its next message where
    yesterday it sailed on — and that is the point, because yesterday it sailed on into an opaque
    provider-side failure instead.

    The control is the load-bearing half: the SAME conversation shape with two IMAGES in place of
    the two documents still sends. Nothing else differs, so the only thing that can have changed
    the answer is what a document is charged. Without it this test passes with the gate wired to
    refuse anything at all."""
    user, _project, conversation = await _a_conversation(db_session)
    for index in range(2):
        await _upload(client, user, f"hist_{index}", "application/pdf", pdf_with_pages(2))
    first = await _send_with(
        client, user, conversation.id, ["hist_0", "hist_1"], text="read these"
    )
    assert first.status_code == 202, first.text
    await _settle(_fresh_engine, conversation.id)
    # A real build conversation on top of them — well inside the limit on its own.
    await _stuff_the_conversation(db_session, user, conversation, tokens=60_000)

    refused = await _send(client, user, conversation.id)

    assert refused.status_code == 413, refused.text
    assert refused.json()["error"]["code"] == CHAT_TOO_LONG_CODE
    assert refused.json()["error"]["message"] == CHAT_TOO_LONG_TEXT

    # CONTROL: the identical conversation with images instead of documents still sends.
    other, _p2, other_conv = await _a_conversation(db_session)
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
    for index in range(2):
        await _upload(client, other, f"ctrl_{index}", "image/png", png)
    control_first = await _send_with(
        client, other, other_conv.id, ["ctrl_0", "ctrl_1"], text="read these"
    )
    assert control_first.status_code == 202, control_first.text
    await _settle(_fresh_engine, other_conv.id)
    await _stuff_the_conversation(db_session, other, other_conv, tokens=60_000)

    assert (await _send(client, other, other_conv.id)).status_code == 202
    await _settle(_fresh_engine, other_conv.id)
