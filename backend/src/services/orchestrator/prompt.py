"""The repair-prompt template (KD-4 / KD-9 / KD-10 / C6 / R18).

`build_repair_prompt` frames a redacted `BuildError` as the NEXT run's user prompt — the concrete
channel by which an observed error re-enters the model's context (KD-1 / KD-5). Its consumer is the
live turn engine's self-heal loop (`turns/engine.py`).

`BUILD_SYSTEM_PROMPT` USED TO LIVE HERE and is deleted with the standalone build harness that was
its only consumer (`orchestrator/agent.py`'s `build_agent`). Nothing is lost from the model's
context: the prompt was assembled from EXACTLY the `core/prompt_blocks.py` pieces that
`mode_prompts._WRITE_SEGMENT` + `_base()` compose for a Build chat turn, which is the surviving —
and, since PR #182, the only — Write prompt. The open-sandbox reality it described (a real shell,
a fully editable workspace, the always-running dev server, the injected app ENV, the real-data-only
rule R4, the tool surface, the golden-template manifest) is all still stated, from the same single
sources, by `compose_kind_prompt(ChatKind.BUILD, ...)`. The guards that pinned this copy moved to
that prompt with it.

The unconditional AFTER A WRITE rule (U11 — the user must see their own mutation without a manual
reload) is UNENFORCEABLE at generation time. The shipped static detector
`flag_liveness_overpromise` (`src/services/build_sessions/liveness.py`) is claim-gated: its
`_CLAIM_RE` only fires on a `.tsx`/`.jsx` file that advertises live/shared/real-time copy, so an
app that makes no such claim and wires no refetch violates this rule silently — nothing lands in
the log. Measuring the rendered-page property "the user saw their own write" needs a JS-executing
probe the frozen C2 `SandboxClient` surface cannot run. That gap is ACCEPTED here, not closed
(deferred to issue #49); relaxing `_CLAIM_RE` for the after-write case is a cheap follow-up,
explicitly out of scope for this unit.
"""

from __future__ import annotations

from src.api.v1.build_sessions.schemas import BuildError


def build_repair_prompt(error: BuildError) -> str:
    """Frame a redacted `BuildError` as the next run's user prompt (KD-1 / KD-5). The
    `cleaned_stack` is already de-noised + secret-redacted by `errors.declutter`.

    THE ONE PLACE `agent_only_detail` IS READ (U13). A `client`-class report is text the generated
    app wrote, so it is deliberately absent from the two fields that egress to the portal and
    carried instead on a field that never serializes — which means the model's copy of the
    diagnostic can only be assembled here, in-process. It arrives pre-wrapped in the data-only
    frame `errors.from_client` builds; do not unwrap it, and do not "simplify" this back to a bare
    `cleaned_stack` read, which would silently send the model an empty diagnostic for the entire
    runtime-crash class."""
    detail = error.agent_only_detail or error.cleaned_stack
    return (
        f"The build is not green yet — a `{error.source.value}` check failed:\n\n"
        f"{error.title}\n\n"
        f"{detail}\n\n"
        "Fix the root cause in your code, then call `declare_done` again. You may use "
        "`run_command` to investigate (re-run a check, inspect a file, reinstall a dependency)."
    )
