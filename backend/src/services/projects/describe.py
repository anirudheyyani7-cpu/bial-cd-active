"""Project description generation from the app's code (U7, KD-5).

Reuses the existing Claude/agent path (Foundry-only, R11 of the migration doc) as a normal
one-shot model call. Its spend is METERED against the citizen but does not come out of their
daily allowance — see `generate_project_description` for why, and for the precedent it
follows. A fresh project (no code) has nothing to generate from — the caller rejects that
BEFORE calling here. When a description already exists, it is fed in alongside the code so
generation *revises* rather than discards it (R19). The code fed to the model is bounded to a
fixed character budget (a single app's snapshot can exceed it), and the result is length-capped
(KD-8).
"""

from __future__ import annotations

import uuid
from typing import Any

from pydantic_ai.models import Model
from sqlalchemy.ext.asyncio import AsyncSession

from src.db.models.project import MAX_PROJECT_DESCRIPTION
from src.db.models.token_usage import TokenUsageKind
from src.services.agent.agent import ChatDeps, chat_agent
from src.services.usage.gate import record_usage

# Bound the code fed to the model so a large snapshot can't blow the window (KD-5).
#
# AN ABSOLUTE NUMBER, NOT A DERIVATION, AND THAT IS THE FIX. This used to be
# `MODEL_CONTEXT_WINDOW * 3` — 200,000 tokens times a ~3-chars-per-token heuristic. The window
# has since been corrected to the figure the deployment actually serves (1,000,000), and the
# derivation would have quietly handed this generator FIVE TIMES more source with nobody
# deciding that: a description is two to four sentences, and how much code it reads is a
# judgement about cost and latency, not a function of how big a chat may get. Nothing guarded
# the derivation, so the change would have shipped unnoticed. 600,000 is exactly what it
# resolved to before, kept on purpose, and `tests/api/v1/projects/test_project_description.py`
# now pins the number itself.
_CODE_CHAR_BUDGET = 600_000
# A description is short (2-4 sentences); cap the model's output so it can't run long.
_MAX_DESCRIPTION_TOKENS = 400

_DESCRIBE_SYSTEM = (
    "You are a technical writer. Given a citizen-built app's source code, write a concise, "
    "factual description (2-4 sentences) of what the app does and who it is for. Output ONLY "
    "the description text — no preamble, no markdown, no code fences."
)


def extract_source(current_code: dict[str, Any] | None) -> str:
    """Pull the working source out of a `{current: {source, ...}}` code snapshot (KD-9);
    empty string when absent or malformed (the caller treats empty as 'nothing to generate')."""
    if not isinstance(current_code, dict):
        return ""
    current = current_code.get("current")
    if not isinstance(current, dict):
        return ""
    source = current.get("source")
    return source if isinstance(source, str) else ""


def bound_source(source: str, budget: int) -> str:
    """Bound code fed to the model to `budget` chars, appending a truncation marker when cut.

    IT HAS ONE CALLER NOW. The second was the retired relay's builder code seed, which is what
    made this a shared truncate-with-marker rather than four lines inline — so by ADR-0010 the
    seam no longer earns its keep, and inlining it is a live option rather than a regression.
    Left standing here because collapsing it is a code change and this pass is a comment sweep;
    what is not acceptable is the docstring going on naming a caller that does not exist."""
    if len(source) <= budget:
        return source
    return source[:budget] + "\n\n[... code truncated to fit the model context window ...]"


def _build_prompt(source: str, current_description: str | None) -> str:
    bounded = bound_source(source, _CODE_CHAR_BUDGET)
    if current_description:
        return (
            "This is the app's CURRENT description:\n"
            f"{current_description}\n\n"
            "This is the app's CURRENT code:\n"
            f"{bounded}\n\n"
            "Revise the description so it accurately reflects the code, preserving the author's "
            "intent where it still holds. Output only the revised description."
        )
    return (
        "This is the app's code:\n"
        f"{bounded}\n\n"
        "Write a concise description of what this app does. Output only the description."
    )


async def generate_project_description(
    db: AsyncSession,
    model: Model,
    user_id: uuid.UUID,
    *,
    source: str,
    current_description: str | None,
) -> str | None:
    """Generate (or revise) a project description from its app code (KD-5). Meters the turn
    via `record_usage`; the CALLER owns the daily-limit check + the commit. Returns the
    length-capped description, or None for a blank generation — the empty string is never
    persisted, the same empty→NULL normalization every other description write path applies
    (KD-8).

    ★ METERED AGAINST THE CITIZEN, NOT BILLED TO THEM (R14). The spend is recorded under
    `review` — the kind the daily gate's `_used_today` does not read — for the same reason the
    pre-publish classification review is (`services/classification/service.py`, the precedent
    this mirrors): the person did not ask for these tokens. They pressed a button that says
    "generate a description", and what it costs is the platform's own reasoning about their
    code, not work they chose to spend their day's allowance on. Under `build` it came out of
    the same budget as their chats, so pressing it twice on a busy day could stop them building
    — and nothing in the product said that was the trade.

    The row is still WRITTEN, and written against them, so the cost stays attributable. What
    changes is only whose ceiling it counts toward."""
    prompt = _build_prompt(source, current_description)
    deps = ChatDeps(db=db, user_id=user_id, system=_DESCRIBE_SYSTEM)
    result = await chat_agent.run(
        prompt, deps=deps, model=model, model_settings={"max_tokens": _MAX_DESCRIPTION_TOKENS}
    )
    usage = result.usage
    await record_usage(
        db,
        user_id,
        input_tokens=usage.input_tokens,
        output_tokens=usage.output_tokens,
        cache_read_tokens=usage.cache_read_tokens,
        cache_write_tokens=usage.cache_write_tokens,
        kind=TokenUsageKind.REVIEW,
    )
    text = result.output.strip()[:MAX_PROJECT_DESCRIPTION]
    return text or None
