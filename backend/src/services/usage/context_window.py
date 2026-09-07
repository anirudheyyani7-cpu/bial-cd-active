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
) -> int:
    """Raise `ContextWindowExceededError` when this conversation is past its owner's hard limit,
    and hand back the occupancy it measured.

    ONE CALLER NOW — `turns.start_turn`, the route that starts a turn on a conversation that
    already exists. This used to be a shared preflight with `transition.build_from_plan`, and
    the deletion of that second call is a decision, not an oversight (D16). A build chat is
    created EMPTY: the route measured a fresh conversation against a ceiling and could only ever
    admit, so it was a guard that had already gone inert. The bound that does hold on that door
    is the plan's own — `engine.plan_from_call` refuses an offer whose plan is past
    `MAX_MESSAGE_TEXT_CHARS`, with copy that asks for a shorter plan, which is the remedy that
    works there.

    AND DO NOT "FIX" IT BY POINTING IT AT THE SOURCE PLAN CHAT. That substitution is the obvious
    repair and it is the harmful one: the build chat inherits none of the plan chat's history, so
    measuring the plan chat would refuse "Build this plan" for exactly the citizens who planned
    longest — and send them to start a new chat, which is where the plan they are trying to build
    lives.

    NOTHING SIZES THE MESSAGE ABOUT TO BE SENT, and there is no argument here for one. Only the
    provider can count a prompt, and it counts it when the turn completes; an argument this
    function accepted and did not measure is exactly the shape a later reader mistakes for a
    check. The reading is RETROSPECTIVE by construction and the module docstring says why.

    IT RETURNS WHAT IT MEASURED, which is what makes the browser's meter and this wall the same
    number rather than two readings of one scale. `turns.start_turn` puts it on the 202 the send
    already gets, so the meter is fed by the very computation that admitted the turn — no second
    request, and nothing sized before a send.

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
    return occupied
