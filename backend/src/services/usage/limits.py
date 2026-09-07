"""Effective per-user limits — the daily token cap and the per-conversation context
guardrails (soft/hard), resolved with the clamps the portal has always applied.

The SINGLE source of truth shared by the admin `/admin/users` endpoint AND `/auth/me`, so a
superadmin's per-user override reaches the client (the daily badge + the "getting long"
warning) instead of the client silently falling back to the global defaults. Daily reuses the
gate's resolver so the badge and the 429 gate can never diverge.

WHO ENFORCES WHICH. `hard` is the SERVER's: `usage/context_window.enforce_context_limit`
refuses a turn at the route, before anything is persisted. `soft` is the browser's: it is
advisory, it blocks nothing, and it exists to warn the citizen in time to start a new chat
rather than to be told at the wall. This docstring used to call both of them "the values the
client should enforce", which was true of neither — nothing enforced them at all, front or
back, while an administrator was being shown a field promising a hard stop.
"""

from __future__ import annotations

import uuid
from typing import Final

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.db.models.user_limit import UserLimit
from src.services.usage.gate import effective_daily_limit

# Context guardrails (Express `limits.js`) — the SPA per-conversation warn/stop thresholds.
MODEL_CONTEXT_WINDOW = 200_000
DEFAULT_CONTEXT_SOFT = 150_000
DEFAULT_CONTEXT_HARD = 200_000

SYSTEM_PROMPT_RESERVE: Final = 8_000
"""What a run costs before the citizen has typed anything — the per-run system prompt and the
tool schemas that ride with it.

Measured at the time of writing: the Plan segment composes to ~1,800 tokens and the Build
segment — the larger — to ~4,400, before the tool schemas. 8,000 covers the larger of the two
with room for the schemas and for both to grow.

★ NOTHING HOLDS IT BACK ANY MORE, AND THAT IS AN IMPROVEMENT RATHER THAN A LOSS. This used to
be a reserve in the literal sense: the gate estimated a conversation and then added this,
because the system prompt was composed after the gate had decided and the estimate could not
see it. The gate now reads the token count the PROVIDER reported for a completed turn, and that
count is of the whole prompt — system segment, tool schemas and all. There is nothing left for
it to be blind to, so there is nothing to reserve.

IT SURVIVES AS A SIZE, NOT AS A CHARGE. The floor below is derived from it, and the admin
panel's `contextLimits.SYSTEM_PROMPT_RESERVE` is its browser twin, so an administrator's lowest
settable ceiling is expressed in the same unit on both sides."""

CONTEXT_HARD_FLOOR: Final = SYSTEM_PROMPT_RESERVE * 2
"""The lowest per-user chat length that still leaves a usable chat.

AN ADMINISTRATOR MUST NOT BE ABLE TO LOCK A CITIZEN OUT, and below this they could. Every run
spends `SYSTEM_PROMPT_RESERVE` on its system prompt and tool schemas before the citizen has
typed a word, and the provider counts that in the very first turn it reports — so a hard limit
at or under the reserve refuses that person's SECOND message in every chat they open, forever,
whatever they wrote in the first. Only another administrator raising the number gets them
working again, and nothing in the product says that is what happened.

TWICE THE RESERVE, not the reserve plus one: a floor that merely clears the reserve would leave
a chat with room for a sentence and no reply. This leaves the reserve plus an equal amount of
real conversation — tight, deliberate, and still a chat someone can use."""


def effective_context(override: UserLimit | None) -> tuple[int, int]:
    """Resolve (soft, hard) with Express's clamps: hard ≤ the model window and ≥ the floor;
    soft in [1, hard-1]. A non-positive/absent override falls back to the default (0/negative
    never caps to nothing).

    THE FLOOR IS APPLIED AT READ TIME AS WELL AS AT WRITE TIME, and both halves are needed. The
    admin PATCH validator refuses a new value below it, which is where an administrator learns
    why; this clamp is what keeps a value ALREADY stored below the floor — written before the
    validator existed — from locking that citizen out of every chat they own. Validation alone
    would leave the people the defect already reached exactly where it left them."""
    hard_raw = (
        override.context_hard_limit
        if override and override.context_hard_limit and override.context_hard_limit > 0
        else DEFAULT_CONTEXT_HARD
    )
    hard = max(CONTEXT_HARD_FLOOR, min(hard_raw, MODEL_CONTEXT_WINDOW))
    soft_raw = (
        override.context_soft_limit
        if override and override.context_soft_limit and override.context_soft_limit > 0
        else DEFAULT_CONTEXT_SOFT
    )
    soft = max(1, min(soft_raw, hard - 1))
    return soft, hard


async def effective_limits_for(db: AsyncSession, user_id: uuid.UUID) -> tuple[int, int, int]:
    """(daily, context_soft, context_hard) for one user, as the client is told them: `daily`
    drives the badge, `context_soft` the browser's warning, `context_hard` the number the
    SERVER refuses at (sent so the browser can describe the boundary, never so it can police
    it). Loads the user's override once; daily via the gate resolver so the badge and the gate
    agree."""
    daily = await effective_daily_limit(db, user_id)
    override = await db.scalar(select(UserLimit).where(UserLimit.user_id == user_id))
    soft, hard = effective_context(override)
    return daily, soft, hard
