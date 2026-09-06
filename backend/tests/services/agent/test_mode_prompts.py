"""The chat-kind prompt system: BASE + exactly one positive segment per run.

The property under test: a kind's composed prompt describes what that kind IS and DOES with
the tools it HAS — never prohibitions against tools the registry already makes uncallable
(`test_toolsets.py` proves the structural half; this file proves the prose half). Plus the
delivery property: composed instructions ride `@agent.instructions` per run and never reach a
persisted row (`test_store_roundtrip.py` pins the store seam).

There are two segments, Plan and Build. This file owns the properties that must hold whatever
their wording becomes.
"""

from __future__ import annotations

import asyncio
import inspect
import uuid

import pytest
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    UserPromptPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.tools import ToolDefinition

from src.core.prompt_blocks import (
    BUILD_THIS_PLAN_LABEL,
    DATA_INTEGRITY_RULES_WITHOUT_THE_WRITE_MACHINERY,
    KEEP_PLANNING_LABEL,
    NARRATION_VOICE,
    PORTAL_SURFACES,
    WRITE_IDENTITY,
)
from src.db.models.conversation import ChatKind
from src.services.agent.agent import ChatDeps, chat_agent
from src.services.agent.mode_prompts import (
    _PLAN_SEGMENT,
    PromptContext,
    compose_kind_prompt,
    workspace_note,
)
from src.services.agent.toolsets import registered_tool_definitions
from src.services.orchestrator.prompt import (
    BUILD_SYSTEM_PROMPT,
    BUILD_WORKING_RULES_HEAD,
    BUILD_WORKING_RULES_TAIL,
    DATA_INTEGRITY_RULES,
)

_CONTEXT = PromptContext(
    user_name="Asha",
    project_name="Visitor Log",
    project_description="Tracks visitors at the airport office.",
)

# The segment header each kind's composition must carry, and only its own — what matters here
# is that the two compositions are distinct and that neither leaks the other's segment.
_SEGMENT_HEADERS = {
    ChatKind.PLAN: "PLAN MODE",
    ChatKind.BUILD: "WRITE MODE",
}


@pytest.mark.parametrize("kind", list(ChatKind))
def test_composition_is_base_plus_exactly_its_own_segment(kind: ChatKind) -> None:
    composed = compose_kind_prompt(kind, _CONTEXT)
    # BASE: identity + project grounding + the single-sourced data-safety block.
    assert "Citizen Developer assistant for BIAL" in composed
    assert "Asha" in composed and "Visitor Log" in composed
    assert "Tracks visitors at the airport office." in composed
    # The data-safety block, verbatim, in the ONE form this kind is supposed to get. Build takes
    # the whole constant; Plan takes the same string minus the two Build-machinery clauses, which
    # is why this is a per-kind lookup and not a shared substring — the dropped sentinel clause
    # sits mid-sentence, so neither form contains the other. WHY the two differ, and that the
    # rules themselves are identical, is
    # `test_the_sql_sentinel_and_the_migration_channel_are_named_to_build_alone` below.
    expected_integrity = {
        ChatKind.PLAN: DATA_INTEGRITY_RULES_WITHOUT_THE_WRITE_MACHINERY,
        ChatKind.BUILD: DATA_INTEGRITY_RULES,
    }[kind]
    assert expected_integrity in composed
    # Exactly this kind's segment, not the other's (mutation-checked: swapping a segment in
    # `compose_kind_prompt` turns this red). Parametrized over the WHOLE enum rather than a
    # hand-kept list, so a third kind added without a segment fails here.
    assert _SEGMENT_HEADERS[kind] in composed
    for other, header in _SEGMENT_HEADERS.items():
        if other is not kind:
            assert header not in composed


@pytest.mark.parametrize("kind", list(ChatKind))
def test_every_kind_carries_the_truthful_portal_self_description(
    kind: ChatKind,
) -> None:
    """It lives in BASE, so neither kind can be missing it."""
    composed = compose_kind_prompt(kind, _CONTEXT)
    assert PORTAL_SURFACES in composed
    # The two clauses that do the actual work: the closed world, and honesty over invention.
    assert "There are no other tabs" in composed
    assert "say so plainly" in composed
    # Named surfaces exist as routes in `portal/src/App.jsx` — extend clause and list together.
    for real_surface in (
        "Dashboard",
        "Projects list",
        "Help page",
        "Marketplace",
        "Admin review area",
    ):
        assert real_surface in composed
    # The unified chat's right pane is the APP. The relay's retiring wording said the
    # builder view was "a chat beside a live preview"; this layout must not be re-described.
    assert "the right pane shows the app itself" in composed


def test_base_survives_an_undescribed_project() -> None:
    bare = PromptContext(user_name="Asha", project_name="Visitor Log")
    composed = compose_kind_prompt(ChatKind.PLAN, bare)
    assert 'on "Visitor Log".' in composed  # no dangling " — None"
    assert "None" not in composed.split("DATA INTEGRITY")[0]


def test_build_composes_like_the_other_kind() -> None:
    """A Build chat has a segment like any other."""
    composed = compose_kind_prompt(ChatKind.BUILD, _CONTEXT)
    assert "WRITE MODE" in composed
    assert 'on "Visitor Log"' in composed  # the same BASE both kinds carry


def test_the_write_segment_and_the_build_prompt_come_from_one_source() -> None:
    """Assert they genuinely share the blocks, so a future edit to either cannot silently fork
    the two Write prompts."""
    composed = compose_kind_prompt(ChatKind.BUILD, _CONTEXT)
    assert BUILD_WORKING_RULES_HEAD in composed
    assert BUILD_WORKING_RULES_TAIL in composed
    assert WRITE_IDENTITY in composed
    assert WRITE_IDENTITY in BUILD_SYSTEM_PROMPT
    assert BUILD_WORKING_RULES_HEAD in BUILD_SYSTEM_PROMPT
    # The audience block is shared the same way — one constant, reached by both Write prompts
    # through the TAIL they already share, so neither can grow a voice the other does not have.
    assert NARRATION_VOICE in composed
    assert NARRATION_VOICE in BUILD_SYSTEM_PROMPT


def test_write_states_the_data_integrity_rules_exactly_once() -> None:
    """The trap in composing Write from the shared blocks: `_base()` already appends
    DATA_INTEGRITY_RULES for EVERY mode, so listing it among the segment's blocks too would emit
    the whole block twice in every Write prompt — burning context and reading as a stutter."""
    composed = compose_kind_prompt(ChatKind.BUILD, _CONTEXT)
    assert composed.count(DATA_INTEGRITY_RULES) == 1


_SQL_SENTINEL_SENTENCE = "a destructive-SQL sentinel enforces this on `run_command`"
_MIGRATION_CHANNEL_SENTENCE = "Schema changes go through generated migrations (see DATABASE)"


def test_the_sql_sentinel_and_the_migration_channel_are_named_to_build_alone() -> None:
    """The two DATA INTEGRITY clauses that were FALSE in a Plan prompt, and only there.

    Both name machinery the registry does not hand a Plan run: the SQL sentinel is wired into
    BUILD's `run_command` (`orchestrator/tools.py`), and "(see DATABASE)" points at a section of
    `BUILD_WORKING_RULES_HEAD` that a Plan prompt does not carry. The rules THEMSELVES are
    asserted present in both. Mutation check: make `_base` ignore its `kind` and Plan goes red.
    """
    # Mutation check: make `_base` ignore its `kind` and this goes red on the Plan arm.
    plan = compose_kind_prompt(ChatKind.PLAN, _CONTEXT)
    build = compose_kind_prompt(ChatKind.BUILD, _CONTEXT)

    assert _SQL_SENTINEL_SENTENCE in build
    assert _SQL_SENTINEL_SENTENCE not in plan
    assert _MIGRATION_CHANNEL_SENTENCE in build
    assert _MIGRATION_CHANNEL_SENTENCE not in plan

    # …because the tools it describes are Build's. Read off the registry, so a Plan run that
    # ever gains a write or schema tool fails HERE rather than shipping a prompt that lies the
    # other way round.
    plan_tools = asyncio.run(registered_tool_definitions(ChatKind.PLAN))
    build_tools = asyncio.run(registered_tool_definitions(ChatKind.BUILD))
    assert "apply_schema_change" in build_tools
    assert "apply_schema_change" not in plan_tools
    assert "declare_done" in build_tools
    assert "declare_done" not in plan_tools

    # The rules survive intact in both — this is a removal of two claims, not of a safety rule.
    for composed in (plan, build):
        assert "Never INSERT, UPDATE, DELETE, or TRUNCATE data" in composed
        assert "Never hardcode, seed, or generate dummy" in composed


def test_write_speaks_to_the_person_who_asked_for_the_app() -> None:
    """The composed Write prompt carries the audience block, and the assertions pin it
    CONCRETELY — the plain register, what stays behind the scenes, and the failure turns —
    rather than just proving some voice text exists.

    No length bar is asserted, because there is no longer one to assert. WHO is being written
    for is what this test holds."""
    composed = compose_kind_prompt(ChatKind.BUILD, _CONTEXT)
    assert NARRATION_VOICE in composed
    lowered = composed.lower()
    assert "talking to the user" in lowered
    assert "plain, everyday words" in lowered
    assert "keep the how-it's-built details behind the scenes" in lowered
    assert "the file and folder names, the commands you run" in lowered
    # The hard turns are covered as well: a failure and its recovery stay in product language.
    assert "when something goes wrong" in lowered
    # The technical record is untouched, which is what lets the narration be short.
    assert "recorded step by step" in lowered


def test_the_audience_block_is_emitted_exactly_once() -> None:
    """The DATA_INTEGRITY_RULES trap, one block over, and now at three sites instead of one.

    The contract is named by `_base()` (both kinds) and separately by `BUILD_SYSTEM_PROMPT`,
    which cannot call `_base` — each is a place a second copy could appear.

    `== 1` rather than `<= 1` is the point of the counting: the failure it catches is the block
    being lifted out of the TAIL and never named at the standalone build prompt, a count of ZERO
    that every `<=` and every `in` formulation passes. It also guards against deletion."""
    for kind in ChatKind:
        composed = compose_kind_prompt(kind, _CONTEXT)
        assert composed.count(NARRATION_VOICE) == 1
        assert composed.count("TALKING TO THE USER") == 1
        # AND NO LENGTH BAR BESIDE IT, in either kind. The per-kind "HOW LONG —" sentences went
        # with the rest of the caps; asserting their absence here is what stops one drifting
        # back in beside the contract it used to ride with.
        assert "HOW LONG —" not in composed
    assert BUILD_SYSTEM_PROMPT.count(NARRATION_VOICE) == 1
    assert "HOW LONG —" not in BUILD_SYSTEM_PROMPT


def test_the_name_the_files_instruction_went_with_the_segment_that_carried_it() -> None:
    """A REAL LOSS, recorded rather than quietly dropped.

    The retired Ask segment told the model to "name the actual files and quote the actual code".
    A citizen who asks what their app does lands in a Plan chat instead, whose segment says the
    opposite deliberately: keep file and folder names behind the scenes.

    The guard is inertness only — the instruction is gone from every composition and stays gone,
    and nothing here may paper over that by inventing prompt copy."""
    for kind in ChatKind:
        assert "name the actual files and quote the actual code" not in compose_kind_prompt(
            kind, _CONTEXT
        )


def test_both_kinds_inherit_the_one_audience_contract() -> None:
    """The two kinds are told the same thing about their reader.

    ONE CONTRACT, WITH NO PER-KIND HALF AT ALL: the audience block lives in BASE, neither kind
    carries a plain-language paragraph of its own beside it, and neither carries a length clause.
    A per-kind half drifting back in alone is the failure this catches."""
    plan = compose_kind_prompt(ChatKind.PLAN, _CONTEXT)
    build = compose_kind_prompt(ChatKind.BUILD, _CONTEXT)
    assert NARRATION_VOICE in plan
    assert NARRATION_VOICE in build

    # The register survives the move — asserted on the COMPOSED prompt, because the wording no
    # longer lives in the Plan segment; deleting the duplicate is the point of the unit.
    lowered = plan.lower()
    assert "plain, everyday words" in lowered
    assert "keep the how-it's-built details behind the scenes" in lowered
    assert "present_plan_options" in plan

    # NO PER-KIND LENGTH CLAUSE IS LEFT, in either direction. Both halves are asserted because
    # the failure this catches is one of them drifting back in alone, which would restore the
    # split without restoring the thing the split was for.
    assert "a plan is as long as it needs to be" not in lowered
    assert "a couple of lines at each milestone" not in lowered
    assert "a plan is as long as it needs to be" not in build.lower()
    assert "a couple of lines at each milestone" not in build.lower()

    # The two prompts say the same thing about voice, with nothing left that
    # differs. Nothing in the shared block is reachable from only one kind.
    assert plan.count(NARRATION_VOICE) == build.count(NARRATION_VOICE) == 1


# --- the version control the agent no longer does ---------------------------------
#
# The commit the platform takes instead is `build_sessions/snapshot._COMMIT_SCRIPT`.
#
# TWO INERTNESS GUARDS AND ONE LIVENESS GUARD, and the third is not decoration: an inertness pair
# on its own is greenest against a Write prompt somebody deleted outright, so one rule that must
# SURVIVE every trim is asserted next to them.

_RETIRED_GIT_INSTRUCTIONS = (
    # The commit discipline itself.
    "git add",
    "git commit",
    # THE UNDO HALF, and the reason this is a set rather than one assertion. The deleted block
    # taught `git checkout` and `git revert` for backing out a bad edit; both — and `git reset`,
    # and `git stash` — leave a HEAD that is NOT a descendant of the copy on record, over a
    # perfectly good tree. That is precisely the input the workspace-integrity verdict has to
    # reason about before it may call a workspace REVERTED. The verdict closes the hazard on its
    # own (it requires the CONTENT to disagree as well as the lineage); this stops a future
    # prompt edit from feeding it self-inflicted non-descendant HEADs, and reintroducing ANY ONE
    # of the five turns it red.
    "git checkout",
    "git revert",
    "git reset",
    "git stash",
)


@pytest.mark.parametrize(
    "prompt_name", ["write_mode_segment", "build_system_prompt"], ids=["write_mode", "build"]
)
def test_neither_write_prompt_instructs_the_agent_in_git(prompt_name: str) -> None:
    """★ THE INERTNESS GUARD. Asserted as a SET so the
    failure names every instruction that crept back, and asserted on BOTH Write prompts because
    they compose from shared blocks and either composition site could grow one.

    Mutation check: put any of the six back into `BUILD_WORKING_RULES_HEAD` and this goes red."""
    prompt = (
        compose_kind_prompt(ChatKind.BUILD, _CONTEXT)
        if prompt_name == "write_mode_segment"
        else BUILD_SYSTEM_PROMPT
    )
    lowered = prompt.lower()
    found = {phrase for phrase in _RETIRED_GIT_INSTRUCTIONS if phrase in lowered}
    assert found == set(), f"{prompt_name} instructs the agent in git again: {sorted(found)}"
    # The header of the deleted block, named separately so a reworded revival still trips.
    assert "commit as you work" not in lowered


def test_the_write_prompt_still_says_not_to_restart_the_dev_server() -> None:
    """★ THE LIVENESS GUARD, and the one rule a prompt trim must not take with it.

    The agent can start a dev server of its own through `run_command` — the supervisor's child
    env carries no marker that would tell the harness's flag apart from the real one — so this
    sentence is the whole of what stops a second `next dev` racing the one the harness reads to
    verify the build."""
    composed = compose_kind_prompt(ChatKind.BUILD, _CONTEXT)
    lowered = composed.lower()
    assert "the dev server (`next dev`) is already running" in lowered
    assert "do not start, restart, or kill it" in lowered


def test_the_composer_takes_no_approved_plan_at_all() -> None:
    """The parameter is GONE rather than rejected, which is the stronger guarantee.

    A plan reaches a Build chat as its first user MESSAGE, never spliced into the system prompt,
    so there is no caller left to mis-wire. The guard is on the SIGNATURE rather than on a
    raise: asserting a `TypeError` from a literal call would only prove that Python rejects
    unknown keywords, and would need a suppression on every type checker to compile at all."""
    assert "approved_plan" not in inspect.signature(compose_kind_prompt).parameters


def test_a_plan_chat_stays_lean() -> None:
    # Template facts / working rules are the BUILD prompt's business: a Plan chat never carries
    # the build environment blocks.
    composed = compose_kind_prompt(ChatKind.PLAN, _CONTEXT)
    assert BUILD_WORKING_RULES_HEAD not in composed
    assert "declare_done" not in composed


_FORBIDDEN_FRUIT = (
    # Prohibition prose aimed at tools the mode doesn't have. The registry already
    # removed them — ban text would teach the model to reason about absent capabilities
    # (the research doc's anti-pattern 1/2).
    "do not",
    "don't",
    "never",
    "cannot",
    "can't",
    "forbidden",
    "not allowed",
    "no access",
    "unable to",
    "must not",
)


def test_the_plan_segment_never_speaks_of_forbidden_fruit() -> None:
    lowered = _PLAN_SEGMENT.lower()
    for phrase in _FORBIDDEN_FRUIT:
        assert phrase not in lowered, f"prohibition prose {phrase!r} crept into a segment"


def test_the_plan_still_says_nothing_technical_even_with_its_shape_freed() -> None:
    """A plan is read by someone who asked for an app, and naming the file it lives in tells them
    nothing they can act on. Asserted per category rather than in general: a sentence that
    dropped "a command" while keeping the other four would still read as a no-jargon rule.

    Mutation check: delete any one of the five nouns from `_PLAN_SEGMENT` and this names it."""
    lowered = _PLAN_SEGMENT.lower()
    for banned in ("a file", "a folder", "a framework", "a library", "a command"):
        assert banned in lowered, f"the no-jargon sentence stopped naming {banned!r}"


def test_plan_segment_is_citizen_facing_not_a_developer_spec() -> None:
    # The plan streams as ordinary assistant TEXT, so its register is dictated entirely by
    # _PLAN_SEGMENT. The developer skeleton ("the files you would touch", "the trade-offs the
    # user should weigh") is retired; the segment now steers an outcome-first, plain-language plan,
    # while KEEPING the read-first grounding. This asserts the PROMPT's shape — the ground-truth
    # check is an eyeballed rendered Plan turn against PLAN-FORMAT-RESEARCH.md's AFTER, since a
    # prompt string cannot prove the model's OUTPUT stays jargon-free.
    lowered = _PLAN_SEGMENT.lower()
    # the retired developer-register source phrases are gone (assert the REAL phrases, not the
    # model-output headings from the research BEFORE example)
    assert "the files you would touch" not in lowered
    assert "trade-offs the user should weigh" not in lowered
    assert "trade-offs" not in lowered
    # citizen framing is present: outcome-first + see/do + the options contract. "Plain,
    # everyday words" is NO LONGER asserted here on purpose — it moved to the shared audience
    # block, and a Plan chat inherits it through `_base` rather than restating it. Asserting it
    # against the segment again would recreate a second copy of the same text;
    # `test_both_kinds_inherit_the_one_audience_contract` holds that ground on
    # the composed prompt, where the model actually reads it.
    assert "plain, everyday words" in compose_kind_prompt(ChatKind.PLAN, _CONTEXT).lower()
    # THE MANDATED SHAPE IS GONE, and its absence is asserted rather than merely unmentioned.
    # The segment used to dictate five headed sections in a fixed order, which made every plan
    # read the same whatever was being planned. What a plan is FOR and who reads it survives;
    # how it is arranged is the agent's, in front of the person who asked.
    assert "five parts" not in lowered
    assert "what this gives you" not in lowered
    assert "present_plan_options" in _PLAN_SEGMENT
    # the read-first grounding instruction stays — only the OUTPUT register changed
    assert "read the relevant files first" in lowered


def test_the_plan_segment_says_the_plan_travels_in_the_offer_argument() -> None:
    """THE SENTENCE THAT KEEPS A BUTTON ATTACHED TO SOMETHING.

    The buttons are attached to the `plan` argument, so a plan announced beside the call leaves
    the person reading it with nothing to press. The segment must still say where the plan goes,
    and must no longer say that everything else the agent writes is discarded.

    Mutation check: revert that paragraph to "write the plan, then call the tool" and no other
    test in the repo goes red."""
    # Mutation check: revert this paragraph to "write the plan, then call the tool" and no other
    # test in the repo goes red — the failure is a citizen reading a plan with no button.
    lowered = _PLAN_SEGMENT.lower()
    assert "as the `plan` argument of" in lowered
    assert "not as a message beside the call" in lowered
    # AND IT NO LONGER LIES TO THE MODEL. The segment used to say anything written in the same
    # breath as a tool call "does not reach the user", which stopped being true the moment the
    # hold was deleted — the point is that nothing tells the model something about this
    # system that is no longer so.
    assert "does not reach the user" not in lowered
    assert "everything else you write does reach them" in lowered


# THE PLAN REMINDERS' OWN CHECK USED TO SIT HERE, and it is not orphaned: the reminders it
# guarded no longer exist (`tests/services/turns/test_reminders.py` is their inertness guard),
# and every property it asserted — citizen-plain wording, prohibition-free, the
# `present_plan_options` contract — is asserted directly against `_PLAN_SEGMENT` above, which is
# now the only place that framing is stated. One source, one check.


def _capturing_model(captured: dict[str, str]) -> FunctionModel:
    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        captured["instructions"] = info.instructions or ""
        return ModelResponse(parts=[TextPart(content="ok")])

    return FunctionModel(respond)


async def test_relay_path_stays_verbatim_deps_system(db_session) -> None:
    captured: dict[str, str] = {}
    deps = ChatDeps(db=db_session, user_id=uuid.uuid4(), system="RELAY-PROMPT")
    result = await chat_agent.run("hi", deps=deps, model=_capturing_model(captured))
    assert captured["instructions"] == "RELAY-PROMPT"  # mode=None → byte-identical path
    assert result.output == "ok"


async def test_mode_run_composes_and_never_persists_instructions(db_session) -> None:
    """Delivery: the model RECEIVES the composition; the store's dump seam keeps it out
    of any persisted payload (the JSONB half is pinned in test_store_roundtrip)."""
    captured: dict[str, str] = {}
    deps = ChatDeps(
        db=db_session,
        user_id=uuid.uuid4(),
        kind=ChatKind.PLAN,
        prompt_context=_CONTEXT,
    )
    result = await chat_agent.run(
        "what does my app do?", deps=deps, model=_capturing_model(captured)
    )
    assert captured["instructions"] == compose_kind_prompt(ChatKind.PLAN, _CONTEXT)

    from src.services.messages.store import dump_for_row

    dumped = dump_for_row(result.new_messages())
    for message in dumped:
        assert message.get("instructions") is None  # the composed prompt never lands in a row


async def test_a_kind_without_context_fails_first(db_session) -> None:
    deps = ChatDeps(db=db_session, user_id=uuid.uuid4(), kind=ChatKind.PLAN)
    with pytest.raises(ValueError, match="composed without a PromptContext"):
        await chat_agent.run("hi", deps=deps, model=_capturing_model({}))


@pytest.mark.parametrize("kind", list(ChatKind))
def test_no_segment_promises_an_emptiness_signal_that_never_arrives(kind: ChatKind) -> None:
    """THE PROMISE IS GONE BECAUSE THE SIGNAL NEVER ARRIVES.

    The retired Ask segment told the model "If there is no app yet, your tools will tell you
    truthfully." A brand-new project gets the live container like every other project and the
    container holds the golden template, so the reads come back FULL and a model waiting for an
    emptiness signal spends round-trips looking for one that is not coming. Widened to both
    surviving segments: the promise was wrong about the platform, not about Ask. `_PLAN_SEGMENT`
    carries the ACTION half the retired sentence taught, and only Plan's segment does."""
    lowered = compose_kind_prompt(kind, _CONTEXT).lower()
    assert "your tools will tell you truthfully" not in lowered
    assert "if there is no app yet" not in lowered
    # THE ASSERTION THAT WAS WITHHELD: Plan's composition now carries the instruction the
    # retired sentence's ACTION half taught, and Build's — which shares the workspace note's
    # FACT but not the segment — does not. Parametrized over the whole enum like the rest of
    # this test, so a third kind added without a decision here fails loudly instead of silently.
    if kind is ChatKind.PLAN:
        assert "talk about what could be built for them" in lowered
    else:
        assert "talk about what could be built for them" not in lowered


async def test_a_plan_turn_carries_the_notes_fact_and_the_segments_instruction_together(
    db_session,
) -> None:
    """The integration half: the workspace note's FACT and the Plan segment's ACTION on one turn.

    Each is unit-tested alone (`test_reminders.py` and the test above), and neither catches one
    regressing while the other stays green. This assembles a Plan turn the way `turns/engine.py`
    actually does — the note appended to `message_history` as a `UserPromptPart`, the segment
    delivered through `@agent.instructions` — and proves both reach the one model call.
    """
    captured_instructions = ""
    captured_messages: list[ModelMessage] = []

    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        nonlocal captured_instructions, captured_messages
        captured_instructions = info.instructions or ""
        captured_messages = list(messages)
        return ModelResponse(parts=[TextPart(content="ok")])

    note = workspace_note(serving=True, still_the_template=True)
    history: list[ModelMessage] = [ModelRequest(parts=[UserPromptPart(content=note)])]
    deps = ChatDeps(
        db=db_session,
        user_id=uuid.uuid4(),
        kind=ChatKind.PLAN,
        prompt_context=_CONTEXT,
    )

    await chat_agent.run(
        "what should we build?",
        deps=deps,
        model=FunctionModel(respond),
        message_history=history,
    )

    # The segment's INSTRUCTION, on the instructions channel.
    assert "talk about what could be built for them" in captured_instructions
    # The note's FACT, on the message-history channel — the same wording `_WORKSPACE_STILL_
    # TEMPLATE` composes, checked as literal text rather than the private constant so this
    # test fails the way a reviewer reading the model's actual request would notice it.
    sent_notes = [
        part.content
        for message in captured_messages
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, UserPromptPart)
    ]
    assert any("still byte-for-byte the starter template" in str(text) for text in sent_notes)


def test_no_prompt_surface_names_a_button_the_interface_does_not_draw() -> None:
    """A prompt naming a button the interface does not draw fails nothing: the prompt composes,
    the tool registers, the turn runs, and only the person reading it is stuck.

    THE TOOL DESCRIPTIONS ARE CHECKED TOO. `present_plan_options`' docstring is prompt copy —
    pydantic-ai sends it on the tool schema of every request — but it never appears in any
    composed prompt string, so a guard over prompts alone reads clean while the model is being
    told the old labels."""
    retired = ("Keep refining", "keep refining", "Build it")
    surfaces: dict[str, str] = {
        f"composed {kind.value} prompt": compose_kind_prompt(kind, _CONTEXT) for kind in ChatKind
    }
    surfaces["BUILD_SYSTEM_PROMPT"] = BUILD_SYSTEM_PROMPT
    for kind in ChatKind:
        for name, definition in (await_definitions(kind)).items():
            surfaces[f"{kind.value} tool `{name}`"] = definition.description or ""

    for where, text in surfaces.items():
        for label in retired:
            assert label not in text, f"{where} still names the retired button {label!r}"

    offer = (await_definitions(ChatKind.PLAN))["present_plan_options"].description or ""
    assert BUILD_THIS_PLAN_LABEL in offer
    assert KEEP_PLANNING_LABEL in offer
    plan_prompt = compose_kind_prompt(ChatKind.PLAN, _CONTEXT)
    assert BUILD_THIS_PLAN_LABEL in plan_prompt
    assert KEEP_PLANNING_LABEL in plan_prompt


def await_definitions(kind: ChatKind) -> dict[str, ToolDefinition]:
    """`registered_tool_definitions` without the await, for a sync test.

    The registry's renderer is async only because pydantic-ai's `get_tools` is; it performs no
    I/O and calls no model (its accessors raise if anything tries). Running it on its own loop
    here keeps the guard above a plain sync test beside the other prompt-copy guards, which is
    where a reader looks for it."""
    return asyncio.run(registered_tool_definitions(kind))
