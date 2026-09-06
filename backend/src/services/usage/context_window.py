"""How much of the model's context window a conversation already occupies.

★ THIS IS NOT A SPEND MEASUREMENT, AND THE SEPARATE MODULE IS THE POINT. `weighted_spend` and
`billable_spend` next door deliberately discount a cache READ to a tenth of a fresh token,
because that is what it costs. A cached token still OCCUPIES the window — it is in the prompt,
byte for byte, whatever it was billed at. Routing a window check through the billing weights
would report a 190k conversation as a 30k one and the guardrail would never fire. This repo's
own record has that class of confusion recurring three times, with the rule that token
accounting route through a shared, PURPOSE-NAMED function; so this is that function, and its
name says which question it answers.

WHY A HEURISTIC RATHER THAN THE MODEL'S OWN COUNT. pydantic-ai 2.5.0 exposes
`Model.count_tokens()`, but it is a network round trip to the Foundry-routed client and its
Foundry compatibility is unverified — the same shape as the Files API, which turned out not to
work on Foundry at all. This measures what is already in memory: the `list[ModelMessage]` that
`load_history` loads on every turn anyway, plus the message about to be sent. No call, no DB
read, no new failure mode on the send path.

WHAT IT COUNTS, and where it is deliberately imprecise:

* Every string reachable from the messages, at four characters to the token — the same ratio
  the retired client-side guardrail used, so the browser and the server describe one thing.
* A `BinaryContent` at a flat nominal rather than its byte length — one nominal for an image
  and a much larger one for a PDF. Neither cost tracks byte length: an image is worth roughly
  a thousand tokens however many megabytes it is, and a document is worth what its PAGES cost.
  Charging base64 length would read a 5 MB photo as 1.7 MILLION tokens and refuse every
  conversation that contained one.
* A structural walk (list → dict → dataclass), not a per-part-type table. The part union is
  pydantic-ai's and it grows; a table would silently stop counting whatever it did not know
  about, which is the failure mode that hurts — under-counting is what lets a conversation
  past the guard. The walk shape is `messages/store.py::_assert_binaries_attributed`'s.
* It over-counts a little: `ModelResponse` carries a model name and a provider id that never
  travel back to the model. Tens of characters per turn, and in the safe direction.
* It does NOT see the per-run system prompt, which is composed inside the engine after this
  gate has already decided. That is what `SYSTEM_PROMPT_RESERVE` is for.

So the number is an estimate, and it is used to decide one thing: whether a conversation has
grown past the boundary an administrator set. It is not billing, and nothing is charged from it.
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
"""The estimate's one constant. Four characters to the token is the ratio the retired
`useClaudeAPI.ts` guardrail used against the same 200k window, kept so the browser's warning
and the server's refusal are two readings of one scale rather than two different scales."""

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

IT NO LONGER COVERS PDFs, and that split is the fix for #194 rather than a tidy-up. This
constant used to be charged for both; see `NOMINAL_PDF_TOKENS` for what that cost."""

NOMINAL_PDF_TOKENS: Final = 75_000
"""What one attached PDF is charged, regardless of its size.

★ THE NUMBER THIS REPLACED WAS 1,600, AND IT WAS THE LARGEST ERROR IN THIS MODULE. A document
is read page by page, so its cost scales with pages and not with bytes. A measured 61-page
upload occupied 153,342 tokens — 77% of the 200,000 hard limit — while this module recorded it
as 1,600, or 0.8% (#194). A citizen attaching documents could therefore carry a conversation
straight past the wall while the guardrail reported it comfortably inside, which is the opaque
provider-side failure the guardrail exists to REPLACE, not a conservative estimate.

IT IS FLAT, NOT PER-PAGE, BY DECISION (D4). Per-page charging would need a page count persisted
on the attachment row, which the platform does not store; more to the point, the owner asked for
one number. So the number is sized to the LONGEST DOCUMENT THE PLATFORM WILL ADMIT: the upload
route refuses anything over `attachments/router.MAX_PDF_PAGES` (30) pages, and a page measured
~2,514 tokens. A flat charge sized to the cap cannot under-count an admitted file, which is the
only direction that hurts — under-counting is what lets an over-long conversation past the guard.

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
    two must not share a number (#194). Anything that is neither — nothing today, since
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

    THE MESSAGE ENVELOPE IS NOT WALKED, deliberately. `ModelResponse` carries a dozen
    bookkeeping fields — `kind`, `state`, `model_name`, `provider_name`,
    `provider_response_id`, `finish_reason` — none of which the model ever reads back, and all
    of which are strings. Walking them added a constant to every message, so a long
    conversation's measurement would be part pydantic-ai's own field values, and would MOVE when
    the library added a field.

    Descending into `parts` rather than reading each part type by name keeps the property that
    matters: a part shape this module has never heard of is still measured, because the walk
    below is structural. Under-counting is the direction that hurts — it is what lets an
    over-long conversation past the guard."""
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
    """Raise `ContextWindowExceededError` when this conversation is past its owner's hard limit.

    THE ONE PREFLIGHT, called from BOTH routes that start a conversation turn — `turns.start_turn`
    and `transition.build_from_plan`. The daily cap next door is hand-copied at three call sites,
    and the cost of that is on record: a gate wired to one of two send paths is not a gate, it is
    a detour sign. This is a single function precisely so the second entry point cannot drift
    away from the first.

    IT IS NOT "EVERY ROUTE THAT REACHES A MODEL", and this docstring used to say so. `POST
    /v1/build-sessions` starts a model-driven build without consulting this (its per-step spend
    is capped inside `orchestrator/harness.py`, but its context is not bounded here). That route
    sends a caller-supplied prompt rather than a conversation history, so it is not a turn on a
    conversation — but a reader who took the wider claim at face value would go looking for a
    gate that is not there.

    Called AFTER `load_history` and BEFORE `persist_user_turn`, the same slot
    `enforce_daily_limit` occupies — so a refused turn leaves no row to roll back and no claim
    to release."""
    override = await db.scalar(select(UserLimit).where(UserLimit.user_id == user_id))
    _soft, hard = effective_context(override)
    occupied = occupied_window(history, prompt)
    if occupied >= hard:
        raise ContextWindowExceededError(occupied=occupied, hard_limit=hard)
