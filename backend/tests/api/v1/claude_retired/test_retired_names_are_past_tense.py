"""Backend half of the repo's retire-a-behaviour convention: a mention of something DELETED must
read as history, not present tense. Exists because a stale comment once claimed a branch "retires
with the relay" when a shipping endpoint still ran on it — a comment cannot be asserted, so this
checks the one thing that can be: naming what replaced dead code is fine, but the sentence around
it has to say the thing is gone.

A marker-list scan, not real prose analysis, on purpose: cheap enough to survive, and wrong only
in the harmless direction — a miss, never a false alarm that gets the guard deleted and the check
skipped on the next wholesale deletion.

Sibling: `portal/src/__tests__/retired-names-are-past-tense.test.ts`.
"""

from __future__ import annotations

from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[4]

# BOTH TREES, AND MARKDOWN TOO: an earlier version scanned `src/` alone, and a harness `.md` kept
# a copy-pasteable dead import and a "live" contract listing invisible to it. A harness doc that
# lies costs the reader the same hour a lying docstring does.
# `claude_retired/` is the ONE directory excluded: these files exist to name the dead thing and
# prove it's dead, so every mention is the subject of a sentence, not a claim about live code.
_GUARD_HOME = _BACKEND / "tests/api/v1/claude_retired"

SCANNED = tuple(
    path
    for path in (
        *sorted((_BACKEND / "src").rglob("*.py")),
        *sorted((_BACKEND / "tests").rglob("*.py")),
        *sorted((_BACKEND / "tests").rglob("*.md")),
    )
    if _GUARD_HOME not in path.parents
)

# Unambiguous identifiers only — a generic word like "relay" appears in live contexts (the C3
# progress relay, the BRAIN↔SESSION-API relay) and would produce pure noise.
#
# This asserts an ABSENCE: adding a word to either tuple below changes what the whole repo is
# scanned for and can turn an unrelated edit elsewhere red. Treat both as fixed data.
RETIRED = (
    "v1/claude",
    "api.v1.claude",
    "claude/router.py",
    "claude/prompts.py",
    "to_model_content",
    "services/agent/content",
    # The standalone build stack, deleted whole: the harness and the module-level agent it ran,
    # the deps type and the API dependency that fed them, the locked start body behind the route,
    # the frozen prompt only that agent applied, the attachment resolver only that route needed,
    # the transcript row only it wrote, and the one lock op whose button went before it did.
    # Named here because this deletion is the case in the docstring above — a removal wide
    # enough that the prose describing it is
    # spread over modules nobody re-reads, which is where the fifth link came undone last time.
    # Internals of those modules (`BuildSpec`, `RunContextProvider`, `EMPTY_TRANSCRIPT`, the
    # trace recorders) are deliberately NOT listed: a sentence naming one of them sits next to a
    # name that is, and a longer list is a list that gets skimmed.
    # DELIBERATELY ABSENT for the opposite reason — `preview_framed` and `claim_preview_frame`
    # were deleted from `orchestrator/deps.py`, but `services/turns/engine.py` has LIVE members
    # under both names. They fail the "unambiguous identifiers only" rule above, and listing them
    # would make this guard cry wolf at the live turn engine on every run.
    "orchestrator/harness.py",
    "orchestrator/agent.py",
    "build_agent",
    "BuildOrchestrator",
    "BuildDeps",
    "run_build_dependency",
    "_start_locked",
    "BUILD_SYSTEM_PROMPT",
    "resolve_build_attachments",
    "write_build_started",
    "lock/force-end",
)

# Deliberately generous: a miss is cheaper than a false alarm.
HISTORICAL = (
    "used to",
    "was ",
    "were ",
    "had ",
    "died",
    "dies with",
    "deleted",
    "retired",
    "removed",
    "gone",
    "no longer",
    "until",
    "before",
    "predates",
    "legacy",
    "old ",
    "since",
    "outlived",
    "replaced",
)


def _window(lines: list[str], index: int) -> str:
    """The mention's line plus two either side — a docstring sentence rarely fits on one."""
    return " ".join(lines[max(0, index - 2) : index + 3]).lower()


def test_no_source_or_harness_file_mentions_a_retired_name_in_the_present_tense() -> None:
    offenders: list[str] = []
    for file in SCANNED:
        lines = file.read_text(encoding="utf-8").splitlines()
        for index, line in enumerate(lines):
            for name in RETIRED:
                if name not in line:
                    continue
                if not any(marker in _window(lines, index) for marker in HISTORICAL):
                    rel = file.relative_to(_BACKEND)
                    offenders.append(f"{rel}:{index + 1}: {name} — {line.strip()[:90]}")
    assert offenders == []


def test_the_guard_can_actually_fail() -> None:
    """Mutation-proofing. If the marker list ever grew to match everything, the check above
    would be green forever and this file would be worse than nothing."""
    present = ["# The chat relay (`/v1/claude`) carries no CSRF token."]
    historical = ["# The `/v1/claude` relay was retired; nothing carries that contract now."]

    def flags(lines: list[str]) -> bool:
        return "v1/claude" in lines[0] and not any(m in _window(lines, 0) for m in HISTORICAL)

    assert flags(present) is True
    assert flags(historical) is False
