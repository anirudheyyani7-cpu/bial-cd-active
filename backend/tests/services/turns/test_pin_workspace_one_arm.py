"""`_pin_workspace` resolves one workspace, for both kinds of chat, with no branch.

WHY THIS IS ASSERTED RATHER THAN WRITTEN DOWN. A sentence saying "there is one arm here"
cannot fail, and a sentence that cannot fail is how the last census of this method went
wrong — see `test_no_prose_readers`, which exists because two docstrings disagreed about a
count. This can fail: the day someone reintroduces the branch, it goes red.

IT IS A STRUCTURAL ASSERTION ON PURPOSE. The behavioural coverage already exists — the
write-turn and turn-stream suites drive real turns of both kinds through the live
container. What none of them can say is "there is ONE arm here": a branch returning a live
workspace on both sides would keep every one of those tests green while re-establishing the
exact shape that was removed. So this reads the method's AST and asserts the absence of a
fork, which is the property, rather than sampling outcomes a fork would still produce.
"""

from __future__ import annotations

import ast
import pathlib

ENGINE = pathlib.Path(__file__).resolve().parents[3] / "src" / "services" / "turns" / "engine.py"


def _pin_workspace_node(source: str) -> ast.AsyncFunctionDef:
    """The `_pin_workspace` definition, or a hard failure naming what was found instead.

    Walks the whole tree rather than indexing a known class body: a method that moved to another
    class would otherwise make this test vanish silently, which is the failure mode a guard must
    not have."""
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "_pin_workspace":
            return node
    raise AssertionError(
        "`_pin_workspace` is not in engine.py any more. If the turn-pinned read surface moved, "
        "re-point this guard; if the single-workspace rule itself was retired, delete this file."
    )


def _forks(node: ast.AST) -> list[str]:
    """Every conditional inside the body — the shape this method is asserted NOT to have.

    `if`, `match` and a conditional expression all count: the branch R18 removed was an `if`, but
    a ternary picking between two workspace classes is the same defect written smaller. A `try`
    is not a fork — it selects on failure, not on what kind of chat this is."""
    found: list[str] = []
    for child in ast.walk(node):
        if isinstance(child, ast.If):
            found.append(f"if at line {child.lineno}")
        elif isinstance(child, ast.Match):
            found.append(f"match at line {child.lineno}")
        elif isinstance(child, ast.IfExp):
            found.append(f"conditional expression at line {child.lineno}")
    return found


def _returned_calls(node: ast.AST) -> list[str]:
    """The name called by each `return`, so "returns one kind of workspace" is checkable."""
    names: list[str] = []
    for child in ast.walk(node):
        if isinstance(child, ast.Return) and isinstance(child.value, ast.Call):
            func = child.value.func
            names.append(func.id if isinstance(func, ast.Name) else ast.unparse(func))
    return names


def test_pin_workspace_still_has_exactly_one_arm() -> None:
    node = _pin_workspace_node(ENGINE.read_text(encoding="utf-8"))
    assert _forks(node) == [], (
        "`_pin_workspace` has grown a branch. Both kinds of chat resolve the project's live "
        "container through one arm; a Plan chat reading a saved copy instead is the shape this "
        "guard exists to refuse."
    )
    assert _returned_calls(node) == ["LiveSandboxWorkspace"], (
        "`_pin_workspace` no longer resolves the project's live container as its single answer."
    )


def test_the_guard_can_actually_fail() -> None:
    """Mutation-proofing. Both helpers above are absence checks, and an absence check whose
    finder is broken is green forever — the exact false-green this repo pairs every
    `toEqual([])` with a liveness assertion to avoid."""
    branched = ast.parse(
        "async def _pin_workspace(self):\n"
        "    if kind is ChatKind.PLAN:\n"
        "        return SnapshotWorkspace(x)\n"
        "    return LiveSandboxWorkspace(y)\n"
    )
    ternary = ast.parse(
        "async def _pin_workspace(self):\n"
        "    return SnapshotWorkspace(x) if plan else LiveSandboxWorkspace(y)\n"
    )
    assert len(_forks(branched)) == 1
    assert sorted(_returned_calls(branched)) == ["LiveSandboxWorkspace", "SnapshotWorkspace"]
    assert len(_forks(ternary)) == 1
    # ...and the live source still parses through the same finder, so a walker that silently
    # matched nothing could not produce the green above.
    assert _returned_calls(_pin_workspace_node(ENGINE.read_text(encoding="utf-8")))
