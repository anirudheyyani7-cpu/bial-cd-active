"""The Plan chat's attachment capability (#214 R14) — what it allows, and what it refuses.

`test_toolsets.py` asserts WHO is offered this tool. This file asserts what the tool does with what
it is given: the scope of the command it builds, and the three ways it can fail.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, cast

import pytest
from pydantic_ai import ModelRetry
from pydantic_ai.toolsets import FunctionToolset

from src.services.agent.attachment_tools import (
    READER_PATH,
    AttachmentReader,
    attachment_toolset,
)
from src.services.orchestrator.deps import SandboxSession


@dataclass
class _Recorder:
    """Stands in for the reader, recording the path it was asked for."""

    result: str = '{"ok": true, "file": "roster.xlsx", "rows": 5000}'
    raises: Exception | None = None
    seen: list[str] | None = None

    async def read(self, path: str) -> str:
        if self.seen is None:
            self.seen = []
        self.seen.append(path)
        if self.raises is not None:
            raise self.raises
        return self.result


def _tool(reader: Any) -> Any:
    toolset: FunctionToolset[Any] = attachment_toolset(lambda _ctx: reader)
    return toolset.tools["read_attachment"].function


async def test_it_reads_an_attachment_and_returns_the_manifest() -> None:
    reader = _Recorder()

    out = await _tool(reader)(None, ".attachments/roster.xlsx")

    assert reader.seen == [".attachments/roster.xlsx"]
    assert json.loads(out)["rows"] == 5000


async def test_it_refuses_a_path_that_is_not_an_attachment() -> None:
    """★ THE SCOPE. R14 requires a capability scoped to attachments — never a widening of which
    paths the agent may name. A tool that would read any path is a second, unguarded `read_file`,
    and it runs `python3`, which the shared read surface deliberately does not offer.

    Mutation receipt: drop the `is_an_attachment_path` guard and this passes an app path straight
    to the interpreter.
    """
    reader = _Recorder()

    for path in ("app/page.tsx", "/etc/passwd", "../../secrets", "attachments/x.xlsx"):
        with pytest.raises(ModelRetry):
            await _tool(reader)(None, path)

    assert reader.seen is None  # nothing reached the container


async def test_the_command_is_the_shipped_reader_and_nothing_else() -> None:
    """★ THE ARGV IS THE SCOPE. The command is a fixed interpreter, a fixed script path and one
    operand — there is no input shape that turns this into a way to run something else."""
    calls: list[list[str]] = []

    class _Client:
        async def exec(self, _handle: Any, argv: list[str], *, timeout_s: int) -> Any:
            calls.append(argv)
            return type("R", (), {"stdout": '{"ok": true}', "stderr": "", "exit": 0})()

    # A DOUBLE RATHER THAN A `SandboxSession`, and cast because it is one deliberately: the
    # reader touches exactly two attributes, and building a whole session here would hide which
    # two by supplying twenty. The cast is the claim the double makes, written down.
    session = cast(
        SandboxSession, type("S", (), {"sandbox_client": _Client(), "handle": object()})()
    )
    await AttachmentReader(session=session).read(".attachments/roster.xlsx")

    assert calls == [["python3", READER_PATH, ".attachments/roster.xlsx"]]


async def test_a_transport_failure_is_a_retry_not_a_fabricated_answer() -> None:
    """The model must not paper over a failed read by describing what the file might contain."""
    reader = _Recorder(raises=RuntimeError("sandbox gone"))

    with pytest.raises(ModelRetry) as caught:
        await _tool(reader)(None, ".attachments/roster.xlsx")

    assert "guessing" in str(caught.value)


async def test_output_that_is_not_the_readers_contract_is_a_retry() -> None:
    """The reader always prints one JSON object and exits 0, including for a corrupt file. Anything
    else means the script is missing or broken — which the model must not describe around."""
    reader = _Recorder(result="Traceback (most recent call last):\n  ...")

    with pytest.raises(ModelRetry):
        await _tool(reader)(None, ".attachments/roster.xlsx")


async def test_a_named_failure_is_returned_rather_than_retried() -> None:
    """★ A DAMAGED FILE IS AN ANSWER. Retrying it would fail identically; the citizen should be
    told the file is damaged and what to do, which is what the reader's failure shape carries."""
    reader = _Recorder(
        result=json.dumps(
            {
                "ok": False,
                "file": "roster.xlsx",
                "error": {
                    "code": "encrypted",
                    "message": "locked",
                    "next": "Remove the password.",
                },
            }
        )
    )

    out = await _tool(reader)(None, ".attachments/roster.xlsx")

    assert json.loads(out)["error"]["code"] == "encrypted"
