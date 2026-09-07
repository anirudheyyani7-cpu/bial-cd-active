"""How much of the model's context window a conversation already occupies.

WHY THIS EXISTS: this is NOT a spend measurement, and that distinction is the whole
point. `weighted_spend`/`billable_spend` discount a cache READ to a tenth of a fresh
token because that is what it costs — but a cached token still OCCUPIES the window,
byte for byte. Routing a window check through billing weights would report a 190k
conversation as 30k and the guardrail would never fire. This confusion has recurred
three times in this repo's history; token accounting now routes through a shared,
PURPOSE-NAMED function, and this is that function.

It measures a HEURISTIC, not the model's own count: pydantic-ai's `count_tokens()` is a
network round trip with unverified Foundry compatibility (the Files API's failure mode).
This instead walks the `list[ModelMessage]` already in memory, four characters to the token,
with a flat nominal per `BinaryContent` — an image is worth roughly a thousand tokens however
many megabytes it is, and charging base64 length would read a 5 MB photo as
1.7 MILLION tokens and refuse every conversation that contained one. A structural walk (list
→ dict → dataclass), never a per-part-type table: a part shape this module has not heard of is
still counted, and under-counting is the direction that hurts. It does NOT see the per-run
system prompt composed after this gate runs (`SYSTEM_PROMPT_RESERVE` covers that). It decides
one thing: whether a conversation is past the boundary an administrator set. Nothing is
billed from it.
"""

from __future__ import annotations

import dataclasses
import uuid
from collections.abc import Sequence
from typing import Any, Final

from pydantic_ai import BinaryContent
from pydantic_ai.messages import ModelMessage
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.db.models.user_limit import UserLimit
from src.services.usage.limits import SYSTEM_PROMPT_RESERVE, effective_context

CHARS_PER_TOKEN: Final = 4
"""The estimate's one constant. Four characters to the token, against the same 200k window,
kept so the browser's warning and the server's refusal are two readings of one scale rather
than two different scales."""

NOMINAL_BINARY_TOKENS: Final = 1_600
"""What one attached image or PDF is charged, regardless of its size.

For an IMAGE this is honest. Vision content costs roughly a thousand tokens per image and does
not scale with the file's byte length, so a flat charge is the right shape — byte length is the
WRONG number by orders of magnitude: base64 of a 5 MB photo is ~6.7 M characters, which at four
characters to the token would read as 1.7 M tokens and refuse the conversation outright.

★ FOR A MULTI-PAGE PDF IT IS A KNOWN UNDER-COUNT, AND THE LARGEST ONE HERE. A document is read
page by page, so a 40-page PDF costs roughly forty times what this charges it, and
`_shared.resolve_binaries` admits `application/pdf` beside `image/*`. A citizen who attaches
documents can therefore carry a conversation past the hard limit while this measures it as
comfortably inside — which is the opaque provider-side failure the guardrail exists to replace,
not a conservative estimate. It is recorded rather than fixed because the honest fix needs a
page count the platform does not store yet (persisted at upload, as the deck branch already
does for its own reasons); charging by byte length instead would resurrect the 1.7 M-token
absurdity above. Until then: prose conversations are guarded, document-heavy ones are not."""


class ContextWindowExceededError(Exception):
    """This conversation is past the hard limit in force for its owner.

    Raised BEFORE anything is persisted, so the citizen's message is refused whole rather than
    half-recorded. Carries the numbers for the log and the test; the sentence the citizen reads
    is `copy.CHAT_TOO_LONG_TEXT`, and it deliberately states neither."""

    def __init__(self, *, occupied: int, hard_limit: int) -> None:
        super().__init__("conversation context window exceeded")
        self.occupied = occupied
        self.hard_limit = hard_limit


def _tokens_in(node: Any) -> int:
    """The estimate over one live object, recursively. See the module docstring for the rules.

    `BinaryContent` is tested BEFORE the generic dataclass arm because it IS a dataclass, and
    descending into it would charge its `data` field by byte length — the exact over-count the
    flat nominal exists to avoid."""
    if isinstance(node, BinaryContent):
        return NOMINAL_BINARY_TOKENS
    if isinstance(node, str):
        return -(-len(node) // CHARS_PER_TOKEN)  # ceil, without importing math for one call
    if isinstance(node, (list, tuple)):  # fmt: skip  # ruff py314 strips parens
        return sum(_tokens_in(item) for item in node)
    if isinstance(node, dict):
        # Values only. Keys are structural — they are a few characters of JSON framing, and
        # counting them would make the estimate a function of pydantic-ai's field names.
        return sum(_tokens_in(value) for value in node.values())
    if dataclasses.is_dataclass(node) and not isinstance(node, type):
        return sum(
            _tokens_in(getattr(node, field.name))
            for field in dataclasses.fields(node)
            if field.name != "part_kind"  # pydantic-ai's union tag, not content
        )
    return 0


def _tokens_in_message(message: ModelMessage) -> int:
    """One message's contribution: its PARTS, and only its parts.

    THE ENVELOPE IS NOT WALKED, deliberately: `ModelResponse`'s bookkeeping fields
    (`kind`, `state`, `model_name`, ...) never reach the model, and walking them would
    make the measurement partly pydantic-ai's own field values, moving when the library
    adds one. Descending into `parts` structurally, rather than a per-part-type table,
    keeps an unrecognised part shape measured too — under-counting is the direction that
    hurts, since it's what lets an over-long conversation past the guard."""
    return _tokens_in(message.parts)


def occupied_window(
    history: Sequence[ModelMessage],
    prompt: object = None,
) -> int:
    """How full the window will be when this turn runs: the stored history, the message about
    to be sent, and the reserve for the system prompt this cannot see.

    `prompt` is whatever the route is about to hand the agent — a string, a mixed
    `[str | BinaryContent]` list, or `None` on a regenerate, where the trailing request in
    `history` IS the prompt and counting it twice would be wrong."""
    stored = sum(_tokens_in_message(message) for message in history)
    return stored + _tokens_in(prompt) + SYSTEM_PROMPT_RESERVE


async def enforce_context_limit(
    db: AsyncSession,
    user_id: uuid.UUID,
    *,
    history: Sequence[ModelMessage],
    prompt: object = None,
) -> None:
    """Raise `ContextWindowExceededError` when past the owner's hard limit. THE ONE
    PREFLIGHT, called from BOTH turn-starting routes (`turns.start_turn`,
    `transition.build_from_plan`) — one function so the second entry point cannot drift.

    NOT "every route that reaches a model": `POST /v1/build-sessions` sends a raw
    prompt, not a history, so it isn't a turn here (its spend is capped in
    `orchestrator/harness.py`). Called AFTER `load_history`, BEFORE `persist_user_turn`
    — a refused turn leaves no row to roll back."""
    override = await db.scalar(select(UserLimit).where(UserLimit.user_id == user_id))
    _soft, hard = effective_context(override)
    occupied = occupied_window(history, prompt)
    if occupied >= hard:
        raise ContextWindowExceededError(occupied=occupied, hard_limit=hard)
