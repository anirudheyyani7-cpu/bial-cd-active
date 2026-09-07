"""The window measurement — what it counts, and what it must never be confused with.

The unit under test answers ONE question: how much of the model's context window will this
turn's prompt occupy. The failure this whole guardrail exists to fix was that nobody was
asking it; the failure that would replace it is asking it with the billing helpers, which
discount a cached prefix to a tenth and would report a full conversation as an empty one.
"""

from __future__ import annotations

import dataclasses
from typing import Any, cast

import pytest
from pydantic_ai import BinaryContent
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)

from src.api.v1.attachments.router import MAX_PDF_PAGES
from src.services.usage.context_window import (
    CHARS_PER_TOKEN,
    NOMINAL_BINARY_TOKENS,
    NOMINAL_PDF_TOKENS,
    occupied_window,
)
from src.services.usage.gate import weighted_spend
from src.services.usage.limits import SYSTEM_PROMPT_RESERVE


def _user(text: str) -> ModelRequest:
    return ModelRequest(parts=[UserPromptPart(content=text)])


def _assistant(text: str) -> ModelResponse:
    return ModelResponse(parts=[TextPart(content=text)])


def test_an_empty_conversation_is_the_reserve_and_nothing_else() -> None:
    # The floor is not zero: the system prompt this cannot see is still going to be there.
    assert occupied_window([], None) == SYSTEM_PROMPT_RESERVE


def test_prose_counts_at_four_characters_to_the_token() -> None:
    history: list[ModelMessage] = [_user("a" * 400), _assistant("b" * 800)]
    assert occupied_window(history, None) == SYSTEM_PROMPT_RESERVE + 100 + 200


def test_the_message_about_to_be_sent_counts_too() -> None:
    # Measured BEFORE it is persisted, so it is not in the history — counting only the history
    # would let the one message that pushes a conversation over the edge through every time.
    before = occupied_window([_user("x" * 400)], None)
    after = occupied_window([_user("x" * 400)], "y" * 4_000)
    assert after - before == 1_000


def test_a_regenerate_counts_its_prompt_once() -> None:
    # A regenerate replays the trailing request rather than sending a new one, so the route
    # passes `prompt=None`. Charging a phantom second copy would refuse a retry the original
    # turn was allowed.
    history = [_user("q" * 4_000)]
    assert occupied_window(history, None) == SYSTEM_PROMPT_RESERVE + 1_000


def test_a_binary_is_a_flat_charge_not_its_byte_length() -> None:
    """★ The over-count that would refuse every conversation containing a photo.

    A 3 MB image base64s to ~4 M characters. Counted as text that is a million tokens, and no
    conversation carrying one could ever start. Mutation check: delete the `BinaryContent` arm
    in `_tokens_in` so the generic dataclass walk descends into `.data`, and this goes red."""
    big = BinaryContent(data=b"\x89PNG" + b"\x00" * 3_000_000, media_type="image/png")
    history = [ModelRequest(parts=[UserPromptPart(content=["look at this", big])])]

    measured = occupied_window(history, None)

    prose = -(-len("look at this") // CHARS_PER_TOKEN)
    assert measured == SYSTEM_PROMPT_RESERVE + NOMINAL_BINARY_TOKENS + prose
    # And emphatically not the byte length, in either direction.
    assert measured < 10_000


def test_tool_traffic_occupies_the_window_like_anything_else() -> None:
    """A Build turn's window is mostly tool calls and their results. A measure that saw only
    prose would read a 180k build conversation as a few thousand tokens — which is exactly the
    conversation this guardrail is for."""
    prose: list[ModelMessage] = [_user("hi"), _assistant("hello")]
    prose_only = occupied_window(prose, None)
    with_tools = occupied_window(
        [
            _user("hi"),
            ModelResponse(parts=[ToolCallPart(tool_name="read_file", args={"path": "p" * 4_000})]),
            ModelRequest(
                parts=[
                    ToolReturnPart(
                        tool_name="read_file", content="f" * 8_000, tool_call_id="call-1"
                    )
                ]
            ),
            _assistant("hello"),
        ],
        None,
    )
    assert with_tools - prose_only >= 3_000


def test_an_unknown_part_shape_is_still_counted() -> None:
    """The walk is structural, not a per-part-type table, and this is why.

    pydantic-ai's part union grows. A table would stop counting whatever it did not recognise,
    and under-counting is the direction that HURTS — it is what lets an over-long conversation
    past the guard. A dataclass this module has never heard of is still measured."""

    @dataclasses.dataclass
    class SomeFuturePart:
        content: str

    parts = cast(Any, [TextPart(content="short"), SomeFuturePart(content="z" * 4_000)])
    response = ModelResponse(parts=parts)

    assert occupied_window([response], None) >= SYSTEM_PROMPT_RESERVE + 1_000


def test_the_window_is_not_the_bill_and_cache_is_the_reason() -> None:
    """★ The BILL for a long, mostly-cached turn is tiny — `weighted_spend` correctly
    discounts a cache read to a tenth — but the WINDOW is full regardless: every one of those
    tokens is still in the prompt. Mutation check: route the window through `weighted_spend`
    instead and a 190,000-token conversation reports as ~30,000 — the guardrail never fires,
    and this is the only test that would notice.
    """
    # ~150k tokens of conversation: the shape that would be almost entirely cache-read.
    history: list[ModelMessage] = [_user("a" * 300_000), _assistant("b" * 300_000)]

    occupancy = occupied_window(history, None)
    assert occupancy > 150_000

    # What the same turn would be BILLED, with 90% of its prompt served from cache.
    billed = weighted_spend(
        input_tokens=150_000,
        output_tokens=0,
        cache_read_tokens=135_000,
        cache_write_tokens=0,
    )
    assert billed < 30_000
    # Not "different by rounding" — different by an order of magnitude. A window measured with
    # the billing weights would be under a 200k limit while the real prompt was over it.
    assert occupancy > billed * 4


@pytest.mark.parametrize("chars", [0, 1, 3, 4, 5])
def test_a_partial_token_rounds_up(chars: int) -> None:
    # Floor division would report a 3-character message as zero tokens. Harmless once;
    # systematic across thousands of small tool returns it is a real under-count.
    expected = -(-chars // CHARS_PER_TOKEN)
    assert occupied_window([_user("x" * chars)], None) == SYSTEM_PROMPT_RESERVE + expected


# --- documents cost what documents cost ----------------------------------------


def _pdf(identifier: str = "doc") -> BinaryContent:
    return BinaryContent(data=b"%PDF-1.4 ...", media_type="application/pdf", identifier=identifier)


def _image(identifier: str = "shot") -> BinaryContent:
    return BinaryContent(
        data=b"\x89PNG" + b"\x00" * 4_000, media_type="image/png", identifier=identifier
    )


def test_a_pdf_and_an_image_are_charged_differently() -> None:
    """★ THE UNDER-COUNT, IN ONE ASSERTION.

    A 61-page document really occupies ~153,000 tokens — 77% of the hard limit — and was
    measured at 1,600, or 0.8%. The flat charge is honest for an IMAGE, whose cost does not
    scale with byte length, and was the largest error in this module for a DOCUMENT, which is
    read page by page.

    MUTATION: swap the two constants in `_tokens_in` and both halves of this go red — the PDF
    would read as 1,600 (the bug) and the image as 75,000 (which would refuse every
    conversation containing a screenshot)."""
    reserve_only = occupied_window([], None)

    pdf_only = occupied_window([ModelRequest(parts=[UserPromptPart(content=[_pdf()])])], None)
    image_only = occupied_window([ModelRequest(parts=[UserPromptPart(content=[_image()])])], None)

    assert pdf_only - reserve_only == NOMINAL_PDF_TOKENS
    assert image_only - reserve_only == NOMINAL_BINARY_TOKENS
    assert NOMINAL_PDF_TOKENS > NOMINAL_BINARY_TOKENS * 40


def test_the_document_charge_covers_the_longest_document_the_platform_admits() -> None:
    """The two numbers are one decision, and this is the seam that holds them together.

    The upload cap admits at most `MAX_PDF_PAGES` pages; a page measured ~2,514 tokens. A
    charge below that product would leave an ADMITTED document under-counted, which is exactly
    the under-count this module guards against — so raising the page cap without raising the
    charge is the regression this test refuses.

    THE 1% IS A REAL ALLOWANCE, NOT A FUDGE FACTOR, and saying so is the point of this
    paragraph. 30 × 2,514 = 75,420 and the charge is 75,000, so the bound below is not
    "comfortably satisfied" — it is satisfied BY the tolerance, and a reader who assumed the
    charge covered the product exactly would be wrong by 420 tokens. That shortfall is 0.6%
    against an 8,000-token reserve and is accepted deliberately in favour of a round number;
    `NOMINAL_PDF_TOKENS`' own docblock carries the reasoning. What this still refuses is the
    regression that matters: move `MAX_PDF_PAGES` up and the product outruns the tolerance."""
    measured_tokens_per_page = 2_514

    # `* 0.99` — see the paragraph above. Tightening this to `>= product` is a deliberate
    # decision to raise the charge, not a cleanup.
    assert NOMINAL_PDF_TOKENS >= MAX_PDF_PAGES * measured_tokens_per_page * 0.99
    # And not wildly above it either: an over-charge refuses conversations that would fit.
    assert NOMINAL_PDF_TOKENS <= MAX_PDF_PAGES * measured_tokens_per_page * 1.2


def test_one_document_leaves_room_to_work_and_two_do_not() -> None:
    """The missing behaviour restored here: one ordinary document plus a real conversation sits
    inside the soft limit, and a second document does not.

    This is the shape of the whole fix — not "documents are refused" but "a document costs what
    it costs, so the warning fires before the wall does"."""
    from src.services.usage.limits import DEFAULT_CONTEXT_HARD, DEFAULT_CONTEXT_SOFT

    prose: list[ModelMessage] = [_user("a" * 40_000), _assistant("b" * 40_000)]  # 20k tokens

    one = occupied_window(
        [*prose, ModelRequest(parts=[UserPromptPart(content=[_pdf("a")])])], None
    )
    two = occupied_window(
        [
            *prose,
            ModelRequest(parts=[UserPromptPart(content=[_pdf("a")])]),
            ModelRequest(parts=[UserPromptPart(content=[_pdf("b")])]),
        ],
        None,
    )

    assert one < DEFAULT_CONTEXT_SOFT
    assert two > DEFAULT_CONTEXT_SOFT
    # Two still fit under the hard wall — the citizen is warned, not stopped. Three would not.
    assert two < DEFAULT_CONTEXT_HARD


def test_three_documents_cannot_fit_the_hard_limit_at_all() -> None:
    """The document-count cap's arithmetic, asserted rather than assumed: 3 x 75,000 + the
    8,000 reserve is 233,000 against a 200,000 ceiling. It is why the send route refuses a
    third document by COUNT — a token-limit refusal would tell the citizen to start a new
    chat, and the new chat would refuse the identical message."""
    from src.services.usage.limits import DEFAULT_CONTEXT_HARD

    three = occupied_window(
        [ModelRequest(parts=[UserPromptPart(content=[_pdf("a"), _pdf("b"), _pdf("c")])])], None
    )

    assert three > DEFAULT_CONTEXT_HARD
