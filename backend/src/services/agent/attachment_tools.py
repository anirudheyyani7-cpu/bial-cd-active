"""The Plan chat's one way to read an attached file (#214 R14).

WHY THIS IS ITS OWN TOOLSET RATHER THAN A WIDER `run_command`. Plan already executes inside the
container, but only through `check_the_guest_list`: eight read-only binaries, exec-style argv, no
shell, no runtime, no package manager. `python3` is deliberately absent, so Plan cannot invoke the
shipped reader the way Build does.

The obvious fix — add `python3` to the guest list, or let a path outside the app root be named —
is the one that must not be taken. That surface is SHARED with the reviewer agent, which runs on
the control plane over untrusted project contents, and `check_the_guest_list(argv)` takes argv and
nothing else precisely so no body below it can ask which agent is calling. Widening it for
attachments widens it there too, and the signature is the proof that it cannot be done selectively.

So the capability goes where the architecture already sanctions a per-kind difference:
`toolsets_for_kind` is the one place permitted to read `ChatKind`, and this toolset is registered
on the Plan arm alone — the same way `_PLAN_OPTIONS_TOOLSET` already is. The reviewer never
receives it, by construction rather than by a check.

BUILD DOES NOT GET THIS, and that asymmetry is R15 rather than an oversight: Build holds an
unrestricted `run_command` and can read, EDIT and re-run the reader as it would any other file.
Handing it a fixed-shape tool as well would give it a second, weaker way to do what it can already
do better, and would make the reader look opaque at exactly the moment it stops being so.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from pydantic_ai import ModelRetry, RunContext
from pydantic_ai.toolsets import FunctionToolset

from src.core.prompt_blocks import ATTACHMENT_READ_TOOL
from src.services.agent.read_tools import (
    ATTACHMENTS_PREFIX,
    is_an_attachment_path,
    to_container_path,
)
from src.services.orchestrator.deps import SandboxSession

# Where the canonical reader is baked. Fixed and known, never discovered: R11a's whole point is
# that an agent is TOLD where this is, because an agent that has to find a reader writes one
# instead — the single failure this design exists to prevent.
READER_PATH = "/usr/local/lib/bial/read_attachment.py"

# Long enough for the reader's own 30-second ceiling to fire first, so a slow file comes back as
# the reader's named `timeout` failure rather than as a transport error with no advice in it.
_READ_TIMEOUT_SECONDS = 45


@dataclass
class AttachmentReader:
    """Runs the shipped reader over one attached file, and nothing else.

    THE SCOPE IS THE ARGV, which is why this is a class holding a session rather than a general
    exec helper: the command is assembled here from a fixed interpreter, a fixed script path and
    one operand that must name the attachments root. There is no shape of input that turns this
    into a way to run something else.
    """

    session: SandboxSession

    async def read(self, path: str) -> str:
        # ★ TRANSLATED, NOT PASSED THROUGH. The model is given `.attachments/<name>` — a token the
        # READ SURFACE understands and rewrites — but this tool does not go through that surface:
        # it hands an argv straight to `exec`, which runs in the app root. Passed verbatim, the
        # reader resolves `.attachments/roster.xlsx` against `/workspace/app` and reports the file
        # missing while it sits in `/workspace/attachments` the whole time. That is exactly what
        # the first end-to-end run produced, and no unit test caught it: every test here drives
        # `read` with a path and asserts on the argv, so the argv was self-consistently wrong.
        #
        # The same `to_container_path` `read_file` and `search_files` use, for the same reason and
        # with the same one-prefix scope — `read_attachment` refuses anything that is not an
        # attachment path, so this only ever rewrites the prefix it was built for.
        argv = ["python3", READER_PATH, to_container_path(path)]
        result = await self.session.sandbox_client.exec(
            self.session.handle, argv, timeout_s=_READ_TIMEOUT_SECONDS
        )
        return result.stdout


def attachment_toolset[DepsT](
    reader_of: Callable[[RunContext[DepsT]], AttachmentReader],
) -> FunctionToolset[DepsT]:
    """The Plan arm's attachment capability, over whatever deps the caller resolves a reader from.

    A factory for the same reason `read_only_toolset` is one: WHICH container is a fact about the
    run, not about the ability. What this toolset allows is written down once, here.

    The inner tool annotates `RunContext[Any]`, matching `read_only_toolset`'s own note and for
    the same reason: pydantic-ai resolves tool annotations with `get_type_hints` at registration,
    and a PEP-695 type param of the ENCLOSING function is not in scope there under deferred
    annotations. The factory signature carries the real typing.
    """
    toolset: FunctionToolset[DepsT] = FunctionToolset[DepsT](id="attachments")

    # THE NAME IS THE CONSTANT, not the spelling of this function, because the transcript's
    # label mapping matches on it from a module that cannot import this one.
    @toolset.tool(name=ATTACHMENT_READ_TOOL)
    async def read_attachment(ctx: RunContext[Any], file: str) -> str:
        """Read a file the user attached to this chat and report what is in it.

        Pass `file` as the path you were given for the attachment — it starts with
        `.attachments/`. Returns a description of the file's real contents: for a spreadsheet the
        sheets, their true row counts and what each column holds; for a document its headings,
        paragraphs and tables; for a deck its slides and speaker notes.

        The whole file is read, not a sample, and the answer says so — if anything could not be
        summarised it is named. Use this rather than guessing from the file's name, and never
        write your own parser: this is the tested one.
        """
        if not is_an_attachment_path(file):
            # A TEACHING REFUSAL, not an error. The model gets one sentence naming the shape it
            # should have used and retries — the same contract every refusal on the read surface
            # follows.
            raise ModelRetry(
                f"`{file}` is not an attached file. Attachments are named with the "
                f"`{ATTACHMENTS_PREFIX}` prefix you were given in this turn — pass that path. "
                "This tool reads attachments only; use `read_file` for the app's own source."
            )
        reader = reader_of(ctx)
        try:
            raw = await reader.read(file)
        except Exception as exc:  # a transport failure, not a bad file
            raise ModelRetry(
                f"The attachment could not be read right now ({type(exc).__name__}). "
                "Try once more; if it fails again, say so rather than guessing at the contents."
            ) from None

        # THE READER ALWAYS PRINTS ONE JSON OBJECT AND EXITS 0, including for a corrupt or
        # encrypted file — that is its contract. Anything else means the script itself is wrong or
        # missing, which the model must not paper over by inventing a description of the file.
        try:
            parsed: Any = json.loads(raw)
        except ValueError:
            raise ModelRetry(
                "The reader did not return a result for that file. Tell the user the file "
                "could not be read rather than describing what it might contain."
            ) from None
        if isinstance(parsed, dict) and parsed.get("ok") is False:
            # A NAMED FAILURE IS AN ANSWER, so it is returned rather than raised: the model should
            # tell the citizen the file is damaged and what to do, not retry a file that will fail
            # identically.
            return raw
        return raw

    return toolset
