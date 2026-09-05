"""The Plan → Build handoff: pressing Build it creates a NEW Build chat whose first visible
message is the plan, verbatim. A chat's kind is fixed at creation, so this route creates rather
than flips, and the planning conversation is left exactly as it was.

NO LINKAGE IS STORED, IN EITHER DIRECTION — no column, no marker, no back-reference. What makes
a double press safe instead is the client-minted conversation id colliding with itself
(`BuildHandoffBody`), and what makes "pressing the same offer again a week later builds again"
true is that nothing remembers the first press.

THE ORDER IS THE UNIT: every refusal first, then the flushed Build chat, then the turn starter
whose first durable write commits both, and only then the answer in the Plan chat. Moving any of
those is how an empty Build chat gets stranded; each step below says what its position buys."""

from __future__ import annotations

import uuid
from typing import Literal

import structlog
from fastapi import APIRouter, status
from fastapi.responses import JSONResponse
from pydantic_ai.messages import ToolCallPart
from sqlalchemy.exc import IntegrityError

from src.api.deps import CurrentUser, DbSession
from src.api.deps_csrf import RequireCsrf
from src.api.v1.build_sessions.deps import OptionalSandbox, SessionManagerDep
from src.api.v1.conversations._shared import (
    BUILD_IN_FLIGHT_MSG,
    ModelDep,
    SessionFactoryDep,
    resolve_conversation_or_404,
)
from src.api.v1.conversations.turns import _app_id_for_project, start_conversation_turn
from src.api.v1.live_build import reclaim_blocked_response
from src.core.errors import AppApiError
from src.db.models.conversation import ChatKind, Conversation
from src.db.models.project import Project
from src.schemas import AUTH_401, CamelModel, ErrorEnvelope, error_responses
from src.services.agent.mode_prompts import PromptContext
from src.services.build_sessions import SandboxReclaimBlockedError
from src.services.build_sessions.counters import count
from src.services.messages.store import load_rows
from src.services.redis import build_coordination_or_503
from src.services.turns.copy import (
    ALREADY_BUILDING_HERE_CODE,
    CHAT_TOO_LONG_CODE,
    CHAT_TOO_LONG_TEXT,
    WORKSPACE_UNAVAILABLE_CODE,
    WORKSPACE_UNAVAILABLE_TEXT,
)
from src.services.turns.engine import get_turn_engine, plan_argument_of, plan_from_call
from src.services.turns.plan_options import (
    newest_card,
    pending_card,
    record_build_started,
    resolution_of,
    stored_call,
)
from src.services.usage.context_window import (
    ContextWindowExceededError,
    enforce_context_limit,
)
from src.services.usage.gate import DailyTokenLimitExceededError, enforce_daily_limit

logger = structlog.get_logger()

router = APIRouter(prefix="/conversations", tags=["turns"])

BUILD_HANDOFF_PRESSED = "build_handoff_pressed"
"""The one thing this handoff counts, and it is a bare OCCURRENCE.

No conversation id, no plan reference, no id of the chat it created — recording any of those
would be exactly the linkage this route exists not to store. The counter's name, its storage
and its reading belong to the measurement work; this is only the emit point."""

NO_PLAN_CODE = "offer_has_no_plan"
"""The stored offer carries no plan argument the platform can use.

EVERY CARD PRESENTED BEFORE THE PLAN BECAME THE TOOL'S ARGUMENT LOOKS LIKE THIS, and refusing
by name is the point. The previous implementation fell back to a stand-in — "Build what the
user planned in this conversation" — so a build could start from a sentence nobody wrote,
against a plan nobody could point to. A named refusal is a worse experience and a better
outcome: the citizen asks for the plan again and gets one that can actually be built."""

PLAN_TOO_LONG_CODE = "plan_too_long"
"""The stored plan is past what a message can hold. REFUSED, never truncated — a plan cut
mid-sentence is one the citizen agreed to and the build would never see the end of."""

_NO_PLAN_MESSAGE = (
    "This plan can't be built from — ask for the plan again and the button will work."
)
_PLAN_TOO_LONG_MESSAGE = (
    "This plan is too long to build from in one go. Ask for a shorter version of it."
)


class BuildHandoffBody(CamelModel):
    """The press names the chat it is about to create.

    A CLIENT-MINTED ID IS THE WHOLE IDEMPOTENCY MECHANISM, which is why it is required rather
    than convenient. The browser holds one id per press, so a double press, a retry or a reload
    carries the same id and collides on the primary key. Nothing is recorded against the plan to
    make that work, and nothing has to be cleaned up when the press never happens."""

    chat_id: uuid.UUID


class BuildHandoffResponse(CamelModel):
    """IDS ONLY, and that is deliberate rather than minimal.

    The new conversation row is flushed and not committed when this is built, so projecting a
    header off it would touch server-defaulted attributes on an un-refreshed row and raise
    `MissingGreenlet`. If it ever grows a header, it refreshes first.

    `already_started` is the collision arm: the same press arriving twice, carrying whatever turn
    is live on the chat that already exists so a second tab attaches to that run."""

    outcome: Literal["started", "already_started"]
    chat_id: str
    turn_id: str | None = None


@router.post(
    "/{conversation_id}/plan-options/{tool_call_id}/build",
    response_model=BuildHandoffResponse,
    dependencies=[RequireCsrf],
    responses=error_responses(
        (400, ErrorEnvelope, "Unknown card, or an offer with no usable plan"),
        AUTH_401,
        (403, ErrorEnvelope, "CSRF check failed"),
        (404, ErrorEnvelope, "Conversation not found"),
        (409, ErrorEnvelope, "The card is superseded, the id is taken, or a workspace is busy"),
        (413, ErrorEnvelope, "The plan is past the per-conversation limit"),
        (429, ErrorEnvelope, "Daily token limit reached"),
        (503, ErrorEnvelope, "Build engine or workspace unavailable"),
    ),
)
async def build_it(
    conversation_id: uuid.UUID,
    tool_call_id: str,
    body: BuildHandoffBody,
    user: CurrentUser,
    db: DbSession,
    sandbox: OptionalSandbox,
    manager: SessionManagerDep,
    model: ModelDep,
    factory: SessionFactoryDep,
) -> BuildHandoffResponse | JSONResponse:
    plan_chat = await resolve_conversation_or_404(db, user.id, conversation_id)
    rows = list(
        await load_rows(db, user_id=user.id, conversation_id=plan_chat.id, include_hidden=True)
    )

    # --- every refusal first, and every one of them side-effect free ------------------------
    #
    # Nothing below writes, claims or creates until the last of these has passed, so a refusal
    # can never leave a half-started build to compensate for.
    card = pending_card(rows, tool_call_id)
    if card is None:
        raise AppApiError(400, "No such plan options card.")
    newest = newest_card(rows)
    if newest is None or newest.tool_call_id != tool_call_id:
        raise AppApiError(409, "A newer plan supersedes these options.")

    # THE PLAN COMES FROM THE OFFER'S OWN STORED CALL, never from the request body. That is what
    # R44 asks for, and it is also what stops a stale second tab writing stale requirements into
    # a permanent first message: the browser cannot post a plan at all.
    call = stored_call(rows, tool_call_id)
    plan = plan_from_call(call) if call is not None else None
    if plan is None:
        message, code = _refusal_for(call)
        raise AppApiError(400, message, code=code)

    # --- THE IDEMPOTENCY READ, AND IT HAS TO SIT HERE -----------------------------------------
    #
    # A press that already succeeded is answered with ITS OWN ANSWER, before anything asks
    # whether a NEW build could start — because none of those questions apply to it. The three
    # refusals above are about whether this press is meaningful at all (a card, the newest card,
    # a plan in it) and a retry has to pass them too. Everything below is about capacity: the
    # daily ceiling, a configured model and sandbox, and the one-workspace-per-user rules. A
    # retry that reaches those gets told it cannot start the build it has ALREADY started.
    #
    # THE BUSY CHECK IN PARTICULAR IS UNANSWERABLE FROM DOWN THERE. It compares the user's live
    # session against `plan_chat.id`, and a handoff's session belongs to the BUILD chat, which
    # is a different conversation by construction — so once the first press has attached its
    # sandbox, that comparison is true for every retry, forever, and a reload or a resend after
    # a dropped response was answered `409 already_building_here` instead of `already_started`.
    # The browser caches the minted id per card precisely so a retry is recognisable; this is
    # where it gets recognised.
    #
    # STILL SIDE-EFFECT FREE, so it does not disturb the "nothing is written until every refusal
    # has passed" property the block above rests on: `_already_started` is two SELECTs.
    if await db.get(Conversation, body.chat_id) is not None:
        return await _already_started(db, user.id, body.chat_id, plan_chat.project_id)

    # 429 with its byte-stable body, and the card STAYS PRESSABLE — nothing has been written, so
    # there is no half-started build and the citizen can simply press again tomorrow.
    try:
        await enforce_daily_limit(db, user.id)
    except DailyTokenLimitExceededError as exc:
        return exc.as_response()

    # THE SAME PER-CONVERSATION GUARDRAIL THE SEND ROUTE ENFORCES, on the second door into a
    # conversation turn. A build chat starts EMPTY and its whole prompt is the plan, so in
    # practice it passes — the plan is length-capped well below the window. It is here anyway,
    # and through the one shared preflight rather than a second copy, because leaving the check
    # on the send route alone would make "Build this plan" a way around the administrator's
    # number rather than a route that happens to fit under it. If the plan cap ever moves, this
    # is already correct.
    try:
        await enforce_context_limit(db, user.id, history=[], prompt=plan)
    except ContextWindowExceededError as exc:
        # Same shape as the send route's refusal — one boundary, one body.
        raise AppApiError(
            status.HTTP_413_CONTENT_TOO_LARGE,
            CHAT_TOO_LONG_TEXT,
            code=CHAT_TOO_LONG_CODE,
            detail={"occupied": exc.occupied, "hardLimit": exc.hard_limit},
        ) from None

    if model is None:
        raise AppApiError(status.HTTP_503_SERVICE_UNAVAILABLE, "Claude client not configured.")
    # R98, identically to the send route: no workspace service means nothing for the build to
    # read or write, said before anything is created rather than inside the detached turn.
    if sandbox is None:
        raise AppApiError(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            WORKSPACE_UNAVAILABLE_TEXT,
            code=WORKSPACE_UNAVAILABLE_CODE,
        )

    # R19's two refusals, in the same order and carrying the same codes the send route uses:
    # one workspace per user, and it is not this press's to take if another of the user's own
    # chats holds it — or if unsaved work in a different project is in the way.
    active = manager.active_session_for(user.id)
    if active is not None and active.conversation_id != plan_chat.id:
        raise AppApiError(409, BUILD_IN_FLIGHT_MSG, code=ALREADY_BUILDING_HERE_CODE)
    with build_coordination_or_503():
        try:
            await manager.reclaim_preflight(db, user, plan_chat.project_id, sandbox_client=sandbox)
        except SandboxReclaimBlockedError as exc:
            return reclaim_blocked_response(exc)

    project = await db.get(Project, plan_chat.project_id)
    if project is None:  # the FK guarantees this; fail loudly if it ever breaks
        raise AppApiError(404, "Conversation not found.")
    app_id = await _app_id_for_project(db, user.id, plan_chat.project_id)

    # --- the new chat: FLUSHED, deliberately not committed ----------------------------------
    #
    # THE ORDINARY DOUBLE PRESS NEVER REACHES HERE — it was answered by the idempotency read
    # above, which is one SELECT rather than a failed INSERT. THE CATCH BELOW IS THE RACE
    # BACKSTOP, not the mechanism: two presses genuinely in flight at once both find nothing up
    # there and one of them loses this insert. It is the same answer either way, which is what
    # makes the fast path safe to take.
    build_chat = Conversation(
        id=body.chat_id,
        user_id=user.id,
        project_id=plan_chat.project_id,
        kind=ChatKind.BUILD,
    )
    db.add(build_chat)
    try:
        await db.flush()
    except IntegrityError:
        # The genuine race. `rollback` rather than a savepoint because this is the one path
        # where the session is holding an object the database refused: it has to go, and nothing
        # this request has done so far is a write, so there is nothing else to lose.
        await db.rollback()
        return await _already_started(db, user.id, body.chat_id, plan_chat.project_id)

    # --- the turn: its first durable write is what commits the conversation row -------------
    turn_id = await start_conversation_turn(
        db=db,
        user=user,
        conversation=build_chat,
        # THE PLAN, VERBATIM, AS AN ORDINARY VISIBLE USER MESSAGE. No prefix, no wrapper, no
        # planning history — byte-identical to the citizen having pasted it themselves, which
        # is what makes a handoff-built chat indistinguishable in storage from a typed one.
        #
        # The instruction the retired prefix carried — follow the code's reality where it
        # differs from what the plan assumed, and say what changed — moved into the Build
        # chat's own prompt segment, where it applies to a plan built weeks later as well as to
        # one built a minute after it was written.
        prompt=plan,
        history=[],
        prompt_context=PromptContext(
            user_name=user.display_name or user.email,
            project_name=project.name,
            project_description=project.description or None,
        ),
        app_id=app_id,
        model=model,
        factory=factory,
        manager=manager,
        sandbox=sandbox,
        # AND IT OWES A FILE CHANGE. This is the one entry point where "the model touched
        # nothing" is not a legitimate outcome: the citizen pressed Build on a plan, so a run
        # that writes nothing is a failed build and must be reported as one.
        expects_mutation=True,
    )

    # --- ONLY NOW: the one write in the Plan chat -------------------------------------------
    #
    # ANYONE MOVING THIS WRITE, OR ADDING A COMMIT BETWEEN THE FLUSH ABOVE AND THE TURN
    # STARTER, STRANDS AN EMPTY BUILD CHAT. `append_batch` owns its commit and both
    # conversations share one session, so a write here before the turn started would make the
    # flushed Build chat durable, and a later failure would strand it empty.
    #
    # ITS CONTENT IS THE CHOICE AND NOTHING ELSE — never the new chat's id, never its url,
    # never a count. That is what makes "no stored field references both conversations" a fact
    # about the row rather than an aspiration.
    #
    # AND IT IS DECIDED ON A FRESH READ, NOT ON `rows`. `rows` is the snapshot this request
    # opened with, and everything between there and here takes real time: the daily-limit read,
    # the reclaim preflight, the insert, and a turn start that does not return until a sandbox
    # is attached. A free-text send in the Plan chat from a second tab resolves this same card
    # as `refine` inside that window — and answering off the stale snapshot would put a SECOND
    # real `ToolReturnPart` on one call id, which is the hazard the comment below names.
    #
    # THREE ANSWERS, ONE READ:
    #   nothing stored  → write the real `ToolReturnPart`; this is the ordinary press.
    #   `build` stored  → write nothing. The week-later press: the offer stays pressable after a
    #                     build (nothing archives it) and the card already reads what happened.
    #   anything else   → the raced `refine`, or a `build_failed:` string left by the retired
    #                     recorder. The build DID start, so it is recorded as a hidden overlay
    #                     instead: the projection reads `build` as the newest resolution and the
    #                     wire still carries exactly one return for the call id.
    fresh = list(
        await load_rows(db, user_id=user.id, conversation_id=plan_chat.id, include_hidden=True)
    )
    prior = resolution_of(fresh, tool_call_id)
    if prior != "build":
        await record_build_started(
            db,
            user_id=user.id,
            conversation_id=plan_chat.id,
            pending=card,
            answered_already=prior is not None,
        )
    await count(BUILD_HANDOFF_PRESSED)
    return BuildHandoffResponse(
        outcome="started", chat_id=str(build_chat.id), turn_id=str(turn_id)
    )


def _refusal_for(call: ToolCallPart | None) -> tuple[str, str]:
    """(message, code) for an offer that cannot be built from.

    TWO CODES, because the two causes have different remedies: an offer with no plan is fixed by
    asking for the plan again, an over-long one by asking for a shorter one.

    ASKS THE SAME QUESTION `plan_from_call` ASKS rather than re-deriving it. The ceiling is the
    only thing separating the two refusals, so "the call carries a plan argument at all" IS
    "the plan is too long" — and it stays true if a third rejection is ever added there."""
    if call is not None and plan_argument_of(call) is not None:
        return _PLAN_TOO_LONG_MESSAGE, PLAN_TOO_LONG_CODE
    return _NO_PLAN_MESSAGE, NO_PLAN_CODE


async def _already_started(
    db: DbSession, user_id: uuid.UUID, chat_id: uuid.UUID, project_id: uuid.UUID
) -> BuildHandoffResponse:
    """The collision arm, GUARDED BY OWNERSHIP AND PARENTAGE rather than by existence alone.

    The conversation id is client-minted, so an unguarded arm would hand any caller who guesses
    a colliding id the existence of — and a live turn id for — somebody else's conversation. The
    predicate is the create route's: same owner, same project, same kind, else one flat 409.

    It starts NOTHING. The chat that already exists has whatever turn is already live on it, and
    that is what a second tab should attach to."""
    existing = await db.get(Conversation, chat_id)
    if (
        existing is None
        or existing.user_id != user_id
        or existing.project_id != project_id
        or existing.kind is not ChatKind.BUILD
    ):
        raise AppApiError(409, "This conversation id is already in use.")
    live = get_turn_engine().peek(existing.id)
    return BuildHandoffResponse(
        outcome="already_started",
        chat_id=str(existing.id),
        turn_id=str(live.turn_id) if live is not None else None,
    )
