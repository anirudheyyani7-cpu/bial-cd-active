"""How full a conversation is, read off the stored rows (`projection.measured_context_tokens`).

★ WHY THIS FILE EXISTS AT ALL. The number the browser's meter shows and the number the server
refuses on have to be one number. The server's lives in `usage/context_window.py` and reads a
validated `list[ModelMessage]`; this one reads the RAW JSONB, because that is all the projection
is allowed to touch. Two readers of one rule is exactly the shape that drifts, so the last test
here runs both over the same persisted conversation and demands the same answer.

★ AND WHY THE CACHE TEST IS NOT OPTIONAL. Under pydantic-ai `input_tokens` is ALREADY INCLUSIVE
of both cache classes — it is the provider's raw prompt count, which is the occupancy wanted —
while `weighted_spend` next door is a COST figure that discounts a cache read to a tenth. This
codebase has shipped the opposite belief three times, twice past review
(`docs/solutions/integration-issues/run-token-ceiling-billed-cache-reads-at-face-value-2026-09-01.md`).
Real conversations here run 97-99% cache-read, so a spend-shaped meter reads a full chat as a
tenth-full one and warns nobody.

Every row below is written through the REAL store, so the measurement has to survive the JSONB
round trip to be found — a history assembled by hand would prove the rule and not the wiring.
"""

from __future__ import annotations

from pydantic_ai.messages import (
    ModelRequest,
    ModelResponse,
    TextPart,
    UserPromptPart,
)
from pydantic_ai.usage import RequestUsage

from src.db.models.message import MessageEntryKind, MessageVisibility
from src.services.messages.projection import (
    TURN_TERMINAL_KIND,
    measured_context_tokens,
)
from src.services.messages.store import append_batch, load_history, load_rows
from src.services.usage.gate import weighted_spend
from tests.factories import ConversationFactory, ProjectFactory, UserFactory


async def _no_refs(attachment_ids) -> dict[str, tuple[str, str]]:
    """No conversation here carries an attachment, so a rehydration request means the fixture has
    drifted rather than that the reader needs bytes. Fail loudly, never a quiet empty map."""
    raise AssertionError(f"unexpected rehydration of {list(attachment_ids)!r}")


async def _thread(db_session):
    user = await UserFactory.create(db_session)
    project = await ProjectFactory.create(db_session, user.id)
    conversation = await ConversationFactory.create(db_session, user.id, project_id=project.id)
    return user, conversation


async def _rows(db_session, user, conversation):
    return await load_rows(
        db_session, user_id=user.id, conversation_id=conversation.id, include_hidden=True
    )


async def _served_turn(
    db_session, user, conversation, *, input_tokens: int, cache_read_tokens: int = 0
) -> None:
    """One turn the provider actually served, carrying the count it reported for that prompt."""
    await append_batch(
        db_session,
        user_id=user.id,
        conversation_id=conversation.id,
        messages=[
            ModelRequest(parts=[UserPromptPart(content="carry on")]),
            ModelResponse(
                parts=[TextPart(content="here you go")],
                usage=RequestUsage(input_tokens=input_tokens, cache_read_tokens=cache_read_tokens),
            ),
        ],
        entry_kind=MessageEntryKind.TURN,
        kind=conversation.kind,
    )


async def _platform_said(db_session, user, conversation, text: str) -> None:
    """A sentence the PLATFORM wrote — a handoff note, a build's opening message. A real
    `ModelResponse` in the transcript, carrying a real `RequestUsage` whose every field is zero
    because no provider ever saw it."""
    await append_batch(
        db_session,
        user_id=user.id,
        conversation_id=conversation.id,
        messages=[ModelResponse(parts=[TextPart(content=text)])],
        entry_kind=MessageEntryKind.TURN,
        kind=conversation.kind,
    )


async def _turn_terminal(db_session, user, conversation) -> None:
    """The hidden per-turn terminal row, in the shape `TurnEngine._write_turn_terminal` writes:
    payload-less, hidden, the whole fact in `meta`."""
    await append_batch(
        db_session,
        user_id=user.id,
        conversation_id=conversation.id,
        messages=[],
        entry_kind=MessageEntryKind.SYSTEM_EVENT,
        kind=conversation.kind,
        visibility=MessageVisibility.HIDDEN,
        meta={
            "kind": TURN_TERMINAL_KIND,
            "turnId": "01a05879-5345-73b6-b795-47767884ea4c",
            "status": "completed",
            "reason": None,
        },
    )


# --- the measurement itself ----------------------------------------------------------------


async def test_a_served_conversation_reports_what_the_provider_reported(db_session) -> None:
    """★ THE POSITIVE CASE, FIRST. Every other test here asserts a skip or an absence, and a
    reader that answered None to everything would satisfy most of them."""
    user, conversation = await _thread(db_session)
    await _served_turn(db_session, user, conversation, input_tokens=42_000)

    assert measured_context_tokens(await _rows(db_session, user, conversation)) == 42_000


async def test_the_platforms_own_last_word_does_not_read_back_as_an_empty_chat(
    db_session,
) -> None:
    """★ COVERS AE3, THE HAPPY PATH THIS UNIT IS FOR.

    A long conversation whose NEWEST response is one the platform wrote — which carries no
    measurement at all — must still report the last turn that WAS measured. Read "the last
    response" and this conversation hands itself back as empty, and the meter goes silent
    exactly when the platform speaks last, which on this platform is often.

    MUTATION: swap the `max(...)` for the trailing response and this goes red while the
    positive case above stays green."""
    user, conversation = await _thread(db_session)
    await _served_turn(db_session, user, conversation, input_tokens=310_000)
    await _platform_said(db_session, user, conversation, "Starting your build.")

    assert measured_context_tokens(await _rows(db_session, user, conversation)) == 310_000


async def test_a_conversation_nobody_has_measured_is_unmeasured_not_zero(db_session) -> None:
    """★ EDGE CASE: no measured turn at all — answered, not raised, and answered `None`.

    `None` and `0` are different claims. `0` says the chat is empty, which the meter would be
    entitled to act on; `None` says nobody has counted, which is the truth for a brand-new chat
    and for one where only the platform has spoken. The browser stays silent on `None` rather
    than assuming either — guessing is the whole thing #194 deleted."""
    user, conversation = await _thread(db_session)

    assert measured_context_tokens(await _rows(db_session, user, conversation)) is None

    await _platform_said(db_session, user, conversation, "Starting your build.")

    assert measured_context_tokens(await _rows(db_session, user, conversation)) is None


async def test_the_hidden_turn_terminal_row_does_not_become_the_measurement(db_session) -> None:
    """★ INTEGRATION. Every turn now ends with a hidden, payload-less `system_event` row, and it
    is the LAST row in the conversation. It carries no messages at all, so a reader that walked
    rows without checking what it found would measure the row that ends the turn rather than the
    turn — and report zero for a conversation the provider has just filled.

    Written through the real `append_batch` in the engine's own shape, so a drift in how that row
    is written breaks this too."""
    user, conversation = await _thread(db_session)
    await _served_turn(db_session, user, conversation, input_tokens=175_000)
    await _turn_terminal(db_session, user, conversation)

    rows = await _rows(db_session, user, conversation)

    # LIVENESS: the terminal row really is there and really is last, so the assertion below is
    # about skipping it rather than about a row that was never written.
    assert rows[-1].entry_kind is MessageEntryKind.SYSTEM_EVENT
    assert measured_context_tokens(rows) == 175_000


async def test_the_figure_is_the_raw_prompt_count_and_not_the_bill(db_session) -> None:
    """★ ASM14, AND THE ONE MISTAKE THIS PLATFORM KEEPS MAKING.

    A long conversation served almost entirely from cache. The BILL is tiny and correctly so —
    `weighted_spend` prices a cache read at a tenth, because that is what it costs. The WINDOW
    is full regardless: every one of those tokens is in the prompt, byte for byte.

    Verified by RUNNING the provider's extraction path, not by reading a docstring — reading is
    what reinforced the wrong belief twice. `RequestUsage.extract` on an Anthropic payload of
    `input_tokens: 10` + `cache_read_input_tokens: 90_000` yields `input_tokens == 90_010`: the
    cache read is folded IN, so nothing here may add it or subtract it.

    Route this reader through the spend helper and a 190,000-token chat reports as 23,500 — not
    "different by rounding", different by an order of magnitude, and on the wrong side of the
    threshold it should have warned at."""
    user, conversation = await _thread(db_session)
    await _served_turn(
        db_session, user, conversation, input_tokens=190_000, cache_read_tokens=185_000
    )

    occupied = measured_context_tokens(await _rows(db_session, user, conversation))

    assert occupied == 190_000

    billed = weighted_spend(
        input_tokens=190_000, output_tokens=0, cache_read_tokens=185_000, cache_write_tokens=0
    )
    assert billed < 25_000  # what a spend-shaped meter would have shown
    assert occupied is not None and occupied > billed * 7  # roughly tenfold apart, not rounding


async def test_the_largest_measurement_wins_even_when_a_later_turn_reports_less(
    db_session,
) -> None:
    """★ THE MUTANT SKIPPING THE ZEROS DOES NOT KILL: "the newest measured turn" and "the largest"
    agree on every conversation whose prompt only ever grows, which is most of them. So this one
    is built where they DISAGREE — a later served turn reporting a smaller prompt than an earlier
    one, which is what a retried request or a re-seeded run looks like.

    The maximum is what the server compares against (`enforce_context_limit`), so a reader that
    took the newest would show a citizen a smaller chat than the one they will be refused on —
    and the two numbers this whole unit exists to unify would be two numbers again.

    MUTATION: `max(...)` → the last measured value, and this goes red while every other test in
    this file stays green."""
    user, conversation = await _thread(db_session)
    await _served_turn(db_session, user, conversation, input_tokens=120_000)
    await _served_turn(db_session, user, conversation, input_tokens=40_000)
    await _platform_said(db_session, user, conversation, "Your app is ready.")
    await _turn_terminal(db_session, user, conversation)

    assert measured_context_tokens(await _rows(db_session, user, conversation)) == 120_000


# --- the two readers are one rule ----------------------------------------------------------


async def test_the_meter_and_the_wall_measure_the_same_conversation_identically(
    db_session,
) -> None:
    """★ COVERS AE3b, AT THE SEAM. The browser's meter reads this; `enforce_context_limit` reads
    a validated `list[ModelMessage]` from `load_history`. Two readers, two input shapes, one
    rule — and the whole point of #194 is that they are the SAME NUMBER rather than two readings
    of one scale.

    So both are run over the same persisted conversation, and the check's own expression is
    reproduced here rather than mocked: if either side changes what it counts, this goes red.

    MUTATION: make either reader take the last measurement, or the sum, or the weighted spend,
    and this goes red while each side's own tests could still pass."""
    user, conversation = await _thread(db_session)
    await _served_turn(
        db_session, user, conversation, input_tokens=64_000, cache_read_tokens=60_000
    )
    await _served_turn(
        db_session, user, conversation, input_tokens=196_000, cache_read_tokens=190_000
    )
    await _platform_said(db_session, user, conversation, "Your app is ready.")
    await _turn_terminal(db_session, user, conversation)

    from_rows = measured_context_tokens(await _rows(db_session, user, conversation))

    history = await load_history(
        db_session, user_id=user.id, conversation_id=conversation.id, rehydrate=_no_refs
    )
    from_history = max(
        (m.usage.input_tokens for m in history if isinstance(m, ModelResponse)), default=0
    )

    assert from_rows == 196_000
    assert from_rows == from_history
