"""The classification review agent — six verdicts from the saved code alone.

ONE module-level `Agent`, built without a bound model — the Foundry model is passed
per-run, so importing this module never requires a configured Foundry. Instructions are
a STATIC string so the cache breakpoints hit platform-wide (`prompts.py`).
TOOL-CALLING OUTPUT (`ToolOutput`), not provider-native: the latter is selected by
matching the deployment name string, so a rename would silently downgrade it. EXTENDED
THINKING MUST STAY OFF — `ensure_thinking_off` RAISES (never `assert`) rather than
assuming it, because thinking reroutes output onto that fragile native path.

Tools are read-only over the extracted saved version — no sandbox, no write, no network.
The runner owns invoking this agent; this module owns the agent and its one run entry."""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from pydantic_ai import Agent, RunContext, ToolOutput
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models import Model
from pydantic_ai.models.anthropic import AnthropicModelSettings
from pydantic_ai.run import AgentRunResult
from pydantic_ai.usage import UsageLimits

from src.services.agent.read_tools import (
    ExtractedSnapshotWorkspace,
    ReadOnlyWorkspace,
    read_only_toolset,
)
from src.services.classification.constants import (
    CACHE_TTL,
    MAX_TOKENS,
    REVIEW_EFFORT,
    TEMPERATURE,
    THINKING_FORCING_EFFORT,
)
from src.services.classification.prompts import (
    REVIEW_INSTRUCTIONS,
    LocatedHit,
    build_review_prompt,
)
from src.services.classification.schema import ReviewOutput


class ThinkingEnabledError(RuntimeError):
    """Raised when the review would run with extended thinking enabled — directly, or
    through an effort level that forces it back on. Thinking reroutes output handling
    onto the provider-native path this module exists to avoid, so the combination is
    refused outright rather than run degraded."""


@dataclass(frozen=True)
class ReviewDeps:
    """Per-run agent dependencies. `user_id` is the owning citizen (attribution, and
    the user-scope convention every agent deps carries); `workspace` is the extracted
    snapshot the read tools resolve through. DELIBERATELY no sandbox field: the review
    reads saved code only, and a surface that is not in the deps cannot be
    reached by any tool."""

    user_id: uuid.UUID
    workspace: ReadOnlyWorkspace


def _workspace_of(ctx: RunContext[ReviewDeps]) -> ReadOnlyWorkspace:
    return ctx.deps.workspace


OUTPUT_TOOL_NAME = "record_classification_review"
"""The output tool's name — static, so its definition sits behind the tool-definitions
cache breakpoint unchanged across every review."""

# The constructor is parametrized explicitly: the output type is carried by the
# `ToolOutput` marker, which not every checker resolves through the overloads.
review_agent = Agent[ReviewDeps, ReviewOutput](
    deps_type=ReviewDeps,
    output_type=ToolOutput(
        ReviewOutput,
        name=OUTPUT_TOOL_NAME,
        description=(
            "Record the completed six-question classification review. Call exactly "
            "once, after every question has been examined."
        ),
    ),
    instructions=REVIEW_INSTRUCTIONS,  # static — never composed per run (the cache hit)
    toolsets=[read_only_toolset(_workspace_of)],
    retries=2,
)


def ensure_thinking_off(settings: AnthropicModelSettings) -> None:
    """Fail closed on any thinking-enabling combination (a RAISING runtime check, never
    `assert`). Three doors are guarded: the base `thinking` knob, an Anthropic thinking
    config that is not explicitly disabled, and the effort levels (`xhigh`, `max`) that
    force thinking back on whatever the config says."""
    thinking = settings.get("thinking")
    if thinking:  # True, or any adaptive-thinking level string — every truthy value enables it
        raise ThinkingEnabledError(
            "the classification review runs with extended thinking OFF; "
            f"`thinking={thinking!r}` would enable it."
        )
    anthropic_thinking = settings.get("anthropic_thinking")
    if anthropic_thinking is not None and anthropic_thinking["type"] != "disabled":
        raise ThinkingEnabledError(
            "the classification review runs with extended thinking OFF; "
            f"`anthropic_thinking` is configured `{anthropic_thinking['type']}`."
        )
    effort = settings.get("anthropic_effort")
    if effort is not None and effort in THINKING_FORCING_EFFORT:
        raise ThinkingEnabledError(
            f"`anthropic_effort={effort!r}` silently re-enables extended thinking "
            "(thinking-disabled is only honoured up to `high`); the review refuses it."
        )


def review_model_settings() -> AnthropicModelSettings:
    """The review's settings block — the harness's shape with its own values. Three of
    these are load-bearing (see `constants.py` for the reasoning each carries): the
    three cache breakpoints at the 1-hour tier, the explicit `low` effort, and the
    explicit `max_tokens`. Guarded on the way out so a drifted constant can never ship
    a thinking-enabled block."""
    settings = AnthropicModelSettings(
        max_tokens=MAX_TOKENS,
        temperature=TEMPERATURE,
        anthropic_effort=REVIEW_EFFORT,
        anthropic_cache_instructions=CACHE_TTL,
        anthropic_cache_tool_definitions=CACHE_TTL,
        anthropic_cache=CACHE_TTL,
    )
    ensure_thinking_off(settings)
    return settings


async def run_review(
    *,
    model: Model,
    user_id: uuid.UUID,
    snapshot_root: Path,
    scan_hits: Sequence[LocatedHit] = (),
    prompt: str | None = None,
    message_history: list[ModelMessage] | None = None,
    model_settings: AnthropicModelSettings | None = None,
    usage_limits: UsageLimits | None = None,
) -> AgentRunResult[ReviewOutput]:
    """One review run over an extracted snapshot — the entry the runner calls.

    `snapshot_root` is the extraction directory (runner owns extracting/deleting it).
    `scan_hits` are the credential scan's findings, formatted as directed evidence —
    location and family, never a value. On the guided truncation retry the runner passes
    `message_history` + a constraining `prompt`, skipping default assembly. A
    `model_settings` override is guarded like the default: a thinking-enabling
    combination raises before any model call."""
    settings = review_model_settings() if model_settings is None else model_settings
    ensure_thinking_off(settings)
    workspace = ExtractedSnapshotWorkspace(root=snapshot_root)
    if prompt is None:
        files = await workspace.list_files()
        prompt = build_review_prompt(files=files, scan_hits=scan_hits)
    return await review_agent.run(
        prompt,
        deps=ReviewDeps(user_id=user_id, workspace=workspace),
        model=model,
        model_settings=settings,
        message_history=message_history,
        usage_limits=usage_limits,
    )
