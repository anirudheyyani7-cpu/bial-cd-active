"""The sandbox tool surface and its per-run dependencies (contracts C2 / C6 / C7).

This package USED to own the standalone `/build-sessions` build harness — `harness.py`,
`agent.py`, `trace.py` and the `BuildOrchestrator` / `BuildSpec` / `RunContextProvider` /
`BuildDeps` surround. All of it is deleted: the bare `POST` on the build-sessions collection lost
its browser client in PR #182 and the route went with it, so nothing constructed an orchestrator
any more. What remains
here is not legacy — it is the machinery of the LIVE chat turn, which merely lives in a directory
still named after the thing that was cut: the sandbox toolset (`tools.py`), the destructive-SQL
sentinel (`sql_guard.py`), the self-heal loop (`selfheal.py`), the redacted error surface
(`errors.py`), the shared budgets (`constants.py`), the generated app's own error reporter
(`client_errors.py`), the repair prompt (`prompt.build_repair_prompt`) and the two per-run
dependency types below.

It reaches everything else through frozen contracts imported read-only: the C2 `SandboxClient`
ABC, the C7 progress envelope, the `gate.py` metering surface. Budgets/knobs are in-module
constants — the config surface is never touched (rule §5.9).

Public surface via explicit `from .x import Y as Y` re-exports (`.claude/rules/modules.md` — never
`__all__`).
"""

# A plain re-export, not a side-effect import: `tools.sandbox_toolset` is the FACTORY the chat
# agent's Build arm composes its workspace tools from (`agent/toolsets.py`), over its own deps.
from src.services.orchestrator import tools as tools
from src.services.orchestrator.deps import SandboxSession as SandboxSession
from src.services.orchestrator.progress import ProgressEmitter as ProgressEmitter
