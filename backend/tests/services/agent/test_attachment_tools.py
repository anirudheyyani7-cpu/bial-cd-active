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


@pytest.mark.parametrize(
    "escape",
    [
        ".attachments/../../etc/roster.csv",
        ".attachments/../app/lib/secrets.csv",
        ".attachments/nested/../../../../var/data.xlsx",
    ],
)
async def test_a_traversal_out_of_the_attachments_root_is_refused(escape: str) -> None:
    """★ THE PREFIX IS NOT CONTAINMENT (#214 R19).

    `is_an_attachment_path` answers one question — does this name the reserved prefix — and every
    string below answers it yes. This tool then builds an argv and hands it to `exec`, which does
    NOT pass through the supervisor's `_resolve`, so an unvetted `..` reached the reader and it
    would open any `.csv`/`.xlsx`/`.docx`/`.pptx`/`.tsv` in the container.

    It is reachable rather than theoretical: the path is model-chosen, and this feature's own rule
    (R18) holds that attachment content is untrusted — a spreadsheet cell that talks an agent into
    a traversal is exactly what that rule anticipates.

    Mutation receipt: drop the `refuse_unsafe_path` call and each of these reaches `exec`.
    """
    reader = _Recorder()

    with pytest.raises(ModelRetry):
        await _tool(reader)(None, escape)

    assert reader.seen is None, f"{escape} reached the container"


async def test_the_command_is_the_shipped_reader_over_the_container_path() -> None:
    """★ THE ARGV IS THE SCOPE, AND THE PATH IN IT MUST BE THE CONTAINER'S.

    The command is a fixed interpreter, a fixed script path and one operand — no input shape turns
    this into a way to run something else. But the operand also has to be a path the container can
    resolve, and that is the half this test used to get wrong: it asserted the argv carried
    `.attachments/roster.xlsx`, the MODEL-facing token, which is exactly what the code did. Both
    were self-consistent and both were wrong.

    `exec` runs in the app root, so a relative `.attachments/…` resolves to
    `/workspace/app/.attachments/…` and the reader truthfully reports the file missing while it
    sits in `/workspace/attachments`. Driving the real UI is what found it: the agent said the
    folder was not there, and it was right.

    Mutation receipt: drop `to_container_path` from `AttachmentReader.read` and this goes red on
    the prefix — which is the assertion the old version of this test was missing."""
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

    assert calls == [["python3", READER_PATH, "/workspace/attachments/roster.xlsx"]]
    # The model-facing token must NOT survive into the command.
    assert ".attachments/" not in calls[0][2]


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
