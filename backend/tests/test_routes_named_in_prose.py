"""Every route a comment hands a reader must resolve against the mounted app.

Checked against the MOUNTED app, never a hard-coded list, since the failure mode is a prefix
moving — pinned literals would go green on the rot. Path parameter names are normalised away
(`{id}` vs `{app_id}`) since a reader resolves that abbreviation fine; only a wrong prefix or
segment is unresolvable. `test_reaper.py` runs the same check for one module; this widens it
to all of `src/`.

Mutation check: drop `/apps` from the reaper docstring's reconcile URL, or write
`/v1/internal/reap` in either sweep module, and this goes red naming the file.
"""

from __future__ import annotations

import re
from pathlib import Path

from src.main import create_app

_SRC = Path(__file__).resolve().parents[1] / "src"

_A_ROUTE_IN_PROSE = re.compile(r"`(?:GET|POST|PATCH|PUT|DELETE) (/v1/[A-Za-z0-9/_{}.-]+)`")
# Anchored on `/v1/` so this can't pick up a portal, supervisor, or example path.

_A_PATH_PARAMETER = re.compile(r"\{[^{}]*\}")


def _shape(path: str) -> str:
    return _A_PATH_PARAMETER.sub("{}", path)


def test_every_route_named_in_a_backend_comment_resolves() -> None:
    mounted = {_shape(path) for path in create_app().openapi()["paths"]}
    assert mounted, "the app mounted no paths; this guard has lost its subject"

    named_somewhere = False
    unresolvable: dict[str, list[str]] = {}
    for module in sorted(_SRC.rglob("*.py")):
        named = {_shape(m) for m in _A_ROUTE_IN_PROSE.findall(module.read_text(encoding="utf-8"))}
        named_somewhere = named_somewhere or bool(named)
        missing = named - mounted
        if missing:
            unresolvable[str(module.relative_to(_SRC.parent))] = sorted(missing)

    assert named_somewhere, "no comment in `src/` names a `/v1/` route; the regex has drifted"
    assert not unresolvable, (
        "these comments hand a reader a URL no route serves — correct the prose (or the route):\n"
        + "\n".join(f"  {module}: {paths}" for module, paths in sorted(unresolvable.items()))
    )
