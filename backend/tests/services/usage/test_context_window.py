"""The per-conversation admission check — what it reads, and what it no longer derives.

★ THE RULE THESE TESTS PIN IS A DIFFERENT RULE FROM THE ONE THEY REPLACE, and the difference
is the unit. The check used to re-derive an occupancy — four characters to the token over a walk
of the message tree, a flat nominal for an image, another for a document, plus a reserve for the
system prompt it could not see. Every one of those numbers is deleted. The check now reads the
token count the PROVIDER returned for a turn it actually served, and derives nothing.

So the arithmetic tests are not loosened here, they are GONE, and two properties take their
place: what the provider reported is the number, and what nobody has measured is not a number
at all. The second one is the honest cost of the change and is asserted head-on: a conversation
carrying a 30-page document the provider has not yet been asked about occupies nothing, and is
admitted. The refusal for that conversation arrives on its next turn, from a measurement, rather
than immediately from a guess that was wrong by 47x in the direction that hurts (#194).

The gate at the ROUTES — nothing persisted, the pending card unburnt, both doors — is
`tests/api/v1/conversations/test_context_gate.py`'s. What is here is the rule itself.
"""

from __future__ import annotations

import uuid

import pytest
from pydantic_ai import BinaryContent
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    UserPromptPart,
)
from pydantic_ai.usage import RequestUsage
from sqlalchemy.ext.asyncio import AsyncSession

from src.db.models.user_limit import UserLimit
from src.services.usage import context_window
from src.services.usage.context_window import (
    ContextWindowExceededError,
    enforce_context_limit,
)
from src.services.usage.gate import weighted_spend
from src.services.usage.limits import DEFAULT_CONTEXT_HARD
from tests.factories import UserFactory


def _served(input_tokens: int, *, cache_read_tokens: int = 0) -> ModelResponse:
    """A response the provider served, carrying the count it reported for that prompt."""
    return ModelResponse(
        parts=[TextPart(content="ok")],
        usage=RequestUsage(input_tokens=input_tokens, cache_read_tokens=cache_read_tokens),
    )


def _written_by_the_platform() -> ModelResponse:
    """A response the platform wrote itself — a handoff note, a build's opening message. It is a
    real `ModelResponse` in the history and it carries a real `RequestUsage`, whose every field
    is zero because no provider ever saw it."""
    return ModelResponse(parts=[TextPart(content="Starting your build.")])


def _typed(text: str) -> ModelRequest:
    return ModelRequest(parts=[UserPromptPart(content=text)])


async def _user_with_ceiling(db: AsyncSession, ceiling: int | None = None):
    user = await UserFactory.create(db)
    if ceiling is not None:
        db.add(UserLimit(user_id=user.id, context_hard_limit=ceiling))
        await db.flush()
    return user


async def _refusal(db: AsyncSession, user_id: uuid.UUID, history: list[ModelMessage]):
    """The error the check raises, or None when it admits the conversation."""
    try:
        await enforce_context_limit(db, user_id, history=history)
    except ContextWindowExceededError as exc:
        return exc
    return None


# --- the check admits ordinary conversations ---------------------------------------------


async def test_a_conversation_the_provider_has_never_served_is_admitted(db_session) -> None:
    """★ THE POSITIVE CASE, FIRST. Every other test here asserts a refusal, and a check that
    refused everything would satisfy all of them. A brand-new chat has no measurement and must
    open."""
    user = await _user_with_ceiling(db_session)

    assert await _refusal(db_session, user.id, []) is None


async def test_a_measured_conversation_well_inside_the_ceiling_is_admitted(db_session) -> None:
    user = await _user_with_ceiling(db_session)
    history: list[ModelMessage] = [_typed("hello"), _served(12_000)]

    assert await _refusal(db_session, user.id, history) is None


# --- the number is the provider's, and nothing else ---------------------------------------


async def test_the_occupancy_is_the_count_the_provider_reported(db_session) -> None:
    """★ THE NEW RULE IN ONE ASSERTION. The refusal carries the provider's own figure, verbatim
    — not that figure plus a reserve, not a figure derived from anything in the message tree."""
    user = await _user_with_ceiling(db_session)
    history: list[ModelMessage] = [_typed("carry on"), _served(DEFAULT_CONTEXT_HARD + 7)]

    exc = await _refusal(db_session, user.id, history)

    assert exc is not None
    assert exc.occupied == DEFAULT_CONTEXT_HARD + 7
    assert exc.hard_limit == DEFAULT_CONTEXT_HARD


async def test_nothing_in_the_transcript_is_measured(db_session) -> None:
    """★ THE DELETION, ASSERTED HEAD-ON RATHER THAN BY THE ABSENCE OF A TEST.

    Six hundred thousand characters of prose and a 3 MB binary, on a turn the provider has not
    reported. Under the estimator this was ~150,000 tokens and would have been refused against a
    lowered ceiling; there is no estimator, so it is nothing.

    MUTATION: reintroduce any character-count or per-binary charge and this goes red. It is the
    guard that stops the estimate being quietly rebuilt inside the check that replaced it."""
    user = await _user_with_ceiling(db_session, ceiling=20_000)
    big = BinaryContent(data=b"\x89PNG" + b"\x00" * 3_000_000, media_type="image/png")
    history: list[ModelMessage] = [
        ModelRequest(parts=[UserPromptPart(content=["look at this", big])]),
        _typed("a" * 600_000),
        _written_by_the_platform(),
    ]

    assert await _refusal(db_session, user.id, history) is None


async def test_a_document_occupies_nothing_until_the_provider_has_counted_it(db_session) -> None:
    """AE3b, and the honest cost of the change stated as a test rather than left to be found.

    A thirty-page document — the longest the upload route admits — sits in the history of a
    conversation whose ceiling is 20,000 tokens. The platform computes NO token figure for it
    and stores none, so it is admitted. It used to be charged a flat 75,000 here, and before
    that a flat 1,600 (#194): two guesses, one of them wrong by 47x. The refusal that matters
    now arrives on the next turn, from what the provider actually counted."""
    user = await _user_with_ceiling(db_session, ceiling=20_000)
    document = BinaryContent(
        data=b"%PDF-1.4" + b"\x00" * 80_000, media_type="application/pdf", identifier="spec"
    )
    history: list[ModelMessage] = [
        ModelRequest(parts=[UserPromptPart(content=["read this", document])])
    ]

    assert await _refusal(db_session, user.id, history) is None

    # And the turn AFTER it, once the provider has said what that prompt cost, is refused.
    history.append(_served(153_342))
    exc = await _refusal(db_session, user.id, history)
    assert exc is not None
    assert exc.occupied == 153_342


async def test_the_largest_reported_prompt_wins_not_the_last(db_session) -> None:
    """★ THE UNDER-COUNT THIS RULE COULD STILL HAVE HAD, AND THE MUTATION THAT CATCHES IT.

    The platform writes messages of its own into a conversation and they carry a `RequestUsage`
    whose fields are all zero, because no provider ever served them. Read "the last response"
    and a full conversation whose newest row is one of those reads back as an empty one — a
    guardrail that goes silent exactly when the platform speaks last.

    MUTATION: swap the `max(...)` for the trailing response and this goes red while every other
    test in this file stays green."""
    user = await _user_with_ceiling(db_session)
    history: list[ModelMessage] = [
        _typed("write the app"),
        _served(DEFAULT_CONTEXT_HARD + 1_000),
        _written_by_the_platform(),
    ]

    exc = await _refusal(db_session, user.id, history)

    assert exc is not None
    assert exc.occupied == DEFAULT_CONTEXT_HARD + 1_000


async def test_the_window_is_not_the_bill_and_cache_is_the_reason(db_session) -> None:
    """★ KTD-2, and it survives the change to a measured figure — with a new way to get it wrong.

    A long conversation is served with almost all of its prompt read from cache. The BILL is
    tiny: `weighted_spend` discounts a cache read to a tenth, correctly, because that is what it
    costs. The WINDOW is full regardless — every one of those tokens is in the prompt.

    `input_tokens` is the provider's RAW prompt count and is already inclusive of both cache
    classes, which is exactly the occupancy this asks for. Route the check through the spend
    helper — or subtract `cache_read_tokens` on the belief that they are counted twice — and a
    conversation at 190,000 reports as 23,500, comfortably inside the very ceiling it is over."""
    user = await _user_with_ceiling(db_session, ceiling=150_000)
    history: list[ModelMessage] = [_typed("carry on"), _served(190_000, cache_read_tokens=185_000)]

    exc = await _refusal(db_session, user.id, history)

    assert exc is not None
    assert exc.occupied == 190_000

    billed = weighted_spend(
        input_tokens=190_000, output_tokens=0, cache_read_tokens=185_000, cache_write_tokens=0
    )
    # Not "different by rounding" — different by an order of magnitude, and on the OTHER SIDE of
    # the ceiling this conversation was just refused against. A check wired to the billing
    # weights would have admitted it.
    assert billed < 30_000
    assert exc.occupied > billed * 4
    assert billed < exc.hard_limit < exc.occupied


# --- the administrator's number is the boundary -------------------------------------------


async def test_the_administrators_ceiling_is_what_decides(db_session) -> None:
    """One conversation, two users. Under the default it is admitted; under a ceiling set below
    its measured size it is refused. Nothing else differs, so the only thing that can have
    changed the answer is the number an administrator typed."""
    measured: list[ModelMessage] = [_typed("carry on"), _served(40_000)]

    allowed = await _user_with_ceiling(db_session)
    assert await _refusal(db_session, allowed.id, measured) is None

    capped = await _user_with_ceiling(db_session, ceiling=20_000)
    exc = await _refusal(db_session, capped.id, measured)
    assert exc is not None
    assert exc.hard_limit == 20_000


@pytest.mark.parametrize(
    ("measured", "refused"),
    [(19_999, False), (20_000, True), (20_001, True)],
)
async def test_the_boundary_is_at_the_ceiling_not_past_it(
    db_session, measured: int, refused: bool
) -> None:
    """`>=` against `>` is a one-character mutation. A conversation measured AT its ceiling has
    no room for the turn that would follow, so it is refused there rather than one turn later."""
    user = await _user_with_ceiling(db_session, ceiling=20_000)

    exc = await _refusal(db_session, user.id, [_typed("hi"), _served(measured)])

    assert (exc is not None) is refused


# --- the estimator is gone, not merely unused ---------------------------------------------


def test_no_estimator_symbol_survives_in_the_module() -> None:
    """★ ASSERT-ABSENCE, PAIRED WITH LIVENESS so it cannot false-green on a module that failed
    to import. Each of these was a number the platform derived and no longer may."""
    for name in (
        "CHARS_PER_TOKEN",
        "PDF_MEDIA_TYPE",
        "NOMINAL_BINARY_TOKENS",
        "NOMINAL_PDF_TOKENS",
        "occupied_window",
        "_tokens_in",
        "_tokens_in_message",
    ):
        assert not hasattr(context_window, name), (
            f"{name} is back — the estimator R8 deleted has been rebuilt"
        )

    # Liveness: the module really imported, so the absences above are absences and not the
    # silence of a module that never loaded.
    assert callable(context_window.enforce_context_limit)
    assert issubclass(context_window.ContextWindowExceededError, Exception)
