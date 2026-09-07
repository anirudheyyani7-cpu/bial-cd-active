"""present_plan_options mechanics: the call DEFERS (the click is the result), the plan RIDES
the argument (no other copy of it exists), and resolutions are idempotent, newest-only, and
derived identically by the projection. There is no `build_failed` resolution value.

Also covered: inertness guards for the retired prose heuristic (list-item counting, trailing
`?` scan) and the forced retry/fabricated card it drove — all deleted — and the platform's own
voice on this path: a wordless turn stays wordless, and the one line the platform still speaks
(a refused offer) rides its own system row, never a `ModelResponse` in the model's name."""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import json
from typing import get_args

import pytest
from pydantic import SecretStr
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models.function import (
    AgentInfo,
    DeltaToolCall,
    DeltaToolCalls,
    FunctionModel,
)

from src.api.v1.conversations._shared import MAX_MESSAGE_TEXT_CHARS
from src.api.v1.conversations.turns import ResolvePlanOptionsResponse
from src.config import settings
from src.db.models.conversation import ChatKind
from src.db.models.message import MessageEntryKind
from src.services.agent import toolsets as toolsets_module
from src.services.agent.mode_prompts import PromptContext
from src.services.build_sessions.manager import SessionManager
from src.services.messages.projection import (
    PLATFORM_TEXT_KIND,
    AssistantTextItem,
    PlanOptionsItem,
    StepItem,
    project_rows,
)
from src.services.messages.store import load_history, load_rows
from src.services.sandbox.config import SandboxConfig
from src.services.turns import engine as engine_module
from src.services.turns import plan_options as plan_options_module
from src.services.turns.copy import PLAN_NOT_KEPT_TEXT
from src.services.turns.engine import TurnEngine, plan_from_call, set_turn_engine_for_tests
from src.services.turns.guard import _mid_reply
from src.services.turns.plan_options import (
    NoPendingOptionsError,
    PendingPlanOptions,
    PlanChoice,
    PlanOptionsExpiredError,
    find_pending,
    newest_card,
    record_build_started,
    resolve,
    resolve_pending_as_refine,
    stored_call,
)
from tests.factories import ConversationFactory, UserFactory
from tests.fakes import FakeSandboxClient
from tests.transcript import live_shape, reload_shape, rendered_text

_CTX = PromptContext(user_name="Ada", project_name="Visitors", project_description=None)

_PLAN_TEXT = "Here is the plan:\n1. Add a table\n2. Wire the form\n3. Ship it"

# --- the exact shapes that used to fire the retired prose heuristic ----------------------
#
# `_looks_plan_shaped` counted list items and scanned the reply's tail for a trailing `?`;
# two-or-more items with no trailing `?` forced a retry, and a no-call retry got a card
# FABRICATED underneath it. These texts are kept verbatim from the shapes that tripped it,
# so the tests below regress against the actual defect, not a generic "text alone proves
# nothing".

_LIST_SHAPED_NO_CALL_TEXT = (
    "Here is how I'd tackle it:\n1. Add a visitors table.\n2. Wire the intake form.\n3. Ship it.\n"
)

_CLARIFYING_QUESTION_TEXT = (
    "A couple of options exist.\nWhich fields should the visitors table hold?"
)

# The turn-019fc05f regression shape: A/B/C options with an explicit refusal to finalize.
_CHOICE_QUESTION_TEXT = (
    "We keep circling the same three fields, so let me ask it straight — which of these "
    "do you want me to take as settled?\n"
    "\n"
    "- **A.** Name, badge number and visit purpose, and nothing else.\n"
    "- **B.** Everything on the paper form, including the host's signature line.\n"
    "- **C.** Start from A and add fields once the front desk has used it for a week.\n"
    "\n"
    "Any of those is workable. But I'm not going to start writing code until one of us "
    "has moved."
)


@pytest.fixture(autouse=True)
def _sandbox_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    # Plan chats now pin a live container exactly like Build does; without this every turn
    # dies at the workspace pin before the model ever runs.
    monkeypatch.setattr(
        settings,
        "sandbox",
        SandboxConfig(
            subscription_id="s",
            resource_group="r",
            region="westeurope",
            managed_environment_name="aca-env",
            acr_server="acr.azurecr.io",
            acr_username="acr-user",
            acr_password=SecretStr("acr-pass"),
            image_ref="acr/img:latest",
        ),
    )


@pytest.fixture(autouse=True)
async def _sandbox_dependencies(fake_redis, fake_storage) -> None:
    """Redis (liveness lease) and storage (sandbox attach reads) both need a backing fake now
    that a Plan turn also attaches a live container — autouse so it doesn't have to be added
    to every test signature."""
    return None


@pytest.fixture(autouse=True)
def _fresh_engine():
    _mid_reply.clear()
    engine = TurnEngine()
    set_turn_engine_for_tests(engine)
    yield engine
    set_turn_engine_for_tests(None)
    _mid_reply.clear()


@pytest.fixture
def session_factory(db_session):
    @contextlib.asynccontextmanager
    async def _session():
        yield db_session

    return lambda: _session()


async def _plan_conversation(db_session):
    user = await UserFactory.create(db_session)
    conv = await ConversationFactory.create(db_session, user.id, kind=ChatKind.PLAN)
    return user, conv


async def _noop_persist() -> None:
    return None


async def _run_turn(engine, db_session, session_factory, model, user, conv):
    await engine.start_turn(
        conversation=conv,
        user_id=user.id,
        prompt="plan the visitors app",
        history=[],
        prompt_context=_CTX,
        app_id=None,
        project_id=conv.project_id,
        model=model,
        session_factory=session_factory,
        persist_user_turn=_noop_persist,
        manager=SessionManager(),
        sandbox_client=FakeSandboxClient(),
    )
    state = engine.peek(conv.id)
    assert state is not None and state.task is not None
    with contextlib.suppress(asyncio.CancelledError):
        await asyncio.wait_for(state.task, timeout=10)
    return state


def _call_options(plan: str = _PLAN_TEXT, call_id: str = "opt-1") -> DeltaToolCalls:
    """A complete offer call, the plan riding the argument the way the real tool requires —
    every fixture in this file that means to make a HONOURABLE offer uses this, never
    the empty `json_args="{}"` the tool used to take."""
    return DeltaToolCalls(
        {
            0: DeltaToolCall(
                name="present_plan_options",
                json_args=json.dumps({"plan": plan}),
                tool_call_id=call_id,
            )
        }
    )


# --- the plan rides the argument, and it is the only copy of it --------------------------


async def test_the_plan_argument_is_the_happy_path_live_and_on_reload(
    _fresh_engine, db_session, session_factory
) -> None:
    """The live stream and the reload projection derive the SAME text from the SAME stored
    call, so they can never drift apart."""
    calls = {"count": 0}

    async def _stream(messages, info: AgentInfo):
        calls["count"] += 1
        yield _call_options()

    user, conv = await _plan_conversation(db_session)
    state = await _run_turn(
        _fresh_engine,
        db_session,
        session_factory,
        FunctionModel(stream_function=_stream),
        user,
        conv,
    )
    assert state.status == "completed"
    assert calls["count"] == 1  # nothing anywhere re-issues this run

    text_frames = [f for f in state.ring if f.type == "text_delta"]
    assert "".join(f.text for f in text_frames) == _PLAN_TEXT
    cards = [f for f in state.ring if f.type == "plan_options"]
    assert len(cards) == 1 and cards[0].item.state == "pending"
    assert cards[0].item.tool_call_id == "opt-1"
    assert state.ring.index(cards[0]) > state.ring.index(text_frames[-1])

    pending = await find_pending(db_session, user_id=user.id, conversation_id=conv.id)
    assert pending is not None and pending.tool_call_id == "opt-1"
    assert pending.synthesized is False

    # The pending row carries the call's id and nothing else: no snapshot pin rides
    # along with it any more.
    #
    # ADDRESSED BY META KIND, NOT BY POSITION. `rows[-1]` used to be the turn's row; a
    # durable terminal row is now appended after it, so an index here would now be reading the
    # wrong row — and would keep silently reading the wrong row as later units add lifecycle
    # records.
    rows = await load_rows(
        db_session, user_id=user.id, conversation_id=conv.id, include_hidden=True
    )
    pending_rows = [
        row
        for row in rows
        if isinstance(row.meta, dict) and row.meta.get("kind") == engine_module.PENDING_META_KIND
    ]
    assert len(pending_rows) == 1
    assert pending_rows[0].meta == {
        "kind": engine_module.PENDING_META_KIND,
        "toolCallId": "opt-1",
    }

    items = project_rows(list(rows))
    text_items = [i for i in items if isinstance(i, AssistantTextItem)]
    options = [i for i in items if isinstance(i, PlanOptionsItem)]
    assert [t.text for t in text_items] == [_PLAN_TEXT]
    assert len(options) == 1 and options[0].state == "pending"


async def test_the_writing_up_status_leaves_the_screen_when_the_plan_arrives(
    _fresh_engine, db_session, session_factory
) -> None:
    """A WATCHING TAB AND A RELOADED ONE READ THE SAME THING, on a turn with a status line to
    withdraw. "Writing up the plan…" opens the moment the tool call opens and has no durable
    counterpart, so it must be explicitly retracted on the wire — a tab already connected got
    the started frame, and only the retraction (not a reload) clears it for that tab.

    Mutation check: put `state.drop_step(...)` back in place of `_retract_step(...)` in the
    engine's offer arm and the live shape grows a `step:present_plan_options` the reloaded one
    does not have."""

    async def _stream(messages, info: AgentInfo):
        # The provider's own two-part shape: the tool NAME with an empty argument first, which
        # is what opens the status, then the plan.
        yield DeltaToolCalls(
            {0: DeltaToolCall(name="present_plan_options", json_args="", tool_call_id="opt-1")}
        )
        yield DeltaToolCalls(
            {0: DeltaToolCall(json_args=json.dumps({"plan": _PLAN_TEXT}), tool_call_id="opt-1")}
        )

    user, conv = await _plan_conversation(db_session)
    state = await _run_turn(
        _fresh_engine,
        db_session,
        session_factory,
        FunctionModel(stream_function=_stream),
        user,
        conv,
    )
    assert state.status == "completed"

    rows = await load_rows(
        db_session, user_id=user.id, conversation_id=conv.id, include_hidden=True
    )
    assert live_shape(state) == [f"text:{_PLAN_TEXT}"] == reload_shape(project_rows(list(rows)))

    # The withdrawal is a FRAME, not just an absence from the snapshot: the connected tab is
    # told, on the same call id, and the item it is told with is hidden.
    withdrawals = [
        f
        for f in state.ring
        if f.type == "step" and f.tool_call_id == "opt-1" and f.phase == "finished"
    ]
    assert len(withdrawals) == 1 and withdrawals[0].item.hidden is True

    assert [f.item.tool_call_id for f in state.ring if f.type == "plan_options"] == ["opt-1"]


async def test_an_offer_survives_unrelated_turns_and_still_names_its_own_plan(
    _fresh_engine, db_session, session_factory
) -> None:
    """An offer made on turn three must still name turn three's plan after two
    more exchanges that have nothing to do with it — the stored call is the one and only
    copy, so nothing later in the conversation can dilute or relabel it."""
    engine = _fresh_engine
    user, conv = await _plan_conversation(db_session)

    def _plain(text: str) -> FunctionModel:
        async def _stream(messages, info: AgentInfo):
            yield text

        return FunctionModel(stream_function=_stream)

    async def _offer(messages, info: AgentInfo):
        yield _call_options(plan=_PLAN_TEXT, call_id="opt-turn-3")

    await _run_turn(
        engine, db_session, session_factory, _plain("Tell me about your visitors."), user, conv
    )
    await _run_turn(
        engine, db_session, session_factory, _plain("A few more questions first."), user, conv
    )
    await _run_turn(
        engine, db_session, session_factory, FunctionModel(stream_function=_offer), user, conv
    )
    await _run_turn(
        engine, db_session, session_factory, _plain("One more unrelated aside."), user, conv
    )
    await _run_turn(engine, db_session, session_factory, _plain("And another."), user, conv)

    pending = await find_pending(db_session, user_id=user.id, conversation_id=conv.id)
    assert pending is not None and pending.tool_call_id == "opt-turn-3"
    rows = await load_rows(
        db_session, user_id=user.id, conversation_id=conv.id, include_hidden=True
    )
    call = stored_call(list(rows), "opt-turn-3")
    assert call is not None and plan_from_call(call) == _PLAN_TEXT


async def test_a_revised_plan_leaves_exactly_one_live_offer_naming_the_newer_plan(
    _fresh_engine, db_session, session_factory
) -> None:
    """The agent revises and calls again: exactly one offer is live and it names
    the newer plan. The older one reads as spent — a newer presentation supersedes it by
    construction, whether or not anyone ever clicked it — and its OWN plan is untouched:
    superseded, not overwritten."""
    engine = _fresh_engine
    user, conv = await _plan_conversation(db_session)
    plan_v1 = _PLAN_TEXT
    plan_v2 = _PLAN_TEXT + "\n4. Add a CSV export."

    async def _offer_v1(messages, info: AgentInfo):
        yield _call_options(plan=plan_v1, call_id="opt-v1")

    async def _offer_v2(messages, info: AgentInfo):
        yield _call_options(plan=plan_v2, call_id="opt-v2")

    await _run_turn(
        engine, db_session, session_factory, FunctionModel(stream_function=_offer_v1), user, conv
    )
    await _run_turn(
        engine, db_session, session_factory, FunctionModel(stream_function=_offer_v2), user, conv
    )

    pending = await find_pending(db_session, user_id=user.id, conversation_id=conv.id)
    assert pending is not None and pending.tool_call_id == "opt-v2"
    rows = await load_rows(
        db_session, user_id=user.id, conversation_id=conv.id, include_hidden=True
    )
    newer = stored_call(list(rows), "opt-v2")
    assert newer is not None and plan_from_call(newer) == plan_v2

    # The older offer cannot be acted on any more, even though nothing ever resolved it.
    with pytest.raises(PlanOptionsExpiredError):
        await resolve(
            db_session,
            user_id=user.id,
            conversation_id=conv.id,
            tool_call_id="opt-v1",
            choice="refine",
        )
    older = stored_call(list(rows), "opt-v1")
    assert older is not None and plan_from_call(older) == plan_v1


async def test_a_run_cut_off_mid_argument_records_no_offer_and_no_partial_plan(
    _fresh_engine, db_session, session_factory
) -> None:
    """A run stopped after the tool's NAME lands on the wire but before the argument
    completes must leave no half-written plan, live or durable — and the status itself
    cannot outlive the turn: it has no durable counterpart, so a tab already connected keeps
    a spinning row forever unless the terminal explicitly withdraws it (a reload alone would
    clear it, but this pins the live case too).

    Mutation check: drop the `plan_status_tool_call_id` retraction from `_finish` and the live
    shape grows a `step:present_plan_options` the reloaded transcript does not have."""
    engine = _fresh_engine
    gate = asyncio.Event()

    async def _stream(messages, info: AgentInfo):
        # The block opens (the name is on the wire) but the argument never finishes.
        yield DeltaToolCalls(
            {0: DeltaToolCall(name="present_plan_options", json_args="", tool_call_id="opt-cut")}
        )
        await gate.wait()
        yield DeltaToolCalls(  # pragma: no cover - never reached; the turn is stopped first
            {0: DeltaToolCall(json_args=json.dumps({"plan": _PLAN_TEXT}), tool_call_id="opt-cut")}
        )

    user, conv = await _plan_conversation(db_session)
    turn_id = await engine.start_turn(
        conversation=conv,
        user_id=user.id,
        prompt="plan the visitors app",
        history=[],
        prompt_context=_CTX,
        app_id=None,
        project_id=conv.project_id,
        model=FunctionModel(stream_function=_stream),
        session_factory=session_factory,
        persist_user_turn=_noop_persist,
        manager=SessionManager(),
        sandbox_client=FakeSandboxClient(),
    )
    state = engine.peek(conv.id)
    assert state is not None
    while not state.steps:  # the started status has landed; the argument is still open
        await asyncio.sleep(0.01)

    assert await engine.stop_turn(conv.id, turn_id) is True
    with contextlib.suppress(asyncio.CancelledError):
        await asyncio.wait_for(state.task, timeout=10)

    assert state.status == "stopped"
    assert state.text_blocks() == []  # no plan, partial or otherwise, reached the live feed
    assert not [f for f in state.ring if f.type == "plan_options"]

    # WRITE-BEFORE-DONE: no TURN row persists for a run that never completed — but a hidden,
    # payload-less durable terminal row for the STOP itself still lands, so a reload can tell
    # this turn ended rather than treating a cut-off run as still in flight forever.
    assert await find_pending(db_session, user_id=user.id, conversation_id=conv.id) is None
    rows = await load_rows(
        db_session, user_id=user.id, conversation_id=conv.id, include_hidden=True
    )
    assert [row.entry_kind for row in rows] == [MessageEntryKind.SYSTEM_EVENT]
    assert rows[0].payload == []
    assert rows[0].meta is not None and rows[0].meta["status"] == "stopped"

    # AND THE WATCHING TAB IS TOLD — the checks above read the snapshot and durable rows only,
    # and the started frame went out on the wire before either existed.
    assert live_shape(state) == [] == reload_shape(project_rows(list(rows)))

    # The withdrawal is a FRAME on the status's own call id, hidden — the only way an already
    # connected tab learns the status is over. Exactly one: the terminal must not double up.
    withdrawals = [
        f
        for f in state.ring
        if f.type == "step" and f.tool_call_id == "opt-cut" and f.phase == "finished"
    ]
    assert len(withdrawals) == 1 and withdrawals[0].item.hidden is True


async def test_an_empty_plan_argument_records_no_offer_and_says_so_once(
    _fresh_engine, db_session, session_factory
) -> None:
    """Error path. A whitespace-only argument is nothing to build from — the exact defect the
    retired heuristic used to manufacture, a Build-it button under a plan nobody wrote.

    THE LINE IS THE PLATFORM'S NOW, NOT THE MODEL'S: it reaches the citizen exactly as before,
    but the record attributes it to a system row of the platform's own, not a response written
    in the model's name."""

    async def _stream(messages, info: AgentInfo):
        yield _call_options(plan="   ")

    user, conv = await _plan_conversation(db_session)
    state = await _run_turn(
        _fresh_engine,
        db_session,
        session_factory,
        FunctionModel(stream_function=_stream),
        user,
        conv,
    )

    assert state.status == "completed"
    assert await find_pending(db_session, user_id=user.id, conversation_id=conv.id) is None
    # SAID ONCE, ALONE: compared as the whole block list, not searched for — a substring/`in`
    # check would pass even if the sentence were repeated or buried under other prose.
    assert state.text_blocks() == [PLAN_NOT_KEPT_TEXT]

    rows = await load_rows(
        db_session, user_id=user.id, conversation_id=conv.id, include_hidden=True
    )
    items = project_rows(list(rows))
    assert [i.text for i in items if isinstance(i, AssistantTextItem)] == [PLAN_NOT_KEPT_TEXT]
    assert not [i for i in items if isinstance(i, PlanOptionsItem)]

    # THE PROVENANCE IS THE CHANGE, pinned as hard as the words: this used to ride as a
    # `ModelResponse` (stored and read back as something the model wrote); it now lives on its
    # own hidden SYSTEM_EVENT row, in `meta`, with no payload — what the citizen reads is
    # unchanged, only the attribution moved.
    platform_rows = [
        row
        for row in rows
        if isinstance(row.meta, dict) and row.meta.get("kind") == PLATFORM_TEXT_KIND
    ]
    assert len(platform_rows) == 1
    assert platform_rows[0].entry_kind is MessageEntryKind.SYSTEM_EVENT
    assert platform_rows[0].meta == {
        "kind": PLATFORM_TEXT_KIND,
        "turnId": str(state.turn_id),
        "text": PLAN_NOT_KEPT_TEXT,
    }
    # ★ THE MODEL IS NEVER TOLD IT SAID THIS. `load_history` flattens every row's payload with
    # no filter, so a sentence stored there is one the NEXT turn hands the model as its own
    # words. Asserted DIRECTLY on the payload (not just via the reader): the reader returns
    # nothing for this turn regardless, so an absence there alone would false-green even if the
    # payload still carried the sentence.
    assert platform_rows[0].payload == []
    assert not any(PLAN_NOT_KEPT_TEXT in str(row.payload) for row in rows)

    async def _noop_rehydrate(_attachment_ids):
        raise AssertionError("no attachments in this history")

    history = await load_history(
        db_session, user_id=user.id, conversation_id=conv.id, rehydrate=_noop_rehydrate
    )
    assert not any(PLAN_NOT_KEPT_TEXT in str(message) for message in history)
    for row in rows:
        for message in row.payload:
            assert "present_plan_options" not in str(message.get("parts", []))


async def test_an_over_ceiling_plan_argument_records_no_offer_and_is_not_truncated(
    _fresh_engine, db_session, session_factory
) -> None:
    """Error path. An argument past the stored-message ceiling is REFUSED, never
    trimmed: a plan cut mid-sentence is one the citizen would agree to sight-unseen. The
    refusal is explained by the same platform-authored line, on the same platform-owned row."""
    huge_plan = "x" * (MAX_MESSAGE_TEXT_CHARS + 1)

    async def _stream(messages, info: AgentInfo):
        yield _call_options(plan=huge_plan)

    user, conv = await _plan_conversation(db_session)
    state = await _run_turn(
        _fresh_engine,
        db_session,
        session_factory,
        FunctionModel(stream_function=_stream),
        user,
        conv,
    )

    assert state.status == "completed"
    assert await find_pending(db_session, user_id=user.id, conversation_id=conv.id) is None
    assert state.text_blocks() == [PLAN_NOT_KEPT_TEXT]  # refused outright, not trimmed to fit

    rows = await load_rows(
        db_session, user_id=user.id, conversation_id=conv.id, include_hidden=True
    )
    for row in rows:
        assert huge_plan[:200] not in str(row.payload)  # no fragment of the refused plan survives
    items = project_rows(list(rows))
    assert [i.text for i in items if isinstance(i, AssistantTextItem)] == [PLAN_NOT_KEPT_TEXT]
    # Restated here (not left to the sibling test) so the pair reads deliberately, not as an
    # accident of whichever test was written second.
    assert [
        row.entry_kind
        for row in rows
        if isinstance(row.meta, dict) and row.meta.get("kind") == PLATFORM_TEXT_KIND
    ] == [MessageEntryKind.SYSTEM_EVENT]


# --- the prose heuristic, the forced retry and the fabricated card are all gone ----------


async def test_a_list_shaped_reply_with_no_tool_call_produces_no_offer(
    _fresh_engine, db_session, session_factory
) -> None:
    """Edge case. Two-or-more list items and no trailing `?` is precisely the shape
    `_looks_plan_shaped` used to count as a plan. There is no reader left that counts list
    items, so the model simply not calling the tool ends the turn — no retry, no card."""
    calls = {"count": 0}

    async def _stream(messages, info: AgentInfo):
        calls["count"] += 1
        yield _LIST_SHAPED_NO_CALL_TEXT

    user, conv = await _plan_conversation(db_session)
    state = await _run_turn(
        _fresh_engine,
        db_session,
        session_factory,
        FunctionModel(stream_function=_stream),
        user,
        conv,
    )

    assert state.status == "completed"
    assert calls["count"] == 1  # nothing re-issues this run
    assert await find_pending(db_session, user_id=user.id, conversation_id=conv.id) is None
    assert not [f for f in state.ring if f.type == "plan_options"]


async def test_a_clarifying_question_turn_produces_no_offer(
    _fresh_engine, db_session, session_factory
) -> None:
    """Edge case. A clarifying question is a legitimate planning turn on its own — never
    a trigger for a forced retry, with or without a `?` at the very end."""
    calls = {"count": 0}

    async def _stream(messages, info: AgentInfo):
        calls["count"] += 1
        yield _CLARIFYING_QUESTION_TEXT

    user, conv = await _plan_conversation(db_session)
    state = await _run_turn(
        _fresh_engine,
        db_session,
        session_factory,
        FunctionModel(stream_function=_stream),
        user,
        conv,
    )

    assert state.status == "completed"
    assert calls["count"] == 1
    assert await find_pending(db_session, user_id=user.id, conversation_id=conv.id) is None


async def test_the_turn_019fc05f_regression_shape_still_produces_no_offer(
    _fresh_engine, db_session, session_factory
) -> None:
    """★ THE FABRICATED CARD, for real — turn 019fc05f-d3df-729d-a688-d33a309bddfd. The model
    listed three options A/B/C and explicitly refused to finalize; the retired heuristic read
    that as three plan steps (no trailing `?`), forced the tool, and synthesized a Build-it
    card under a question nobody had answered."""
    calls = {"count": 0}

    async def _stream(messages, info: AgentInfo):
        calls["count"] += 1
        yield _CHOICE_QUESTION_TEXT

    user, conv = await _plan_conversation(db_session)
    state = await _run_turn(
        _fresh_engine,
        db_session,
        session_factory,
        FunctionModel(stream_function=_stream),
        user,
        conv,
    )

    assert state.status == "completed"
    assert calls["count"] == 1  # A/B/C is a question with its answers written out
    assert await find_pending(db_session, user_id=user.id, conversation_id=conv.id) is None
    assert not [f for f in state.ring if f.type == "plan_options"]


def test_the_prose_heuristic_the_forced_retry_and_the_synthesizer_no_longer_exist() -> None:
    """★ INERTNESS GUARD. Named individually rather than as a set: an implementer working
    from a plan SUMMARY rather than the plan itself tends to delete three symbols and leave
    the fourth behind (or vice versa), and a coarser check (e.g. "the module still imports")
    would not catch that partial cleanup.

    Mutation-check: reintroduce any ONE of these names as a no-op stub (e.g. `def
    _looks_plan_shaped(...): return False`) and this goes red on that exact assertion, with
    every other test in this file still green."""
    for name in (
        "_looks_plan_shaped",
        "_list_item_body",
        "_is_labelled_alternative",
        "_CLARIFYING_TAIL_LINES",
        "_FORCE_OPTIONS_NUDGE",
    ):
        assert not hasattr(engine_module, name), f"engine.{name} should have been deleted"
    assert not hasattr(TurnEngine, "_synthesize_options")
    assert not hasattr(toolsets_module, "plan_options_only_toolset")


# --- the stale-plan pin is gone, at both ends of the wire ---------------------------------


def test_no_snapshot_head_rides_on_the_turn_state_or_the_pending_record() -> None:
    """★ INERTNESS GUARD. The pin's only writer sat inside the mode branch that no
    longer exists; this guards that nothing reintroduces the field under any name, on either
    the in-memory turn state or the durable pending record.

    Mutation-check: add `head_sha: str | None = None` back to either dataclass and this goes
    red on that exact field name."""
    state_fields = {f.name for f in dataclasses.fields(engine_module._TurnState)}
    assert "head_sha" not in state_fields
    pending_fields = {f.name for f in dataclasses.fields(PendingPlanOptions)}
    assert "head_sha" not in pending_fields
    assert not hasattr(plan_options_module, "approved_plan_text")


# --- there is no third resolution value anywhere -------------------------------------------


def test_no_resolution_value_exists_that_a_user_cannot_produce() -> None:
    """★ INERTNESS GUARD. `build_failed` had no production caller and no way for a user
    to reach it. This pins every place that value could still hide: the wire type the engine
    writes, the projection the client reads, and the endpoint response the client parses.

    Mutation-check: add "build_failed" back to any ONE of the three `Literal`s (or restore
    `record_build_failure`) and this goes red on that exact assertion."""
    assert get_args(PlanChoice) == ("refine", "build")
    assert get_args(PlanOptionsItem.model_fields["state"].annotation) == (
        "pending",
        "refine",
        "build",
    )
    assert get_args(ResolvePlanOptionsResponse.model_fields["state"].annotation) == (
        "refine",
        "build",
    )
    assert not hasattr(plan_options_module, "record_build_failure")


# --- resolution mechanics, unaffected by the changes above (kept from the prior suite) ----


async def test_refine_resolution_is_idempotent_and_feeds_the_next_run(
    _fresh_engine, db_session, session_factory
) -> None:
    async def _stream(messages, info: AgentInfo):
        yield _call_options()

    user, conv = await _plan_conversation(db_session)
    await _run_turn(
        _fresh_engine,
        db_session,
        session_factory,
        FunctionModel(stream_function=_stream),
        user,
        conv,
    )

    first = await resolve(
        db_session, user_id=user.id, conversation_id=conv.id, tool_call_id="opt-1", choice="refine"
    )
    assert first.already_resolved is False
    second = await resolve(
        db_session, user_id=user.id, conversation_id=conv.id, tool_call_id="opt-1", choice="refine"
    )
    assert second.already_resolved is True and second.choice == "refine"

    # The projection reads the SAME record the model will see.
    rows = await load_rows(db_session, user_id=user.id, conversation_id=conv.id)
    options = [i for i in project_rows(list(rows)) if isinstance(i, PlanOptionsItem)]
    assert options[0].state == "refine"

    async def _noop_rehydrate(_attachment_ids):
        raise AssertionError("no attachments in this history")

    history = await load_history(
        db_session, user_id=user.id, conversation_id=conv.id, rehydrate=_noop_rehydrate
    )
    flat = [
        part
        for message in history
        for part in getattr(message, "parts", [])
        if getattr(part, "part_kind", "") == "tool-return"
    ]
    assert any(p.tool_call_id == "opt-1" and p.content == "refine" for p in flat)


async def test_only_the_newest_pending_is_actionable(
    _fresh_engine, db_session, session_factory
) -> None:
    round_ = {"n": 0}

    async def _stream(messages, info: AgentInfo):
        round_["n"] += 1
        yield _call_options(call_id=f"opt-{round_['n']}")

    user, conv = await _plan_conversation(db_session)
    model = FunctionModel(stream_function=_stream)
    await _run_turn(_fresh_engine, db_session, session_factory, model, user, conv)
    # The user keeps typing → implicit refine resolves card 1; a second plan presents card 2.
    implicit = await resolve_pending_as_refine(
        db_session, user_id=user.id, conversation_id=conv.id
    )
    assert implicit is not None and implicit.choice == "refine"
    engine2 = TurnEngine()
    set_turn_engine_for_tests(engine2)
    await _run_turn(engine2, db_session, session_factory, model, user, conv)

    pending = await find_pending(db_session, user_id=user.id, conversation_id=conv.id)
    assert pending is not None and pending.tool_call_id == "opt-2"
    with pytest.raises(NoPendingOptionsError):
        await resolve(
            db_session,
            user_id=user.id,
            conversation_id=conv.id,
            tool_call_id="opt-missing",
            choice="refine",
        )
    # Resolving the SUPERSEDED card is refused; its stored resolution (refine) answers
    # idempotently instead.
    superseded = await resolve(
        db_session, user_id=user.id, conversation_id=conv.id, tool_call_id="opt-1", choice="refine"
    )
    assert superseded.already_resolved is True


async def test_build_started_after_a_raced_refine_writes_no_second_wire_return(
    _fresh_engine, db_session, session_factory
) -> None:
    # The Build-it vs turn-start race: a concurrent turn-start resolves the card as
    # "refine" (a real ToolReturnPart) while the build is starting. record_build_started must
    # then record the build as a system overlay — NOT a second ToolReturnPart — so the loaded
    # history carries exactly one return for the card and the conversation never wedges.
    async def _stream(messages, info: AgentInfo):
        yield _call_options()

    user, conv = await _plan_conversation(db_session)
    await _run_turn(
        _fresh_engine,
        db_session,
        session_factory,
        FunctionModel(stream_function=_stream),
        user,
        conv,
    )
    await resolve(
        db_session, user_id=user.id, conversation_id=conv.id, tool_call_id="opt-1", choice="refine"
    )
    rows = await load_rows(
        db_session, user_id=user.id, conversation_id=conv.id, include_hidden=True
    )
    card = newest_card(list(rows))
    assert card is not None
    # Build-it re-checks and finds the card already answered → overlay, not a 2nd return.
    await record_build_started(
        db_session,
        user_id=user.id,
        conversation_id=conv.id,
        pending=card,
        answered_already=True,
    )

    async def _noop_rehydrate(_attachment_ids):
        raise AssertionError("no attachments in this history")

    history = await load_history(
        db_session, user_id=user.id, conversation_id=conv.id, rehydrate=_noop_rehydrate
    )
    returns = [
        part
        for message in history
        for part in getattr(message, "parts", [])
        if getattr(part, "part_kind", "") == "tool-return" and part.tool_call_id == "opt-1"
    ]
    assert len(returns) == 1  # exactly one wire return — no duplicate tool_result to reject
    # NEWEST WINS BY ROW SEQ. The build overlay was recorded AFTER the raced refine return, so
    # the card projects "build" — which is the truth the user can see (a build is running).
    fresh_rows = await load_rows(
        db_session, user_id=user.id, conversation_id=conv.id, include_hidden=True
    )
    projected = [i for i in project_rows(list(fresh_rows)) if isinstance(i, PlanOptionsItem)]
    assert projected[0].state == "build"


# --- nothing is written in the model's name -------------------------------------------------
#
# The prose-drop that used to strip words beside a tool call, and the platform sentence that
# existed to paper over the resulting silence, are both gone: a wordless turn now means the
# agent chose not to speak. The one platform sentence still reachable on this path is the
# refused-offer line, pinned above on its own SYSTEM_EVENT row.


async def test_a_turn_that_only_used_a_tool_leaves_no_words_behind(
    _fresh_engine, db_session, session_factory
) -> None:
    """★ The turn that reads a file and then has nothing to say now says nothing — narrower
    than "every response called a tool," since the loop can't end on a response with no
    usable output at all. Asserted LIVE AND ON RELOAD, read step included on both sides: an
    absence check on a turn that rendered nothing whatsoever would prove the opposite of what
    it claims.

    Mutation check: restore the arm that pushed a platform-authored sentence whenever a turn
    produced no prose, and this goes red twice over — on the live blocks and on the projected
    items — while every other test in this file stays green."""
    engine, (user, conv) = _fresh_engine, await _plan_conversation(db_session)

    requests = 0

    async def _reads_then_says_nothing(messages: list[ModelMessage], info: AgentInfo):
        nonlocal requests
        requests += 1
        if requests == 1:
            yield {
                0: DeltaToolCall(
                    name="read_file", json_args='{"path": "app/page.tsx"}', tool_call_id="r1"
                )
            }
            return
        yield "   "

    state = await _run_turn(
        engine,
        db_session,
        session_factory,
        FunctionModel(stream_function=_reads_then_says_nothing),
        user,
        conv,
    )

    assert state.status == "completed"
    # NOT ONE READABLE WORD: the whitespace closing response survives live as an empty block
    # and is dropped outright on reload — either way, nothing reaches the citizen.
    assert rendered_text(state).strip() == ""

    rows = await load_rows(
        db_session, user_id=user.id, conversation_id=conv.id, include_hidden=True
    )
    assert not [
        row
        for row in rows
        if isinstance(row.meta, dict) and row.meta.get("kind") == PLATFORM_TEXT_KIND
    ]
    items = project_rows(list(rows))
    assert not [i for i in items if isinstance(i, AssistantTextItem)]
    # LIVENESS, on both paths. The turn is not empty — it did the work and shows the work — so
    # the two absences above are about what was said, not about a transcript that never rendered.
    assert [i.tool for i in items if isinstance(i, StepItem)] == ["read_file"]
    assert "r1" in state.steps


async def test_a_plain_answer_turn_shows_the_answer_and_no_activity_at_all(
    _fresh_engine, db_session, session_factory
) -> None:
    """The other half: an ordinary turn stays quiet. A response that calls no tool IS the
    answer — nothing is appended underneath it (the noise this unit removes), and nothing is
    manufactured beside it either, so `steps` stays empty."""
    engine, (user, conv) = _fresh_engine, await _plan_conversation(db_session)

    async def _just_answers(messages: list[ModelMessage], info: AgentInfo):
        yield "Your visitor list already records arrival times."

    state = await _run_turn(
        engine,
        db_session,
        session_factory,
        FunctionModel(stream_function=_just_answers),
        user,
        conv,
    )

    assert state.text_blocks() == ["Your visitor list already records arrival times."]
    assert state.steps == {}


async def test_the_words_spoken_mid_work_are_the_whole_of_what_the_turn_says(
    _fresh_engine, db_session, session_factory
) -> None:
    """★ The turn that spoke through the voice channel and then closed on nothing. The citizen
    already has something to read, so the platform must not follow it with a second sentence —
    least of all one saying there was nothing to show.

    FILTERED ON `strip()` because the closing response is whitespace: an empty block live,
    dropped entirely on reload. What's pinned is that no READABLE block joins the spoken one —
    the claim that breaks if the platform starts writing again."""
    engine, (user, conv) = _fresh_engine, await _plan_conversation(db_session)
    spoken = "Looking at how your visitor list works today."

    requests = 0

    async def _speaks_then_says_nothing(messages: list[ModelMessage], info: AgentInfo):
        nonlocal requests
        requests += 1
        if requests == 1:
            yield {
                0: DeltaToolCall(
                    name="tell_the_user",
                    json_args=json.dumps({"update": spoken}),
                    tool_call_id="s1",
                )
            }
            return
        yield "   "

    state = await _run_turn(
        engine,
        db_session,
        session_factory,
        FunctionModel(stream_function=_speaks_then_says_nothing),
        user,
        conv,
    )

    assert [block for block in state.text_blocks() if block.strip()] == [spoken]


async def test_prose_written_after_a_tool_call_is_the_whole_of_the_answer(
    _fresh_engine, db_session, session_factory
) -> None:
    """★ The turn the drop used to break: the agent reads a file, then answers, and that prose
    is no longer withheld — and it's the WHOLE of what the turn says, no second closing block
    from the platform.

    Mutation check: append any platform-authored sentence at the end of a chat run and this goes
    red on the block list, where a substring check would still find the answer inside it."""
    engine, (user, conv) = _fresh_engine, await _plan_conversation(db_session)

    async def _reads_then_answers(messages: list[ModelMessage], info: AgentInfo):
        if len(messages) == 1:
            yield {
                0: DeltaToolCall(
                    name="read_file", json_args='{"path": "app/page.tsx"}', tool_call_id="r1"
                )
            }
            return
        yield "Your visitor list shows who arrived and when."

    state = await _run_turn(
        engine,
        db_session,
        session_factory,
        FunctionModel(stream_function=_reads_then_answers),
        user,
        conv,
    )

    assert state.text_blocks() == ["Your visitor list shows who arrived and when."]
    assert "r1" in state.steps  # liveness: the read happened, and the answer came after it
