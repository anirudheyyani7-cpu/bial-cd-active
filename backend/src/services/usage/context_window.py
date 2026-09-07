"""The per-conversation admission check: how much of the window a conversation already holds.

★ THE PLATFORM DOES NOT DERIVE THIS NUMBER ANY MORE, AND THAT IS THE WHOLE MODULE. The
provider returns a token count for every turn it serves; this reads that count. It used to
re-derive one instead — four characters to the token over a structural walk of the message
tree, with a flat nominal for an image and another for a document — and the re-derivation was
wrong in the direction that hurts. A 61-page upload really occupied 153,342 tokens and the
estimate recorded 1,600, or 0.8% of the hard limit (#194). Every constant that made that
possible is gone, and nothing estimates in its place: the measurement now comes from the only
party that can take it.

★ THIS IS NOT A SPEND MEASUREMENT, AND THE SEPARATE MODULE IS STILL THE POINT. `weighted_spend`
and `billable_spend` next door deliberately discount a cache READ to a tenth of a fresh token,
because that is what it costs. A cached token still OCCUPIES the window — it is in the prompt,
byte for byte, whatever it was billed at. Real conversations here run 97-99% cache-read, so
routing a window check through the billing weights would report a 190k conversation as a 30k
one and the guardrail would never fire. `input_tokens` is the provider's raw prompt count and
is already inclusive of both cache classes, which is exactly the occupancy this asks for.

WHAT IT MEASURES, AND THE ONE PROPERTY THAT FALLS OUT OF IT. The number describes the turn the
provider has already served, not the message about to be sent — nobody can count the latter
without asking the provider, and asking is a network round trip on the send path. So the check
is RETROSPECTIVE: a conversation is refused on the turn after the one that filled it. That is
the same guarantee the estimate gave in practice and one the estimate could not keep honestly,
because a wrong estimate refuses conversations that fit and admits conversations that do not.

It is used to decide one thing: whether a conversation has grown past the boundary an
administrator set. It is not billing, and nothing is charged from it.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

from pydantic_ai.messages import ModelMessage, ModelResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.db.models.user_limit import UserLimit
from src.services.usage.limits import effective_context


class ContextWindowExceededError(Exception):
    """This conversation is past the hard limit in force for its owner.

    Raised BEFORE anything is persisted, so the citizen's message is refused whole rather than
    half-recorded. Carries the numbers for the log and the test; the sentence the citizen reads
    is `copy.CHAT_TOO_LONG_TEXT`, and it deliberately states neither."""

    def __init__(self, *, occupied: int, hard_limit: int) -> None:
        super().__init__("conversation context window exceeded")
        self.occupied = occupied
        self.hard_limit = hard_limit


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

    `prompt` IS ACCEPTED AND NOT MEASURED, and saying so is better than a silent shrug. The
    message about to be sent has no token count yet — only the provider can give it one, and it
    gives it when the turn completes. Both callers still pass it; the argument is removed with
    the unit that gives the browser the same measurement.

    THE OCCUPANCY IS THE LARGEST REPORTED PROMPT, NOT THE LAST ONE, and the difference is not
    cosmetic. Not every message in the history is a served turn: the platform writes responses
    of its own and they carry a `RequestUsage()` whose `input_tokens` is zero. Reading "the last
    response" would read that zero and hand a full conversation back as an empty one — the
    under-count that lets an over-long conversation past the guard. A maximum cannot be fooled
    that way, and a conversation's prompt only grows, so the largest measurement is also the
    most recent real one.

    NOTHING HERE RE-READS THE CONVERSATION. `history` is the list the route has already loaded
    and already scoped to its owner (`load_history` filters on `Message.user_id`), so there is
    no second query to scope and no `WHERE` clause to forget.

    Called AFTER `load_history` and BEFORE `persist_user_turn`, the same slot
    `enforce_daily_limit` occupies — so a refused turn leaves no row to roll back and no claim
    to release."""
    override = await db.scalar(select(UserLimit).where(UserLimit.user_id == user_id))
    _soft, hard = effective_context(override)
    occupied = max(
        (message.usage.input_tokens for message in history if isinstance(message, ModelResponse)),
        default=0,
    )
    if occupied >= hard:
        raise ContextWindowExceededError(occupied=occupied, hard_limit=hard)
