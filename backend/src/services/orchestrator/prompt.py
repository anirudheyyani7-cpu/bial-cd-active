"""The build-agent system prompt + the repair-prompt template.

WHY THIS EXISTS
`BUILD_SYSTEM_PROMPT` describes the open-sandbox reality the model works in (the
vibe-coding pivot): a real shell (`run_command` + on-demand `npm install`), a fully
editable workspace (config and `package.json` included, only `.git/` and escapes
denied), the always-running dev server it must NOT restart, the injected app ENV it
writes its own data/storage code against, the rule against seeded dummy records
(empty/loading/error states instead), the tool surface, and a slim golden-template
manifest of starting points instead of a computed repo map. `build_repair_prompt`
frames a redacted `BuildError` as the NEXT run's user prompt — the concrete channel
by which a harness-observed error re-enters the model's context.

The unconditional rule that the user must see their own write without a manual
reload is UNENFORCEABLE at generation time. The shipped static detector
`flag_liveness_overpromise` (`src/services/build_sessions/liveness.py`) is
claim-gated: it only fires on a `.tsx`/`.jsx` file that advertises live/shared/
real-time copy, so an app that makes no such claim and wires no refetch violates
this rule silently — nothing lands in the log. Measuring whether the user actually
saw their own write needs a JS-executing probe the frozen `SandboxClient` surface
cannot run. That gap is accepted, not closed; relaxing the detector for the
after-write case is a cheap follow-up, out of scope here.
Kept as a module constant (like `describe.py:_DESCRIBE_SYSTEM`) so the prompt
evolves in code review, never at config or runtime.
"""

from __future__ import annotations

from src.api.v1.build_sessions.schemas import BuildError
from src.core.prompt_blocks import (
    BUILD_WORKING_RULES_HEAD as BUILD_WORKING_RULES_HEAD,
)
from src.core.prompt_blocks import (
    BUILD_WORKING_RULES_TAIL as BUILD_WORKING_RULES_TAIL,
)
from src.core.prompt_blocks import (
    DATA_INTEGRITY_RULES as DATA_INTEGRITY_RULES,
)
from src.core.prompt_blocks import (
    NARRATION_VOICE as NARRATION_VOICE,
)
from src.core.prompt_blocks import (
    WRITE_IDENTITY as WRITE_IDENTITY,
)

BUILD_SYSTEM_PROMPT = f"""\
{WRITE_IDENTITY}

{BUILD_WORKING_RULES_HEAD}

{DATA_INTEGRITY_RULES}

{NARRATION_VOICE}

{BUILD_WORKING_RULES_TAIL}"""
"""The standalone build prompt, assembled from EXACTLY the pieces `_WRITE_SEGMENT` uses.
It is the live `@build_agent.instructions` return value, not dead legacy text; the identity
paragraph that used to be typed out here is imported, so the two cannot drift while both exist.

IT NAMES `NARRATION_VOICE` ITSELF, and that line is load-bearing. The audience contract
is shared by both chat kinds now, so it moved into `mode_prompts._base()` — which THIS prompt
cannot call, because `_base(context, kind)` needs a `PromptContext` the standalone harness has no
source for. Lifting the block out of `BUILD_WORKING_RULES_TAIL` without this line would have
deleted the audience contract from a live prompt and reinstated the defect that produced it.

IT ALSO OVER-STATES ITS OWN TOOL SURFACE, and that is known rather than accidental. `TAIL` carries
`WRITE_TOOL_SURFACE`, a snapshot of what the CHAT Build arm registers (twelve tools), while
`build_agent` is constructed with `sandbox_toolset` alone (eight). So this prompt names
`list_files`, `search_files`, `tell_the_user` and `propose_first_slice` to an agent that cannot
call any of them. See `prompt_blocks.WRITE_TOOL_SURFACE`'s docstring for why it is recorded rather
than fixed, and `test_prompt.py`'s
`test_the_harness_arm_is_told_about_four_tools_it_does_not_register` for the guard that goes red
when it is."""


def build_repair_prompt(error: BuildError) -> str:
    """Frame a redacted `BuildError` as the next run's user prompt. The `cleaned_stack`
    is already de-noised + secret-redacted by `errors.declutter`.
    THE ONE PLACE `agent_only_detail` IS READ. A `client`-class report is text the
    generated app wrote, so it is deliberately absent from the two fields that egress
    to the portal and carried instead on a field that never serializes — the model's
    copy of the diagnostic can only be assembled here, in-process. It arrives
    pre-wrapped in the data-only frame `errors.from_client` builds; never unwrap it or
    "simplify" this to a bare `cleaned_stack` read, which would send an empty diagnostic."""
    detail = error.agent_only_detail or error.cleaned_stack
    return (
        f"The build is not green yet — a `{error.source.value}` check failed:\n\n"
        f"{error.title}\n\n"
        f"{detail}\n\n"
        "Fix the root cause in your code, then call `declare_done` again. You may use "
        "`run_command` to investigate (re-run a check, inspect a file, reinstall a dependency)."
    )
