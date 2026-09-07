"""How much of the model's context window a conversation already occupies.

WHY THIS EXISTS: this is NOT a spend measurement, and that distinction is the whole
point. `weighted_spend`/`billable_spend` discount a cache READ to a tenth of a fresh
token because that is what it costs — but a cached token still OCCUPIES the window,
byte for byte. Routing a window check through billing weights would report a 190k
conversation as 30k and the guardrail would never fire. This confusion has recurred
three times in this repo's history; token accounting now routes through a shared,
PURPOSE-NAMED function, and this is that function.

It measures a HEURISTIC, not the model's own count: pydantic-ai's `count_tokens()` is a network
round trip with unverified Foundry compatibility (the Files API's failure mode). This walks the
`list[ModelMessage]` `load_history` loads every turn, plus the message about to be sent — four
characters to the token, the same ratio the retired client-side guardrail used, so browser and
server describe one thing. TWO flat nominals per `BinaryContent`, the document's far larger than
the image's: an image is worth roughly a thousand tokens however many megabytes it is, a document
is worth what its PAGES cost, and charging base64 length would read a 5 MB photo as 1.7 MILLION
tokens and refuse every conversation that contained one. A structural walk (list → dict →
dataclass), never a per-part-type table: an unrecognised part shape still counts, since
under-counting is the direction that hurts — and it over-counts a little too, since
`ModelResponse`'s model name and provider id never reach the model (tens of characters, the safe
direction). It does NOT see the per-run system prompt composed after this gate runs
(`SYSTEM_PROMPT_RESERVE` covers that). It decides one thing: whether a conversation is past the
boundary an administrator set. Nothing is billed from it.
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

PDF_MEDIA_TYPE: Final = "application/pdf"
"""The one media type charged as a document. Spelled out here rather than imported from
`api/v1/conversations/_shared.py`, which holds the same string: a service does not reach up
into the API layer for a constant. `_shared.resolve_binaries` admits exactly `image/*` and this,
so the two arms below are the whole of what can reach the model as a binary."""

NOMINAL_BINARY_TOKENS: Final = 1_600
"""What one attached IMAGE is charged, regardless of its size.

Vision content costs roughly a thousand tokens per image and does not scale with the file's byte
length, so a flat charge is the right shape — byte length is the WRONG number by orders of
magnitude: base64 of a 5 MB photo is ~6.7 M characters, which at four characters to the token
would read as 1.7 M tokens and refuse the conversation outright.

IT NO LONGER COVERS PDFs, and that split is a correctness fix rather than a tidy-up: charging a
document this image-sized number under-counted it by orders of magnitude, which is what let a
conversation past the guard. See `NOMINAL_PDF_TOKENS` for the measurement."""

NOMINAL_PDF_TOKENS: Final = 75_000
"""What one attached PDF is charged, regardless of its size.

★ THE NUMBER THIS REPLACED WAS 1,600, AND IT WAS THE LARGEST ERROR IN THIS MODULE. A document
is read page by page, so its cost scales with pages and not with bytes. A measured 61-page
upload occupied 153,342 tokens — 77% of the 200,000 hard limit — while this module recorded it
as 1,600, or 0.8%. A citizen attaching documents could therefore carry a conversation
straight past the wall while the guardrail reported it comfortably inside, which is the opaque
provider-side failure the guardrail exists to REPLACE, not a conservative estimate.

IT IS FLAT, NOT PER-PAGE, BY DECISION. Per-page charging would need a page count persisted
on the attachment row, which the platform does not store; more to the point, the owner asked for
one number. So the number is sized to the LONGEST DOCUMENT THE PLATFORM WILL ADMIT: the upload
route refuses anything over `attachments/router.MAX_PDF_PAGES` (30) pages, and a page measured
~2,514 tokens. Under-counting is the only direction that hurts — it is what lets an over-long
conversation past the guard.

THE ROUNDING, STATED RATHER THAN GLOSSED: 30 × 2,514 is 75,420, and this is 75,000. So a
worst-case document — thirty pages, every one as dense as the measured average — is under-charged
by **420 tokens, 0.6%**. Sizing the charge to the cap does NOT make under-counting an admitted
file impossible — that absolute is false by exactly those 420 tokens. The gap is immaterial
against the 8,000-token system-prompt reserve and it is deliberate — a round number the owner
asked for beats 75,420 by enough to be worth 0.6% — but it is a rounding, not an impossibility,
and the test below permits it EXPLICITLY rather than by accident.

THE TWO NUMBERS ARE ONE DECISION. Raising the page cap without raising this re-opens the hole
exactly; raising this without raising the cap merely refuses conversations that would have fit.
`test_context_window.py` pins the relationship so neither can move alone.

WHAT IT COSTS, SAID PLAINLY: with the 8,000-token system-prompt reserve, one document plus a
real build conversation fits inside the 150,000 soft limit, two documents trip the warning
honestly, and three cannot fit the 200,000 ceiling at all — which is why the send route refuses
a third by COUNT rather than letting it arrive as a token-limit refusal that would tell the
citizen to start a new chat that refuses the identical message."""


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
    flat nominal exists to avoid.

    THE BINARY ARM IS SPLIT BY MEDIA TYPE, and reads the type off the content rather than
    guessing from the bytes: a document costs orders of magnitude more than an image and the
    two must not share a number. Anything that is neither — nothing today, since
    `resolve_binaries` admits only these two — falls to the image nominal, the smaller and more
    common shape."""
    if isinstance(node, BinaryContent):
        if node.media_type == PDF_MEDIA_TYPE:
            return NOMINAL_PDF_TOKENS
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
